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
  `PRAGMA user_version`. Current schema version: **5**.
- Tables: `key_value(key TEXT PRIMARY KEY, value TEXT (JSON), updated_at INTEGER)`,
  `workspaces(id, root_path UNIQUE, display_name, created_at, last_opened_at)`
  plus a recency index, `change_transactions` + `change_transaction_files`,
  `coding_sessions` + `coding_messages` (workspace/session cascades, recency
  and paging indexes), `ai_provider_configs` + `ai_provider_credentials`
  (ciphertext BLOB only, config cascade).
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
  operation, safe category, and duration. Schema is **v6** (context
  rows added; provider tables unchanged).

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
  Schema is **v6** (`006-message-context.ts`, append-only).
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
- [x] Change transactions: persisted pending proposals + explicit Accept/Reject + guarded Rollback, Stage 8 writer stays the only mutator (no AI)
- [x] Monaco code editor + transaction DiffEditor: local assets/workers, line focus, CRLF preservation, mixed-EOL read-only safety (no LSP/tabs/AI)
- [x] Human terminal: xterm.js bottom panel + node-pty PTY, one session per window, Workspace-root cwd, explicit Start/Kill, no agent access, no persistence (schema v3)
- [x] Read-only Git: system-git status/branch/upstream awareness + staged/working diff viewer, Workspace-root equality gate, no polling, no mutation, no network (schema v3 → v4 keeps Git table-free)
- [x] Persistent coding sessions: workspace-scoped SQLite sessions + append-only user messages, explicit New session, deterministic first-message titles, 50-session / 100-message paging, 64 KiB limit, local-only with no AI provider yet (schema v4 → v5 keeps session tables)
- [x] AI provider foundation: OpenAI-only adapter (Responses API, store:false, 4096 tokens, explicit context only), safeStorage-encrypted key persistence with fail-closed platforms, one selected model, explicit discovery/test, real assistant replies in Sessions with Retry (schema v5 → v6 keeps provider tables)
- [x] Explicit bounded project context: user-attached excerpts/whole-file/search-match/notes with visible removable chips, main-side re-resolution, 20-item/32 KiB/200 KiB bounds, deterministic provider blocks, persisted per-message history (schema v6)
- [ ] Agent orchestration, model routing, auth, Supabase — later stages
