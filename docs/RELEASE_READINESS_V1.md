# STARK v1 — Release Readiness (Stage 31 outcome)

Release-candidate readiness record for STARK v1 (schema **v18**,
Stages 1–30 implemented, Stage 31 acceptance executed 2026-10-09).

**Manual acceptance status: STAGE 31 EXECUTED — RC ACCEPTANCE COMPLETE,
PUBLIC RELEASE SIGN-OFF BLOCKED (external prerequisites remain).**
See `docs/RELEASE_ACCEPTANCE_V1.md` (76 checks: 6 PASS · 70 BLOCKED ·
0 FAIL · 0 N/A · 0 UNTESTED) and `docs/STAGE31_DEFECTS.md` (4 defects,
all fixed and retested).
This document makes no production-release-ready claim.

RC: **STARK-v0.1.0-RC1+2870399** (package 0.1.0, commit
`2870399c79fc4b238d05c971c3a710282853da13`, schema **v18**,
Windows x64, Node v22.23.2, Electron v44.6.0).
Baseline: `npm run release:check` ALL CHECKS PASSED
(281 suites / 1824 tests / 0 failures). Baseline timestamp 2026-10-09.

## Schema

Current schema: **v19** (chat attachments step: append-only migration
019 `message-attachments` adds `chat_attachments` +
`message_attachments`; migrations 001–018 untouched). Singleton cloud
tables (`cloud_account`, `cloud_auth_session`) from v18 remain the
only account storage.

## Implemented stages

1–15 locked foundations (shell, settings, profile, Workspace,
Explorer, Search, editing, transactions, Monaco, terminal, Git,
sessions, providers, context, proposals) · 16 single-file proposals ·
17 Change Sets · 18 Brain · 19 Heart · 20 Looplink · 21 Recovery ·
22 capabilities · 23 read-only Worker tools · 24 change.propose ·
25 terminal_execute · 26 managed runtimes · 27 runtime observation +
Preview inspection · 28 usage awareness + threshold routing · 29
optional Google/GitHub account (local-first) · 30 release hardening
(startup/shutdown, fatal UI, diagnostics, packaging, acceptance matrix)
· 31 final acceptance (defect fixes only, no features, no migration).

## Automated tests

Full suite (`npm test`, Node built-in runner): 281 suites, 1824 tests,
0 failures (final `npm run release:check`, Stage 31). Stage 30 added:
startup failure/fatal/recovery-order/shutdown/global-errors/smoke
suites, diagnostic redaction/logger suites, schema-guard + upgrade-matrix
(v5/v9/v13/v15/v17→v18, fresh→v18) suites, renderer Error Boundary +
profile editor + double-submit suites, 30-item release security
matrix, 21-domain public-error redaction sweep, package-config +
Monaco + release-check-shape suites, docs-completeness suite.
Stage 31 changed: release-gate audit + docs-completeness suites now
accept the finalized Stage 31 outcome (see STAGE31-D01/D02); fixed two
stale code comments (D03/D04). No suite-count change.

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

Current host (Windows) builds via `npm run build`. `npm run release:smoke`
was executed in Stage 31 against the unpacked production build: one
bounded Electron launch with isolated userdata wrote the ready marker
(`ok`, schema v18) and quit cleanly with no stray processes. Full
installer packaging (`electron-builder` NSIS/DMG/AppImage/DEB) was not
executed; produce installers on the release-candidate host and complete
the AD-01/AD-02 human pass.

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

STAGE 31 EXECUTED 2026-10-09 against STARK-v0.1.0-RC1+2870399.
`docs/RELEASE_ACCEPTANCE_V1.md` holds 76 checks with per-check
Status/Date/RC/Evidence/Notes and zero UNTESTED:
**6 PASS · 0 FAIL · 70 BLOCKED · 0 NOT_APPLICABLE.**
P0: 4 PASS / 43 BLOCKED · P1: 1 PASS / 27 BLOCKED · P2: 1 PASS.
PASS items (observed): AA-02 (v17→v18 upgrade), AA-03 (newer-schema
refusal), Z-08 (malformed deep-link rejection), AD-03 (bundle secret
audit), AD-04 (signing-state record), AF-01 (final release:check).
BLOCKED items are prerequisite-bound (human GUI session, real provider
key, OAuth backend, installer host, network control, kill/relaunch
driver), each with unblock action and supporting automated coverage;
none is a software failure. Defects: `docs/STAGE31_DEFECTS.md`
(D01 release-gate lock, D02 completeness-test lock, D03/D04 stale
comments — all fixed, retested green).

## Stage 31 defects

