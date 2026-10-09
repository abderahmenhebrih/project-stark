# STARK

**Your model stopped. Your work didn’t.**

STARK is an AI-first desktop vibe-coding application that lets users work
continuously across AI models and sessions — without manually switching
models, copying prompts, or losing coding context. It targets both
nontechnical users and developers on Windows, macOS, and Linux.

> **Current stage: explicit bounded project context (Stage 15).** This repository contains
> the Electron + React + TypeScript application with local SQLite
> persistence and the Settings, local-profile, Workspace, Explorer,
> Search, single-file Editing, Change Transaction, Monaco Editor,
> human-only Terminal, read-only Git, persistent local coding-session,
> OpenAI provider, and explicit project-context domains. The provider
> receives only user-attached context plus session text — no tools,
> no agents, no automatic ingestion. Brain/Heart orchestration, model
> routing, authentication, Supabase sync, and the duo-agent workflow are
> **not implemented yet**. Nothing below claims otherwise.

## Stack

- Electron (main process + secure preload bridge)
- React 19 + TypeScript (strict) renderer
- Vite via electron-vite (dev server + bundling)
- electron-builder (desktop packaging)
- ESLint (flat config: TypeScript, React, Node)

## Prerequisites

- Node.js 22 LTS or newer
- npm 10 or newer

## Installation

```bash
npm install
```

## Development

Launch the renderer dev server and Electron together:

```bash
npm run dev
```

## Build

Production renderer + main/preload bundles (output in `out/`):

```bash
npm run build
```

Run the built app locally:

```bash
npm start
```

Create distributable packages (output in `dist/`):

```bash
npm run dist
```

## Typecheck

```bash
npm run typecheck
```

Runs `tsc --noEmit` separately for the Node layer
(`tsconfig.node.json`: main + preload + shared) and the renderer layer
(`tsconfig.web.json`: renderer + shared).

## Lint

```bash
npm run lint
```

Auto-fix:

```bash
npm run lint:fix
```

## Architecture

```text
src/
  main/            Electron main process (Node.js only)
    index.ts       App lifecycle, window management, platform quit behavior
    windows/       BrowserWindow factory (app-window.ts)
    ipc/           IPC handler registration (sender-validated via handleSecureIpc)
    services/      Main-process services (app-info.ts)
    security/      Pure URL/CSP checks + session wiring (csp, external-url, session, app-urls)
  preload/         Secure context bridge (exposes typed `window.stark` only)
    index.ts
  renderer/        React application (no Node.js access)
    index.html     Renderer entry
    src/
      app/         App root composition
      layouts/     Shell chrome (MainLayout)
      pages/       Page components (HomePage)
      features/    Feature modules (system-status/ — pattern for future work)
      components/  Reusable UI (StatusIndicator)
      hooks/       Shared React hooks (useAppInfo)
      lib/         Renderer utilities (stark-api bridge accessor)
      styles/      Design tokens (tokens.css) + global styles (global.css)
      types/       Renderer ambient type declarations (window.stark)
  shared/          Plain TS for all processes (no Node/DOM APIs)
    types/         AppInfo, StarkApi, SystemStatus
    constants/     App name, tagline, IPC channel names
```

Security defaults: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, with the preload bridge bundled as a single CommonJS file
(the only module shape sandboxed preloads can load). The renderer never
touches Node or Electron directly; the single read-only
`stark:get-app-info` channel proves the bridge wiring that future features
will reuse. IPC handlers additionally validate the sender origin/document,
responses carry an environment-specific Content-Security-Policy (restrictive
in production, narrowly relaxed for Vite/HMR in development), only http(s)
links reach the OS browser, and the main frame cannot navigate away from
the application.

Future modules (sessions, providers, models, agents, routing,
chat/history, terminal integration, auth, cloud sync)
plug into `main/services/`, `main/ipc/`, `renderer/features/`, and
`shared/` without restructuring. Persistence for those modules goes
through `main/database/` repositories — never raw SQL from features.

## Local persistence

STARK uses the SQLite implementation built into the Node.js runtime
(`node:sqlite`, `DatabaseSync`). No database dependency is installed.
SQLite lives in the Electron main process only — the renderer, preload,
and `window.stark` have no database access and no generic SQL IPC exists.

- Location: `app.getPath('userData')` — `stark-dev.db` in development,
  `stark.db` in packaged production. Never in the repository tree. (Note:
  the userData *root* follows standard Electron app-identity resolution,
  so the dev server and a raw `electron ./out/...` launch may use
  different roots; the dev/prod *filename* split above always applies.)
- Migrations: ordered, validated, transactional, tracked with
  `PRAGMA user_version`. Current schema version: **17**.
- Tables: `key_value(key TEXT PRIMARY KEY, value TEXT (JSON), updated_at INTEGER)`,
  `workspaces(id, root_path UNIQUE, display_name, created_at, last_opened_at)`
  plus a recency index, `change_transactions` + `change_transaction_files`,
  `coding_sessions` + `coding_messages` (workspace/session cascades, recency
  and paging indexes), `ai_provider_configs` + `ai_provider_credentials`
  (ciphertext BLOB only, config cascade), `message_context_items`,
  `change_sets` + `change_set_items` (grouped-review linkage, cascades),
  `worker_tool_approvals` + `worker_tool_events` + `worker_tool_run_state`
  (exact approvals, immutable audit, bounded resume state),
  `worker_command_executions` (at-most-once bounded command runs, UNIQUE approval),
  `project_runtime_sessions` (at-most-once managed runtimes, UNIQUE approval, one active per Workspace).
- Pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`,
  `busy_timeout = 5000`.
- Tests: `npm test` (Node built-in runner, real SQLite, isolated
  `:memory:`/temp databases).

## Settings domain

STARK's reference domain flow: React → `window.stark.settings` → sandboxed
preload → sender-validated IPC → `SettingsService` → `KeyValueRepository`
→ SQLite. The renderer uses only the typed domain API (`get` / `update` /
`reset`); the persistence key (`stark.settings`) and all SQL stay in the
main process. Updates accept known fields only and are runtime-validated;
failures map to renderer-safe errors with no database internals.

- Fields: `appearance` (`'dark'` default; `'system'` reserved), `reduceMotion`
  (`false`), `confirmBeforeDestructiveActions` (`true`).
- No Settings UI exists yet — this stage is architecture, not interface.

## Local profile

First launch asks "How should I call you?" and persists the display name
locally through the profile domain (`window.stark.profile` → validated IPC
→ `ProfileService` → SQLite `stark.profile` key). The main shell then
greets `Hi {name}, I’m STARK. What are we building today?` Returning
launches skip onboarding. This is a local preference, not an account —
no authentication exists yet.

## Workspace domain

After onboarding, the shell offers "Open project folder", which opens the
OS native directory picker (main process only). The validated directory is
persisted as a Workspace (`window.stark.workspace` → validated IPC →
`WorkspaceService` → SQLite `workspaces` table) and restored as current on
restart; recent workspaces (max 8, newest first) reopen by ID. The renderer
never handles raw paths, `dialog`, or filesystem APIs — new paths enter
only through the picker, stored IDs resolve in the main process. No file
tree, scanning, editor, terminal, or Git yet.

## Workspace Explorer

Once a workspace is active, the shell shows a lazy Explorer:
per-directory listings (directories first, then files, then symlinks/other,
alphabetical; generated folders like `.git`/`node_modules`/`dist` hidden)
plus read-only preview of small UTF-8 text files (1 MiB limit, strict
decoding, no binary). Everything stays workspace-scoped — requests carry a
persisted workspace ID plus a relative path, resolved and contained in the
main process (symlinks never traversed, `..`/absolute paths rejected).
Schema stays v2; nothing is written, watched, or scanned recursively, and
no file content leaves the machine (no AI ingestion yet).

## Workspace Search

When a workspace is active, the Explorer offers a Search tab: explicit
submit only (Enter/button, never per keystroke), literal text matching
(case-insensitive by default, optional case-sensitive), on demand with no
persistent index. The main process traverses only beneath the persisted
root (same generated-directory exclusions as Explorer, symlinks never
followed, secret-bearing names like `.env`/`.env.*`/`*.pem`/`*.key`/
`credentials.json` skipped automatically but still manual-previewable),
reading safe UTF-8 files only (1 MiB each, 32 MiB total, 2000 files,
200 results, 20 per file, 5 seconds — truncated:true on budget).
Clicking a result reuses the existing safe file preview (with Line
metadata); search remains local with no AI consumption yet.

## Workspace File Editing

Supported text-file previews expose an **Edit** action backed by a
minimal temporary textarea editor — no Monaco/CodeMirror, no autosave,
no formatting. The flow is explicit: read-only preview → Edit →
modify → Preview changes (plain-text Before | After) → Save changes
(or Cancel, which never touches disk).

Every read carries a **SHA-256 revision** (64 lowercase hex chars over
the exact file bytes, so LF vs CRLF and Unicode variants differ), and
every save echoes that revision back. The main process re-resolves the
workspace, re-checks the target (regular file only, symlinks refused),
and compares the current on-disk revision immediately before mutation —
plus once more right before replacement. A mismatch refuses the write
with "This file changed on disk. Reload it before saving your changes.";
there is no force overwrite and no merge. Identical content returns
`changed: false` without touching the file.

Replacement is **atomic**: new bytes go to a private `.stark-tmp-*`
file created exclusively in the same directory, synced, given the
original mode bits where supported (POSIX executable bits preserved;
Windows ACLs are not cloned), then renamed over the target. The temp
file is removed on every failure path. New content is capped at
**1 MiB** UTF-8, must be NUL-free with well-formed UTF-16, and is
stored byte-for-byte (indentation, CRLF, final newline preserved).

Editing covers **existing files only** — no create, delete, rename,
move, copy, or Save As. Unsaved drafts never vanish silently: file
selection, search-result selection, and workspace switching all share
one discard confirmation, and declining keeps the current file and
workspace. Schema stays **v2** (no draft/revision tables).

## Change Transactions

Editing a file no longer writes disk directly. Instead, **Review
change** persists a **pending change transaction**: the exact current
bytes (checkpoint) plus the exact proposed bytes, each with its SHA-256
revision, stored as SQLite BLOBs. The project file is untouched until
an explicit **Accept**, which re-validates staleness through the Stage
8 writer and records the applied revision — or an explicit **Reject**,
which never writes anything.

Lifecycle: `pending → applied → rolled_back`, or `pending →
rejected`; terminal states never transition (enforced in the service
and atomically in SQL). **Rollback** restores the exact checkpoint but
only when the disk still carries what STARK applied — an external
change after apply turns rollback into a conflict instead of an
overwrite, and the transaction stays `applied`. Stored bytes are
hash-verified on every load; corruption blocks apply/rollback without
exposing bytes.

Pending proposals survive application restart (SQLite), appear in the
per-workspace **Changes** history (up to 20, newest first), and never
auto-apply — only an explicit Accept changes disk. One file per
transaction in this stage; the schema already supports more. Schema is
**v3** (`change_transactions`, `change_transaction_files`, plus
`key_value` and `workspaces`). No AI creates or accepts transactions
yet.

## Code Editor

STARK edits code in a locally bundled **Monaco Editor** — no CDN, no
remote origins. The editor chunk and all language workers (editor,
JSON, CSS, HTML, TypeScript) ship inside STARK's own assets and load
as same-origin workers, so the production CSP keeps `script-src
'self'` with no `unsafe-eval` and no new script sources.

One file is editable at a time (no tabs, no splits): the selected
Explorer/Search file becomes the active document under a synthetic
`inmemory://stark-workspace/…` model URI (no host paths), with
syntax highlighting from the file extension, line numbers, bracket
matching, built-in find, and local undo/redo under the custom
`stark-obsidian` theme. Clicking a Search result opens the file
read-only and reveals its line/column. Models are disposed on file,
transaction, and workspace switches.

