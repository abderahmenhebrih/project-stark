/**
 * STARK-owned Extension Host formatter adapter (generic activation core).
 *
 * Legacy `ACTIVATE_FORMATTER` / `FORMAT_DOCUMENT` / `DEACTIVATE_FORMATTER`
 * messages now run through the SAME generic pipeline as every other
 * extension (`generic-host.mjs`) — there is NO Prettier-only allowlist
 * in this file. The `PILOT_*` constants below remain only as the
 * feature-level default the formatter service passes in (Format
 * Document prefers Prettier when installed); they never gate whether
 * the host may load a package. Any installed + enabled extension whose
 * manifest verifies and whose entrypoint registers a document
 * formatter can activate here.
 *
 * Loaded ONLY via the bootstrap's narrow dynamic import of a
 * main-supplied STARK-owned file URL — never by path invention, never
 * from renderer input.
 *
 * ESM with node: imports only (no third-party imports). Testable by
 * importing this file directly with a fake channel.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  activateExtension as genericActivate,
  deactivateExtension as genericDeactivate,
  formatSnapshot as genericFormatSnapshot,
  matchSelector as genericMatchSelector,
  buildSyntheticDocument as genericBuildSyntheticDocument,
  __listActive as genericListActive,
  __resetForTests as genericReset
} from './generic-host.mjs';

/**
 * Legacy feature default (NOT a gate): Format Document prefers this
 * identity when installed. The host never checks it — activation
 * verifies whatever identity the manifest carries.
 */
export const PILOT_FORMATTER_NAMESPACE = 'esbenp';
export const PILOT_FORMATTER_NAME = 'prettier-vscode';

/** Maximum manifest bytes parsed as data. */
export const FORMATTER_MANIFEST_MAX_BYTES = 1024 * 1024;

function containedUnder(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  const rootLower = resolvedRoot.toLowerCase();
  const candidateLower = resolvedCandidate.toLowerCase();
  return candidateLower === rootLower || candidateLower.startsWith(rootLower + path.sep);
}

function readManifestIdentity(extensionDir, storeRoot) {
  if (!containedUnder(extensionDir, storeRoot)) {
    throw new Error('Extension directory escapes the extension store.');
  }
  const resolvedDir = path.resolve(storeRoot, extensionDir);
  const manifestPath = path.join(resolvedDir, 'extension', 'package.json');
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
  if (typeof parsed.name !== 'string' || typeof parsed.publisher !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('Extension manifest is missing its identity.');
  }
  return { extensionId: `${parsed.publisher}.${parsed.name}@${parsed.version}`, manifest: parsed };
}

/**
 * Activates any verified extension that registers a document
 * formatter (generic pipeline, no allowlist). Throws when the
 * package fails verification or registers no formatter.
 */
export async function activateFormatter({ storeRoot, extensionDir }) {
  if (typeof storeRoot !== 'string' || storeRoot === '' || typeof extensionDir !== 'string' || extensionDir === '') {
    throw new Error('Activation needs a store root and an extension directory.');
  }
  const { extensionId, manifest } = readManifestIdentity(extensionDir, storeRoot);
  await genericActivate({
    extensionId,
    storeRoot,
    extensionDir,
    manifest: {
      name: manifest.name,
      publisher: manifest.publisher,
      version: manifest.version,
      displayName: typeof manifest.displayName === 'string' ? manifest.displayName : manifest.name,
      main: typeof manifest.main === 'string' ? manifest.main : null,
      browser: typeof manifest.browser === 'string' ? manifest.browser : null,
      activationEvents: Array.isArray(manifest.activationEvents) ? manifest.activationEvents : [],
      enginesVscode: manifest.engines?.vscode ?? null
    }
  });
  const shim = await import('vscode');
  let owned = 0;
  try {
    if (typeof shim?.__getOwnerRegistrations === 'function') {
      owned = shim.__getOwnerRegistrations(extensionId)?.documentFormatters ?? 0;
    } else {
      owned = shim?.languages?.__captured?.documentFormatter ? 1 : 0;
    }
  } catch {
    void 0;
  }
  if (owned <= 0) {
    // No formatter registered: unwind this activation so legacy
    // callers see a clean failure (the generic registry drops the
    // extension; other extensions are untouched).
    try {
      await genericDeactivate({ extensionId });
    } catch {
      // Best effort unwind.
    }
    throw new Error('Extension did not register a document formatter.');
  }
  return { extensionId };
}

/** Drops formatter registrations (legacy: all active formatters). */
export async function deactivateFormatter() {
  const active = genericListActive();
  for (const extensionId of active) {
    try {
      await genericDeactivate({ extensionId });
    } catch {
      // Best effort per extension.
    }
  }
  try {
    const shim = await import('vscode');
    if (shim?.languages?.__captured) {
      shim.languages.__captured.documentFormatter = null;
      shim.languages.__captured.rangeFormatter = null;
    }
  } catch {
    // Best effort legacy view reset.
  }
}

export const matchSelector = genericMatchSelector;
export const buildSyntheticDocument = genericBuildSyntheticDocument;
export const formatSnapshot = genericFormatSnapshot;

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
      const edits = await genericFormatSnapshot({
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
    await deactivateFormatter();
    post('FORMATTER_DEACTIVATED', { activationId: payload.activationId });
    return;
  }
  throw new Error(`Unknown formatter message: ${String(type)}`);
}

/** Test/host introspection only: whether any extension is active. */
export function __isActive() {
  return genericListActive().length > 0;
}

/** Test-only reset (fresh module state per test file via query params). */
export function __resetForTests() {
  genericReset();
  // Legacy captured view is owned by the shim singleton; clear it
  // best-effort so stale formatters never leak across tests (the
  // generic reset already disposed owners, this only clears the view).
  import('vscode').then((shim) => {
    try {
      if (typeof shim?.__resetForTests === 'function') {
        shim.__resetForTests();
      } else if (shim?.languages?.__captured) {
        shim.languages.__captured.documentFormatter = null;
        shim.languages.__captured.rangeFormatter = null;
      }
    } catch {
      // Best effort.
    }
  }).catch(() => {});
}
