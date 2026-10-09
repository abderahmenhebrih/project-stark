/**
 * STARK release check (Stage 30).
 *
 * Bounded deterministic release gate: typecheck → lint → build →
 * tests → package-config audit → artifact/docs audit. Fail fast, no
 * retries, per-step timeouts. Manual acceptance is NOT part of this
 * script (see docs/RELEASE_ACCEPTANCE_V1.md, executed in Stage 31).
 */
const { execSync } = require('node:child_process');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const STEP_TIMEOUT_MS = 600_000;

function step(label, script) {
  process.stdout.write(`[release:check] ${label} ...\n`);
  try {
    execSync(`npm run ${script}`, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: STEP_TIMEOUT_MS,
      env: process.env
    });
  } catch {
    process.stderr.write(`[release:check] FAILED at ${label}\n`);
    process.exit(1);
  }
  process.stdout.write(`[release:check] ${label} ok\n`);
}

function fail(message) {
  process.stderr.write(`[release:check] FAILED: ${message}\n`);
  process.exit(1);
}

function auditPackageConfig() {
  process.stdout.write('[release:check] package-config audit ...\n');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.build?.productName !== 'STARK') fail('build.productName must be STARK');
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) fail('version must be valid semver');
  if (typeof pkg.build?.appId !== 'string' || pkg.build.appId === '') fail('build.appId must be stable and set');
  const files = JSON.stringify(pkg.build?.files ?? []);
  for (const required of ['out/**/*', 'node-pty']) {
    if (!files.includes(required)) fail(`build.files must include ${required}`);
  }
  for (const excluded of ['.env', '.db', '.log']) {
    if (!files.includes(excluded)) fail(`build.files must exclude ${excluded} patterns`);
  }
  const protocols = JSON.stringify(pkg.build?.protocols ?? []);
  if (!protocols.includes('stark')) fail('build.protocols must register the stark:// scheme');
  const targets = JSON.stringify(pkg.build ?? {});
  for (const expected of ['nsis', 'dmg', 'AppImage']) {
    if (!targets.includes(expected)) fail(`packaging targets must include ${expected}`);
  }
  if (!existsSync(join(ROOT, 'src', 'main', 'database', 'migrations', '018-cloud-account.ts'))) {
    fail('migration 018 must exist (schema v18)');
  }
  process.stdout.write('[release:check] package-config audit ok\n');
}

function auditArtifactsAndDocs() {
  process.stdout.write('[release:check] artifact/docs audit ...\n');
  for (const artifact of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    const path = join(ROOT, artifact);
    if (!existsSync(path)) fail(`missing build artifact ${artifact} (run build first)`);
    if (statSync(path).size === 0) fail(`empty build artifact ${artifact}`);
  }
  for (const doc of ['docs/RELEASE_ACCEPTANCE_V1.md', 'docs/RELEASE_READINESS_V1.md']) {
    if (!existsSync(join(ROOT, doc))) fail(`missing ${doc}`);
  }
  const readiness = readFileSync(join(ROOT, 'docs/RELEASE_READINESS_V1.md'), 'utf8');
  if (!readiness.includes('v18')) fail('readiness doc must record schema v18');
  // Stage 31: accept the pre-acceptance record ("NOT YET EXECUTED") or the
  // finalized Stage 31 outcome (acceptance executed, decision recorded).
  // The gate previously required NOT YET EXECUTED forever, which made the
  // final AF-01 regression unrunnable after acceptance docs were finalized.
  const acceptanceRecorded =
    readiness.includes('NOT YET EXECUTED') ||
    (readiness.includes('Stage 31') && readiness.includes('ACCEPTANCE'));
  if (!acceptanceRecorded) fail('readiness doc must record acceptance state (NOT YET EXECUTED or Stage 31 outcome)');
  process.stdout.write('[release:check] artifact/docs audit ok\n');
}

step('typecheck', 'typecheck');
step('lint', 'lint');
step('build', 'build');
step('tests', 'test');
auditPackageConfig();
auditArtifactsAndDocs();
process.stdout.write('[release:check] ALL CHECKS PASSED\n');
