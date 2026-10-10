# STARK Terminal Subsystem

> Documentation export for external architecture / code review.
> Reflects the FINAL repository code after the terminal hardening pass
> (isolation + close-race fix + B1–B7/H1–H2/D1 hardening).
> Schema is v19 (no migration 020).

## Current Status

The human-terminal subsystem is fully isolated from Electron main:

- Human PTYs no longer run directly in Electron main. Every `node-pty` handle lives in a dedicated **Terminal Host** utility process (`terminal-host-bootstrap.js` + `terminal-host.mjs`, forked via `utilityProcess.fork`).
- **Electron main acts as broker / policy authority** (`TerminalManager` + `TerminalHostManager` + `TerminalProcessClient`). Main owns shell choice, workspace cwd, env, opaque ids, per-owner caps, and ownership checks. It owns zero PTY handles.
- The **renderer never receives generic process authority**. It gets exactly four invoke channels (`create/write/resize/kill`) plus two owner-only event channels (`data/exit`), all with validated payloads.
- Multiple terminals may run simultaneously (cap 8 per owner). Normally **exactly ONE terminal canvas is visible** (the active terminal). Exactly **TWO canvases may be visible only after explicit Split Terminal** (`splitIds` pair + resizable divider).
- Terminal selection never recreates PTYs. One stable xterm instance per session stays mounted (hidden with `display:none` when backgrounded), preserving buffer/scrollback/focus.
- Close is **two-phase** (`close-requested` hides presentation immediately; `close-finalized` disposes after backend kill initiates). **EXIT wins close races**: an EXIT arriving while `closingIds` contains the id finalizes removal immediately, and late stale kill-failures are ignored (bounded per-id generation token + reducer guards). **Already-exited terminal cleanup requires no kill** (`close-finalized` locally, no IPC).
- Live PTYs are runtime resources, never persisted. Restart assumes nothing alive. Schema remains **v19**.

## Architecture Summary

```
Renderer (Explorer + TerminalDrawer + TerminalPanel + TerminalInstanceView/xterm)
  │  narrow TerminalApi: create({workspaceId,cols,rows}) / write / resize / kill
  │  events: onData / onExit   (owner-only, validated)
  ▼
Preload bridge (src/preload/index.ts :: createTerminalApi)
  │  ipcRenderer.invoke(stark:terminal:create|write|resize|kill)
  │  ipcRenderer.on(stark:terminal:data|exit) with payload validators
  ▼
Electron Main broker
  ├─ TerminalService   (validate create request, resolve workspace cwd)
  ├─ shell-policy      (main-chosen shell: win32 powershell.exe -NoLogo,
  │                      darwin /bin/zsh, linux /bin/bash → /bin/sh fallback)
  ├─ terminal-environment (main-built env, TERM=xterm-256color)
  ├─ TerminalManager   (opaque UUID ids, ownerWebContentsId, cap 8,
  │                      ownership checks, exit-once delivery, teardown)
  ├─ TerminalProcessClient (correlates CREATE/KILL answers, maps outcomes)
  └─ TerminalHostManager (owns/forks/monitors the host child, bounds,
                           routes correlated answers, no retries/polling)
  │  private closed protocol (stark-terminal-host/v1, 64 KiB caps)
  ▼
Terminal Host utility process (out/main/terminal-host-bootstrap.js)
  │  createTerminalHostRuntime (src/main/terminal/terminal-host.mjs)
  │  owns ALL node-pty handles; blocking ConPTY kill runs HERE, never on main
  ▼
node-pty / ConPTY / shell (powershell.exe -NoLogo on Windows)
```

Return path (host → main → owner renderer only):

- `PTY DATA` → host `DATA` → client `data` → broker streams bounded chunks → `sendData(ownerId)` → `stark:terminal:data` → owning xterm `term.write`.
- `PTY EXIT` → host `EXIT` (once, then host deletes session) → client `exit` → broker `sendExit(ownerId)` once, removes broker session → `stark:terminal:exit` → reducer `exit-received` + xterm writes `[Terminal exited]`.
- `create result` → `CREATED` resolves `create()`; `CREATE_FAILED` throws `We couldn't start the terminal.`
- `kill result` → `KILL_RESULT{initiated|gone|failed}` → broker maps: `initiated` = closing (exit finalizes later), `gone` = remove + `NotFound` (renderer finalizes), `failed` = `CloseFailed` (renderer restores live terminal). If EXIT/host-down already removed broker bookkeeping mid-flight, any outcome normalizes to `NotFound` (already-gone = success, never a failure).

Ownership at each layer:

- Renderer: presentation + xterm instances only. Never chooses shell/cwd/env. Kills by exact opaque id only.
- Preload: validation + transport. Drops malformed data/exit payloads.
- Main broker: policy (shell, cwd, env, caps, ownership). `requireOwnedSession` on every op; cross-owner access throws the same `no longer available` copy as unknown ids (no oracle).
- Host: execution only. Re-validates every inbound field; unknown/malformed messages ignored. Knows nothing of workspaces/renderers.
- PTY: one native handle per session, keyed by main-minted UUID.

## Core Invariants

1. Human PTYs never run on Electron main; the host owns all `node-pty` handles (`pty.kill()` appears only in `terminal-host.mjs`).
2. Exactly four renderer→main channels; no shell/executable/cwd/env choice, no `child_process`, no `taskkill/pkill`, no `shell:true`.
3. Output/exit route to the owning WebContents only (`sendToOwner`, destroyed renderers silently stop receiving).
4. One session = one independent PTY = one mounted xterm. Create never reuses/evicts; kill targets the exact id; siblings untouched.
5. Single view by default; a visible pair exists only via explicit `split-opened`. New/Duplicate/select/kill resolve to single view.
6. Titles are deterministic and monotonic (`PowerShell`, `PowerShell 2`, …), never reused after kills.
7. Cap is 8 live terminals per owner; over-cap creation fails calmly with no eviction (main authoritative, renderer pre-checks).
8. Two-phase close: `close-requested` hides now + retains instance; `close-finalized` unmounts/disposes; `close-aborted` restores the SAME instance (buffer intact) only when still `running`, else finalizes silently.
9. EXIT is authoritative: while closing it finalizes immediately; stale late failures never resurrect or show an error (generation token `terminalCloseGenRef` + reducer status guards).
10. Exited-row × needs no backend kill and shows no error. Natural exits keep the readable row until the user closes it.
11. Host crash yields one honest `exitCode:null` exit per session; next explicit create starts a fresh host (never a restart loop).
12. All bounds, no polling/loops/retries: 64 KiB message/data caps, id length 128, startup 10 s, stop 5 s, request 10 s, graceful PTY shutdown 5 s.
13. Renderer terminal state is local-only, never persisted; DB schema stays v19.

---

## Terminal Behaviors (current code truth)

- **Renderer Terminal activity**: rail `Terminal` activity owns the drawer (`TerminalDrawer` management surface); the terminal viewport stacks in the secondary region. Selecting the activity reveals the pane; hidden viewports keep PTYs.
- **Terminal drawer** (`TerminalDrawer.tsx`): New/Split/Duplicate actions + open-terminal list (closes via sibling × outside the select button, no bubbling). Active row uses magenta indicator (`--stark-magenta`). Shows `status` meta when not running, `Starting terminal…` while pending, calm `notice` copy. Explorer passes `sessions.filter(!closingIds.includes(id))`, so closing rows vanish instantly.
- **Multi-terminal state** (`terminal-state.ts`, pure, testable): `sessions[]`, `pending[]`, `activeId`, `closingIds`, `splitIds|[a,b]|null`, `splitRatio`, `titleCounters`, `notice`, `workspaceId`. `workspace-changed` resets everything.
- **Active selection**: `session-selected` moves `activeId` (+ focus follows via `terminalInstancesRef.get(activeId)?.focus()`); split-member click keeps the pair, outsider click singles the view. Closing ids cannot be selected/split/duplicated.
- **Single-view**: `visibleTerminalIds` returns the split pair only when both are open, else `[activeId]` or `[]`. `TerminalPanel` renders one pane per session in creation order keyed by id; visibility flips CSS only.
- **Split**: `handleSplitTerminal(sourceId)` requires live `running` non-closing source + cap, spawns a real second PTY, dispatches `split-opened`. Divider drag resizes via pointer capture, ratio clamped 0.2–0.8, narrow widths stack. `split-closed` or any member close collapses to the survivor.
- **Duplicate**: fresh PTY via same narrow create (never cloned state/history), lands in single view.
- **New**: cap pre-check → `spawnTerminal()` (`start-requested` → `api.create({workspaceId, cols, rows})` → `start-succeeded` + activate). Mid-spawn unmount kills the just-spawned PTY so none strand. Failures clear pending, keep selection, show calm copy.
- **Hide/show**: `display:none` on background panes; xterm stays mounted. Hiding never kills (kills only via exact kill, exit, confirmed workspace switch, window teardown).
- **Close/kill**: `handleKillTerminal(id)` — unknown → noop; `status!=='running'` → `close-finalized` locally (no IPC, no error); else single-flight (`terminalClosingRef` + reducer `closingIds`), generation++ , `close-requested` (drawer/viewport/selection/split resolve synchronously), then `api.kill`. Success or `That terminal session is no longer available.` → `close-finalized`; other failure → `close-aborted` + `We couldn't close the terminal.` iff generation still current (stale ignored). `finally` releases guards.
- **Exited-terminal**: natural `exit` (not closing) marks `exited`, writes `\r\n[Terminal exited]\r\n` into that xterm, row keeps `Exited` meta. × finalizes instantly. Stale `close-aborted` on exited/missing finalizes silently with no error.
- **Two-phase close**: see above. Retained hidden instance enables buffer-intact restore on genuine failure.
- **Race handling**: EXIT-while-closing finalizes + clears `closingIds` + `notice:null` with valid selection; broker post-await missing session → `NotFound` (success). Generation bump in `offExit` invalidates the in-flight kill.
- **xterm lifecycle** (`TerminalInstanceView`): one `Terminal` + `FitAddon` per `sessionId`, `open(container)`, `onRegister`, `onData` → `api.write` only while `runningRef`, `ResizeObserver` + rAF-debounced `fitAndReport` (clamped, change-only, resize only while running), `dispose()` exactly once on unmount (`onUnregister`).
- **Resizing**: FitAddon propose → `clampTerminalDimensions` (20–500 × 5–200) → `api.resize`. Main re-validates; invalid → safe error, PTY untouched.
- **Workspace ownership**: renderer sends only `workspaceId`; `TerminalService.resolveWorkspaceCwd` canonicalizes `rootPath` (missing → unavailable copy, never HOME fallback). Broker keys sessions by `ownerWebContentsId`; `handleWebContentsDestroyed` exact-kills owned sessions; app quit `shutdownAll` bounded.
- **Security boundaries**: closed IPC vocab; closed host protocol; bounded validated ids/payloads; safe public error copy only (no paths/PIDs/env/stacks); owner-only streaming; shell/env chosen in main; no worker/runtime/extension mixing in terminal paths.
- **Tests**: pure reducer suites, broker suites with fake host (incl. deferred-kill races), static source-invariant suites (exact kill, close ordering, single-flight, split guards, no generic process surface, v19), protocol/host lifecycle suites.
- **Build/packaging**: `npm run dev/build` copy `terminal-host-bootstrap.js` + `terminal-host.mjs` verbatim into `out/main`; `utilityProcess.fork` loads the bootstrap; dev self-heals missing artifacts, packaged builds log actionable errors.
- **Known limitations**: host crash kills all host PTYs (honest exits, manual recreate); ConPTY teardown can take seconds (hidden in host, UI already responsive); scrollback is display-only (5000 lines, no persistence); live PTYs never survive restart; cap is fixed at 8.

---

## Terminal File Inventory

### Renderer

- `src/renderer/src/features/terminal/terminal-state.ts` — Pure multi-terminal state: types, cap, deterministic titles, `visibleTerminalIds`, full reducer (start/exit/close/split/select/notice), data routing, dimension clamp. No xterm, no IPC.
- `src/renderer/src/features/terminal/TerminalDrawer.tsx` — Management drawer UI: New/Split/Duplicate + open-terminal rows with active magenta state and per-row ×. Presentational only.
- `src/renderer/src/features/terminal/TerminalDrawer.css` — Compact drawer styling (32 px rows, ellipsis, magenta active bar, no sideways scroll).
- `src/renderer/src/features/terminal/TerminalPanel.tsx` — Viewport root: one stably-keyed pane per session, CSS-only visibility, split layout + divider, empty state, per-pane Split/Clear/Close.
- `src/renderer/src/features/terminal/TerminalPanel.css` — Viewport styling (single/split layouts, panes, divider, empty state, xterm container, narrow stacking).
- `src/renderer/src/features/terminal/TerminalInstanceView.tsx` — One owned xterm per session: mount/open/register, keystroke + resize wiring, visibility hiding, dispose-on-unmount.
- `src/renderer/src/features/terminal/terminal-guard.ts` — Workspace-switch guard: `terminalActive` flag, kill-handler registration, confirm copy `Close the active terminal and switch projects?`.
- `src/renderer/src/features/terminal/terminal-dimensions.ts` — DOM-free dimension defaults mirroring main limits (80×24, bounds, 5000-line scrollback).
- `src/renderer/src/lib/terminal-api.ts` — Typed accessor `getTerminalApi()` returning the preload `terminal` bridge.
- `src/renderer/src/features/explorer/Explorer.tsx` *(terminal integration, excerpts in Source Code)* — Owns the terminal reducer + instance registry + all side effects: event subscriptions, spawn/split/duplicate/select/kill/clear, focus-follow, switch kill-all, drawer + panel wiring.

### Shared

- `src/shared/terminal/types.ts` — Plain-TS contracts for all three processes: `TerminalSession`, create/write/resize/kill requests, data/exit events, `TerminalApi` (exactly 4 invokes + 2 subscriptions).
- `src/shared/constants/index.ts` *(excerpt)* — IPC channel names: `stark:terminal:create|write|resize|kill` (invoke) and `stark:terminal:data|exit` (main→owner events).

### Preload

- `src/preload/index.ts` *(terminal bridge excerpt)* — `createTerminalApi()`: invoke passthrough for create/write/resize/kill; validated `onData`/`onExit` subscriptions; exposed as `terminal` on the Stark API.

### Main

- `src/main/terminal/terminal-manager.ts` — Broker lifecycle + ownership: UUID sessions per `ownerWebContentsId`, cap enforcement, write/resize/kill with exact ownership, two-phase kill with EXIT-wins normalization, exit-once delivery, owner-destroy + shutdown cleanup.
- `src/main/terminal/terminal-service.ts` — Create-request validation + trusted workspace→cwd resolution (canonical realpath, unavailable copy, never HOME).
- `src/main/terminal/shell-policy.ts` — Main-chosen shell data (win32/darwin/linux + fallback). No spawning.
- `src/main/terminal/terminal-environment.ts` — Main-built PTY env (filtered host env + `TERM`/`COLORTERM`/`TERM_PROGRAM`). Never logged.
- `src/main/terminal/errors.ts` — Stable user-facing error classes + `toPublicTerminalError` mapper (kill unknowns → `no longer available`).
- `src/main/terminal/limits.ts` — Single central limits (dims, 64 KiB I/O bounds, id length, cap 8, timeouts, scrollback).
- `src/main/terminal/pty-adapter.ts` — `PtyHandle`/`PtyFactory` interfaces + multibyte-safe `splitOutputForIpc`.
- `src/main/terminal/node-pty-adapter.ts` — Lazy production `PtyFactory` over `node-pty` (loads only in Electron main; unit tests inject fakes).
- `src/main/index.ts` *(terminal wiring excerpts)* — Artifact self-heal, `utilityProcess.fork` launcher, `TerminalHostManager` + `TerminalProcessClient` + `TerminalManager` construction, window-destroy cleanup, bounded quit shutdown, IPC wiring.

### Terminal Host

- `src/main/terminal/terminal-host.mjs` — Dependency-free host runtime owning every PTY: CREATE/WRITE/RESIZE/KILL/SHUTDOWN handling, DATA chunking, once-only EXIT, `KILL_RESULT{initiated|gone|failed}`, blocking kill isolated here.
- `src/main/terminal/terminal-host-bootstrap.js` — Sole host entrypoint: requires `parentPort`, loads `node-pty`, dynamically imports the sibling runtime, wires message transport. Exits(1) on any init failure.
- `src/main/terminal/terminal-host-manager.ts` — Main-side host broker: fork/startup bound (10 s), stop bound (5 s), correlated request bound (10 s), answer routing, crash→`crashed` (no restart loop), exact-handle kill only.
- `src/main/terminal/terminal-host-client.ts` — `TerminalHostClient` interface + `TerminalProcessClient` (CREATE/KILL correlation, DATA/EXIT translation, request failure → `failed`) + call-recording stub.
- `src/main/terminal/terminal-host-fake.ts` — Unit-test fake: recorded creates/writes/resizes/kills, configurable outcomes, explicit `fireData/fireExit/fireHostDown`, deferred-kill gate.
- `src/main/terminal/terminal-host-protocol.ts` — Versioned closed protocol `stark-terminal-host/v1`: direction vocabularies, 64 KiB caps, builders + strict parsers for both directions.
- `src/main/terminal/terminal-host-paths.ts` — Artifact locations: `out/main` canonical dir, verbatim copy list, completeness/missing/ensure helpers, dev source derivation.

### IPC

- `src/main/ipc/terminal.ts` — Exactly four invoke bindings (create/write/resize/kill) with sender-derived ownership + owner-only `createTerminalEventSink` (`sendData`/`sendExit` via `webContents.fromId`, best-effort).

### Build / Packaging

- `scripts/copy-terminal-host-bootstrap.cjs` — Copies `terminal-host-bootstrap.js` + `terminal-host.mjs` verbatim to `out/main`; fails build if sources missing.
- `package.json` *(scripts excerpt)* — `dev`/`build` run both host copy scripts around `electron-vite`; `node-pty` dependency ships prebuilds unpacked via `asarUnpack`.
- `electron.vite.config.ts` *(excerpt)* — main/preload/renderer artifacts; renderer gets no Node access; preload is single-file CJS; host files are copied, never bundled.

### Tests

