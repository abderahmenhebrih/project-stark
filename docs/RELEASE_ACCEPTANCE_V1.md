# STARK v1 — Release Acceptance Matrix (Stage 31)

Authoritative human acceptance checklist for the STARK v1 release
candidate (schema v18, Stages 1–30). Prepared in Stage 30.

**Status: EXECUTED in Stage 31 (2026-10-09).** Every check below carries
a Stage 31 record (Status / Date / RC / Evidence / Notes). Automated
coverage notes never replace the manual confirmation; BLOCKED items name
their exact prerequisite and unblock action.

RC: **STARK-v0.1.0-RC1+2870399** (package 0.1.0, commit
`2870399c79fc4b238d05c971c3a710282853da13`, schema **v18**,
Windows x64, Node v22.23.2, Electron v44.6.0).

Result totals: **Total 76 — PASS 6 · FAIL 0 · BLOCKED 70 ·
NOT_APPLICABLE 0.** P0: 4 PASS / 43 BLOCKED. P1: 1 PASS / 27 BLOCKED.
P2: 1 PASS. No UNTESTED remains.

Priorities: **P0** release-blocking safety/data-integrity ·
**P1** normal functional workflows · **P2** cosmetic/polish.

Related stages are traced per section (e.g. Recovery — Stages 20–21).

---

## A. First Launch / Onboarding (Stages 1–4) — P0/P1

A-01 [P0]
Preconditions: fresh userdata (no stark.db).
Steps: 1. Launch app. 2. Observe first screen.
Expected: "How should I call you?" prompt; no shell flash; no account,
key, or workspace demanded.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — no human-operated GUI session in this headless agent run (no display forwarding).
Notes: Blocking prerequisite: human-operated RC GUI session with fresh userdata. Blocks current-host RC manual confirmation only, not public release. Action: human launches RC with empty userData, observes first screen, records result. Automated coverage (support only): boot-state, profile-service suites; release:smoke launch ok (schema v18).

A-02 [P0]
Preconditions: A-01 state.
Steps: 1. Enter "Abdou". 2. Continue.
Expected: greeting "Hi Abdou…"; shell usable; restart skips onboarding.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI onboarding interaction.
Notes: Prerequisite: A-01 human pass + GUI session. Blocks RC confirmation only. Action: human enters name, continues, restarts, records greeting/skip behavior. Automated coverage (support only): profile-service, profile-schema, double-submit-guards suites.

A-03 [P1]
Preconditions: signed-in shell.
Steps: 1. Open "STARK calls you". 2. Change name to "Amina". 3. Save.
4. Restart.
Expected: greeting uses "Amina"; no cloud sync; blank save rejected;
double-click Save saves once.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI profile edit + restart.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human edits/saves/restarts, verifies greeting, blank-reject, single-save. Automated coverage (support only): profile-state, double-submit-guards suites.

A-04 [P1]
Preconditions: corrupt `stark.profile` value in DB.
Steps: 1. Launch.
Expected: safe fallback to onboarding; no crash; other settings intact.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — service falls back to null with warn (code) and boot-state routes null→onboarding (code), covered by unit suites.
Notes: Prerequisite: human GUI launch with corrupted profile row. Blocks RC confirmation only. Action: human corrupts value in disposable DB, launches, observes fallback. Automated coverage (support only): profile-service, boot-state suites.

## B. Workspace (Stages 2–5)

B-01 [P1]
Preconditions: no workspace selected.
Steps: 1. Observe empty state.
Expected: clear empty state with primary "Open Workspace" action; no
misleading disabled project data.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI empty-state inspection.
Notes: Prerequisite: human GUI session with no workspace. Blocks RC confirmation only. Action: human observes empty state, records copy/actions. Automated coverage (support only): renderer workspace-layout suite.

B-02 [P1]
Preconditions: empty state.
Steps: 1. Open Workspace. 2. Pick a folder. 3. Restart.
Expected: folder persists as current; recent list updates (max 8).
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires native picker + human restart.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human opens folder, restarts, verifies persistence/recency. Automated coverage (support only): workspace-service, workspace-repository suites (limit 8, dedupe).

B-03 [P0]
Preconditions: workspace selected.
Steps: 1. Delete/move the folder on disk. 2. Trigger workspace load.
Expected: safe "no longer available" copy; no crash; no invented paths.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — service returns null/WorkspaceUnavailableError on missing root (code), covered by unit suites.
Notes: Prerequisite: human GUI session with disposable folder. Blocks RC confirmation only. Action: human deletes folder, triggers load, observes safe copy. Automated coverage (support only): workspace-service suite.

## C. Explorer (Stage 6)

C-01 [P1]
Preconditions: workspace with nested dirs incl. `.git`, `node_modules`.
Steps: 1. Expand tree. 2. Open a small text file.
Expected: lazy listing, generated dirs hidden, preview ≤1 MiB, strict
decoding, symlinks never traversed.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI tree navigation.
Notes: Prerequisite: human GUI session with fixture workspace. Blocks RC confirmation only. Action: human expands tree, opens file, verifies listing/hiding/limits. Automated coverage (support only): workspace-files-service, workspace-path, file-revision suites.

C-02 [P0]
Preconditions: workspace with binary file.
Steps: 1. Select binary.
Expected: refused preview with safe copy; no binary bytes rendered.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — reader rejects NUL/strict-decode failures with UnsupportedFileError (code), covered by unit suites.
Notes: Prerequisite: human GUI session with binary fixture. Blocks RC confirmation only. Action: human selects binary, verifies refusal copy and no byte rendering. Automated coverage (support only): workspace-files-service suite.

