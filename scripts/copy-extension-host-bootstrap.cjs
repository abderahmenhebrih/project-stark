/**
 * Copies the STARK-owned Extension Host files into the built main
 * output so production packages (and the smoke runner) can fork them.
 *
 * The entrypoint plus its formatter modules are dependency-free,
 * STARK-owned plain Node.js on purpose: they are copied verbatim,
 * never bundled, so what ships is exactly what is audited in
 * src/main/extension-host/. Fails the build if any source is missing.
 */
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const SOURCE_DIR = join(ROOT, 'src', 'main', 'extension-host');
const DEST_DIR = join(ROOT, 'out', 'main');

const SHIPPED_HOST_FILES = [
  // Bootstrap entrypoint (forked by Electron utilityProcess).
  { src: 'bootstrap.js', dest: 'extension-host-bootstrap.js' },
  // Generic activation core + formatter adapter (loaded only via the
  // bootstrap's narrow dynamic imports of STARK-owned sibling URLs).
  // Copied under identical names so relative loader resolution
  // (`./vscode-loader.mjs`, `./generic-host.mjs`) holds in src and
  // in out/.
  { src: 'generic-host.mjs', dest: 'generic-host.mjs' },
  { src: 'extension-process.mjs', dest: 'extension-process.mjs' },
  { src: 'formatter-host.mjs', dest: 'formatter-host.mjs' },
  { src: 'vscode-shim.mjs', dest: 'vscode-shim.mjs' },
  { src: 'vscode-loader.mjs', dest: 'vscode-loader.mjs' }
];

mkdirSync(DEST_DIR, { recursive: true });
for (const file of SHIPPED_HOST_FILES) {
  const source = join(SOURCE_DIR, file.src);
  if (!existsSync(source)) {
    process.stderr.write(`[extension-host] FAILED: missing ${source}\n`);
    process.exit(1);
  }
  copyFileSync(source, join(DEST_DIR, file.dest));
  process.stdout.write(`[extension-host] ${file.src} copied to ${join(DEST_DIR, file.dest)}\n`);
}
