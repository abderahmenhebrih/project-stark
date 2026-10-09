# STARK v1 — Release Acceptance Matrix (Stage 31)

Authoritative human acceptance checklist for the STARK v1 release
candidate (schema v18, Stages 1–30). Prepared in Stage 30.

**Status: NOT EXECUTED.** Every check below begins UNTESTED. Do not mark
PASS without performing the exact steps on the release-candidate build.
Automated coverage notes never replace the manual confirmation.

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
Status: UNTESTED (Manual)

A-02 [P0]
Preconditions: A-01 state.
Steps: 1. Enter "Abdou". 2. Continue.
Expected: greeting "Hi Abdou…"; shell usable; restart skips onboarding.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

A-03 [P1]
Preconditions: signed-in shell.
Steps: 1. Open "STARK calls you". 2. Change name to "Amina". 3. Save.
4. Restart.
Expected: greeting uses "Amina"; no cloud sync; blank save rejected;
double-click Save saves once.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

A-04 [P1]
Preconditions: corrupt `stark.profile` value in DB.
Steps: 1. Launch.
Expected: safe fallback to onboarding; no crash; other settings intact.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## B. Workspace (Stages 2–5)

B-01 [P1]
Preconditions: no workspace selected.
Steps: 1. Observe empty state.
Expected: clear empty state with primary "Open Workspace" action; no
misleading disabled project data.
Status: UNTESTED (Manual)

B-02 [P1]
Preconditions: empty state.
Steps: 1. Open Workspace. 2. Pick a folder. 3. Restart.
Expected: folder persists as current; recent list updates (max 8).
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

B-03 [P0]
Preconditions: workspace selected.
Steps: 1. Delete/move the folder on disk. 2. Trigger workspace load.
Expected: safe "no longer available" copy; no crash; no invented paths.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## C. Explorer (Stage 6)

C-01 [P1]
Preconditions: workspace with nested dirs incl. `.git`, `node_modules`.
Steps: 1. Expand tree. 2. Open a small text file.
Expected: lazy listing, generated dirs hidden, preview ≤1 MiB, strict
decoding, symlinks never traversed.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

C-02 [P0]
Preconditions: workspace with binary file.
Steps: 1. Select binary.
Expected: refused preview with safe copy; no binary bytes rendered.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## D. Search (Stage 7)

D-01 [P1]
Preconditions: workspace selected.
Steps: 1. Type query (do not submit). 2. Press Enter.
Expected: nothing runs per keystroke; results only after explicit
submit; literal match; secret names skipped.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

D-02 [P1]
Preconditions: D-01 results.
Steps: 1. Click a result.
Expected: file opens read-only at line/column via existing preview.
Status: UNTESTED (Manual)

## E. Editor / Monaco (Stages 8, 10)

E-01 [P0]
Preconditions: text file open.
Steps: 1. Edit outside STARK. 2. Edit in STARK, Review, Save.
Expected: stale-write refusal ("changed on disk"); no force overwrite.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

E-02 [P1]
Preconditions: packaged build, offline.
Steps: 1. Open editor.
Expected: highlighting/undo/find work; no CDN request; no network needed.
Status: UNTESTED (Manual)

E-03 [P1]
Preconditions: mixed-line-ending file.
Steps: 1. Open file.
Expected: read-only with mixed-endings notice; never normalized.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## F. Change Transactions (Stage 9)

F-01 [P0]
Preconditions: file preview.
Steps: 1. Edit → Review change → Accept.
Expected: pending proposal created first (disk untouched); Accept
writes atomically; history shows applied.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

F-02 [P0]
Preconditions: pending transaction.
Steps: 1. Change file externally. 2. Accept. 3. Rollback attempt.
Expected: Accept conflicts safely; rollback of moved disk content
conflicts instead of overwriting.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

F-03 [P1]
Preconditions: applied transaction.
Steps: 1. Reject (expect refusal). 2. Rollback.
Expected: terminal states immutable except valid rollback; Reject of
applied refused.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## G. Change Sets (Stage 17)

G-01 [P1]
Preconditions: AI proposal with 2–5 whole files.
Steps: 1. Review group. 2. Accept one file.
Expected: grouped review, per-file Accept only; no Accept All; group
state derived.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## H. Human Terminal (Stage 11)

H-01 [P1]
Preconditions: workspace selected.
Steps: 1. Open terminal panel (collapsed). 2. Start. 3. Type `echo hi`.
4. Kill.
Expected: explicit Start only; output streams; Kill terminates with
"Terminal exited"; no auto-respawn.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

