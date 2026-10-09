# STARK Stage 31 — Defect Tracker

RC: **STARK-v0.1.0-RC1+2870399** (package 0.1.0, commit
`2870399c79fc4b238d05c971c3a710282853da13`, schema **v18**).
Date: 2026-10-09. Host: Windows x64, Node v22.23.2, Electron v44.6.0.

Baseline before acceptance: `npm run release:check` PASS
(281 suites / 1824 tests / 0 failures).

No persistent-schema change was required. Schema remains **v18**;
no migration 019 was created.

---

## STAGE31-D01 — release gate locked the pre-acceptance state (fixed)

- Acceptance check: **AF-01** (final `npm run release:check` must pass
  after docs finalization).
- Priority: P0 (release-blocking tooling).
- Symptom: `scripts/release-check.cjs` `auditArtifactsAndDocs`
  unconditionally required the readiness document to contain
  `NOT YET EXECUTED`. Finalizing `docs/RELEASE_READINESS_V1.md`
  with the Stage 31 outcome (as Stage 31 mandates) would therefore
  make the final AF-01 regression FAIL by construction.
- Root cause: Stage 30 gate asserted a pre-acceptance state forever;
  it had no branch for the finalized Stage 31 outcome.
- Files changed: `scripts/release-check.cjs` only (audit now accepts
  `NOT YET EXECUTED` **or** a Stage 31 outcome record containing
  `Stage 31` + `ACCEPTANCE`; still fail-fast, still no retries).
- Regression test: existing `release:check script shape` suite
  (still asserts fail-fast/bounded/no-retries shape) plus the final
  `npm run release:check` green run.
- Retest result: PASS (final `release:check`: ALL CHECKS PASSED).

## STAGE31-D02 — docs-completeness tests locked the pre-acceptance matrix (fixed)

- Acceptance checks: **AF-02** (matrix finalization; no unexplained
  UNTESTED) and the readiness update.
- Priority: P0 (release-blocking tooling).
- Symptom: `src/main/release/docs-completeness.test.ts` required
  `Status: UNTESTED` ≥ 70, forbade any `Status: PASS`, and required
  readiness to contain `NOT YET EXECUTED`. Recording Stage 31
  results (as Stage 31 mandates) would therefore break `npm test`.
- Root cause: same as D01 — Stage 30 completeness tests encoded only
  the pre-execution state.
- Files changed: `src/main/release/docs-completeness.test.ts` only.
  The suites now accept **either** the pre-execution matrix
  (NOT EXECUTED banner, ≥70 UNTESTED, no PASS) **or** the Stage 31
  finalized matrix (Stage 31 record, `Status: PASS` present,
  `Evidence:` per check, zero UNTESTED); and readiness with
  `NOT YET EXECUTED` **or** a Stage 31 ACCEPTANCE outcome. Section,
  field, priority, and no-release-ready-claim assertions are unchanged.
- Regression test: the updated suites themselves (targeted run:
  docs-completeness + release-check-shape + schema-guard, 9/9 PASS)
  plus the final full `npm run release:check`.
- Retest result: PASS.

## STAGE31-D03 — stale tool-count comment (fixed)

- Acceptance check: none failed (worker boundary behavior correct).
- Priority: low (incorrect code documentation).
- Symptom: `src/main/worker-tools/worker-tool-registry.ts`
  documented "exactly the six known tools" while `WORKER_TOOLS`
  carries eight (`workspace_read`, `workspace_search`, `git_read`,
  `change_propose`, `terminal_execute`, `runtime_start`,
  `runtime_observe`, `preview_inspect`).
- Root cause: comment not updated when runtime/observation tools landed.
- Files changed: one comment line (`six` → `eight`).
- Regression test: pre-existing assertions of the 8-tool set
  (`worker-terminal`, `worker-proposal`, `worker-observation`,
  `project-runtime`, 30-item `release-security` matrix) — all green.
- Retest result: PASS (no behavior change; targeted suites green).

## STAGE31-D04 — misleading preview-partition comment (fixed)

- Acceptance check: none failed (Preview isolation behavior correct:
  per-runtime partition, no preload, navigation allowlist enforced,
  popups/permissions denied — all covered by tests).
- Priority: low (incorrect code documentation).
- Symptom: `src/main/project-runtime/runtime-preview.ts` called the
  partition "Ephemeral" while `previewPartitionForRuntime` returns a
  persistent per-runtime partition (`persist:stark-runtime-preview-<id>`),
  isolated per runtime id and never shared across runtimes.
- Root cause: stale wording from an earlier design.
- Files changed: two comment lines in `runtime-preview.ts` (behavior
  untouched).
- Regression test: pre-existing `preview-inspection-security` and
  `release-security` partition assertions — all green.
- Retest result: PASS.

---

## STAGE31-D05 — frontend shell visually broken/disorganized (fixed)

- Acceptance checks: human visual inspection during Stage 31 (layout
  defects, no functional failure).
- Priority: P1 (visual, release-candidate quality).
- Symptom: session header toolbar clipped controls
  ("Continue with Loo…"); weak workbench hierarchy; unfinished editor
  empty state; detached full-width profile strip; no IDE status bar;
  browser-default buttons on profile/account; per-tab boxes instead of
  a segmented system; single-accent token system. Follow-up visual
  pass 2 corrected the second brand accent (mint green #3ddc84 is
  semantic-only, NOT brand) to official neon magenta #ff2ea6, added a
  vertical activity rail (tabs truncated to Ex…/Se…/Ch…), rebuilt the
  top bar as one compact row, reworked the composer into one rounded
  surface with per-mode selection, fixed Send prominence, corrected
  typography (sans UI / mono code-paths-meta), removed border boxes,
  and removed the duplicate version footer.
