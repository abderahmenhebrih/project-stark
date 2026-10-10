'use strict';
/**
 * STARK-owned Terminal Host bootstrap (human PTYs only).
 *
 * This is the ONLY entrypoint the Terminal Host process runs. It is
 * plain dependency-free Node.js at the top level: no static imports,
 * no filesystem access, no network, no child processes of its own. It
 * initializes the terminal host runtime (which owns every node-pty
 * handle), reports READY over the private parent port, and routes
 * control messages:
 *
 *   Main → Host:  SHUTDOWN, CREATE, WRITE, RESIZE, KILL
 *   Host → Main:  READY, SHUTDOWN_COMPLETE,
 *                 CREATED, CREATE_FAILED, DATA, EXIT, KILL_RESULT
 *
 * The node-pty module is resolved beside the shipped artifacts (never
 * a renderer path, never an installed-extension path). Unknown or
 * malformed messages are ignored by the runtime. This file NEVER
 * spawns worker terminals, runtime processes, or extension code, and
 * NEVER mixes with the Extension Host process.
 */

async function main() {
  if (process.parentPort === null || process.parentPort === undefined) {
    process.exit(1);
    return;
  }
  const parentPort = process.parentPort;
  let nodePty = null;
  try {
    const imported = await import('node-pty');
    nodePty = imported && imported.default ? imported.default : imported;
  } catch (err) {
    void err;
    process.exit(1);
    return;
  }
  let createRuntime = null;
  try {
    const runtime = await import('./terminal-host.mjs');
    if (runtime !== null && typeof runtime.createTerminalHostRuntime === 'function') {
      createRuntime = runtime.createTerminalHostRuntime;
    }
  } catch (err) {
    void err;
    process.exit(1);
    return;
  }
  if (createRuntime === null || typeof createRuntime !== 'function' || nodePty === null || typeof nodePty.spawn !== 'function') {
    process.exit(1);
    return;
  }
  try {
    createRuntime({
      spawnPty: (file, args, options) => nodePty.spawn(file, args, options),
      send: (message) => parentPort.postMessage(message),
      onMessage: (listener) => parentPort.on('message', (event) => listener(event.data))
    });
  } catch (err) {
    void err;
    process.exit(1);
  }
}

void main();