## D. Search (Stage 7)

D-01 [P1]
Preconditions: workspace selected.
Steps: 1. Type query (do not submit). 2. Press Enter.
Expected: nothing runs per keystroke; results only after explicit
submit; literal match; secret names skipped.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI typing/submit.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human types (no run), submits, verifies literal results + secret-name skips. Automated coverage (support only): workspace-search-service, search-validation, search-state suites.

D-02 [P1]
Preconditions: D-01 results.
Steps: 1. Click a result.
Expected: file opens read-only at line/column via existing preview.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI click-through.
Notes: Prerequisite: D-01 human pass. Blocks RC confirmation only. Action: human clicks result, verifies read-only open at line/column. Automated coverage: none beyond D-01 path reuse (manual).

## E. Editor / Monaco (Stages 8, 10)

E-01 [P0]
Preconditions: text file open.
Steps: 1. Edit outside STARK. 2. Edit in STARK, Review, Save.
Expected: stale-write refusal ("changed on disk"); no force overwrite.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — SHA-256 revision double-check refuses on mismatch with no force path (code), covered by unit suites.
Notes: Prerequisite: human GUI session + external edit. Blocks RC confirmation only. Action: human edits externally, then in STARK, verifies refusal copy. Automated coverage (support only): workspace write-error, editor-document suites.

E-02 [P1]
Preconditions: packaged build, offline.
Steps: 1. Open editor.
Expected: highlighting/undo/find work; no CDN request; no network needed.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human offline GUI session. Static support: monaco-packaging suite forbids CDN hosts; editor imports local worker URLs (code).
Notes: Prerequisite: packaged RC + network disconnect + human session. Blocks RC confirmation only. Action: human opens editor offline, verifies editing features. Automated coverage (support only): monaco-packaging suite.

E-03 [P1]
Preconditions: mixed-line-ending file.
Steps: 1. Open file.
Expected: read-only with mixed-endings notice; never normalized.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — EOL detector forces read-only + fixed notice (code), covered by unit suites.
Notes: Prerequisite: human GUI session with mixed-endings fixture. Blocks RC confirmation only. Action: human opens file, verifies notice + read-only. Automated coverage (support only): editor-eol suite.

## F. Change Transactions (Stage 9)

F-01 [P0]
Preconditions: file preview.
Steps: 1. Edit → Review change → Accept.
Expected: pending proposal created first (disk untouched); Accept
writes atomically; history shows applied.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — service creates pending first, Accept via atomic Stage 8 writer (code), covered by unit suites.
Notes: Prerequisite: human GUI session with disposable file. Blocks RC confirmation only. Action: human reviews, verifies disk untouched pre-Accept, accepts, verifies applied history. Automated coverage (support only): change-transaction-service/repository suites.

F-02 [P0]
Preconditions: pending transaction.
Steps: 1. Change file externally. 2. Accept. 3. Rollback attempt.
Expected: Accept conflicts safely; rollback of moved disk content
conflicts instead of overwriting.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — Accept stays pending on conflict; rollback stays applied on conflict (code), covered by unit suites.
Notes: Prerequisite: human GUI session + external modification. Blocks RC confirmation only. Action: human races external change, verifies conflict (no overwrite). Automated coverage (support only): change-transaction-service suite.

F-03 [P1]
Preconditions: applied transaction.
Steps: 1. Reject (expect refusal). 2. Rollback.
Expected: terminal states immutable except valid rollback; Reject of
applied refused.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — terminal-state transitions enforced in service + SQL (code), covered by unit suites.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human rejects applied (refusal), rolls back, verifies states. Automated coverage (support only): change-transaction-service suite.

## G. Change Sets (Stage 17)

G-01 [P1]
Preconditions: AI proposal with 2–5 whole files.
Steps: 1. Review group. 2. Accept one file.
Expected: grouped review, per-file Accept only; no Accept All; group
state derived.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires provider-backed multi-file proposal + human review (needs API key + GUI).
Notes: Prerequisite: valid provider key + human GUI session. Blocks RC confirmation only. Action: human reviews group, accepts one file, verifies no Accept All + derived state. Automated coverage (support only): change-set-service/repository/safety, ai-change-set-architecture suites.

## H. Human Terminal (Stage 11)

H-01 [P1]
Preconditions: workspace selected.
Steps: 1. Open terminal panel (collapsed). 2. Start. 3. Type `echo hi`.
4. Kill.
Expected: explicit Start only; output streams; Kill terminates with
"Terminal exited"; no auto-respawn.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human PTY interaction in GUI.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human starts, types harmless command, kills, verifies lifecycle copy. Automated coverage (support only): terminal-manager, terminal-state, terminal-contract suites.

H-02 [P0]
Preconditions: terminal running.
Steps: 1. Switch workspace.
Expected: confirm dialog; decline stays; accept kills first, never
auto-starts in new project.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires running PTY + human workspace switch (manual).
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human switches workspace, exercises decline/accept paths. Automated coverage (support only): terminal-guard copy (manual).