H-02 [P0]
Preconditions: terminal running.
Steps: 1. Switch workspace.
Expected: confirm dialog; decline stays; accept kills first, never
auto-starts in new project.
Status: UNTESTED (Manual)

H-03 [P0]
Preconditions: none.
Steps: 1. Confirm no agent/AI path can write to the terminal.
Expected: no `runCommand` API; AI panels offer no terminal action.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## I. Git (Stage 12)

I-01 [P1]
Preconditions: workspace is a repo root.
Steps: 1. Open GIT tab. 2. Refresh. 3. View diff.
Expected: branch/status/diff render; no fetch; no mutation; 5s bound.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

I-02 [P0]
Preconditions: workspace is a subfolder of a repo.
Steps: 1. Open GIT tab.
Expected: refusal ("open the repository root"); no nested scan.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## J. Sessions / Ask (Stages 13–15)

J-01 [P1]
Preconditions: workspace, no sessions.
Steps: 1. Observe panel.
Expected: "No coding sessions yet." + New session; no auto-creation.
Status: UNTESTED (Manual)

J-02 [P1]
Preconditions: session exists.
Steps: 1. Send message. 2. Load older.
Expected: message persists byte-exact; paging 100/page; title derived
from first message.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

J-03 [P0]
Preconditions: provider unconfigured.
Steps: 1. Send message.
Expected: clear setup guidance ("AI provider not connected"); no raw
SDK error; no network action.
Status: UNTESTED (Manual)

## K. Providers / Credentials (Stage 14) — P0

K-01 [P0]
Preconditions: clean provider state.
Steps: 1. Save OpenAI key. 2. Restart. 3. Test connection.
Expected: Configured; key never displayed; survives restart; insecure
platforms refuse with safe copy.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

K-02 [P0]
Preconditions: saved key.
Steps: 1. Inspect renderer APIs, logs, DB.
Expected: no plaintext key in renderer/SQLite/logs; ciphertext BLOB only.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

K-03 [P1]
Preconditions: saved key.
Steps: 1. Remove key.
Expected: Not configured; generation disabled with guidance.
Status: UNTESTED (Manual)

## L. Explicit Context (Stage 15)

L-01 [P1]
Preconditions: session + open file.
Steps: 1. Attach selection. 2. Inspect chip. 3. Remove chip. 4. Send.
Expected: visible removable chips; history shows sent items; stale
attachment fails send with reattach copy.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## M. Propose (Stage 16)

M-01 [P0]
Preconditions: one whole-file attachment.
Steps: 1. Propose change. 2. Review. 3. Accept.
Expected: one pending transaction (disk unchanged until Accept);
identical content yields "no code changes" with no transaction.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## N. Brain (Stage 18)

N-01 [P1]
Preconditions: provider + model configured.
Steps: 1. Run Work (answer path). 2. Run Work (delegate path).
Expected: ≤3 provider calls; plan + result details persist; retry
starts a new run without duplicating the message.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## O. Heart (Stage 19)

O-01 [P1]
Preconditions: Heart configured Fixed + Auto-Swap.
Steps: 1. Save config. 2. Run Work. 3. Inspect run audit.
Expected: routing resolves locally; per-step provider/model audit;
legacy selection untouched.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## P. Looplink (Stage 20)

P-01 [P1]
Preconditions: session with history.
Steps: 1. Continue with Looplink. 2. Send Ask in target.
Expected: new "Continue: …" session; handoff consumed once;
historical files not proposal-eligible until reattached.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## Q. Recovery (Stages 20–21)

Q-01 [P0]
Preconditions: recovery `auto_once` with assignments; provider
rate-limiting (or simulated 429).
Steps: 1. Send Ask.
Expected: exactly one handoff + one recovery attempt, then STOP; no
chains; source run stays failed.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Q-02 [P1]
Preconditions: recovery `handoff`.
Steps: 1. Trigger recoverable failure. 2. Dismiss recovery.
Expected: "Recovery ready" target, no provider call; dismiss keeps session.
Status: UNTESTED (Manual)

## R. Agent Permissions (Stage 22)

R-01 [P0]
Preconditions: fresh workspace.
Steps: 1. Open Agent Permissions.
Expected: master Disabled; all Deny; saving `terminal.execute=allow`
rejected.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

R-02 [P1]
Preconditions: R-01.
Steps: 1. Enable master, set modes, Save. 2. Disable, re-enable.
Expected: complete-replacement save; modes preserved across disable.
Status: UNTESTED (Manual)

## S. Worker Read/Search/Git Tools (Stage 23)

