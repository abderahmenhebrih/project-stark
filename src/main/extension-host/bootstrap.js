'use strict';
/**
 * STARK-owned Extension Host bootstrap (foundation only).
 *
 * This is the ONLY code the Extension Host process runs. It is plain
 * dependency-free Node.js: no imports, no filesystem access, no
 * network, no child processes. It initializes, reports READY over the
 * private parent port, and answers exactly two control messages:
 *
 *   Main → Host:  PING, SHUTDOWN
 *   Host → Main:  READY, PONG, HOST_ERROR, SHUTDOWN_COMPLETE
 *
 * It NEVER requires, imports, reads, or executes installed extension
 * code, manifests, activation events, or package scripts. Unknown or
 * malformed messages are answered with HOST_ERROR and otherwise
 * ignored. Control messages are capped at 64 KiB.
 */

const PROTOCOL = 'stark-extension-host/v1';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAIN_TO_HOST_TYPES = ['PING', 'SHUTDOWN'];

function messageByteLength(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? MAX_MESSAGE_BYTES + 1 : Buffer.byteLength(text, 'utf8');
  } catch (err) {
    void err;
    return MAX_MESSAGE_BYTES + 1;
  }
}

function isAllowedInbound(value) {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (value.protocol !== PROTOCOL) {
    return false;
  }
  if (typeof value.type !== 'string') {
    return false;
  }
  if (MAIN_TO_HOST_TYPES.indexOf(value.type) === -1) {
    return false;
  }
  return messageByteLength(value) <= MAX_MESSAGE_BYTES;
}

function send(type) {
  // parentPort exists only under Electron utilityProcess; without it
  // there is no private channel, so the process cannot serve main.
  if (process.parentPort === null || process.parentPort === undefined) {
    process.exit(1);
    return;
  }
  process.parentPort.postMessage({ protocol: PROTOCOL, type: type });
}

function fail(reason) {
  if (process.parentPort !== null && process.parentPort !== undefined) {
    try {
      process.parentPort.postMessage({ protocol: PROTOCOL, type: 'HOST_ERROR', reason: String(reason).slice(0, 256) });
    } catch (err) {
      void err;
    }
  }
}

function handleMessage(message) {
  if (!isAllowedInbound(message)) {
    fail('rejected control message');
    return;
  }
  if (message.type === 'PING') {
    send('PONG');
    return;
  }
  if (message.type === 'SHUTDOWN') {
    send('SHUTDOWN_COMPLETE');
    setImmediate(() => {
      process.exit(0);
    });
  }
}

function main() {
  if (process.parentPort === null || process.parentPort === undefined) {
    process.exit(1);
    return;
  }
  process.parentPort.on('message', (event) => {
    try {
      handleMessage(event.data !== undefined ? event.data : event);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'handler failure');
    }
  });
  send('READY');
}

main();