H-03 [P0]
Preconditions: none.
Steps: 1. Confirm no agent/AI path can write to the terminal.
Expected: no `runCommand` API; AI panels offer no terminal action.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — static audit: no `runCommand`/`executeCommand` channel in preload/IPC (grep); command service never touches human TerminalManager (unit suite PASS). AI-panel half unobserved (needs GUI).
Notes: Prerequisite: human GUI inspection of AI panels. Blocks RC confirmation only. Action: human verifies AI panels offer no terminal action. Automated coverage (support only): terminal-contract, worker-tool-architecture suites.

## I. Git (Stage 12)

I-01 [P1]
Preconditions: workspace is a repo root.
Steps: 1. Open GIT tab. 2. Refresh. 3. View diff.
Expected: branch/status/diff render; no fetch; no mutation; 5s bound.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI on a repo-root fixture.
Notes: Prerequisite: human GUI session + disposable repo. Blocks RC confirmation only. Action: human opens tab, refreshes once, views diff, verifies no network/mutation. Automated coverage (support only): git-service, git-process-runner suites (shell:false, 5s bound, no fetch).

I-02 [P0]
Preconditions: workspace is a subfolder of a repo.
Steps: 1. Open GIT tab.
Expected: refusal ("open the repository root"); no nested scan.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — top-level equality check throws RootMismatchError (code), covered by unit suites.
Notes: Prerequisite: human GUI session with subfolder workspace. Blocks RC confirmation only. Action: human opens GIT tab, verifies refusal copy. Automated coverage (support only): git-service suite.

## J. Sessions / Ask (Stages 13–15)

J-01 [P1]
Preconditions: workspace, no sessions.
Steps: 1. Observe panel.
Expected: "No coding sessions yet." + New session; no auto-creation.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI panel inspection.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human observes empty panel, verifies copy + no auto-creation. Automated coverage (support only): 004-coding-sessions no-auto-create test.

J-02 [P1]
Preconditions: session exists.
Steps: 1. Send message. 2. Load older.
Expected: message persists byte-exact; paging 100/page; title derived
from first message.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI messaging/paging.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human sends message, pages history, verifies byte-exact + title. Automated coverage (support only): coding-session-service/repository suites.

J-03 [P0]
Preconditions: provider unconfigured.
Steps: 1. Send message.
Expected: clear setup guidance ("AI provider not connected"); no raw
SDK error; no network action.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — guidance copy exists in renderer + safe error maps (code), covered by unit suites.
Notes: Prerequisite: human GUI session with no provider configured. Blocks RC confirmation only. Action: human sends message, verifies guidance + no network. Automated coverage (support only): provider-error suite.

## K. Providers / Credentials (Stage 14) — P0

K-01 [P0]
Preconditions: clean provider state.
Steps: 1. Save OpenAI key. 2. Restart. 3. Test connection.
Expected: Configured; key never displayed; survives restart; insecure
platforms refuse with safe copy.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires a real key handled only via STARK credential UI (no key available in this environment; keys must never be pasted into logs/chat).
Notes: Blocking prerequisite: one valid provider key + human GUI session. Blocks provider checks on all hosts until configured; not a software failure. Action: human saves key in AI Settings, restarts, tests connection, verifies Configured + no display. Automated coverage (support only): ai-provider-service, providers-bindings suites.

K-02 [P0]
Preconditions: saved key.
Steps: 1. Inspect renderer APIs, logs, DB.
Expected: no plaintext key in renderer/SQLite/logs; ciphertext BLOB only.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — schema holds ciphertext BLOB only (code); safeStorage encrypt/decrypt seam fail-closed (code); redaction suites green; bundle scan shows only redaction-guard references to secret patterns. Renderer/DB/log inspection with a real saved key unobserved (needs K-01 human pass).
Notes: Prerequisite: K-01 human pass + human inspection. Blocks RC confirmation only. Action: human inspects window.stark/SQLite/logs for plaintext. Automated coverage (support only): credential suites, public-error-redaction suite, release-security BLOB checks.

K-03 [P1]
Preconditions: saved key.
Steps: 1. Remove key.
Expected: Not configured; generation disabled with guidance.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires K-01 human pass first (manual).
Notes: Prerequisite: K-01 human pass. Blocks RC confirmation only. Action: human removes key, verifies Not configured + disabled generation. Automated coverage (support only): provider-state suite.

## L. Explicit Context (Stage 15)

L-01 [P1]
Preconditions: session + open file.
Steps: 1. Attach selection. 2. Inspect chip. 3. Remove chip. 4. Send.
Expected: visible removable chips; history shows sent items; stale
attachment fails send with reattach copy.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI attach/send flow.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human attaches, inspects, removes, sends; races a stale file for refusal copy. Automated coverage (support only): session-context-state suites.

## M. Propose (Stage 16)

M-01 [P0]
Preconditions: one whole-file attachment.
Steps: 1. Propose change. 2. Review. 3. Accept.
Expected: one pending transaction (disk unchanged until Accept);
identical content yields "no code changes" with no transaction.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires provider-backed propose (needs API key) + human review.
Notes: Prerequisite: valid provider key + human GUI session. Blocks RC confirmation only. Action: human proposes, verifies pending-only + disk unchanged, accepts. Automated coverage (support only): ai-proposal stale/validation/transaction suites.

## N. Brain (Stage 18)