- `src/renderer/src/features/terminal/terminal-state.test.ts` — Pure reducer: start/titles/cap/selection/split/close/exit races CASE 1–7, stale-abort guards, split validity, workspace reset, dims, switch guard, exit-in-split retention, concurrent-creation cap/pending hygiene.
- `src/renderer/src/features/terminal/terminal-activity.test.ts` — Static source invariants: drawer/panel structure, exact-id kills, close ordering, single-flight, exited fast-path, generation invalidation + unconditional release (B6), concurrent switch kill-all, kill-all naming, security + v19.
- `src/main/terminal/terminal-manager.test.ts` — Broker with fake host: create/cap/write/resize, prompt initiated kill, gone/failed mapping, deferred-kill races (EXIT/host-down mid-flight → already-gone), per-owner isolation, crash + shutdown + once-only exit, cap-counts-tracked (B3), ack-loss cleanup (B2), destroy-during-CREATE (B4), failed-kill retention until EXIT (B4), ownerGone front-door/cap behavior.
- `src/main/terminal/terminal-host-protocol.test.ts` — Envelope/cap/schema validation both directions, vocabulary parity.
- `src/main/terminal/terminal-host-manager.test.ts` — Fork/startup/stop/request bounds, crash semantics, no auto-restart, stop-during-start settles waiters (B5), pre-READY exit, exact-kill-on-stop (B1), prompt exit-during-stopping settle, double stop, old-generation message drop (§10), unknown-requestId drop (§11).
- `src/main/terminal/terminal-host-runtime.test.ts` — Host runtime with fake PTY: spawn/stream/resize/kill/EXIT-once/validation.
- `src/main/terminal/terminal-host-isolation.test.ts` — Real forked-host proof with real ConPTY: blocking kill never stalls the parent loop, sibling round-trip SLO (< 5 s unconditional) during the kill window, exact host cleanup with no orphans.
- `src/main/terminal/terminal-host-paths.test.ts` — Artifact completeness/copy/dev-path behavior.
- `src/main/terminal/terminal-service.test.ts` + `src/main/ipc/terminal-bindings.test.ts` + `terminal-contract.test.ts` + `terminal-output.test.ts` — Request validation, cwd resolution, binding ownership/error mapping, channel contract, bounded output chunking.

---

# Source Code

## src/renderer/src/features/terminal/terminal-state.ts

```ts
import type { TerminalExitEvent, TerminalSession } from '../../../../shared/terminal/types'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from './terminal-dimensions'

export { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS }

/**
 * Pure multi-terminal session state. No xterm, no IPC here — the
 * Explorer owns side effects, this module owns transitions, so the
 * lifecycle is unit-testable: explicit starts per terminal, running,
 * exit, exact removal, active selection, split visibility, the human
 * cap, and workspace reset.
 *
 * Three concepts stay strictly separate (VS Code model):
 * - sessions: every live human terminal (drawer lists all of these).
 * - activeId: the single selected terminal (magenta row, input focus).
 * - splitIds: the explicit split pair, or null in normal single view.
 * Only Split Terminal ever sets splitIds; New, Duplicate, plain
 * selection, and kills always resolve back to single view. Two
 * canvases without an explicit split are unrepresentable.
 *
 * Human terminals only: worker/runtime/extension processes never
 * appear here. Live PTYs are runtime resources — never persisted, so
 * restart assumes nothing alive. Schema untouched (v19).
 */

export type HumanTerminalStatus = 'starting' | 'running' | 'exited'

export interface HumanTerminalEntry {
  /** Opaque main-owned session id (stable per PTY). */
  readonly id: string
  /** Shell label from main (e.g. PowerShell). */
  readonly shell: string
  /** Deterministic drawer/viewport title (e.g. PowerShell 2). */
  readonly title: string
  readonly status: HumanTerminalStatus
  /** Calm per-terminal failure copy (start failures only). */
  readonly error: string | null
  readonly exit: TerminalExitEvent | null
}

/** Pending creation (no PTY yet): tracked so failures clean up. */
export interface PendingTerminalEntry {
  readonly key: string
}

export interface TerminalSessionsState {
  readonly workspaceId: number | null
  readonly sessions: readonly HumanTerminalEntry[]
  /** Creations in flight (renderer-local keys, never PTYs). */
  readonly pending: readonly PendingTerminalEntry[]
  /** Active terminal for input/focus; always a live session id or null. */
  readonly activeId: string | null
  /**
   * Kills in flight (exact session ids): presentation is removed
   * immediately on close-requested while the backend kill completes
   * asynchronously; the id clears when its exit arrives. Bounds
   * double-close, and selection/split/duplicate never target these.
   * Renderer-local only, never persisted.
   */
  readonly closingIds: readonly string[]
  /**
   * Explicit split pair (two visible canvases) or null for the normal
   * single view. ONLY Split Terminal sets this; every other action
   * clears or preserves it per the selection rules below.
   */
  readonly splitIds: readonly [string, string] | null
  /** Split divider ratio (0..1, first pane share); null when single. */
  readonly splitRatio: number | null
  /** Per-shell title counters (monotonic, never reused after kills). */
  readonly titleCounters: Readonly<Record<string, number>>
  /** Calm global notice (cap reached, spawn failure). */
  readonly notice: string | null
}

export function initialTerminalSessionsState(): TerminalSessionsState {
  return {
    workspaceId: null,
    sessions: [],
    pending: [],
    activeId: null,
    closingIds: [],
    splitIds: null,
    splitRatio: null,
    titleCounters: {},
    notice: null
  }
}

/** Hard cap on live human terminals (main enforces authoritatively). */
export const MAX_HUMAN_TERMINALS = 8

/** Calm cap copy (mirrors the main-side limit error). */
export const TERMINAL_LIMIT_NOTICE = 'Too many terminals are open. Close one before creating another.'

/** True while a creation may start (below the cap). */
export function canCreateTerminal(state: TerminalSessionsState): boolean {
  return state.sessions.length + state.pending.length < MAX_HUMAN_TERMINALS
}

/**
 * Deterministic display title for a new terminal of one shell:
 * bare label while no sibling of that shell exists, otherwise a
 * monotonic suffix that is never reused after kills (PowerShell,
 * PowerShell 2, PowerShell 3, …).
 */
export function nextTerminalTitle(
  sessions: readonly HumanTerminalEntry[],
  counters: Readonly<Record<string, number>>,
  shell: string
): { readonly title: string; readonly counters: Readonly<Record<string, number>> } {
  const related = sessions.filter((entry) => entry.title === shell || entry.title.startsWith(`${shell} `))
  if (related.length === 0 && (counters[shell] ?? 0) === 0) {
    return { title: shell, counters }
  }
  const taken = new Set(sessions.map((entry) => entry.title))
  let suffix = Math.max(counters[shell] ?? 0, related.length) + 1
  while (taken.has(`${shell} ${suffix}`)) {
    suffix += 1
  }
  return { title: `${shell} ${suffix}`, counters: { ...counters, [shell]: suffix } }
}

export type TerminalSessionsAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'start-requested'; readonly key: string }
  | { readonly type: 'start-succeeded'; readonly key: string; readonly session: TerminalSession; readonly title: string }
  | { readonly type: 'start-failed'; readonly key: string; readonly message: string }
  | { readonly type: 'exit-received'; readonly exit: TerminalExitEvent }
  | { readonly type: 'close-requested'; readonly sessionId: string }
  | { readonly type: 'close-finalized'; readonly sessionId: string }
  | { readonly type: 'close-aborted'; readonly sessionId: string; readonly message: string }
  | { readonly type: 'session-removed'; readonly sessionId: string }
  | { readonly type: 'session-selected'; readonly sessionId: string }
  | { readonly type: 'split-opened'; readonly sessionIds: readonly [string, string] }
  | { readonly type: 'split-ratio-changed'; readonly ratio: number }
  | { readonly type: 'split-closed' }
  | { readonly type: 'notice-shown'; readonly message: string }
  | { readonly type: 'notice-dismissed' }

function liveIds(state: TerminalSessionsState): readonly string[] {
  return state.sessions.map((entry) => entry.id)
}

/**
 * The single ordered list of ids the viewport renders: the explicit
 * split pair while split, otherwise exactly the active terminal.
 * Closing terminals are never visible (presentation hides on
 * close-requested) while their instances stay mounted until
 * close-finalized — so a failed kill restores the same xterm with
 * its buffer intact instead of recreating an empty one.
 */
export function visibleTerminalIds(state: TerminalSessionsState): readonly string[] {
  const ids = new Set(liveIds(state))
  const open = (id: string): boolean => ids.has(id) && !state.closingIds.includes(id)
  if (state.splitIds !== null) {
    const [first, second] = state.splitIds
    if (open(first) && open(second)) {
      return [first, second]
    }
  }
  return state.activeId !== null && open(state.activeId) ? [state.activeId] : []
}

function withValidSelection(state: TerminalSessionsState): TerminalSessionsState {
  const ids = new Set(liveIds(state).filter((id) => !state.closingIds.includes(id)))
  const activeId = state.activeId !== null && ids.has(state.activeId) ? state.activeId : [...ids][0] ?? null
  const splitIds =
    state.splitIds !== null && ids.has(state.splitIds[0]) && ids.has(state.splitIds[1]) ? state.splitIds : null
  return {
    ...state,
    activeId,
    splitIds,
    splitRatio: splitIds !== null ? (state.splitRatio ?? 0.5) : null
  }
}

export function terminalSessionsReducer(
  state: TerminalSessionsState,
  action: TerminalSessionsAction
): TerminalSessionsState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialTerminalSessionsState(), workspaceId: action.workspaceId }
    case 'start-requested': {
      if (state.workspaceId === null || !canCreateTerminal(state)) {
        return state
      }
      return {
        ...state,
        pending: [...state.pending, { key: action.key }],
        notice: null
      }
    }
    case 'start-succeeded': {
      if (!state.pending.some((entry) => entry.key === action.key)) {
        return state
      }
      const titled = nextTerminalTitle(state.sessions, state.titleCounters, action.session.shell)
      const entry: HumanTerminalEntry = {
        id: action.session.id,
        shell: action.session.shell,
        title: action.title !== '' ? action.title : titled.title,
        status: 'running',
        error: null,
        exit: null
      }
      return {
        ...state,
        sessions: [...state.sessions, entry],
        pending: state.pending.filter((pending) => pending.key !== action.key),
        titleCounters: action.title !== '' ? state.titleCounters : titled.counters,
        activeId: entry.id,
        // New/Duplicate always land in normal single view, even when
        // invoked while split (VS Code-like; the pair keeps running).
        splitIds: null,
        splitRatio: null,
        notice: null
      }
    }
    case 'start-failed': {
      if (!state.pending.some((entry) => entry.key === action.key)) {
        return state
      }
      // Failed creations leave no instance behind; the selection stays
      // valid and the failure surfaces as calm notice copy only.
      return {
        ...state,
        pending: state.pending.filter((pending) => pending.key !== action.key),
        notice: action.message
      }
    }
    case 'exit-received': {
      // EXIT is authoritative evidence the process is gone. While a
      // close is in flight (closingIds) it wins the race outright:
      // finalize removal now so a late stale kill-failure can never
      // resurrect the dead terminal or raise a close error. Natural
      // exits (not closing) keep the readable [Terminal exited] row.
      const known = state.sessions.some((entry) => entry.id === action.exit.sessionId)
      const wasClosing = state.closingIds.includes(action.exit.sessionId)
      if (!known && !wasClosing) {
        return state
      }
      if (wasClosing) {
        if (!known) {
          return {
            ...state,
            closingIds: state.closingIds.filter((id) => id !== action.exit.sessionId)
          }
        }
        return withValidSelection({
          ...state,
          sessions: state.sessions.filter((entry) => entry.id !== action.exit.sessionId),
          closingIds: state.closingIds.filter((id) => id !== action.exit.sessionId),
          notice: null
        })
      }
      if (!known) {
        return state
      }
      return {
        ...state,
        sessions: state.sessions.map((entry) =>
          entry.id === action.exit.sessionId ? { ...entry, status: 'exited' as const, exit: action.exit } : entry
        )
      }
    }
    case 'close-requested': {
      // Immediate presentation hide in the same tick — drawer row,
      // viewport pane, replacement selection, and split collapse all
      // resolve now — while the SESSION IS RETAINED with its mounted
      // xterm: only close-finalized unmounts it. Unknown or already
      // closing ids are no-ops (single-flight).
      if (
        !state.sessions.some((entry) => entry.id === action.sessionId) ||
        state.closingIds.includes(action.sessionId)
      ) {
        return state
      }
      return withValidSelection({
        ...state,
        closingIds: [...state.closingIds, action.sessionId],
        notice: null
      })
    }
    case 'close-finalized': {
      // Termination initiated (or already gone): the instance may now
      // unmount and dispose. Unknown ids are no-ops.
      if (
        !state.sessions.some((entry) => entry.id === action.sessionId) &&
        !state.closingIds.includes(action.sessionId)
      ) {
        return state
      }
      return withValidSelection({
        ...state,
        sessions: state.sessions.filter((entry) => entry.id !== action.sessionId),
        closingIds: state.closingIds.filter((id) => id !== action.sessionId),
        notice: null
      })
    }
    case 'close-aborted': {
      // Initiation failed: restore ONLY when the terminal is still
      // alive (status running). An already-exited or already-removed
      // terminal is authoritative gone — finalize silently with no
      // error so a stale late failure can never resurrect it.
      const entry = state.sessions.find((candidate) => candidate.id === action.sessionId)
      if (entry === undefined) {
        return state.closingIds.includes(action.sessionId)
          ? { ...state, closingIds: state.closingIds.filter((id) => id !== action.sessionId) }
          : state
      }
      if (entry.status !== 'running') {
        return withValidSelection({
          ...state,
          sessions: state.sessions.filter((candidate) => candidate.id !== action.sessionId),
          closingIds: state.closingIds.filter((id) => id !== action.sessionId),
          notice: null
        })
      }
      return {
        ...state,
        closingIds: state.closingIds.filter((id) => id !== action.sessionId),
        activeId: action.sessionId,
        splitIds: null,
        splitRatio: null,
        notice: action.message
      }
    }
    case 'session-removed': {
      if (!state.sessions.some((entry) => entry.id === action.sessionId)) {
        return state
      }
      return withValidSelection({
        ...state,
        sessions: state.sessions.filter((entry) => entry.id !== action.sessionId),
        closingIds: state.closingIds.filter((id) => id !== action.sessionId),
        notice: null
      })
    }
    case 'session-selected': {
      if (
        !state.sessions.some((entry) => entry.id === action.sessionId) ||
        state.closingIds.includes(action.sessionId)
      ) {
        return state
      }
      // Split member click keeps the pair (and its ratio); any other
      // click exits split presentation to that terminal alone. Both
      // split PTYs keep running in the background either way.
      const keepSplit = state.splitIds !== null && state.splitIds.includes(action.sessionId)
      return {
        ...state,
        activeId: action.sessionId,
        splitIds: keepSplit ? state.splitIds : null,
        splitRatio: keepSplit ? state.splitRatio : null,
        notice: null
      }
    }
    case 'split-opened': {
      const [first, second] = action.sessionIds
      const ids = new Set(liveIds(state).filter((id) => !state.closingIds.includes(id)))
      if (!ids.has(first) || !ids.has(second) || first === second) {
        return state
      }
      return { ...state, activeId: first, splitIds: [first, second], splitRatio: state.splitRatio ?? 0.5, notice: null }
    }
    case 'split-ratio-changed': {
      if (state.splitIds === null) {
        return state
      }
      if (!Number.isFinite(action.ratio) || action.ratio < 0.2 || action.ratio > 0.8) {
        return state
      }
      return { ...state, splitRatio: action.ratio }
    }
    case 'split-closed': {
      if (state.splitIds === null) {
        return state
      }
      const active = state.activeId !== null && state.splitIds.includes(state.activeId) ? state.activeId : state.splitIds[0]
      if (active === undefined) {
        return state
      }
      return { ...state, activeId: active, splitIds: null, splitRatio: null }
    }
    case 'notice-dismissed':
      return { ...state, notice: null }
    case 'notice-shown':
      return { ...state, notice: action.message }
    default:
      return state
  }
}

/**
 * Routes an incoming PTY data event to a live session id.
 * Returns the payload when the session exists (any status that can
 * still hold a viewport); otherwise null (unknown/dead sessions are
 * ignored).
 */
export function routeTerminalDataToSession(
  state: TerminalSessionsState,
  event: { readonly sessionId: string; readonly data: string }
): { readonly sessionId: string; readonly data: string } | null {
  if (!state.sessions.some((entry) => entry.id === event.sessionId)) {
    return null
  }
  return { sessionId: event.sessionId, data: event.data }
}

/** Clamps FitAddon-measured dimensions into the main-enforced bounds. */
export function clampTerminalDimensions(cols: number, rows: number): { cols: number; rows: number } {
  const safeCols = Number.isInteger(cols) ? cols : DEFAULT_TERMINAL_COLS
  const safeRows = Number.isInteger(rows) ? rows : DEFAULT_TERMINAL_ROWS
  return {
    cols: Math.min(500, Math.max(20, safeCols)),
    rows: Math.min(200, Math.max(5, safeRows))
  }
}
```

## src/renderer/src/features/terminal/TerminalDrawer.tsx

