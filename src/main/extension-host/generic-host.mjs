/**
 * STARK-owned generic Extension Host module (Step 8 generic runtime).
 *
 * The SINGLE pipeline every installed + enabled VS Code-compatible
 * extension activates through — no allowlist anywhere in this file.
 * Loaded ONLY via the bootstrap's narrow dynamic import of a
 * main-supplied STARK-owned file URL — never by path invention, never
 * from renderer input.
 *
 * Boundaries (fail closed, never execute beyond the declared entry):
 * - exact identity is main-supplied (extensionId `<ns>.<name>@<ver>`);
 *   the on-disk manifest name/publisher/version is re-verified here;
 * - containment: the version directory must resolve under the
 *   main-supplied store root; the manifest `main` entrypoint must
 *   resolve under `<versionDir>/extension` (no traversal, regular
 *   file, JS module only);
 * - `vscode` resolves exclusively to the audited STARK shim: ESM via
 *   the loader hook (registered lazily here, once) and CommonJS via
 *   a host-only bare-specifier interception (exact `vscode` only —
 *   relative paths and all other packages use normal resolution);
 * - only registrations captured by the shim during `activate()` are
 *   ever used; results leave as validated serializable data only —
 *   the host never touches project files (it only reads the
 *   installed package directory plus main-owned snapshot files, and
 *   whatever the extension itself reads during an explicit action);
 * - manifest `scripts.*` / install hooks are never read and never
 *   executed: activation imports ONLY the resolved `main` file URL;
 * - `*` activation events never trigger background execution (no
 *   startup sweep); demand-driven triggers arrive as explicit
 *   main-sent messages only;
 * - DEACTIVATE disposes ONLY the owning extension's registrations,
 *   exact-owned helper processes, and module references; a hanging
 *   `deactivate()` is bounded at 5 seconds.
 *
 * Security boundary (explicit, no OS sandbox claim): third-party
 * Node code runs inside the Extension Host utilityProcess with a
 * sanitized env (main-owned allowlist, no secrets) and a neutral
 * cwd. `utilityProcess` is process isolation, NOT an OS-level
 * sandbox: native extension code with Node `fs` access can read the
 * machine as the user. The host never invents STARK IPC, never
 * exposes project-write IPC to extensions. Extension-originated file
 * effects leave only as review proposals; direct workspace writes
 * throw Unsupported. Helper processes spawned by extension code run
 * with forced no-shell execution, bounded counts, sanitized env, and
 * exact-handle cleanup (see the sibling helper module).
 *
 * ESM with node: imports only (no third-party imports). Testable by
 * importing this file directly with a fake channel.
 */

import { register } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExtensionProcessManager, MAX_PROCESSES_PER_EXTENSION, MAX_PROCESSES_TOTAL } from './extension-process.mjs';

/** Maximum simultaneously loaded extensions (bounded registry). */
export const MAX_LOADED_EXTENSIONS = 128;

/** Maximum manifest bytes parsed as data. */
export const GENERIC_MANIFEST_MAX_BYTES = 1024 * 1024;

/** Maximum commands registered per extension. */
export const MAX_COMMANDS_PER_EXTENSION = 256;

/** Maximum language providers registered per extension. */
export const MAX_PROVIDERS_PER_EXTENSION = 256;

/** Activation is main-bounded at 10s; host enforces no retry. */
export const GENERIC_ACTIVATION_TIMEOUT_MS = 10_000;

/** `deactivate()` export is bounded at 5 seconds. */
export const GENERIC_DEACTIVATE_TIMEOUT_MS = 5_000;

/** Provider query bound per request (no retries). */
export const GENERIC_PROVIDER_TIMEOUT_MS = 5_000;

/** Maximum providers consulted per query (merged, deterministic). */
export const GENERIC_PROVIDER_MAX_CONSULTED = 8;

/** Maximum pending host-to-main requests (bounded correlation). */
export const GENERIC_MAX_PENDING_REQUESTS = 64;

let loaderRegistered = false;
let cjsInterceptionInstalled = false;
let cachedShimModule = null;

/** Last-known host-to-main sender (every sender reaches one parent port). */
let activePost = null;

/** Correlated host-to-main requests: requestId -> { resolve, timer }. */
const pendingHostRequests = new Map();
let nextHostRequestId = 1;

/** Managed helper processes for language servers (exact ownership). */
const processManager = new ExtensionProcessManager();

/** Direct-spawn tracking: handle -> { owner, commandLabel }. */
const directSpawnHandles = new Set();
const directSpawnCounts = new Map();

function ensureLoader() {
  if (loaderRegistered) {
    return;
  }
  register('./vscode-loader.mjs', import.meta.url);
  loaderRegistered = true;
}

/**
 * Host-only CommonJS interception: inside verified extension code,
 * `require('vscode')` resolves to the SAME STARK-owned compatibility
 * module used by ESM extensions. Applies ONLY to the exact bare
 * specifier `vscode` — relative paths (`./local-file`) and every
 * other package (`fs`, normal dependencies, …) flow through Node's
 * normal resolution untouched. Installed once per host process.
 */
