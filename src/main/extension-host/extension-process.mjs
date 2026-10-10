/**
 * STARK-owned managed extension child processes (Step 8, host-only).
 *
 * Language servers and similar extension helpers run as bounded child
 * processes of the Extension Host (utilityProcess) — NEVER in the
 * STARK renderer and NEVER in Electron main. Each process belongs to
 * exactly one extension id; cleanup disposes ONLY that owner's
 * processes (exact-handle kill only, never broad or name-based kills).
 *
 * Hard rules (fail closed):
 * - shell:false ALWAYS (no shell interpretation, argv arrays only)
 * - command must be an extension-owned file under the extension base
 *   dir OR a bare executable basename resolved via PATH lookup off
 *   (bare names like `node` resolve through the sanitized PATH only —
 *   no absolute host paths outside the extension, no renderer input)
 * - max 4 processes per extension, max 64 globally
 * - sanitized inherited environment (same allowlist shape as the
 *   host env: operational keys only, secret-name sweep)
 * - stdout/stderr each capped at 256 KiB rolling (older bytes dropped)
 * - stdio is piped (no inherit); stdin closed by default
 * - no automatic restart loop: callers may restart explicitly, at most
 *   3 restarts per process slot (bounded, then the slot fails)
 * - kill is exact-handle only (child.kill with SIGTERM, then SIGKILL
 *   fallback after 2s); never process-group scans, never name-based kills
 *   by name, never tree walks
 *
 * Plain ESM importing only node: modules. Testable by importing this
 * file directly (no parentPort needed). The generic host owns the one
 * instance per host process.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Maximum child processes per extension. */
export const MAX_PROCESSES_PER_EXTENSION = 4;

/** Maximum child processes host-wide. */
export const MAX_PROCESSES_TOTAL = 64;

/** Maximum retained bytes per stdio stream (rolling). */
export const MAX_STREAM_BYTES = 256 * 1024;

/** Maximum argv entries / arg length. */
export const MAX_ARGV_ENTRIES = 64;
export const MAX_ARG_LENGTH = 4096;

/** Maximum explicit restarts per slot. */
export const MAX_RESTARTS_PER_SLOT = 3;

/** Graceful-stop wait before SIGKILL (ms). */
export const KILL_GRACE_MS = 2000;

/** Exact env names a child may inherit (operational only, no secrets). */
const ENV_ALLOWLIST = new Set([
  'PATH', 'Path', 'SystemRoot', 'windir', 'LANG', 'LC_ALL', 'LC_MESSAGES',
  'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'NODE_PATH'
]);

const SECRET_NAME_PATTERN = /key|token|secret|password|credential|auth|bearer|session|private|signature/i;

function sanitizedEnv(extra) {
  const out = {};
  const parentEnv = (typeof globalThis.process === 'object' && globalThis.process !== null ? globalThis.process.env : {}) ?? {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (!ENV_ALLOWLIST.has(name)) continue;
    if (SECRET_NAME_PATTERN.test(name)) continue;
    out[name] = value;
  }
  if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [name, value] of Object.entries(extra).slice(0, 32)) {
      if (typeof name !== 'string' || name === '' || name.length > 128) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      if (SECRET_NAME_PATTERN.test(name)) continue;
      if (typeof value !== 'string' || value.length > 4096) continue;
      out[name] = value;
    }
  }
  return out;
}

function validateCommand(command, extensionBase) {
  if (typeof command !== 'string' || command === '' || command.length > 512 || command.includes('\0')) {
    throw new Error('Process command is not valid.');
  }
  // Bare basename (e.g. `node`, `pwsh`): resolved via sanitized PATH
  // by the OS spawn itself. No separators, no drive letters.
  if (!command.includes('/') && !command.includes('\\') && !command.includes(':')) {
    if (!/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new Error('Process command is not valid.');
    }
    return { file: command, extensionOwned: false };
  }
  // Otherwise the command must be an extension-owned file.
  if (command.includes('\\') || command.startsWith('/') || /^[A-Za-z]:/.test(command)) {
    throw new Error('Process command escapes the extension directory.');
  }
  const base = path.resolve(extensionBase);
  const resolved = path.resolve(base, command);
  const baseLower = base.toLowerCase();
  const resolvedLower = resolved.toLowerCase();
  if (resolvedLower !== baseLower && !resolvedLower.startsWith(baseLower + path.sep)) {
    throw new Error('Process command escapes the extension directory.');
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error('Process command is not a file.');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Process command is not a file.');
  }
  return { file: resolved, extensionOwned: true };
}

function validateArgv(argv) {
  if (argv === undefined) return [];
  if (!Array.isArray(argv) || argv.length > MAX_ARGV_ENTRIES) {
    throw new Error('Process arguments are not valid.');
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || arg.includes('\0')) {
      throw new Error('Process arguments are not valid.');
    }
  }
  return [...argv];
}