N-01 [P1]
Preconditions: provider + model configured.
Steps: 1. Run Work (answer path). 2. Run Work (delegate path).
Expected: ≤3 provider calls; plan + result details persist; retry
starts a new run without duplicating the message.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires billable provider calls (bounded: ≤3 per Work) + human GUI.
Notes: Prerequisite: valid provider key + human GUI session. Blocks RC confirmation only; do not cause unnecessary billable calls. Action: human runs both paths, verifies call bounds + persisted details + clean retry. Automated coverage (support only): ai-brain direct/delegated/guard/architecture suites.

## O. Heart (Stage 19)

O-01 [P1]
Preconditions: Heart configured Fixed + Auto-Swap.
Steps: 1. Save config. 2. Run Work. 3. Inspect run audit.
Expected: routing resolves locally; per-step provider/model audit;
legacy selection untouched.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires provider-backed Work (needs API key) + human GUI.
Notes: Prerequisite: valid provider key + human GUI session. Blocks RC confirmation only. Action: human saves Heart config, runs Work, verifies local routing + audit. Automated coverage (support only): heart-service/repository, ai-heart-routing suites.

## P. Looplink (Stage 20)

P-01 [P1]
Preconditions: session with history.
Steps: 1. Continue with Looplink. 2. Send Ask in target.
Expected: new "Continue: …" session; handoff consumed once;
historical files not proposal-eligible until reattached.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI continuation flow (Ask send needs provider unless failure-path; consume-once needs human send).
Notes: Prerequisite: human GUI session (+ provider key for Ask send). Blocks RC confirmation only. Action: human continues, sends in target, verifies single consume + history non-authority. Automated coverage (support only): looplink-service/bindings, ai-looplink suites.

## Q. Recovery (Stages 20–21)

Q-01 [P0]
Preconditions: recovery `auto_once` with assignments; provider
rate-limiting (or simulated 429).
Steps: 1. Send Ask.
Expected: exactly one handoff + one recovery attempt, then STOP; no
chains; source run stays failed.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires provider failure (real 429 or deterministic fake config) + human GUI.
Notes: Prerequisite: human GUI session + recoverable-failure setup (prefer deterministic/fake 429 over exhausting real quota). Blocks RC confirmation only. Action: human sends Ask, verifies single-hop STOP + failed source. Automated coverage (support only): recovery-coordinator-ask/work, recovery-architecture suites (MAX_RECOVERY_HOPS=1).

Q-02 [P1]
Preconditions: recovery `handoff`.
Steps: 1. Trigger recoverable failure. 2. Dismiss recovery.
Expected: "Recovery ready" target, no provider call; dismiss keeps session.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires recoverable failure + human GUI (manual).
Notes: Prerequisite: human GUI session + failure setup. Blocks RC confirmation only. Action: human triggers, dismisses, verifies no-call target + session kept. Automated coverage (support only): recovery-state suite.

## R. Agent Permissions (Stage 22)

R-01 [P0]
Preconditions: fresh workspace.
Steps: 1. Open Agent Permissions.
Expected: master Disabled; all Deny; saving `terminal.execute=allow`
rejected.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — default-deny synthesis + terminal-allow rejection enforced in gate/validation (code), covered by unit suites.
Notes: Prerequisite: human GUI session. Blocks RC confirmation only. Action: human opens permissions, verifies defaults + allow-rejection. Automated coverage (support only): capability suites, release-security terminal-allow checks.

R-02 [P1]
Preconditions: R-01.
Steps: 1. Enable master, set modes, Save. 2. Disable, re-enable.
Expected: complete-replacement save; modes preserved across disable.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI permissions editing (manual).
Notes: Prerequisite: R-01 human pass. Blocks RC confirmation only. Action: human saves, disables, re-enables, verifies preserved modes. Automated coverage (support only): capabilities-state suite.

## S. Worker Read/Search/Git Tools (Stage 23)

S-01 [P0]
Preconditions: `workspace.read=Ask`, Work request needing a file.
Steps: 1. Run Work. 2. Approve exact read.
Expected: run parks (`waiting_for_approval`, no polling); approval
covers one exact invocation; resume continues.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires provider-backed Work (billable) + human exact-approval click.
Notes: Prerequisite: valid provider key + human GUI session. Blocks RC confirmation only. Action: human runs Work, approves exact read, verifies park/resume (no polling). Automated coverage (support only): worker-tool-runner/integration suites (park/resume, 15-min lazy expiry, tamper-hash).

S-02 [P0]
Preconditions: S-01 pending.
Steps: 1. Tamper approval args (if possible). 2. Deny instead.
Expected: tamper fails safely; denial resumes Worker with denied
result (run may still succeed).
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires S-01 human pending state.
Notes: Prerequisite: S-01 human pass. Blocks RC confirmation only. Action: human attempts tamper (must fail), denies, verifies denied-resume. Automated coverage (support only): worker-tool approval-hash + deny-resume suites.

## T. Worker change.propose (Stage 24)

T-01 [P0]
Preconditions: `change.propose=Ask`, prior successful `workspace_read`
in same run.
Steps: 1. Worker proposes. 2. Approve exact proposal.
Expected: reviewable pending proposal only; unknown `R99`/cross-run
refs rejected; disk unchanged.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires provider-backed tool Work + human approval.
Notes: Prerequisite: valid provider key + human GUI session. Blocks RC confirmation only. Action: human approves exact proposal, verifies pending-only + disk unchanged + ref rejection. Automated coverage (support only): worker-proposal, worker-tool-integration suites (readRef same-run authority).

## U. Worker terminal_execute (Stage 25)