Editing still creates Stage 9 proposals — **Review change** is the
only dirty-editor action (no Save wording, no direct disk writes) —
and transaction review renders in a read-only Monaco **DiffEditor**
(checkpoint vs proposal) with Accept/Reject/Rollback as STARK
controls around it.

Line endings are preserved exactly: uniform LF and uniform CRLF files
edit with the model EOL pinned to match, so Accept round-trips
bytes. Files with mixed or lone-CR endings open read-only with
"This file uses mixed line endings. Editing is disabled to avoid
changing its formatting." — never silently normalized. No language
servers, formatters, or Git yet.

## Human terminal

STARK's first interactive terminal is **human-controlled only** — no
agent or AI may use it in this stage, and no `runCommand` /
`executeCommand` API exists. The renderer shows a locally bundled
**xterm.js** panel (with FitAddon, bounded 5000-line scrollback, no
CDN) collapsed beneath the editor; only an explicit **Start** creates
a PTY. Input flows as keystrokes through four narrow IPC channels
(`stark:terminal:create/write/resize/kill`) plus two fixed main→renderer
events (`stark:terminal:data/exit`); output streams in bounded 64 KiB
chunks with no main-process history buffer.

One active session per window: starting again returns the running
session, killing terminates it (graceful PTY kill, exit event once,
"Terminal exited", no auto-respawn), and closing the window or quitting
the app terminates sessions with bounded cleanup. The main process
chooses the shell (`powershell.exe -NoLogo` on Windows, `/bin/zsh` on
macOS, `/bin/bash` on Linux with `/bin/sh` fallback) — the renderer
never sends executables, cwd, or environment. The startup cwd is the
trusted persisted Workspace root (live-validated; a missing folder
fails with "That project folder is no longer available." — never HOME).
Switching projects while a terminal runs asks "Close the active
terminal and switch projects?"; declining stays, accepting kills the
session first and never auto-starts one in the new project.

Security reality: shell processes run with STARK's OS-user privileges
— Stage 11 claims **no OS sandboxing** and no Workspace containment
after a manual `cd ..`. Protection is explicit human start, no agent
access, no renderer-chosen executable/cwd/env, strict per-window
session ownership, narrow IPC, and bounded lifecycle handling.
`node-pty` (N-API prebuilds, no rebuild needed for the current
Electron) is externalized from bundling and shipped unpacked from ASAR
by electron-builder. Schema stays **v3**: no terminal tables, no
command history, no output persistence.

## Read-only Git integration

STARK understands the Git state of the current Workspace — it never
mutates it. The sidebar offers a **GIT** tab (Explorer / Search /
Changes / Git) backed by the OS `git` executable (never bundled,
downloaded, or installed; no simple-git/isomorphic-git/libgit2).
The renderer chooses only two fixed operations
(`stark:git:get-status`, `stark:git:get-diff` via
`window.stark.git`); all command arguments are built in the main
process and run with `shell: false`, argument arrays, the trusted
persisted Workspace root as cwd, ignored stdin, and a
non-interactive environment (`GIT_TERMINAL_PROMPT=0`,
`GIT_PAGER=cat`, `PAGER=cat`, `GIT_OPTIONAL_LOCKS=0`).

- Requirement: the repository root must equal the selected Workspace
  root (`git rev-parse --show-toplevel`, canonicalized and compared
  platform-correctly). A subfolder inside a parent repo is refused
  with "This folder is inside a Git repository. Open the repository
  root as the workspace to use Git integration." Bare repositories
  are unsupported. Nested repos are never scanned.
- Awareness: branch / detached HEAD (`rev-parse --short=12`) /
  unborn, upstream (`@{upstream}`) where present, and ahead/behind
  (`rev-list --left-right --count`, local refs only — no fetch).
- Status: `git status --porcelain=v1 -z --untracked-files=normal`
  (NUL-separated, space/Unicode-safe), grouped as Conflicts /
  Staged / Changes / Untracked. A file may appear under both Staged
  and Changes; conflicts (`DD AU UD UA DU AA UU`) group separately
  with no resolution UI.
- Diffs: fixed `git diff [--cached] --no-ext-diff --no-textconv
  --no-color --unified=3 -- <validated path>` (2 MiB cap, controlled
  too-large outcome). External diff drivers and textconv filters are
  never executed. Untracked files have no Git diff — the panel offers
  Open file instead, reusing the existing Stage 6/10 file read and
  Monaco editor (no second read path).
- No background polling: status is fetched when the Git tab first
  opens, on Refresh (exactly one request), and when the Workspace
  changes and the tab later activates. Every Git invocation is
  bounded to 5 seconds, single attempt, no retries. No network
  operations, no credentials, no hooks triggered, no pager.
- The human terminal remains available for manual Git commands.
  Schema is **v4** (sessions/messages tables added; still no Git
  tables, no cached status/diffs, no stored credentials).

## Persistent coding sessions

STARK keeps workspace-scoped coding sessions in local SQLite — the
conversation substrate future provider/Brain stages will build on.
No AI is connected: the panel states "Local session — AI provider
not connected yet.", user messages persist with one send per action,
and no assistant reply is fabricated.

- Model: `coding_sessions(id, workspace_id → workspaces, title,
  created_at, updated_at)` plus `coding_messages(id, session_id →
  coding_sessions, role CHECK ('user','assistant'), content,
  created_at)`, both cascading, both indexed for the two hot reads
  (recent sessions per workspace; message pages per session). Schema
  is **v4** (`004-coding-sessions.ts`, append-only; migrations
  001–003 untouched).
- Explicit lifecycle only: no auto-creation on startup, workspace
  selection, file open, or panel open. Empty workspaces show "No
  coding sessions yet." plus New session. Creation takes a
  workspaceId and starts titled "New session".