S-01 [P0]
Preconditions: `workspace.read=Ask`, Work request needing a file.
Steps: 1. Run Work. 2. Approve exact read.
Expected: run parks (`waiting_for_approval`, no polling); approval
covers one exact invocation; resume continues.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

S-02 [P0]
Preconditions: S-01 pending.
Steps: 1. Tamper approval args (if possible). 2. Deny instead.
Expected: tamper fails safely; denial resumes Worker with denied
result (run may still succeed).
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## T. Worker change.propose (Stage 24)

T-01 [P0]
Preconditions: `change.propose=Ask`, prior successful `workspace_read`
in same run.
Steps: 1. Worker proposes. 2. Approve exact proposal.
Expected: reviewable pending proposal only; unknown `R99`/cross-run
refs rejected; disk unchanged.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## U. Worker terminal_execute (Stage 25)

U-01 [P0]
Preconditions: `terminal.execute=Ask`.
Steps: 1. Worker requests exact command. 2. Approve.
Expected: one bounded non-interactive run (60s, 64 KiB cap); argv
execution (no shell string); nonzero exit reported, no retry.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

U-02 [P0]
Preconditions: U-01 approved and running.
Steps: 1. Kill app mid-command. 2. Relaunch.
Expected: execution marked interrupted; no re-execution; parked run
fails with safe copy; approval stays consumed.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## V. Managed Runtime (Stage 26)

V-01 [P0]
Preconditions: workspace; `terminal.execute=Ask`.
Steps: 1. Start Work. 2. Worker requests runtime_start. 3. Approve exact command.
Expected: one runtime starts; Preview URL derived by main; Worker
continues; runtime remains after Work completion.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

V-02 [P0]
Preconditions: V-01 running.
Steps: 1. Start second runtime. 2. Stop runtime. 3. Quit app.
Expected: second start refused (one active); Stop terminates exact
tree; quit persists final state with bounded cleanup.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

V-03 [P0]
Preconditions: running runtime with Preview open.
Steps: 1. Navigate Preview to external site (if possible).
Expected: off-origin navigation blocked; popups denied; no preload in
Preview; permissions denied.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## W. Runtime Observation (Stage 27a)

W-01 [P1]
Preconditions: active runtime; `runtime.observe=Ask`.
Steps: 1. Worker observes (approve). 2. Inspect output.
Expected: bounded normalized observation (≤64 KiB, no PID/paths/env);
second observe is a fresh explicit read.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## X. Preview Inspection (Stage 27b)

X-01 [P0]
Preconditions: active runtime; Preview open; `preview.inspect=Ask`.
Steps: 1. Worker inspects (approve).
Expected: bounded textual snapshot (no input values/cookies/scripts);
hidden inspector destroyed immediately; runtime untouched.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## Y. Usage / Threshold Routing (Stage 28)

Y-01 [P1]
Preconditions: usage panel.
Steps: 1. Load summary. 2. Save a threshold + alternate. 3. Run Work.
Expected: 24h local summary; explicit save only; frozen per-run
snapshot with decision audit; Ask/Propose untracked-for-routing.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Y-02 [P0]
Preconditions: Y-01 alternate configured.
Steps: 1. Verify alternate differs from Heart route (save identical).
Expected: identical alternate rejected; at most one alternate/route.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## Z. Account / OAuth (Stage 29) — P0

Z-01 [P0]
Preconditions: signed out; Supabase configured.
Steps: 1. Click Continue with Google.
Expected: system browser opens ONCE; STARK stays usable; signing-in
state with Cancel.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Z-02 [P0]
Preconditions: Z-01 browser flow.
Steps: 1. Authenticate. 2. Return via deep link.
Expected: signed-in Google identity; NO project upload; local profile
greeting unchanged.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Z-03 [P0]
Preconditions: Z-02.
Steps: 1. Inspect renderer APIs, SQLite, logs.
Expected: no access/refresh token, code, or verifier in renderer/DB
plaintext/logs; encrypted BLOB only.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Z-04 [P0]
Preconditions: signing-in active.
Steps: 1. Cancel. 2. Complete browser flow anyway.
Expected: no authentication from the late callback.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Z-05 [P1]
Preconditions: GitHub account.
Steps: 1. Sign out. 2. Continue with GitHub.
Expected: same flow as Google; must sign out before switching.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Z-06 [P0]
Preconditions: signed in.
Steps: 1. Close STARK. 2. Reopen (online).
Expected: account restores securely; no new browser opens.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Z-07 [P0]
Preconditions: signed in.
Steps: 1. Sign out.
Expected: identity/session gone; Workspaces, sessions, API keys,
local profile all intact.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

