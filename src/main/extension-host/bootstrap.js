'use strict';
/**
 * STARK-owned Extension Host bootstrap (formatter pilot).
 *
 * This is the ONLY entrypoint the Extension Host process runs. It is
 * plain dependency-free Node.js at the top level: no static imports,
 * no filesystem access, no network, no child processes. It
 * initializes, reports READY over the private parent port, and routes
 * control messages:
 *
 *   Main → Host:  PING, SHUTDOWN,
 *                 ACTIVATE_FORMATTER, FORMAT_DOCUMENT, DEACTIVATE_FORMATTER
 *   Host → Main:  READY, PONG, HOST_ERROR, SHUTDOWN_COMPLETE,
 *                 FORMATTER_READY, FORMAT_RESULT, FORMAT_ERROR,
 *                 FORMATTER_DEACTIVATED
 *
 * Lifecycle messages are answered inline. Formatter messages are
 * delegated to a STARK-owned formatter module whose file URL arrives
 * exclusively in the main-sent ACTIVATE payload (never from a
 * renderer, never a path the host invents). That module — and only
 * that module — may load the single allowlisted extension after its
 * own containment and identity checks. This file itself NEVER
 * requires, imports (statically), reads, or executes installed
 * extension code, manifests, activation events, or package scripts.
 * Unknown or malformed messages are answered with HOST_ERROR (or
 * FORMAT_ERROR when a request id is present) and otherwise ignored.
 * Control messages are capped at 64 KiB; formatter payloads at 2 MiB.
 */

const PROTOCOL = 'stark-extension-host/v1';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_FORMAT_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAIN_TO_HOST_TYPES = ['PING', 'SHUTDOWN', 'ACTIVATE_FORMATTER', 'FORMAT_DOCUMENT', 'DEACTIVATE_FORMATTER'];

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
  // Lifecycle controls stay on the 64 KiB cap; formatter payloads
  // (document text, edit lists) use the dedicated format cap.
  const cap = value.type === 'PING' || value.type === 'SHUTDOWN' ? MAX_MESSAGE_BYTES : MAX_FORMAT_MESSAGE_BYTES;
  return messageByteLength(value) <= cap;
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

function sendPayload(type, payload) {
  if (process.parentPort === null || process.parentPort === undefined) {
    process.exit(1);
    return;
  }
  const message = { protocol: PROTOCOL, type: type, payload: payload };
  if (messageByteLength(message) > MAX_FORMAT_MESSAGE_BYTES) {
    fail('formatter payload exceeds its bound');
    return;
  }
  process.parentPort.postMessage(message);
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
    return;
  }
  if (message.type === 'ACTIVATE_FORMATTER' || message.type === 'FORMAT_DOCUMENT' || message.type === 'DEACTIVATE_FORMATTER') {
    if (messageByteLength(message) > MAX_FORMAT_MESSAGE_BYTES) {
      failFormatter(message, 'formatter payload exceeds its bound');
      return;
    }
    void delegateFormatterMessage(message);
  }
}

/**
 * Loads the STARK-owned formatter module on first use and delegates
 * formatter messages to it. The module URL comes exclusively from the
 * main-sent ACTIVATE payload; anything else fails closed. Dynamic
 * module loading here is deliberate and narrow: this file keeps zero
 * static imports so the shipped entrypoint stays dependency-free and
 * auditable, while all extension contact lives in the delegated
 * module behind its own allowlist and containment checks.
 */
let formatterModulePromise = null;

function failFormatter(message, reason) {
  const payload = message !== null && typeof message === 'object' ? message.payload : null;
  const requestId = payload !== null && typeof payload === 'object' && typeof payload.requestId === 'string'
    ? payload.requestId
    : null;
  if (requestId !== null) {
    sendPayload('FORMAT_ERROR', { requestId: requestId, code: 'invalid-request' });
    return;
  }
  fail(reason);
}

async function delegateFormatterMessage(message) {
  try {
    const payload = message.payload;
    if (payload === null || typeof payload !== 'object') {
      failFormatter(message, 'formatter message needs a payload');
      return;
    }
    if (message.type === 'ACTIVATE_FORMATTER') {
      const moduleUrl = payload.formatterModuleUrl;
      if (typeof moduleUrl !== 'string' || moduleUrl === '' || (!moduleUrl.startsWith('file:///') && !moduleUrl.startsWith('file://localhost/'))) {
        fail('formatter module URL is not valid');
        return;
      }
      if (formatterModulePromise === null) {
        formatterModulePromise = loadFormatterModule(moduleUrl);
      }
    }
    if (formatterModulePromise === null) {
      failFormatter(message, 'formatter is not activated');
      return;
    }
    const loaded = await formatterModulePromise;
    if (loaded === null || typeof loaded.handleFormatterMessage !== 'function') {
      failFormatter(message, 'formatter module is not valid');
      return;
    }
    await loaded.handleFormatterMessage(message, {
      postMessage: (type, responsePayload) => sendPayload(type, responsePayload),
      fail: (reason) => fail(reason)
    });
  } catch (err) {
    try {
      failFormatter(message, err instanceof Error ? err.message : 'formatter failure');
    } catch (ignored) {
      void ignored;
    }
  }
}

async function loadFormatterModule(moduleUrl) {
  // Narrow dynamic load of the STARK-owned formatter module only.
  // Any failure (missing file, syntax, wrong shape) resolves to null
  // so every formatter request fails closed without crashing the host.
  try {
    return await import(moduleUrl);
  } catch (err) {
    fail(err instanceof Error ? err.message : 'formatter module failed to load');
    return null;
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