function ensureCjsInterception() {
  if (cjsInterceptionInstalled) {
    return;
  }
  cjsInterceptionInstalled = true;
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      if (cachedShimModule === null) {
        throw new Error("Cannot find module 'vscode'");
      }
      return cachedShimModule;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

function postToMain(type, payload) {
  const post = activePost;
  if (typeof post !== 'function') {
    return;
  }
  try {
    post(type, payload);
  } catch {
    // Fire-and-forget notifications never break execution.
  }
}

/**
 * Correlated host-to-main request (findFiles, openDocument, prompts,
 * clipboard, cross-extension activation). Resolves with the response
 * object or null on timeout/absence. Bounded pending map, no retries.
 */
function requestFromMain(type, payload, timeoutMs) {
  return new Promise((resolve) => {
    if (pendingHostRequests.size >= GENERIC_MAX_PENDING_REQUESTS) {
      resolve(null);
      return;
    }
    const requestId = `hr-${nextHostRequestId++}`;
    const boundedTimeout = Math.max(1000, Math.min(120_000, Math.floor(timeoutMs ?? 5000)));
    const timer = globalThis.setTimeout(() => {
      pendingHostRequests.delete(requestId);
      resolve(null);
    }, boundedTimeout);
    pendingHostRequests.set(requestId, {
      resolve: (response) => {
        globalThis.clearTimeout(timer);
        resolve(response);
      }
    });
    postToMain('HOST_REQUEST', { requestId, type, payload });
  });
}

function resolveHostRequest(requestId, response) {
  const waiter = pendingHostRequests.get(requestId);
  if (waiter === undefined) {
    return;
  }
  pendingHostRequests.delete(requestId);
  try {
    waiter.resolve(response);
  } catch {
    // Best effort.
  }
}

function containedUnder(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  const rootLower = resolvedRoot.toLowerCase();
  const candidateLower = resolvedCandidate.toLowerCase();
  return candidateLower === rootLower || candidateLower.startsWith(rootLower + path.sep);
}

function readManifestData(extensionDir) {
  const manifestPath = path.join(extensionDir, 'extension', 'package.json');
  let stat;
  try {
    stat = fs.statSync(manifestPath);
  } catch (err) {
    throw new Error('Extension manifest is missing.', { cause: err });
  }
  if (stat.size <= 0 || stat.size > GENERIC_MANIFEST_MAX_BYTES) {
    throw new Error('Extension manifest has an invalid size.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error('Extension manifest is not valid JSON.', { cause: err });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Extension manifest is not an object.');
  }
  return parsed;
}

/**
 * Reads one main-owned JSON snapshot file (config/storage) as DATA
 * ONLY with hard bounds. Missing or malformed files read back as
 * empty (defaults win) — never throws outward.
 */
function readSnapshotFile(filePath, maxBytes) {
  try {
    if (fs.statSync(filePath).size > maxBytes) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function snapshotConfigFor(storeRoot, extensionId) {
  const parsed = readSnapshotFile(path.join(storeRoot, 'extensions-config.json'), 256 * 1024);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const extensions = parsed.extensions;
  if (extensions === null || typeof extensions !== 'object' || Array.isArray(extensions)) {
    return {};
  }
  const values = extensions[extensionId];
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(values).slice(0, 256)) {
    if (typeof key !== 'string' || key === '' || key.length > 256) {
      continue;
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function safeStorageDirName(extensionId) {
  return String(extensionId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200);
}

function snapshotStorageScope(storeRoot, extensionId, fileName) {
  const filePath = path.join(storeRoot, 'extension-storage', safeStorageDirName(extensionId), fileName);
  const parsed = readSnapshotFile(filePath, 1024 * 1024);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const values = parsed.values;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(values).slice(0, 1024)) {
    if (typeof key !== 'string' || key === '' || key.length > 256) {
      continue;
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Whether raw manifest contributes are purely declarative (no code
 * execution needed): at least one declarative key and no
 * executable-only keys. Mirrors the main-side manifest gate.
 */
function isDeclarativeContributes(contributes) {
  if (contributes === null || typeof contributes !== 'object' || Array.isArray(contributes)) {
    return false;
  }
  const keys = Object.keys(contributes);
  if (keys.length === 0) {
    return false;
  }
  const executable = new Set([
    'webviews', 'customEditors', 'views', 'debuggers', 'breakpoints',
    'terminal', 'notebooks', 'taskDefinitions', 'problemMatchers',
    'authentication', 'comments', 'timeline', 'fileSystemProviders'
  ]);
  const declarative = new Set([
    'languages', 'grammars', 'snippets', 'themes', 'iconThemes',
    'configuration', 'commands', 'keybindings', 'menus', 'colors'
  ]);
  if (keys.some((key) => executable.has(key))) {
    return false;
  }
  return keys.some((key) => declarative.has(key));
}

function parseExtensionId(extensionId) {  if (typeof extensionId !== 'string' || extensionId === '') {
    throw new Error('Activation needs an extension id.');
  }
  const at = extensionId.lastIndexOf('@');
  const dot = extensionId.indexOf('.');
  if (at === -1 || dot === -1 || dot > at) {
    throw new Error('Extension id is not valid.');
  }
  const namespace = extensionId.slice(0, dot);
  const rest = extensionId.slice(dot + 1, at);
  const version = extensionId.slice(at + 1);
  // Rest is `<name>` (names cannot contain `.`? Actually they can via
  // `<ns>.<name>` where name may contain dots — split on FIRST dot
  // for namespace, remainder before @ is the name).
  const name = rest;
  if (namespace === '' || name === '' || version === '') {
    throw new Error('Extension id is not valid.');
  }
  return { namespace, name, version };
}

function toUnsupportedErrorCode(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('Unsupported VS Code API: ')) {
    return { code: 'unsupported-api', api: message.slice('Unsupported VS Code API: '.length).slice(0, 256) };
  }
  return null;
}

/**
 * Direct-spawn guard for extension code running in this host: forces
 * no-shell execution, enforces the global cap plus the per-extension
 * cap when the caller runs inside a known activation, and tracks
 * exact handles for owner-scoped cleanup. Shell-bound entrypoints
 * fail closed (no shell interpretation anywhere in this process).
 */
function ensureSpawnGuard() {
  const spawnModule = getSpawnModule();
  if (spawnModule === null || spawnModule.__starkGuarded === true) {
    return;
  }
  const originalSpawn = spawnModule.spawn;
  const originalSpawnSync = spawnModule.spawnSync;
  const originalExecFile = spawnModule.execFile;
  const originalFork = spawnModule.fork;

  function ownerNow() {
    const id = cachedShimModule?.__getActiveExtensionId?.();
    return typeof id === 'string' && id !== '' ? id : 'unattributed';
  }

  function checkCaps(owner) {
    let alive = 0;
    for (const handle of directSpawnHandles) {
      if (handle.alive) {
        alive++;
      }
    }
    if (alive >= MAX_PROCESSES_TOTAL) {
      throw new Error('Too many extension child processes.');
    }
    if (owner !== 'unattributed') {
      const owned = directSpawnCounts.get(owner) ?? 0;
      if (owned >= MAX_PROCESSES_PER_EXTENSION) {
        throw new Error('Too many child processes for this extension.');
      }
    }
  }

  function track(owner, child) {
    const handle = { owner, child, alive: true };
    directSpawnHandles.add(handle);
    if (owner !== 'unattributed') {
      directSpawnCounts.set(owner, (directSpawnCounts.get(owner) ?? 0) + 1);
    }
    postToMain('EXTENSION_NOTIFY', { notify: 'PROCESS_SPAWNED', owner });
    const settle = () => {
      handle.alive = false;
    };
    try {
      child.on('error', settle);
      child.on('exit', settle);
    } catch {
      // Tracking is best-effort.
    }
    return child;
  }

  function noShellOptions(options) {
    if (options !== null && typeof options === 'object' && !Array.isArray(options)) {
      if (options.shell !== undefined && options.shell !== false) {
        throw new Error('Process spawn with shell is not supported.');
      }
      return { ...options, shell: false };
    }
    return { shell: false };
  }

  spawnModule.spawn = function (command, args, options) {
    const owner = ownerNow();
    checkCaps(owner);
    const guarded = noShellOptions(options);
    const child = originalSpawn.call(this, command, args, guarded);
    return track(owner, child);
  };
  if (typeof originalSpawnSync === 'function') {
    spawnModule.spawnSync = function (command, args, options) {
      ownerNow();
      const guarded = noShellOptions(options);
      return originalSpawnSync.call(this, command, args, guarded);
    };
  }
  if (typeof originalExecFile === 'function') {
    spawnModule.execFile = function (file, args, options, callback) {
      const owner = ownerNow();
      checkCaps(owner);
      const guarded = noShellOptions(typeof options === 'object' && options !== null && !Array.isArray(options) ? options : {});
      const realCallback = typeof options === 'function' ? options : callback;
      const child = originalExecFile.call(this, file, args, guarded, realCallback);
      if (child !== null && typeof child === 'object' && typeof child.on === 'function') {
        return track(owner, child);
      }
      return child;
    };
  }
  if (typeof originalFork === 'function') {
    spawnModule.fork = function (modulePath, args, options) {
      const owner = ownerNow();
      checkCaps(owner);
      const guarded = noShellOptions(options);
      if (guarded.silent !== true) {
        guarded.silent = true;
      }
      const child = originalFork.call(this, modulePath, args, guarded);
      return track(owner, child);
    };
  }
  // Shell-bound entrypoints cannot run here (they require shell
  // interpretation): fail closed with an honest error.
  if (typeof spawnModule.exec === 'function') {
    spawnModule.exec = function () {
      throw new Error('Process spawn with shell is not supported.');
    };
  }
  if (typeof spawnModule.execSync === 'function') {
    spawnModule.execSync = function () {
      throw new Error('Process spawn with shell is not supported.');
    };
  }
  spawnModule.__starkGuarded = true;
}

function getSpawnModule() {
  try {
    return cachedShimModule !== null ? getSpawnModuleInner() : getSpawnModuleInner();
  } catch {
    return null;
  }
}

function getSpawnModuleInner() {
  // Narrow dynamic load of the built-in spawn module for guarding
  // extension-originated spawns (never extension code).
  const req = Module.createRequire(import.meta.url);
  return req('node:child_process');
}

function killOwnedDirectSpawns(owner) {
  for (const handle of [...directSpawnHandles]) {
    if (handle.owner !== owner) {
      continue;
    }
    try {
      handle.child?.kill?.('SIGTERM');
    } catch {
      // Best effort on the exact handle.
    }
    handle.alive = false;
    directSpawnHandles.delete(handle);
  }
  directSpawnCounts.delete(owner);
}

/**
 * Registry: extensionId -> {
 *   state, module, exports, extensionBase, manifest,
 *   subscriptions, commandIds, providerCounts
 * }
 * States: inactive | activating | active | deactivating | failed.
 */
const registry = new Map();
const activationFlights = new Map();

function createExtensionContext({ shim, extensionId, extensionBase, manifest, storeRoot }) {
  const Uri = shim.Uri;
  const extensionUri = Uri.file(extensionBase);
  const storageRoot = path.join(storeRoot, 'extension-storage', safeStorageDirName(extensionId));
  const context = {
    subscriptions: [],
    extensionUri,
    extensionPath: extensionBase,
    globalStorageUri: Uri.file(path.join(storageRoot, 'global')),
    workspaceStorageUri: Uri.file(path.join(storageRoot, 'workspace')),
    globalState: new shim.Memento(extensionId, 'global', snapshotStorageScope(storeRoot, extensionId, 'global-state.json')),
    workspaceState: new shim.Memento(extensionId, 'workspace', snapshotStorageScope(storeRoot, extensionId, 'workspace-state.json')),
    extensionMode: 1,
    extension: {
      id: `${manifest.publisher}.${manifest.name}`,
      extensionUri,
      packageJSON: {
        name: manifest.name,
        publisher: manifest.publisher,
        version: manifest.version,
        displayName: manifest.displayName,
        engines: manifest.enginesVscode ? { vscode: manifest.enginesVscode } : undefined
      }
    },
    asAbsolutePath(relativePath) {
      if (typeof relativePath !== 'string' || relativePath === '' || relativePath.length > 512) {
        throw new Error('Extension path is not valid.');
      }
      return path.join(extensionBase, relativePath);
    }
  };
  // Explicit failure for secrets: no suitable secure primitive exists
  // in the host, so plaintext is never substituted.
  Object.defineProperties(context, {
    secrets: {
      get() {
        throw new Error('Unsupported VS Code API: ExtensionContext.secrets');
      }
    }
  });
  try {
    shim.__setExtensionSnapshots(extensionId, {
      config: snapshotConfigFor(storeRoot, extensionId),
      globalState: { ...context.globalState.values },
      workspaceState: { ...context.workspaceState.values }
    });
  } catch {
    // Snapshots are best-effort; activation still proceeds.
  }
  return context;
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
    }
  });
}

/**
 * Activates one verified extension generically. Throws narrow errors
 * with `code` for the wire envelope (`unsupported-extension-kind`,
 * `unsupported-api`, `activation-failed`). Single flight per
 * extensionId (concurrent duplicates share the flight).
 */
export async function activateExtension({ extensionId, storeRoot, extensionDir, manifest }) {
  if (typeof extensionId !== 'string' || extensionId === '') {
    throw new Error('Activation needs an extension id.');
  }
  if (typeof storeRoot !== 'string' || storeRoot === '' || typeof extensionDir !== 'string' || extensionDir === '') {
    throw new Error('Activation needs a store root and an extension directory.');
  }
  const existingFlight = activationFlights.get(extensionId);
  if (existingFlight !== undefined) {
    return existingFlight;
  }
  const flight = runActivation({ extensionId, storeRoot, extensionDir, manifest });
  activationFlights.set(extensionId, flight);
  try {
    return await flight;
  } finally {
    if (activationFlights.get(extensionId) === flight) {
      activationFlights.delete(extensionId);
    }
  }
}

async function runActivation({ extensionId, storeRoot, extensionDir, manifest }) {
  const current = registry.get(extensionId);
  if (current !== undefined && (current.state === 'active' || current.state === 'activating')) {
    return current;
  }
  if (registry.size >= MAX_LOADED_EXTENSIONS && (current === undefined || current.state !== 'active')) {
    const error = new Error('Too many extensions are loaded.');
    error.code = 'activation-failed';
    throw error;
  }
  if (!containedUnder(extensionDir, storeRoot)) {
    const error = new Error('Extension directory escapes the extension store.');
    error.code = 'activation-failed';
    throw error;
  }
  const resolvedDir = path.resolve(storeRoot, extensionDir);
  const { namespace, name, version } = parseExtensionId(extensionId);
  const diskManifest = readManifestData(resolvedDir);
  if (diskManifest.name !== name || diskManifest.publisher !== namespace || diskManifest.version !== version) {
    const error = new Error('Extension manifest does not match the installed extension.');
    error.code = 'activation-failed';
    throw error;
  }
  // Main-supplied manifest subset is a cross-check only; disk is
  // truth. When main supplies one, identities must agree.
  if (manifest !== undefined && manifest !== null) {
    if (typeof manifest === 'object' && !Array.isArray(manifest)) {
      if ((manifest.name !== undefined && manifest.name !== diskManifest.name) ||
          (manifest.publisher !== undefined && manifest.publisher !== diskManifest.publisher) ||
          (manifest.version !== undefined && manifest.version !== diskManifest.version)) {
        const error = new Error('Extension manifest does not match the installed extension.');
        error.code = 'activation-failed';
        throw error;
      }
    }
  }
  const mainEntry = typeof diskManifest.main === 'string' && diskManifest.main !== '' ? diskManifest.main : null;
  const browserEntry = typeof diskManifest.browser === 'string' && diskManifest.browser !== '' ? diskManifest.browser : null;
  const extensionBase = path.join(resolvedDir, 'extension');
  if (mainEntry === null) {
    // Purely declarative manifests (themes/snippets/grammars/…) need
    // no activation: contributions apply without running code. This
    // resolves as a successful no-op WITHOUT a registry record (no
    // code runs, nothing to dispose). Anything executable without an
    // entrypoint fails honestly below.
    if (browserEntry === null && isDeclarativeContributes(diskManifest.contributes)) {
      return {
        state: 'active',
        declarative: true,
        module: null,
        exports: null,
        extensionBase,
        manifest: {
          name: diskManifest.name,
          publisher: diskManifest.publisher,
          version: diskManifest.version,
          displayName: typeof diskManifest.displayName === 'string' ? diskManifest.displayName : name,
          enginesVscode: null,
          activationEvents: []
        },
        subscriptions: [],
        commandIds: [],
        providerCounts: { document: 0, range: 0, codeAction: 0 }
      };
    }
    const error = new Error(
      browserEntry !== null
        ? 'Extension kind is not supported (browser-only).'
        : 'Extension has no supported entrypoint.'
    );
    error.code = 'unsupported-extension-kind';
    throw error;
  }
  // Entrypoint containment: relative path only, under extension dir.
  // Node-style extensionless mains probe `<main>.js`/`.cjs`/`.mjs`
  // (bounded, max 4 candidates) — e.g. `./client/out/extension`.
  if (mainEntry.includes('\0') || mainEntry.includes('\\') || mainEntry.startsWith('/') || /^[A-Za-z]:/.test(mainEntry)) {
    const error = new Error('Extension entrypoint escapes the extension directory.');
    error.code = 'activation-failed';
    throw error;
  }
  const resolvedBase = path.resolve(extensionBase);
  const baseLower = resolvedBase.toLowerCase();
  function contained(candidate) {
    const candidateLower = candidate.toLowerCase();
    if (candidateLower !== baseLower && !candidateLower.startsWith(baseLower + path.sep)) {
      return false;
    }
    if (candidateLower === baseLower) {
      return false;
    }
    return true;
  }
  // Explicit escape: the declared entry itself must stay contained.
  // (Probing below skips non-contained candidates; without this the
  // error would read as a missing module instead of an escape.)
  if (!contained(path.resolve(resolvedBase, mainEntry))) {
    const error = new Error('Extension entrypoint escapes the extension directory.');
    error.code = 'activation-failed';
    throw error;
  }
  function probeJs(candidate) {
    if (!/\.(mjs|cjs|js)$/i.test(candidate)) {
      return null;
    }
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    return candidate;
  }
  let resolvedEntry = null;
  for (const candidate of [mainEntry, `${mainEntry}.js`, `${mainEntry}.cjs`, `${mainEntry}.mjs`].slice(0, 4)) {
    const resolved = path.resolve(resolvedBase, candidate);
    if (!contained(resolved)) {
      continue;
    }
    const probed = probeJs(resolved);
    if (probed !== null) {
      resolvedEntry = probed;
      break;
    }
  }
  if (resolvedEntry === null) {
    const error = new Error('Extension entrypoint is not a JavaScript module.');
    error.code = 'activation-failed';
    throw error;
  }
  ensureLoader();
  ensureCjsInterception();
  const record = {
    state: 'activating',
    module: null,
    exports: null,
    extensionBase,
    manifest: {
      name: diskManifest.name,
      publisher: diskManifest.publisher,
      version: diskManifest.version,
      displayName: typeof diskManifest.displayName === 'string' ? diskManifest.displayName : name,
      enginesVscode: diskManifest.engines !== undefined && diskManifest.engines !== null && typeof diskManifest.engines === 'object'
        ? diskManifest.engines.vscode ?? null
        : null,
      activationEvents: Array.isArray(diskManifest.activationEvents) ? diskManifest.activationEvents.slice(0, 128) : []
    },
    subscriptions: [],
    commandIds: [],
    providerCounts: { document: 0, range: 0, codeAction: 0 }
  };
  registry.set(extensionId, record);
  const shimPre = await import('vscode');
  cachedShimModule = shimPre;
  ensureSpawnGuard();
  // Wire main cooperation for this host process (every sender reaches
  // the same parent port; correlation ids route responses).
  if (typeof shimPre?.__setHostRequestHandler === 'function') {
    shimPre.__setHostRequestHandler((type, payload, timeoutMs) => requestFromMain(type, payload, timeoutMs));
  }
  if (typeof shimPre?.__setHostNotify === 'function') {
    shimPre.__setHostNotify((type, payload) => postToMain('EXTENSION_NOTIFY', { notify: type, ...(payload ?? {}) }));
  }
  let setActive = false;
  try {
    if (typeof shimPre?.__setActiveExtensionId === 'function') {
      shimPre.__setActiveExtensionId(extensionId);
      setActive = true;
    }
  } catch (err) {
    registry.delete(extensionId);
    throw err;
  }
  const entryUrl = pathToFileURL(resolvedEntry).href;
  let extensionModule;
  try {
    extensionModule = await import(entryUrl);
  } catch (err) {
    try {
      if (setActive && typeof shimPre?.__clearActiveExtensionId === 'function') {
        shimPre.__clearActiveExtensionId();
      }
      if (typeof shimPre?.__disposeOwner === 'function') {
        shimPre.__disposeOwner(extensionId);
      }
    } catch {
      // Best effort cleanup.
    }
    registry.delete(extensionId);
    const unsupported = toUnsupportedErrorCode(err);
    if (unsupported !== null) {
      const error = new Error(`Unsupported VS Code API: ${unsupported.api}`);
      error.code = 'unsupported-api';
      error.unsupportedApi = unsupported.api;
      throw error;
    }
    const error = new Error('Extension entrypoint failed to load.', { cause: err });
    error.code = 'activation-failed';
    throw error;
  }
  if (extensionModule === null || typeof extensionModule !== 'object') {
    try {
      if (setActive && typeof shimPre?.__clearActiveExtensionId === 'function') {
        shimPre.__clearActiveExtensionId();
      }
    } catch { void 0; }
    registry.delete(extensionId);
    const error = new Error('Extension entrypoint has an invalid shape.');
    error.code = 'activation-failed';
    throw error;
  }
  // ESM/CJS interop: CommonJS entries (`exports.activate = …` or
  // `module.exports = { activate }`) surface through the default
  // export when the lexer cannot name them; ESM entries use named
  // exports. Named exports win when both exist.
  const defaultExport = extensionModule.default !== null && typeof extensionModule.default === 'object'
    ? extensionModule.default
    : null;
  const activateFn = typeof extensionModule.activate === 'function'
    ? extensionModule.activate
    : (defaultExport !== null && typeof defaultExport.activate === 'function' ? defaultExport.activate : undefined);
  const deactivateFn = typeof extensionModule.deactivate === 'function'
    ? extensionModule.deactivate
    : (defaultExport !== null && typeof defaultExport.deactivate === 'function' ? defaultExport.deactivate : undefined);
  if (activateFn !== undefined && typeof activateFn !== 'function') {
    try {
      if (setActive && typeof shimPre?.__clearActiveExtensionId === 'function') {
        shimPre.__clearActiveExtensionId();
      }
    } catch { void 0; }
    registry.delete(extensionId);
    const error = new Error('Extension activate export is not a function.');
    error.code = 'activation-failed';
    throw error;
  }
  if (deactivateFn !== undefined && typeof deactivateFn !== 'function') {
    try {
      if (setActive && typeof shimPre?.__clearActiveExtensionId === 'function') {
        shimPre.__clearActiveExtensionId();
      }
    } catch { void 0; }
    registry.delete(extensionId);
    const error = new Error('Extension deactivate export is not a function.');
    error.code = 'activation-failed';
    throw error;
  }
  // VS Code-compatible: absent `activate` is a successful no-op
  // activation (themes/grammars style). Only a present non-function
  // or a throwing activate fails.
  if (typeof activateFn === 'function') {
    const context = createExtensionContext({
      shim: shimPre,
      extensionId,
      extensionBase,
      manifest: {
        name: diskManifest.name,
        publisher: diskManifest.publisher,
        version: diskManifest.version,
        displayName: record.manifest.displayName,
        enginesVscode: record.manifest.enginesVscode
      },
      storeRoot: path.resolve(storeRoot)
    });
    try {
      await activateFn(context);
    } catch (err) {
      try {
        if (setActive && typeof shimPre?.__clearActiveExtensionId === 'function') {
          shimPre.__clearActiveExtensionId();
        }
        if (typeof shimPre?.__disposeOwner === 'function') {
          shimPre.__disposeOwner(extensionId);
        }
      } catch { void 0; }
      record.state = 'failed';
      registry.delete(extensionId);
      const unsupported = toUnsupportedErrorCode(err);
      if (unsupported !== null) {
        const error = new Error(`Unsupported VS Code API: ${unsupported.api}`);
        error.code = 'unsupported-api';
        error.unsupportedApi = unsupported.api;
        throw error;
      }
      const error = new Error('Extension activation failed.', { cause: err });
      error.code = 'activation-failed';
      throw error;
    }
    record.subscriptions = Array.isArray(context.subscriptions) ? context.subscriptions : [];
  }
  try {
    if (setActive && typeof shimPre?.__clearActiveExtensionId === 'function') {
      shimPre.__clearActiveExtensionId();
    }
  } catch { void 0; }
  // Capture owner-scoped registrations for disposal + formatting.
  try {
    const shim = await import('vscode');
    if (typeof shim?.__getOwnerRegistrations === 'function') {
      const owned = shim.__getOwnerRegistrations(extensionId);
      record.commandIds = Array.isArray(owned?.commands) ? owned.commands.slice(0, MAX_COMMANDS_PER_EXTENSION) : [];
      record.providerCounts = {
        document: Number(owned?.documentFormatters ?? 0) || 0,
        range: Number(owned?.rangeFormatters ?? 0) || 0,
        codeAction: Number(owned?.codeActions ?? 0) || 0
      };
    } else {
      // Legacy fallback: count via introspection arrays.
      const commands = shim?.commands?.__registeredCommands;
      record.commandIds = Array.isArray(commands) ? commands.map((c) => c?.id).filter((id) => typeof id === 'string') : [];
    }
    if (typeof shim?.__registerExtensionInfo === 'function') {
      shim.__registerExtensionInfo(extensionId, {
        id: `${diskManifest.publisher}.${diskManifest.name}`,
        packageJSON: {
          name: diskManifest.name,
          publisher: diskManifest.publisher,
          version: diskManifest.version,
          displayName: record.manifest.displayName,
          engines: record.manifest.enginesVscode ? { vscode: record.manifest.enginesVscode } : undefined
        }
      });
    }
  } catch {
    // Introspection is best-effort; activation still succeeds.
  }
  record.state = 'active';
  record.module = extensionModule;
  record.exports = defaultExport ?? extensionModule;
  if (deactivateFn !== undefined) {
    record.exports = { ...(record.exports ?? {}), deactivate: deactivateFn };
  }
  registry.set(extensionId, record);
  try {
    const shim = await import('vscode');
    notifyRegistrationsChanged(extensionId, record.commandIds.length, providerKindsForOwner(shim, extensionId));
  } catch {
    // Registration telemetry is best-effort.
  }
  return record;
}

/**
 * Deactivates one extension: bounded `deactivate()` call (5s),
 * then disposes ONLY the owning extension's registrations, its
 * exact-owned helper processes and direct spawns, and drops module
 * references. Never touches other extensions. Returns true when a
 * clean deactivate was established, false when the caller should
 * stop the owned host (hang/failure).
 */
export async function deactivateExtension({ extensionId }) {
  const record = registry.get(extensionId);
  if (record === undefined) {
    return true;
  }
  if (record.state !== 'active' && record.state !== 'failed') {
    registry.delete(extensionId);
    return true;
  }
  record.state = 'deactivating';
  let clean = true;
  const deactivateFn = record.exports?.deactivate;
  if (typeof deactivateFn === 'function') {
    try {
      await withTimeout(
        Promise.resolve().then(() => deactivateFn()),
        GENERIC_DEACTIVATE_TIMEOUT_MS,
        'Extension deactivation timed out.'
      );
    } catch {
      clean = false;
    }
  }
  try {
    const shim = await import('vscode');
    if (typeof shim?.__disposeOwner === 'function') {
      shim.__disposeOwner(extensionId);
    }
    if (typeof shim?.__unregisterExtensionInfo === 'function') {
      shim.__unregisterExtensionInfo(extensionId);
    }
  } catch {
    clean = false;
  }
  try {
    processManager.disposeOwner(extensionId);
  } catch {
    clean = false;
  }
  try {
    killOwnedDirectSpawns(extensionId);
  } catch {
    clean = false;
  }
  for (const subscription of record.subscriptions) {
    try {
      if (subscription !== null && typeof subscription === 'object' && typeof subscription.dispose === 'function') {
        subscription.dispose();
      }
    } catch {
      clean = false;
    }
  }
  registry.delete(extensionId);
  notifyRegistrationsChanged(extensionId, 0, []);
  return clean;
}

/** Host introspection: active extension ids (bounded). */
export function listActiveExtensions() {
  const out = [];
  for (const [id, record] of registry) {
    if (record.state === 'active') {
      out.push(id);
    }
    if (out.length >= MAX_LOADED_EXTENSIONS) {
      break;
    }
  }
  return out;
}

/** Host introspection: whether an extension id is active. */
export function isExtensionActive(extensionId) {
  return registry.get(extensionId)?.state === 'active';
}

/**
 * Minimal VS Code DocumentSelector match over a captured selector:
 * plain language strings and { language, scheme? } filters. Anything
 * else never matches.
 */
export function matchSelector(selector, languageId, scheme) {
  const entries = Array.isArray(selector) ? selector : [selector];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry === languageId) {
        return true;
      }
      continue;
    }
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      if (typeof entry.language === 'string' && entry.language !== languageId) {
        continue;
      }
      if (typeof entry.scheme === 'string' && entry.scheme !== scheme) {
        continue;
      }
      if (typeof entry.language === 'string') {
        return true;
      }
    }
  }
  return false;
}