function appendCapped(buffer, chunk) {
  const next = buffer + chunk;
  if (next.length <= MAX_STREAM_BYTES) return next;
  return next.slice(next.length - MAX_STREAM_BYTES);
}

export class ExtensionProcessManager {
  constructor() {
    this.slots = new Map();
    this.nextId = 1;
  }

  countFor(owner) {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.owner === owner && slot.alive) count++;
    }
    return count;
  }

  totalAlive() {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.alive) count++;
    }
    return count;
  }

  spawnManaged({ owner, extensionBase, command, argv, cwd, env }) {
    if (typeof owner !== 'string' || owner === '') {
      throw new Error('Process needs an owning extension.');
    }
    if (this.countFor(owner) >= MAX_PROCESSES_PER_EXTENSION) {
      throw new Error('Too many child processes for this extension.');
    }
    if (this.totalAlive() >= MAX_PROCESSES_TOTAL) {
      throw new Error('Too many extension child processes.');
    }
    const { file } = validateCommand(command, extensionBase);
    const args = validateArgv(argv);
    let resolvedCwd = null;
    if (cwd !== undefined && cwd !== null) {
      if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0')) {
        throw new Error('Process working directory is not valid.');
      }
      const base = path.resolve(extensionBase);
      const candidate = path.resolve(base, cwd);
      const baseLower = base.toLowerCase();
      const candidateLower = candidate.toLowerCase();
      if (candidateLower !== baseLower && !candidateLower.startsWith(baseLower + path.sep)) {
        throw new Error('Process working directory escapes the extension directory.');
      }
      resolvedCwd = candidate;
    }
    const id = `extproc-${this.nextId++}`;
    const slot = {
      id, owner, file, args, cwd: resolvedCwd, envExtra: env ?? null,
      child: null, alive: false, restarts: 0,
      stdout: '', stderr: '', exitCode: null, exitSignal: null,
      onExit: new Set()
    };
    this.slots.set(id, slot);
    this.startSlot(slot, extensionBase);
    return this.handleFor(slot);
  }

  startSlot(slot, extensionBase) {
    const child = spawn(slot.file, slot.args, {
      cwd: slot.cwd ?? extensionBase,
      env: sanitizedEnv(slot.envExtra),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    slot.child = child;
    slot.alive = true;
    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        slot.stdout = appendCapped(slot.stdout, String(chunk));
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        slot.stderr = appendCapped(slot.stderr, String(chunk));
      });
    }
    child.on('error', () => {
      slot.alive = false;
      slot.exitCode = null;
      this.emitExit(slot);
    });
    child.on('exit', (code, signal) => {
      slot.alive = false;
      slot.exitCode = code;
      slot.exitSignal = signal;
      this.emitExit(slot);
    });
  }

  emitExit(slot) {
    for (const listener of [...slot.onExit]) {
      try {
        listener({ exitCode: slot.exitCode, signal: slot.exitSignal });
      } catch {
        // Listener failures never break process control.
      }
    }
  }

  handleFor(slot) {
    return {
      get id() { return slot.id; },
      get pid() { return slot.child?.pid ?? null; },
      get alive() { return slot.alive; },
      get restarts() { return slot.restarts; },
      stdoutTail() { return slot.stdout; },
      stderrTail() { return slot.stderr; },
      onExit(listener) {
        if (typeof listener !== 'function') throw new Error('Exit listener is not valid.');
        slot.onExit.add(listener);
        return { dispose() { slot.onExit.delete(listener); } };
      },
      restart: (extensionBase) => {
        if (slot.restarts >= MAX_RESTARTS_PER_SLOT) {
          throw new Error('Process restart limit reached.');
        }
        if (slot.alive) {
          throw new Error('Process is still running.');
        }
        slot.restarts += 1;
        slot.stdout = '';
        slot.stderr = '';
        slot.exitCode = null;
        slot.exitSignal = null;
        this.startSlot(slot, extensionBase);
      },
      kill: () => {
        this.killSlot(slot);
      }
    };
  }

  killSlot(slot) {
    const child = slot.child;
    if (child === null || !slot.alive) {
      slot.alive = false;
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      slot.alive = false;
      return;
    }
    // Exact-handle escalation only: SIGKILL to the SAME handle after
    // a grace period, never a broad kill.
    globalThis.setTimeout(() => {
      if (slot.alive) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Best effort on the exact handle.
        }
      }
    }, KILL_GRACE_MS).unref?.();
  }

  disposeOwner(owner) {
    for (const slot of [...this.slots.values()]) {
      if (slot.owner === owner) {
        this.killSlot(slot);
        slot.onExit.clear();
        this.slots.delete(slot.id);
      }
    }
  }

  listOwner(owner) {
    const out = [];
    for (const slot of this.slots.values()) {
      if (slot.owner === owner) {
        out.push({ id: slot.id, alive: slot.alive, restarts: slot.restarts });
      }
    }
    return out;
  }

  __resetForTests() {
    for (const slot of [...this.slots.values()]) {
      this.killSlot(slot);
    }
    this.slots.clear();
  }
}
