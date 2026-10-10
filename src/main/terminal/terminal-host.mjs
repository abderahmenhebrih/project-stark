/**
 * STARK-owned Terminal Host runtime (human PTYs only).
 *
 * This module owns every node-pty handle: spawn, streaming, resize,
 * and — critically — kill. Native ConPTY teardown (notably kill on
 * Windows) can block its calling thread for seconds; running it here
 * keeps Electron's main event loop responsive no matter how long a
 * teardown takes. Main stays a narrow broker (shell policy, cwd
 * resolution, ownership, caps) over the closed protocol below:
 *
 *   Main → Host:  SHUTDOWN, CREATE, WRITE, RESIZE, KILL
 *   Host → Main:  READY, SHUTDOWN_COMPLETE,
 *                 CREATED, CREATE_FAILED, DATA, EXIT, KILL_RESULT
 *
 * Plain dependency-free JS: node-pty itself is injected (production
 * passes the real module from the bootstrap; tests pass fakes), so
 * this file imports nothing and runs identically under Electron
 * utilityProcess, plain-Node child processes, and unit tests.
 * Unknown or malformed messages are ignored (CREATE answers
 * CREATE_FAILED when correlatable). Control traffic stays on the
 * 64 KiB cap; PTY output chunks reuse the 64 KiB output bound with
 * multibyte-safe splitting. No renderer contact, no worker/runtime
 * processes, no Extension Host mixing — human terminals only.
 */

const PROTOCOL = 'stark-terminal-host/v1';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_DATA_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 128;
const MAIN_TO_HOST_TYPES = ['SHUTDOWN', 'CREATE', 'WRITE', 'RESIZE', 'KILL'];

function safeByteLength(text) {
  try {
    return Buffer.byteLength(text, 'utf8');
  } catch (err) {
    void err;
    return -1;
  }
}

function messageByteLength(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? MAX_MESSAGE_BYTES + 1 : Buffer.byteLength(text, 'utf8');
  } catch (err) {
    void err;
    return MAX_MESSAGE_BYTES + 1;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function isBoundedId(value) {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
}

function isAllowedInbound(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (value.protocol !== PROTOCOL || typeof value.type !== 'string') {
    return false;
  }
  if (MAIN_TO_HOST_TYPES.indexOf(value.type) === -1) {
    return false;
  }
  return messageByteLength(value) <= MAX_MESSAGE_BYTES;
}

/** Multibyte-safe chunk split for PTY output (64 KiB IPC bound). */
function splitOutput(data) {
  const text = typeof data === 'string' ? data : '';
  if (text === '') {
    return [];
  }
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = safeByteLength(char);
    if (charBytes < 0) {
      continue;
    }
    if (currentBytes + charBytes > MAX_DATA_BYTES) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current !== '') {
    chunks.push(current);
  }
  return chunks;
}

function validCreate(payload) {
  if (!isRecord(payload)) {
    return false;
  }
  const { requestId, sessionId, cwd, shellFile, shellArgs, cols, rows, env } = payload;
  if (!isBoundedId(requestId) || !isBoundedId(sessionId)) {
    return false;
  }
  if (typeof cwd !== 'string' || cwd === '' || typeof shellFile !== 'string' || shellFile === '') {
    return false;
  }
  if (!Array.isArray(shellArgs) || !shellArgs.every((entry) => typeof entry === 'string')) {
    return false;
  }
  // Parity with the main-enforced bounds (20..500 x 5..200): the
  // host fails closed on values main would reject.
  if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
    return false;
  }
  if (!isRecord(env) || !Object.values(env).every((entry) => typeof entry === 'string')) {
    return false;
  }
  return true;
}

/**
 * Creates the terminal host runtime.
 *
 * @param {object} deps
 * @param {(file: string, args: readonly string[], options: object) => object} deps.spawnPty
 *   node-pty-compatible spawn (injected; production passes node-pty).
 * @param {(message: object) => void} deps.send outbound transport to main.
 * @param {(listener: (message: unknown) => void) => void} deps.onMessage inbound subscription.
 */