function toPosition(offset, text) {
  let line = 0;
  let character = offset;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      character = offset - i - 1;
    }
  }
  return { line, character };
}

function toOffset(position, text) {
  let line = 0;
  let offset = 0;
  while (line < position.line && offset < text.length) {
    if (text[offset] === '\n') {
      line++;
    }
    offset++;
  }
  return Math.min(offset + position.character, text.length);
}

/**
 * Builds the synthetic document handed to captured providers.
 * Plain data + closures over the snapshot text: no renderer objects,
 * no workspace handles, no filesystem access of its own.
 */
export function buildSyntheticDocument({ Uri, filePath, languageId, text }) {
  const snapshot = String(text);
  return {
    uri: Uri.file(filePath),
    fileName: filePath,
    languageId: String(languageId),
    version: 1,
    eol: snapshot.includes('\r\n') ? 2 : 1,
    getText() {
      return snapshot;
    },
    positionAt(offset) {
      const clamped = Math.max(0, Math.min(Math.floor(offset), snapshot.length));
      return toPosition(clamped, snapshot);
    },
    offsetAt(position) {
      const line = Math.max(0, Math.floor(position?.line ?? 0));
      const character = Math.max(0, Math.floor(position?.character ?? 0));
      return toOffset({ line, character }, snapshot);
    }
  };
}

