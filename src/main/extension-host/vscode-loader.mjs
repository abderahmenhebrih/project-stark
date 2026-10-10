/**
 * STARK-owned Extension Host module loader (Prettier pilot).
 *
 * Registered via `module.register()` before any third-party import.
 * It maps exactly one bare specifier — `vscode` — to the audited
 * STARK-owned shim in this directory. Every other specifier
 * (including `prettier`, which resolves natively from the
 * allowlisted extension's own node_modules) passes through to the
 * default resolver untouched. No remapping, no interception, and no
 * behavior change for anything but `vscode`.
 *
 * Plain ESM, no imports beyond node:url.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SHIM_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vscode-shim.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    return { url: SHIM_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
