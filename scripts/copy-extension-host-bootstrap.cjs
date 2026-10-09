/**
 * Copies the STARK-owned Extension Host bootstrap into the built main
 * output so production packages (and the smoke runner) can fork it.
 *
 * The bootstrap is dependency-free plain Node.js on purpose: it is
 * copied verbatim, never bundled, so what ships is exactly what is
 * audited in src/main/extension-host/bootstrap.js. Fails the build if
 * the source is missing.
 */
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const SOURCE = join(ROOT, 'src', 'main', 'extension-host', 'bootstrap.js');
const DEST_DIR = join(ROOT, 'out', 'main');
const DEST = join(DEST_DIR, 'extension-host-bootstrap.js');

if (!existsSync(SOURCE)) {
  process.stderr.write(`[extension-host] FAILED: missing ${SOURCE}\n`);
  process.exit(1);
}
mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SOURCE, DEST);
process.stdout.write(`[extension-host] bootstrap copied to ${DEST}\n`);