function isSerializableEdit(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const { range, newText } = value;
  if (typeof newText !== 'string') {
    return false;
  }
  if (range === null || typeof range !== 'object') {
    return false;
  }
  for (const end of ['start', 'end']) {
    const pos = range[end];
    if (pos === null || typeof pos !== 'object') {
      return false;
    }
    if (!Number.isInteger(pos.line) || pos.line < 0 || !Number.isInteger(pos.character) || pos.character < 0) {
      return false;
    }
  }
  return true;
}

function toSerializableEdits(edits) {
  if (edits === undefined || edits === null) {
    return [];
  }
  if (!Array.isArray(edits)) {
    const error = new Error('Provider returned an invalid result.');
    error.code = 'provider-failed';
    throw error;
  }
  const serializable = [];
  for (const edit of edits.slice(0, 64)) {
    if (!isSerializableEdit(edit)) {
      const error = new Error('Provider returned an invalid edit.');
      error.code = 'provider-failed';
      throw error;
    }
    serializable.push({
      range: {
        start: { line: edit.range.start.line, character: edit.range.start.character },
        end: { line: edit.range.end.line, character: edit.range.end.character }
      },
      newText: edit.newText
    });
  }
  return serializable;
}

function providerToken() {
  return { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } };
}

function matchingProviders(list, languageId) {
  return list
    .filter((candidate) => candidate?.provider !== null && typeof candidate?.provider === 'object' &&
      matchSelector(candidate.selector, languageId, 'file'))
    .sort((a, b) => String(a.owner ?? '').localeCompare(String(b.owner ?? '')))
    .slice(0, GENERIC_PROVIDER_MAX_CONSULTED);
}

