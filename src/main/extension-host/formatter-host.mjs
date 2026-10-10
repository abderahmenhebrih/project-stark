/**
 * STARK-owned Extension Host formatter module (Prettier pilot).
 *
 * Loaded ONLY via the bootstrap's narrow dynamic import of a
 * main-supplied STARK-owned file URL — never by path invention, never
 * from renderer input. This is the single place third-party extension
 * code may execute in Step 6, and it enforces every pilot boundary:
 *
 * - exact pilot allowlist: esbenp/prettier-vscode only (manifest
 *   name/publisher re-verified from disk at activation);
 * - containment: the extension directory must resolve under the
 *   main-supplied store root; the manifest `main` entrypoint must
 *   resolve under the extension directory;
 * - `vscode` resolves exclusively to the audited STARK shim via a
 *   loader hook (registered lazily here, once);
 * - only the captured document-formatting provider is ever invoked,
 *   with a host-built synthetic document (text + path + language);
 * - results leave as validated serializable edits only — the host
 *   never touches project files (it only reads the allowlisted
 *   package directory and whatever the extension itself reads during
 *   an explicit user format, e.g. upward `.prettierignore` lookup);
 * - DEACTIVATE drops registrations and module references; without a
 *   `deactivate` export there is nothing else to unwind (main stops
 *   the host process on disable).
 *
 * ESM with node: imports only (no third-party imports). Testable by
 * importing this file directly with a fake channel.
 */

import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exact pilot allowlist: nothing else may activate in Step 6. */
export const PILOT_FORMATTER_NAMESPACE = 'esbenp';
export const PILOT_FORMATTER_NAME = 'prettier-vscode';

/** Maximum manifest bytes parsed as data. */
export const FORMATTER_MANIFEST_MAX_BYTES = 1024 * 1024;

let loaderRegistered = false;
let activeFormatter = null;

function ensureLoader() {
  if (loaderRegistered) {
    return;
  }
  register('./vscode-loader.mjs', import.meta.url);
  loaderRegistered = true;
}