```tsx
import type { ReactElement } from 'react'
import { StarkIcon } from '../../components/icons/StarkIcon'
import type { HumanTerminalEntry } from './terminal-state'

interface TerminalDrawerProps {
  readonly sessions: readonly HumanTerminalEntry[]
  readonly activeId: string | null
  /** A creation is in flight (New stays available; no double spawn). */
  readonly starting: boolean
  readonly atCap: boolean
  /** Calm notice (cap reached, spawn failure). */
  readonly notice: string | null
  readonly onNew: () => void
  readonly onSplit: () => void
  readonly onDuplicate: () => void
  readonly onSelect: (sessionId: string) => void
  readonly onKill: (sessionId: string) => void
}

/**
 * Terminal management drawer (activity surface only): New/Split/
 * Duplicate actions plus the open-terminal list with active
 * selection. Every control performs its real action — no dead
 * buttons. Human terminals only; worker/runtime processes never
 * appear here. No PTY, xterm, or IPC in this file.
 */
export function TerminalDrawer({
  sessions,
  activeId,
  starting,
  atCap,
  notice,
  onNew,
  onSplit,
  onDuplicate,
  onSelect,
  onKill
}: TerminalDrawerProps): ReactElement {
  const canManage = activeId !== null && sessions.some((entry) => entry.id === activeId && entry.status === 'running')
  return (
    <div className="terminal-drawer" aria-label="Terminal management">
      <button
        className="terminal-drawer__new"
        type="button"
        onClick={onNew}
        disabled={atCap}
        aria-label="New terminal"
        title={atCap ? 'Too many terminals are open' : 'New terminal'}
      >
        <StarkIcon name="plus" size={14} />
        <span>New terminal</span>
      </button>
      <p className="terminal-drawer__section" aria-hidden="true">
        Actions
      </p>
      <div className="terminal-drawer__actions" role="group" aria-label="Terminal actions">
        <button
          className="terminal-drawer__action"
          type="button"
          onClick={onSplit}
          disabled={!canManage}
          aria-label="Split terminal"
          title={canManage ? 'Split terminal' : 'Start a terminal first'}
        >
          Split terminal
        </button>
        <button
          className="terminal-drawer__action"
          type="button"
          onClick={onDuplicate}
          disabled={!canManage}
          aria-label="Duplicate terminal"
          title={canManage ? 'Duplicate terminal' : 'Start a terminal first'}
        >
          Duplicate terminal
        </button>
      </div>
      {starting && (
        <p className="terminal-drawer__status" role="status">
          Starting terminal…
        </p>
      )}
      {notice !== null && (
        <p className="terminal-drawer__notice" role="status">
          {notice}
        </p>
      )}
      <p className="terminal-drawer__section" aria-hidden="true">
        Open terminals
      </p>
      {sessions.length === 0 && !starting ? (
        <p className="terminal-drawer__empty">No terminals running.</p>
      ) : (
        <ul className="terminal-drawer__list" aria-label="Open terminals">
          {sessions.map((entry) => {
            const active = entry.id === activeId
            return (
              <li key={entry.id} className="terminal-drawer__row-wrap">
                <button
                  className={active ? 'terminal-drawer__row terminal-drawer__row--active' : 'terminal-drawer__row'}
                  type="button"
                  onClick={() => onSelect(entry.id)}
                  aria-label={active ? `${entry.title} (active terminal)` : `Switch to ${entry.title}`}
                  aria-current={active}
                  title={entry.title}
                >
                  <span className="terminal-drawer__indicator" aria-hidden="true" />
                  <StarkIcon name="terminal" size={14} />
                  <span className="terminal-drawer__title">{entry.title}</span>
                  {entry.status !== 'running' && <span className="terminal-drawer__meta">{entry.status}</span>}
                </button>
                <button
                  className="terminal-drawer__kill"
                  type="button"
                  onClick={() => onKill(entry.id)}
                  aria-label={`Close ${entry.title}`}
                  title={`Close ${entry.title}`}
                >
                  <StarkIcon name="close" size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
```

## src/renderer/src/features/terminal/TerminalPanel.tsx

```tsx
import { Fragment, useRef, type ReactElement } from 'react'
import type { Terminal } from '@xterm/xterm'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { TerminalInstanceView } from './TerminalInstanceView'
import type { HumanTerminalEntry } from './terminal-state'
import './TerminalPanel.css'

interface TerminalPanelProps {
  readonly sessions: readonly HumanTerminalEntry[]
  readonly activeId: string | null
  readonly visibleIds: readonly string[]
  readonly splitRatio: number | null
  readonly starting: boolean
  readonly onNew: () => void
  readonly onSplitPane: (sessionId: string) => void
  readonly onClearPane: (sessionId: string) => void
  readonly onClosePane: (sessionId: string) => void
  readonly onSplitRatioChange: (ratio: number) => void
  readonly onRegisterInstance: (sessionId: string, term: Terminal) => void
  readonly onUnregisterInstance: (sessionId: string) => void
}

/**
 * Multi-terminal viewport root (human terminals only).
 *
 * Exactly one TerminalInstanceView per live session, keyed by session
 * id in stable creation order — selection changes only toggle CSS
 * visibility, never remount. That is what preserves PTY processes,
 * buffers, scrollback, and command state across switches: unmounting
 * would dispose the xterm and lose everything. Split panes are
 * independent: input routes by construction, killing one never
 * touches the other. Presentational only: session lifecycle lives in
 * the Explorer-owned reducer.
 */
export function TerminalPanel({
  sessions,
  activeId,
  visibleIds,
  splitRatio,
  starting,
  onNew,
  onSplitPane,
  onClearPane,
  onClosePane,
  onSplitRatioChange,
  onRegisterInstance,
  onUnregisterInstance
}: TerminalPanelProps): ReactElement {
  const splitRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ readonly pointerId: number } | null>(null)

  const visibleCount = visibleIds.filter((id) => sessions.some((entry) => entry.id === id)).length
  const split = visibleCount === 2
  const ratio = splitRatio ?? 0.5

  function handleDividerPointerDown(event: React.PointerEvent): void {
    if (event.button !== 0 || !split) {
      return
    }
    dragRef.current = { pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleDividerPointerMove(event: React.PointerEvent): void {
    const drag = dragRef.current
    const container = splitRef.current
    if (drag === null || drag.pointerId !== event.pointerId || container === null) {
      return
    }
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) {
      return
    }
    onSplitRatioChange((event.clientX - rect.left) / rect.width)
  }

  function handleDividerPointerEnd(event: React.PointerEvent): void {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Best effort; the drag is over either way.
    }
  }

  if (sessions.length === 0) {
    return (
      <section className="terminal terminal--empty" aria-label="Terminal">
        <p className="terminal__empty-title">Terminal</p>
        <p className="terminal__empty-copy">{starting ? 'Starting terminal…' : 'No terminals running.'}</p>
        {!starting && (
          <button className="explorer__primary" type="button" onClick={onNew}>
            New terminal
          </button>
        )}
      </section>
    )
  }

  return (
    <section className="terminal" aria-label="Terminal">
      <div ref={splitRef} className={split ? 'terminal-split' : 'terminal-single'}>
        {sessions.map((entry) => {
          // Stable key in creation order: toggling visibility below
          // only flips CSS, so React never remounts (and never
          // disposes) the xterm on selection changes.
          const active = entry.id === activeId
          const visibleIndex = visibleIds.indexOf(entry.id)
          const isVisible = visibleIndex !== -1
          const paneStyle = !isVisible
            ? { display: 'none' }
            : split
              ? {
                  flexGrow: 0,
                  flexShrink: 0,
                  flexBasis: `${(visibleIndex === 0 ? ratio : 1 - ratio) * 100}%`
                }
              : undefined
          return (
            <Fragment key={entry.id}>
              <div
                className={active ? 'terminal-pane terminal-pane--active' : 'terminal-pane'}
                style={paneStyle}
                aria-label={active ? `${entry.title} (active terminal)` : entry.title}
              >
                <div className="terminal-pane__header">
                  <StarkIcon name="terminal" size={14} />
                  <span className="terminal-pane__title">{entry.title}</span>
                  {entry.status !== 'running' && <span className="terminal-pane__meta">{entry.status}</span>}
                  <span className="terminal-pane__spacer" aria-hidden="true" />
                  <button
                    className="terminal-pane__iconbtn"
                    type="button"
                    onClick={() => onSplitPane(entry.id)}
                    disabled={entry.status !== 'running'}
                    aria-label={`Split ${entry.title}`}
                    title={entry.status === 'running' ? `Split ${entry.title}` : 'Start state cannot split'}
                  >
                    Split
                  </button>
                  <button
                    className="terminal-pane__iconbtn"
                    type="button"
                    onClick={() => onClearPane(entry.id)}
                    aria-label={`Clear ${entry.title}`}
                    title={`Clear ${entry.title}`}
                  >
                    Clear
                  </button>
                  <button
                    className="terminal-pane__iconbtn"
                    type="button"
                    onClick={() => onClosePane(entry.id)}
                    aria-label={`Close ${entry.title}`}
                    title={`Close ${entry.title}`}
                  >
                    <StarkIcon name="close" size={12} />
                  </button>
                </div>
                <TerminalInstanceView
                  sessionId={entry.id}
                  running={entry.status === 'running'}
                  visible={isVisible}
                  onRegister={onRegisterInstance}
                  onUnregister={onUnregisterInstance}
                />
              </div>
              {split && visibleIndex === 0 && (
                <div
                  className="terminal-split__divider"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize split terminals"
                  aria-valuenow={Math.round(ratio * 100)}
                  aria-valuemin={20}
                  aria-valuemax={80}
                  tabIndex={0}
                  onPointerDown={handleDividerPointerDown}
                  onPointerMove={handleDividerPointerMove}
                  onPointerUp={handleDividerPointerEnd}
                  onPointerCancel={handleDividerPointerEnd}
                />
              )}
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}
```

## src/renderer/src/features/terminal/TerminalInstanceView.tsx

```tsx
import { useEffect, useRef, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getTerminalApi } from '../../lib/terminal-api'
import { clampTerminalDimensions } from './terminal-state'
import { TERMINAL_SCROLLBACK_LINES } from './terminal-dimensions'

interface TerminalInstanceViewProps {
  /** Opaque main-owned session id (stable per PTY). */
  readonly sessionId: string
  /** True while the PTY is alive (keystrokes/resize flow only then). */
  readonly running: boolean
  /** False for background instances (kept mounted, buffer preserved). */
  readonly visible: boolean
  readonly onRegister: (sessionId: string, term: Terminal) => void
  readonly onUnregister: (sessionId: string) => void
}

/**
 * One owned xterm instance bound to exactly one PTY session.
 *
 * The component stays mounted while its session lives — including
 * while hidden (display:none) — so the PTY process, output buffer,
 * and scroll position survive tab switches. Keystrokes route by
 * construction (this instance's session id only); typing in a split
 * neighbor can never reach this PTY. Disposal happens exactly once
 * on unmount (session removal).
 */
export function TerminalInstanceView({
  sessionId,
  running,
  visible,
  onRegister,
  onUnregister
}: TerminalInstanceViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef(sessionId)
  const runningRef = useRef(running)
  const resizeFrame = useRef<number | null>(null)
  const lastDims = useRef<{ cols: number; rows: number } | null>(null)

  useEffect(() => {
    sessionRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    runningRef.current = running
  }, [running])

  // Mount exactly one xterm for this session; dispose on unmount.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) {
      return
    }
    let term: Terminal | null = null
    try {
      term = new Terminal({
        allowTransparency: false,
        convertEol: false,
        cursorBlink: true,
        fontFamily: "'JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace",
        fontSize: 13,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        theme: {
          background: '#0a0c0a',
          foreground: '#e9f1ea',
          cursor: '#c8ff00',
          selectionBackground: 'rgba(200, 255, 0, 0.25)'
        }
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      terminalRef.current = term
      fitRef.current = fit
      onRegister(sessionRef.current, term)
      term.onData((data) => {
        if (!runningRef.current) {
          return
        }
        const api = getTerminalApi()
        if (api === undefined) {
          return
        }
        api.write({ sessionId: sessionRef.current, data }).catch(() => {
          // Write failures surface via exit/error paths; keep typing alive.
        })
      })
    } catch {
      term = null
    }
    return () => {
      onUnregister(sessionRef.current)
      try {
        term?.dispose()
      } catch {
        // Best effort during teardown.
      } finally {
        if (terminalRef.current === term) {
          terminalRef.current = null
          fitRef.current = null
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  function fitAndReport(): void {
    const term = terminalRef.current
    const fit = fitRef.current
    if (term === null || fit === null || !runningRef.current) {
      return
    }
    try {
      fit.fit()
    } catch {
      return
    }
    const proposed = fit.proposeDimensions()
    if (proposed === undefined || proposed.cols <= 0 || proposed.rows <= 0) {
      return
    }
    const dims = clampTerminalDimensions(proposed.cols, proposed.rows)
    const last = lastDims.current
    if (last !== null && last.cols === dims.cols && last.rows === dims.rows) {
      return
    }
    lastDims.current = dims
    const api = getTerminalApi()
    if (api === undefined) {
      return
    }
    api.resize({ sessionId: sessionRef.current, cols: dims.cols, rows: dims.rows }).catch(() => {
      // Resize failures are non-fatal; the shell keeps running.
    })
  }

  // Refit when revealed (hidden containers measure zero) and on
  // container resizes (rAF debounce, single observer, full cleanup).
  // Hidden instances stay mounted (buffer preserved) but observe
  // nothing: a display:none container only ever measures zero, so
  // observing it would churn rAF without ever reporting a resize.
  useEffect(() => {
    if (visible) {
      fitAndReport()
    } else {
      return
    }
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (resizeFrame.current !== null) {
        cancelAnimationFrame(resizeFrame.current)
      }
      resizeFrame.current = requestAnimationFrame(() => {
        resizeFrame.current = null
        fitAndReport()
      })
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (resizeFrame.current !== null) {
        cancelAnimationFrame(resizeFrame.current)
        resizeFrame.current = null
      }
    }
  }, [visible, sessionId])

  return (
    <div
      ref={containerRef}
      className="terminal__xterm"
      role="application"
      aria-label="Terminal"
      style={visible ? undefined : { display: 'none' }}
    />
  )
}
```

## src/renderer/src/features/terminal/TerminalDrawer.css

```css
/* Terminal management drawer: compact VS Code-like density, no cards. */
.terminal-drawer {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--stark-space-sm) var(--stark-space-md) var(--stark-space-md);
}

.terminal-drawer__new {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 10px;
  font-family: var(--stark-font-sans);
  font-size: 12px;
  font-weight: 700;
  color: var(--stark-accent-text);
  background: var(--stark-accent);
  border: 1px solid transparent;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}

.terminal-drawer__new:disabled {
  opacity: 0.45;
  cursor: default;
}

.terminal-drawer__section {
  flex: 0 0 auto;
  margin: var(--stark-space-md) 0 var(--stark-space-xs);
  font-family: var(--stark-font-sans);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--stark-text-dim);
}

.terminal-drawer__actions {
  flex: 0 0 auto;
  display: flex;
  gap: var(--stark-space-xs);
}

.terminal-drawer__action {
  flex: 1 1 0;
  min-width: 0;
  min-height: 30px;
  padding: 4px 8px;
  font-family: var(--stark-font-sans);
  font-size: 12px;
  font-weight: 700;
  color: var(--stark-text);
  background: transparent;
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.terminal-drawer__action:disabled {
  opacity: 0.45;
  cursor: default;
}

.terminal-drawer__status,
.terminal-drawer__notice,
.terminal-drawer__empty {
  flex: 0 0 auto;
  margin: var(--stark-space-sm) 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--stark-text-dim);
}

.terminal-drawer__list {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.terminal-drawer__row-wrap {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--stark-border);
}

.terminal-drawer__row {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 4px 6px;
  font-family: var(--stark-font-sans);
  font-size: 12px;
  color: var(--stark-text-dim);
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  cursor: pointer;
  text-align: left;
}

.terminal-drawer__row--active {
  color: var(--stark-text);
  border-left-color: var(--stark-magenta);
  background: var(--stark-elevated);
}

.terminal-drawer__indicator {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}

.terminal-drawer__row--active .terminal-drawer__indicator {
  background: var(--stark-magenta);
}

.terminal-drawer__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
}

.terminal-drawer__row--active .terminal-drawer__title {
  color: var(--stark-text);
}

.terminal-drawer__meta {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--stark-text-dim);
  text-transform: capitalize;
}

.terminal-drawer__kill {
  flex: 0 0 auto;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  color: var(--stark-text-dim);
  background: transparent;
  border: none;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
}

.terminal-drawer__kill:hover {
  color: var(--stark-text);
  background: var(--stark-elevated);
}
```

## src/renderer/src/features/terminal/TerminalPanel.css

```css
.terminal {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-top: 1px solid var(--stark-border);
  background: transparent;
  overflow: hidden;
}

.terminal__bar {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--stark-space-sm);
  row-gap: 6px;
  min-height: 40px;
  padding: var(--stark-space-xs) var(--stark-space-md);
  background: var(--stark-surface);
}

.terminal__identity {
  display: flex;
  align-items: baseline;
  gap: var(--stark-space-sm);
  min-width: 0;
  flex: 1;
}

.terminal__title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--stark-text-dim);
}

.terminal__shell {
  font-family: var(--stark-font-mono);
  font-size: 11px;
  color: var(--stark-accent);
  white-space: nowrap;
}

.terminal__status {
  font-family: var(--stark-font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--stark-text-dim);
  white-space: nowrap;
}

.terminal__actions {
  display: flex;
  align-items: center;
  gap: var(--stark-space-xs);
  flex-shrink: 0;
}

.terminal__primary {
  padding: var(--stark-space-xs) var(--stark-space-sm);
  font-size: 12px;
  font-weight: 700;
  color: var(--stark-accent-text);
  background: var(--stark-accent);
  border: 1px solid transparent;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}

.terminal__secondary {
  padding: var(--stark-space-xs) var(--stark-space-sm);
  font-size: 12px;
  font-weight: 700;
  color: var(--stark-text);
  background: transparent;
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}

.terminal__error {
  flex: 0 0 auto;
  margin: 0;
  padding: 0 var(--stark-space-md) var(--stark-space-xs);
  font-size: 13px;
  line-height: 1.5;
  color: var(--stark-danger);
}

/* Multi-terminal viewport: single pane or resizable split columns. */
.terminal-single {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.terminal-split {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  overflow: hidden;
}

.terminal-pane {
  flex: 1 1 0;
  min-height: 0;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.terminal-pane--active .terminal-pane__title {
  color: var(--stark-text);
}

.terminal-pane__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 var(--stark-space-md);
  color: var(--stark-text-dim);
}

.terminal-pane__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--stark-font-sans);
  font-size: 12px;
  font-weight: 700;
}

.terminal-pane__meta {
  flex: 0 0 auto;
  font-size: 11px;
  text-transform: capitalize;
}

.terminal-pane__spacer {
  flex: 1;
  min-width: 4px;
}

.terminal-pane__iconbtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  padding: 0 6px;
  font-family: var(--stark-font-sans);
  font-size: 11px;
  font-weight: 700;
  color: var(--stark-text-dim);
  background: transparent;
  border: none;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}

.terminal-pane__iconbtn:hover:not(:disabled) {
  color: var(--stark-text);
  background: var(--stark-elevated);
}

.terminal-pane__iconbtn:disabled {
  opacity: 0.45;
  cursor: default;
}

.terminal-split__divider {
  flex: 0 0 auto;
  width: 6px;
  min-height: 0;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
  border-left: 1px solid var(--stark-border);
}

.terminal-split__divider:hover,
.terminal-split__divider:focus-visible {
  background: var(--stark-lime-dim);
  outline: none;
}

/* Restrained empty state: calm copy plus one primary action. */
.terminal--empty {
  align-items: flex-start;
  justify-content: center;
  gap: var(--stark-space-xs);
  padding: var(--stark-space-md);
}

.terminal__empty-title {
  margin: 0;
  font-family: var(--stark-font-sans);
  font-size: 13px;
  font-weight: 700;
  color: var(--stark-text);
}

.terminal__empty-copy {
  margin: 0 0 var(--stark-space-sm);
  font-size: 12px;
  color: var(--stark-text-dim);
}

@media (max-width: 1099px) {
  .terminal-split {
    flex-direction: column;
  }

  .terminal-split__divider {
    width: auto;
    height: 6px;
    cursor: row-resize;
    border-left: none;
    border-top: 1px solid var(--stark-border);
  }
}

.terminal__xterm {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: #0a0c0a;
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
  margin: 0 var(--stark-space-md) var(--stark-space-md);
}

.terminal__xterm .xterm {
  height: 100%;
  padding: 4px 8px;
}
```