- Deterministic local titles: the first valid user message on an
  untitled session derives the title (trimmed, whitespace-collapsed,
  first 80 code points plus ellipsis when truncated). No model call.
- Messages are append-only user rows (role forced to `'user'` in
  main; no renderer path can choose a role, and no edit/delete/
  regenerate/streaming exists). Content persists byte-exact: no
  trimming, no line-ending or Unicode normalization. Validation caps
  at 64 KiB UTF-8 and rejects empty/whitespace-only, NUL, unpaired
  surrogates, and stray control characters; tabs/newlines/CR and
  normal Unicode pass through.
- Bounded reads: up to 50 recent sessions (updatedAt DESC, id
  tiebreak), message pages of 100 (latest page, then older pages
  before the oldest loaded id, with a `hasMore` probe — never the
  whole history). Workspace isolation is enforced per call in main:
  a session from Workspace A is unreachable under Workspace B.
- UI: RIGHT "STARK Session" panel (360 px, collapsible to a rail
  toggle, own internal scroll, composer pinned at bottom) beside the
  LEFT sidebar and CENTER editor/terminal. Compact history dropdown,
  YOU/STARK role labels, subtle timestamps, plain-text pre-wrapped
  messages (no Markdown package), textarea composer with Enter to
  send / Shift+Enter newline / IME-composition guard, visible Send
  with single-flight disabled states, Load older messages on demand,
  and safe error copy only. No open file, search, Git, or terminal
  content is ever attached to messages; zero network calls.

## AI provider foundation (OpenAI)

STARK talks to exactly one language-model provider — OpenAI — through
a provider-neutral architecture (explicit `ProviderRegistry`, one
  registered adapter) so future adapters slot in without changing
  Session/UI/storage foundations. The provider reads bounded Session
  conversation text plus the trailing message's explicit user-attached
  context, and appends one real assistant reply. No
  Brain/Heart, no agents, no tools, no automatic ingestion, no routing.

- Official `openai` SDK (main process only), Responses API with
  `store: false`, up to 4096 output tokens, non-streaming. No
  provider Conversations, no response/conversation IDs persisted —
  local SQLite Sessions stay the canonical store. `maxRetries: 0`
  with bounded timeouts (15 s model/test, 60 s generation); one
  attempt, no automatic retries. No tools of any kind in requests.
- Credentials: `ai_provider_credentials` holds ONLY safeStorage
  ciphertext (BLOB); the plaintext key never touches SQLite,
  `key_value`, logs, or the renderer. Async safeStorage API
  (`isAsyncEncryptionAvailable` / `encryptStringAsync` /
  `decryptStringAsync`) behind a `CredentialProtector` seam (fakes in
  tests, never Electron in unit suites). Fail-closed everywhere:
  unavailable storage, pre-`whenReady` calls, and Linux `basic_text`
  backends all refuse persistence — `setUsePlainTextEncryption(true)`
  is never called. Key rotation (`shouldReEncrypt`) re-encrypts
  silently. Secrets are decrypted immediately before a call and
  references dropped after (strings can't be zeroed — documented;
  temp buffers are).
- Platform notes: Windows uses DPAPI (per-OS-user protection, not a
  defense against same-user malware; no hardware-vault claims).
  macOS Keychain reliability needs a consistently code-signed
  packaged app — unsigned dev builds are not weakened to
  accommodate. Linux persists only on a real keyring backend.
- Config: `ai_provider_configs(provider_id, selected_model, …)` —
  exactly one selected model for OpenAI, set from discovered IDs
  (syntactically validated, 1–128 safe identifier chars; no URLs).
  No per-session models, no routing, no custom endpoints (renderer
  can never supply a base URL — SSRF/credential-exfiltration
  boundary stays closed).
- Discovery/testing: explicit Refresh models / Test connection only
  (≤15 s, ≤500 IDs, deterministic sort, no polling). Connection test
  is a non-billable Models call returning connected /
  invalid-credential / rate-limited / network-error / timeout, and a
  successful test reuses its single response for the model list.
  The Models API lists accessible IDs — not a Responses-capability
  guarantee; failures map safely. No brittle key-prefix or
  model-prefix assumptions.
- Generation: `AiCompletionService` validates workspace/session
  ownership, requires a configured credential + model, requires the
  trailing message to be the user's (else "no new message"), enforces
  one in-flight generation per session, sends at most the newest 40
  messages / 256 KiB (oldest dropped first) plus the trailing
  message's explicit context block plus one fixed
  main-owned instruction disclaiming file/terminal/Git/web/tool
  access. Assistant text is validated to the 64 KiB message
  discipline and appended atomically with the session timestamp (no
  retitle) through a main-only path — no `sendAssistantMessage` for
  the renderer. Failures keep the user message with an explicit
  Retry response (no resend, no auto-retry); restarts with a trailing
  user message offer Retry without auto-generating.
- UI: compact AI Settings inside the Session panel (password input
  cleared after save, reveal shows only the unsaved typed value,
  Configured/Not configured, Remove key, Test connection, Refresh
  models, model select + Use model). Notices switch from "Local
  session — AI provider not connected yet." to "OpenAI · \<model\>".
  Composer sends the user message then shows "STARK is thinking…"
  until the real reply (plain text, same inert surface) lands.
- Logging: production logs never include prompts, history,
  responses, keys, headers, or provider bodies — only provider id,
  operation, safe category, and duration. Schema is **v13** (Worker
  tool approval/event/state tables added; provider tables unchanged).

## Explicit bounded project context

STARK sends the AI only what the user explicitly attaches — never
whole-project scans, indexes, embeddings, watchers, summaries, open
files, search lists, terminal output, or Git diffs by default. Every
attachment is a visible removable chip with inspectable content
before send, and history shows exactly which items traveled.

- Sources (all explicit buttons): open-file text selection ("Attach
  selection", read-only preview only), whole open file ("Attach
  file"), one search-result excerpt ("Attach" per result, ±3-line
  window), any Explorer text file ("Attach" per row), and manual
  notes ("Add note"). Nothing attaches on open, edit, save, review,
  search, or result click.
- Model: `message_context_items(message_id → coding_messages
  CASCADE, kind CHECK, label, relative_path?, line_start/end?,
  content, content_bytes, created_at)` with a per-message index.
  Schema is **v7** (`006-message-context.ts`, append-only; v7 adds
  change sets).
- Bounds (centralized, UTF-8 measured): 20 items/message, 32 KiB per
  item, 200 KiB total, 16 KiB manual notes, 120-codepoint labels. No
  silent truncation — over-limit attachments fail with safe UI copy.
  Stage 6 text rules reused (binary/oversized rejected); symlinks and
  traversal rejected by the existing path authority.
- Security: renderer sends only workspaceId + relativePath + line
  range; main resolves through the trusted path flow, reads via the
  Stage 6 text reader, and builds drafts. At send, file items are
  re-read from disk (fresh snapshot wins; vanished files fail the
  send), so renderer content is preview-only and never trusted. Only
  manual-note text originates from the renderer (message-grade
  validation). No absolute paths, no invented file contents, no
  hidden provider-side injection.
- Provider payload: deterministic `[CONTEXT n]` blocks (Type, Path +
  Lines or Label, Content) ahead of the user message — only the
  trailing message's sent items, never anything else. Persisted rows
  (not request envelopes) back the history view.
- Atomicity: message + context rows + session touch land in one
  SQLite transaction. Assistant messages carry no context.
- UI: "Attached context" section above the composer (empty-state
  copy included), per-item Preview/Remove buttons, note form, and
  read-only history chips under their message — all real buttons and
  plain-text `<pre>` previews, keyboard/touch accessible.
- Revision pinning: every file-backed draft carries the SHA-256 of
  the exact bytes previewed. Send re-reads and compares; a mismatch
  fails the whole send with "This attached context changed on disk.
  Reattach it before sending." — never silent substitution, never
  partial persist, never a provider call on stale source.

## AI-proposed single-file changes

The composer has two modes — **Ask** (default, unchanged Stage 14
behavior) and **Propose change**. Propose change turns the trailing
user message's exactly-one whole-file attachment into a pending
Stage 9 Change Transaction via one structured provider call. The AI
never writes disk; only a human Accept reaches the Stage 8 writer.

- Scope: one existing text file per proposal, attached as whole-file
  context to the latest user message (manual notes may accompany).
  Excerpt-only, search-only, multi-file, creation, deletion, rename,
  patch chains, tools, terminal, and Git are out of scope.
- Eligibility: exactly one `whole-file` item, zero `file-excerpt` /
  `search-match` items. Otherwise "Attach exactly one whole file to
  propose a code change." — never a silent file choice.
- Authority: renderer sends only `{workspaceId, sessionId}` to
  `stark:ai:propose-file-change`. Main derives path + reviewed
  content from the persisted latest user message. The model output
  contains no path or revision, so it cannot choose a target.