U-01 [P0]
Preconditions: `terminal.execute=Ask`.
Steps: 1. Worker requests exact command. 2. Approve.
Expected: one bounded non-interactive run (60s, 64 KiB cap); argv
execution (no shell string); nonzero exit reported, no retry.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — validator accepts exact {program,args} and rejects malformed (headless script); execution uses shell:false + at-most-once UNIQUE approval (code); stage-25 bounds suite green (131 tests incl. terminal). Human approval + live run unobserved.
Notes: Prerequisite: valid provider key + human GUI session; use harmless commands only. Blocks RC confirmation only. Action: human approves exact command, verifies single bounded run + exit report + no retry. Automated coverage (support only): worker-terminal, worker-command suites.

U-02 [P0]
Preconditions: U-01 approved and running.
Steps: 1. Kill app mid-command. 2. Relaunch.
Expected: execution marked interrupted; no re-execution; parked run
fails with safe copy; approval stays consumed.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human kill + relaunch with disposable userData.
Notes: Prerequisite: U-01 human pass + human-driven kill. Blocks RC confirmation only. Action: human kills mid-command, relaunches, verifies interrupted + consumed approval + no replay. Automated coverage (support only): command-interruption suites.

## V. Managed Runtime (Stage 26)

V-01 [P0]
Preconditions: workspace; `terminal.execute=Ask`.
Steps: 1. Start Work. 2. Worker requests runtime_start. 3. Approve exact command.
Expected: one runtime starts; Preview URL derived by main; Worker
continues; runtime remains after Work completion.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires provider-backed Work + human approval + disposable project.
Notes: Prerequisite: valid provider key + human GUI session + disposable runtime project (never prod). Blocks RC confirmation only. Action: human approves exact start, verifies single runtime + derived URL + post-Work survival. Automated coverage (support only): project-runtime suites.

V-02 [P0]
Preconditions: V-01 running.
Steps: 1. Start second runtime. 2. Stop runtime. 3. Quit app.
Expected: second start refused (one active); Stop terminates exact
tree; quit persists final state with bounded cleanup.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires V-01 human pass. One-active + exact-tree kill enforced in service (code), covered by unit suites.
Notes: Prerequisite: V-01 human pass. Blocks RC confirmation only. Action: human refuses second start, stops (verifies exact tree gone, no unrelated kills), quits (bounded cleanup). Automated coverage (support only): project-runtime suites (incl. taskkill-exact-args test).

V-03 [P0]
Preconditions: running runtime with Preview open.
Steps: 1. Navigate Preview to external site (if possible).
Expected: off-origin navigation blocked; popups denied; no preload in
Preview; permissions denied.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — `isAllowedPreviewNavigation`: same-loopback-origin allowed, external/file/other-port denied (headless script); window wiring denies popups/permissions and has no preload (code); preview-inspection-security + release-security suites green. Live Preview navigation unobserved (needs running runtime + human GUI).
Notes: Prerequisite: V-01 human pass + open Preview. Blocks RC confirmation only. Action: human attempts external navigation/popup, verifies blocking. Automated coverage (support only): preview-inspection-security, release-security suites.

## W. Runtime Observation (Stage 27a)

W-01 [P1]
Preconditions: active runtime; `runtime.observe=Ask`.
Steps: 1. Worker observes (approve). 2. Inspect output.
Expected: bounded normalized observation (≤64 KiB, no PID/paths/env);
second observe is a fresh explicit read.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires active runtime + provider-backed Work + human approval.
Notes: Prerequisite: valid provider key + human GUI session + running runtime. Blocks RC confirmation only. Action: human approves observe twice, verifies bounds + normalization + fresh-read semantics. Automated coverage (support only): worker-observation suites.

## X. Preview Inspection (Stage 27b)

X-01 [P0]
Preconditions: active runtime; Preview open; `preview.inspect=Ask`.
Steps: 1. Worker inspects (approve).
Expected: bounded textual snapshot (no input values/cookies/scripts);
hidden inspector destroyed immediately; runtime untouched.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires active runtime + Preview + human approval.
Notes: Prerequisite: valid provider key + human GUI session + open Preview. Blocks RC confirmation only. Action: human approves inspect, verifies bounded redacted snapshot + inspector teardown + running runtime. Automated coverage (support only): preview-inspection-security suites.

## Y. Usage / Threshold Routing (Stage 28)

Y-01 [P1]
Preconditions: usage panel.
Steps: 1. Load summary. 2. Save a threshold + alternate. 3. Run Work.
Expected: 24h local summary; explicit save only; frozen per-run
snapshot with decision audit; Ask/Propose untracked-for-routing.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human GUI + provider-backed Work.
Notes: Prerequisite: human GUI session (+ provider key for Work step). Blocks RC confirmation only. Action: human loads summary, saves threshold, runs Work, verifies snapshot audit. Automated coverage (support only): ai-usage-service, usage-threshold-policy/heart-routing, usage-state suites (explicit save, no polling).

Y-02 [P0]
Preconditions: Y-01 alternate configured.
Steps: 1. Verify alternate differs from Heart route (save identical).
Expected: identical alternate rejected; at most one alternate/route.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — identical-alternate rejection + single-alternate policy enforced in threshold policy/constraints (code), covered by unit suites.
Notes: Prerequisite: Y-01 human pass. Blocks RC confirmation only. Action: human saves identical alternate, verifies rejection. Automated coverage (support only): usage-threshold-policy, usage-heart-routing suites.