/**
 * Formats one snapshot through the generic language registry: the
 * first active provider whose selector matches handles the request.
 * Returns validated serializable edits (possibly empty). Throws
 * narrow coded errors for the wire envelope.
 */
export async function formatSnapshot({ filePath, languageId, text }) {
  const shim = await import('vscode');
  const providers = typeof shim?.languages?.__getDocumentFormatters === 'function'
    ? shim.languages.__getDocumentFormatters()
    : [];
  // Legacy fallback: single captured formatter (pilot compat).
  let candidates = Array.isArray(providers) && providers.length > 0
    ? providers
    : (() => {
        const captured = shim?.languages?.__captured?.documentFormatter ?? null;
        return captured?.provider ? [{ selector: captured.selector, provider: captured.provider, owner: 'legacy' }] : [];
      })();
  // Deterministic order: sort by owner id for stable multi-provider
  // behavior (first match wins).
  candidates = [...candidates].sort((a, b) => String(a.owner ?? '').localeCompare(String(b.owner ?? '')));
  let matched = null;
  for (const candidate of candidates) {
    if (candidate?.provider !== null && typeof candidate?.provider === 'object' &&
        typeof candidate.provider.provideDocumentFormattingEdits === 'function' &&
        matchSelector(candidate.selector, languageId, 'file')) {
      matched = candidate;
      break;
    }
  }
  if (matched === null) {
    const error = new Error('No formatter is available for this file.');
    error.code = 'unsupported-language';
    throw error;
  }
  const document = buildSyntheticDocument({ Uri: shim.Uri, filePath, languageId, text });
  const token = providerToken();
  let edits;
  try {
    edits = await matched.provider.provideDocumentFormattingEdits(document, {}, token);
  } catch (err) {
    const unsupported = toUnsupportedErrorCode(err);
    if (unsupported !== null) {
      const error = new Error(`Unsupported VS Code API: ${unsupported.api}`);
      error.code = 'unsupported-api';
      error.unsupportedApi = unsupported.api;
      throw error;
    }
    const error = new Error(`Formatting failed: ${err instanceof Error ? err.message : 'unknown'}`);
    error.code = 'format-failed';
    throw error;
  }
  return toSerializableEdits(edits);
}

function toSerializableLocation(shim, value) {
  if (value instanceof shim.Location) {
    return { uri: value.uri.toString(), range: serializableRangeOf(value.range) };
  }
  if (value !== null && typeof value === 'object' && value.uri !== undefined && value.range !== undefined) {
    return { uri: String(value.uri?.toString?.() ?? ''), range: value.range };
  }
  return null;
}

