# STARK v1 — Release Readiness (Stage 30)

Release-candidate readiness record for STARK v1 (schema **v18**,
Stages 1–30 implemented). Prepared in Stage 30.

**Manual acceptance status: NOT YET EXECUTED.**
See `docs/RELEASE_ACCEPTANCE_V1.md` (76 checks, all UNTESTED).
This document makes no production-release-ready claim before Stage 31.

## Schema

Current schema: **v18**. No migration 019 exists; Stage 30 adds no
tables. Singleton cloud tables (`cloud_account`, `cloud_auth_session`)
from v18 remain the only account storage.

## Implemented stages

1–15 locked foundations (shell, settings, profile, Workspace,
Explorer, Search, editing, transactions, Monaco, terminal, Git,
sessions, providers, context, proposals) · 16 single-file proposals ·
17 Change Sets · 18 Brain · 19 Heart · 20 Looplink · 21 Recovery ·
22 capabilities · 23 read-only Worker tools · 24 change.propose ·
25 terminal_execute · 26 managed runtimes · 27 runtime observation +
Preview inspection · 28 usage awareness + threshold routing · 29
optional Google/GitHub account (local-first) · 30 release hardening
(startup/shutdown, fatal UI, diagnostics, packaging, acceptance matrix).

## Automated tests

Full suite (`npm test`, Node built-in runner): see Validation in the
Stage 30 final report for exact counts. Stage 30 adds: startup
failure/fatal/recovery-order/shutdown/global-errors/smoke suites,
diagnostic redaction/logger suites, schema-guard + upgrade-matrix
(v5/v9/v13/v15/v17→v18, fresh→v18) suites, renderer Error Boundary +
profile editor + double-submit suites, 30-item release security
matrix, 21-domain public-error redaction sweep, package-config +
Monaco + release-check-shape suites, docs-completeness suite.

## Production packaging status

- electron-builder configured: `com.stark.app` (release-stable),
  productName STARK, version 0.1.0 (semver).
- Targets: Windows NSIS · macOS DMG+ZIP · Linux AppImage+DEB.
- `stark://` protocol registered in package metadata and at runtime
  (`setAsDefaultProtocolClient`, best-effort).
- Allowlist `files` (out, package.json, node-pty) with explicit
  excludes (`.env*`, `.db*`, `.log`, coverage); ASAR with
  node-pty/native unpack.
- `npm run release:check` gates typecheck → lint → build → tests →
  package-config audit → artifact/docs audit (fail fast, no retries).
- `npm run release:smoke` performs one bounded (20s) isolated-userdata
  smoke launch with `STARK_RELEASE_SMOKE=1` (manual, current host).

## Current-host package status

Current host (Windows) builds via `npm run build` (see Stage 30
Validation). `npm run release:smoke` was executed against the unpacked
production build: one bounded Electron launch with isolated userdata
wrote the ready marker (`ok`, schema v18) and quit cleanly with no
stray processes. Full installer packaging (`electron-builder` NSIS/DMG/
AppImage/DEB) was not executed as part of automated success; produce
installers on the release-candidate host in Stage 31.

Known quirk: launching the *unpacked* build via `electron ./out/...`
shows the Electron version in the version footer because no app
`package.json` sits beside `out/`; packaged builds bundle
`package.json`, so `app.getVersion()` resolves the real 0.1.0 there.

## Known platform packaging limitations

- Unsigned build: no code-signing certificates are configured, so
  packages are unsigned development/release-candidate artifacts.
  Production distribution should be signed/notarized. Never generate
  fake certificates.
- Cross-platform installers cannot all be produced on one host:
  validate non-host targets statically only.
- No official platform icon assets were found in the repository; icon
  conversion is a release asset requirement (do not fabricate a logo).

## Security invariants (all enforced by tests)

contextIsolation=true, nodeIntegration=false, sandbox=true on every
window · no generic IPC · no renderer filesystem/Supabase/credential
authority · no AI direct file writer · no AI Accept · Brain tool-free ·
Worker budget 4 / turns ≤5 / Tool-Work calls ≤7 · terminal + runtimes
exact-approval only (terminal persistent Allow impossible) · Preview
isolated + read-only inspection · Recovery single-hop · one threshold
alternate per route · no billing/quota/auth polling · no cloud project
sync · no broad kills · no PID persistence · no plaintext auth/provider
secrets · restrictive CSP + navigation guards.

## Manual acceptance status

NOT YET EXECUTED. `docs/RELEASE_ACCEPTANCE_V1.md` holds 76 checks
(47 P0 · 28 P1 · 1 P2), all UNTESTED, organized A–AF with stage
traceability.

## Known remaining release requirements

1. Code signing/notarization for production distribution (absent).
2. Real OAuth configuration + OS deep-link registration verification.
3. Real provider smoke test with a valid key (manual, Stage 31).
4. Platform icon assets (missing; do not fabricate).
5. Full Stage 31 execution of RELEASE_ACCEPTANCE_V1 on the
   release-candidate build, defect fixes, affected-suite reruns, and
   final v1 sign-off.