4 discovered, 4 fixed, 0 remaining (see `docs/STAGE31_DEFECTS.md`).
No functional/behavioral defect found in product code; both P0 items
were release-gate tooling locks (D01/D02) plus two stale comments
(D03/D04). Investigated-but-not-defects (terminal charset safety,
bounded looplink shrink loop, git cache scope, unpacked footer quirk,
preview partition persistence) are documented there with rationale.

## Remaining release requirements (external blockers)

1. Code signing/notarization for production distribution — absent
   (PUBLIC_RELEASE_BLOCKER).
2. Official platform icon assets — missing (PUBLIC_RELEASE_BLOCKER
   for branded distribution; do not fabricate).
3. Real OAuth configuration (Supabase + Google/GitHub + registered
   stark:// redirect) + human flow verification — unconfigured
   (ENVIRONMENT_CONFIGURATION_BLOCKER; Z-01–Z-07, Z-03 inspection).
4. Real provider key + bounded human smoke (Ask, direct/delegated/tool
   Work, error handling, usage/threshold) — no key in this environment
   (ENVIRONMENT_CONFIGURATION_BLOCKER; N-01, O-01, G-01, S/T/U/V/W/X/Y
   live legs).
5. Windows NSIS installer production + human install/uninstall pass;
   macOS/Linux installers on target hosts (PLATFORM_RELEASE_BLOCKER;
   AD-01/AD-02).
6. Human GUI confirmation pass for the 70 BLOCKED checks on the RC
   (ENVIRONMENT_CONFIGURATION_BLOCKER — headless agent run; steps and
   expected results are preserved per check in the acceptance matrix).
7. Offline + crash kill/relaunch human passes (same blocker as 6).

## Release decision

**STARK v1 RC ACCEPTANCE: COMPLETE — PUBLIC RELEASE SIGN-OFF: BLOCKED.**
Software acceptance is sound (0 FAILs, 0 unresolved defects, final
automated regression green, schema v18 intact with no migration 019),
but public release is blocked by the external prerequisites above
(signing, icons, OAuth backend, provider-key smoke, target-platform
installers, and the human GUI confirmation pass). Do not represent
this RC as release-ready.

(End of file — Stage 31 outcome recorded 2026-10-09.)

---

## Final V1 Release QA addendum (post–Stage 31 feature pass, 2026-10-10)

Product scope grew after the Stage 31 record above: chat attachments
(schema v19, migration 019), AI image/file understanding, attachment
→ workspace mobility, voice-to-text, and single/multi image
generation. This addendum records the final verification truth; the
Stage 31 sections above are preserved verbatim as history.

- Commit: `d54b2d7` (v027). Schema: **v19** (migrations 001–019 only;
  no migration 020). Upgrade paths fresh→v19 and v5/v9/v13/v15/v17/v18→v19
  covered by `upgrade-matrix` + per-migration suites.
- Automated baseline (this host, clean tree): `typecheck` PASS,
  `lint` PASS, `build` PASS (out/main, out/preload, out/renderer +
  Extension Host modules), `npm test` **388 suites / 2365 tests /
  0 failures**, `release:check` ALL CHECKS PASSED,
  `release:smoke` ready marker ok (schema v19).
- Worker tools now number ten (workspace_read, workspace_search,
  git_read, change_propose, attachment_import, image_generate,
  terminal_execute, runtime_start, runtime_observe, preview_inspect);
  capabilities number nine (image.generate added, deny/ask only).
- Voice: mic control, audio-only permission gate, 5 min / 25 MiB
  bounds, 60 s transcription budget with 0 retries, no audio
  persistence. Image generation: ASK-only image_generate tool,
  1–4 images as normal chat attachments, Heart capability routing,
  review-before-write mobility preserved.
- Security invariants from Stage 31 hold, extended by suite: no
  generic IPC (exact production channel set asserted), audio-only
  media grants, fixed provider endpoints plus allowlisted image-URL
  origins, no secret leakage (redaction suites), attachment boundary
  (resolver-only byte reads), at-most-once paid executions.
- Manual acceptance status for the new scope: GUI/voice-hardware/
  live-provider/installer checks remain MANUAL REQUIRED —
  ENVIRONMENT (headless QA host; no microphone, display session,
  provider key, or installer run here). No reproducible software
  defect was found; static audits (IPC, renderer, processes,
  network, secrets, attachments, extensions, anti-hang) are clean.
- Remaining external prerequisites from Stage 31 are unchanged
  (code signing, official icon assets, OAuth backend, provider-key
  smoke, target-platform installers, human GUI confirmation pass).

(Final QA addendum recorded 2026-10-10.)
