/**
 * STARK packaged smoke runner (Stage 30, manual use on the current host).
 *
 * Builds nothing: it launches the already-built Electron app once with
 * an isolated userdata dir and STARK_RELEASE_SMOKE=1, waits at most
 * MAX_PACKAGED_SMOKE_MS (20s) for the ready marker, then terminates
 * the exact spawned process tree. One attempt, no retries, bounded
 * cleanup of the temp dir. Fails once with diagnostics.
 *
 * Usage: npm run build && npm run release:smoke
 */
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const MAIN_ENTRY = join(ROOT, 'out', 'main', 'index.js');
const ELECTRON_BIN = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app' : 'electron'
);
const TIMEOUT_MS = 20_000;

function fail(message, dir) {
  process.stderr.write(`[release:smoke] FAILED: ${message}\n`);
  if (typeof dir === 'string') {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
  process.exit(1);
}

if (!existsSync(MAIN_ENTRY)) {
  fail(`missing ${MAIN_ENTRY} (run npm run build first)`);
}
if (!existsSync(ELECTRON_BIN)) {
  fail(`missing Electron binary at ${ELECTRON_BIN}`);
}

const dir = mkdtempSync(join(tmpdir(), 'stark-smoke-'));
const markerPath = join(dir, 'marker.json');
const userDataDir = join(dir, 'userdata');

const child = spawn(ELECTRON_BIN, [MAIN_ENTRY], {
  cwd: ROOT,
  env: { ...process.env, STARK_RELEASE_SMOKE: '1', STARK_SMOKE_MARKER: markerPath, STARK_SMOKE_USERDATA: userDataDir },
  stdio: 'ignore'
});

const deadline = setTimeout(() => {
  try {
    child.kill();
  } catch {
    // Best effort: exact process only, no broad kills.
  }
  fail(`no ready marker within ${TIMEOUT_MS}ms`, dir);
}, TIMEOUT_MS);

const poll = setInterval(() => {
  if (!existsSync(markerPath)) {
    return;
  }
  clearTimeout(deadline);
  clearInterval(poll);
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.ok === true && typeof marker.schemaVersion === 'number') {
      process.stdout.write(
        `[release:smoke] ready marker ok (schema v${marker.schemaVersion}, app ${marker.appVersion})\n`
      );
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    }
    fail(`negative ready marker: ${JSON.stringify(marker)}`, dir);
  } catch (error) {
    fail(`unreadable ready marker: ${String(error)}`, dir);
  }
}, 250);

child.on('error', (error) => {
  clearTimeout(deadline);
  clearInterval(poll);
  fail(`spawn error: ${String(error)}`, dir);
});