function serializableRangeOf(range) {
  return {
    start: { line: range?.start?.line ?? 0, character: range?.start?.character ?? 0 },
    end: { line: range?.end?.line ?? 0, character: range?.end?.character ?? 0 }
  };
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value) ?? 'null';
    if (text.length > 64 * 1024) {
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Runs one language-feature query across every active extension's
 * matching providers (merged, bounded, deterministic). Kinds:
 * completion, hover, definition, references, documentSymbols,
 * workspaceSymbols, rename, signatureHelp, codeAction, rangeFormat.
 * Every provider call is bounded (5s, no retries); failures are
 * skipped (one bad provider never fails the query).
 */
export async function runProviderQuery({ kind, filePath, languageId, text, position, endPosition, query, newName }) {
  const shim = await import('vscode');
  const document = buildSyntheticDocument({ Uri: shim.Uri, filePath, languageId, text });
  const token = providerToken();
  const pos = position !== undefined && position !== null
    ? new shim.Position(Math.max(0, Math.floor(position.line ?? 0)), Math.max(0, Math.floor(position.character ?? 0)))
    : null;

  function currentAttribution() {
    try {
      return cachedShimModule?.__getActiveExtensionId?.() ?? null;
    } catch {
      return null;
    }
  }

  function restoreAttribution(previous) {
    try {
      if (previous !== null && previous !== undefined) {
        cachedShimModule?.__setActiveExtensionId?.(previous);
      } else {
        cachedShimModule?.__clearActiveExtensionId?.();
      }
    } catch {
      // Best effort.
    }
  }

  async function callProvider(owner, provider, method, args) {
    const previous = currentAttribution();
    if (typeof owner === 'string' && owner !== '') {
      try {
        cachedShimModule?.__setActiveExtensionId?.(owner);
      } catch {
        // Attribution is best-effort.
      }
    }
    try {
      return await withTimeout(
        Promise.resolve().then(() => provider[method](...args)),
        GENERIC_PROVIDER_TIMEOUT_MS,
        'Provider timed out.'
      );
    } catch {
      return undefined;
    } finally {
      restoreAttribution(previous);
    }
  }

  if (kind === 'completion') {
    const candidates = matchingProviders(
      typeof shim.languages.__getCompletionProviders === 'function' ? shim.languages.__getCompletionProviders() : [],
      languageId
    ).filter((c) => typeof c.provider.provideCompletionItems === 'function');
    const items = [];
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideCompletionItems', [document, pos, token, {}]);
      const list = Array.isArray(result) ? result : result?.items;
      if (!Array.isArray(list)) {
        continue;
      }
      for (const item of list.slice(0, 100)) {
        if (itemDefinitions(item)) {
          items.push(itemDefinitions(item));
        }
        if (items.length >= 200) {
          break;
        }
      }
      if (items.length >= 200) {
        break;
      }
    }
    return { kind, items: items.slice(0, 200) };
  }

  function itemDefinitions(item) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const label = typeof item.label === 'string' ? item.label : item.label?.label;
    if (typeof label !== 'string' || label === '') {
      return null;
    }
    return {
      label: label.slice(0, 256),
      kind: typeof item.kind === 'number' ? item.kind : 0,
      detail: typeof item.detail === 'string' ? item.detail.slice(0, 512) : undefined,
      documentation: typeof item.documentation === 'string'
        ? item.documentation.slice(0, 2048)
        : item.documentation?.value !== undefined ? String(item.documentation.value).slice(0, 2048) : undefined,
      insertText: typeof item.insertText === 'string'
        ? item.insertText.slice(0, 2048)
        : item.insertText?.value !== undefined ? String(item.insertText.value).slice(0, 2048) : undefined
    };
  }

  if (kind === 'hover') {
    const candidates = matchingProviders(
      typeof shim.languages.__getHoverProviders === 'function' ? shim.languages.__getHoverProviders() : [],
      languageId
    ).filter((c) => typeof c.provider.provideHover === 'function');
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideHover', [document, pos, token]);
      if (result !== undefined && result !== null) {
        const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
        const text = contents
          .map((entry) => (typeof entry === 'string' ? entry : entry?.value ?? ''))
          .filter((entry) => typeof entry === 'string' && entry !== '')
          .join('\n')
          .slice(0, 8192);
        if (text !== '') {
          return { kind, contents: text };
        }
      }
    }
    return { kind, contents: '' };
  }

  if (kind === 'definition' || kind === 'references') {
    const getter = kind === 'definition' ? '__getDefinitionProviders' : '__getReferenceProviders';
    const method = kind === 'definition' ? 'provideDefinition' : 'provideReferences';
    const list = typeof shim.languages[getter] === 'function' ? shim.languages[getter]() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider[method] === 'function');
    const out = [];
    const args = kind === 'definition'
      ? [document, pos, token]
      : [document, pos, { includeDeclaration: true }, token];
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, method, args);
      const entries = Array.isArray(result) ? result : result === undefined || result === null ? [] : [result];
      for (const entry of entries.slice(0, 32)) {
        const location = toSerializableLocation(shim, entry);
        if (location !== null) {
          out.push(location);
        }
        if (out.length >= 100) {
          break;
        }
      }
      if (out.length >= 100) {
        break;
      }
    }
    return { kind, locations: out.slice(0, 100) };
  }

  if (kind === 'documentSymbols') {
    const list = typeof shim.languages.__getDocumentSymbolProviders === 'function'
      ? shim.languages.__getDocumentSymbolProviders()
      : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideDocumentSymbols === 'function');
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideDocumentSymbols', [document, token]);
      if (Array.isArray(result)) {
        return { kind, symbols: result.slice(0, 100).map(symbolShape).filter((entry) => entry !== null) };
      }
    }
    return { kind, symbols: [] };
  }

  function symbolShape(symbol) {
    if (symbol === null || typeof symbol !== 'object') {
      return null;
    }
    const name = typeof symbol.name === 'string' ? symbol.name : null;
    if (name === null || name === '') {
      return null;
    }
    return {
      name: name.slice(0, 256),
      kind: typeof symbol.kind === 'number' ? symbol.kind : 0,
      range: symbol.range !== undefined ? symbol.range : undefined,
      location: symbol.location !== undefined ? toSerializableLocation(shim, symbol.location) : undefined
    };
  }

  if (kind === 'workspaceSymbols') {
    const list = typeof shim.languages.__getWorkspaceSymbolProviders === 'function'
      ? shim.languages.__getWorkspaceSymbolProviders()
      : [];
    const out = [];
    for (const candidate of list.slice(0, GENERIC_PROVIDER_MAX_CONSULTED)) {
      if (typeof candidate.provider.provideWorkspaceSymbols !== 'function') {
        continue;
      }
      const result = await callProvider(candidate.owner, candidate.provider, 'provideWorkspaceSymbols', [String(query ?? '').slice(0, 128), token]);
      if (Array.isArray(result)) {
        for (const entry of result.slice(0, 32)) {
          if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string') {
            out.push({ name: entry.name.slice(0, 256), kind: typeof entry.kind === 'number' ? entry.kind : 0 });
          }
          if (out.length >= 100) {
            break;
          }
        }
      }
      if (out.length >= 100) {
        break;
      }
    }
    return { kind, symbols: out.slice(0, 100) };
  }

  if (kind === 'rename') {
    const list = typeof shim.languages.__getRenameProviders === 'function' ? shim.languages.__getRenameProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideRenameEdits === 'function');
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideRenameEdits', [document, pos, String(newName ?? '').slice(0, 256), token]);
      if (result !== undefined && result !== null) {
        const entries = Array.isArray(result.entries) ? result.entries : [];
        // Rename proposals route to review like any WorkspaceEdit:
        // return them as serializable edits for the review pipeline.
        const owner = candidate.owner ?? 'unknown';
        postToMain('EXTENSION_NOTIFY', { notify: 'EDIT_PROPOSAL', owner, edits: entries.slice(0, 64) });
        return { kind, proposed: true };
      }
    }
    return { kind, proposed: false };
  }

  if (kind === 'signatureHelp') {
    const list = typeof shim.languages.__getSignatureHelpProviders === 'function'
      ? shim.languages.__getSignatureHelpProviders()
      : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideSignatureHelp === 'function');
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideSignatureHelp', [document, pos, token, {}]);
      if (result !== undefined && result !== null && Array.isArray(result.signatures)) {
        return {
          kind,
          signatures: result.signatures.slice(0, 8).map((signature) => ({
            label: String(signature?.label ?? '').slice(0, 512),
            documentation: typeof signature?.documentation === 'string' ? signature.documentation.slice(0, 2048) : undefined
          }))
        };
      }
    }
    return { kind, signatures: [] };
  }

  if (kind === 'codeAction') {
    const candidates = matchingProviders(
      typeof shim.languages.__getCodeActionProviders === 'function' ? shim.languages.__getCodeActionProviders() : [],
      languageId
    ).filter((c) => typeof c.provider.provideCodeActions === 'function');
    const range = endPosition !== undefined && endPosition !== null
      ? new shim.Range(
        new shim.Position(Math.max(0, Math.floor(position?.line ?? 0)), Math.max(0, Math.floor(position?.character ?? 0))),
        new shim.Position(Math.max(0, Math.floor(endPosition.line ?? 0)), Math.max(0, Math.floor(endPosition.character ?? 0)))
      )
      : new shim.Range(pos, pos);
    const out = [];
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideCodeActions', [document, range, { diagnostics: [] }, token]);
      if (Array.isArray(result)) {
        for (const action of result.slice(0, 32)) {
          if (action !== null && typeof action === 'object' && typeof action.title === 'string') {
            out.push({ title: action.title.slice(0, 512) });
          }
          if (out.length >= 64) {
            break;
          }
        }
      }
      if (out.length >= 64) {
        break;
      }
    }
    return { kind, actions: out.slice(0, 64) };
  }

  if (kind === 'rangeFormat') {
    const list = typeof shim.languages.__getRangeFormatters === 'function' ? shim.languages.__getRangeFormatters() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideDocumentRangeFormattingEdits === 'function');
    const range = new shim.Range(
      new shim.Position(Math.max(0, Math.floor(position?.line ?? 0)), Math.max(0, Math.floor(position?.character ?? 0))),
      new shim.Position(Math.max(0, Math.floor(endPosition?.line ?? 0)), Math.max(0, Math.floor(endPosition?.character ?? 0)))
    );
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideDocumentRangeFormattingEdits', [document, range, {}, token]);
      if (result !== undefined) {
        try {
          return { kind, edits: toSerializableEdits(result) };
        } catch {
          return { kind, edits: [] };
        }
      }
    }
    return { kind, edits: [] };
  }

  if (kind === 'codeLens') {
    const list = typeof shim.languages.__getCodeLensProviders === 'function' ? shim.languages.__getCodeLensProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideCodeLenses === 'function');
    const out = [];
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideCodeLenses', [document, token]);
      if (Array.isArray(result)) {
        for (const lens of result.slice(0, 64)) {
          if (lens !== null && typeof lens === 'object' && lens.range !== undefined) {
            out.push({
              range: lens.range,
              title: typeof lens.command?.title === 'string' ? lens.command.title.slice(0, 256) : undefined,
              command: typeof lens.command?.command === 'string' ? lens.command.command.slice(0, 128) : undefined
            });
          }
          if (out.length >= 128) {
            break;
          }
        }
      }
      if (out.length >= 128) {
        break;
      }
    }
    return { kind, lenses: out.slice(0, 128) };
  }

  if (kind === 'documentLink') {
    const list = typeof shim.languages.__getDocumentLinkProviders === 'function' ? shim.languages.__getDocumentLinkProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideDocumentLinks === 'function');
    const out = [];
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideDocumentLinks', [document, token]);
      if (Array.isArray(result)) {
        for (const link of result.slice(0, 64)) {
          if (link !== null && typeof link === 'object' && link.range !== undefined && link.target !== undefined) {
            out.push({ range: link.range, target: String(link.target?.toString?.() ?? '').slice(0, 4096) });
          }
          if (out.length >= 128) {
            break;
          }
        }
      }
      if (out.length >= 128) {
        break;
      }
    }
    return { kind, links: out.slice(0, 128) };
  }

  if (kind === 'documentHighlight') {
    const list = typeof shim.languages.__getDocumentHighlightProviders === 'function' ? shim.languages.__getDocumentHighlightProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideDocumentHighlights === 'function');
    const out = [];
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideDocumentHighlights', [document, pos, token]);
      if (Array.isArray(result)) {
        for (const highlight of result.slice(0, 64)) {
          if (highlight !== null && typeof highlight === 'object' && highlight.range !== undefined) {
            out.push({ range: highlight.range, kind: typeof highlight.kind === 'number' ? highlight.kind : 0 });
          }
          if (out.length >= 128) {
            break;
          }
        }
      }
      if (out.length >= 128) {
        break;
      }
    }
    return { kind, highlights: out.slice(0, 128) };
  }

  if (kind === 'foldingRange') {
    const list = typeof shim.languages.__getFoldingRangeProviders === 'function' ? shim.languages.__getFoldingRangeProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideFoldingRanges === 'function');
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideFoldingRanges', [document, {}, token]);
      if (Array.isArray(result)) {
        return {
          kind,
          ranges: result.slice(0, 256).filter((entry) => entry !== null && typeof entry === 'object').map((entry) => ({
            start: Math.max(0, Math.floor(entry.start ?? 0)),
            end: Math.max(0, Math.floor(entry.end ?? 0)),
            kind: typeof entry.kind === 'number' ? entry.kind : undefined
          }))
        };
      }
    }
    return { kind, ranges: [] };
  }

  if (kind === 'selectionRange') {
    const list = typeof shim.languages.__getSelectionRangeProviders === 'function' ? shim.languages.__getSelectionRangeProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideSelectionRanges === 'function');
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideSelectionRanges', [document, [pos], token]);
      if (Array.isArray(result) && result.length > 0) {
        const chain = [];
        let current = result[0];
        for (let depth = 0; depth < 16 && current !== null && typeof current === 'object'; depth++) {
          if (current.range === undefined) {
            break;
          }
          chain.push({ range: current.range });
          current = current.parent;
        }
        return { kind, chain };
      }
    }
    return { kind, chain: [] };
  }

  if (kind === 'inlayHint') {
    const list = typeof shim.languages.__getInlayHintsProviders === 'function' ? shim.languages.__getInlayHintsProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideInlayHints === 'function');
    const fullRange = new shim.Range(new shim.Position(0, 0), new shim.Position(1000000, 0));
    const out = [];
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideInlayHints', [document, fullRange, token]);
      if (Array.isArray(result)) {
        for (const hint of result.slice(0, 128)) {
          if (hint === null || typeof hint !== 'object' || hint.position === undefined) {
            continue;
          }
          const label = typeof hint.label === 'string'
            ? hint.label
            : Array.isArray(hint.label) ? hint.label.map((part) => (typeof part === 'string' ? part : part?.value ?? '')).join('') : '';
          out.push({
            position: hint.position,
            label: String(label).slice(0, 512),
            kind: typeof hint.kind === 'number' ? hint.kind : undefined
          });
          if (out.length >= 256) {
            break;
          }
        }
      }
      if (out.length >= 256) {
        break;
      }
    }
    return { kind, hints: out.slice(0, 256) };
  }

  if (kind === 'documentColor') {
    const list = typeof shim.languages.__getDocumentColorProviders === 'function' ? shim.languages.__getDocumentColorProviders() : [];
    const candidates = matchingProviders(list, languageId).filter((c) => typeof c.provider.provideDocumentColors === 'function');
    for (const candidate of candidates) {
      const result = await callProvider(candidate.owner, candidate.provider, 'provideDocumentColors', [document, token]);
      if (Array.isArray(result)) {
        return {
          kind,
          colors: result.slice(0, 128).filter((entry) => entry !== null && typeof entry === 'object' && entry.range !== undefined).map((entry) => ({
            range: entry.range,
            color: {
              red: Number(entry.color?.red ?? 0),
              green: Number(entry.color?.green ?? 0),
              blue: Number(entry.color?.blue ?? 0),
              alpha: Number(entry.color?.alpha ?? 1)
            }
          }))
        };
      }
    }
    return { kind, colors: [] };
  }

  const error = new Error(`Unknown provider query: ${String(kind)}`);
  error.code = 'provider-failed';
  throw error;
}