- Root cause: incremental per-stage panel CSS with no unifying shell
  pass; only one brand accent tokenized; several controls unclassed.
- Files changed (renderer only; zero main-process/IPC/schema
  changes): `tokens.css` (official lime + magenta tokens; mint stays
  semantic-only), `global.css` (unified button system, surface
  secondaries), `MainLayout` (emblem slot, duplicate footer removed),
  `HomePage` (one-row top bar with breadcrumb, IDE status bar, compact
  profile), `Explorer` (vertical activity rail with icon + full
  labels, branded empty state), `session.css` (wrapping toolbar,
  message hierarchy with magenta AI edge, composer dock, per-mode
  selection), `TerminalPanel.css` (editor-blended), `editor.css`
  (empty state), `WorkspaceSection.css` (sans name), `ProfileSection`/
  `AccountSection` (button classes), new `StarkMark` asset-slot
  component (official-asset-ready, faithful CSS stand-in only),
  `session-layout.test.ts` (width-range assertion),
  `workbench-polish.test.ts` rewritten for pass 2 (15 regression
  tests), tsconfig include entry.
- Regression test: `workbench-polish` suite — 18/18 green
  (global bar, rail/sidebar selection, primary canvas, context
  collapse, terminal drawer, composer dock, secondary actions, brand
  tokens, emblem slot, filenames, scrollbars, status strip, buttons,
  typography, regions/functionality, responsive shell, no-HTML/no-IPC,
  schema v18);
  full gate green (282 suites / 1845 tests / 0 failures).
- Retest result: PASS (automated). Human visual sign-off pending —
  STOPPED for human inspection per instruction; Stage 31 manual
  acceptance remains paused.
- Rearchitecture note: incremental CSS could not fix the outdated
  three-pane shell, so the renderer was restructured (single AppChrome
  bar, 48px activity rail, contextual sidebar, tabbed Session|Editor
  primary canvas, docked terminal drawer, thin status strip, session
  options menu, collapsible context drawer). Renderer-only; all
  shipped functionality preserved with zero main/IPC/DB/schema
  changes.

---

## STAGE31-D05 — final UI rebuild, OpenCode UX architecture × STARK brand (implemented, human visual retest required)

- Status: **FAIL → pending human visual retest.** Automated gates are
  green; visual PASS may only be granted by a human inspecting the
  rendered result. Stage 31 acceptance remains paused.
- Direction: the structural/UX quality of OpenCode with the identity
  and product logic of STARK, reimplemented natively in STARK's
  existing React renderer. No OpenCode source, packages, branding, or
  assets were used.
- Architecture (renderer-only):
  primary Session pane (always mounted on desktop) + optional
  secondary workspace pane (Review | Context | file tabs) with the
  terminal stacked beneath it; workspace-tools drawer overlays on
  demand and consumes no permanent column; composer dock at the
  session bottom with approval/recovery/runtime docks directly above
  it; dedicated settings surface (modal) hosting AI & Models, Heart,
  Recovery, Permissions, Usage, Account (existing AccountSection), and
  Profile; compact AppChrome (menu, STARK mark, workspace name,
  workspace search, terminal toggle, settings, account initial);
  quiet 24px status strip without profile editing.
- State ownership unchanged: single context-draft reducer in HomePage;
  all session/provider/Heart/Recovery/usage/capability/runtime
  reducers still owned by SessionPanel (settings visibility only
  lifted so AppChrome can reach the surface); all explorer/preview/
  editor/changes/Git reducers still owned by Explorer; terminal PTY
  behavior untouched. No new IPC, no timers, no polling, no network
  calls, no persistence.
- Boundary: `git diff -- src/main` EMPTY, `git diff -- src/preload`
  EMPTY, no migration 019, schema v18, no shared IPC changes.
- Validation: `npm run typecheck` PASS, `npm run lint` PASS,
  `npm run build` PASS, `npm test` 283 suites / 1868 tests / 0
  failures, `npm run release:check` ALL CHECKS PASSED.
- Retest result: PASS (automated). **D05 HUMAN VISUAL RETEST REQUIRED**
  at 1920×1080, 1440×900, 1366×768, and 1024×768 before Stage 31
  acceptance may resume.

---

## Investigated and ruled NOT defects (no change made)

- **Terminal program charset** (`npm; rm -rf` accepted by
  `parseTerminalExecuteArgs`): safe — execution uses `shell: false`
  with a sanitized PATH lookup, so an unresolvable program fails as
  `spawn_failed`; argv metacharacters are proven inert by
  `worker-terminal.test.ts` ("passes shell metacharacters as inert
  argv data"). No acceptance expectation violated.
- **`while (true)` in `looplink-service.ts:459`**: bounded — each
  iteration drops one message (≤12 total) and exits at ≤1 or throws
  `LooplinkPayloadTooLargeError`. Terminates; no hang.
- **Git availability cache**: in-memory only with a test clear hook;
  no acceptance check covers mid-session git install/remove.
  Post-v1 polish at most; not recorded as a defect.
- **Unpacked-build version footer** showing the Electron version
  instead of 0.1.0: environmental quirk (no `package.json` beside
  `out/` when launching via `electron ./out/...`), already documented
  in readiness; packaged builds bundle `package.json` so
  `app.getVersion()` resolves 0.1.0. Not a software defect.
- **Preview partition persistence**: per-runtime-id `persist:`
  partitions are isolated across runtimes; no acceptance check
  requires storage erasure on stop. Comment corrected (D04);
  behavior unchanged.

---

## Remaining software issues

None. Zero unresolved software defects. All four tracked items are
fixed and retested green.