function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, 'extension', 'package.json');
  let stat;
  try {
    stat = fs.statSync(manifestPath);
  } catch (err) {
    throw new Error('Extension manifest is missing.', { cause: err });
  }
  if (stat.size <= 0 || stat.size > FORMATTER_MANIFEST_MAX_BYTES) {
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

function containedUnder(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  const rootLower = resolvedRoot.toLowerCase();
  const candidateLower = resolvedCandidate.toLowerCase();
  return candidateLower === rootLower || candidateLower.startsWith(rootLower + path.sep);
}

/**
 * Activates the allowlisted formatter. Throws on any boundary
 * violation (wrong identity, containment escape, missing entry,
 * missing provider). Returns the activation record.
 */
export async function activateFormatter({ storeRoot, extensionDir }) {
  if (typeof storeRoot !== 'string' || storeRoot === '' || typeof extensionDir !== 'string' || extensionDir === '') {
    throw new Error('Activation needs a store root and an extension directory.');
  }
  if (!containedUnder(extensionDir, storeRoot)) {
    throw new Error('Extension directory escapes the extension store.');
  }
  const resolvedDir = path.resolve(storeRoot, extensionDir);
  const manifest = readManifest(resolvedDir);
  if (manifest.name !== PILOT_FORMATTER_NAME || manifest.publisher !== PILOT_FORMATTER_NAMESPACE) {
    throw new Error('Only the Prettier pilot extension may activate.');
  }
  const mainEntry = typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : './dist/extension.js';
  const extensionBase = path.join(resolvedDir, 'extension');
  const resolvedEntry = path.resolve(extensionBase, mainEntry);
  const baseLower = path.resolve(extensionBase).toLowerCase();
  const entryLower = resolvedEntry.toLowerCase();
  if (entryLower !== baseLower && !entryLower.startsWith(baseLower + path.sep)) {
    throw new Error('Extension entrypoint escapes the extension directory.');
  }
  if (!/\.(mjs|cjs|js)$/i.test(resolvedEntry)) {
    throw new Error('Extension entrypoint is not a JavaScript module.');
  }
  ensureLoader();
  // Reset captures BEFORE importing: only a provider registered
  // during THIS activation may be used. Otherwise a failed or
  // provider-less activation could silently reuse a stale
  // registration from an earlier one.
  const shimPre = await import('vscode');
  try {
    if (shimPre?.languages?.__captured) {
      shimPre.languages.__captured.documentFormatter = null;
      shimPre.languages.__captured.rangeFormatter = null;
    }
  } catch (err) {
    throw new Error('Formatter shim is not valid.', { cause: err });
  }
  const entryUrl = pathToFileURL(resolvedEntry).href;
  let extensionModule;
  try {
    extensionModule = await import(entryUrl);
  } catch (err) {
    throw new Error('Extension entrypoint failed to load.', { cause: err });
  }
  if (extensionModule === null || typeof extensionModule !== 'object' || typeof extensionModule.activate !== 'function') {
    throw new Error('Extension does not export an activate function.');
  }
  const context = { subscriptions: [], extensionPath: extensionBase };
  try {
    await extensionModule.activate(context);
  } catch (err) {
    throw new Error('Extension activation failed.', { cause: err });
  }
  const shim = await import('vscode');
  const captured = shim?.languages?.__captured?.documentFormatter ?? null;
  const provider = captured?.provider ?? null;
  if (provider === null || typeof provider !== 'object' || typeof provider.provideDocumentFormattingEdits !== 'function') {
    throw new Error('Extension did not register a document formatter.');
  }
  activeFormatter = {
    extensionDir: resolvedDir,
    provider,
    selector: Array.isArray(captured.selector) ? captured.selector : [captured.selector],
    subscriptions: Array.isArray(context.subscriptions) ? context.subscriptions : []
  };
  return activeFormatter;
}

/** Drops registrations and module references (best-effort, synchronous). */
export function deactivateFormatter() {
  const current = activeFormatter;
  activeFormatter = null;
  if (current === null) {
    return;
  }
  for (const subscription of current.subscriptions) {
    try {
      if (subscription !== null && typeof subscription === 'object' && typeof subscription.dispose === 'function') {
        subscription.dispose();
      }
    } catch (err) {
      void err;
    }
  }
}

/**
 * Minimal VS Code DocumentSelector match over the captured selector:
 * plain language strings and { language, scheme? } filters. Anything
 * else never matches. Mirrors the pilot's needs only.
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
 * Builds the synthetic document handed to the captured provider.
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

/**
 * Formats one snapshot through the captured provider. Returns
 * validated serializable edits (possibly empty when already
 * formatted). Throws narrow coded errors for the wire envelope.
 */
export async function formatSnapshot({ filePath, languageId, text }) {
  const current = activeFormatter;
  if (current === null) {
    const error = new Error('Formatter is not activated.');
    error.code = 'not-activated';
    throw error;
  }
  if (!matchSelector(current.selector, languageId, 'file')) {
    const error = new Error('No formatter is available for this file.');
    error.code = 'unsupported-language';
    throw error;
  }
  const shim = await import('vscode');
  const document = buildSyntheticDocument({ Uri: shim.Uri, filePath, languageId, text });
  const token = { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } };
  let edits;
  try {
    edits = await current.provider.provideDocumentFormattingEdits(document, {}, token);
  } catch (err) {
    const error = new Error(`Formatting failed: ${err instanceof Error ? err.message : 'unknown'}`);
    error.code = 'format-failed';
    throw error;
  }
  if (edits === undefined || edits === null) {
    return [];
  }
  if (!Array.isArray(edits)) {
    const error = new Error('Formatter returned an invalid result.');
    error.code = 'format-failed';
    throw error;
  }
  const serializable = [];
  for (const edit of edits) {
    if (!isSerializableEdit(edit)) {
      const error = new Error('Formatter returned an invalid edit.');
      error.code = 'format-failed';
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

/**
 * Bootstrap delegate: handles one formatter message, replying through
 * the channel. Never throws outward (bootstrap guards regardless).
 */
export async function handleFormatterMessage(message, channel) {
  const { type, payload } = message;
  const post = channel?.postMessage;
  if (typeof post !== 'function') {
    throw new Error('Formatter channel is not valid.');
  }
  if (payload === null || typeof payload !== 'object') {
    throw new Error('Formatter message needs a payload.');
  }
  if (type === 'ACTIVATE_FORMATTER') {
    await activateFormatter({ storeRoot: payload.storeRoot, extensionDir: payload.extensionDir });
    post('FORMATTER_READY', { activationId: payload.activationId });
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
      post('FORMAT_ERROR', {
        requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
        code: typeof err?.code === 'string' ? err.code : 'format-failed'
      });
    }
    return;
  }
  if (type === 'DEACTIVATE_FORMATTER') {
    deactivateFormatter();
    post('FORMATTER_DEACTIVATED', { activationId: payload.activationId });
    return;
  }
  throw new Error(`Unknown formatter message: ${String(type)}`);
}

/** Test/host introspection only: whether a formatter is active. */
export function __isActive() {
  return activeFormatter !== null;
}

/** Test-only reset (fresh module state per test file via query params). */
export function __resetForTests() {
  deactivateFormatter();
}