## src/renderer/src/features/terminal/terminal-guard.ts

```ts
/**
 * Shared guard for ALL running human terminals (multi-terminal).
 *
 * Workspace switching consults this alongside the editor discard guard:
 * when any PTY session is running, switching requires one explicit user
 * confirmation ("Close the active terminal and switch projects?").
 * The flag lives in module scope: Explorer sets it from the live
 * session list, and every workspace-switch trigger reads it. The
 * registered kill handler terminates every owned terminal (not merely
 * the selected one) with bounded exact cleanup.
 */

export const TERMINAL_SWITCH_CONFIRM_MESSAGE = 'Close the active terminal and switch projects?'

let terminalActive = false
let killHandler: (() => Promise<void>) | null = null

/** Called by Explorer whenever the live running-terminal set changes. */
export function setTerminalActive(value: boolean): void {
  terminalActive = value
}

/** True while any PTY session is running for the current window. */
export function hasActiveTerminal(): boolean {
  return terminalActive
}

/** Explorer registers its bounded kill-all routine; workspace-switch flows invoke it on confirmed switch. */
export function registerTerminalKillHandler(handler: (() => Promise<void>) | null): void {
  killHandler = handler
}

/** Kills every owned terminal with bounded cleanup (no-op when none). */
export async function closeAllTerminalsForSwitch(): Promise<void> {
  if (!terminalActive) {
    return
  }
  const handler = killHandler
  if (handler === null) {
    return
  }
  await handler()
}

/**
 * Returns true when a workspace switch may proceed: no active
 * terminal, or the user confirmed closing it. Returns false when the
 * user declines (caller must stay on the current workspace) or when no
 * confirmation UI is available while a session runs.
 */
export function confirmCloseTerminalAndSwitch(confirm?: () => boolean): boolean {
  if (!terminalActive) {
    return true
  }
  if (confirm !== undefined) {
    return confirm()
  }
  const candidate = (globalThis as { confirm?: unknown }).confirm
  if (typeof candidate === 'function') {
    return (candidate as (message: string) => boolean)(TERMINAL_SWITCH_CONFIRM_MESSAGE)
  }
  return false
}
```

## src/renderer/src/features/terminal/terminal-dimensions.ts

```ts
/**
 * Renderer-side terminal dimension defaults mirroring main limits.
 * Kept in a DOM-free module so pure state logic stays unit-testable
 * under the Node test build.
 */

export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24
export const MIN_TERMINAL_COLS = 20
export const MAX_TERMINAL_COLS = 500
export const MIN_TERMINAL_ROWS = 5
export const MAX_TERMINAL_ROWS = 200

/** xterm visible scrollback lines (display only, no persistence). */
export const TERMINAL_SCROLLBACK_LINES = 5000
```

## src/renderer/src/lib/terminal-api.ts

```ts
import type { TerminalApi } from '../../../shared/terminal/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the human-terminal domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getTerminalApi(): TerminalApi | undefined {
  return getStarkApi()?.terminal
}
```

## src/shared/terminal/types.ts

```ts
/**
 * Shared terminal contracts (Stage 11).
 *
 * Plain TypeScript only — no Node.js or DOM APIs — so every process
 * (main, preload, renderer) can import these. The renderer never
 * chooses executables, cwd, or environment: creation carries only the
 * persisted workspace reference plus xterm dimensions.
 */

/** Public session handle returned to the renderer. PID stays internal. */
export interface TerminalSession {
  readonly id: string
  readonly workspaceId: number
  readonly shell: string
  readonly running: boolean
}

/** Renderer → main: explicit Start Terminal. No cwd, no shell, no env. */
export interface CreateTerminalRequest {
  readonly workspaceId: number
  readonly cols: number
  readonly rows: number
}

/** Renderer → main: human xterm keystrokes for one owned session. */
export interface TerminalWriteRequest {
  readonly sessionId: string
  readonly data: string
}

/** Renderer → main: FitAddon dimensions for one owned session. */
export interface TerminalResizeRequest {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
}

/** Renderer → main: explicit Kill Terminal for one owned session. */
export interface TerminalKillRequest {
  readonly sessionId: string
}

/** Main → renderer: bounded PTY output chunk for the owning session. */
export interface TerminalDataEvent {
  readonly sessionId: string
  readonly data: string
}

/** Main → renderer: shell exit for the owning session, delivered once. */
export interface TerminalExitEvent {
  readonly sessionId: string
  readonly exitCode: number | null
  readonly signal: number | null
}

export type TerminalDataListener = (event: TerminalDataEvent) => void
export type TerminalExitListener = (event: TerminalExitEvent) => void

/**
 * Narrow renderer bridge for the human terminal.
 * No executable choice, no cwd choice, no environment maps,
 * no generic spawn/exec, no agent command-execution method.
 */
export interface TerminalApi {
  create: (request: CreateTerminalRequest) => Promise<TerminalSession>
  write: (request: TerminalWriteRequest) => Promise<void>
  resize: (request: TerminalResizeRequest) => Promise<void>
  kill: (request: TerminalKillRequest) => Promise<void>
  onData: (listener: TerminalDataListener) => () => void
  onExit: (listener: TerminalExitListener) => () => void
}
```

## src/main/terminal/terminal-manager.ts

```ts
import { randomUUID } from 'node:crypto'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession
} from '../../shared/terminal/types'
import {
  InvalidTerminalRequestError,
  TerminalCloseFailedError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalOwnershipError,
  TerminalUnavailableError
} from './errors'
import {
  MAX_HUMAN_TERMINALS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SESSION_ID_LENGTH,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS
} from './limits'
import type { TerminalHostClient } from './terminal-host-client'
import { splitOutputForIpc } from './pty-adapter'

/** Main → owner-renderer event sink (wired to WebContents.send by IPC). */
export interface TerminalEventSink {
  sendData: (ownerWebContentsId: number, event: TerminalDataEvent) => void
  sendExit: (ownerWebContentsId: number, event: TerminalExitEvent) => void
}

interface ManagedSession {
  readonly session: TerminalSession
  readonly ownerWebContentsId: number
  running: boolean
  exitDelivered: boolean
  /**
   * Owner renderer is gone (window destroyed): bookkeeping is
   * RETAINED until EXIT reaps it — never dropped while a live PTY
   * may exist. All front-door ops reject with NotFound; EXIT and
   * host-down still remove normally.
   */
  ownerGone: boolean
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TERMINAL_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(value)
  )
}

function isValidDimensions(cols: unknown, rows: unknown): cols is number {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= MIN_TERMINAL_COLS &&
    cols <= MAX_TERMINAL_COLS &&
    rows >= MIN_TERMINAL_ROWS &&
    rows <= MAX_TERMINAL_ROWS
  )
}

function inputByteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8')
}

/**
 * Human-terminal lifecycle + ownership broker (multi-terminal).
 *
 * This class owns NO node-pty handles: every PTY lives in the
 * dedicated Terminal Host process behind TerminalHostClient, so a
 * blocking native ConPTY operation (notably kill on Windows, measured
 * at ~2–5s on Electron main) can never stall Electron's main event
 * loop. Main stays a narrow broker: shell policy, workspace cwd,
 * environment, opaque ids, per-owner caps, and ownership checks all
 * remain here; the host only executes validated commands for ids
 * main minted.
 *
 * Each owning WebContents may hold up to MAX_HUMAN_TERMINALS live
 * terminals with stable opaque IDs. Every creation spawns a new,
 * independent PTY — never reusing, evicting, or touching a running
 * one. Every operation verifies ownership. PTY output streams only
 * to the owning WebContents in bounded chunks; main keeps no
 * unbounded history buffer. Exit is delivered once per session,
 * then that session is removed.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly ownerIndex = new Map<number, Set<string>>()
  /**
   * Creates in flight per owner (session ids SENT to the host but not
   * yet tracked). Lets window-destroyed cleanup recognize a session
   * that materializes after its owner died. Bounded: entries live
   * only until their own create settles.
   */
  private readonly pendingCreates = new Map<number, Set<string>>()
  /**
   * Owners destroyed while a create was in flight. Bounded: an entry
   * exists only while its owner has pending creates; removed when the
   * last one settles.
   */
  private readonly deadOwners = new Set<number>()

  constructor(
    private readonly host: TerminalHostClient,
    private readonly sink: TerminalEventSink
  ) {
    this.host.onEvent((event) => {
      if (event.kind === 'data') {
        this.handleHostData(event.sessionId, event.data)
      } else if (event.kind === 'exit') {
        this.handleHostExit(event.sessionId, event.exitCode, event.signal)
      } else {
        this.handleHostDown()
      }
    })
  }

  /** Active session count (for diagnostics/tests; not exposed to UI). */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Spawns one new independent terminal for the owning renderer.
   * Always creates (never returns an existing session); past the
   * per-owner cap it throws before spawning — no eviction, never
   * silently killing a running terminal.
   */
  async createSession(input: {
    ownerWebContentsId: number
    workspaceId: number
    cwd: string
    shellFile: string
    shellArgs: readonly string[]
    shellLabel: string
    cols: number
    rows: number
  }): Promise<TerminalSession> {
    return this.spawnSession({ ...input, env: {} })
  }

  /**
   * Production creation with the real environment-bearing spawn. The
   * manager core above spawns with an empty env so unit tests stay
   * hermetic; production passes env through this seam.
   */
  async createSessionWithEnv(
    input: Parameters<TerminalManager['createSession']>[0] & { env: Record<string, string> }
  ): Promise<TerminalSession> {
    return this.spawnSession(input)
  }

  private async spawnSession(
    input: Parameters<TerminalManager['createSession']>[0] & { env: Record<string, string> }
  ): Promise<TerminalSession> {
    if (!isValidDimensions(input.cols, input.rows)) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    this.pruneOwnerIndex(input.ownerWebContentsId)
    if (this.liveCountForOwner(input.ownerWebContentsId) >= MAX_HUMAN_TERMINALS) {
      throw new TerminalLimitError()
    }
    const id = randomUUID()
    this.registerPendingCreate(input.ownerWebContentsId, id)
    try {
      await this.host.create({
        sessionId: id,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        shellFile: input.shellFile,
        shellArgs: input.shellArgs,
        cols: input.cols,
        rows: input.rows,
        env: input.env
      })
    } catch {
      this.unregisterPendingCreate(input.ownerWebContentsId, id)
      // Uncertain result: the host may still own a live PTY for this
      // id (CREATE ack lost/timed out after a successful spawn).
      // Exact scoped cleanup of that one session before failing —
      // a `gone` answer is the common no-op; never throws.
      try {
        await this.host.kill(id)
      } catch {
        // Best effort; host-down reaps everything regardless.
      }
      throw new TerminalUnavailableError()
    }
    // Dead-owner check runs BEFORE unregistering: the unregister
    // drops the dead mark once no creates remain in flight.
    const ownerDiedMidCreate = this.deadOwners.has(input.ownerWebContentsId)
    this.unregisterPendingCreate(input.ownerWebContentsId, id)
    if (ownerDiedMidCreate) {
      // Owner died mid-create: never track a session for a dead
      // renderer. Exact cleanup of the just-created PTY instead.
      try {
        await this.host.kill(id)
      } catch {
        // Best effort; EXIT/host-down still reaps when it can.
      }
      throw new TerminalUnavailableError()
    }
    const session: TerminalSession = {
      id,
      workspaceId: input.workspaceId,
      shell: input.shellLabel,
      running: true
    }
    const managed: ManagedSession = {
      session,
      ownerWebContentsId: input.ownerWebContentsId,
      running: true,
      exitDelivered: false,
      ownerGone: false
    }
    this.sessions.set(id, managed)
    let owned = this.ownerIndex.get(input.ownerWebContentsId)
    if (owned === undefined) {
      owned = new Set<string>()
      this.ownerIndex.set(input.ownerWebContentsId, owned)
    }
    owned.add(id)
    return session
  }

  writeSession(ownerWebContentsId: number, sessionId: unknown, data: unknown): void {
    if (!isValidSessionId(sessionId)) {
      throw new InvalidTerminalRequestError('terminal session is invalid')
    }
    if (typeof data !== 'string') {
      throw new InvalidTerminalRequestError('terminal input must be a string')
    }
    if (inputByteLength(data) > MAX_TERMINAL_INPUT_BYTES) {
      throw new InvalidTerminalRequestError('terminal input is too large')
    }
    const managed = this.requireOwnedSession(ownerWebContentsId, sessionId)
    if (!managed.running) {
      throw new TerminalNotFoundError()
    }
    this.host.write(sessionId, data)
  }

  resizeSession(ownerWebContentsId: number, sessionId: unknown, cols: unknown, rows: unknown): void {
    if (!isValidSessionId(sessionId)) {
      throw new InvalidTerminalRequestError('terminal session is invalid')
    }
    if (!isValidDimensions(cols, rows)) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    const managed = this.requireOwnedSession(ownerWebContentsId, sessionId)
    if (!managed.running) {
      throw new TerminalNotFoundError()
    }
    this.host.resize(sessionId, cols as number, rows as number)
  }

  /**
   * Two-phase close contract: validates ownership, asks the host to
   * terminate exactly this PTY, and maps the host outcome —
   * `initiated` marks closing and returns promptly (exit finalizes
   * later), `gone` removes and reports NotFound (renderer finalizes),
   * `failed` throws a close error (renderer restores the terminal).
   * Never waits for the shell exit itself.
   */
  async killSession(ownerWebContentsId: number, sessionId: unknown): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new InvalidTerminalRequestError('terminal session is invalid')
    }
    const managed = this.requireOwnedSession(ownerWebContentsId, sessionId)
    if (!managed.running) {
      this.removeSession(managed.session.id)
      throw new TerminalNotFoundError()
    }
    const outcome = await this.host.kill(sessionId)
    // EXIT (or host-down) may win the race while the kill is in
    // flight and remove bookkeeping first: a session that
    // disappeared because it exited is already_gone/success — never
    // a termination failure. Ownership/security checks above stay
    // exact; only this post-await disappearance is normalized.
    if (this.sessions.get(sessionId) === undefined) {
      throw new TerminalNotFoundError()
    }
    if (outcome === 'gone') {
      this.removeSession(managed.session.id)
      throw new TerminalNotFoundError()
    }
    if (outcome !== 'initiated') {
      throw new TerminalCloseFailedError()
    }
    // Exit callback performs authoritative removal; this marks the
    // intent so post-exit writes are rejected even if exit is slow.
    managed.running = false
  }

  /**
   * Bounded cleanup when an owning renderer is destroyed.
   *
   * Bookkeeping is RETAINED (marked ownerGone) until EXIT or
   * host-down reaps each session: dropping it while a kill is
   * unconfirmed would orphan a live PTY with no owner record. EXIT
   * delivery to the dead owner is a sink no-op; removal is normal.
   */
  handleWebContentsDestroyed(ownerWebContentsId: number): void {
    if (this.pendingCreates.has(ownerWebContentsId)) {
      this.deadOwners.add(ownerWebContentsId)
    }
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return
    }
    for (const sessionId of [...owned]) {
      const managed = this.sessions.get(sessionId)
      if (managed === undefined) {
        continue
      }
      managed.ownerGone = true
      // Initiate exact termination; the EXIT callback performs
      // authoritative removal. App-quit shutdown follows with a
      // bounded host stop as the backstop.
      try {
        void this.host.kill(sessionId).catch(() => {})
      } catch {
        // Best effort during teardown.
      }
    }
  }

  /** Bounded shutdown of every session (app quit path). */
  async shutdownAll(): Promise<void> {
    try {
      await this.host.shutdown()
    } catch {
      // Best effort; removal below is authoritative and bounded.
    } finally {
      this.sessions.clear()
      this.ownerIndex.clear()
    }
  }

  /** A running session for a live owner, if any (insertion order). */
  findActiveForOwner(ownerWebContentsId: number): TerminalSession | undefined {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return undefined
    }
    for (const sessionId of owned) {
      const managed = this.sessions.get(sessionId)
      if (managed !== undefined && managed.running && !managed.ownerGone) {
        return managed.session
      }
    }
    return undefined
  }

  /**
   * Tracked resource count for an owner (cap accounting). Counts every
   * tracked session — including closing-but-not-yet-exited ones whose
   * ConPTY still physically exists — so at most 8 real resources exist
   * per owner. Dead-owner sessions never count against a recycled id.
   */
  liveCountForOwner(ownerWebContentsId: number): number {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return 0
    }
    let count = 0
    for (const sessionId of owned) {
      const managed = this.sessions.get(sessionId)
      if (managed !== undefined && !managed.ownerGone) {
        count += 1
      }
    }
    return count
  }

  /**
   * Drops index entries for sessions that no longer exist, so a dead
   * session never blocks (or inflates) cap accounting.
   */
  private pruneOwnerIndex(ownerWebContentsId: number): void {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return
    }
    for (const sessionId of [...owned]) {
      if (!this.sessions.has(sessionId)) {
        owned.delete(sessionId)
      }
    }
    if (owned.size === 0) {
      this.ownerIndex.delete(ownerWebContentsId)
    }
  }

  private registerPendingCreate(ownerWebContentsId: number, sessionId: string): void {
    let pending = this.pendingCreates.get(ownerWebContentsId)
    if (pending === undefined) {
      pending = new Set<string>()
      this.pendingCreates.set(ownerWebContentsId, pending)
    }
    pending.add(sessionId)
  }

  private unregisterPendingCreate(ownerWebContentsId: number, sessionId: string): void {
    const pending = this.pendingCreates.get(ownerWebContentsId)
    if (pending === undefined) {
      return
    }
    pending.delete(sessionId)
    if (pending.size === 0) {
      this.pendingCreates.delete(ownerWebContentsId)
      this.deadOwners.delete(ownerWebContentsId)
    }
  }

  private requireOwnedSession(ownerWebContentsId: number, sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined) {
      throw new TerminalNotFoundError()
    }
    if (managed.ownerWebContentsId !== ownerWebContentsId) {
      throw new TerminalOwnershipError()
    }
    if (managed.ownerGone) {
      throw new TerminalNotFoundError()
    }
    return managed
  }

  private handleHostData(sessionId: string, data: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined || !managed.running || managed.ownerGone) {
      return
    }
    const chunks = splitOutputForIpc(data, MAX_TERMINAL_OUTPUT_CHUNK_BYTES)
    for (const chunk of chunks) {
      this.sink.sendData(managed.ownerWebContentsId, { sessionId, data: chunk })
    }
  }

  private handleHostExit(sessionId: string, exitCode: number | null, signal: number | null): void {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined || managed.exitDelivered) {
      return
    }
    managed.exitDelivered = true
    managed.running = false
    try {
      this.sink.sendExit(managed.ownerWebContentsId, { sessionId, exitCode, signal })
    } finally {
      this.removeSession(sessionId)
    }
  }

  /**
   * Host process died: every tracked PTY died with it. Each owner
   * gets one honest exit per session (exitCode unknown); nothing
   * restarts — the next explicit New Terminal starts a fresh host.
   */
  private handleHostDown(): void {
    for (const [sessionId, managed] of [...this.sessions.entries()]) {
      if (managed.exitDelivered) {
        continue
      }
      managed.exitDelivered = true
      managed.running = false
      try {
        this.sink.sendExit(managed.ownerWebContentsId, { sessionId, exitCode: null, signal: null })
      } catch {
        // Best effort streaming.
      } finally {
        this.removeSession(sessionId)
      }
    }
  }

  private removeSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed !== undefined) {
      const owned = this.ownerIndex.get(managed.ownerWebContentsId)
      owned?.delete(sessionId)
      if (owned !== undefined && owned.size === 0) {
        this.ownerIndex.delete(managed.ownerWebContentsId)
      }
    }
    this.sessions.delete(sessionId)
  }
}
```