## Z. Account / OAuth (Stage 29) — P0

Z-01 [P0]
Preconditions: signed out; Supabase configured.
Steps: 1. Click Continue with Google.
Expected: system browser opens ONCE; STARK stays usable; signing-in
state with Cancel.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — no Supabase project/provider configured and no registered stark:// redirect in this environment; no browser flow attempted (must not fake PASS).
Notes: Blocking prerequisite: Supabase project + Google provider + registered redirect + interactive browser + human. Blocks OAuth checks on all hosts until configured; not a software failure. Action: configure backend, human clicks, verifies single browser open + Cancel state. Automated coverage (support only): oauth-attempt-manager, cloud-account-service suites.

Z-02 [P0]
Preconditions: Z-01 browser flow.
Steps: 1. Authenticate. 2. Return via deep link.
Expected: signed-in Google identity; NO project upload; local profile
greeting unchanged.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires Z-01 human pass (same missing backend).
Notes: Prerequisite: Z-01 human pass. Blocks OAuth checks until configured. Action: human authenticates, returns via deep link, verifies identity + no upload + unchanged greeting. Automated coverage (support only): cloud-account-service, deep-link suites.

Z-03 [P0]
Preconditions: Z-02.
Steps: 1. Inspect renderer APIs, SQLite, logs.
Expected: no access/refresh token, code, or verifier in renderer/DB
plaintext/logs; encrypted BLOB only.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — session store holds encrypted BLOB only (code); preload carries a token-field denylist validator rejecting any status with token/code/verifier fields (observed in out/preload/index.cjs); bundle scan shows only redaction-guard references; redaction suites green. Inspection with a real session unobserved (needs Z-02 human pass; tokens must never be copied).
Notes: Prerequisite: Z-02 human pass + human inspection (verify only, never copy tokens). Blocks OAuth checks until configured. Action: human inspects renderer/DB/logs for plaintext. Automated coverage (support only): cloud-auth-session-store, cloud-account-service redaction, release-security BLOB suites.

Z-04 [P0]
Preconditions: signing-in active.
Steps: 1. Cancel. 2. Complete browser flow anyway.
Expected: no authentication from the late callback.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires live sign-in flow (same missing backend).
Notes: Prerequisite: configured backend + human GUI. Blocks OAuth checks until configured. Action: human cancels, completes browser flow anyway, verifies no authentication. Automated coverage (support only): oauth-attempt-manager single-use/expiry suites.

Z-05 [P1]
Preconditions: GitHub account.
Steps: 1. Sign out. 2. Continue with GitHub.
Expected: same flow as Google; must sign out before switching.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — no Supabase/GitHub provider configured (must not fake PASS).
Notes: Prerequisite: Supabase + GitHub provider + registered redirect + human. Blocks OAuth checks until configured. Action: human signs out, signs in with GitHub, verifies switch guard. Automated coverage (support only): cloud-account-service suites.

Z-06 [P0]
Preconditions: signed in.
Steps: 1. Close STARK. 2. Reopen (online).
Expected: account restores securely; no new browser opens.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires signed-in state (needs Z-01/Z-02 human pass).
Notes: Prerequisite: Z-02 human pass. Blocks OAuth checks until configured. Action: human restarts online, verifies silent secure restore. Automated coverage (support only): cloud-account-service restore suites.

Z-07 [P0]
Preconditions: signed in.
Steps: 1. Sign out.
Expected: identity/session gone; Workspaces, sessions, API keys,
local profile all intact.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires signed-in state (needs Z-02 human pass).
Notes: Prerequisite: Z-02 human pass. Blocks OAuth checks until configured. Action: human signs out, verifies session gone + local data intact. Automated coverage (support only): cloud-account-service sign-out suites.

Z-08 [P0]
Preconditions: any.
Steps: 1. Feed malformed `stark://` URLs (wrong host/path/scheme,
fragment, oversized).
Expected: all rejected; no exchange; no crash.
Status: PASS
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Observed headless — `parseAuthCallbackUrl` accepts the exact valid callback and rejects 5/5 malformed (wrong scheme, missing code, fragment, wrong host, unexpected param); no exchange path reached; no crash. deep-link suite green.
Notes: Validator-layer PASS. Full OS-registered deep-link delivery still needs human installer pass (see AD-01); no tokens handled here.

## AA. Persistence / Restart (Stages 1–29) — P0

AA-01 [P0]
Preconditions: populated app (workspace, session, pending proposal,
provider key, Heart config, signed in).
Steps: 1. Quit. 2. Relaunch.
Expected: everything restores; no auto-send/AI/resume; account
restores without browser.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires populated human GUI session (incl. real key + sign-in) + quit/relaunch.
Notes: Prerequisite: human GUI session with populated state. Blocks RC confirmation only. Action: human quits/relaunches, verifies restore + no auto-AI + silent account restore. Automated coverage (support only): per-domain persistence suites; release:smoke launch ok.

AA-02 [P0]
Preconditions: v17 database copy.
Steps: 1. Launch new build.
Expected: upgrade to v18; rows preserved; no destructive reset.
Status: PASS
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Observed headless — upgrade-matrix suite 6/6 green (v5/v9/v13/v15/v17→v18 rows preserved); direct `runMigrations` fresh→v18 yields user_version=18 with 35 tables; 018-cloud-account suite green (idempotent, account rows kept).
Notes: Initial result PASS; no defect. No migration 019 exists; schema stays v18.