export function createTerminalHostRuntime(deps) {
  const spawnPty = deps.spawnPty;
  const send = deps.send;
  const sessions = new Map();

  function post(type, payload) {
    try {
      send({ protocol: PROTOCOL, type, payload });
    } catch (err) {
      void err;
    }
  }

  function handleExit(sessionId, exitCode, signal) {
    const tracked = sessions.get(sessionId);
    if (tracked === undefined || tracked.exitDelivered) {
      return;
    }
    tracked.exitDelivered = true;
    tracked.running = false;
    post('EXIT', { sessionId, exitCode, signal });
    sessions.delete(sessionId);
  }

  function handleMessage(raw) {
    if (!isAllowedInbound(raw)) {
      return;
    }
    const { type, payload } = raw;
    if (type === 'SHUTDOWN') {
      if (type === 'SHUTDOWN') {
        for (const [, tracked] of [...sessions]) {
          try {
            if (tracked.running) {
              tracked.pty.kill();
            }
          } catch (err) {
            void err;
          }
        }
        sessions.clear();
        post('SHUTDOWN_COMPLETE', {});
      }
      return;
    }
    if (!isRecord(payload)) {
      return;
    }
    if (type === 'CREATE') {
      if (!validCreate(payload)) {
        if (isBoundedId(payload.requestId) && isBoundedId(payload.sessionId)) {
          post('CREATE_FAILED', { requestId: payload.requestId, sessionId: payload.sessionId, code: 'invalid' });
        }
        return;
      }
      const { requestId, sessionId } = payload;
      if (sessions.has(sessionId)) {
        post('CREATE_FAILED', { requestId, sessionId, code: 'invalid' });
        return;
      }
      let spawned = null;
      try {
        spawned = spawnPty(payload.shellFile, payload.shellArgs, {
          cwd: payload.cwd,
          cols: payload.cols,
          rows: payload.rows,
          env: payload.env
        });
      } catch (err) {
        void err;
      }
      if (spawned === null || spawned === undefined) {
        post('CREATE_FAILED', { requestId, sessionId, code: 'spawn_failed' });
        return;
      }
      const pty = spawned;
      sessions.set(sessionId, { pty, running: true, exitDelivered: false });
      try {
        pty.onData((data) => {
          const tracked = sessions.get(sessionId);
          if (tracked === undefined || !tracked.running) {
            return;
          }
          for (const chunk of splitOutput(data)) {
            post('DATA', { sessionId, data: chunk });
          }
        });
      } catch (err) {
        void err;
      }
      try {
        pty.onExit(({ exitCode, signal }) => {
          handleExit(
            sessionId,
            typeof exitCode === 'number' ? exitCode : null,
            typeof signal === 'number' ? signal : null
          );
        });
      } catch (err) {
        void err;
      }
      post('CREATED', { requestId, sessionId });
      return;
    }
    if (type === 'WRITE') {
      const { sessionId, data } = payload;
      if (!isBoundedId(sessionId) || typeof data !== 'string' || data === '') {
        return;
      }
      const tracked = sessions.get(sessionId);
      if (tracked === undefined || !tracked.running) {
        return;
      }
      try {
        tracked.pty.write(data);
      } catch (err) {
        void err;
      }
      return;
    }
    if (type === 'RESIZE') {
      const { sessionId, cols, rows } = payload;
      // Same bounds as CREATE/main: reject degenerate or absurd sizes
      // instead of forwarding them to the native layer.
      if (
        !isBoundedId(sessionId) ||
        !Number.isInteger(cols) ||
        cols < 20 ||
        cols > 500 ||
        !Number.isInteger(rows) ||
        rows < 5 ||
        rows > 200
      ) {
        return;
      }
      const tracked = sessions.get(sessionId);
      if (tracked === undefined || !tracked.running) {
        return;
      }
      try {
        tracked.pty.resize(cols, rows);
      } catch (err) {
        void err;
      }
      return;
    }
    if (type === 'KILL') {
      const { requestId, sessionId } = payload;
      if (!isBoundedId(requestId) || !isBoundedId(sessionId)) {
        return;
      }
      const tracked = sessions.get(sessionId);
      if (tracked === undefined) {
        post('KILL_RESULT', { requestId, sessionId, outcome: 'gone' });
        return;
      }
      if (!tracked.running) {
        sessions.delete(sessionId);
        post('KILL_RESULT', { requestId, sessionId, outcome: 'gone' });
        return;
      }
      // The blocking call lives HERE (host thread), never on main.
      // On synchronous throw the session stays tracked: a later EXIT
      // still reconciles honestly instead of stranding a zombie.
      try {
        tracked.pty.kill();
      } catch (err) {
        void err;
        post('KILL_RESULT', { requestId, sessionId, outcome: 'failed' });
        return;
      }
      tracked.running = false;
      post('KILL_RESULT', { requestId, sessionId, outcome: 'initiated' });
    }
  }

  deps.onMessage(handleMessage);
  post('READY', {});

  return {
    /** Live session count (diagnostics/tests only). */
    get size() {
      return sessions.size;
    }
  };
}

/**
 * Forked-child entry (integration tests only): when loaded as a plain
 * Node child_process target (process.send present, no Electron
 * parentPort), wire the real node-pty behind the same runtime and
 * speak over process IPC. Production (utilityProcess) never takes
 * this path — the bootstrap wires parentPort explicitly instead.
 */
const forkedChildEntry =
  typeof process !== 'undefined' &&
  typeof process.send === 'function' &&
  (process.parentPort === null || process.parentPort === undefined);

if (forkedChildEntry) {
  (async () => {
    let nodePty = null;
    try {
      const imported = await import('node-pty');
      nodePty = imported && imported.default ? imported.default : imported;
    } catch (err) {
      void err;
    }
    if (nodePty === null || typeof nodePty.spawn !== 'function') {
      process.exit(1);
      return;
    }
    try {
      createTerminalHostRuntime({
        spawnPty: (file, args, options) => nodePty.spawn(file, args, options),
        send: (message) => {
          try {
            process.send(message);
          } catch (err) {
            void err;
          }
        },
        onMessage: (listener) => process.on('message', (message) => listener(message))
      });
    } catch (err) {
      void err;
      process.exit(1);
    }
  })().catch(() => process.exit(1));
}