Z-08 [P0]
Preconditions: any.
Steps: 1. Feed malformed `stark://` URLs (wrong host/path/scheme,
fragment, oversized).
Expected: all rejected; no exchange; no crash.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## AA. Persistence / Restart (Stages 1–29) — P0

AA-01 [P0]
Preconditions: populated app (workspace, session, pending proposal,
provider key, Heart config, signed in).
Steps: 1. Quit. 2. Relaunch.
Expected: everything restores; no auto-send/AI/resume; account
restores without browser.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AA-02 [P0]
Preconditions: v17 database copy.
Steps: 1. Launch new build.
Expected: upgrade to v18; rows preserved; no destructive reset.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AA-03 [P0]
Preconditions: DB with user_version 99.
Steps: 1. Launch.
Expected: safe "newer version of STARK" failure; no backwards
migration; no writable open.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AA-04 [P0]
Preconditions: corrupt (non-SQLite) stark.db.
Steps: 1. Launch.
Expected: single safe "STARK could not start." dialog + Quit; file
left untouched; no relaunch loop.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## AB. Crash / Interrupted States (Stages 18–28) — P0

AB-01 [P0]
Preconditions: running Work orchestration.
Steps: 1. Kill process mid-run. 2. Relaunch.
Expected: run marked interrupted/failed; Looplink pending preserved;
no resume, no duplicate message.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AB-02 [P0]
Preconditions: approved Worker command running.
Steps: 1. Kill process. 2. Relaunch.
Expected: execution interrupted; no re-execution; no PID kills.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AB-03 [P0]
Preconditions: starting/running managed runtime.
Steps: 1. Kill process. 2. Relaunch.
Expected: session interrupted; no relaunch; no auto-restart.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## AC. Security (all stages) — P0

AC-01 [P0]
Preconditions: packaged or dev build.
Steps: 1. Open DevTools → inspect `window.stark`.
Expected: fixed per-domain functions only; no generic invoke/fs/
process/eval/URL-open/Supabase surface.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AC-02 [P0]
Preconditions: any file/image from untrusted source in Workspace.
Steps: 1. Preview/search/probe it.
Expected: hostile strings render inert; no HTML/JS execution anywhere.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AC-03 [P0]
Preconditions: renderer crash (e.g. forced via DevTools).
Steps: 1. Observe fallback. 2. Reload interface.
Expected: "STARK encountered a display error." + Reload; no runtime
restart, AI resend, or approval replay.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

## AD. Packaging / Install / Uninstall (Stage 30)

AD-01 [P0]
Preconditions: release-candidate installer for current host.
Steps: 1. Install. 2. Launch. 3. Verify version footer.
Expected: installs; starts; `STARK v0.1.0` + tagline visible; stark://
protocol registered (OS prompt on first deep link acceptable).
Status: UNTESTED (Manual)

AD-02 [P1]
Preconditions: AD-01 installed.
Steps: 1. Uninstall via OS flow (keep data if asked).
Expected: application data preserved by default; no silent project
deletion.
Status: UNTESTED (Manual)

AD-03 [P1]
Preconditions: installed package.
Steps: 1. Inspect bundle contents.
Expected: no `.env`, keys, dev databases, logs, or service-role
material inside.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AD-04 [P2]
Preconditions: none.
Steps: 1. Confirm signing/notarization state.
Expected: unsigned dev/RC status recorded; production distribution
signing requirement documented.
Status: UNTESTED (Manual)

## AE. Offline Behavior (Stages 14, 29) — P0

AE-01 [P0]
Preconditions: signed in; provider key saved.
Steps: 1. Disconnect network. 2. Launch STARK. 3. Work locally.
Expected: full local use (Explorer/editing/sessions); account shows
signed-in or attention state; no retry loops; no data loss.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AE-02 [P0]
Preconditions: offline, signed out, no Supabase config.
Steps: 1. Launch. 2. Open Account section.
Expected: "unavailable in this build"; everything else functional.
Status: UNTESTED (Manual)

## AF. Final Regression (all stages)

AF-01 [P0]
Preconditions: release candidate.
Steps: 1. Run `npm run release:check` (typecheck+lint+build+tests+
audits).
Expected: ALL CHECKS PASSED; no retries.
Status: UNTESTED (Manual; automated coverage exists, manual confirmation required)

AF-02 [P1]
Preconditions: AF-01 green.
Steps: 1. Exercise each P1 workflow once end-to-end.
Expected: no `UNTESTED` item left unattempted; defects filed with
stage trace; fixes rerun affected suites.
Status: UNTESTED (Manual)