AA-03 [P0]
Preconditions: DB with user_version 99.
Steps: 1. Launch.
Expected: safe "newer version of STARK" failure; no backwards
migration; no writable open.
Status: PASS
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Observed headless — user_version=99 throws NewerSchemaError ("created by a newer version of STARK (data v99, this build supports v18)"); no migration attempted; schema-guard suite green (newer/backwards/ordered).
Notes: Initial result PASS; failure-copy text comes from startup-failure map (unit-covered). GUI dialog observation pending human launch but failure semantics observed.

AA-04 [P0]
Preconditions: corrupt (non-SQLite) stark.db.
Steps: 1. Launch.
Expected: single safe "STARK could not start." dialog + Quit; file
left untouched; no relaunch loop.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — non-SQLite file fails safe open (Error, no crash, file left in place) headless; schema-guard + startup-failure suites green. Dialog/Quit/no-relaunch-loop unobserved (needs human GUI launch).
Notes: Prerequisite: human GUI launch with disposable corrupt DB (never prod data). Blocks RC confirmation only. Action: human launches, verifies single safe dialog + Quit + untouched file + no loop. Automated coverage (support only): database, startup-failure suites.

## AB. Crash / Interrupted States (Stages 18–28) — P0

AB-01 [P0]
Preconditions: running Work orchestration.
Steps: 1. Kill process mid-run. 2. Relaunch.
Expected: run marked interrupted/failed; Looplink pending preserved;
no resume, no duplicate message.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human-driven kill + relaunch with disposable userData.
Notes: Prerequisite: human kill/relaunch (test seams exist; never prod data). Blocks RC confirmation only. Action: human kills mid-run, relaunches, verifies interrupted marking + no replay. Automated coverage (support only): orchestration/recovery interruption suites (startup pass marks running→interrupted, no resume).

AB-02 [P0]
Preconditions: approved Worker command running.
Steps: 1. Kill process. 2. Relaunch.
Expected: execution interrupted; no re-execution; no PID kills.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human-driven kill + relaunch.
Notes: Prerequisite: human kill/relaunch with disposable userData. Blocks RC confirmation only. Action: human kills mid-command, relaunches, verifies interrupted + consumed approval + no PID kills. Automated coverage (support only): worker-command interruption suites.

AB-03 [P0]
Preconditions: starting/running managed runtime.
Steps: 1. Kill process. 2. Relaunch.
Expected: session interrupted; no relaunch; no auto-restart.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires human-driven kill + relaunch.
Notes: Prerequisite: human kill/relaunch with disposable userData. Blocks RC confirmation only. Action: human kills mid-runtime-start/run, relaunches, verifies interrupted + no auto-restart. Automated coverage (support only): project-runtime interruption suites.

## AC. Security (all stages) — P0

AC-01 [P0]
Preconditions: packaged or dev build.
Steps: 1. Open DevTools → inspect `window.stark`.
Expected: fixed per-domain functions only; no generic invoke/fs/
process/eval/URL-open/Supabase surface.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — preload exposes only `window.stark` via contextBridge with fixed per-domain invoke calls (static audit); window factory sets contextIsolation/nodeIntegration-false/sandbox (code); 30-item release-security matrix + preload-contract + production-surface suites green. DevTools inspection unobserved (needs human GUI).
Notes: Prerequisite: human DevTools inspection on RC build. Blocks RC confirmation only. Action: human inspects window.stark, verifies fixed surface only. Automated coverage (support only): release-security, preload-contract, production-surface suites.

AC-02 [P0]
Preconditions: any file/image from untrusted source in Workspace.
Steps: 1. Preview/search/probe it.
Expected: hostile strings render inert; no HTML/JS execution anywhere.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — plain-text pre-wrapped inert rendering across panels (code), covered by content-safety suites.
Notes: Prerequisite: human GUI session with hostile-string fixtures. Blocks RC confirmation only. Action: human previews/searches/probes hostile content, verifies inert rendering everywhere. Automated coverage (support only): explorer/session/observation content-safety suites.

AC-03 [P0]
Preconditions: renderer crash (e.g. forced via DevTools).
Steps: 1. Observe fallback. 2. Reload interface.
Expected: "STARK encountered a display error." + Reload; no runtime
restart, AI resend, or approval replay.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — boundary shows fixed copy + remount-only reload (code), covered by error-boundary-state suite.
Notes: Prerequisite: human GUI crash + reload. Blocks RC confirmation only. Action: human forces crash, reloads, verifies safe UI + zero side-effect replay. Automated coverage (support only): error-boundary-state suite.

## AD. Packaging / Install / Uninstall (Stage 30)