## src/main/terminal/terminal-host-manager.ts

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTerminalHostMessage,
  parseTerminalHostMessage,
  parseTerminalHostPayloadMessage,
  type TerminalHostPayloadMessage
} from './terminal-host-protocol'

/** Hard startup bound: READY must arrive within 10 seconds. */
export const TERMINAL_HOST_STARTUP_TIMEOUT_MS = 10_000

/** Hard graceful-stop bound: SHUTDOWN_COMPLETE within 5 seconds. */
export const TERMINAL_HOST_STOP_TIMEOUT_MS = 5_000

/** Default bound for one correlated host request (create/kill). */
export const TERMINAL_HOST_REQUEST_TIMEOUT_MS = 10_000

/** Neutral STARK-owned working directory under userData. */
export const TERMINAL_HOST_RUNTIME_DIR_NAME = 'terminal-host-runtime'

export type TerminalHostState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed'

/**
 * Minimal host-process surface: the exact subset of Electron
 * UtilityProcess the broker uses (fork handle with message passing
 * and exact-handle kill). Tests inject fakes; production wraps the
 * real utilityProcess child.
 */
export interface TerminalHostProcess {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message' | 'exit', listener: (...args: Array<unknown>) => void): void
  removeAllListeners(event: 'message' | 'exit'): void
}

export interface TerminalHostForkOptions {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly execArgv: string[]
  readonly stdio: ['ignore', 'ignore', 'ignore']
  readonly serviceName: string
}

export interface TerminalHostLauncher {
  fork(modulePath: string, options: TerminalHostForkOptions): TerminalHostProcess
}

export interface TerminalHostManagerOptions {
  /** Absolute STARK-owned bootstrap file (shipped production artifact). */
  readonly bootstrapPath: string
  /** Electron userData directory (owns the neutral runtime cwd). */
  readonly userDataDir: string
  /** Process spawner (utilityProcess in production, fakes in tests). */
  readonly launcher: TerminalHostLauncher
  /** Bounds (spec defaults; tests inject short values). */
  readonly startupTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /** Internal transition log sink (state words only, never payloads). */
  readonly onLog?: (message: string) => void
}

export type TerminalHostEvent =
  | { readonly kind: 'message'; readonly message: TerminalHostPayloadMessage }
  | { readonly kind: 'shutdown-complete' }
  | { readonly kind: 'exit' }

/**
 * Main-owned Terminal Host broker: the ONLY main-side owner of the
 * human-PTY host process.
 *
 * Blocking native ConPTY operations (notably kill) execute inside the
 * host, never on Electron's main event loop — a wedged teardown
 * stalls at most the host while main keeps serving every other
 * window, IPC channel, and terminal. One host instance per manager.
 * Unexpected exits become `crashed` without restarting; a fresh host
 * starts only on the next explicit user action (never a loop).
 * Startup, shutdown, and correlated requests are hard-bounded with
 * exact-handle termination and no retries, polling, or loops.
 */
export class TerminalHostManager {
  private state: TerminalHostState = 'stopped'
  private child: TerminalHostProcess | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private startingPromise: Promise<void> | null = null
  private readonly readyWaiters = new Set<{
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }>()
  private readonly pendingRequests = new Map<
    string,
    { readonly resolve: (message: TerminalHostPayloadMessage) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
  >()
  private readonly subscribers = new Set<(event: TerminalHostEvent) => void>()
  private readonly options: TerminalHostManagerOptions

  constructor(options: TerminalHostManagerOptions) {
    this.options = options
  }

  getState(): TerminalHostState {
    return this.state
  }

  /**
   * Subscribes to host payload events and exits. Listeners persist
   * across restarts and must never throw (a throwing listener is
   * dropped for that event). Returns an unsubscribe function.
   */
  onHostEvent(listener: (event: TerminalHostEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private emit(event: TerminalHostEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event)
      } catch {
        // Subscriber failures must never break lifecycle control.
      }
    }
  }

  private log(transition: string): void {
    try {
      this.options.onLog?.(`terminal-host: ${transition}`)
    } catch {
      // Logging must never break lifecycle control.
    }
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
  }

  /** Terminates only the exact owned child handle. Never broad kills. */
  private killOwned(): void {
    const child = this.child
    if (child === null) {
      return
    }
    try {
      child.kill()
    } catch {
      // Best effort: the exit handler still settles state.
    }
  }

  private detach(): void {
    const child = this.child
    if (child !== null) {
      try {
        child.removeAllListeners('message')
        child.removeAllListeners('exit')
      } catch {
        // Best effort.
      }
    }
    this.child = null
  }

  private failAllRequests(message: string): void {
    for (const [, pending] of [...this.pendingRequests]) {
      try {
        clearTimeout(pending.timer)
      } catch {
        // Best effort.
      }
      try {
        pending.reject(new Error(message))
      } catch {
        // Reject handlers are caller-owned; never break control flow.
      }
    }
    this.pendingRequests.clear()
  }

  /** Routes one validated payload to a waiting correlated request. */
  private routeAnswer(message: TerminalHostPayloadMessage): void {
    const payload = message.payload as { readonly requestId?: unknown }
    const requestId = payload.requestId
    if (typeof requestId !== 'string') {
      return
    }
    const pending = this.pendingRequests.get(requestId)
    if (pending === undefined) {
      return
    }
    this.pendingRequests.delete(requestId)
    try {
      clearTimeout(pending.timer)
    } catch {
      // Best effort.
    }
    pending.resolve(message)
  }

  /** Permanent per-child router: answers, subscriber events, lifecycle. */
  private attachChild(child: TerminalHostProcess): void {
    child.on('message', (raw: unknown) => {
      const parsed = parseTerminalHostPayloadMessage(raw)
      if (parsed !== null) {
        this.routeAnswer(parsed)
        this.emit({ kind: 'message', message: parsed })
        return
      }
      if (parseTerminalHostMessage(raw) === 'READY' && this.state === 'starting') {
        this.clearStartupTimer()
        this.state = 'ready'
        this.log('ready')
        this.settleReadyWaiters(null)
        return
      }
      if (parseTerminalHostMessage(raw) === 'SHUTDOWN_COMPLETE') {
        this.emit({ kind: 'shutdown-complete' })
      }
    })
    child.on('exit', () => {
      this.emit({ kind: 'exit' })
      if (this.state === 'starting' || this.state === 'ready' || this.state === 'stopping') {
        this.clearStartupTimer()
        this.clearStopTimer()
        this.detach()
        this.state = 'crashed'
        this.log('crashed')
        this.failAllRequests('Terminal Host exited.')
        this.settleReadyWaiters(new Error('Terminal Host exited during startup.'))
      }
    })
  }

  private settleReadyWaiters(error: Error | null): void {
    for (const waiter of [...this.readyWaiters]) {
      try {
        if (error === null) {
          waiter.resolve()
        } else {
          waiter.reject(error)
        }
      } catch {
        // Waiter handlers are caller-owned; never break control flow.
      }
    }
    this.readyWaiters.clear()
  }

  /**
   * Ensures a ready host, starting one on demand (bounded). Called
   * only from explicit user actions (terminal create) — never from
   * crash handling, so a dead host is never resurrected in a loop.
   */
  async ensureReady(): Promise<void> {
    if (this.state === 'ready') {
      return
    }
    if (this.state === 'starting') {
      const ongoing = this.startingPromise
      if (ongoing !== null) {
        await ongoing
        return
      }
    }
    await this.start()
  }

  private async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'stopping') {
      return
    }
    if (this.state === 'starting' && this.startingPromise !== null) {
      await this.startingPromise
      return
    }
    const startupTimeoutMs = this.options.startupTimeoutMs ?? TERMINAL_HOST_STARTUP_TIMEOUT_MS
    const runtimeDir = join(this.options.userDataDir, TERMINAL_HOST_RUNTIME_DIR_NAME)
    try {
      mkdirSync(runtimeDir, { recursive: true })
    } catch {
      throw new Error('Terminal Host failed to start.')
    }
    let child: TerminalHostProcess
    try {
      child = this.options.launcher.fork(this.options.bootstrapPath, {
        env: { ...process.env },
        cwd: runtimeDir,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore'],
        serviceName: 'STARK Terminal Host'
      })
    } catch {
      throw new Error('Terminal Host failed to start.')
    }
    this.child = child
    this.state = 'starting'
    this.log('starting')
    this.attachChild(child)
    this.startingPromise = new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject })
      this.startupTimer = setTimeout(() => {
        this.killOwned()
        this.detach()
        this.state = 'crashed'
        this.log('crashed')
        this.failAllRequests('Terminal Host failed to start.')
        this.settleReadyWaiters(new Error('Terminal Host failed to start.'))
      }, startupTimeoutMs)
    })
    try {
      await this.startingPromise
    } finally {
      this.startingPromise = null
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'crashed' || this.child === null) {
      if (this.child === null && this.state !== 'crashed') {
        this.state = 'stopped'
      }
      return
    }
    if (this.state === 'starting') {
      this.clearStartupTimer()
      this.killOwned()
      this.detach()
      this.state = 'stopped'
      this.log('stopped')
      this.failAllRequests('Terminal Host stopped.')
      // Waiting ensureReady() callers must never hang: the startup
      // promise below only settles through these waiters.
      this.settleReadyWaiters(new Error('Terminal Host stopped.'))
      return
    }
    const stopTimeoutMs = this.options.stopTimeoutMs ?? TERMINAL_HOST_STOP_TIMEOUT_MS
    this.state = 'stopping'
    this.log('stopping')
    return new Promise<void>((resolve) => {
      const child = this.child
      let settled = false
      const finishStopped = (): void => {
        if (settled) {
          return
        }
        settled = true
        this.clearStopTimer()
        // SHUTDOWN_COMPLETE is a message, not process exit: the host
        // never self-terminates, so terminate the exact owned child
        // here or a live utility process lingers after every stop.
        this.killOwned()
        this.detach()
        this.state = 'stopped'
        this.log('stopped')
        resolve()
      }
      if (child === null) {
        finishStopped()
        return
      }
      // One-shot: SHUTDOWN_COMPLETE or host exit, whichever arrives
      // first (both flow through the shared subscriber channel). The
      // local flag (not state) guards double-settle: the exit path in
      // attachChild may flip state before this listener runs.
      const unsubscribe = this.onHostEvent((event) => {
        if (settled) {
          return
        }
        if (event.kind === 'exit' || event.kind === 'shutdown-complete') {
          unsubscribe()
          finishStopped()
        }
      })
      try {
        child.postMessage(buildTerminalHostMessage('SHUTDOWN'))
      } catch {
        this.killOwned()
        unsubscribe()
        finishStopped()
        return
      }
      this.stopTimer = setTimeout(() => {
        this.killOwned()
        unsubscribe()
        finishStopped()
      }, stopTimeoutMs)
    })
  }

  /**
   * Sends one correlated request (CREATE/KILL carry their own
   * requestId) and resolves with the typed host answer (bounded).
   * Rejects when the host is not ready, the bound lapses, or the
   * host exits mid-flight. Callers never retry.
   */
  request(
    message:
      | { readonly protocol: string; readonly type: 'CREATE'; readonly payload: { readonly requestId: string } }
      | { readonly protocol: string; readonly type: 'KILL'; readonly payload: { readonly requestId: string } },
    timeoutMs?: number
  ): Promise<TerminalHostPayloadMessage> {
    const child = this.child
    if (child === null || this.state !== 'ready') {
      return Promise.reject(new Error('Terminal Host is not ready.'))
    }
    const requestId = message.payload.requestId
    const bound = timeoutMs ?? this.options.requestTimeoutMs ?? TERMINAL_HOST_REQUEST_TIMEOUT_MS
    return new Promise<TerminalHostPayloadMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Terminal Host request timed out.'))
      }, bound)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
      try {
        child.postMessage(message)
      } catch {
        this.pendingRequests.delete(requestId)
        clearTimeout(timer)
        reject(new Error('Terminal Host failed to receive a message.'))
      }
    })
  }

  /**
   * Fire-and-forget post for streaming operations (write/resize)
   * after local validation. Throws when the host is not ready.
   */
  notify(message: unknown): void {
    const child = this.child
    if (child === null || this.state !== 'ready') {
      throw new Error('Terminal Host is not ready.')
    }
    try {
      child.postMessage(message)
    } catch {
      throw new Error('Terminal Host failed to receive a message.')
    }
  }
}
```

## src/main/terminal/terminal-host-protocol.ts

```ts
/**
 * Private main ↔ Terminal Host control protocol.
 *
 * Tiny closed vocabulary over a versioned envelope — no arbitrary
 * method names, no code payloads, no generic RPC, no path commands:
 *
 *   Main → Host:  SHUTDOWN, CREATE, WRITE, RESIZE, KILL
 *   Host → Main:  READY, SHUTDOWN_COMPLETE,
 *                 CREATED, CREATE_FAILED, DATA, EXIT, KILL_RESULT
 *
 * The host owns node-pty handles exclusively so a blocking native
 * ConPTY operation can never stall Electron's main event loop; main
 * stays a narrow broker (shell policy, cwd resolution, ownership,
 * caps). Lifecycle messages stay on the 64 KiB control cap; PTY
 * output chunks reuse the existing 64 KiB terminal output bound.
 * The STARK-owned bootstrap mirrors the envelope in plain JS; a
 * static test asserts both sides name the same types. Every inbound
 * message is validated (envelope, type, cap, schema) before use.
 */

/** Protocol envelope version. Both sides must agree. */
export const TERMINAL_HOST_PROTOCOL = 'stark-terminal-host/v1' as const

/** Maximum accepted control message size (UTF-8 JSON bytes). */
export const TERMINAL_HOST_MAX_MESSAGE_BYTES = 64 * 1024

/** Maximum PTY output payload per DATA message (matches terminal output bound). */
export const TERMINAL_HOST_MAX_DATA_BYTES = 64 * 1024

/** Maximum identifier length (session/request ids). */
export const TERMINAL_HOST_MAX_ID_LENGTH = 128

/** Messages main may send to the host. */
export const TERMINAL_MAIN_TO_HOST_TYPES = ['SHUTDOWN', 'CREATE', 'WRITE', 'RESIZE', 'KILL'] as const

/** Messages the host may send to main. */
export const TERMINAL_HOST_TO_MAIN_TYPES = [
  'READY',
  'SHUTDOWN_COMPLETE',
  'CREATED',
  'CREATE_FAILED',
  'DATA',
  'EXIT',
  'KILL_RESULT'
] as const

export type TerminalMainToHostType = (typeof TERMINAL_MAIN_TO_HOST_TYPES)[number]
export type TerminalHostToMainType = (typeof TERMINAL_HOST_TO_MAIN_TYPES)[number]

export interface TerminalHostControlMessage {
  readonly protocol: string
  readonly type: string
}

function messageByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return TERMINAL_HOST_MAX_MESSAGE_BYTES + 1
  }
}

function isEnvelope(value: unknown): value is TerminalHostControlMessage {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return record['protocol'] === TERMINAL_HOST_PROTOCOL && typeof record['type'] === 'string'
}

/**
 * Validates one inbound host→main message. Returns its type, or null
 * for malformed envelopes, unknown types, or oversized payloads
 * (callers ignore such messages without replying).
 */
export function parseTerminalHostMessage(value: unknown): TerminalHostToMainType | null {
  if (!isEnvelope(value)) {
    return null
  }
  const type = (value as TerminalHostControlMessage).type
  if (!(TERMINAL_HOST_TO_MAIN_TYPES as readonly string[]).includes(type)) {
    return null
  }
  if (messageByteLength(value) > TERMINAL_HOST_MAX_MESSAGE_BYTES) {
    return null
  }
  return type as TerminalHostToMainType
}

/** Builds one outbound main→host message (closed vocabulary only). */
export function buildTerminalHostMessage(type: TerminalMainToHostType): {
  readonly protocol: string
  readonly type: TerminalMainToHostType
} {
  return { protocol: TERMINAL_HOST_PROTOCOL, type }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= TERMINAL_HOST_MAX_ID_LENGTH
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** CREATE payload: concrete spawn parameters, all main-resolved. */
export interface TerminalHostCreatePayload {
  readonly requestId: string
  readonly sessionId: string
  readonly cwd: string
  readonly shellFile: string
  readonly shellArgs: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
}

/** WRITE payload: keystrokes for one owned session. */
export interface TerminalHostWritePayload {
  readonly sessionId: string
  readonly data: string
}

/** RESIZE payload: fitted dimensions for one owned session. */
export interface TerminalHostResizePayload {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
}

/** KILL payload: exact session termination. */
export interface TerminalHostKillPayload {
  readonly requestId: string
  readonly sessionId: string
}

export type TerminalMainToHostPayload =
  | TerminalHostCreatePayload
  | TerminalHostWritePayload
  | TerminalHostResizePayload
  | TerminalHostKillPayload

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === 'string')
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Builds one outbound main→host payload message. Payload shapes are
 * fixed per type; anything else is a compile-time error.
 */