- Stale checks: before the provider call, current disk content must
  exactly equal the persisted reviewed content ("This file changed
  after you attached it. Attach it again before requesting a
  change."). After the call, the transaction is created with the
  pre-provider revision through `ChangeTransactionService`; a
  mid-generation change fails with "The file changed while STARK was
  preparing the proposal. Attach it again and try again."
- Provider: Responses Structured Outputs (`text.format` json_schema
  strict, main-owned `{summary, proposedContent}` schema), `store:
  false`, no tools, no conversations, fixed main-owned instruction.
  One attempt, 60 s budget, no retries, no model-name filtering; an
  unsupported model maps to "The selected model could not create a
  structured code proposal. Choose another model."
- Validation: summary non-empty ≤500 codepoints; proposed content
  Stage 8-compatible (no NUL, valid Unicode, ≤64 KiB, preserved
  byte-for-byte, no auto-format). Identical content returns "STARK
  did not propose any code changes." with no transaction.
- Result: a `pending` Change Transaction only (disk still holds the
  original bytes). The Session shows "Proposal ready" + summary +
  Review change, which opens the existing TransactionReview + Monaco
  DiffEditor. Existing Accept/Reject/Rollback behavior is unchanged;
  Ask mode never creates transactions and Propose never calls normal
  generation. One AI operation per session at a time ("STARK is
  already generating a response for this session."). Single-file
  proposals need no new tables — the pending transaction IS the
  persistent proposal.

## Persistent multi-file AI Change Sets

Propose change also handles 2–5 whole-file attachments: one
structured provider call becomes one persistent Change Set holding
one pending Stage 9 transaction per changed file. The AI still never
writes disk. One whole file keeps the Stage 16 single-transaction
behavior.

- Targets: 2–5 existing text files (`MIN_AI_CHANGE_SET_FILES`,
  `MAX_AI_CHANGE_SET_FILES`), all attached as whole-file context
  (notes may accompany); excerpt/search attachments block the
  proposal. No creation, deletion, rename, move, copy, terminal,
  Git, hidden context, or auto-discovery.
- Target IDs: main assigns temporary opaque IDs (T1…Tn) mapped to
  persisted context rows for one request only — never persisted. The
  model sees `[TARGET Tn]` blocks (path informational) and returns
  `{summary, changes: [{targetId, summary, proposedContent}]}` with a
  strict main-owned schema. Unknown/duplicate target IDs reject the
  whole proposal; omitted files stay untouched.
- Stale checks: every attached file must exactly equal its reviewed
  content before the provider call, or no call happens; every
  proposed target is re-read after validation and must match its
  pre-provider revision, or zero sets and zero transactions persist.
- Limits: 64 KiB per proposed file, 256 KiB combined
  (`MAX_AI_CHANGE_SET_TOTAL_PROPOSED_BYTES`), 500-codepoint global
  summary, 300-codepoint file summaries. No-op files are dropped; all
  no-op returns "STARK did not propose any code changes." No
  truncation, no repair retries.
- Persistence: `change_sets` + `change_set_items(file_summary)` plus
  child `change_transactions`/`change_transaction_files` land in ONE
  SQLite transaction (schema **v7**, `007-change-sets.ts`,
  append-only; migrations 001–006 untouched). Group state
  (pending/partially_resolved/resolved) is derived from children —
  never a persisted column.
- Review: Change Sets survive restart in Changes history beside
  ungrouped transactions. Grouped review shows the global summary,
  derived status, and per-file status with individual Review buttons
  into the existing TransactionReview + DiffEditor. Accept/Reject/
  Rollback stay per-file through the existing Changes API. There is
  deliberately no Accept All: a Change Set groups reviewable
  proposals; it is NOT a single atomic filesystem commit.

## STARK Brain Stage 18

The composer has three modes — **Ask** (direct normal provider
response), **Work** (bounded Brain → optional Worker → Brain
response), and **Propose** (existing Change Transaction paths).
Work runs at most one Brain plan, at most one Worker call, and at
most one Brain synthesis — three provider calls maximum, no loops,
no retries, no tools, no filesystem authority.

- Brain and Worker share the currently selected provider/model in
  Stage 18 (no role models yet — Heart/model routing comes later).
  Both receive only bounded Session history, the latest user's
  explicit persisted context, and main-owned run artifacts. Worker
  output is untrusted data in a user-role block, never an
  instruction; synthesis keeps the main-owned instruction
  authoritative. No chain-of-thought is requested or stored — only
  the short plan summary and bounded text outputs.
- Direct path: plan action `answer` persists its final answer as a
  normal assistant message (1 provider call). Delegated path: plan
  action `delegate` with one worker instruction → one Worker text
  call → one synthesis call → final assistant message.
- Persistence: `orchestration_runs` + `orchestration_steps`
  (schema **v8**, `008-orchestration-runs.ts`, append-only). The run
  is created running before the first provider call; steps append as
  they complete; the final assistant message plus run completion land
  in one SQLite transaction. Failures mark the run failed with safe
  copy and persist no fake message. One bounded startup pass marks
  crash-leftover running runs interrupted (no resume).
- Concurrency: the whole run holds the shared per-session AI guard,
  excluding Ask generation and both proposal paths until it
  completes or fails ("STARK is already generating a response for
  this session."). Explicit Retry Work starts a new run against the
  same trailing user message without duplicating it.
- UI: Work flight shows one honest preparing state ("Brain is
  working…", no fake percentages); completed runs show persistent
  details (Plan summary, per-step Plan/Worker result/Final response
  states, expandable inert Worker text). Run history reloads from
  storage, so details survive restart.

## HEART Stage 19

Heart is STARK's deterministic model-routing layer: the Brain
requests a Worker task profile, Heart maps it to a user-configured
provider/model assignment. Brain never names models; Heart never
calls a model. Brain plan and Brain synthesis share one snapshotted
Brain assignment per run.

- Brain assignment: one configured provider/model used for both
  planning and synthesis within a run (captured once — no mid-run
  drift). Worker routing: Fixed mode always uses the configured
  Worker assignment (the requested profile is recorded but does not
  change routing); Auto-Swap maps the requested profile
  (general/coding/reasoning/fast) to an explicit per-profile
  assignment or the configured default — one result, no fallback
  cascade. Auto-Swap is task routing, NOT failure fallback: a failed
  Worker call fails the run with no retry on another model.
- The user configures which model each profile means (no
  name-prefix, pricing, or benchmark heuristics anywhere). First use
  derives Brain and Fixed Worker once from the legacy selected
  provider/model without mutating it; later routing never touches the
  global selection — per-request models only.
- Limits: 2–5 file rule untouched; 64 KiB per proposed file;
  provider/model IDs bounded (100/200 codepoints). Work stays at max
  3 provider calls; Heart adds zero LLM calls. Credentials stay in
  Stage 14 storage; Heart tables hold IDs only.
- Audit: every provider-backed step persists role/provider/model/
  route/requested-profile atomically with the step, so run details
  show exactly what ran what (requested coding → resolved default →
  model-D). Historical Stage 18 rows show "Model information
  unavailable for this older run." Ask/Propose modes keep the legacy
  selected model in Stage 19.
- Persistence: `ai_heart_settings` (singleton) +
  `ai_heart_assignments` + `orchestration_step_models` (schema **v9**,
  `009-heart.ts`, append-only). Config saves are single SQLite
  transactions; group run state stays derived.

## Looplink Stage 20

Looplink is STARK's persistent continuity layer: explicit work from
one coding Session continues in a NEW Session without copy/paste —
"Your model stopped. Your work didn't." No AI summarizer, no hidden
reads, no automatic sending; creation, reads, and dismissal use zero
provider calls.

- Explicit "Continue with Looplink" snapshots bounded already-
  persisted state (≤12 recent messages newest-first, sent context
  from the most recent contextual user message, latest orchestration
  metadata with ≤32 KiB Worker result, ≤10 change references) into an
  immutable versioned payload (≤128 KiB, SHA-256 verified on read)
  and atomically creates the target Session ("Continue: …") plus its
  pending handoff in the same Workspace. No message rows are cloned;
  later source edits never mutate the snapshot; chained continuations
  rebuild from the target's own messages (no nested payloads).
- Historical file context inside a Looplink is conversational data,
  never fresh Stage 15 proposal authority: Propose change stays
  ineligible until the user attaches the current file again (stale-
  file protections preserved). Target Ask/Work use current Heart
  routing, so source A/B and target X/Y routings interoperate over
  provider-neutral text with no response/conversation IDs crossing.
- One-time continuity: the first successful Ask or Work response
  consumes the handoff atomically with its assistant message (and,
  for Work, the completed orchestration state); failures keep it
  pending for explicit retry; a second request never resends it.
  Dismiss marks it dismissed with the Session retained.

## Continuity Recovery Stage 21

Recovery is bounded single-hop continuity when an Ask or Work
provider path fails with a recoverable availability condition:
"Your model stopped. Your work didn't." One source request, one
automatic Looplink handoff, one configured recovery route, one
recovery attempt — then STOP. No fallback chains, no retry loops,
no global model mutation, no proposal recovery.

- Modes (default `off`, never silently enabled): `off` surfaces
  failures normally; `handoff` creates one Looplink recovery target
  ("Recovery ready", no provider call, `attempt_count=0`); `auto_once`
  replays the failed request once using explicit Recovery models.
- Recoverable categories only: `provider-rate-limit` (429/quota),
  `provider-network`, `provider-timeout`, `provider-unavailable`,
  `model-unavailable`, `structured-output-unsupported`. Auth (401),
  permission (403), validation, storage, transaction, Looplink,
  Heart, and renderer failures never trigger recovery.
- Recovery assignments (user-chosen, IDs only, no credentials):
  Ask Recovery, Brain Recovery, Worker Recovery. Recovery Work uses
  a fixed topology (Recovery Brain → optional Recovery Worker →
  same Recovery Brain, `route_key=recovery`); the Brain-requested
  profile is audited but never changes routing. `auto_once` requires
  all three; `off`/`handoff` leave them optional.
- Ask ≤2 total provider calls (1 primary + 1 recovery); Work ≤6
  (3 primary + 3 recovery). Policy, Looplink preparation, and config
  resolution perform zero calls. Per-call ≤60s, per-Work-run ≤150s.
  No second handoff, no second route, no automatic retry.
- Recovery target is a new Session ("Recovery: …", 80-codepoint
  bound): handoff creates session + Looplink + event atomically;
  auto_once additionally persists one replay user message with
  exactly the failed text and zero fresh context attachments.
  Historical Looplink context stays non-authoritative — Propose
  remains ineligible until the user reattaches current files.
  Whole-Work restart only: recovery never resumes half-run provider
  state; the source failed run stays failed and the target starts a
  new run.
- Persistence (schema **v10 → v11** adds recovery tables):
  `ai_recovery_settings` (singleton `off`), `ai_recovery_assignments`
  (`ask`/`brain`/`worker`), `ai_recovery_events` (source tuple unique,
  handoff unique, `handoff_ready`/`running`/`succeeded`/`failed`/
  `dismissed`/`interrupted`), `ai_recovery_event_routes`
  (actual `ask`/`brain`/`worker` routes). Crash marks leftover
  `running` as `interrupted` with no resume; Looplink stays pending
  and the replay message is preserved for manual continuation.
- No global mutation: legacy selected model, Heart Brain/routes/mode
  never change. No quota polling, billing APIs, or dashboards.
  Renderer shows safe mode toggles, explicit Save Recovery (no
  autosave), source/target banners with failure/policy/status plus
  route IDs only, and Open recovery session — no percentages,
  countdowns, credentials, or raw provider bodies.

## Workspace Capabilities Stage 22

Stage 22 is the default-deny permission boundary future Worker tools
must pass before invoking any bounded application capability. It
defines permissions only — it executes zero tools and adds zero
provider calls.

- Five main-owned capabilities only: `workspace.read` (future bounded
  Stage 6 file reads), `workspace.search` (future bounded Stage 7
  literal search), `git.read` (future read-only Stage 12 status/diff,
  never commit/checkout/push), `change.propose` (future pending Stage 9
  / Change Set proposals only, never Accept), `terminal.execute`
  (future user-visible bounded command, no implementation yet). There
  is deliberately no `direct-file-write`, `accept/reject/rollback`,
  `delete/rename/move`, `raw-shell`, `arbitrary-node/fs`, or
  `credential/provider-secret-read` capability — direct AI file-writing
  remains architecturally impossible.
- Modes: `deny` (forbidden), `ask` (explicit per-action human approval
  in a later stage), `allow` (may proceed without an extra prompt but
  still through all bounded security layers). Terminal allows only
  `deny`/`ask`; saving `terminal.execute=allow` fails validation
  because exact-command approval must always be required.
- Default deny: after migration no Workspace gains any capability, no
  opt-in initializer exists, and absent rows synthesize
  `enabled=false` + all `deny`. Existing Ask/Work/Propose keep working
  because they are not tool invocations.
- Master kill switch: per-workspace `enabled` (default `false`).
  Authorization requires enabled AND the capability decision;
  disabled denies everything with `workspace-disabled` while preserving
  configured modes for later re-enable.
- Gate (`CapabilityGate.authorize`, main-internal, never in preload):
  validates workspace/session ownership, rejects unknown capabilities,
  denies `brain` always (`brain-has-no-tool-authority`), checks master,
  then maps stored mode to `deny` / `requires_approval` / `allow`.
  Local bounded DB lookup, deterministic, no side effects, no
  filesystem, no tools. `ask` returns `requires_approval` without
  resolving it — Stage 23+ will create action-specific requests.
- Saves are complete-replacement in one transaction (settings + all
  five rows); unknown/duplicate/missing/mode/terminal-allow/extra
  fields reject; failure keeps the old config. Tables hold only
  workspace/enabled/capability/mode/timestamps — no keys, models,
  commands, paths, or output. No approval or audit tables yet.
- UI: Agent Permissions with master `[ Disabled / Enabled ]`,
  per-capability Deny/Ask/Allow (terminal Deny/Ask only), safety copy
  that permissions never bypass Workspace security or review, terminal
  exact-command copy, proposal review/Accept copy, explicit Save
  permissions, disabled-master read-only selectors with preserved
  choices, no tool/approve UI, no autosave/polling.
- Human isolation: Explorer, Search, Git tab, human terminal, Change
  review/Accept/Reject, Propose, Ask, Work, Heart, Looplink, Recovery
  never consult the gate and behave exactly as before.

## Read-Only Worker Tools Stage 23

Stage 23 introduces the first actual Worker tools — read-only only
(`workspace_read`, `workspace_search`, `git_read`), each gated by the
Stage 22 CapabilityGate with concrete per-action human approval. Brain
stays tool-free; Worker is the only tool actor. No proposal or
terminal tools exist.

- Flow per request: validate name/args → `CapabilityGate.authorize`
  (worker) → `deny` returns a bounded denied result (counts toward
  budget, Worker continues), `allow` executes immediately through the
  existing bounded Stage 6/7/12 services, `ask` creates one exact
  approval and parks the run as `waiting_for_approval` (guard released,
  no polling, no open provider call). Approval covers one exact
  invocation (path/query/operation); policy never mutates and no
  session-wide grant exists.
- Bounds: max 4 tool calls per run (allowed/denied/approval/failure
  all count), max 5 Worker provider turns (initial + follow-ups),
  max 7 Work provider calls (1 plan + 5 worker + 1 synthesis). One
  tool per turn; multiples or tool+text fail with zero execution.
  Explicit `for (turn < MAX_WORKER_TURNS)` — no `while(true)`, no
  recursion. Results are untrusted data blocks, never instructions.
- Tools: `workspace_read{relativePath}` reuses Stage 6 validation
  (containment, symlink refusal, text rules) plus a 64 KiB agent cap
  (larger fails, never truncated; revision informational only, never
  proposal authority); `workspace_search{query}` is literal only
  (128-codepoint query, 30 results, 32 KiB payload, secret exclusions,
  `truncated` flag); `git_read` accepts `{status}` or
  `{diff, staged|unstaged, relativePath|null}` and reuses the Stage 12
  read-only service (shell:false, top-level check, caps, 64 KiB bound,
  no mutation).
- Approvals persist (`pending`→`approved`/`denied`/`expired`→`consumed`
  once; denied/expired terminal) with deterministic arg JSON + SHA-256
  (tampering fails, no execution), 15-minute lazy expiry (no timers),
  approve/deny-and-resume by IDs only (main derives everything).
  Denial resumes the Worker with a denied result (run may still
  succeed). Run state (instruction, request, context, continuity,
  history, counts, route snapshot, hashes; ≤256 KiB) makes resume
  crash-safe with the same Worker model (no Heart re-read).
  Restart reloads the card with no provider call; expiry fails the run.
- Looplink stays pending while waiting and consumes only on final
  successful completion. Tool-enabled Work disables Stage 21 auto
  recovery after the first tool interaction (fail normally, no target);
  pre-tool failures may still use Stage 21. New Ask/Work/Proposal in a
  session with a pending approval is blocked with a safe message
  (explicit state, not a held guard). Audit (`worker_tool_events` +
  per-turn `worker`/`worker_followup` model rows) survives restart
  with no secrets or provider-native IDs.

## Worker Change Proposals Stage 24

Stage 24 adds exactly one Worker tool — `change_propose` (`change.propose`) —
creating reviewable proposals only. The Worker may propose; it may never
choose a filesystem target, write, or Accept. A valid target must come from
a successful `workspace_read` earlier in THE SAME Worker run.

- Target authority: successful `workspace_read` results expose a
  main-generated opaque same-run `readRef` (`R1`, `R2`, … deterministic
  per run, bounded by the four-tool budget, persisted in normalized Worker
  state/tool audit). Main maintains `readRef → successful worker_tool_event
  → workspace/session/run → relative path → exact revision → exact content`.
  On restart the mapping reconstructs from persisted successful tool
  events/state. Only `workspace_read` creates authority — `workspace_search`
  previews, `git_read` data, denied/failed reads, and historical Looplink
  files never do. Unknown (`R99`), duplicate (`R1` twice), cross-run,
  cross-session, cross-workspace, search/Git refs all reject with no
  proposal record.
- Arguments: exactly `{changes:[{targetRef,summary,proposedContent}]}`,
  1–5 targets (reachable count bounded further by actual reads/tool budget),
  per-file 64 KiB (`MAX_AI_PROPOSED_FILE_BYTES`), total 192 KiB
  (`MAX_WORKER_PROPOSAL_TOTAL_BYTES`), 300-codepoint summaries
  (`MAX_WORKER_PROPOSAL_FILE_SUMMARY_CODEPOINTS`), UTF-8 measured, no
  truncation, no formatting, no fence parsing, extra fields rejected. Model
  paths in summary/content are inert text — resolution uses only the
  `readRef` mapping through a strict main-owned decoder (tampered payloads
  fail safely).
- Single file → exactly one pending Stage 9 transaction via the existing
  `ChangeTransactionService` (shared `prepare-file-change` validation:
  existing file, ownership, symlink refusal, expected revision, Unicode/text
  rules, stale detection). Multi (2+) → existing Stage 17 `ChangeSetService`
  with one pending child transaction per effective changed file. Disk
  remains unchanged; no group Apply, no Accept All. No-op items (proposed
  equals exact read content) are dropped; all-no-op returns `no_changes`
  with no persistence; mixed no-op with one effective file becomes an
  ordinary single transaction. Stale reads (disk moved past the read
  revision, including mid-approval races) fail with "The file changed after
  STARK read it. Read it again before proposing a change." — no silent
  re-read, no `readRef` update. Because reads require existing files, no
  proposal can create new files.
- Gate: every invocation authorizes `change.propose` for `worker` at
  execution time. `deny` persists a denied event and returns
  "Change proposals are not allowed for this Workspace." (one tool call,
  Worker may continue). `allow` creates the pending proposal immediately
  (no disk write). `ask` creates one exact approval and parks the run as
  `waiting_for_approval` (no proposal yet); the approval binds targetRefs,
  summaries, and proposedContent through deterministic JSON + SHA-256, lists
  resolved relative paths + summaries (never bare `R1`), and states
  "Approval creates a reviewable proposal only. It does not modify files."
  Approval shows file count/paths/summaries (full diff stays in later
  Transaction/ChangeSet review). Approve re-validates hash, re-resolves
  refs, re-checks staleness, consumes exactly once, then resumes the bounded
  Worker loop; deny returns "The user denied creation of this code proposal."
  Expiry reuses the 15-minute lazy rule with no timers. Proposal creation
  adds zero provider calls; budgets stay 4 tools / 5 Worker turns / 7 Work
  calls; no retries, repair, recursion, polling, background jobs, fallback,
  or broad kills. After ANY tool interaction Stage 21 recovery stays
  disabled; proposals survive later synthesis failure and remain reviewable.
- Persistence: schema stays **v13** (`worker_tool_events` result_payload
  holds the normalized `{proposal_created|no_changes}` result with IDs only;
  canonical proposals live in `change_transactions` / `change_sets`;
  run details link via stored IDs to existing Transaction/ChangeSet review —
  no new tables, no new diff viewer, no new IPC (existing
  `get-pending-approval` / `approve-and-resume` / `deny-and-resume` only,
  no preload execution API). Audit stores tool name, capability, bounded
  arguments JSON (with proposed code for hash/audit), approval link, safe
  result (no code duplication, no secrets). Worker instruction explains
  readRef-only proposals, no-write, human-Accept-required semantics. Only
  `allow`/`ask` advertise the schema; `deny` hides it with defense-in-depth
  execution-time recheck. Stage 8 remains the exclusive writer for direct
  STARK-managed code edits.

## Worker Terminal Commands Stage 25

Stage 25 adds exactly one Worker-only tool — `terminal_execute`
(`terminal.execute`) — running one bounded non-interactive external command
per exact human approval. The Worker may REQUEST a command; it may NEVER
silently execute it. There is NO automatic terminal execution, ever.

- Security boundary: STARK itself never gives the AI direct
  filesystem-write authority, and direct STARK code changes still require
  proposal → human review → human Accept → Stage 8 writer. BUT an
  explicitly human-approved terminal command executes as an external process
  under the user's OS account and MAY modify files, access the network, or
  start subprocesses. Stage 8 therefore remains the exclusive writer for
  direct STARK-managed code edits — NOT the exclusive OS writer. Approval is
  always exact-action precisely because external commands are powerful.
- Request flow: strict argument validation → `CapabilityGate`
  (`actor=worker`, `terminal.execute`, must be `requires_approval`) →
  persist exact approval → STOP. Human sees exact program + exact argv +
  warning → Approve → revalidate exact hashed action + re-run the gate →
  reserve execution at most once → spawn one bounded process → capture
  bounded output → Worker continues in budget. Persistent `allow` is
  forbidden by Stage 22 and fails closed again here: a gate `allow` (even
  seeded past the service) never spawns.
- Tool schema: exactly `{program, args}` (`program` bare executable name
  ≤128 codepoints, no `/ \ :`, no paths; `args` ≤32 inert strings ≤2048
  codepoints each, ≤12 KiB serialized total). No command string, cwd, env,
  shell, stdin, timeout, background, or session fields. `&& | > $()`
  backticks in argv stay literal DATA through argv execution (`shell:false`).
- Execution: `WorkerCommandService` resolves the bare program through a
  bounded sanitized PATH search (≤128 entries, 32 KiB, PATHEXT on Windows,
  never Workspace-root/cwd precedence; failure is a safe `spawn_failed`),
  spawns with `cwd` = trusted Workspace root, `shell:false`,
  `detached:false`, stdin ignored, piped stdout/stderr, `windowsHide`, and a
  minimal environment (PATH/PATHEXT/SystemRoot/WINDIR/COMSPEC/HOME/
  USERPROFILE/HOMEDRIVE/HOMEPATH/TEMP/TMP/APPDATA/LOCALAPPDATA/PROGRAMDATA/
  LANG/LC_ALL where present, plus `CI=1` — never provider keys or STARK
  secrets). No PTY, no input after launch; the Stage 11 human terminal is a
  separate session Worker bytes never enter.
- Bounds: 60 s runtime (`MAX_WORKER_COMMAND_RUNTIME_MS`, one attempt, exact
  child-handle termination only — never by name, never broadly, 5 s cleanup
  bound), 64 KiB combined output (`MAX_WORKER_COMMAND_OUTPUT_BYTES`: stop,
  terminate, mark `output_limit` + `truncated`, expose bounded output).
  Results (`completed` even on nonzero exit with its code, `spawn_failed`,
  `timed_out`, `output_limit`) normalize stdout/stderr to valid Unicode
  (NUL/controls → U+FFFD) and persist without executable path, PID, or env.
  Failures continue the Worker in budget; integrity failures fail the run.
- At-most-once: BEFORE spawn, ONE transaction verifies pending approval +
  exact hash, records approval, inserts the `launching` row, and consumes
  the approval. Only then does the process spawn (→ `running` → terminal
  outcome). Crash between reservation and spawn NEVER re-executes: startup
  marks `launching`/`running` → `interrupted` (no PID kills — PIDs are never
  persisted) and fails parked runs with "An approved Worker command was
  interrupted. Start the Work request again." Approvals stay consumed.
- Approval card: `STARK Worker needs permission`, `Capability: Terminal
  command`, exact `Program` + indexed `Arguments` + `Working directory:
  Workspace root` (never the host path), "This exact command will run with
  your user account from the Workspace root. It may modify files, start
  subprocesses, or access the network." plus "This approval applies only to
  this exact program and argument list." Deny/Approve only. Run details show
  status/program/args/exit/duration/stdout/stderr as inert text. Deny
  records "The user denied this command." with no row and no spawn.
- Budget: one tool call however it ends; Worker turns ≤5, Work provider
  calls ≤7, execution adds zero. Post-tool Stage 21 recovery stays disabled;
  Looplink stays pending while waiting/running and consumes only on final
  success. Commands that rewrite files stale old `readRef`s (Worker must
  re-read); output never auto-Accepts anything. Schema is **v14**
  (`014-worker-command-executions.ts`, append-only; 001–013 untouched).

## Managed Project Runtime Stage 26

Stage 26 adds exactly one Worker-only tool — `runtime_start`
(`terminal.execute`) — plus a managed project-runtime subsystem for bounded
long-lived development servers (e.g. `npm run dev`). The Worker may REQUEST a
start; it may NEVER silently start one, observe logs, or stop a runtime.
Every start requires exact human approval; persistent Allow stays impossible
without weakening Stage 25 terminal policy.

- Request flow: strict `{program, args, port}` validation (Stage 25
  program/argv rules verbatim; port integer 1024–65535; no command string,
  cwd, env, host, URL, shell, or timeout) → `CapabilityGate`
  (`worker`/`terminal.execute`, must be `requires_approval`; `allow` fails
  closed) → one-active-runtime precheck (an active `starting`/`running`
  session answers `runtime_already_active` with its ID and preview URL —
  one tool call, no approval, no spawn) → exact approval binding
  program/argv/port through deterministic JSON + SHA-256 → Approve →
  gate recheck + atomic reserve-and-consume + active recheck in ONE
  transaction as `starting` → spawn once → `running`. Crash between
  reservation and spawn never auto-starts after restart.
- Execution reuses Stage 25 process rules: bounded sanitized PATH
  resolution (no Workspace/cwd precedence), argv semantics (`shell:false`),
  Workspace-root cwd, sanitized allowlist environment (`CI=1`, no provider
  secrets), stdin closed. No PTY, no human-terminal contact. Runtime
  processes spawn detached so exact tree termination reaches dev-server
  children (POSIX process-group signal, Windows `taskkill /PID <exact-pid>
  /T` — never by name, never broadly, no persisted PIDs).
- Lifetime: one 30-minute hard deadline per runtime (single timer, not
  polling) → `timed_out`/`lifetime_limit`, no restart. Explicit human Stop
  (IDs only, workspace-ownership checked, live-handle-only signalling,
  bounded 5 s wait) → `stopped`/`user`. Natural exits record
  `exited`/`process_exit` with no restart. Normal app shutdown stops every
  live tree with a bounded global deadline (`stopped`/`app_shutdown`).
  Startup marks leftover `starting`/`running` → `interrupted` with no
  launch, no PID kill, no reconnect, failing parked runs with safe copy.
- Logs: continuous stdout/stderr capture into a bounded 128 KiB rolling
  tail (oldest dropped, newest kept, `logs_truncated`, overflow-safe total;
  large logs never terminate the runtime), persisted coalesced (one timer
  per runtime, ≥500 ms; flushed on transitions/exit/stop), normalized to
  safe Unicode. Logs are untrusted human-visible DATA only — Stage 26
  feeds nothing to Brain/Worker automatically and adds no Worker stop
  tool (Stage 27 adds explicit bounded read-only observation).
- Live Preview: an isolated `BrowserWindow` per runtime (no Node, no STARK
  preload/bridge, sandboxed, `webSecurity`, ephemeral per-runtime session
  partition), navigating only to main-derived `http://127.0.0.1:<port>/`
  with same-loopback-origin allowlist (paths/queries fine; external hosts,
  other ports, `localhost`-as-different-host, `file:`/`javascript:`/`data:`
  denied), `window.open` denied, sensitive permissions denied. Closing the
  preview never stops the runtime; reload is explicit (no polling, no
  readiness probing — spawn success means running, not ready; Stage 27
  adds explicit bounded read-only inspection with no click/type/submit,
  no navigation, and no DOM mutation).
- UI: workspace-scoped Runtime section (active card with status/command/
  preview URL/started time/"Maximum runtime: 30 minutes.", Open/Reload/Stop
  buttons, inert log tails with omission copy, 10-row history; no
  countdowns), runtime approval variant (capability, exact program/argv/
  preview/cwd, both warnings, Deny/Approve only), `stark:runtime:updated`
  push events instead of polling. IPC adds only `get-active`/`list-recent`/
  `stop`/`open-preview`/`reload-preview` (IDs only) — no start/spawn/kill/
  URL surface. Runtimes outlive Work completion/failure by design; post-tool
  recovery stays disabled; Looplink untouched by runtime state. Schema is
  **v15** (`015-project-runtimes.ts`, append-only; 001–014 untouched).

## Local Provider Usage Awareness + Bounded Heart Threshold Routing Stage 28

Stage 28 observes — never bills. STARK counts only the provider calls
STARK itself makes, using provider-reported token counts when
available, and may switch once BEFORE a call to a user-configured
alternate when a local 24-hour routing threshold is reached. There is
no provider billing/quota API polling of any kind.

- Local usage ledger: every outbound AI adapter invocation (Ask,
  Brain plan, Worker turns, synthesis, single/multi proposals, all
  Recovery variants, tool-runner follow-ups) passes through one
  central tracker recording provider/model/operation/role, run
  scope, success or safe failure category, reported tokens, and
  latency. Reservation (`started`) precedes the single invocation;
  telemetry failures never retry or duplicate model operations, and
  startup marks leftovers `interrupted` with one bounded 31-day
  retention delete. Token fields stay null unless reported — no
  estimation, no pricing. Tables hold metadata/counters only.
- Rolling 24-hour summaries per provider/model (calls including
  started/success/failed/interrupted, successes, failures,
  rate-limit failures, token sums, token-telemetry completeness)
  over at most 100 pairs, plus configured limits and Heart
  assignments. Token thresholds evaluate only on complete
  telemetry; call thresholds always apply.
- Heart threshold alternates: at most one alternate per route
  (`brain.primary`, `worker.fixed/default/general/coding/reasoning/
  fast`), validated against known providers and current Heart
  bases, saved atomically with limits in one transaction. Routing
  defaults OFF, so existing Work is unchanged until opt-in.
- Route selection is frozen per run: Brain plan+synthesis share one
  threshold-selected assignment from the Work-start snapshot;
  Worker selection reuses the same snapshot after the plan;
  approval resume never re-routes. Decisions persist per run role
  (`base` / `threshold_alternate` /
  `threshold_reached_no_alternate`, which never blocks) beside the
  unchanged step-model audit. Recovery, Ask, and Propose calls are
  tracked but never threshold-routed. Zero added provider calls;
  Work ≤7 and Recovery bounds unchanged. IPC adds only
  `stark:usage:get-config` / `update-config` / `get-summary`
  (schema v16 → v17 adds usage tables).

## Current status

- [x] Electron main process, preload bridge, React shell
- [x] Secure defaults + minimal read-only IPC
- [x] STARK design tokens (obsidian + neon lime) and dev shell UI
- [x] Strict TypeScript, ESLint, build packaging config
- [x] Local SQLite persistence foundation (schema v3, key/value + workspaces + change transactions, tests)
- [x] Typed Settings domain + secure IPC (reference domain architecture, no UI yet)
- [x] Local profile + first-launch onboarding (no authentication)
- [x] Workspace domain: native folder picker, persistence, recents, restore (no file tree/editor/terminal/Git)
- [x] Workspace Explorer: lazy tree + Monaco file preview, workspace-scoped security (no writes/AI)
- [x] Workspace Search: bounded literal on-demand search + safe preview reuse, workspace-scoped security (no index/AI)
- [x] Single-file editing: Monaco editor + SHA-256 stale-write protection + atomic same-directory replacement, existing files only (no autosave/AI)
- [x] Change transactions: persisted pending proposals + explicit Accept/Reject + guarded Rollback, Stage 8 writer stays the exclusive writer for direct STARK-managed code edits (human-approved terminal commands remain an explicitly authorized external-process boundary, never a STARK write path)
- [x] Monaco code editor + transaction DiffEditor: local assets/workers, line focus, CRLF preservation, mixed-EOL read-only safety (no LSP/tabs/AI)
- [x] Human terminal: xterm.js bottom panel + node-pty PTY, one session per window, Workspace-root cwd, explicit Start/Kill, no agent access, no persistence (schema v3)
- [x] Read-only Git: system-git status/branch/upstream awareness + staged/working diff viewer, Workspace-root equality gate, no polling, no mutation, no network (schema v3 → v4 keeps Git table-free)
- [x] Persistent coding sessions: workspace-scoped SQLite sessions + append-only user messages, explicit New session, deterministic first-message titles, 50-session / 100-message paging, 64 KiB limit, local-only with no AI provider yet (schema v4 → v5 keeps session tables)
- [x] AI provider foundation: OpenAI-only adapter (Responses API, store:false, 4096 tokens, explicit context only), safeStorage-encrypted key persistence with fail-closed platforms, one selected model, explicit discovery/test, real assistant replies in Sessions with Retry (schema v5 → v6 keeps provider tables)
- [x] Explicit bounded project context: user-attached excerpts/whole-file/search-match/notes with visible removable chips, main-side re-resolution, 20-item/32 KiB/200 KiB bounds, deterministic provider blocks, persisted per-message history (schema v6)
- [x] AI-proposed single-file changes: Ask vs Propose change composer modes, one whole-file attachment, Responses Structured Outputs, full-file replacement into a pending Change Transaction, human Accept required, no AI disk writes
- [x] Persistent multi-file AI Change Sets: 2–5 whole-file targets with temporary target IDs (model cannot choose paths), one structured call, one pending Stage 9 transaction per changed file in a single atomic aggregate, grouped review with per-file Accept/Reject/Rollback, no Accept All, no group filesystem atomicity claim (schema v6 → v7 adds change sets)
- [x] STARK Brain orchestration: Ask/Work/Propose composer modes, bounded Brain → optional Worker → Brain synthesis (max 3 provider calls, no loops/retries/tools), same selected model for both roles, persisted runs with ordered steps and atomic final completion, crash-interrupted recovery, shared per-session AI guard (schema v7 → v8 adds orchestration runs)
- [x] HEART model routing: Brain assignment plus Fixed/Auto-Swap Worker modes over general/coding/reasoning/fast profiles, deterministic local resolution with zero AI calls, per-run routing snapshot, per-step model audit, atomic config saves, legacy-compat initialization without global mutation (schema v8 → v9 adds Heart tables)
- [x] Looplink continuity: explicit same-Workspace continuation into a new Session with an immutable bounded snapshot (messages, sent context, orchestration and change metadata, SHA-256 verified), zero provider calls to create/read/dismiss, one-time atomic consumption by first successful Ask/Work, historical code never becomes proposal authority (schema v9 → v10 adds handoffs)
- [x] Continuity Recovery: bounded single-hop Ask/Work failover on six recoverable provider/model categories only, off/handoff/auto_once (default off), explicit Ask/Brain/Worker recovery assignments, Ask ≤2 and Work ≤6 total calls, one Looplink target + one event + one attempt then STOP, whole-Work restart, atomic target and completion transactions, route audit, crash-interrupted with no resume, no global mutation, no proposal recovery (schema v10 → v11 adds recovery tables)
- [x] Workspace capabilities: persistent default-deny permission boundary for future Worker tools — five main-owned capabilities (`workspace.read`, `workspace.search`, `git.read`, `change.propose`, `terminal.execute`), Deny/Ask/Allow with terminal never persistent Allow, workspace master kill switch (default disabled, preserves modes), Brain always denied, deterministic local gate with session ownership, complete-replacement atomic saves, no approval/audit rows yet, existing human Explorer/Search/Git/Terminal/Propose/Ask/Work/Heart/Looplink/Recovery unchanged, zero tools executed, zero provider calls (schema v11 → v12 adds capability tables)
- [x] Read-only Worker tools: first actual Worker tools (`workspace_read`, `workspace_search`, `git_read`) gated by CapabilityGate with exact per-action approval (pending/approved/denied/expired/consumed, 15-min lazy expiry, hash-verified single-use), max 4 tools and 5 Worker turns per run (max 7 provider calls: 1 plan + 5 worker + 1 synthesis), explicit bounded for-loop, Brain tool-free, guard released while waiting with pending-block on new ops, restart-safe persisted state (256 KiB, same Worker route), Looplink consumed only on final success, tool-enabled recovery disabled after first tool, no terminal/proposal tools, tool data never authority (schema v12 → v13 adds approval/event/state tables)
- [x] Worker change proposals: exactly one additional Worker tool (`change_propose` → `change.propose`) creating reviewable proposals only from same-run successful `workspace_read` opaque refs (`R1…`, deterministic, restart-reconstructed; search/Git/Looplink/denied/foreign refs never authority), 1–5 targets with 64 KiB per file / 192 KiB total / 300-cp summaries, single → pending Stage 9 transaction and multi → Stage 17 Change Set via existing services (shared validation, stale protection, no-op dropping, disk unchanged, no creation, no Accept), Ask gives exact proposal-creation approval (paths + summaries + non-apply copy, hash-bound single-use, 15-min lazy expiry, stale rechecked on resume), zero new provider calls with 4-tool / 5-turn / 7-call bounds intact, proposals survive later run failure with recovery disabled after tools, existing Changes/Transaction/ChangeSet review reused, no new IPC/tables (schema stays v13)
- [x] Worker terminal commands: exactly one additional Worker-only tool (`terminal_execute` → `terminal.execute`) running one bounded non-interactive external command per exact human approval — bare program + inert argv only (never a shell string, cwd, env, shell, stdin, or timeout; metacharacters stay data via argv execution), trusted Workspace-root cwd, sanitized allowlist environment (`CI=1`, no provider secrets injected), stdin closed, 60 s runtime cap with child-only termination, 64 KiB combined output cap with output-limit termination, nonzero exits reported as completed failures with no retry, persistent Allow forbidden and fails closed even when seeded (advertised on `ask` only), at-most-once reservation (approval consume + `launching` row in ONE transaction before spawn; crashes mark `interrupted` with no re-execution and no PID kills; parked runs fail with safe copy), counts toward the 4-tool budget with total Work calls still ≤7 and zero new provider calls, post-tool recovery disabled, Looplink pending-while-waiting/consumed-on-success, command side effects stale old `readRef`s without auto-Accept, human terminal stays a separate interactive PTY, Stage 8 remains the exclusive direct STARK writer (explicitly approved commands may still mutate files as external OS processes), no new IPC/preload execution API (schema v13 → v14 adds command executions)
- [x] Managed project runtime: exactly one additional Worker-only tool (`runtime_start` → `terminal.execute`) starting one bounded long-lived dev server per exact human approval — program + argv (Stage 25 rules) + loopback preview port, one active runtime per Workspace (`runtime_already_active` without approval/spawn), Workspace-root cwd, sanitized environment, stdin closed, detached process-group/tree termination (POSIX group signal, Windows exact-PID `taskkill /T`, no names/scans/PIDs), 30-minute hard deadline, explicit human Stop, bounded app-shutdown cleanup, crash → `interrupted` with no relaunch/kill/reconnect, 128 KiB rolling log tails persisted for human display, isolated loopback-only Preview window (no preload/bridge, same-origin allowlist, popups/permissions denied, lifecycle separate from runtime), workspace Runtime UI with push updates (no polling/countdowns), runtime-scoped IPC reads/stop/preview only, outlives Work by design with recovery disabled, no Worker stop tool (schema v14 → v15 adds runtime sessions)
- [x] Bounded Worker runtime observation + read-only Live Preview inspection: exactly two additional read-only Worker-only tools (`runtime_observe` → `runtime.observe`, `preview_inspect` → `preview.inspect`) with two new default-deny Workspace capabilities (Deny/Ask/Allow; existing five unchanged; v15 configs migrate withdeny backfill, no silent grants). `runtime_observe` (`{}` only, main derives the active `starting`/`running` runtime) returns a bounded normalized observation (runtimeId/state/program/args/previewUrl/previewPort/startedAt/maximumLifetimeMs plus stdout/stderr/totalOutputBytes/olderOutputOmitted, ≤64 KiB newest-preferred, no PID/paths/env/credentials, no start/stop/reload/lifetime change). `preview_inspect` (`{}` only, main derives the loopback target from the human Preview's current same-origin URL or `/`) returns a bounded structured textual snapshot (title/readyState/URL, ≤32 KiB visible text, ≤100 elements with 300-codepoint text, same-origin path-only hrefs, no input values/cookies/storage/scripts/outerHTML, ≤64 KiB total) via the single constant main-owned DOM script through either the visible page (read-only, never navigated/reloaded/focused) or one temporary hidden isolated inspector (same partition, no preload, popups/permissions denied, one 10 s load attempt, no retry/polling, destroyed immediately, runtime untouched). Ask binds exact `runtimeId` (observe) or `runtimeId` + frozen path (inspect); replaced/restarted runtimes fail safely with no retargeting. Observations are untrusted DATA with zero provider calls, create no `readRef`/proposal authority (only same-run `workspace_read` does), never auto-inject into Worker context, count toward the 4-tool budget (Work still ≤7 calls), disable recovery after use, and reuse existing approval/event IPC with no new channels (schema v15 → v16 backfills capability defaults only)
- [x] Local provider usage awareness + bounded Heart threshold routing: STARK-only outbound-call ledger with provider-reported tokens (no estimation, no billing/quota polling), rolling 24h summaries with token-completeness gating, user-configured routing thresholds + at most one Heart alternate per route (default off, atomic saves), frozen per-run route snapshots with immutable per-role decision audit beside the step-model audit, tracked-but-unrouted Ask/Propose/Recovery paths, zero added provider calls with all existing call bounds intact, three usage IPC channels (schema v16 → v17 adds usage tables)
- [ ] Agent orchestration, model routing, auth, Supabase — later stages
