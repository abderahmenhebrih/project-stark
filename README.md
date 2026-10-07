# STARK

**Your model stopped. Your work didn’t.**

STARK is an AI-first desktop vibe-coding application that lets users work
continuously across AI models and sessions — without manually switching
models, copying prompts, or losing coding context. It targets both
nontechnical users and developers on Windows, macOS, and Linux.

> **Current stage: production code editor (Stage 10).** This repository contains
> the Electron + React + TypeScript application with local SQLite
> persistence and the Settings, local-profile, Workspace, Explorer,
> Search, single-file Editing, Change Transaction, and Monaco Editor
> domains.
> The AI agent orchestration system, model routing, authentication,
> Supabase sync, the duo-agent workflow, and terminal are
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
  `PRAGMA user_version`. Current schema version: **2**.
- Tables: `key_value(key TEXT PRIMARY KEY, value TEXT (JSON), updated_at INTEGER)`,
  `workspaces(id, root_path UNIQUE, display_name, created_at, last_opened_at)`
  plus a recency index.
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
servers, formatters, terminal, or Git yet.

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
- [ ] Agent orchestration, model routing, auth, Supabase — later stages