export function buildTerminalHostPayloadMessage(
  type: 'CREATE',
  payload: TerminalHostCreatePayload
): { readonly protocol: string; readonly type: 'CREATE'; readonly payload: TerminalHostCreatePayload }
export function buildTerminalHostPayloadMessage(
  type: 'WRITE',
  payload: TerminalHostWritePayload
): { readonly protocol: string; readonly type: 'WRITE'; readonly payload: TerminalHostWritePayload }
export function buildTerminalHostPayloadMessage(
  type: 'RESIZE',
  payload: TerminalHostResizePayload
): { readonly protocol: string; readonly type: 'RESIZE'; readonly payload: TerminalHostResizePayload }
export function buildTerminalHostPayloadMessage(
  type: 'KILL',
  payload: TerminalHostKillPayload
): { readonly protocol: string; readonly type: 'KILL'; readonly payload: TerminalHostKillPayload }
export function buildTerminalHostPayloadMessage(type: TerminalMainToHostType, payload: TerminalMainToHostPayload): {
  readonly protocol: string
  readonly type: TerminalMainToHostType
  readonly payload: TerminalMainToHostPayload
} {
  return { protocol: TERMINAL_HOST_PROTOCOL, type, payload }
}

/** CREATED: spawn accepted for one session. */
export interface TerminalHostCreatedPayload {
  readonly requestId: string
  readonly sessionId: string
}

/** CREATE_FAILED: spawn rejected (closed reason code, no paths/PIDs). */
export interface TerminalHostCreateFailedPayload {
  readonly requestId: string
  readonly sessionId: string
  readonly code: 'invalid' | 'spawn_failed'
}

/** DATA: bounded PTY output chunk for one session. */
export interface TerminalHostDataPayload {
  readonly sessionId: string
  readonly data: string
}

/** EXIT: shell exit for one session, delivered once. */
export interface TerminalHostExitPayload {
  readonly sessionId: string
  readonly exitCode: number | null
  readonly signal: number | null
}

/** KILL_RESULT: exact outcome of one KILL request. */
export interface TerminalHostKillResultPayload {
  readonly requestId: string
  readonly sessionId: string
  readonly outcome: 'initiated' | 'gone' | 'failed'
}

export type TerminalHostPayloadMessage =
  | { readonly type: 'CREATED'; readonly payload: TerminalHostCreatedPayload }
  | { readonly type: 'CREATE_FAILED'; readonly payload: TerminalHostCreateFailedPayload }
  | { readonly type: 'DATA'; readonly payload: TerminalHostDataPayload }
  | { readonly type: 'EXIT'; readonly payload: TerminalHostExitPayload }
  | { readonly type: 'KILL_RESULT'; readonly payload: TerminalHostKillResultPayload }

/**
 * Validates one inbound host→main payload message. Returns the typed
 * message, or null for malformed envelopes, unknown types, oversized
 * payloads, or schema violations (callers ignore such messages
 * without replying).
 */
export function parseTerminalHostPayloadMessage(value: unknown): TerminalHostPayloadMessage | null {
  if (!isEnvelope(value)) {
    return null
  }
  if (messageByteLength(value) > TERMINAL_HOST_MAX_MESSAGE_BYTES) {
    return null
  }
  const record = value as unknown as Record<string, unknown>
  const { type, payload } = record
  if (!isRecord(payload)) {
    return null
  }
  switch (type) {
    case 'CREATED':
      return isBoundedId(payload['requestId']) && isBoundedId(payload['sessionId'])
        ? { type, payload: { requestId: payload['requestId'], sessionId: payload['sessionId'] } }
        : null
    case 'CREATE_FAILED':
      return isBoundedId(payload['requestId']) &&
        isBoundedId(payload['sessionId']) &&
        (payload['code'] === 'invalid' || payload['code'] === 'spawn_failed')
        ? {
            type,
            payload: {
              requestId: payload['requestId'],
              sessionId: payload['sessionId'],
              code: payload['code']
            }
          }
        : null
    case 'DATA': {
      if (!isBoundedId(payload['sessionId']) || typeof payload['data'] !== 'string') {
        return null
      }
      try {
        return Buffer.byteLength(payload['data'], 'utf8') <= TERMINAL_HOST_MAX_DATA_BYTES
          ? { type, payload: { sessionId: payload['sessionId'], data: payload['data'] } }
          : null
      } catch {
        return null
      }
    }
    case 'EXIT': {
      const { sessionId, exitCode, signal } = payload
      if (!isBoundedId(sessionId)) {
        return null
      }
      const codeOk = exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode))
      const signalOk = signal === null || (typeof signal === 'number' && Number.isInteger(signal))
      return codeOk && signalOk
        ? { type, payload: { sessionId, exitCode: exitCode as number | null, signal: signal as number | null } }
        : null
    }
    case 'KILL_RESULT':
      return isBoundedId(payload['requestId']) &&
        isBoundedId(payload['sessionId']) &&
        (payload['outcome'] === 'initiated' || payload['outcome'] === 'gone' || payload['outcome'] === 'failed')
        ? {
            type,
            payload: {
              requestId: payload['requestId'],
              sessionId: payload['sessionId'],
              outcome: payload['outcome']
            }
          }
        : null
    default:
      return null
  }
}

/**
 * Validates one inbound main→host payload message (host-side gate).
 * Same closed vocabularies and bounds as main; the host re-checks
 * every field before touching node-pty.
 */
export function parseTerminalMainPayloadMessage(
  value: unknown
): { readonly type: 'CREATE'; readonly payload: TerminalHostCreatePayload } | { readonly type: 'WRITE'; readonly payload: TerminalHostWritePayload } | { readonly type: 'RESIZE'; readonly payload: TerminalHostResizePayload } | { readonly type: 'KILL'; readonly payload: TerminalHostKillPayload } | null {
  if (!isEnvelope(value)) {
    return null
  }
  if (messageByteLength(value) > TERMINAL_HOST_MAX_MESSAGE_BYTES) {
    return null
  }
  const record = value as unknown as Record<string, unknown>
  const { type, payload } = record
  if (!isRecord(payload)) {
    return null
  }
  switch (type) {
    case 'CREATE': {
      const { requestId, sessionId, cwd, shellFile, shellArgs, cols, rows, env } = payload
      if (
        !isBoundedId(requestId) ||
        !isBoundedId(sessionId) ||
        typeof cwd !== 'string' ||
        cwd === '' ||
        typeof shellFile !== 'string' ||
        shellFile === '' ||
        !isStringArray(shellArgs) ||
        !isPositiveInt(cols) ||
        cols > 500 ||
        !isPositiveInt(rows) ||
        rows > 200 ||
        !isStringMap(env)
      ) {
        return null
      }
      return {
        type,
        payload: { requestId, sessionId, cwd, shellFile, shellArgs, cols, rows, env }
      }
    }
    case 'WRITE':
      return isBoundedId(payload['sessionId']) && typeof payload['data'] === 'string' && payload['data'] !== ''
        ? { type, payload: { sessionId: payload['sessionId'] as string, data: payload['data'] as string } }
        : null
    case 'RESIZE': {
      const { sessionId, cols, rows } = payload
      return isBoundedId(sessionId) && isPositiveInt(cols) && cols <= 500 && isPositiveInt(rows) && rows <= 200
        ? { type, payload: { sessionId, cols, rows } }
        : null
    }
    case 'KILL':
      return isBoundedId(payload['requestId']) && isBoundedId(payload['sessionId'])
        ? { type, payload: { requestId: payload['requestId'] as string, sessionId: payload['sessionId'] as string } }
        : null
    default:
      return null
  }
}
```

## src/main/terminal/terminal-host-client.ts

```ts
import { randomUUID } from 'node:crypto'
import { buildTerminalHostPayloadMessage } from './terminal-host-protocol'
import { TerminalHostManager } from './terminal-host-manager'

/** Exact outcome of one host KILL request (two-phase close contract). */
export type TerminalHostKillOutcome = 'initiated' | 'gone' | 'failed'

export interface TerminalHostCreateInput {
  readonly sessionId: string
  readonly workspaceId: number
  readonly cwd: string
  readonly shellFile: string
  readonly shellArgs: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
}

export type TerminalHostClientEvent =
  | { readonly kind: 'data'; readonly sessionId: string; readonly data: string }
  | { readonly kind: 'exit'; readonly sessionId: string; readonly exitCode: number | null; readonly signal: number | null }
  | { readonly kind: 'host-down' }

/**
 * Narrow client over the Terminal Host process. The broker owns all
 * policy (shell choice, cwd, caps, ownership); this layer only moves
 * validated commands and typed events. Tests inject fakes (including
 * wedged hosts); production wraps the real manager.
 */
export interface TerminalHostClient {
  create(input: TerminalHostCreateInput): Promise<void>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  kill(sessionId: string): Promise<TerminalHostKillOutcome>
  shutdown(): Promise<void>
  onEvent(listener: (event: TerminalHostClientEvent) => void): () => void
}

/**
 * Production client: correlates host answers, maps outcomes, and
 * translates host events for the broker. Request bounds come from
 * the manager; callers never retry.
 */
export class TerminalProcessClient implements TerminalHostClient {
  private readonly subscribers = new Set<(event: TerminalHostClientEvent) => void>()

  constructor(private readonly manager: TerminalHostManager) {
    this.manager.onHostEvent((event) => {
      if (event.kind === 'exit') {
        this.emit({ kind: 'host-down' })
        return
      }
      if (event.kind !== 'message') {
        return
      }
      const message = event.message
      if (message.type === 'DATA') {
        this.emit({ kind: 'data', sessionId: message.payload.sessionId, data: message.payload.data })
      } else if (message.type === 'EXIT') {
        this.emit({
          kind: 'exit',
          sessionId: message.payload.sessionId,
          exitCode: message.payload.exitCode,
          signal: message.payload.signal
        })
      }
    })
  }

  onEvent(listener: (event: TerminalHostClientEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private emit(event: TerminalHostClientEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event)
      } catch {
        // Subscriber failures must never break the client.
      }
    }
  }

  async create(input: TerminalHostCreateInput): Promise<void> {
    await this.manager.ensureReady()
    const requestId = randomUUID()
    const answer = await this.manager.request(
      buildTerminalHostPayloadMessage('CREATE', {
        requestId,
        sessionId: input.sessionId,
        cwd: input.cwd,
        shellFile: input.shellFile,
        shellArgs: input.shellArgs,
        cols: input.cols,
        rows: input.rows,
        env: input.env
      })
    )
    if (answer.type === 'CREATED') {
      return
    }
    throw new Error('Terminal Host failed to start the terminal.')
  }

  write(sessionId: string, data: string): void {
    this.manager.notify(buildTerminalHostPayloadMessage('WRITE', { sessionId, data }))
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.manager.notify(buildTerminalHostPayloadMessage('RESIZE', { sessionId, cols, rows }))
  }

  async kill(sessionId: string): Promise<TerminalHostKillOutcome> {
    const requestId = randomUUID()
    let answer
    try {
      answer = await this.manager.request(buildTerminalHostPayloadMessage('KILL', { requestId, sessionId }))
    } catch {
      return 'failed'
    }
    if (answer.type === 'KILL_RESULT') {
      return answer.payload.outcome
    }
    return 'failed'
  }

  async shutdown(): Promise<void> {
    await this.manager.stop()
  }
}

/** Test stub: records calls, never touches processes. */
export function createStubTerminalHostClient(): TerminalHostClient & {
  readonly calls: Array<{ readonly op: string; readonly sessionId?: string }>
} {
  const calls: Array<{ readonly op: string; readonly sessionId?: string }> = []
  const client: TerminalHostClient & { readonly calls: Array<{ readonly op: string; readonly sessionId?: string }> } = {
    calls,
    create: () => {
      calls.push({ op: 'create' })
      return Promise.reject(new Error('Terminal Host stub does not spawn.'))
    },
    write: () => {},
    resize: () => {},
    kill: () => {
      calls.push({ op: 'kill' })
      return Promise.reject(new Error('Terminal Host stub does not kill.'))
    },
    shutdown: () => Promise.resolve(),
    onEvent: () => () => {}
  }
  return client
}
```

## src/main/terminal/terminal-host.mjs (full runtime)

```js
/**
 * STARK-owned Terminal Host runtime (human PTYs only).
 *
 * This module owns every node-pty handle: spawn, streaming, resize,
 * and — critically — kill. Native ConPTY teardown (notably kill on
 * Windows) can block its calling thread for seconds; running it here
 * keeps Electron's main event loop responsive no matter how long a
 * teardown takes. Main stays a narrow broker (shell policy, cwd
 * resolution, ownership, caps) over the closed protocol below:
 *
 *   Main → Host:  SHUTDOWN, CREATE, WRITE, RESIZE, KILL
 *   Host → Main:  READY, SHUTDOWN_COMPLETE,
 *                 CREATED, CREATE_FAILED, DATA, EXIT, KILL_RESULT
 *
 * Plain dependency-free JS: node-pty itself is injected (production
 * passes the real module from the bootstrap; tests pass fakes), so
 * this file imports nothing and runs identically under Electron
 * utilityProcess, plain-Node child processes, and unit tests.
 * Unknown or malformed messages are ignored (CREATE answers
 * CREATE_FAILED when correlatable). Control traffic stays on the
 * 64 KiB cap; PTY output chunks reuse the 64 KiB output bound with
 * multibyte-safe splitting. No renderer contact, no worker/runtime
 * processes, no Extension Host mixing — human terminals only.
 */

const PROTOCOL = 'stark-terminal-host/v1';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_DATA_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 128;
const MAIN_TO_HOST_TYPES = ['SHUTDOWN', 'CREATE', 'WRITE', 'RESIZE', 'KILL'];

function safeByteLength(text) {
  try {
    return Buffer.byteLength(text, 'utf8');
  } catch (err) {
    void err;
    return -1;
  }
}

function messageByteLength(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? MAX_MESSAGE_BYTES + 1 : Buffer.byteLength(text, 'utf8');
  } catch (err) {
    void err;
    return MAX_MESSAGE_BYTES + 1;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function isBoundedId(value) {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
}

function isAllowedInbound(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (value.protocol !== PROTOCOL || typeof value.type !== 'string') {
    return false;
  }
  if (MAIN_TO_HOST_TYPES.indexOf(value.type) === -1) {
    return false;
  }
  return messageByteLength(value) <= MAX_MESSAGE_BYTES;
}

/** Multibyte-safe chunk split for PTY output (64 KiB IPC bound). */
function splitOutput(data) {
  const text = typeof data === 'string' ? data : '';
  if (text === '') {
    return [];
  }
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = safeByteLength(char);
    if (charBytes < 0) {
      continue;
    }
    if (currentBytes + charBytes > MAX_DATA_BYTES) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current !== '') {
    chunks.push(current);
  }
  return chunks;
}

function validCreate(payload) {
  if (!isRecord(payload)) {
    return false;
  }
  const { requestId, sessionId, cwd, shellFile, shellArgs, cols, rows, env } = payload;
  if (!isBoundedId(requestId) || !isBoundedId(sessionId)) {
    return false;
  }
  if (typeof cwd !== 'string' || cwd === '' || typeof shellFile !== 'string' || shellFile === '') {
    return false;
  }
  if (!Array.isArray(shellArgs) || !shellArgs.every((entry) => typeof entry === 'string')) {
    return false;
  }
  // Parity with the main-enforced bounds (20..500 x 5..200): the
  // host fails closed on values main would reject.
  if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
    return false;
  }
  if (!isRecord(env) || !Object.values(env).every((entry) => typeof entry === 'string')) {
    return false;
  }
  return true;
}

/**
 * Creates the terminal host runtime.
 *
 * @param {object} deps
 * @param {(file: string, args: readonly string[], options: object) => object} deps.spawnPty
 *   node-pty-compatible spawn (injected; production passes node-pty).
 * @param {(message: object) => void} deps.send outbound transport to main.
 * @param {(listener: (message: unknown) => void) => void} deps.onMessage inbound subscription.
 */
export function createTerminalHostRuntime(deps) {
  const spawnPty = deps.spawnPty;
  const send = deps.send;
  const sessions = new Map();

  function post(type, payload) {
    try {
      send({ protocol: PROTOCOL, type, payload });
    } catch (err) {
      void err;
    }
  }

  function handleExit(sessionId, exitCode, signal) {
    const tracked = sessions.get(sessionId);
    if (tracked === undefined || tracked.exitDelivered) {
      return;
    }
    tracked.exitDelivered = true;
    tracked.running = false;
    post('EXIT', { sessionId, exitCode, signal });
    sessions.delete(sessionId);
  }

  function handleMessage(raw) {
    if (!isAllowedInbound(raw)) {
      return;
    }
    const { type, payload } = raw;
    if (type === 'SHUTDOWN') {
      if (type === 'SHUTDOWN') {
        for (const [, tracked] of [...sessions]) {
          try {
            if (tracked.running) {
              tracked.pty.kill();
            }
          } catch (err) {
            void err;
          }
        }
        sessions.clear();
        post('SHUTDOWN_COMPLETE', {});
      }
      return;
    }
    if (!isRecord(payload)) {
      return;
    }
    if (type === 'CREATE') {
      if (!validCreate(payload)) {
        if (isBoundedId(payload.requestId) && isBoundedId(payload.sessionId)) {
          post('CREATE_FAILED', { requestId: payload.requestId, sessionId: payload.sessionId, code: 'invalid' });
        }
        return;
      }
      const { requestId, sessionId } = payload;
      if (sessions.has(sessionId)) {
        post('CREATE_FAILED', { requestId, sessionId, code: 'invalid' });
        return;
      }
      let spawned = null;
      try {
        spawned = spawnPty(payload.shellFile, payload.shellArgs, {
          cwd: payload.cwd,
          cols: payload.cols,
          rows: payload.rows,
          env: payload.env
        });
      } catch (err) {
        void err;
      }
      if (spawned === null || spawned === undefined) {
        post('CREATE_FAILED', { requestId, sessionId, code: 'spawn_failed' });
        return;
      }
      const pty = spawned;
      sessions.set(sessionId, { pty, running: true, exitDelivered: false });
      try {
        pty.onData((data) => {
          const tracked = sessions.get(sessionId);
          if (tracked === undefined || !tracked.running) {
            return;
          }
          for (const chunk of splitOutput(data)) {
            post('DATA', { sessionId, data: chunk });
          }
        });
      } catch (err) {
        void err;
      }
      try {
        pty.onExit(({ exitCode, signal }) => {
          handleExit(
            sessionId,
            typeof exitCode === 'number' ? exitCode : null,
            typeof signal === 'number' ? signal : null
          );
        });
      } catch (err) {
        void err;
      }
      post('CREATED', { requestId, sessionId });
      return;
    }
    if (type === 'WRITE') {
      const { sessionId, data } = payload;
      if (!isBoundedId(sessionId) || typeof data !== 'string' || data === '') {
        return;
      }
      const tracked = sessions.get(sessionId);
      if (tracked === undefined || !tracked.running) {
        return;
      }
      try {
        tracked.pty.write(data);
      } catch (err) {
        void err;
      }
      return;
    }
    if (type === 'RESIZE') {
      const { sessionId, cols, rows } = payload;
      // Same bounds as CREATE/main: reject degenerate or absurd sizes
      // instead of forwarding them to the native layer.
      if (
        !isBoundedId(sessionId) ||
        !Number.isInteger(cols) ||
        cols < 20 ||
        cols > 500 ||
        !Number.isInteger(rows) ||
        rows < 5 ||
        rows > 200
      ) {
        return;
      }
      const tracked = sessions.get(sessionId);
      if (tracked === undefined || !tracked.running) {
        return;
      }
      try {
        tracked.pty.resize(cols, rows);
      } catch (err) {
        void err;
      }
      return;
    }
    if (type === 'KILL') {
      const { requestId, sessionId } = payload;
      if (!isBoundedId(requestId) || !isBoundedId(sessionId)) {
        return;
      }
      const tracked = sessions.get(sessionId);
      if (tracked === undefined) {
        post('KILL_RESULT', { requestId, sessionId, outcome: 'gone' });
        return;
      }
      if (!tracked.running) {
        sessions.delete(sessionId);
        post('KILL_RESULT', { requestId, sessionId, outcome: 'gone' });
        return;
      }
      // The blocking call lives HERE (host thread), never on main.
      // On synchronous throw the session stays tracked: a later EXIT
      // still reconciles honestly instead of stranding a zombie.
      try {
        tracked.pty.kill();
      } catch (err) {
        void err;
        post('KILL_RESULT', { requestId, sessionId, outcome: 'failed' });
        return;
      }
      tracked.running = false;
      post('KILL_RESULT', { requestId, sessionId, outcome: 'initiated' });
    }
  }

  deps.onMessage(handleMessage);
  post('READY', {});

  return {
    /** Live session count (diagnostics/tests only). */
    get size() {
      return sessions.size;
    }
  };
}