/**
 * Executes one registered command by id (palette path): resolves any
 * owner's registration with the shim's nesting bound, serializes the
 * result (bounded), and reports narrow coded errors.
 */
export async function executeHostCommand({ command, args }) {
  const shim = await import('vscode');
  if (typeof command !== 'string' || command === '') {
    const error = new Error('Command id is not valid.');
    error.code = 'invalid-command';
    throw error;
  }
  const boundedArgs = Array.isArray(args) ? args.slice(0, 8) : [];
  // Attribute nested host cooperation (prompts, edits) to the owning
  // extension while its handler runs; restore afterwards.
  const owner = typeof shim?.__getCommandOwner === 'function' ? shim.__getCommandOwner(command) : null;
  const previous = typeof shim?.__getActiveExtensionId === 'function' ? shim.__getActiveExtensionId() : null;
  if (typeof owner === 'string' && owner !== '' && typeof shim?.__setActiveExtensionId === 'function') {
    try {
      shim.__setActiveExtensionId(owner);
    } catch {
      // Attribution is best-effort.
    }
  }
  try {
    const result = await shim.commands.executeCommand(command, ...boundedArgs);
    const safe = result === undefined ? null : safeJson(result);
    return { ok: true, result: safe };
  } catch (err) {
    const unsupported = toUnsupportedErrorCode(err);
    if (unsupported !== null) {
      const error = new Error(`Unsupported VS Code API: ${unsupported.api}`);
      error.code = 'unsupported-api';
      error.unsupportedApi = unsupported.api;
      throw error;
    }
    const error = new Error(err instanceof Error ? err.message : 'Command failed.');
    error.code = 'command-failed';
    throw error;
  } finally {
    if (typeof shim?.__setActiveExtensionId === 'function' || typeof shim?.__clearActiveExtensionId === 'function') {
      try {
        if (previous !== null && previous !== undefined && typeof shim?.__setActiveExtensionId === 'function') {
          shim.__setActiveExtensionId(previous);
        } else if (typeof shim?.__clearActiveExtensionId === 'function') {
          shim.__clearActiveExtensionId();
        }
      } catch {
        // Best effort.
      }
    }
  }
}

