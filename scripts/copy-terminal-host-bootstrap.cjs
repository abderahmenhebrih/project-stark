/**
 * Copies the STARK-owned Terminal Host files into the built main
 * output so production packages (and the smoke runner) can fork them.
 *
 * The bootstrap entrypoint plus the dependency-free host runtime are
 * copied verbatim, never bundled, so what ships is exactly what is
 * audited in src/main/terminal/. Fails the build if any source is
 * missing. Human PTYs only — never mixed with the Extension Host.
 */
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const SOURCE_DIR = join(ROOT, 'src', 'main', 'terminal');
const DEST_DIR = join(ROOT, 'out', 'main');

const SHIPPED_HOST_FILES = [
  // Bootstrap entrypoint (forked by Electron utilityProcess).
  { src: 'terminal-host-bootstrap.js', dest: 'terminal-host-bootstrap.js' },
  // Human-PTY host runtime (loaded only via the bootstrap's narrow
  // dynamic import of the STARK-owned sibling URL).
  { src: 'terminal-host.mjs', dest: 'terminal-host.mjs' }
];

mkdirSync(DEST_DIR, { recursive: true });
for (const file of SHIPPED_HOST_FILES) {
  const source = join(SOURCE_DIR, file.src);
  if (!existsSync(source)) {
    process.stderr.write(`[terminal-host] FAILED: missing ${source}\n`);
    process.exit(1);
  }
  copyFileSync(source, join(DEST_DIR, file.dest));
  process.stdout.write(`[terminal-host] ${file.src} copied to ${join(DEST_DIR, file.dest)}\n`);
}