/**
 * Forked-child entry (integration tests only): when loaded as a plain
 * Node child_process target (process.send present, no Electron
 * parentPort), wire the real node-pty behind the same runtime and
 * speak over process IPC. Production (utilityProcess) never takes
 * this path — the bootstrap wires parentPort explicitly instead.
 */
const forkedChildEntry =
  typeof process !== 'undefined' &&
  typeof process.send === 'function' &&
  (process.parentPort === null || process.parentPort === undefined);

if (forkedChildEntry) {
  (async () => {
    let nodePty = null;
    try {
      const imported = await import('node-pty');
      nodePty = imported && imported.default ? imported.default : imported;
    } catch (err) {
      void err;
    }
    if (nodePty === null || typeof nodePty.spawn !== 'function') {
      process.exit(1);
      return;
    }
    try {
      createTerminalHostRuntime({
        spawnPty: (file, args, options) => nodePty.spawn(file, args, options),
        send: (message) => {
          try {
            process.send(message);
          } catch (err) {
            void err;
          }
        },
        onMessage: (listener) => process.on('message', (message) => listener(message))
      });
    } catch (err) {
      void err;
      process.exit(1);
    }
  })().catch(() => process.exit(1));
}
```

## src/main/terminal/terminal-host-bootstrap.js

```js
'use strict';
/**
 * STARK-owned Terminal Host bootstrap (human PTYs only).
 * ... (verbatim header in repo: ONLY entrypoint, plain dependency-free
 * Node.js, reports READY over the private parent port, routes the
 * closed vocabulary; node-pty resolved beside shipped artifacts;
 * NEVER spawns worker/runtime/extension code.)
 */

async function main() {
  if (process.parentPort === null || process.parentPort === undefined) {
    process.exit(1);
    return;
  }
  const parentPort = process.parentPort;
  let nodePty = null;
  try {
    const imported = await import('node-pty');
    nodePty = imported && imported.default ? imported.default : imported;
  } catch (err) {
    void err;
    process.exit(1);
    return;
  }
  let createRuntime = null;
  try {
    const runtime = await import('./terminal-host.mjs');
    if (runtime !== null && typeof runtime.createTerminalHostRuntime === 'function') {
      createRuntime = runtime.createTerminalHostRuntime;
    }
  } catch (err) {
    void err;
    process.exit(1);
    return;
  }
  if (createRuntime === null || typeof createRuntime !== 'function' || nodePty === null || typeof nodePty.spawn !== 'function') {
    process.exit(1);
    return;
  }
  try {
    createRuntime({
      spawnPty: (file, args, options) => nodePty.spawn(file, args, options),
      send: (message) => parentPort.postMessage(message),
      onMessage: (listener) => parentPort.on('message', (event) => listener(event.data))
    });
  } catch (err) {
    void err;
    process.exit(1);
  }
}

void main();
```

## src/main/terminal/terminal-host-paths.ts

```ts
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Terminal Host artifact locations (dev + packaged).
 *
 * The built main entry (`out/main`) is the single canonical host
 * directory in BOTH dev and packaged runs: `utilityProcess.fork()`
 * runs `terminal-host-bootstrap.js` from there, which loads the
 * sibling `terminal-host.mjs` runtime. The `npm run dev` / `npm run
 * build` scripts copy these files; a cleaned output directory must
 * never leave the fork path dangling.
 */

/** Audited source file → shipped runtime name (verbatim copies, never bundled). */
export const SHIPPED_TERMINAL_HOST_FILES: readonly { src: string; dest: string }[] = [
  { src: 'terminal-host-bootstrap.js', dest: 'terminal-host-bootstrap.js' },
  { src: 'terminal-host.mjs', dest: 'terminal-host.mjs' }
]

/** Canonical fork entrypoint name inside the built main directory. */
export const TERMINAL_HOST_BOOTSTRAP_FILE = 'terminal-host-bootstrap.js'

/** Whether every shipped host artifact exists in a main directory. */
export function terminalHostArtifactsComplete(mainDir: string): boolean {
  return SHIPPED_TERMINAL_HOST_FILES.every((file) => existsQuietly(join(mainDir, file.dest)))
}

function existsQuietly(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** Missing artifact names in a main directory (bounded, renderer-safe labels only). */
export function missingTerminalHostArtifacts(mainDir: string): readonly string[] {
  const missing: string[] = []
  for (const file of SHIPPED_TERMINAL_HOST_FILES) {
    if (!existsQuietly(join(mainDir, file.dest))) {
      missing.push(file.dest)
    }
  }
  return missing
}

/**
 * Copies missing host artifacts verbatim from the audited source
 * directory into the built main directory. Returns the names that
 * were copied. Throws on I/O failure (caller logs main-side only).
 */
export function ensureTerminalHostArtifacts(mainDir: string, sourceDir: string): readonly string[] {
  const copied: string[] = []
  mkdirSync(mainDir, { recursive: true })
  for (const file of SHIPPED_TERMINAL_HOST_FILES) {
    const dest = join(mainDir, file.dest)
    if (existsQuietly(dest)) {
      continue
    }
    copyFileSync(join(sourceDir, file.src), dest)
    copied.push(file.dest)
  }
  return copied
}

/** Audited host source directory for a dev app path (runtime-derived, never hardcoded). */
export function devTerminalHostSourceDir(appPath: string): string {
  return join(appPath, 'src', 'main', 'terminal')
}
```

## src/main/terminal/terminal-host-fake.ts

```ts
import type {
  TerminalHostClient,
  TerminalHostClientEvent,
  TerminalHostCreateInput,
  TerminalHostKillOutcome
} from './terminal-host-client'

/**
 * Test fake Terminal Host client (unit suites only — never production).
 *
 * Mirrors the real host contract without processes: create records
 * and resolves, write/resize record per session, kill answers with a
 * configured outcome, and tests fire DATA/EXIT/host-down explicitly
 * (including deferred exits for slow-teardown simulation). No
 * timers, no retries, no real waiting unless a test opts into a
 * deferred gate it controls.
 */

export interface FakeHostSession {
  readonly id: string
  readonly workspaceId: string | number
  readonly cwd: string
  readonly shellFile: string
  readonly written: string[]
  readonly resized: Array<{ cols: number; rows: number }>
  kills: number
  exited: boolean
}

export interface FakeTerminalHostOptions {
  /** Fail every create with a spawn error. */
  readonly failCreate?: boolean
  /** Spawn the session but then throw, simulating a lost CREATE acknowledgement (orphan drill). */
  readonly loseCreateAck?: boolean
  /** When true, create() waits until releaseCreate() before proceeding. */
  readonly deferCreate?: boolean
  /** Answer every kill with this outcome (default 'initiated'). */
  readonly killOutcome?: TerminalHostKillOutcome
  /** When true, kill() returns a promise resolved only via releaseKill(). */
  readonly deferKill?: boolean
  /** Fail shutdown. */
  readonly failShutdown?: boolean
}

export interface FakeTerminalHost extends TerminalHostClient {
  readonly sessions: Map<string, FakeHostSession>
  readonly created: TerminalHostCreateInput[]
  readonly shutdowns: number
  fireData(sessionId: string, data: string): void
  fireExit(sessionId: string, exitCode: number | null, signal: number | null): void
  fireHostDown(): void
  releaseKill(): void
  releaseCreate(): void
}

export function createFakeTerminalHostClient(options: FakeTerminalHostOptions = {}): FakeTerminalHost {
  const sessions = new Map<string, FakeHostSession>()
  const created: TerminalHostCreateInput[] = []
  const listeners = new Set<(event: TerminalHostClientEvent) => void>()
  let shutdowns = 0
  let killWaiters: Array<() => void> = []
  let createWaiters: Array<() => void> = []

  function emit(event: TerminalHostClientEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // Listener failures must never break the fake.
      }
    }
  }

  return {
    sessions,
    created,
    get shutdowns() {
      return shutdowns
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    create: async (input: TerminalHostCreateInput) => {
      created.push(input)
      if (options.deferCreate === true) {
        await new Promise<void>((resolve) => {
          createWaiters.push(resolve)
        })
      }
      if (options.failCreate === true) {
        throw new Error('Terminal Host failed to start the terminal.')
      }
      sessions.set(input.sessionId, {
        id: input.sessionId,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        shellFile: input.shellFile,
        written: [],
        resized: [],
        kills: 0,
        exited: false
      })
      if (options.loseCreateAck === true) {
        throw new Error('Terminal Host acknowledgement lost.')
      }
    },
    write: (sessionId: string, data: string) => {
      sessions.get(sessionId)?.written.push(data)
    },
    resize: (sessionId: string, cols: number, rows: number) => {
      sessions.get(sessionId)?.resized.push({ cols, rows })
    },
    kill: async (sessionId: string): Promise<TerminalHostKillOutcome> => {
      if (options.deferKill === true) {
        await new Promise<void>((resolve) => {
          killWaiters.push(resolve)
        })
      }
      const tracked = sessions.get(sessionId)
      if (tracked === undefined) {
        return 'gone'
      }
      tracked.kills += 1
      return options.killOutcome ?? 'initiated'
    },
    shutdown: async () => {
      shutdowns += 1
      if (options.failShutdown === true) {
        throw new Error('Terminal Host failed to stop.')
      }
    },
    fireData: (sessionId: string, data: string) => {
      emit({ kind: 'data', sessionId, data })
    },
    fireExit: (sessionId: string, exitCode: number | null, signal: number | null) => {
      const tracked = sessions.get(sessionId)
      if (tracked !== undefined) {
        tracked.exited = true
      }
      emit({ kind: 'exit', sessionId, exitCode, signal })
    },
    fireHostDown: () => {
      emit({ kind: 'host-down' })
    },
    releaseKill: () => {
      const waiting = killWaiters
      killWaiters = []
      for (const resolve of waiting) {
        resolve()
      }
    },
    releaseCreate: () => {
      const waiting = createWaiters
      createWaiters = []
      for (const resolve of waiting) {
        resolve()
      }
    }
  }
}
```

## src/main/terminal/errors.ts

```ts
/**
 * Terminal domain errors (Stage 11).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain paths, PIDs, environment values,
 * or stack traces. Internal causes stay in main-process diagnostics.
 */

export class TerminalError extends Error {
  override readonly name: string = 'TerminalError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Request payload failed runtime validation. */
export class InvalidTerminalRequestError extends TerminalError {
  override readonly name = 'InvalidTerminalRequestError'
}

/** No session exists for the requested ID. */
export class TerminalNotFoundError extends TerminalError {
  override readonly name = 'TerminalNotFoundError'

  constructor() {
    super('That terminal session is no longer available.')
  }
}

/** The caller does not own the requested session. */
export class TerminalOwnershipError extends TerminalError {
  override readonly name = 'TerminalOwnershipError'

  constructor() {
    super('That terminal session is no longer available.')
  }
}

/** The workspace root is gone or inaccessible. */
export class TerminalWorkspaceUnavailableError extends TerminalError {
  override readonly name = 'TerminalWorkspaceUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('That project folder is no longer available.', options)
  }
}

/** The shell could not start or the PTY backend is unavailable. */
export class TerminalUnavailableError extends TerminalError {
  override readonly name = 'TerminalUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('We couldn’t start the terminal.', options)
  }
}

/**
 * Termination was requested but could not be initiated and the
 * terminal may still be alive. The renderer restores the terminal so
 * the user never loses a live session; no paths, PIDs, or stacks.
 */
export class TerminalCloseFailedError extends TerminalError {
  override readonly name = 'TerminalCloseFailedError'

  constructor(options?: { cause?: unknown }) {
    super('We couldn’t close the terminal.', options)
  }
}

/** Too many live human terminals: calm cap copy, never an eviction. */
export class TerminalLimitError extends TerminalError {
  override readonly name = 'TerminalLimitError'

  constructor() {
    super('Too many terminals are open. Close one before creating another.')
  }
}

export type TerminalOperation = 'create' | 'write' | 'resize' | 'kill'

/**
 * Maps any terminal-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicTerminalError(operation: TerminalOperation, error: unknown): Error {
  if (error instanceof TerminalWorkspaceUnavailableError) {
    return new Error(error.message)
  }
  if (error instanceof TerminalLimitError) {
    return new Error(error.message)
  }
  if (error instanceof TerminalNotFoundError || error instanceof TerminalOwnershipError) {
    return new Error(error.message)
  }
  if (error instanceof InvalidTerminalRequestError) {
    if (operation === 'write' || operation === 'resize') {
      return new Error('That terminal input was not accepted.')
    }
    if (operation === 'kill') {
      return new Error('That terminal session is no longer available.')
    }
    return new Error('We couldn’t start the terminal.')
  }
  if (error instanceof TerminalUnavailableError) {
    return new Error(error.message)
  }
  if (error instanceof TerminalCloseFailedError) {
    return new Error(error.message)
  }
  if (operation === 'write' || operation === 'resize') {
    return new Error('That terminal input was not accepted.')
  }
  if (operation === 'kill') {
    return new Error('That terminal session is no longer available.')
  }
  return new Error('We couldn’t start the terminal.')
}
```

## src/main/terminal/limits.ts

```ts
/**
 * Central limits for the Stage 11 human terminal.
 * Single definitions — no layer duplicates these numbers.
 */

/** xterm dimension bounds enforced in main (renderer clamps first). */
export const MIN_TERMINAL_COLS = 20
export const MAX_TERMINAL_COLS = 500
export const MIN_TERMINAL_ROWS = 5
export const MAX_TERMINAL_ROWS = 200

/** Default dimensions when the renderer has no laid-out size yet. */
export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24

/** Largest human-keystroke payload accepted per IPC write (64 KiB). */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024

/** Largest PTY output chunk forwarded per IPC data event (64 KiB). */
export const MAX_TERMINAL_OUTPUT_CHUNK_BYTES = 64 * 1024

/** Longest accepted opaque session id string. */
export const MAX_TERMINAL_SESSION_ID_LENGTH = 128

/**
 * Hard cap on live human terminals per owning renderer. Creation past
 * the cap fails calmly (no eviction, never silently killing an
 * existing terminal). Main enforces authoritatively; the renderer
 * pre-checks to avoid futile spawn attempts.
 */
export const MAX_HUMAN_TERMINALS = 8

/** xterm visible scrollback lines (renderer-side, no persistence). */
export const TERMINAL_SCROLLBACK_LINES = 5000
```

## src/main/terminal/shell-policy.ts

```ts
/**
 * Shell selection policy (Stage 11).
 *
 * The renderer NEVER sends an executable: the main process chooses a
 * safe platform default. Pure data — no spawning here — so the policy
 * is unit-testable without the native PTY binary.
 */

export interface SelectedShell {
  /** Executable launched directly by node-pty (never renderer-chosen). */
  readonly file: string
  /** Deterministic args for the selected shell. */
  readonly args: readonly string[]
  /** Short human label for the terminal header (e.g. PowerShell). */
  readonly label: string
}

/**
 * Selects the interactive shell for the given platform.
 * Windows uses powershell.exe with -NoLogo; macOS uses /bin/zsh;
 * Linux prefers /bin/bash with /bin/sh as fallback.
 */
export function selectShell(platform: NodeJS.Platform = process.platform): SelectedShell {
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
  }
  if (platform === 'darwin') {
    return { file: '/bin/zsh', args: [], label: 'zsh' }
  }
  return { file: '/bin/bash', args: [], label: 'bash' }
}

/** Fallback shell when the preferred Linux shell is unavailable. */
export function fallbackShell(): SelectedShell {
  return { file: '/bin/sh', args: [], label: 'sh' }
}
```

## src/main/terminal/terminal-environment.ts

```ts
/**
 * PTY environment construction (Stage 11).
 *
 * Built entirely in main: the renderer supplies no environment maps.
 * The current process environment is filtered to valid string values
 * (never logged), then terminal markers are applied. Values are never
 * printed or logged by this module.
 */

export type RawEnvironment = Record<string, string | undefined>

function isValidEnvValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

/**
 * Builds the environment map for node-pty spawn.
 * Filters the host environment to defined non-empty NUL-free strings,
 * then pins TERM/COLORTERM/TERM_PROGRAM for xterm compatibility.
 */
export function buildTerminalEnv(source: RawEnvironment = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key !== '' && !key.includes('\0') && isValidEnvValue(value)) {
      env[key] = value
    }
  }
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'STARK'
  return env
}
```

## src/main/terminal/terminal-service.ts

```ts
import { realpath, stat } from 'node:fs/promises'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidTerminalRequestError, TerminalWorkspaceUnavailableError } from './errors'