AD-01 [P0]
Preconditions: release-candidate installer for current host.
Steps: 1. Install. 2. Launch. 3. Verify version footer.
Expected: installs; starts; `STARK v0.1.0` + tagline visible; stark://
protocol registered (OS prompt on first deep link acceptable).
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially observed — unpacked production build launches via bounded smoke (ready marker ok, schema v18); packaging metadata static-audit ok (appId com.stark.app, productName STARK, 0.1.0 semver, NSIS/DMG-ZIP/AppImage-DEB targets, stark:// protocol, files allowlist, ASAR unpack node-pty). No NSIS installer produced in this run; install/launch-from-installer + footer + OS protocol prompt unobserved.
Notes: Blocking prerequisite: electron-builder NSIS installer produced on the Windows release host + human install/launch. Blocks Windows-installer confirmation; macOS/Linux installers are separate platform blockers (need target hosts). Action: produce installer (no retries), human installs, launches, verifies footer + protocol. Automated coverage (support only): package-config suite. Known quirk: unpacked `electron ./out/...` launch shows the Electron version in the footer (no bundled package.json); packaged builds resolve real 0.1.0.

AD-02 [P1]
Preconditions: AD-01 installed.
Steps: 1. Uninstall via OS flow (keep data if asked).
Expected: application data preserved by default; no silent project
deletion.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires AD-01 human pass (manual).
Notes: Prerequisite: AD-01 human pass. Blocks installer confirmation only. Action: human uninstalls via OS flow, verifies userData/project preservation. Automated coverage: installer behavior documentation (manual).

AD-03 [P1]
Preconditions: installed package.
Steps: 1. Inspect bundle contents.
Expected: no `.env`, keys, dev databases, logs, or service-role
material inside.
Status: PASS
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Observed — `out/` holds main/preload/renderer bundles only (no .env/.db/.log files); package `files` allowlist ships out/** + package.json + node-pty with explicit !.env/!.db*/!.log/!coverage excludes; bundle scan finds only redaction-guard references to secret patterns (no embedded keys/tokens); package-config suite green.
Notes: Initial result PASS; unpacked-bundle layer. Installed-package re-verification rides with AD-01 human pass.

AD-04 [P2]
Preconditions: none.
Steps: 1. Confirm signing/notarization state.
Expected: unsigned dev/RC status recorded; production distribution
signing requirement documented.
Status: PASS
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Observed — package.json build sets no Windows certificate, no macOS identity/notarization; no build/resources/assets icon dirs and no *.ico/*.icns outside node_modules; unsigned RC + production-signing requirement recorded in readiness. No fake certificates created; no security bypassed.
Notes: Initial result PASS as a status-recording check. Production distribution signing remains a PUBLIC_RELEASE_BLOCKER (see readiness).

## AE. Offline Behavior (Stages 14, 29) — P0

AE-01 [P0]
Preconditions: signed in; provider key saved.
Steps: 1. Disconnect network. 2. Launch STARK. 3. Work locally.
Expected: full local use (Explorer/editing/sessions); account shows
signed-in or attention state; no retry loops; no data loss.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed — requires controlled disconnect + signed-in human GUI session (needs OAuth backend + real key).
Notes: Prerequisite: sign-in + saved key + network control + human session. Blocks RC confirmation only. Action: human disconnects, launches, works locally, verifies local function + no loops + no loss. Automated coverage (support only): startup-failure (recoverable-optional cloud/auth), no-polling architecture suites.

AE-02 [P0]
Preconditions: offline, signed out, no Supabase config.
Steps: 1. Launch. 2. Open Account section.
Expected: "unavailable in this build"; everything else functional.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Not observed in GUI — unavailable-state copy exists in account state (code), covered by unit suites (manual).
Notes: Prerequisite: offline human GUI session with unconfigured build. Blocks RC confirmation only. Action: human launches offline, verifies account copy + full local function. Automated coverage (support only): account-state/account-error suites.

## AF. Final Regression (all stages)

AF-01 [P0]
Preconditions: release candidate.
Steps: 1. Run `npm run release:check` (typecheck+lint+build+tests+
audits).
Expected: ALL CHECKS PASSED; no retries.
Status: PASS
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Observed — final `npm run release:check`: ALL CHECKS PASSED with no retries (typecheck + lint + build + 281 suites / 1824 tests / 0 failures + package-config audit + artifact/docs audit). Baseline run before acceptance was likewise green. During acceptance two release-gate defects were found and fixed (STAGE31-D01/D02: gate + completeness tests locked the pre-acceptance state); targeted reruns green before this final run. Defects: docs/STAGE31_DEFECTS.md (D01/D02, plus doc-comment D03/D04).
Notes: Initial baseline PASS; gate-conflict discovered mid-acceptance, fixed, retested PASS. No automatic retries anywhere (release:check fails fast; smoke single-launch 20s bound).

AF-02 [P1]
Preconditions: AF-01 green.
Steps: 1. Exercise each P1 workflow once end-to-end.
Expected: no `UNTESTED` item left unattempted; defects filed with
stage trace; fixes rerun affected suites.
Status: BLOCKED
Date: 2026-10-09
RC: STARK-v0.1.0-RC1+2870399 (pkg 0.1.0, schema v18, Windows x64, Node v22.23.2, Electron v44.6.0)
Evidence: Partially executed — automatable/security layers executed headless (DB upgrade/refusal, deep-link, preview guards, terminal validation, bundle/partition audits, smoke, full suites); 4 defects filed with trace and targeted reruns green (docs/STAGE31_DEFECTS.md); AF-01 final green. Human end-to-end P1 GUI pass unattempted (needs GUI session + provider key).
Notes: Prerequisite: human P1 end-to-end session on the RC. Blocks RC confirmation only. Action: human exercises each P1 workflow once, files defects for any failure. Matrix accountability: 76/76 accounted (6 PASS, 70 BLOCKED, 0 FAIL, 0 N/A, 0 UNTESTED).

(End of file — Stage 31 executed 2026-10-09 against STARK-v0.1.0-RC1+2870399; totals: 76 = 6 PASS + 70 BLOCKED + 0 FAIL + 0 NOT_APPLICABLE.)