function providerKindsForOwner(shim, owner) {
  const kinds = [];
  try {
    const owned = shim?.__getOwnerRegistrations?.(owner);
    if (owned !== null && typeof owned === 'object') {
      const mapping = [
        ['documentFormatters', 'documentFormatter'],
        ['rangeFormatters', 'rangeFormatter'],
        ['codeActions', 'codeAction'],
        ['completions', 'completion'],
        ['hovers', 'hover'],
        ['definitions', 'definition'],
        ['references', 'reference'],
        ['documentSymbols', 'documentSymbol'],
        ['renames', 'rename'],
        ['signatureHelp', 'signatureHelp'],
        ['codeLens', 'codeLens'],
        ['documentLinks', 'documentLink'],
        ['highlights', 'highlight']
      ];
      for (const [field, kind] of mapping) {
        if (Number(owned[field] ?? 0) > 0) {
          kinds.push(kind);
        }
      }
    }
  } catch {
    // Best effort.
  }
  return kinds;
}

function notifyRegistrationsChanged(extensionId, commandCount, providers) {
  postToMain('EXTENSION_NOTIFY', {
    notify: 'REGISTRATIONS_CHANGED',
    owner: extensionId,
    commands: commandCount,
    providers
  });
}

/**
 * Bootstrap delegate: handles one generic message, replying through
 * the channel. Never throws outward (bootstrap guards regardless).
 */
export async function handleExtensionMessage(message, channel) {
  const { type, payload } = message;
  const post = channel?.postMessage;
  if (typeof post !== 'function') {
    throw new Error('Extension channel is not valid.');
  }
  // Every sender reaches the same parent port; remember the latest
  // for fire-and-forget host notifications and correlated requests.
  activePost = post;
  if (payload === null || typeof payload !== 'object') {
    throw new Error('Extension message needs a payload.');
  }
  if (type === 'ACTIVATE_EXTENSION') {
    const { activationId, extensionId, storeRoot, extensionDir, manifest } = payload;
    try {
      await activateExtension({ extensionId, storeRoot, extensionDir, manifest });
      post('EXTENSION_ACTIVATED', { activationId, extensionId });
    } catch (err) {
      const code = typeof err?.code === 'string' && err.code !== '' ? err.code : 'activation-failed';
      const wire = { activationId, extensionId, code };
      if (typeof err?.unsupportedApi === 'string' && err.unsupportedApi !== '') {
        wire.unsupportedApi = String(err.unsupportedApi).slice(0, 256);
      } else {
        const unsupported = err instanceof Error ? toUnsupportedErrorCode(err) : null;
        if (unsupported !== null) {
          wire.code = 'unsupported-api';
          wire.unsupportedApi = unsupported.api;
        }
      }
      post('EXTENSION_ACTIVATION_ERROR', wire);
    }
    return;
  }
  if (type === 'DEACTIVATE_EXTENSION') {
    const { activationId, extensionId } = payload;
    try {
      await deactivateExtension({ extensionId });
    } catch {
      // Disposal is best-effort; the ack below still unblocks main.
    }
    post('EXTENSION_DEACTIVATED', { activationId, extensionId });
    return;
  }
  if (type === 'FORMAT_DOCUMENT') {
    try {
      const edits = await formatSnapshot({
        filePath: payload.filePath,
        languageId: payload.languageId,
        text: payload.text
      });
      post('FORMAT_RESULT', { requestId: payload.requestId, edits });
    } catch (err) {
      if (err?.code === 'unsupported-api') {
        post('FORMAT_ERROR', {
          requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
          code: 'unsupported-api',
          unsupportedApi: typeof err?.unsupportedApi === 'string' ? err.unsupportedApi : undefined
        });
        return;
      }
      post('FORMAT_ERROR', {
        requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
        code: typeof err?.code === 'string' ? err.code : 'format-failed'
      });
    }
    return;
  }
  if (type === 'PROVIDER_QUERY') {
    try {
      const result = await runProviderQuery({
        kind: payload.kind,
        filePath: payload.filePath,
        languageId: payload.languageId,
        text: payload.text,
        position: payload.position,
        endPosition: payload.endPosition,
        query: payload.query,
        newName: payload.newName
      });
      post('PROVIDER_RESULT', { queryId: payload.queryId, ok: true, result });
    } catch (err) {
      post('PROVIDER_RESULT', {
        queryId: typeof payload.queryId === 'string' ? payload.queryId : '',
        ok: false,
        code: typeof err?.code === 'string' ? err.code : 'provider-failed'
      });
    }
    return;
  }
  if (type === 'EXECUTE_COMMAND') {
    const { requestId, command, args } = payload;
    try {
      const outcome = await executeHostCommand({ command, args });
      post('COMMAND_RESULT', { requestId, command, ok: true, result: outcome.result });
    } catch (err) {
      const wire = {
        requestId: typeof requestId === 'string' ? requestId : '',
        command: typeof command === 'string' ? command : '',
        ok: false,
        code: typeof err?.code === 'string' ? err.code : 'command-failed'
      };
      if (typeof err?.unsupportedApi === 'string' && err.unsupportedApi !== '') {
        wire.unsupportedApi = String(err.unsupportedApi).slice(0, 256);
      }
      post('COMMAND_RESULT', wire);
    }
    return;
  }
  if (type === 'DOCUMENT_EVENT' || type === 'ACTIVE_EDITOR') {
    try {
      const shim = await import('vscode');
      if (type === 'DOCUMENT_EVENT' && typeof shim?.__applyDocumentEvent === 'function') {
        shim.__applyDocumentEvent(payload.event);
      } else if (type === 'ACTIVE_EDITOR' && typeof shim?.__setActiveEditor === 'function') {
        shim.__setActiveEditor(payload.editor ?? null);
      }
    } catch {
      // Document sync is best-effort; the host stays usable.
    }
    return;
  }
  if (type === 'WATCHER_EVENT') {
    try {
      const shim = await import('vscode');
      if (typeof shim?.__dispatchWatcherEvent === 'function') {
        shim.__dispatchWatcherEvent(payload.watcherId, payload.kind, payload.uri);
      }
    } catch {
      // Watcher dispatch is best-effort.
    }
    return;
  }
  if (type === 'WORKSPACE_FOLDERS') {
    try {
      const shim = await import('vscode');
      if (typeof shim?.__setWorkspaceFolders === 'function') {
        shim.__setWorkspaceFolders(payload.folders ?? null);
      }
    } catch {
      // Folder sync is best-effort.
    }
    return;
  }
  if (type === 'HOST_RESPONSE') {
    resolveHostRequest(payload.requestId, payload.response ?? null);
    return;
  }
  throw new Error(`Unknown extension message: ${String(type)}`);
}

/** Test/host introspection: active ids. */
export function __listActive() {
  return listActiveExtensions();
}

/** Test/host introspection: pending request count (bounded). */
export function __pendingRequestCount() {
  return pendingHostRequests.size;
}

/** Test-only reset (fresh module state per test file via query params). */
export function __resetForTests() {
  registry.clear();
  activationFlights.clear();
  pendingHostRequests.clear();
  directSpawnHandles.clear();
  directSpawnCounts.clear();
  try {
    processManager.__resetForTests();
  } catch {
    // Best effort.
  }
}