function isValidWorkspaceId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Terminal domain service (Stage 11): request validation plus trusted
 * Workspace → cwd resolution. The renderer supplies only a persisted
 * workspaceId; the main process resolves the live canonical directory.
 * Never starts in HOME on failure — a missing workspace is a
 * controlled unavailable error with safe copy.
 */
export class TerminalService {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  validateCreateRequest(payload: unknown): { workspaceId: number; cols: number; rows: number } {
    if (typeof payload !== 'object' || payload === null) {
      throw new InvalidTerminalRequestError('terminal request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, cols, rows } = record
    if (!isValidWorkspaceId(workspaceId)) {
      throw new InvalidTerminalRequestError('workspace reference is invalid')
    }
    if (
      typeof cols !== 'number' ||
      typeof rows !== 'number' ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows)
    ) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    return { workspaceId, cols, rows }
  }

  /**
   * Resolves the trusted startup cwd for a workspace: persisted
   * rootPath → live directory check → canonical realpath. Throws the
   * safe unavailable copy when the folder is gone.
   */
  async resolveWorkspaceCwd(workspaceId: number): Promise<string> {
    const stored = this.workspaces.findById(workspaceId)
    if (stored === undefined) {
      throw new TerminalWorkspaceUnavailableError()
    }
    try {
      const stats = await stat(stored.rootPath)
      if (!stats.isDirectory()) {
        throw new TerminalWorkspaceUnavailableError()
      }
      return await realpath(stored.rootPath)
    } catch (error) {
      if (error instanceof TerminalWorkspaceUnavailableError) {
        throw error
      }
      throw new TerminalWorkspaceUnavailableError({ cause: error })
    }
  }
}
```

## src/main/terminal/pty-adapter.ts

```ts
/**
 * Native PTY boundary (Stage 11).
 *
 * PtyAdapter isolates the node-pty binary so unit tests inject a fake
 * implementation and never require the native module in ordinary
 * system-Node suites. Real loading happens only in node-pty-adapter
 * inside Electron.
 */

export interface PtyExit {
  readonly exitCode: number | null
  readonly signal: number | null
}

export interface PtySpawnOptions {
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
}

/** Minimal handle over one native pseudoterminal instance. */
export interface PtyHandle {
  /** OS pid when exposed by the backend; otherwise undefined. */
  readonly pid?: number
  onData: (callback: (data: string) => void) => void
  onExit: (callback: (exit: PtyExit) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

/** Factory that spawns one native PTY for a main-chosen shell. */
export interface PtyFactory {
  spawn: (file: string, args: readonly string[], options: PtySpawnOptions) => PtyHandle
}

/**
 * Splits PTY output into bounded IPC payloads (UTF-8 byte budget).
 * Main acts as a streaming bridge: huge PTY chunks are forwarded as
 * sequential bounded events, never accumulated into one history buffer.
 */
export function splitOutputForIpc(data: string, maxBytes: number): string[] {
  if (data === '' || maxBytes <= 0) {
    return data === '' ? [] : [data]
  }
  if (Buffer.byteLength(data, 'utf8') <= maxBytes) {
    return [data]
  }
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const char of data) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (currentBytes + charBytes > maxBytes && current !== '') {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    // A single char larger than the budget still forwards alone.
    current += char
    currentBytes += charBytes
  }
  if (current !== '') {
    chunks.push(current)
  }
  return chunks
}
```

## src/main/terminal/node-pty-adapter.ts

```ts
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-adapter'

/**
 * Production PtyFactory over the node-pty native module.
 *
 * The require is intentionally lazy and local to this module so the
 * native binary loads only inside Electron's main process — never in
 * ordinary system-Node unit tests (those inject a fake PtyFactory).
 * node-pty ships N-API prebuilds, so no ABI-specific rebuild is needed
 * for the current Electron version; a load failure surfaces as a
 * controlled terminal-unavailable error at spawn time.
 */
export function createNodePtyFactory(): PtyFactory {
  return {
    spawn: (file: string, args: readonly string[], options: PtySpawnOptions): PtyHandle => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require('node-pty') as {
        spawn: (
          file: string,
          args: string[] | string,
          opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
        ) => {
          readonly pid: number
          onData: (cb: (data: string) => void) => void
          onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
          write: (data: string) => void
          resize: (cols: number, rows: number) => void
          kill: (signal?: string) => void
        }
      }
      const proc = pty.spawn(file, [...args], {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env
      })
      return {
        pid: proc.pid,
        onData: (callback) => proc.onData(callback),
        onExit: (callback) =>
          proc.onExit(({ exitCode, signal }) => {
            callback({
              exitCode: typeof exitCode === 'number' ? exitCode : null,
              signal: typeof signal === 'number' ? signal : null
            })
          }),
        write: (data) => proc.write(data),
        resize: (cols, rows) => proc.resize(cols, rows),
        kill: () => proc.kill()
      }
    }
  }
}
```

## src/main/ipc/terminal.ts

```ts
import { webContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { TerminalDataEvent, TerminalExitEvent } from '../../shared/terminal/types'
import { toPublicTerminalError } from '../terminal/errors'
import { buildTerminalEnv } from '../terminal/terminal-environment'
import { TerminalManager } from '../terminal/terminal-manager'
import { TerminalService } from '../terminal/terminal-service'
import { selectShell } from '../terminal/shell-policy'
import type { IpcBinding } from './binding'

async function withPublicTerminalError<T>(operation: 'create' | 'write' | 'resize' | 'kill', run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toPublicTerminalError(operation, error)
  }
}

function sendToOwner(ownerWebContentsId: number, channel: string, payload: unknown): void {
  const contents = webContents.fromId(ownerWebContentsId)
  if (contents === undefined || contents.isDestroyed()) {
    return
  }
  try {
    contents.send(channel, payload)
  } catch {
    // Best effort streaming: a destroyed renderer simply stops receiving.
  }
}

/**
 * Creates the terminal event sink that routes PTY output/exit ONLY to
 * the owning WebContents. No broadcasting, no cross-session subscribe.
 */
export function createTerminalEventSink(): {
  sendData: (ownerWebContentsId: number, event: TerminalDataEvent) => void
  sendExit: (ownerWebContentsId: number, event: TerminalExitEvent) => void
} {
  return {
    sendData: (ownerWebContentsId, event) => {
      sendToOwner(ownerWebContentsId, IPC_CHANNELS.terminalData, event)
    },
    sendExit: (ownerWebContentsId, event) => {
      sendToOwner(ownerWebContentsId, IPC_CHANNELS.terminalExit, event)
    }
  }
}

/**
 * Terminal IPC bindings: exactly four invoke channels (create/write/
 * resize/kill). No shell/executable/cwd/env choice, no generic
 * spawn/exec, no child_process surface. Ownership derives from the
 * validated invoke sender; every operation verifies it in the manager.
 * Fixed data/exit event channels flow main → owner renderer only.
 */
export function createTerminalBindings(
  service: TerminalService,
  manager: TerminalManager
): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.terminalCreate,
      invoke: (payload, event) =>
        withPublicTerminalError('create', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('create', new Error('untrusted sender'))
          }
          const ownerWebContentsId = event.sender.id
          const request = service.validateCreateRequest(payload)
          const cwd = await service.resolveWorkspaceCwd(request.workspaceId)
          const shell = selectShell(process.platform)
          const env = buildTerminalEnv()
          return manager.createSessionWithEnv({
            ownerWebContentsId,
            workspaceId: request.workspaceId,
            cwd,
            shellFile: shell.file,
            shellArgs: shell.args,
            shellLabel: shell.label,
            cols: request.cols,
            rows: request.rows,
            env
          })
        })
    },
    {
      channel: IPC_CHANNELS.terminalWrite,
      invoke: (payload, event) =>
        withPublicTerminalError('write', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('write', new Error('untrusted sender'))
          }
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
          manager.writeSession(event.sender.id, record['sessionId'], record['data'])
        })
    },
    {
      channel: IPC_CHANNELS.terminalResize,
      invoke: (payload, event) =>
        withPublicTerminalError('resize', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('resize', new Error('untrusted sender'))
          }
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
          manager.resizeSession(event.sender.id, record['sessionId'], record['cols'], record['rows'])
        })
    },
    {
      channel: IPC_CHANNELS.terminalKill,
      invoke: (payload, event) =>
        withPublicTerminalError('kill', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('kill', new Error('untrusted sender'))
          }
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
          await manager.killSession(event.sender.id, record['sessionId'])
        })
    }
  ]
}
```


## scripts/copy-terminal-host-bootstrap.cjs

```js
/**
 * Copies the STARK-owned Terminal Host files into the built main
 * output so production packages (and the smoke runner) can fork them.
 *
 * The bootstrap entrypoint plus the dependency-free host runtime are
 * copied verbatim, never bundled, so what ships is exactly what is
 * audited in src/main/terminal/. Fails the build if any source is
 * missing. Human PTYs only — never mixed with the Extension Host.
 */
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const SOURCE_DIR = join(ROOT, 'src', 'main', 'terminal');
const DEST_DIR = join(ROOT, 'out', 'main');

const SHIPPED_HOST_FILES = [
  // Bootstrap entrypoint (forked by Electron utilityProcess).
  { src: 'terminal-host-bootstrap.js', dest: 'terminal-host-bootstrap.js' },
  // Human-PTY host runtime (loaded only via the bootstrap's narrow
  // dynamic import of the STARK-owned sibling URL).
  { src: 'terminal-host.mjs', dest: 'terminal-host.mjs' }
];

mkdirSync(DEST_DIR, { recursive: true });
for (const file of SHIPPED_HOST_FILES) {
  const source = join(SOURCE_DIR, file.src);
  if (!existsSync(source)) {
    process.stderr.write(`[terminal-host] FAILED: missing ${source}\n`);
    process.exit(1);
  }
  copyFileSync(source, join(DEST_DIR, file.dest));
  process.stdout.write(`[terminal-host] ${file.src} copied to ${join(DEST_DIR, file.dest)}\n`);
}
```

## Cross-cutting integration (excerpts, not full files)

### src/renderer/src/features/explorer/Explorer.tsx — terminal integration

State + guards (lines ~360–373):

```tsx
const [terminals, terminalDispatch] = useReducer(terminalSessionsReducer, workspaceId, (id) => ({
  ...initialTerminalSessionsState(),
  workspaceId: id
}))
const terminalInstancesRef = useRef(new Map<string, Terminal>())
const terminalClosingRef = useRef(new Set<string>())
const terminalCloseGenRef = useRef(new Map<string, number>()) // bounded close generation per id
```

Event subscriptions — DATA routes to owning xterm; EXIT bumps generation while closing, dispatches `exit-received`, writes `[Terminal exited]`:

```tsx
const offExit = api.onExit((event) => {
  if (terminalClosingRef.current.has(event.sessionId)) {
    terminalCloseGenRef.current.set(event.sessionId, (terminalCloseGenRef.current.get(event.sessionId) ?? 0) + 1)
  }
  terminalDispatch({ type: 'exit-received', exit: event })
  const term = terminalInstancesRef.current.get(event.sessionId)
  // ... term.write('\r\n[Terminal exited]\r\n') best-effort
})
```

Create / split / duplicate / select / kill (lines ~580–711): `spawnTerminal` (pending key → `api.create({workspaceId, cols, rows})` → `start-succeeded`; mid-spawn unmount kills the orphan); `handleNewTerminal` (cap pre-check); `handleSplitTerminal`/`handleDuplicateTerminal` (require live running non-closing source + cap; split additionally `split-opened`); `handleSelectTerminal` (`session-selected`); `handleKillTerminal` (unknown → noop; `status !== 'running'` → `close-finalized` locally with no IPC; else single-flight + generation + `close-requested`, then `api.kill` with stale-generation ignore, `close-finalized` on success/gone, `close-aborted` + calm copy only on
genuine live failure, `finally` unconditionally releasing both guards so the map stays bounded by in-flight
closes). `handleClearTerminal` is display-only. Split ratio, focus-follow, workspace-switch kill-all (concurrent
`Promise.all` over `api.kill` per exact id, best-effort), `TerminalDrawer` (`sessions.filter(!closingIds)`) and `TerminalPanel` (`visibleIds={visibleTerminalIds(terminals)}`) wiring complete the integration. Full function bodies: see `Explorer.tsx` lines 484–723 and 1900–2030.

### src/preload/index.ts — terminal bridge (excerpt)

```ts
function createTerminalApi(): TerminalApi {
  return {
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, request),
    write: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalWrite, request),
    resize: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request),
    kill: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalKill, request),
    onData: (listener) => { /* validated ipcRenderer.on(terminalData) */ },
    onExit: (listener) => { /* validated ipcRenderer.on(terminalExit) */ }
  }
}
// exposed as: terminal: createTerminalApi()
```

### src/main/index.ts — terminal wiring (excerpts)

```ts
// Single process-wide owner:
let terminalManager: TerminalManager | null = null
// Quit: void terminalManager?.shutdownAll(); terminalManager = null
// Window destroyed: terminalManager?.handleWebContentsDestroyed(ownerId)
// Startup (never autostarted; first explicit create starts it):
//   ensureTerminalHostArtifacts(__dirname, devTerminalHostSourceDir(app.getAppPath()))
//   fork terminal-host-bootstrap.js via utilityProcess.fork
//   terminalManager = new TerminalManager(new TerminalProcessClient(terminalHostManager), createTerminalEventSink())
// IPC registration receives terminalService + terminalManager.
```

### src/shared/constants/index.ts — terminal channels (excerpt)

```ts
terminalCreate: 'stark:terminal:create',
terminalWrite: 'stark:terminal:write',
terminalResize: 'stark:terminal:resize',
terminalKill: 'stark:terminal:kill',
terminalData: 'stark:terminal:data',
terminalExit: 'stark:terminal:exit',
```

### package.json / electron.vite.config.ts (excerpts)

- `dev`: copy extension-host + terminal-host bootstraps, then `electron-vite dev`.
- `build`: `electron-vite build`, then both copy scripts (host files land verbatim in `out/main`, never bundled).
- Deps include `node-pty` (prebuilds `asarUnpack`ed); renderer bundle is framework-only with no Node access; preload is single-file CJS.

---

## Hardening Pass Amendments (B1–B7 / H1–H2 / D1)

Proven by bounded real-process probes on Windows (real ConPTY via the
actual host runtime) and fixed with regression tests:

- **B1 — stop() orphaned the host process.** `SHUTDOWN_COMPLETE` is a
  message, not process exit: the host never self-terminates, and
  `stop()` detached without killing, so every stop leaked a live
  utility process (proven: PID alive 4 s+ after COMPLETE). Now
  `finishStopped()` runs `killOwned()` on the exact child before
  detach (runtime-proven: PID dead 1 s after stop), with a local
  settled flag so exit-during-stopping settles at once.
- **B2 — CREATE ack loss orphaned a live PTY.** A timed-out/failed
  `host.create` after a successful spawn left a host-owned PTY nobody
  tracked (proven: post-timeout KILL answered `initiated`). Now
  `spawnSession` runs exact scoped `host.kill(id)` cleanup before
  throwing `Unavailable`.
- **B3 — cap counted only `running`.** A kill-initiated session
  (`running=false`, ConPTY still alive) freed its slot, permitting 9
  tracked resources. Now `liveCountForOwner` counts every tracked
  non-`ownerGone` session; the slot frees on authoritative EXIT (renderer
  pre-check already counts this way, so both layers agree).
- **B4 — window-destroy dropped bookkeeping on unconfirmed kills.**
  Fire-and-forget kill + immediate removal orphaned the PTY when the
  kill failed/timed out, and destroy-during-CREATE tracked sessions
  for dead owners. Now records are retained with `ownerGone` until
  EXIT/host-down reaps them (front-door ops reject `NotFound`,
  data/cap/active-owner views skip them), and a bounded
  pending-create/dead-owner registry routes mid-create deaths to
  exact cleanup instead of tracking.
- **B5 — stop-during-starting hung waiters.** The `starting` branch
  never settled `readyWaiters`/`startingPromise`, so pending
  `ensureReady()` callers hung forever. Now it settles with a
  `stopped` error.
- **B6 — `terminalCloseGenRef` leaked on the EXIT-bump path.** The
  conditional release skipped the bumped generation. Now the
  `finally` deletes unconditionally (safe under single-flight).
- **B7 — host accepted out-of-range dims.** CREATE allowed 1..500 and
  RESIZE any integer; main enforces 20..500 × 5..200. Now the host
  fails closed on the same bounds (WRITE stays implicitly bounded by
  the 64 KiB message cap).
- **H1 — switch kills are concurrent + guard renamed.**
  `closeActiveTerminalForSwitch` (singular, misleading — it kills
  ALL) is now `closeAllTerminalsForSwitch` with multi-terminal
  comments; the kill-all uses one `Promise.all` over exact kills.
- **H2 — hidden xterms observe nothing.** The `ResizeObserver` now
  attaches only while visible (refit on reveal already existed), so
  `display:none` panes churn no rAF/IPC while staying mounted.
- **D1 — dead constant removed.** `TERMINAL_SHUTDOWN_TIMEOUT_MS` had
  exactly one reference (its own export); removed after proof.
- Not rebuilt: the shared single-thread host stays. Bounded probes
  (busy/flooding shells, 5 rounds) measured `pty.kill()` at 10–17 ms
  with sibling round-trips at baseline (15–22 ms) — no cross-terminal
  stall reproduces in this environment, so per-PTY processes would be
  speculation-grade rearchitecture. The isolation suite now asserts an
  unconditional 5 s sibling-latency SLO as the tripwire.

## Reviewer Notes (what to check first)

1. `terminal-state.ts` reducer: `exit-received` + `close-aborted` guards are the race fix — verify EXIT-while-closing finalizes and stale aborts never set errors.
2. `Explorer.tsx handleKillTerminal` + `offExit`: exited fast-path (no IPC) and `terminalCloseGenRef` invalidation.
3. `terminal-manager.ts killSession`: post-await `sessions.get(id) === undefined → NotFound` normalization.
4. `terminal-host.mjs` KILL/EXIT interplay: `failed` keeps tracking so later EXIT reconciles; `gone` vs `initiated` mapping.
5. Security: only 4 invoke channels, owner-only events, main-chosen shell/cwd/env, no PID/path leakage in errors.
6. Tests: `terminal-state.test.ts` (CASE 1–7), `terminal-manager.test.ts` (deferred-kill races), `terminal-activity.test.ts` (source invariants), host protocol/manager/runtime/path suites.
