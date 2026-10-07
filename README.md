# STARK

**Your model stopped. Your work didn’t.**

STARK is an AI-first desktop vibe-coding application that lets users work
continuously across AI models and sessions — without manually switching
models, copying prompts, or losing coding context. It targets both
nontechnical users and developers on Windows, macOS, and Linux.

> **Current stage: project foundation.** This repository contains the
> Electron + React + TypeScript application shell only. The AI agent
> orchestration system, model routing, authentication, Supabase sync, the
> duo-agent workflow, SQLite persistence, terminal, and editor are
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

Future modules (workspaces, sessions, providers, models, agents, routing,
chat/history, filesystem + terminal integration, settings, auth, cloud sync)
plug into `main/services/`, `main/ipc/`, `renderer/features/`, and
`shared/` without restructuring. Persistence for those modules goes
through `main/database/` repositories — never raw SQL from features.

## Local persistence

STARK uses the SQLite implementation built into the Node.js runtime
(`node:sqlite`, `DatabaseSync`). No database dependency is installed.
SQLite lives in the Electron main process only — the renderer, preload,
and `window.stark` have no database access and no generic SQL IPC exists.

- Location: `app.getPath('userData')` — `stark-dev.db` in development,
  `stark.db` in packaged production. Never in the repository tree.
- Migrations: ordered, validated, transactional, tracked with
  `PRAGMA user_version`. Current schema version: **1**.
- Tables: `key_value(key TEXT PRIMARY KEY, value TEXT (JSON), updated_at INTEGER)`.
- Pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`,
  `busy_timeout = 5000`.
- Tests: `npm run test:db` (Node built-in runner, real SQLite, isolated
  `:memory:`/temp databases).

## Current status

- [x] Electron main process, preload bridge, React shell
- [x] Secure defaults + minimal read-only IPC
- [x] STARK design tokens (obsidian + neon lime) and dev shell UI
- [x] Strict TypeScript, ESLint, build packaging config
- [x] Local SQLite persistence foundation (schema v1, key/value repository, tests)
- [ ] Agent orchestration, model routing, auth, Supabase — later stages
