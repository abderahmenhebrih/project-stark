# STARK Frontend Redesign Dossier (`redesign.md`)

Handoff document for the final UI redesign. Describes the CURRENT STARK
renderer implementation exactly as it exists in the repository. No code
was changed to produce this document. Schema is v18; no backend/IPC
change is in scope.

Conventions: paths are repo-relative. `src/renderer/src/` is the React
app (`main.tsx` boots `App`, `styles/global.css` is imported first, so
component CSS files loaded later win equal-specificity conflicts).

## 1. CURRENT SCREEN MAP (top-left → bottom-right, workspace active)

| # | Region | Component | CSS file | Parent | Size / layout | Fixed or flex | Collapsible | Controlling state |
|---|--------|-----------|----------|--------|---------------|---------------|-------------|-------------------|
| 1 | App chrome (single 40px bar) | `layouts/AppChrome.tsx` | `layouts/AppChrome.css` | `pages/HomePage.tsx` → `.stage-shell` | `min-height: 40px`, full width, flex row | Fixed height, flex children | No | None (always rendered when workspace active) |
| 2 | STARK mark + wordmark (left of chrome) | `components/StarkMark.tsx` (`size="bar"`) inside `AppChrome` | `components/StarkMark.css` | `.app-chrome__brand` | 12×12px mark + 12px letterspaced wordmark | Fixed | No | None; `src` prop empty → CSS fallback |
| 3 | Workspace identity (chrome center) | `AppChrome` (`workspaceName`, `workspacePath` props) | `AppChrome.css` (`.app-chrome__identity`, `.app-chrome__workspace`) | `.app-chrome` | flex:1, ellipsis; full path only in `title` tooltip | Flex | No | `workspace.current` via `useApp()` in `HomePage` |
| 4 | Chrome view controls (right) | `AppChrome` (☰ sidebar, ⌁ terminal) | `AppChrome.css` | `.app-chrome__controls` | Two 30×30px buttons, `aria-pressed` | Fixed | N/A (they ARE the toggles) | `sidebarOpen`, `terminalOpen` in `HomePage` |
| 5 | Activity rail (far left column) | `features/explorer/ActivityRail.tsx` | `features/explorer/Explorer.css` (`.activity-rail`, `.workbench__tabs`, `.explorer__tab*`) | `.workbench` grid area `rail` | 48px wide, full height, vertical icon+9px label buttons (▤ Explorer, ⌕ Search, ⇄ Changes, ⎇ Git), lime indicator + dim wash when active | Grid area, fixed width | No | `activity` / `onActivityChange` (state in `HomePage`) |
| 6 | Contextual sidebar | `aside.workbench__sidebar` rendered by `Explorer.tsx`; content = `WorkspaceSection` + `workbench__sidebar-body` | `Explorer.css` | `.workbench` grid area `sidebar` | 264px (248 ≤1500px, 232 ≤1280px, 216 ≤900px), flex column, 12px radius card | Grid area | Yes — `{sidebarOpen && ...}` via chrome ☰ toggle | `sidebarOpen` in `HomePage` |
| 7 | Workspace switcher (sidebar head) | `features/workspace/WorkspaceSection.tsx` | `features/workspace/WorkspaceSection.css` + sidebar overrides in `Explorer.css` (`.workbench__sidebar > .workspace--compact`) | `aside.workbench__sidebar` | Compact card: name + mono path + `Open another folder` + collapsible `Recent (n)` `<details>` | Flex | No (lives inside collapsible sidebar) | `useApp()` workspace store |
| 8 | Sidebar body (contextual content) | `TreeNode` / `SearchPanel` / `ChangeSetPanel`+`ChangesPanel` / `GitPanel`, switched on `activity` | `Explorer.css` (`.workbench__sidebar-body`: flex:1, scroll, 8px padding) | `aside.workbench__sidebar` | Fills sidebar | Flex | Follows sidebar | `activity` prop |
| 9 | Explorer tree | `TreeNode` (recursive, in `Explorer.tsx`) | `Explorer.css` (`.explorer__branch`, `__row`, `__name`, `__attach`, `__chevron`, `__badge`) | `.workbench__sidebar-body` | Rows: chevron + sans 13px one-line ellipsis name + compact 22px `Attach` button; symlinks show `link` pill | Flex rows | Directories expand per `state.expanded` | `explorer-state` reducer |
| 10 | Search pane | `features/search/SearchPanel.tsx` | `features/search/SearchPanel.css` | sidebar body | Form (label + search input + case checkbox + submit) + status + result rows (path, line:col, preview + Attach) | Normal flow, body scrolls | Follows sidebar | `search-state` reducer, remounts per workspace |
| 11 | Changes pane | `features/changes/ChangesPanel.tsx` (+ `ChangeSetPanel`) | `features/changes/changes.css` | sidebar body | History list (≤20, name + status badge + time) + grouped sets above it | Normal flow | Follows sidebar | `changes-state` / `change-set-state` reducers |
| 12 | Git pane | `features/git/GitPanel.tsx` | `features/git/git.css` | sidebar body | Header (title + Refresh), branch, upstream meta, Conflicts/Staged/Changes/Untracked groups of row-buttons | Normal flow | Follows sidebar | `git-state` reducer, explicit fetch only |
| 13 | Primary canvas (dominant surface) | `section.primary-canvas` rendered by `Explorer.tsx` | `Explorer.css` | `.workbench` grid area `canvas` | flex:1 (`minmax(0,1fr)` column), 14px radius elevated card | Grid area, flexes | No | Always present |
| 14 | Session / Editor tabs | `.canvas-tabs` in `Explorer.tsx` | `Explorer.css` | `.primary-canvas` | Two 30px tabs; active Session = magenta dot, active Editor = lime dot | Fixed strip | No | `canvasView` / `onCanvasViewChange` (state in `HomePage`, default `'session'`) |
| 15 | Session conversation view | `features/sessions/SessionPanel.tsx` (`section.session`) via `sessionNode` prop | `session.css` + `.canvas-view` rules in `Explorer.css` | `.canvas-view` (`hidden` unless session) | flex:1 column; message list max 880px centered | Flex (stays mounted, `hidden` toggles) | No | `canvasView`; remounts per workspace via `key={active.id}` |
| 16 | Editor view | `section.workbench__editor` in `Explorer.tsx` (toolbar + Monaco / diff / review / empty state) | `Explorer.css`, `features/editor/editor.css` | `.canvas-view` (`hidden` unless editor) | flex:1 column | Flex (stays mounted) | No | `canvasView`; review/diff/preview state inside `Explorer` |
| 17 | Attached context drawer | `.session__context` in `SessionPanel.tsx` | `session.css` | `section.session` (above composer) | Full session width, `max-height: 40%`, own scroll; header shows `Attached context (n)` + Collapse/Expand + Add note | Flex | Yes — `contextOpen` toggle (default open) | `contextOpen` local state |
| 18 | Composer dock | `.session__composer` in `SessionPanel.tsx` | `session.css` | `section.session` (last) | 12px rounded elevated card, margin 8px; mode row + textarea (64–200px) + hint + Send | Fixed at conversation bottom | No | `proposal.mode`, `composer`, `sendDisabled` |
| 19 | Session options menu | `details.session__menu` in `SessionPanel.tsx` header | `session.css` | `.session__header` | Absolute dropdown 220–280px: Settings toggle + History select | Popup | Native `<details>` open/close | Uncontrolled DOM state |
| 20 | Terminal drawer (bottom row) | `.bottom-drawer` in `Explorer.tsx` + `features/terminal/TerminalPanel.tsx` | `Explorer.css`, `TerminalPanel.css` | `.workbench` grid area `drawer` (spans all columns) | Closed: single 32px `⌁ Terminal` handle. Open: 32px bar + 200px xterm viewport | Grid row `auto` | Yes — chrome ⌁ toggle + Hide button | `terminalOpen` in `HomePage`; PTY state internal to `TerminalPanel` |
| 21 | Profile (status strip) | `features/profile/ProfileSection.tsx` | `pages/HomePage.css` (`.workbench-status .profile-section*`) | `.workbench-status` | Inline row: `STARK calls you <name>` + Edit/Save/Cancel (24px buttons, 140px input when editing) | Flex | No | `profile-state` reducer |
| 22 | Status strip | `.workbench-status` in `HomePage.tsx` + `SystemStatus` + `StatusIndicator` | `HomePage.css`, `SystemStatus.css`, `StatusIndicator.css` | `.stage-shell` | 28px, mono 11px: lime workspace crumb · profile · spacer · dot + `System ready` + `vX · platform · Electron Y` | Fixed strip | No | `useAppInfo()` + workspace store |
| 23 | Settings surfaces (AI Settings, Heart, Recovery, Usage, Permissions) | `session__settings` block in `SessionPanel.tsx` | `session.css` | `section.session` (between notice and messages) | Full session width stacked form, rendered only when `settingsOpen` | Conditional | Yes — Settings menu toggle | `settingsOpen` local state + 5 config reducers |
| 24 | Approvals / runtime / usage / account areas | `session__recovery` cards + settings subsections in `SessionPanel.tsx` | `session.css` | `section.session` | Cards with lime left edge; runtime shows command/preview/started + Open/Reload/Stop; usage shows 24h rows + limits/alternates | Conditional on data | No | `pendingApproval`, `runtime`, `usage`, `capabilities` reducers |

Approx grid (default ≥1500px wide viewport): rail 48 + gap 8 + sidebar 264 + gap 8 + canvas (flexible, ≈1000 at 1920) + 8 padding; drawer row auto; chrome 40; status 28.

## 2. LAYOUT TREE (real hierarchy, conditionals marked *)

```
App (app/App.tsx)
└── AppProvider (app/AppProvider.tsx: boot/profile/workspace stores)
    └── BootRouter
        ├── [boot=loading] BootLoading
        ├── [boot=error] BootError (Retry)
        ├── [boot=onboarding] OnboardingPage
        └── [ready] MainLayout (viewport shell ONLY)
            └── HomePage
                ├── [active=null] .welcome > .home
                │     ├── WorkspaceSection (open-folder CTA + recent)
                │     ├── ProfileSection
                │     └── SystemStatus
                └── [active] .stage-shell
                      ├── AppChrome (brand, workspace identity, ☰/⌁ toggles)
                      ├── .stage-workarea (flex row)
                      │     └── Explorer (key={active.id})
                      │           └── .workbench (CSS grid, 3 cols × 2 rows)
                      │                 ├── ActivityRail > nav.activity-rail
                      │                 │     └── div.workbench__tabs > 4 × button.explorer__tab
                      │                 ├── [*sidebarOpen] aside.workbench__sidebar
                      │                 │     ├── WorkspaceSection
                      │                 │     └── .workbench__sidebar-body
                      │                 │           ├── [activity=explorer] TreeNode (recursive ul)
                      │                 │           ├── [activity=search] SearchPanel
                      │                 │           ├── [activity=git] GitPanel
                      │                 │           └── [activity=changes] ChangeSetPanel + ChangesPanel
                      │                 ├── section.primary-canvas
                      │                 │     ├── .canvas-tabs (Session | Editor)
                      │                 │     ├── .canvas-view [hidden unless session]
                      │                 │     │     └── sessionNode → SessionPanel (key={active.id})
                      │                 │     └── .canvas-view [hidden unless editor]
                      │                 │           └── section.workbench__editor
                      │                 │                 ├── .workbench__editor-main
                      │                 │                 │     ├── [gitDiff] diff viewer branch
                      │                 │                 │     ├── [changes.detail] TransactionReview
                      │                 │                 │     ├── [changeSets.setDetail] ChangeSetReview
                      │                 │                 │     ├── [no preview] .editor-empty (StarkMark hero)
                      │                 │                 │     ├── [editing] EditorToolbar + CodeEditor
                      │                 │                 │     └── [preview] EditorToolbar + CodeEditor(readonly)
                      │                 └── .bottom-drawer
                      │                       ├── [*terminalOpen] bar + TerminalPanel
                      │                       └── [*closed] button.bottom-drawer__handle
                      └── .workbench-status (workspace crumb, ProfileSection, SystemStatus)
```

`SessionPanel` internal order: `session__header` (eyebrow, title, New, `details.session__menu`, Looplink row) → looplink error → recovery card → approval card → runtime card → notice → settings (iff open) → empty/history-messages → looplink continuity → context drawer → composer.

## 3. STATE MAP (renderer layout state)

| Variable | Defined in | Initial | Changed by | Controls | Must survive redesign |
|----------|-----------|---------|------------|----------|----------------------|
| `activity: 'explorer' \| 'search' \| 'changes' \| 'git'` | `HomePage.tsx` (`useState`), passed into `Explorer` | `'explorer'` | Rail `onSelect`; review handoffs force `'changes'`; `handleOpenGitFile` forces `'explorer'`; reset on workspace change | Sidebar body content | Yes — concept (single contextual sidebar) |
| `canvasView: 'session' \| 'editor'` | `HomePage.tsx` | `'session'` (AI-first default) | Canvas tabs; every file/review/diff open handler calls `onCanvasViewChange('editor')`; proposal review handoffs call it; reset on workspace change | Which canvas view is visible (`hidden` attr; both stay mounted) | Yes |
| `sidebarOpen: boolean` | `HomePage.tsx` | `true` | Chrome ☰ toggle; reset on workspace change | Sidebar pane mounted or not | Yes |
| `terminalOpen: boolean` | `HomePage.tsx` | `false` | Chrome ⌁ toggle, drawer Hide, drawer handle; reset on workspace change | Drawer shows handle vs `TerminalPanel` | Yes |
| `contextOpen: boolean` | `SessionPanel.tsx` (`useState`) | `true` | Collapse/Expand button in context header | Attached-context body rendered or not | Yes (drawer must collapse) |
| `settingsOpen: boolean` | `SessionPanel.tsx` | `false` | Settings button in session menu | AI settings block rendered or not | Yes |
| `noteOpen / noteText: string` | `SessionPanel.tsx` | `false` / `''` | Add note / Cancel / attach success | Manual-note form visibility + draft | Yes |
| `selectedSessionId: number \| null` | `session-state` reducer (default: most recent session) | `null` → auto-selected | `handleSelect`, `handleNew`, recovery continuation | Entire conversation content, composer target, context attach target | Yes (core) |
| `state.preview` (+`revision`) | `explorer-state` reducer | `null` | File/search/git selection, close actions | Editor vs empty state; stale-write guards | Yes |
| `editor: EditorState \| null` | `Explorer.tsx` | `null` | Edit / Cancel / Review change | Read-only vs editing Monaco | Yes |
| `changes.detail`, `changeSets.setDetail`, `gitDiff.relativePath` | respective reducers | `null` | History/diff selection, close actions | Review/diff branches in editor view | Yes |
| `terminal status` (`closed\|starting\|running\|exited`) | `terminal-state` reducer | `closed` | Start/Kill/Close/exit events | Terminal bar buttons + viewport presence | Yes |
| `sessionWorkspace` (+ review ids, drafts) | `HomePage.tsx` | `activeId` | Workspace switch | Full shell reset (`key={active.id}` remounts `Explorer` + `SessionPanel`) | Yes |

Reducers influencing layout: `session-state` (sessions/messages/selection/loading), `explorer-state` (tree/preview), `changes-state` + `change-set-state` (review branches), `git-state` (diff branch), `terminal-state`, plus config reducers (`provider/heart/recovery/usage/capabilities/runtime/looplink`) that only add conditional sections. No layout state persists anywhere (no localStorage, no DB); workspace switch resets all of it.

## 4. CURRENT DIMENSIONS

| Element | Current value | CSS selector | File |
|---------|--------------|--------------|------|
| Top chrome height | `min-height: 40px` | `.app-chrome` | `layouts/AppChrome.css` |
| Chrome controls | 30×30px, 14px glyph | `.app-chrome__control` | `layouts/AppChrome.css` |
| Activity rail width | 48px, full height | `.activity-rail` | `features/explorer/Explorer.css` |
| Rail tab | 46px min-height, 15px icon + 9px label, column | `.explorer__tab` | `features/explorer/Explorer.css` |
| Rail selected | lime text + `lime-dim` wash + 2px lime bar (`top/bottom: 10px`) | `.explorer__tab--active(::before)` | `features/explorer/Explorer.css` |
| Sidebar width | 264px (248 ≤1500, 232 ≤1280, 216 ≤900) | `.workbench__sidebar` | `features/explorer/Explorer.css` |
| Sidebar card | 12px radius, 1px border | `.workbench__sidebar` | `features/explorer/Explorer.css` |
| Work area | grid `auto auto minmax(0,1fr)` / `minmax(0,1fr) auto`, gap + padding 8px | `.workbench` | `features/explorer/Explorer.css` |
| Canvas card | 14px radius, 1px border, flex column | `.primary-canvas` | `features/explorer/Explorer.css` |
| Canvas tabs | 30px, 12px bold, 6px dot (magenta=Session, lime=Editor when active) | `.canvas-tab*` | `features/explorer/Explorer.css` |
| Canvas view padding | `8px 12px 12px`, views stay mounted (`[hidden]{display:none}`) | `.canvas-view` | `features/explorer/Explorer.css` |
| Conversation measure | `max-width: 880px`, centered (list + run details) | `.session__list, .session__generation-error` | `features/sessions/session.css` |
| Composer dock | 12px radius, 8px margin/padding, textarea 64–200px | `.session__composer`, `.session__input` | `features/sessions/session.css` |
| Send | 34px min-height, lime bg, near-black text | `.session__send` | `features/sessions/session.css` |
| Terminal closed | 32px handle (full drawer width) | `.bottom-drawer__handle` | `features/explorer/Explorer.css` |
| Terminal open | 32px bar + 200px viewport + 16px bottom pad (xterm 13px JetBrains Mono) | `.bottom-drawer__bar`, `.terminal__viewport` | `Explorer.css`, `TerminalPanel.css` |
| Status strip | 28px, mono 11px | `.workbench-status` | `pages/HomePage.css` |
| File rows | 13px sans one-line ellipsis name + 22px Attach; dirs `▸/▾` + 1.2em chevron | `.explorer__name`, `.explorer__attach` | `features/explorer/Explorer.css` |
| Editor toolbar | 44px, mono 13px bold path (ellipsis) + mono 11px status + actions | `.editor-toolbar*` | `features/editor/editor.css` |
| Monaco frame | flex:1, min 0, 6px radius, 1px border | `.code-editor__frame` | `features/editor/editor.css` |
| Messages | 10px radius, user = elevated bg, assistant = surface + 2px magenta edge | `.session__message*` | `features/sessions/session.css` |
| Recovery/approval cards | 10px radius, 1px border + 2px lime left edge, 8px margins | `.session__recovery` | `features/sessions/session.css` |
| Context drawer | full session width, `max-height: 40%`, own scroll | `.session__context` | `features/sessions/session.css` |
| Breakpoints | 1500px (sidebar 248, composer margin), 1280px (sidebar 232), 900px (sidebar 216); `prefers-reduced-motion` kills transitions | various | `Explorer.css`, `session.css`, `global.css` |
| Gaps/padding | work area 8px; session internals 8px; rail tabs 2px | various | `Explorer.css`, `session.css` |

## 5. CURRENT DESIGN TOKENS

`src/renderer/src/styles/tokens.css` (verbatim):

```css
/**
 * STARK design tokens.
 *
 * Single source of truth for the visual foundation:
 * obsidian base with the two official STARK brand colors —
 * electric neon lime (primary) and neon magenta (AI/agent accent).
 * The repo green (#3ddc84) is a semantic success color only and must
 * never stand in as brand identity. Restrained weighting: ~85-90%
 * neutral, ~7-10% lime, ~2-5% magenta. Every component stylesheet
 * must reference these variables — no hard-coded palette values in
 * component CSS.
 */
:root {
  /* Surfaces */
  --stark-bg: #0a0c0a;
  --stark-surface: #101412;
  --stark-elevated: #171d19;

  /* Text */
  --stark-text: #e9f1ea;
  --stark-text-dim: #93a196;

  /* Lines */
  --stark-border: #232b25;

  /* Primary brand accent: electric neon lime */
  --stark-lime: #c8ff00;
  --stark-lime-dim: rgba(200, 255, 0, 0.12);
  --stark-lime-text: #0a0c0a;
  --stark-accent: #c8ff00;
  --stark-accent-dim: rgba(200, 255, 0, 0.12);
  --stark-accent-text: #0a0c0a;

  /* Secondary brand accent: neon magenta (AI/Brain/assistant identity) */
  --stark-magenta: #ff2ea6;
  --stark-magenta-dim: rgba(255, 46, 166, 0.12);
  --stark-magenta-text: #0a0c0a;

  /* Semantic */
  --stark-success: #3ddc84;
  --stark-warning: #fbbf24;
  --stark-danger: #f87171;

  /* Typography */
  --stark-font-sans: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
  --stark-font-mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;

  /* Spacing */
  --stark-space-xs: 4px;
  --stark-space-sm: 8px;
  --stark-space-md: 16px;
  --stark-space-lg: 24px;
  --stark-space-xl: 32px;
  --stark-space-2xl: 48px;

  /* Radius */
  --stark-radius-sm: 6px;
  --stark-radius-md: 10px;
  --stark-radius-lg: 16px;
  --stark-radius-pill: 999px;
}
```

OFFICIAL BRAND: lime `#c8ff00`, magenta `#ff2ea6`, obsidian `#0a0c0a` (+surface/elevated neutrals). SEMANTIC ONLY: success `#3ddc84`, warning `#fbbf24`, danger `#f87171`. Focus: 2px lime outline + 2px offset (`:focus-visible` in `global.css`).

## 6. FULL CODE: CORE LAYOUT (part 1 — shell files)

Repository path before every block. Verbatim current contents.

### `src/renderer/src/layouts/MainLayout.tsx`

```tsx
import type { ReactElement, ReactNode } from 'react'
import './MainLayout.css'

interface MainLayoutProps {
  readonly children: ReactNode
}

/**
 * Main application chrome: viewport-bounding shell only. All identity
 * and navigation live in the single global AppChrome bar so the shell
 * never stacks redundant toolbars.
 */
export function MainLayout({ children }: MainLayoutProps): ReactElement {
  return (
    <div className="shell">
      <main className="shell__main">{children}</main>
    </div>
  )
}
```

### `src/renderer/src/layouts/MainLayout.css`

```css
.shell {
  height: 100vh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--stark-bg);
}

.shell__main {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  overflow: hidden;
  padding: 0;
}
```

### `src/renderer/src/layouts/AppChrome.tsx`

```tsx
import type { ReactElement } from 'react'
import { StarkMark } from '../components/StarkMark'
import './AppChrome.css'

interface AppChromeProps {
  readonly workspaceName: string
  readonly workspacePath: string
  readonly sidebarOpen: boolean
  readonly onToggleSidebar: () => void
  readonly terminalOpen: boolean
  readonly onToggleTerminal: () => void
}

/**
 * Single compact global bar: STARK identity, current workspace
 * identity, and high-value view toggles. The workspace path stays
 * muted metadata (tooltip + title). Renderer-local view state only —
 * no backend, no persistence.
 */
export function AppChrome({
  workspaceName,
  workspacePath,
  sidebarOpen,
  onToggleSidebar,
  terminalOpen,
  onToggleTerminal
}: AppChromeProps): ReactElement {
  return (
    <header className="app-chrome">
      <span className="app-chrome__brand">
        <StarkMark size="bar" />
        <span className="app-chrome__wordmark">STARK</span>
      </span>
      <span className="app-chrome__divider" aria-hidden="true" />
      <span className="app-chrome__identity" title={workspacePath}>
        <span className="app-chrome__workspace">{workspaceName}</span>
      </span>
      <span className="app-chrome__spacer" aria-hidden="true" />
      <div className="app-chrome__controls" role="toolbar" aria-label="View controls">
        <button
          className="app-chrome__control"
          type="button"
          onClick={onToggleSidebar}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          ☰
        </button>
        <button
          className="app-chrome__control"
          type="button"
          onClick={onToggleTerminal}
          aria-pressed={terminalOpen}
          title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        >
          ⌁
        </button>
      </div>
    </header>
  )
}
```

### `src/renderer/src/layouts/AppChrome.css`

```css
.app-chrome {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--stark-space-sm);
  min-width: 0;
  min-height: 40px;
  padding: 0 var(--stark-space-md);
  background: var(--stark-surface);
  border-bottom: 1px solid var(--stark-border);
  overflow: hidden;
}

.app-chrome__brand {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: var(--stark-space-xs);
}

.app-chrome__wordmark {
  font-family: var(--stark-font-mono);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.3em;
  color: var(--stark-text);
}

.app-chrome__divider {
  flex: 0 0 auto;
  width: 1px;
  align-self: stretch;
  margin: 8px 0;
  background: var(--stark-border);
}

.app-chrome__identity {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: baseline;
  overflow: hidden;
  white-space: nowrap;
}

.app-chrome__workspace {
  font-family: var(--stark-font-sans);
  font-size: 13px;
  font-weight: 700;
  color: var(--stark-text);
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-chrome__spacer {
  flex: 0 0 var(--stark-space-sm);
}

.app-chrome__controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.app-chrome__control {
  min-width: 30px;
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 8px;
  font-size: 14px;
  line-height: 1;
  color: var(--stark-text-dim);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  touch-action: manipulation;
}

.app-chrome__control:hover {
  color: var(--stark-text);
  background: var(--stark-elevated);
}

.app-chrome__control[aria-pressed="true"] {
  color: var(--stark-lime);
  background: var(--stark-lime-dim);
}
```

### `src/renderer/src/features/explorer/ActivityRail.tsx`

```tsx
import type { ReactElement } from 'react'

export type ActivityKind = 'explorer' | 'search' | 'changes' | 'git'

interface ActivityRailProps {
  readonly activity: ActivityKind
  readonly onSelect: (activity: ActivityKind) => void
}

const ACTIVITIES: readonly { readonly kind: ActivityKind; readonly label: string; readonly icon: string }[] = [
  { kind: 'explorer', label: 'Explorer', icon: '▤' },
  { kind: 'search', label: 'Search', icon: '⌕' },
  { kind: 'changes', label: 'Changes', icon: '⇄' },
  { kind: 'git', label: 'Git', icon: '⎇' }
]

/**
 * Compact icon-first activity rail. The selected activity fills the
 * contextual sidebar; labels are always full (tooltip + caption),
 * the selected state is a lime indicator, never a neon block.
 */
export function ActivityRail({ activity, onSelect }: ActivityRailProps): ReactElement {
  return (
    <nav className="activity-rail" aria-label="Activity">
      <div className="workbench__tabs" role="tablist" aria-label="Explorer views" aria-orientation="vertical">
        {ACTIVITIES.map((entry) => (
          <button
            key={entry.kind}
            className={activity === entry.kind ? 'explorer__tab explorer__tab--active' : 'explorer__tab'}
            type="button"
            role="tab"
            aria-selected={activity === entry.kind}
            title={entry.label}
            aria-label={entry.label}
            onClick={() => onSelect(entry.kind)}
          >
            <span className="explorer__tab-icon" aria-hidden="true">
              {entry.icon}
            </span>
            <span className="explorer__tab-label">{entry.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
```

### `src/renderer/src/pages/HomePage.tsx` (146 lines, verbatim)

```tsx
import type { ReactElement } from 'react'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { APP_TAGLINE } from '../../../shared/constants'
import { useApp } from '../app/app-context'
import { AppChrome } from '../layouts/AppChrome'
import { Explorer } from '../features/explorer/Explorer'
import type { ActivityKind } from '../features/explorer/ActivityRail'
import { ProfileSection } from '../features/profile/ProfileSection'
import { SessionPanel } from '../features/sessions/SessionPanel'
import {
  initialSessionContextDraftState,
  sessionContextDraftReducer
} from '../features/sessions/session-context-state'
import { SystemStatus } from '../features/system-status/SystemStatus'
import { WorkspaceSection } from '../features/workspace/WorkspaceSection'
import './HomePage.css'

/**
 * STARK shell with two modes. Without a workspace it is a centered
 * empty-state card (open-folder CTA + recent list). Once a workspace
 * is active it becomes one calm application surface: a single compact
 * global bar, then a work area of activity rail + contextual sidebar +
 * primary canvas (AI conversation or editor tabs) with a docked
 * terminal drawer, then a thin status strip. The Session panel mounts
 * per workspace so no session state leaks across projects.
 * All pane visibility is renderer-local; nothing persists.
 */
export function HomePage(): ReactElement {
  const { profile, refreshProfile, workspace } = useApp()
  const displayName = profile?.displayName ?? ''
  const active = workspace.current
  const activeId = active?.id ?? null
  const [sessionWorkspace, setSessionWorkspace] = useState(activeId)
  // Stage 16 proposal review handoff: the Session panel reports the
  // newly created pending transaction id; the Explorer opens its
  // existing TransactionReview + DiffEditor. Cleared on workspace
  // switch; the Explorer consumes it once via effect.
  const [reviewTransactionId, setReviewTransactionId] = useState<number | null>(null)
  // Stage 17 Change Set handoff: same pattern for grouped proposals.
  const [reviewChangeSetId, setReviewChangeSetId] = useState<number | null>(null)
  // Explicit context drafts live here so both the Explorer attach
  // actions and the Session composer share one workspace-scoped list.
  // Drafts never leave this boundary except through the validated
  // prepare/send bridges.
  const [contextDrafts, contextDraftsDispatch] = useReducer(
    sessionContextDraftReducer,
    activeId,
    (id) => ({ ...initialSessionContextDraftState(), workspaceId: id })
  )
  // Renderer-local shell state: activity, canvas view, pane visibility.
  const [activity, setActivity] = useState<ActivityKind>('explorer')
  const [canvasView, setCanvasView] = useState<'session' | 'editor'>('session')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)

  // Stable callbacks for effects inside Explorer (identity must not
  // churn or one-shot review handoffs would refire).
  const handleActivityChange = useCallback((next: ActivityKind) => setActivity(next), [])
  const handleCanvasViewChange = useCallback((view: 'session' | 'editor') => setCanvasView(view), [])
  const handleToggleTerminal = useCallback(() => setTerminalOpen((open) => !open), [])
  const handleToggleSidebar = useCallback(() => setSidebarOpen((open) => !open), [])

  // A new workspace resets shell + review state; panels remount per
  // workspace (key={active.id}) so no session, message, composer, or
  // pagination state carries over.
  if (sessionWorkspace !== activeId) {
    setSessionWorkspace(activeId)
    setActivity('explorer')
    setCanvasView('session')
    setSidebarOpen(true)
    setTerminalOpen(false)
    setReviewTransactionId(null)
    setReviewChangeSetId(null)
  }

  useEffect(() => {
    if (activeId !== null) {
      contextDraftsDispatch({ type: 'workspace-changed', workspaceId: activeId })
    }
  }, [activeId])

  if (active === null) {
    return (
      <div className="welcome">
        <div className="home">
          <h1 className="home__title">Hi {displayName}, I’m STARK. What are we building today?</h1>
          <p className="home__tagline">{APP_TAGLINE}</p>
          <WorkspaceSection />
          <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
          <SystemStatus />
        </div>
      </div>
    )
  }

  return (
    <div className="stage-shell">
      <AppChrome
        workspaceName={active.displayName}
        workspacePath={active.rootPath}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        terminalOpen={terminalOpen}
        onToggleTerminal={handleToggleTerminal}
      />
      <div className="stage-workarea">
        <Explorer
          key={active.id}
          workspaceId={active.id}
          contextDraftsDispatch={contextDraftsDispatch}
          externalReviewTransactionId={reviewTransactionId}
          externalReviewChangeSetId={reviewChangeSetId}
          activity={activity}
          onActivityChange={handleActivityChange}
          canvasView={canvasView}
          onCanvasViewChange={handleCanvasViewChange}
          sidebarOpen={sidebarOpen}
          terminalOpen={terminalOpen}
          onToggleTerminal={handleToggleTerminal}
          sessionNode={
            <SessionPanel
              key={active.id}
              workspaceId={active.id}
              contextDrafts={contextDrafts.drafts}
              contextDraftsDispatch={contextDraftsDispatch}
              contextDraftError={contextDrafts.error}
              onReviewTransaction={(transactionId) => {
                setReviewTransactionId(transactionId)
                setCanvasView('editor')
              }}
              onReviewChangeSet={(changeSetId) => {
                setReviewChangeSetId(changeSetId)
                setCanvasView('editor')
              }}
            />
          }
        />
      </div>
      <div className="workbench-status" role="contentinfo" aria-label="Status bar">
        <span className="workbench-status__workspace" title={active.displayName}>
          {active.displayName}
        </span>
        <span className="workbench-status__divider" aria-hidden="true" />
        <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
        <span className="workbench-status__spacer" aria-hidden="true" />
        <SystemStatus />
      </div>
    </div>
  )
}
```

### `src/renderer/src/pages/HomePage.css` (verbatim)

```css
.welcome {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: auto;
  display: flex;
  justify-content: center;
  padding: var(--stark-space-lg);
}

.home {
  margin: auto;
  max-width: 640px;
  width: 100%;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--stark-space-md);
  padding: var(--stark-space-2xl) var(--stark-space-lg);
  background: var(--stark-surface);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-lg);
}

.home__title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--stark-text);
}

.home__tagline {
  margin: 0;
  font-size: 15px;
  line-height: 1.6;
  color: var(--stark-text-dim);
}

/* Active workspace: one calm application surface — global chrome,
   work area (rail + contextual sidebar + primary canvas), thin
   status strip. No page scroll, no stacked toolbars. */
.stage-shell {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--stark-bg);
}

.stage-workarea {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  overflow: hidden;
}

.workbench-status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--stark-space-sm);
  min-height: 28px;
  min-width: 0;
  padding: 2px var(--stark-space-md);
  border-top: 1px solid var(--stark-border);
  background: var(--stark-surface);
  overflow: hidden;
  font-family: var(--stark-font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--stark-text-dim);
}

.workbench-status__workspace {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--stark-font-sans);
  font-weight: 700;
  color: var(--stark-lime);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workbench-status__divider {
  flex: 0 0 auto;
  width: 1px;
  align-self: stretch;
  margin: 3px 0;
  background: var(--stark-border);
}

.workbench-status__spacer {
  flex: 1;
  min-width: var(--stark-space-sm);
}

/* Compact profile: single inline row inside the status bar — never a
   full-width workbench strip. Full editing stays on the welcome card. */
.workbench-status .profile-section {
  flex: 0 1 auto;
  min-width: 0;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--stark-space-xs);
  overflow: hidden;
  white-space: nowrap;
}

.workbench-status .profile-section__line {
  margin: 0;
  font-family: var(--stark-font-sans);
  overflow: hidden;
  text-overflow: ellipsis;
}

.workbench-status .profile-section .stark-btn {
  min-height: 24px;
  padding: 2px 8px;
  font-size: 11px;
}

.workbench-status .profile-section__label,
.workbench-status .profile-section input,
.workbench-status .profile-section [role="alert"] {
  font-size: 11px;
}

.workbench-status .profile-section input {
  width: 140px;
  min-height: 24px;
  padding: 2px 6px;
  color: var(--stark-text);
  background: var(--stark-bg);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
  font-family: var(--stark-font-sans);
}

.workbench-status .system-status {
  flex-direction: row;
  align-items: center;
  gap: var(--stark-space-sm);
  margin-top: 0;
}

.workbench-status .system-status__meta {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

### `src/renderer/src/features/explorer/Explorer.tsx` (994 lines, verbatim, part 1/5: imports, tree, props)

```tsx
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactElement, type ReactNode } from 'react'
import type { WorkspaceEntry } from '../../../../shared/workspace-files/types'
import { APP_NAME } from '../../../../shared/constants'
import {
  acceptChangeTransaction,
  createFileChange,
  getChangeTransaction,
  listRecentChangeTransactions,
  rejectChangeTransaction,
  rollbackChangeTransaction
} from '../../lib/changes-api'
import { normalizeChangeTransactionError } from '../../lib/change-transaction-error'
import { getGitDiff } from '../../lib/git-api'
import {
  prepareContextExcerpt,
  prepareContextFile,
  prepareContextSearchMatch
} from '../../lib/session-context-api'
import { normalizeContextError } from '../../lib/session-context-error'
import { getChangeSet, listRecentChangeSets } from '../../lib/change-sets-api'
import { getWorkspaceFilesApi } from '../../lib/stark-api'
import type { WorkspaceSearchMatch } from '../../../../shared/workspace-search/types'
import type { SessionContextDraft } from '../../../../shared/context/types'
import { ChangesPanel } from '../changes/ChangesPanel'
import { ActivityRail, type ActivityKind } from './ActivityRail'
import { StarkMark } from '../../components/StarkMark'
import { ChangeSetPanel } from '../changes/ChangeSetPanel'
import { ChangeSetReview } from '../changes/ChangeSetReview'
import { changeSetPanelReducer, initialChangeSetPanelState } from '../changes/change-set-state'
import { TransactionReview } from '../changes/TransactionReview'
import { changesReducer, initialChangesState } from '../changes/changes-state'
import { CodeEditor, type EditorSelection } from '../editor/CodeEditor'
import { EditorToolbar } from '../editor/EditorToolbar'
import { buildDocumentUri } from '../editor/editor-document'
import { classifyEol, isEditableEol, MIXED_EOL_MESSAGE } from '../editor/editor-eol'
import { toEditorFocus, type EditorFocus } from '../editor/editor-focus'
import { detectEditorLanguage } from '../editor/editor-language'
import { GitDiffViewer } from '../git/GitDiffViewer'
import { GitPanel } from '../git/GitPanel'
import { WorkspaceSection } from '../workspace/WorkspaceSection'
import { gitDiffReducer, initialGitDiffState } from '../git/git-state'
import { SearchPanel } from '../search/SearchPanel'
import type { SessionContextDraftAction } from '../sessions/session-context-state'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { confirmDiscardUnsavedDraft, setUnsavedDraft } from './editor-guard'
import {
  applyDraftChange,
  createEditorState,
  isEditorDirty,
  markEditorSaveFailed,
  markEditorSaving,
  type EditorState
} from './editor-state'
import { explorerReducer, initialExplorerState, type ExplorerState } from './explorer-state'
import './Explorer.css'

interface TreeNodeProps {
  readonly path: string
  readonly state: ExplorerState
  readonly onToggle: (path: string) => void
  readonly onSelectFile: (path: string) => void
  readonly onAttachFile: (path: string) => void
}

function entryGlyph(kind: WorkspaceEntry['kind'], expanded: boolean): string {
  if (kind === 'directory') {
    return expanded ? '▾' : '▸'
  }
  return ''
}

function TreeNode({ path, state, onToggle, onSelectFile, onAttachFile }: TreeNodeProps): ReactElement | null {
  const entries = state.entries[path]
  const loading = state.loading.includes(path)
  const error = state.errors[path] ?? null
  if (entries === undefined && !loading && error === null) {
    return null
  }
  return (
    <ul className="explorer__branch" aria-label={path === '' ? 'Workspace root' : path}>
      {(entries ?? []).map((entry) => (
        <li key={entry.relativePath} className="explorer__node">
          {entry.kind === 'directory' ? (
            <button
              className="explorer__row explorer__row--directory"
              type="button"
              aria-expanded={state.expanded.includes(entry.relativePath)}
              onClick={() => onToggle(entry.relativePath)}
            >
              <span className="explorer__chevron" aria-hidden="true">
                {entryGlyph(entry.kind, state.expanded.includes(entry.relativePath))}
              </span>
              <span className="explorer__name">{entry.name}</span>
            </button>
          ) : entry.kind === 'file' ? (
            <span className="explorer__file-row">
              <button
                className="explorer__row explorer__row--file"
                type="button"
                onClick={() => onSelectFile(entry.relativePath)}
              >
                <span className="explorer__chevron" aria-hidden="true" />
                <span className="explorer__name">{entry.name}</span>
              </button>
              <button
                className="explorer__attach"
                type="button"
                onClick={() => onAttachFile(entry.relativePath)}
                aria-label={`Attach ${entry.relativePath} to chat`}
                title="Attach file to chat"
              >
                Attach
              </button>
            </span>
          ) : (
            <span className="explorer__row explorer__row--static">
              <span className="explorer__chevron" aria-hidden="true" />
              <span className="explorer__name">{entry.name}</span>
              <span className="explorer__badge">link</span>
            </span>
          )}
          {entry.kind === 'directory' && state.expanded.includes(entry.relativePath) && (
            <div className="explorer__children">
              <TreeNode path={entry.relativePath} state={state} onToggle={onToggle} onSelectFile={onSelectFile} onAttachFile={onAttachFile} />
            </div>
          )}
        </li>
      ))}
      {loading && (
        <li className="explorer__node">
          <p className="explorer__status" role="status">
            Loading…
          </p>
        </li>
      )}
      {error !== null && (
        <li className="explorer__node">
          <p className="explorer__error" role="alert">
            {error}
          </p>
        </li>
      )}
    </ul>
  )
}

interface ExplorerProps {
  readonly workspaceId: number
  readonly contextDraftsDispatch: Dispatch<SessionContextDraftAction>
  /** Stage 16 review handoff: when set, open this transaction's existing review. */
  readonly externalReviewTransactionId?: number | null
  /** Stage 17 review handoff: when set, open this change set's grouped review. */
  readonly externalReviewChangeSetId?: number | null
  /** Controlled activity driving the contextual sidebar. */
  readonly activity: ActivityKind
  readonly onActivityChange: (activity: ActivityKind) => void
  /** Primary canvas view: AI conversation or editor. */
  readonly canvasView: 'session' | 'editor'
  readonly onCanvasViewChange: (view: 'session' | 'editor') => void
  /** Renderer-local pane visibility (no persistence). */
  readonly sidebarOpen: boolean
  readonly terminalOpen: boolean
  readonly onToggleTerminal: () => void
  /** Session workspace rendered as the primary canvas view. */
  readonly sessionNode: ReactNode
}
```

### `Explorer.tsx` part 2/5: state, loaders, review handoffs (lines 168–403)

```tsx
function toChangeSetsError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') {
    for (const known of ['We couldn’t load change sets.', 'That change set is no longer available.']) {
      if (error.message.includes(known)) {
        return known
      }
    }
  }
  return fallback
}

function toReadError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t read this file.'
}



/**
 * Lazy workspace explorer with bounded project search and
 * transaction-gated single-file editing: root loads on mount,
 * directories load only when expanded, files preview on selection.
 * Files render in a local Monaco editor (read-only preview, editable
 * on Edit); editing is explicit only (Edit → modify → Review change
 * → Accept/Reject): no autosave, no formatting, no direct disk
 * writes. Reviewing a draft persists a pending change transaction
 * (disk untouched); only Accept flows through the Stage 8 writer, and
 * only Rollback restores the checkpoint. Uniform LF/CRLF endings are
 * preserved; mixed-ending files open read-only. The Git tab is
 * read-only awareness (branch/status/diff, explicit Refresh only, no
 * polling); selecting a staged/working row opens its patch in the
 * main pane via a read-only Monaco viewer, and Open file reuses the
 * existing file read path. Explicit chat context attaches only on
 * visible actions (preview Attach selection/file, tree Attach, search
 * Attach) through the validated prepare bridges — never on open,
 * edit, or save. All filesystem access
 * goes through workspace bridges; stale responses from a previous
 * workspace are ignored, and switching workspaces resets tree,
 * preview, search, editor, change review, and Git diff.
 */
export function Explorer({
  workspaceId,
  contextDraftsDispatch,
  externalReviewTransactionId = null,
  externalReviewChangeSetId = null,
  activity,
  onActivityChange,
  canvasView,
  onCanvasViewChange,
  sidebarOpen,
  terminalOpen,
  onToggleTerminal,
  sessionNode
}: ExplorerProps): ReactElement {
  const [state, dispatch] = useReducer(explorerReducer, workspaceId, (id) => ({
    ...initialExplorerState(),
    workspaceId: id
  }))
  const [previewLine, setPreviewLine] = useState<number | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [focusRequest, setFocusRequest] = useState<EditorFocus | null>(null)
  // Latest Monaco cursor selection for the read-only preview. Cleared
  // on every file change; edit-mode buffers are excluded because line
  // numbers may no longer match disk (main re-reads at send time).
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null)
  const [changes, changesDispatch] = useReducer(changesReducer, workspaceId, (id) => ({
    ...initialChangesState(),
    workspaceId: id
  }))
  const [changeSets, changeSetsDispatch] = useReducer(changeSetPanelReducer, workspaceId, (id) => ({
    ...initialChangeSetPanelState(),
    workspaceId: id
  }))
  const [gitDiff, gitDiffDispatch] = useReducer(gitDiffReducer, workspaceId, (id) => ({
    ...initialGitDiffState(),
    workspaceId: id
  }))
  const gitDiffRequestRef = useRef(0)

  // Publish the derived dirty flag so file selection, search-result
  // selection, and workspace switching share one discard guard.
  useEffect(() => {
    setUnsavedDraft(editor !== null && isEditorDirty(editor))
    return () => {
      setUnsavedDraft(false)
    }
  }, [editor])

  const loadDirectory = useCallback(
    async (targetWorkspaceId: number, path: string): Promise<void> => {
      const api = getWorkspaceFilesApi()
      if (api === undefined) {
        dispatch({ type: 'directory-failed', path, message: 'We couldn’t read this folder.' })
        return
      }
      dispatch({ type: 'directory-loading', path })
      try {
        const listing = await api.listDirectory(targetWorkspaceId, path)
        dispatch({
          type: 'directory-loaded',
          workspaceId: listing.workspaceId,
          path: listing.relativePath,
          entries: listing.entries
        })
      } catch (error) {
        dispatch({
          type: 'directory-failed',
          path,
          message: error instanceof Error ? error.message : 'We couldn’t read this folder.'
        })
      }
    },
    []
  )

  useEffect(() => {
    dispatch({ type: 'workspace-changed', workspaceId })
    void loadDirectory(workspaceId, '')
  }, [workspaceId, loadDirectory])

  const refreshHistory = useCallback(async (): Promise<void> => {
    const targetWorkspaceId = workspaceId
    try {
      const transactions = await listRecentChangeTransactions({ workspaceId: targetWorkspaceId })
      changesDispatch({ type: 'history-loaded', workspaceId: targetWorkspaceId, transactions })
    } catch (error: unknown) {
      changesDispatch({ type: 'history-failed', message: normalizeChangeTransactionError(error).message })
    }
  }, [workspaceId])

  const refreshChangeSets = useCallback(async (): Promise<void> => {
    const targetWorkspaceId = workspaceId
    changeSetsDispatch({ type: 'sets-loading' })
    try {
      const sets = await listRecentChangeSets({ workspaceId: targetWorkspaceId })
      changeSetsDispatch({ type: 'sets-loaded', workspaceId: targetWorkspaceId, sets })
    } catch (error: unknown) {
      changeSetsDispatch({ type: 'sets-failed', message: toChangeSetsError(error, 'We couldn’t load change sets.') })
    }
  }, [workspaceId])

  useEffect(() => {
    changesDispatch({ type: 'workspace-changed', workspaceId })
    changesDispatch({ type: 'history-loading' })
    void refreshHistory()
    changeSetsDispatch({ type: 'workspace-changed', workspaceId })
    void refreshChangeSets()
  }, [workspaceId, refreshHistory, refreshChangeSets])

  useEffect(() => {
    gitDiffDispatch({ type: 'workspace-changed', workspaceId })
    gitDiffRequestRef.current = 0
  }, [workspaceId])

  // Stage 16 review handoff: open the newly proposed transaction in the
  // existing review + DiffEditor and refresh history. Consumed once per
  // id; null clears nothing. Tab switch here is a one-shot external
  // navigation request, not derived state.
  useEffect(() => {
    if (externalReviewTransactionId === null) {
      return
    }
    const transactionId = externalReviewTransactionId
    // One-shot external navigation: the Session panel requested review
    // of a newly created proposal transaction.
    onActivityChange('changes')
    onCanvasViewChange('editor')
    changesDispatch({ type: 'review-loading', transactionId })
    getChangeTransaction({ transactionId }).then(
      (transaction) =>
        changesDispatch({ type: 'review-loaded', workspaceId: transaction.workspaceId, transaction }),
      (error: unknown) =>
        changesDispatch({ type: 'review-failed', message: normalizeChangeTransactionError(error).message })
    )
    void refreshHistory()
  }, [workspaceId, externalReviewTransactionId, refreshHistory, onActivityChange, onCanvasViewChange])

  // Stage 17 review handoff: open the newly proposed change set in the
  // grouped review and refresh history. Consumed once per id.
  useEffect(() => {
    if (externalReviewChangeSetId === null) {
      return
    }
    const changeSetId = externalReviewChangeSetId
    // One-shot external navigation: the Session panel requested review
    // of a newly created grouped proposal.
    onActivityChange('changes')
    onCanvasViewChange('editor')
    changesDispatch({ type: 'review-closed' })
    changeSetsDispatch({ type: 'set-loading', changeSetId })
    getChangeSet({ changeSetId }).then(
      (changeSet) =>
        changeSetsDispatch({ type: 'set-loaded', workspaceId: changeSet.workspaceId, changeSet }),
      (error: unknown) =>
        changeSetsDispatch({ type: 'set-failed', message: toChangeSetsError(error, 'We couldn’t load change sets.') })
    )
    void refreshChangeSets()
    void refreshHistory()
  }, [workspaceId, externalReviewChangeSetId, refreshHistory, refreshChangeSets, onActivityChange, onCanvasViewChange])

  function handleToggle(path: string): void {
    const expanding = !state.expanded.includes(path)
    dispatch({ type: 'toggle', path })
    if (expanding) {
      void loadDirectory(workspaceId, path)
    }
  }

  function loadPreviewFile(path: string): void {
    dispatch({ type: 'file-selected', path })
    setEditor(null)
    setFocusRequest(null)
    setEditorSelection(null)
    changesDispatch({ type: 'review-closed' })
    gitDiffDispatch({ type: 'diff-closed' })
    const api = getWorkspaceFilesApi()
    if (api === undefined) {
      dispatch({ type: 'file-failed', path, message: 'We couldn’t read this file.' })
      return
    }
    api.readTextFile(workspaceId, path).then(
      (file) =>
        dispatch({
          type: 'file-loaded',
          workspaceId: file.workspaceId,
          path: file.relativePath,
          content: file.content,
          revision: file.revision
        }),
      (error: unknown) =>
        dispatch({
          type: 'file-failed',
          path,
          message: toReadError(error)
        })
    )
  }
```

### `Explorer.tsx` part 3/5: selection, attach, edit, accept handlers (lines 405–707)

```tsx
  function handleSelectFile(path: string): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    setPreviewLine(null)
    loadPreviewFile(path)
    onCanvasViewChange('editor')
  }

  function handleSelectGitDiff(relativePath: string, target: 'staged' | 'unstaged'): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    changesDispatch({ type: 'review-closed' })
    const requestId = gitDiffRequestRef.current + 1
    gitDiffRequestRef.current = requestId
    onCanvasViewChange('editor')
    gitDiffDispatch({ type: 'diff-loading', workspaceId, relativePath, target, requestId })
    getGitDiff({ workspaceId, relativePath, target }).then(
      (result) => {
        if (gitDiffRequestRef.current !== requestId) {
          return
        }
        gitDiffDispatch({ type: 'diff-succeeded', workspaceId: result.workspaceId, requestId, result })
      },
      (error: unknown) => {
        if (gitDiffRequestRef.current !== requestId) {
          return
        }
        gitDiffDispatch({
          type: 'diff-failed',
          workspaceId,
          requestId,
          message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t read this Git diff.'
        })
      }
    )
  }

  function handleCloseGitDiff(): void {
    gitDiffDispatch({ type: 'diff-closed' })
  }

  function handleOpenGitFile(relativePath: string): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    setPreviewLine(null)
    onActivityChange('explorer')
    onCanvasViewChange('editor')
    loadPreviewFile(relativePath)
  }

  function handleSelectSearchResult(path: string, line: number, column: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    setPreviewLine(line)
    loadPreviewFile(path)
    onCanvasViewChange('editor')
    setFocusRequest(toEditorFocus(line, column))
  }

  /**
   * Explicit context attach plumbing. Each action performs exactly one
   * bounded prepare call; failures surface as safe copy in the Session
   * panel's Attached context section (the single owner of draft
   * errors). Nothing attaches implicitly — no open/edit/save hooks.
   */
  function handleAttachDraft(promise: Promise<SessionContextDraft>): void {
    promise.then(
      (draft) => contextDraftsDispatch({ type: 'draft-added', workspaceId, draft }),
      (error: unknown) =>
        contextDraftsDispatch({
          type: 'draft-failed',
          workspaceId,
          message: normalizeContextError(error).message
        })
    )
  }

  function handleAttachPreviewSelection(): void {
    const preview = state.preview
    if (preview === null || editorSelection === null || editor !== null) {
      return
    }
    const lineStart = Math.min(editorSelection.startLineNumber, editorSelection.endLineNumber)
    const lineEnd = Math.max(editorSelection.startLineNumber, editorSelection.endLineNumber)
    handleAttachDraft(prepareContextExcerpt({ workspaceId, relativePath: preview.path, lineStart, lineEnd }))
    )
  }

  function handleAttachPreviewFile(): void {
    const preview = state.preview
    if (preview === null || editor !== null) {
      return
    }
    handleAttachDraft(prepareContextFile({ workspaceId, relativePath: preview.path }))
  }

  function handleAttachTreeFile(path: string): void {
    handleAttachDraft(prepareContextFile({ workspaceId, relativePath: path }))
  }

  function handleAttachSearchResult(match: WorkspaceSearchMatch): void {
    handleAttachDraft(
      prepareContextSearchMatch({ workspaceId, relativePath: match.relativePath, line: match.line })
    )
  }

  function handleEdit(): void {
    const preview = state.preview
    if (
      preview === null ||
      preview.content === null ||
      preview.revision === null ||
      editor !== null ||
      !isEditableEol(classifyEol(preview.content))
    ) {
      return
    }
    setEditor(createEditorState(preview.content, preview.revision))
  }

  function handleMonacoChange(value: string): void {
    setEditor((current) => (current === null ? current : applyDraftChange(current, value)))
  }

  function handleCancel(): void {
    const preview = state.preview
    if (editor === null || preview === null) {
      return
    }
    if (isEditorDirty(editor) && !confirmDiscardUnsavedDraft()) {
      return
    }
    // Discard the draft and reload the actual disk version so the UI
    // never pretends drafted text was kept.
    loadPreviewFile(preview.path)
  }

  async function handleReviewChange(): Promise<void> {
    const preview = state.preview
    if (editor === null || preview === null || editor.saving || !isEditorDirty(editor)) {
      return
    }
    const saving = markEditorSaving(editor)
    setEditor(saving)
    try {
      // Proposal only: the project file is never touched here. The
      // returned pending transaction becomes the review; the volatile
      // draft is replaced by persisted data, so workspace switching is
      // safe again without a discard prompt.
      const transaction = await createFileChange({
        workspaceId,
        relativePath: preview.path,
        expectedRevision: saving.revision,
        proposedContent: saving.draftContent
      })
      setEditor(null)
      changesDispatch({ type: 'review-opened', transaction })
      void refreshHistory()
    } catch (error: unknown) {
      // Never display raw invoke rejections: the normalizer reduces any
      // transported failure (including Electron's "Error invoking remote
      // method" prefix) to canonical display-safe copy. The draft stays
      // intact, including the "no changes" outcome.
      setEditor(markEditorSaveFailed(saving, normalizeChangeTransactionError(error).message))
    }
  }

  function handleSelectTransaction(transactionId: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    onCanvasViewChange('editor')
    changesDispatch({ type: 'review-loading', transactionId })
    getChangeTransaction({ transactionId }).then(
      (transaction) =>
        changesDispatch({ type: 'review-loaded', workspaceId: transaction.workspaceId, transaction }),
      (error: unknown) =>
        changesDispatch({ type: 'review-failed', message: normalizeChangeTransactionError(error).message })
    )
  }

  function handleSelectChangeSet(changeSetId: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    onCanvasViewChange('editor')
    changesDispatch({ type: 'review-closed' })
    changeSetsDispatch({ type: 'set-loading', changeSetId })
    getChangeSet({ changeSetId }).then(
      (changeSet) =>
        changeSetsDispatch({ type: 'set-loaded', workspaceId: changeSet.workspaceId, changeSet }),
      (error: unknown) =>
        changeSetsDispatch({ type: 'set-failed', message: toChangeSetsError(error, 'We couldn’t load change sets.') })
    )
  }

  function handleCloseChangeSet(): void {
    changeSetsDispatch({ type: 'set-closed' })
  }

  function handleCloseReview(): void {
    changesDispatch({ type: 'review-closed' })
  }

  async function handleAccept(): Promise<void> {
    const detail = changes.detail
    if (detail === null || changes.busy !== 'idle') {
      return
    }
    changesDispatch({ type: 'action-started', action: 'accepting' })
    try {
      const transaction = await acceptChangeTransaction({ transactionId: detail.id })
      const file = transaction.files[0]
      if (file !== undefined && file.appliedRevision !== null) {
        dispatch({
          type: 'file-loaded',
          workspaceId: transaction.workspaceId,
          path: file.relativePath,
          content: file.proposedContent,
          revision: file.appliedRevision
        })
      }
      changesDispatch({ type: 'action-succeeded', transaction, notice: 'Change applied' })
      void refreshHistory()
      void refreshChangeSets()
    } catch (error: unknown) {
      changesDispatch({ type: 'action-failed', message: normalizeChangeTransactionError(error).message })
    }
  }

  async function handleReject(): Promise<void> {
    const detail = changes.detail
    if (detail === null || changes.busy !== 'idle') {
      return
    }
    changesDispatch({ type: 'action-started', action: 'rejecting' })
    try {
      const transaction = await rejectChangeTransaction({ transactionId: detail.id })
      const file = transaction.files[0]
      if (file !== undefined) {
        const api = getWorkspaceFilesApi()
        if (api !== undefined) {
          try {
            const current = await api.readTextFile(workspaceId, file.relativePath)
            dispatch({
              type: 'file-loaded',
              workspaceId: current.workspaceId,
              path: current.relativePath,
              content: current.content,
              revision: current.revision
            })
          } catch {
            // Disk state is unchanged by reject; a failed re-read only
            // leaves the previous preview in place.
          }
        }
      }
      changesDispatch({ type: 'action-succeeded', transaction, notice: null })
      void refreshHistory()
      void refreshChangeSets()
    } catch (error: unknown) {
      changesDispatch({ type: 'action-failed', message: normalizeChangeTransactionError(error).message })
    }
  }

  async function handleRollback(): Promise<void> {
    const detail = changes.detail
    if (detail === null || changes.busy !== 'idle') {
      return
    }
    changesDispatch({ type: 'action-started', action: 'rolling-back' })
    try {
      const transaction = await rollbackChangeTransaction({ transactionId: detail.id })
      const file = transaction.files[0]
      if (file !== undefined) {
        dispatch({
          type: 'file-loaded',
          workspaceId: transaction.workspaceId,
          path: file.relativePath,
          content: file.beforeContent,
          revision: file.beforeRevision
        })
      }
      changesDispatch({ type: 'action-succeeded', transaction, notice: 'Change rolled back' })
      void refreshHistory()
      void refreshChangeSets()
    } catch (error: unknown) {
      changesDispatch({ type: 'action-failed', message: normalizeChangeTransactionError(error).message })
    }
  }
```

### `Explorer.tsx` part 4/5: render root, rail, sidebar, canvas tabs (lines 699–780)

```tsx
  const dirty = editor !== null && isEditorDirty(editor)
  const previewContent = state.preview?.content ?? null
  const previewEol = useMemo(
    () => (previewContent === null ? null : classifyEol(previewContent)),
    [previewContent]
  )
  const previewEditable = previewEol !== null && isEditableEol(previewEol)
  const previewPathLabel = state.preview === null ? '' : state.preview.path === '' ? '/' : state.preview.path
  const readOnlyStatus = !previewEditable ? 'Mixed line endings — read-only' : previewLine !== null ? `Line ${previewLine} · Read-only` : 'Read-only'

  return (
    <div className="workbench">
      <ActivityRail activity={activity} onSelect={onActivityChange} />
      {sidebarOpen && (
      <aside className="workbench__sidebar" aria-label="Sidebar">
        <WorkspaceSection />
        <div className="workbench__sidebar-body">
          {activity === 'explorer' ? (
            <TreeNode path="" state={state} onToggle={handleToggle} onSelectFile={handleSelectFile} onAttachFile={handleAttachTreeFile} />
          ) : activity === 'search' ? (
            <SearchPanel
              key={workspaceId}
              workspaceId={workspaceId}
              onSelectResult={handleSelectSearchResult}
              onAttachResult={handleAttachSearchResult}
            />
          ) : activity === 'git' ? (
            <GitPanel
              key={workspaceId}
              workspaceId={workspaceId}
              onSelectDiff={handleSelectGitDiff}
              onOpenFile={handleOpenGitFile}
            />
          ) : (
            <>
              <ChangeSetPanel
                sets={changeSets.sets}
                loading={changeSets.setsLoading}
                error={changeSets.setsError}
                selectedId={changeSets.selectedSetId}
                onSelect={handleSelectChangeSet}
              />
              <ChangesPanel
                history={changes.history}
                loading={changes.historyLoading}
                error={changes.historyError}
                selectedId={changes.selectedId}
                onSelect={handleSelectTransaction}
              />
            </>
          )}
        </div>
      </aside>
      )}
      <section className="primary-canvas" aria-label="Workspace canvas">
        <div className="canvas-tabs" role="tablist" aria-label="Primary views">
          <button
            className={canvasView === 'session' ? 'canvas-tab canvas-tab--session canvas-tab--active' : 'canvas-tab canvas-tab--session'}
            type="button"
            role="tab"
            aria-selected={canvasView === 'session'}
            onClick={() => onCanvasViewChange('session')}
          >
            <span className="canvas-tab__dot" aria-hidden="true" />
            Session
          </button>
          <button
            className={canvasView === 'editor' ? 'canvas-tab canvas-tab--editor canvas-tab--active' : 'canvas-tab canvas-tab--editor'}
            type="button"
            role="tab"
            aria-selected={canvasView === 'editor'}
            onClick={() => onCanvasViewChange('editor')}
          >
            <span className="canvas-tab__dot" aria-hidden="true" />
            Editor
          </button>
        </div>
        <div className="canvas-view" hidden={canvasView !== 'session'}>
          {sessionNode}
        </div>
        <div className="canvas-view" hidden={canvasView !== 'editor'}>
        <section className="workbench__editor" aria-label="Editor">
        <div className="workbench__editor-main">
```

### `Explorer.tsx` part 5/5: editor branches, empty state, drawer (lines 781–994)

The editor column is one exclusive branch chain inside
`.workbench__editor-main` (first match wins): git diff → transaction
review → loading/error → change-set review → loading/error → empty
(`.editor-empty`: StarkMark hero + `Select a file to open`) → loading →
preview error → editing Monaco (`Review change`/`Cancel`) → read-only
Monaco (`Edit`/`Attach selection`/`Attach file`, mixed-EOL notice).
Verbatim tail:

```tsx
        {gitDiff.relativePath !== null ? (
          <div className="workbench__editor-body">
            <EditorToolbar
              path={`Git diff · ${gitDiff.relativePath} · ${gitDiff.target === 'staged' ? 'Staged' : 'Working tree'}`}
              status="Read-only"
              actions={
                <>
                  <button className="explorer__secondary" type="button" onClick={() => handleOpenGitFile(gitDiff.relativePath as string)}>
                    Open file
                  </button>
                  <button className="explorer__secondary" type="button" onClick={handleCloseGitDiff}>
                    Close
                  </button>
                </>
              }
            />
            {gitDiff.phase === 'loading' ? (
              <p className="explorer__status explorer__status--centered" role="status">
                Loading Git diff…
              </p>
            ) : gitDiff.phase === 'error' ? (
              <p className="explorer__error explorer__status--centered" role="alert">
                {gitDiff.error ?? 'We couldn’t read this Git diff.'}
              </p>
            ) : gitDiff.result !== null ? (
              gitDiff.result.patch === '' ? (
                <p className="explorer__status explorer__status--centered">No patch content.</p>
              ) : (
                <div className="editor-canvas">
                  <GitDiffViewer
                    key={`gitdiff:${workspaceId}:${gitDiff.result.relativePath}:${gitDiff.result.target}`}
                    relativePath={gitDiff.result.relativePath}
                    target={gitDiff.result.target}
                    patch={gitDiff.result.patch}
                  />
                </div>
              )
            ) : (
              <p className="explorer__status explorer__status--centered">Loading Git diff…</p>
            )}
          </div>
        ) : changes.detail !== null ? (
          <TransactionReview
            transaction={changes.detail}
            busy={changes.busy}
            actionError={changes.actionError}
            notice={changes.notice}
            onAccept={() => void handleAccept()}
            onReject={() => void handleReject()}
            onRollback={() => void handleRollback()}
            onClose={handleCloseReview}
          />
        ) : changes.detailLoading ? (
          <p className="explorer__status explorer__status--centered" role="status">
            Loading change…
          </p>
        ) : changes.detailError !== null ? (
          <p className="explorer__error explorer__status--centered" role="alert">
            {changes.detailError}
          </p>
        ) : changeSets.setDetail !== null ? (
          <ChangeSetReview
            changeSet={changeSets.setDetail}
            onReviewFile={handleSelectTransaction}
            onClose={handleCloseChangeSet}
          />
        ) : changeSets.setDetailLoading ? (
          <p className="explorer__status explorer__status--centered" role="status">
            Loading change set…
          </p>
        ) : changeSets.setDetailError !== null ? (
          <p className="explorer__error explorer__status--centered" role="alert">
            {changeSets.setDetailError}
          </p>
        ) : state.preview === null ? (
          <div className="editor-empty" role="status" aria-label="No file selected">
            <StarkMark size="hero" />
            <p className="editor-empty__brand">{APP_NAME}</p>
            <p className="editor-empty__title">Select a file to open</p>
            <p className="editor-empty__hint">Open a file from the Explorer · attach context · ask STARK on the right</p>
          </div>
        ) : state.preview.loading ? (
          <p className="explorer__status explorer__status--centered" role="status">
            Loading…
          </p>
        ) : state.preview.error !== null ? (
          <p className="explorer__error explorer__status--centered" role="alert">
            {state.preview.error}
          </p>
        ) : editor !== null && state.preview.content !== null && state.preview.revision !== null ? (
          <div className="workbench__editor-body">
            <EditorToolbar
              path={previewPathLabel}
              status={dirty ? 'Unsaved changes' : 'No unsaved changes'}
              actions={
                <>
                  <button
                    className="explorer__primary"
                    type="button"
                    disabled={!dirty || editor.saving}
                    onClick={() => void handleReviewChange()}
                  >
                    {editor.saving ? 'Reviewing…' : 'Review change'}
                  </button>
                  <button className="explorer__secondary" type="button" onClick={handleCancel}>
                    Cancel
                  </button>
                </>
              }
            />
            {editor.saveError !== null && (
              <p className="explorer__error explorer__inline-alert" role="alert">
                {editor.saveError}
              </p>
            )}
            <div className="editor-canvas">
              <CodeEditor
                key={`edit:${workspaceId}:${state.preview.path}:${state.preview.revision}`}
                documentUri={buildDocumentUri(workspaceId, state.preview.path)}
                language={detectEditorLanguage(state.preview.path)}
                initialValue={editor.draftContent}
                eol={previewEol === 'crlf' ? 'CRLF' : 'LF'}
                readOnly={false}
                focusRequest={null}
                onContentChange={handleMonacoChange}
                ariaLabel="File editor"
              />
            </div>
          </div>
        ) : (
          <div className="workbench__editor-body">
            <EditorToolbar
              path={previewPathLabel}
              status={readOnlyStatus}
              actions={
                state.preview.revision !== null && previewEditable && editor === null ? (
                  <>
                    <button className="explorer__primary" type="button" onClick={handleEdit}>
                      Edit
                    </button>
                    <button
                      className="explorer__secondary"
                      type="button"
                      onClick={handleAttachPreviewSelection}
                      disabled={editorSelection === null}
                      title={editorSelection === null ? 'Select text in the preview first' : 'Attach the selected lines to chat'}
                    >
                      Attach selection
                    </button>
                    <button className="explorer__secondary" type="button" onClick={handleAttachPreviewFile}>
                      Attach file
                    </button>
                  </>
                ) : null
              }
            />
            {previewEol !== null && !previewEditable && (
              <p className="explorer__error explorer__inline-alert" role="alert">
                {MIXED_EOL_MESSAGE}
              </p>
            )}
            {state.preview.content !== null && state.preview.revision !== null && (
              <div className="editor-canvas">
                <CodeEditor
                  key={`view:${workspaceId}:${state.preview.path}:${state.preview.revision}`}
                  documentUri={buildDocumentUri(workspaceId, state.preview.path)}
                  language={detectEditorLanguage(state.preview.path)}
                  initialValue={state.preview.content}
                  eol={previewEol === 'crlf' ? 'CRLF' : 'LF'}
                  readOnly
                  focusRequest={focusRequest}
                  onSelectionChange={setEditorSelection}
                  ariaLabel="File preview"
                />
              </div>
            )}
          </div>
        )}
        </div>
        </section>
        </div>
      </section>
      <div className="bottom-drawer">
        {terminalOpen ? (
          <>
            <div className="bottom-drawer__bar">
              <span className="bottom-drawer__label">Terminal</span>
              <button
                className="stark-btn stark-btn--ghost"
                type="button"
                onClick={onToggleTerminal}
                aria-label="Hide terminal"
              >
                Hide
              </button>
            </div>
            <TerminalPanel key={`terminal:${workspaceId}`} workspaceId={workspaceId} />
          </>
        ) : (
          <button
            className="bottom-drawer__handle"
            type="button"
            onClick={onToggleTerminal}
            aria-expanded={false}
            aria-label="Show terminal"
          >
            <span aria-hidden="true">⌁</span> Terminal
          </button>
        )}
      </div>
    </div>
  )
}
```

### `src/renderer/src/features/sessions/SessionPanel.tsx` (3115 lines, verbatim, part 1/16: lines 1–200)

```tsx
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import type { CodingMessage } from '../../../../shared/sessions/types'
import type { SessionContextDraft } from '../../../../shared/context/types'
import type { ProviderConnectionStatus } from '../../../../shared/providers/types'
import {
  createCodingSession,
  listCodingSessions,
  listSessionMessages,
  sendSessionUserMessage
} from '../../lib/sessions-api'
import {
  SESSION_LIST_MESSAGE,
  SESSION_MESSAGES_MESSAGE,
  SESSION_SAVE_MESSAGE,
  normalizeSessionError
} from '../../lib/session-error'
import {
  CONTEXT_ITEM_TOO_LARGE_MESSAGE,
  CONTEXT_PREPARE_MESSAGE,
  CONTEXT_RANGE_MESSAGE,
  CONTEXT_STALE_MESSAGE,
  CONTEXT_TOTAL_TOO_LARGE_MESSAGE,
  CONTEXT_UNAVAILABLE_MESSAGE,
  CONTEXT_UNSUPPORTED_MESSAGE,
  normalizeContextError
} from '../../lib/session-context-error'
import { prepareContextNote } from '../../lib/session-context-api'
import {
  clearProviderCredential,
  generateAssistantResponseRaw,
  getProviderState,
  listProviderModels,
  proposeAiChangeSet,
  proposeAiFileChange,
  runBrainWorkRaw,
  saveProviderCredential,
  setProviderModel,
  testProviderConnection
} from '../../lib/providers-api'
import { listRecentOrchestrationRuns } from '../../lib/orchestration-api'
import {
  PROVIDER_GENERIC_MESSAGE,
  normalizeProviderError
} from '../../lib/provider-error'
import { isComposerEmpty, shouldSubmitComposerKey } from './composer-keys'
import { ContextCard } from './ContextCard'
import { initialProviderPanelState, providerPanelReducer } from './provider-state'
import { initialSessionPanelState, sessionPanelReducer } from './session-state'
import type { SessionContextDraftAction } from './session-context-state'
import {
  initialProposalState,
  proposalEligibility,
  proposalReducer,
  type ProposalMode
} from './proposal-state'
import { initialWorkPanelState, workPanelReducer } from './work-state'
import {
  BRAIN_GENERIC_MESSAGE,
  normalizeBrainError
} from '../../lib/brain-error'
import { getHeartConfig, saveHeartConfig } from '../../lib/heart-api'
import { initialHeartPanelState, heartPanelReducer } from './heart-state'
import { dismissRecovery, getRecoveryConfig, getRecoveryForTarget, saveRecoveryConfig } from '../../lib/recovery-api'
import { initialRecoveryPanelState, recoveryPanelReducer, recoverySourceCopy, recoveryTargetCopy } from './recovery-state'
import {
  approveWorkerApproval,
  denyWorkerApproval,
  getPendingWorkerApproval
} from '../../lib/worker-tools-api'
import {
  getActiveRuntime,
  listRecentRuntimes,
  openRuntimePreview,
  reloadRuntimePreview,
  stopRuntime,
  subscribeRuntimeUpdates
} from '../../lib/runtimes-api'
import type { ProjectRuntimeSummary } from '../../../../shared/project-runtime/types'
import { PREVIEW_TRUNCATION_NOTICE, initialRuntimePanelState, runtimePanelReducer, runtimeStatusLabel } from './runtime-state'
import type { WorkerToolApproval } from '../../../../shared/worker-tools/types'
import { getUsageConfig, getUsageSummary, saveUsageConfig } from '../../lib/usage-api'
import { USAGE_ROUTE_KEYS, formatUsageThreshold, initialUsagePanelState, usagePanelReducer, usageRouteLabel } from './usage-state'
import { getWorkspaceCapabilityConfig, saveWorkspaceCapabilityConfig } from '../../lib/capabilities-api'
import {
  CAPABILITY_ORDER,
  capabilityLabel,
  initialCapabilityPanelState,
  capabilityPanelReducer,
  legalModesFor
} from './capabilities-state'
import { createSessionContinuation, dismissSessionLooplink, getSessionLooplink } from '../../lib/looplink-api'
import { initialLooplinkPanelState, looplinkPanelReducer } from './looplink-state'
import {
  PROPOSAL_GENERIC_MESSAGE,
  normalizeProposalError
} from '../../lib/proposal-error'
import { normalizeChangeSetProposalError } from '../../lib/change-set-error'
import './session.css'

interface SessionPanelProps {
  readonly workspaceId: number
  readonly contextDrafts: readonly SessionContextDraft[]
  readonly contextDraftsDispatch: Dispatch<SessionContextDraftAction>
  readonly contextDraftError: string | null
  readonly onReviewTransaction: (transactionId: number) => void
  readonly onReviewChangeSet: (changeSetId: number) => void
}

const OPENAI_PROVIDER_ID = 'openai' as const

/** Renderer-side composer byte cap (main enforces authoritatively). */
const COMPOSER_MAX_BYTES = 64 * 1024

function composerByteLength(content: string): number {
  return new TextEncoder().encode(content).length
}

function toErrorMessage(error: unknown, fallback: string): string {
  return normalizeSessionError(error, fallback).message
}

function toProviderErrorMessage(error: unknown, fallback: string): string {
  return normalizeProviderError(error, fallback).message
}

function toSendErrorMessage(error: unknown): string {
  // Context attachment failures carry their own safe copy; anything
  // else falls back to the session send boundary. Stale-context keeps
  // its explicit reattach copy so the composer and chips are retained
  // and the user can remove/reattach — never auto-refreshed.
  if (error instanceof Error && error.message !== '') {
    const known = [
      CONTEXT_ITEM_TOO_LARGE_MESSAGE,
      CONTEXT_TOTAL_TOO_LARGE_MESSAGE,
      CONTEXT_TOO_MANY_MESSAGE,
      CONTEXT_UNSUPPORTED_MESSAGE,
      CONTEXT_UNAVAILABLE_MESSAGE,
      CONTEXT_RANGE_MESSAGE,
      CONTEXT_STALE_MESSAGE,
      CONTEXT_PREPARE_MESSAGE
    ]
    if (known.some((message) => error.message.includes(message))) {
      return normalizeContextError(error, SESSION_SAVE_MESSAGE).message
    }
  }
  return toErrorMessage(error, SESSION_SAVE_MESSAGE)
}

function roleLabel(role: CodingMessage['role']): string {
  return role === 'assistant' ? 'STARK' : 'YOU'
}

function formatTime(createdAt: number): string {
  try {
    return new Date(createdAt).toLocaleString()
  } catch {
    return ''
  }
}

function connectionStatusLabel(status: ProviderConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected.'
    case 'invalid-credential':
      return 'The saved API key was rejected. Check the key and try again.'
    case 'rate-limited':
      return 'The AI provider is rate-limiting requests. Try again shortly.'
    case 'network-error':
      return 'The AI provider could not be reached. Check your connection.'
    case 'timeout':
      return 'The AI provider request timed out. Try again.'
  }
}
```

### SessionPanel part 2/16: lines 201–400 (component open, reducers, Heart/Recovery/Capabilities/Usage loaders)

```tsx
export function SessionPanel({
  workspaceId,
  contextDrafts,
  contextDraftsDispatch,
  contextDraftError,
  onReviewTransaction,
  onReviewChangeSet
}: SessionPanelProps): ReactElement {
  const [state, dispatch] = useReducer(sessionPanelReducer, workspaceId, (id) => ({
    ...initialSessionPanelState(),
    workspaceId: id
  }))
  const [provider, providerDispatch] = useReducer(providerPanelReducer, workspaceId, (id) => ({
    ...initialProviderPanelState(),
    workspaceId: id
  }))
  const [proposal, proposalDispatch] = useReducer(proposalReducer, workspaceId, (id) => ({
    ...initialProposalState(),
    workspaceId: id
  }))
  const [work, workDispatch] = useReducer(workPanelReducer, workspaceId, (id) => ({
    ...initialWorkPanelState(),
    workspaceId: id
  }))
  const [heart, heartDispatch] = useReducer(heartPanelReducer, workspaceId, (id) => ({
    ...initialHeartPanelState(),
    workspaceId: id
  }))
  const [looplink, looplinkDispatch] = useReducer(looplinkPanelReducer, workspaceId, (id) => ({
    ...initialLooplinkPanelState(),
    workspaceId: id
  }))
  const [recovery, recoveryDispatch] = useReducer(recoveryPanelReducer, workspaceId, (id) => ({
    ...initialRecoveryPanelState(),
    workspaceId: id
  }))
  const [capabilities, capabilitiesDispatch] = useReducer(capabilityPanelReducer, workspaceId, (id) => ({
    ...initialCapabilityPanelState(),
    workspaceId: id
  }))
  const [usage, usageDispatch] = useReducer(usagePanelReducer, workspaceId, (id) => ({
    ...initialUsagePanelState(),
    workspaceId: id
  }))
  const [runtime, runtimeDispatch] = useReducer(runtimePanelReducer, workspaceId, (id) => ({
    ...initialRuntimePanelState(),
    workspaceId: id
  }))
  const [pendingApproval, setPendingApproval] = useState<WorkerToolApproval | null>(null)
  const [approvalActing, setApprovalActing] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [contextOpen, setContextOpen] = useState(true)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [revealKey, setRevealKey] = useState(false)
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const sessionsRequestRef = useRef(0)
  const messagesRequestRef = useRef(0)
  const generationRequestRef = useRef(0)
  const providerStateRequestRef = useRef(0)
  const providerModelsRequestRef = useRef(0)
  const providerConnectionRequestRef = useRef(0)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const aiReady = provider.configured && provider.selectedModel !== null

  function scrollToBottom(): void {
    const element = messagesScrollRef.current
    if (element !== null) {
      element.scrollTop = element.scrollHeight
    }
  }

  useEffect(() => {
    if (stickToBottomRef.current) {
      stickToBottomRef.current = false
      scrollToBottom()
    }
  }, [state.messages])

  function refreshProviderState(): void {
    const requestId = providerStateRequestRef.current + 1
    providerStateRequestRef.current = requestId
    providerDispatch({ type: 'state-loading', workspaceId, requestId })
    getProviderState(OPENAI_PROVIDER_ID).then(
      (providerState) => {
        if (providerStateRequestRef.current !== requestId) {
          return
        }
        providerDispatch({ type: 'state-loaded', workspaceId, requestId, state: providerState })
      },
      (error: unknown) => {
        if (providerStateRequestRef.current !== requestId) {
          return
        }
        providerDispatch({
          type: 'state-failed',
          workspaceId,
          requestId,
          message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
        })
      }
    )
  }

  async function refreshHeartConfig(targetWorkspaceId: number): Promise<void> {
    heartDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getHeartConfig()
      heartDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      heartDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the Heart configuration.'
      })
    }
  }

  async function handleSaveHeart(): Promise<void> {
    if (heart.saving) {
      return
    }
    const draft = heart.draft
    heartDispatch({ type: 'save-started', workspaceId })
    try {
      const config = await saveHeartConfig({
        workerMode: draft.workerMode,
        brain: { ...draft.brain },
        workerFixed: draft.workerMode === 'fixed' || draft.workerFixed.model !== '' ? { ...draft.workerFixed } : null,
        workerDefault: draft.workerMode === 'auto_swap' || draft.workerDefault.model !== '' ? { ...draft.workerDefault } : null,
        workerRoutes: {
          general: draft.workerRoutes.general.model !== '' ? { ...draft.workerRoutes.general } : null,
          coding: draft.workerRoutes.coding.model !== '' ? { ...draft.workerRoutes.coding } : null,
          reasoning: draft.workerRoutes.reasoning.model !== '' ? { ...draft.workerRoutes.reasoning } : null,
          fast: draft.workerRoutes.fast.model !== '' ? { ...draft.workerRoutes.fast } : null
        }
      })
      heartDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      heartDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the Heart configuration.'
      })
    }
  }
  async function refreshRecoveryConfig(targetWorkspaceId: number): Promise<void> {
    recoveryDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getRecoveryConfig()
      recoveryDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      recoveryDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the recovery configuration.'
      })
    }
  }

  async function handleSaveRecovery(): Promise<void> {
    if (recovery.saving) {
      return
    }
    const draft = recovery.draft
    recoveryDispatch({ type: 'save-started', workspaceId })
    try {
      const config = await saveRecoveryConfig({
        mode: draft.mode,
        ask: draft.ask.model !== '' ? { ...draft.ask } : null,
        brain: draft.brain.model !== '' ? { ...draft.brain } : null,
        worker: draft.worker.model !== '' ? { ...draft.worker } : null
      })
      recoveryDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      recoveryDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the recovery configuration.'
      })
    }
  }
  async function refreshCapabilityConfig(targetWorkspaceId: number): Promise<void> {
    capabilitiesDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getWorkspaceCapabilityConfig({ workspaceId: targetWorkspaceId })
      capabilitiesDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      capabilitiesDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the workspace permissions.'
      })
    }
  }
```

### SessionPanel part 3/16: lines 401–600 (usage config, activation effect, selection effect)

```tsx
  async function handleSaveCapabilities(): Promise<void> {
    if (capabilities.saving) {
      return
    }
    capabilitiesDispatch({ type: 'save-started', workspaceId })
    try {
      const config = await saveWorkspaceCapabilityConfig({
        workspaceId,
        enabled: capabilities.draft.enabled,
        policies: CAPABILITY_ORDER.map((capability) => ({ capability, mode: capabilities.draft.modes[capability] }))
      })
      capabilitiesDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      capabilitiesDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the workspace permissions.'
      })
    }
  }

  function parseOptionalCount(text: string, what: string): number | null {
    const trimmed = text.trim()
    if (trimmed === '') {
      return null
    }
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new Error(`The usage routing ${what} must be a whole number or empty.`)
    }
    const value = Number(trimmed)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`The usage routing ${what} is invalid.`)
    }
    return value
  }

  async function refreshUsageConfig(targetWorkspaceId: number): Promise<void> {
    usageDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getUsageConfig()
      usageDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      usageDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the usage configuration.'
      })
    }
  }

  async function refreshUsageSummary(targetWorkspaceId: number): Promise<void> {
    usageDispatch({ type: 'summary-loading', workspaceId: targetWorkspaceId })
    try {
      const summary = await getUsageSummary()
      usageDispatch({ type: 'summary-loaded', workspaceId: targetWorkspaceId, summary })
    } catch (error: unknown) {
      usageDispatch({
        type: 'summary-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the local usage summary.'
      })
    }
  }

  async function handleSaveUsage(): Promise<void> {
    if (usage.saving) {
      return
    }
    const draft = usage.draft
    usageDispatch({ type: 'save-started', workspaceId })
    try {
      const limits = draft.limits.map((entry) => {
        if (entry.model.trim() === '') {
          throw new Error('Each usage routing limit needs a model.')
        }
        const maxCalls24h = parseOptionalCount(entry.maxCalls, 'call limit')
        const maxTotalTokens24h = parseOptionalCount(entry.maxTokens, 'token limit')
        const switchText = entry.switchAt.trim()
        if (!/^[0-9]+$/.test(switchText)) {
          throw new Error('The usage routing switch percentage must be a whole number from 1 to 100.')
        }
        return {
          providerId: entry.providerId,
          model: entry.model.trim(),
          maxCalls24h,
          maxTotalTokens24h,
          switchAtPercent: Number(switchText)
        }
      })
      const config = await saveUsageConfig({
        heartThresholdRoutingEnabled: draft.thresholdRoutingEnabled,
        limits,
        alternates: USAGE_ROUTE_KEYS.filter((routeKey) => draft.alternates[routeKey].model.trim() !== '').map(
          (routeKey) => ({
            routeKey,
            providerId: draft.alternates[routeKey].providerId,
            model: draft.alternates[routeKey].model.trim()
          })
        )
      })
      usageDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      usageDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the usage routing configuration.'
      })
    }
  }
  // Workspace activation: reset identity, load recent sessions and the
  // provider state once. (Composer, key input, and drafts start empty
  // because the panel remounts per workspace.)
  useEffect(() => {
    dispatch({ type: 'workspace-changed', workspaceId })
    providerDispatch({ type: 'workspace-changed', workspaceId })
    proposalDispatch({ type: 'workspace-changed', workspaceId })
    workDispatch({ type: 'workspace-changed', workspaceId })
    looplinkDispatch({ type: 'workspace-changed', workspaceId })
    heartDispatch({ type: 'workspace-changed', workspaceId })
    recoveryDispatch({ type: 'workspace-changed', workspaceId })
    capabilitiesDispatch({ type: 'workspace-changed', workspaceId })
    usageDispatch({ type: 'workspace-changed', workspaceId })
    void refreshHeartConfig(workspaceId)
    void refreshRecoveryConfig(workspaceId)
    void refreshCapabilityConfig(workspaceId)
    void refreshUsageConfig(workspaceId)
    void refreshUsageSummary(workspaceId)
    sessionsRequestRef.current = 0
    messagesRequestRef.current = 0
    generationRequestRef.current = 0
    providerStateRequestRef.current = 0
    providerModelsRequestRef.current = 0
    providerConnectionRequestRef.current = 0
    const requestId = sessionsRequestRef.current + 1
    sessionsRequestRef.current = requestId
    dispatch({ type: 'sessions-loading', workspaceId, requestId })
    listCodingSessions(workspaceId).then(
      (sessions) => {
        if (sessionsRequestRef.current !== requestId) {
          return
        }
        dispatch({ type: 'sessions-loaded', workspaceId, requestId, sessions })
      },
      (error: unknown) => {
        if (sessionsRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'sessions-failed',
          workspaceId,
          requestId,
          message: toErrorMessage(error, SESSION_LIST_MESSAGE)
        })
      }
    )
    refreshProviderState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // Selection (including the reducer's default to the most recent
  // session): load that session's latest page, exactly once per
  // selection identity.
  const selectedSessionId = state.selectedSessionId
  useEffect(() => {
    if (selectedSessionId === null) {
      return
    }
    const sessionId = selectedSessionId
    const requestId = messagesRequestRef.current + 1
    messagesRequestRef.current = requestId
    dispatch({ type: 'messages-loading', workspaceId, sessionId, requestId })
    listSessionMessages({ workspaceId, sessionId }).then(
      (page) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        stickToBottomRef.current = true
        dispatch({
          type: 'messages-loaded',
          workspaceId,
          sessionId,
          requestId,
          mode: 'latest',
          messages: page.messages,
          hasMore: page.hasMore
        })
      },
      (error: unknown) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'messages-failed',
          workspaceId,
          sessionId,
          requestId,
          message: toErrorMessage(error, SESSION_MESSAGES_MESSAGE)
        })
      }
    )
  }, [workspaceId, selectedSessionId])
```

### SessionPanel part 4/16: lines 601–830 (send paths: Ask, Propose, generation)

```tsx
  // Keep the transient proposal result bound to the selected session.
  // Switching sessions clears it; the panel remount covers workspaces.
  useEffect(() => {
    if (selectedSessionId === null) {
      return
    }
    proposalDispatch({ type: 'session-changed', workspaceId, sessionId: selectedSessionId })
    workDispatch({ type: 'session-changed', workspaceId, sessionId: selectedSessionId })
    looplinkDispatch({ type: 'session-changed', workspaceId, sessionId: selectedSessionId })
    void loadSessionLooplink(selectedSessionId)
    void loadRecoveryForSelected(selectedSessionId)
    void loadPendingApproval(selectedSessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, selectedSessionId])

  // Managed project runtimes are workspace-scoped and live outside any
  // single session: load explicitly on mount and reflect main-pushed
  // updates with no polling and no timers.
  useEffect(() => {
    void loadActiveRuntime()
    void loadRecentRuntimes()
    const unsubscribe = subscribeRuntimeUpdates((event) => {
      if (event.workspaceId !== workspaceId) {
        return
      }
      runtimeDispatch({ type: 'updated', workspaceId, active: event.runtime })
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  async function runGeneration(sessionId: number): Promise<void> {
    if (state.generating) {
      return
    }
    const requestId = generationRequestRef.current + 1
    generationRequestRef.current = requestId
    dispatch({ type: 'generate-started', workspaceId, sessionId, requestId })
    try {
      const outcome = await generateAssistantResponseRaw({ workspaceId, sessionId })
      if (generationRequestRef.current !== requestId) {
        return
      }
      // Legacy shape (older main without recovery) — treat as completed.
      if (!('kind' in outcome)) {
        const legacy = outcome as { session: never; message: never }
        stickToBottomRef.current = true
        dispatch({
          type: 'generate-succeeded',
          workspaceId,
          sessionId,
          requestId,
          session: legacy.session as never,
          message: legacy.message as never
        })
        void loadSessionLooplink(sessionId)
        return
      }
      if (outcome.kind === 'completed') {
        stickToBottomRef.current = true
        dispatch({
          type: 'generate-succeeded',
          workspaceId,
          sessionId,
          requestId,
          session: outcome.result.session,
          message: outcome.result.message
        })
        void loadSessionLooplink(sessionId)
        void loadRecoveryForSelected(outcome.result.session.id)
        return
      }
      // Single-hop recovery: the source keeps its user message with a
      // safe recovery notice; the target holds the continued work.
      dispatch({ type: 'session-created', session: outcome.targetSession })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: outcome.recoveryEvent })
      if (outcome.kind === 'recovery_handoff') {
        dispatch({
          type: 'generate-failed',
          workspaceId,
          sessionId,
          requestId,
          message: outcome.recoveryEvent.status === 'failed'
            ? 'Recovery attempt failed. No further automatic attempts will be made.'
            : 'STARK created a recovery session.'
        })
      } else {
        dispatch({
          type: 'generate-failed',
          workspaceId,
          sessionId,
          requestId,
          message: 'STARK continued this request in a recovery session.'
        })
      }
      // Offer the target for manual continuation.
      dispatch({ type: 'session-selected', workspaceId, sessionId: outcome.targetSession.id })
      void loadSessionLooplink(outcome.targetSession.id)
      void loadRecoveryForSelected(outcome.targetSession.id)
    } catch (error: unknown) {
      if (generationRequestRef.current !== requestId) {
        return
      }
      dispatch({
        type: 'generate-failed',
        workspaceId,
        sessionId,
        requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleNew(): Promise<void> {
    if (state.loadingSessions) {
      return
    }
    try {
      const session = await createCodingSession(workspaceId)
      dispatch({ type: 'session-created', session })
      setComposer('')
      composerRef.current?.focus()
    } catch (error: unknown) {
      dispatch({
        type: 'sessions-failed',
        workspaceId,
        requestId: state.sessionsRequestId,
        message: toErrorMessage(error, SESSION_LIST_MESSAGE)
      })
    }
  }

  function handleSelect(sessionId: number): void {
    if (sessionId === state.selectedSessionId) {
      return
    }
    dispatch({ type: 'session-selected', workspaceId, sessionId })
  }

  function handleLoadOlder(): void {
    const oldest = state.messages[0]
    if (state.selectedSessionId === null || oldest === undefined || state.loadingMessages) {
      return
    }
    const sessionId = state.selectedSessionId
    const requestId = messagesRequestRef.current + 1
    messagesRequestRef.current = requestId
    dispatch({ type: 'messages-loading', workspaceId, sessionId, requestId })
    listSessionMessages({ workspaceId, sessionId, beforeMessageId: oldest.id }).then(
      (page) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'messages-loaded',
          workspaceId,
          sessionId,
          requestId,
          mode: 'older',
          messages: page.messages,
          hasMore: page.hasMore
        })
      },
      (error: unknown) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'messages-failed',
          workspaceId,
          sessionId,
          requestId,
          message: toErrorMessage(error, SESSION_MESSAGES_MESSAGE)
        })
      }
    )
  }
```

### SessionPanel part 5/16: lines 831–1010 (Ask send, Propose send)

```tsx
  async function handleSend(): Promise<void> {
    if (state.selectedSessionId === null || state.sending) {
      return
    }
    const sessionId = state.selectedSessionId
    const content = composer
    if (isComposerEmpty(content) || composerByteLength(content) > COMPOSER_MAX_BYTES) {
      return
    }
    if (proposal.mode === 'propose') {
      await handleProposeSend(sessionId, content)
      return
    }
    if (proposal.mode === 'work') {
      await handleWorkSend(sessionId, content)
      return
    }
    const generateAfterSend = aiReady
    const attached = [...contextDrafts]
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      const result = await sendSessionUserMessage(
        attached.length === 0
          ? { workspaceId, sessionId, content }
          : { workspaceId, sessionId, content, context: attached }
      )
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      // Clear only the sent text: keystrokes typed during the send are
      // newer composer state and must be preserved. The reducer drops
      // the result entirely if the selection moved on meanwhile.
      setComposer((current) => (current === content ? '' : current))
      // Drafts are renderer-local: sending consumes exactly the
      // attached snapshot, so they clear on success only.
      contextDraftsDispatch({ type: 'drafts-cleared', workspaceId })
      if (generateAfterSend) {
        await runGeneration(sessionId)
      }
    } catch (error: unknown) {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: toSendErrorMessage(error)
      })
    }
  }

  /**
   * Propose-mode send: persists the user message + reviewed context
   * through the normal Stage 15 path, then runs exactly one bounded
   * structured proposal for the persisted trailing message — the
   * single-file Stage 16 path for one whole file, the Stage 17 Change
   * Set path for two to five. The user message stays on proposal
   * failure; nothing retries automatically.
   */
  async function handleProposeSend(sessionId: number, content: string): Promise<void> {
    if (proposal.preparing) {
      return
    }
    const eligibility = proposalEligibility(contextDrafts)
    if (!eligibility.eligible || eligibility.kind === 'none') {
      proposalDispatch({
        type: 'proposal-failed',
        workspaceId,
        sessionId,
        message: eligibility.reason ?? PROPOSAL_GENERIC_MESSAGE
      })
      return
    }
    const kind = eligibility.kind
    const attached = [...contextDrafts]
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      const result = await sendSessionUserMessage(
        attached.length === 0
          ? { workspaceId, sessionId, content }
          : { workspaceId, sessionId, content, context: attached }
      )
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      setComposer((current) => (current === content ? '' : current))
      contextDraftsDispatch({ type: 'drafts-cleared', workspaceId })
    } catch (error: unknown) {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: toSendErrorMessage(error)
      })
      return
    }
    proposalDispatch({ type: 'proposal-started', workspaceId, sessionId, kind })
    if (kind === 'multi') {
      try {
        const outcome = await proposeAiChangeSet({ workspaceId, sessionId })
        proposalDispatch({
          type: 'change-set-succeeded',
          workspaceId,
          sessionId,
          changeSet: outcome.changeSet
        })
      } catch (error: unknown) {
        proposalDispatch({
          type: 'proposal-failed',
          workspaceId,
          sessionId,
          message: normalizeChangeSetProposalError(error).message
        })
      }
      return
    }
    try {
      const outcome = await proposeAiFileChange({ workspaceId, sessionId })
      proposalDispatch({
        type: 'proposal-succeeded',
        workspaceId,
        sessionId,
        result: { transaction: outcome.transaction, summary: outcome.summary }
      })
    } catch (error: unknown) {
      proposalDispatch({
        type: 'proposal-failed',
        workspaceId,
        sessionId,
        message: normalizeProposalError(error, PROPOSAL_GENERIC_MESSAGE).message
      })
    }
  }

  /** Explicit retry: re-runs the proposal for the existing trailing user message. No resend. */
  async function handleRetryProposal(): Promise<void> {
    if (state.selectedSessionId === null || proposal.preparing || state.sending) {
      return
    }
    const sessionId = state.selectedSessionId
    proposalDispatch({ type: 'proposal-retried', workspaceId, sessionId })
    if ((proposal.activeKind ?? 'single') === 'multi') {
      try {
        const outcome = await proposeAiChangeSet({ workspaceId, sessionId })
        proposalDispatch({
          type: 'change-set-succeeded',
          workspaceId,
          sessionId,
          changeSet: outcome.changeSet
        })
      } catch (error: unknown) {
        proposalDispatch({
          type: 'proposal-failed',
          workspaceId,
          sessionId,
          message: normalizeChangeSetProposalError(error).message
        })
      }
      return
    }
    try {
      const outcome = await proposeAiFileChange({ workspaceId, sessionId })
      proposalDispatch({
        type: 'proposal-succeeded',
        workspaceId,
        sessionId,
        result: { transaction: outcome.transaction, summary: outcome.summary }
      })
    } catch (error: unknown) {
      proposalDispatch({
        type: 'proposal-failed',
        workspaceId,
        sessionId,
        message: normalizeProposalError(error, PROPOSAL_GENERIC_MESSAGE).message
      })
    }
  }
```

### SessionPanel part 6/16: lines ~1011–1210 (Work send, retry, Looplink/approval/runtime loaders)

```tsx
  function handleProposalMode(mode: ProposalMode): void {
    if (mode === proposal.mode) {
      return
    }
    proposalDispatch({ type: 'mode-changed', workspaceId, mode })
    if (mode === 'work' && state.selectedSessionId !== null) {
      void loadLatestWorkRun(state.selectedSessionId)
    }
  }

  /** Loads pending continuity for run-details display. Explicit and bounded. */
  async function loadSessionLooplink(sessionId: number): Promise<void> {
    looplinkDispatch({ type: 'continuity-loading', workspaceId, sessionId })
    try {
      const found = await getSessionLooplink({ workspaceId, sessionId })
      looplinkDispatch({ type: 'continuity-loaded', workspaceId, sessionId, looplink: found })
    } catch (error: unknown) {
      looplinkDispatch({
        type: 'continuity-failed',
        workspaceId,
        sessionId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load this continuity.'
      })
    }
  }
  /** Loads the pending Worker approval for a session. Explicit and bounded. */
  async function loadPendingApproval(sessionId: number): Promise<void> {
    try {
      const found = await getPendingWorkerApproval({ workspaceId, sessionId })
      setPendingApproval(found)
      setApprovalError(null)
    } catch (error: unknown) {
      setApprovalError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the pending approval.')
    }
  }

  /** Loads the active managed runtime for the workspace. Explicit and bounded. */
  async function loadActiveRuntime(): Promise<void> {
    try {
      const found = await getActiveRuntime({ workspaceId })
      runtimeDispatch({ type: 'active-loaded', workspaceId, active: found })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the project runtime.'
      })
    }
  }

  /** Loads recent runtime history for the workspace. Explicit and bounded. */
  async function loadRecentRuntimes(): Promise<void> {
    try {
      const found = await listRecentRuntimes({ workspaceId })
      runtimeDispatch({ type: 'history-loaded', workspaceId, history: found })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the project runtime.'
      })
    }
  }

  /** Explicit human Stop: terminates exactly the tracked runtime tree. No AI approval involved. */
  async function handleStopRuntime(runtimeId: number): Promise<void> {
    if (runtime.acting) {
      return
    }
    runtimeDispatch({ type: 'action-started', workspaceId })
    try {
      const stopped = await stopRuntime({ workspaceId, runtimeId })
      runtimeDispatch({ type: 'action-succeeded', workspaceId, active: stopped.status === 'stopped' ? null : stopped })
      void loadRecentRuntimes()
      void loadActiveRuntime()
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t stop the project runtime.'
      })
    }
  }

  /** Opens the isolated Live Preview for a running runtime. Main derives the URL. */
  async function handleOpenPreview(runtimeId: number): Promise<void> {
    if (runtime.acting) {
      return
    }
    runtimeDispatch({ type: 'action-started', workspaceId })
    try {
      const current = await openRuntimePreview({ workspaceId, runtimeId })
      runtimeDispatch({ type: 'action-succeeded', workspaceId, active: current })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t open the live preview.'
      })
    }
  }

  /** Reloads the open preview window. No URL is ever submitted. */
  async function handleReloadPreview(runtimeId: number): Promise<void> {
    if (runtime.acting) {
      return
    }
    runtimeDispatch({ type: 'action-started', workspaceId })
    try {
      const current = await reloadRuntimePreview({ workspaceId, runtimeId })
      runtimeDispatch({ type: 'action-succeeded', workspaceId, active: current })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t reload the live preview.'
      })
    }
  }

  async function handleApprovalDecision(approved: boolean): Promise<void> {
    if (state.selectedSessionId === null || pendingApproval === null || approvalActing) {
      return
    }
    const sessionId = state.selectedSessionId
    const approvalId = pendingApproval.id
    const wasRuntimeStart = pendingApproval.toolName === 'runtime_start'
    setApprovalActing(true)
    setApprovalError(null)
    try {
      const outcome = approved
        ? await approveWorkerApproval({ workspaceId, sessionId, approvalId })
        : await denyWorkerApproval({ workspaceId, sessionId, approvalId })
      await handleToolResumeOutcome(outcome, sessionId)
      if (wasRuntimeStart) {
        void loadActiveRuntime()
        void loadRecentRuntimes()
      }
    } catch (error: unknown) {
      setApprovalError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t resolve this approval.')
    } finally {
      setApprovalActing(false)
    }
  }

  async function handleToolResumeOutcome(outcome: import('../../../../shared/ai/types').WorkRecoveryResult, sessionId: number): Promise<void> {
    if (!('kind' in outcome)) {
      return
    }
    if (outcome.kind === 'completed') {
      setPendingApproval(null)
      stickToBottomRef.current = true
      workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.result.run })
      dispatch({ type: 'work-completed', workspaceId, session: outcome.result.session, message: outcome.result.message })
      void loadSessionLooplink(sessionId)
      void loadLatestWorkRun(sessionId)
      return
    }
    if (outcome.kind === 'waiting_for_approval') {
      setPendingApproval(outcome.approval)
      void loadLatestWorkRun(sessionId)
      return
    }
    // Recovery handoffs from a pre-tool failure surface as safe copy.
    setPendingApproval(null)
    workDispatch({
      type: 'run-failed',
      workspaceId,
      sessionId,
      message: outcome.kind === 'recovery_handoff' && outcome.recoveryEvent.status === 'failed'
        ? 'Recovery attempt failed. No further automatic attempts will be made.'
        : 'STARK created a recovery session.'
    })
  }
```

### SessionPanel part 7/16: Work send, Retry Work, recovery/looplink/note/composer-key/provider-key handlers

```tsx
  /**
   * Work-mode send: persists the user message + explicit context
   * through the normal Stage 15 path, then runs one bounded Brain
   * orchestration for the persisted trailing message. The user
   * message stays on failure; nothing retries automatically.
   */
  async function handleWorkSend(sessionId: number, content: string): Promise<void> {
    if (work.preparing) {
      return
    }
    const attached = [...contextDrafts]
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      const result = await sendSessionUserMessage(
        attached.length === 0
          ? { workspaceId, sessionId, content }
          : { workspaceId, sessionId, content, context: attached }
      )
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      setComposer((current) => (current === content ? '' : current))
      contextDraftsDispatch({ type: 'drafts-cleared', workspaceId })
    } catch (error: unknown) {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: toSendErrorMessage(error)
      })
      return
    }
    workDispatch({ type: 'run-started', workspaceId, sessionId })
    try {
      const outcome = await runBrainWorkRaw({ workspaceId, sessionId })
      if (!('kind' in outcome)) {
        const legacy = outcome as { run: never; session: never; message: never }
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: legacy.run as never })
        dispatch({ type: 'work-completed', workspaceId, session: legacy.session as never, message: legacy.message as never })
        void loadSessionLooplink(sessionId)
        return
      }
      if (outcome.kind === 'completed') {
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.result.run })
        dispatch({ type: 'work-completed', workspaceId, session: outcome.result.session, message: outcome.result.message })
        void loadSessionLooplink(sessionId)
        void loadRecoveryForSelected(outcome.result.session.id)
        setPendingApproval(null)
        return
      }
      if (outcome.kind === 'waiting_for_approval') {
        setPendingApproval(outcome.approval)
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.run })
        void loadSessionLooplink(sessionId)
        void loadLatestWorkRun(sessionId)
        return
      }
      if (outcome.kind === 'recovery_handoff' || outcome.kind === 'recovered') {
        dispatch({ type: 'session-created', session: outcome.targetSession })
        recoveryDispatch({ type: 'event-loaded', workspaceId, event: outcome.recoveryEvent })
        workDispatch({
          type: 'run-failed',
          workspaceId,
          sessionId,
          message: outcome.kind === 'recovery_handoff' && outcome.recoveryEvent.status === 'failed'
            ? 'Recovery attempt failed. No further automatic attempts will be made.'
            : 'STARK created a recovery session.'
        })
        dispatch({ type: 'session-selected', workspaceId, sessionId: outcome.targetSession.id })
        void loadSessionLooplink(outcome.targetSession.id)
        void loadRecoveryForSelected(outcome.targetSession.id)
        return
      }
    } catch (error: unknown) {
      workDispatch({
        type: 'run-failed',
        workspaceId,
        sessionId,
        message: normalizeBrainError(error, BRAIN_GENERIC_MESSAGE).message
      })
    }
  }

  /** Explicit Retry Work: reruns against the existing trailing user message. No resend. */
  async function handleRetryWork(): Promise<void> {
    if (state.selectedSessionId === null || work.preparing || state.sending) {
      return
    }
    const sessionId = state.selectedSessionId
    workDispatch({ type: 'run-retried', workspaceId, sessionId })
    try {
      const outcome = await runBrainWorkRaw({ workspaceId, sessionId })
      if (!('kind' in outcome)) {
        const legacy = outcome as { run: never; session: never; message: never }
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: legacy.run as never })
        dispatch({ type: 'work-completed', workspaceId, session: legacy.session as never, message: legacy.message as never })
        void loadSessionLooplink(sessionId)
        return
      }
      if (outcome.kind === 'completed') {
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.result.run })
        dispatch({ type: 'work-completed', workspaceId, session: outcome.result.session, message: outcome.result.message })
        void loadSessionLooplink(sessionId)
        void loadRecoveryForSelected(outcome.result.session.id)
        setPendingApproval(null)
        return
      }
      if (outcome.kind === 'waiting_for_approval') {
        setPendingApproval(outcome.approval)
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.run })
        void loadSessionLooplink(sessionId)
        void loadLatestWorkRun(sessionId)
        return
      }
      dispatch({ type: 'session-created', session: outcome.targetSession })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: outcome.recoveryEvent })
      workDispatch({
        type: 'run-failed',
        workspaceId,
        sessionId,
        message: outcome.recoveryEvent.status === 'failed'
          ? 'Recovery attempt failed. No further automatic attempts will be made.'
          : 'STARK created a recovery session.'
      })
      dispatch({ type: 'session-selected', workspaceId, sessionId: outcome.targetSession.id })
      void loadSessionLooplink(outcome.targetSession.id)
      void loadRecoveryForSelected(outcome.targetSession.id)
    } catch (error: unknown) {
      workDispatch({
        type: 'run-failed',
        workspaceId,
        sessionId,
        message: normalizeBrainError(error, BRAIN_GENERIC_MESSAGE).message
      })
    }
  }

  /** Loads the recovery event for a target session. Explicit and bounded. */
  async function loadRecoveryForSelected(sessionId: number): Promise<void> {
    try {
      const found = await getRecoveryForTarget({ workspaceId, sessionId })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: found })
    } catch (error: unknown) {
      recoveryDispatch({
        type: 'event-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the recovery state.'
      })
    }
  }

  async function handleDismissRecovery(): Promise<void> {
    if (state.selectedSessionId === null) {
      return
    }
    const sessionId = state.selectedSessionId
    try {
      const dismissed = await dismissRecovery({ workspaceId, sessionId })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: dismissed })
      void loadSessionLooplink(sessionId)
    } catch {
      recoveryDispatch({ type: 'event-failed', workspaceId, message: 'We couldn’t dismiss this recovery.' })
    }
  }
```

### SessionPanel part 8/16: Looplink actions, work-run loader, drafts, retry, key handlers

```tsx
  /**
   * Explicit continuation: snapshots the selected source session into
   * a new target session with a pending handoff. Sends nothing and
   * starts no AI work — the target is selected for the user to read
   * and message explicitly.
   */
  async function handleContinueWithLooplink(): Promise<void> {
    if (state.selectedSessionId === null || looplink.acting || state.sending) {
      return
    }
    const sourceSessionId = state.selectedSessionId
    looplinkDispatch({ type: 'action-started', workspaceId, sessionId: sourceSessionId })
    try {
      const result = await createSessionContinuation({ workspaceId, sourceSessionId })
      dispatch({ type: 'session-created', session: result.targetSession })
      looplinkDispatch({ type: 'action-succeeded', workspaceId, sessionId: sourceSessionId, looplink: null })
    } catch (error: unknown) {
      looplinkDispatch({
        type: 'action-failed',
        workspaceId,
        sessionId: sourceSessionId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t prepare this continuity.'
      })
    }
  }

  /** Dismisses the selected session's pending continuity. No provider call. */
  async function handleDismissLooplink(): Promise<void> {
    if (state.selectedSessionId === null || looplink.acting) {
      return
    }
    const sessionId = state.selectedSessionId
    looplinkDispatch({ type: 'action-started', workspaceId, sessionId })
    try {
      const dismissed = await dismissSessionLooplink({ workspaceId, sessionId })
      looplinkDispatch({ type: 'action-succeeded', workspaceId, sessionId, looplink: dismissed })
    } catch (error: unknown) {
      looplinkDispatch({
        type: 'action-failed',
        workspaceId,
        sessionId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t dismiss this continuity.'
      })
    }
  }
  /** Loads the latest persisted run for run-details display. Explicit and bounded. */
  async function loadLatestWorkRun(sessionId: number): Promise<void> {
    try {
      const runs = await listRecentOrchestrationRuns({ workspaceId, sessionId })
      workDispatch({ type: 'runs-loaded', workspaceId, sessionId, run: runs[0] ?? null })
    } catch {
      // Run history is a convenience surface: a failed load only
      // leaves the previous details in place.
    }
  }
```

(The file then defines `handleRemoveDraft`, `handleAddNote`,
`handleRetry`, `handleComposerKeyDown`, `handleSaveKey`,
`handleRemoveKey`, `handleTestConnection`, `handleRefreshModels`,
`handleUseModel` — small single-bridge handlers whose exact bodies are
quoted in part 9 — followed by the derived render values.)

```tsx
  function handleRemoveDraft(draftId: string): void {
    contextDraftsDispatch({ type: 'draft-removed', workspaceId, draftId })
  }

  async function handleAddNote(): Promise<void> {
    if (isComposerEmpty(noteText)) {
      return
    }
    const content = noteText
    try {
      const draft = await prepareContextNote({ workspaceId, content })
      contextDraftsDispatch({ type: 'draft-added', workspaceId, draft })
      setNoteText('')
      setNoteOpen(false)
    } catch (error: unknown) {
      contextDraftsDispatch({
        type: 'draft-failed',
        workspaceId,
        message: normalizeContextError(error).message
      })
    }
  }

  function handleRetry(): void {
    if (state.selectedSessionId === null || state.generating) {
      return
    }
    void runGeneration(state.selectedSessionId)
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const overLimit = composerByteLength(composer) > COMPOSER_MAX_BYTES
    if (
      shouldSubmitComposerKey(
        { key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing },
        {
          hasSession: state.selectedSessionId !== null,
          isEmpty: isComposerEmpty(composer),
          sending: state.sending,
          overLimit
        }
      )
    ) {
      event.preventDefault()
      void handleSend()
    }
  }

  async function handleSaveKey(): Promise<void> {
    if (apiKeyInput.trim() === '') {
      return
    }
    try {
      const providerState = await saveProviderCredential({ providerId: OPENAI_PROVIDER_ID, apiKey: apiKeyInput })
      providerDispatch({
        type: 'state-loaded',
        workspaceId,
        requestId: provider.requestId,
        state: providerState
      })
      // The input is write-only: cleared immediately, never repopulated
      // from storage. There is no "show saved key" path.
      setApiKeyInput('')
      setRevealKey(false)
    } catch (error: unknown) {
      providerDispatch({
        type: 'state-failed',
        workspaceId,
        requestId: provider.requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleRemoveKey(): Promise<void> {
    try {
      const providerState = await clearProviderCredential(OPENAI_PROVIDER_ID)
      providerDispatch({ type: 'state-loaded', workspaceId, requestId: provider.requestId, state: providerState })
    } catch (error: unknown) {
      providerDispatch({
        type: 'state-failed',
        workspaceId,
        requestId: provider.requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleTestConnection(): Promise<void> {
    if (!provider.configured) {
      return
    }
    const requestId = providerConnectionRequestRef.current + 1
    providerConnectionRequestRef.current = requestId
    providerDispatch({ type: 'connection-started', workspaceId, requestId })
    try {
      const result = await testProviderConnection(OPENAI_PROVIDER_ID)
      if (providerConnectionRequestRef.current !== requestId) {
        return
      }
      providerDispatch({
        type: 'connection-finished',
        workspaceId,
        requestId,
        status: result.status,
        models: result.models
      })
    } catch (error: unknown) {
      if (providerConnectionRequestRef.current !== requestId) {
        return
      }
      providerDispatch({
        type: 'connection-failed',
        workspaceId,
        requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleRefreshModels(): Promise<void> {
    if (!provider.configured || provider.loadingModels) {
      return
    }
    const requestId = providerModelsRequestRef.current + 1
    providerModelsRequestRef.current = requestId
    providerDispatch({ type: 'models-loading', workspaceId, requestId })
    try {
      const models = await listProviderModels(OPENAI_PROVIDER_ID)
      if (providerModelsRequestRef.current !== requestId) {
        return
      }
      providerDispatch({ type: 'models-loaded', workspaceId, requestId, models })
    } catch (error: unknown) {
      if (providerModelsRequestRef.current !== requestId) {
        return
      }
      providerDispatch({
        type: 'models-failed',
        workspaceId,
        requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleUseModel(): Promise<void> {
    if (modelDraft === null || modelDraft === provider.selectedModel) {
      return
    }
    try {
      const providerState = await setProviderModel({ providerId: OPENAI_PROVIDER_ID, model: modelDraft })
      providerDispatch({ type: 'state-loaded', workspaceId, requestId: provider.requestId, state: providerState })
      setModelDraft(null)
    } catch (error: unknown) {
      providerDispatch({
        type: 'state-failed',
        workspaceId,
        requestId: provider.requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  const selectedSession = state.sessions.find((entry) => entry.id === state.selectedSessionId) ?? null
  const empty = isComposerEmpty(composer)
  const overLimit = composerByteLength(composer) > COMPOSER_MAX_BYTES
  const eligibility = proposalEligibility(contextDrafts)
  const proposeMode = proposal.mode === 'propose'
  const workMode = proposal.mode === 'work'
  // loadingMessages gates sending: a latest page in flight must settle
  // first, otherwise its replace-on-arrive could drop a just-appended
  // message. Older-page loads only prepend, so they never clobber.
  // Propose mode additionally requires exactly one whole-file context;
  // Ask mode behavior is unchanged.
  const sendDisabled =
    state.selectedSessionId === null ||
    empty ||
    state.sending ||
    overLimit ||
    state.loadingMessages ||
    proposal.preparing ||
    work.preparing ||
    (proposeMode && !eligibility.eligible)
  const latestMessage = state.messages[state.messages.length - 1] ?? null
  const showRetry =
    latestMessage !== null &&
    latestMessage.role === 'user' &&
    aiReady &&
    !state.generating &&
    !state.loadingMessages
  const modelValue = modelDraft ?? provider.selectedModel ?? ''
  const selectedModel = provider.selectedModel
  const selectedModelMissing =
    selectedModel !== null && !provider.models.some((entry) => entry.id === selectedModel)
```

### SessionPanel part 9/16: render — header, recovery card, approval card

```tsx
  return (
    <section className="session" aria-label="STARK Session">
      <div className="session__header">
        <p className="session__eyebrow">Session</p>
        <p className="session__title">{selectedSession?.title ?? 'No session'}</p>
        <button className="explorer__primary session__new" type="button" onClick={() => void handleNew()} disabled={state.loadingSessions}>
          New
        </button>
        <details className="session__menu">
          <summary
            className="explorer__secondary session__menu-toggle"
            aria-label="Session options"
            title="Session options"
          >
            ···
          </summary>
          <div className="session__menu-body">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-label="Toggle AI settings"
            >
              Settings
            </button>
            {state.sessions.length > 0 && (
              <label className="session__menu-history" htmlFor="session-history-select">
                <span className="session__eyebrow">History</span>
                <select
                  id="session-history-select"
                  className="session__select"
                  value={state.selectedSessionId ?? ''}
                  onChange={(event) => handleSelect(Number(event.target.value))}
                  aria-label="Recent sessions"
                >
                  {state.sessions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </details>
        <button
          className="explorer__secondary session__looplink"
          type="button"
          onClick={() => void handleContinueWithLooplink()}
          disabled={state.selectedSessionId === null || looplink.acting || state.sending}
          aria-label="Continue with Looplink"
          title="Snapshot this session into a new continuation session"
        >
          {looplink.acting ? 'Preparing…' : 'Continue with Looplink'}
        </button>
      </div>
      {looplink.actionError !== null && (
        <p className="session__error" role="alert">
          {looplink.actionError}
        </p>
      )}
      {recovery.event !== null && (
        <div className="session__recovery" aria-label="Recovery handoff">
          <p className="session__status" role="status">
            {recoverySourceCopy(recovery.event.status)}
          </p>
          <p className="session__hint" role="note">
            {recoveryTargetCopy(recovery.event)}
          </p>
          {recovery.event.routes.length > 0 && (
            <ul className="session__list" aria-label="Recovery routes">
              {recovery.event.routes.map((route) => (
                <li key={route.role} className="session__message">
                  <span className="session__role">{route.role}</span>
                  <p className="session__content">
                    {route.providerId} / {route.model}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => handleSelect(recovery.event?.targetSessionId ?? 0)}
              disabled={(recovery.event?.targetSessionId ?? 0) === 0}
              aria-label="Open recovery session"
            >
              Open recovery session
            </button>
            {recovery.event.status === 'handoff_ready' && (
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => void handleDismissRecovery()}
                aria-label="Dismiss recovery"
              >
                Dismiss
              </button>
            )}
          </div>
          {recovery.eventError !== null && (
            <p className="session__error" role="alert">
              {recovery.eventError}
            </p>
          )}
        </div>
      )}
      {pendingApproval !== null && (
        <div className="session__recovery" aria-label="Worker approval">
          <p className="session__status" role="status">
            {pendingApproval.toolName === 'change_propose' ? 'Worker wants to create a reviewable proposal.' : 'STARK Worker needs permission'}
          </p>
          {pendingApproval.toolName === 'terminal_execute' && (
            <p className="session__hint" role="note">
              Capability: Terminal command
            </p>
          )}
          {pendingApproval.toolName === 'runtime_start' && (
            <p className="session__hint" role="note">
              Capability: Project runtime
            </p>
          )}
          {pendingApproval.toolName === 'runtime_observe' && (
            <p className="session__hint" role="note">
              Capability: Runtime observation
            </p>
          )}
          {pendingApproval.toolName === 'preview_inspect' && (
            <p className="session__hint" role="note">
              Capability: Live Preview inspection
            </p>
          )}
          {pendingApproval.toolName === 'runtime_observe' && (
            <p className="session__hint" role="note">
              Action: Observe managed runtime
            </p>
          )}
          {pendingApproval.toolName === 'preview_inspect' && (
            <p className="session__hint" role="note">
              Action: Inspect rendered Live Preview
            </p>
          )}
          <p className="session__hint" role="note">
            {pendingApproval.summary}
          </p>
          <p className="session__hint" role="note">
            {pendingApproval.toolName === 'change_propose'
              ? 'Approval creates a reviewable proposal only. Files will not change until you review and Accept them.'
              : pendingApproval.toolName === 'terminal_execute'
                ? 'This exact command will run with your user account from the Workspace root. It may modify files, start subprocesses, or access the network.'
                : pendingApproval.toolName === 'runtime_start'
                  ? 'This exact command will run with your user account from the Workspace root and may modify files, start subprocesses, or access the network.'
                  : pendingApproval.toolName === 'runtime_observe'
                    ? 'This approval allows STARK Worker to read the current managed runtime state and bounded logs once. This approval does not allow STARK Worker to stop, restart, or modify the runtime.'
                    : pendingApproval.toolName === 'preview_inspect'
                      ? 'STARK Worker may inspect bounded rendered content from this local Preview once. STARK does not click, type, submit forms, or modify the DOM. If needed, STARK may load this approved local Preview path in an isolated inspection window.'
                      : 'This approval applies only to this exact action.'}
          </p>
          {pendingApproval.toolName === 'runtime_start' && (
            <>
              <p className="session__hint" role="note">
                This runtime may remain active for up to 30 minutes.
              </p>
              <p className="session__hint" role="note">
                This approval applies only to this exact program, arguments, and preview port.
              </p>
            </>
          )}
          {pendingApproval.toolName === 'terminal_execute' && (
            <p className="session__hint" role="note">
              This approval applies only to this exact program and argument list.
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleApprovalDecision(false)}
              disabled={approvalActing}
              aria-label="Deny approval"
            >
              Deny
            </button>
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleApprovalDecision(true)}
              disabled={approvalActing}
              aria-label="Approve approval"
            >
              {approvalActing ? 'Resolving…' : 'Approve'}
            </button>
          </div>
          {approvalError !== null && (
            <p className="session__error" role="alert">
              {approvalError}
            </p>
          )}
        </div>
      )}
```

### SessionPanel part 10/16: render — runtime card, notice, AI settings (provider/key/models)

```tsx
      {(runtime.active !== null || runtime.history.length > 0) && (
        <div className="session__recovery" aria-label="Project runtime">
          <p className="session__status" role="status">
            Project runtime{runtime.active !== null ? ` · ${runtimeStatusLabel(runtime.active.status)}` : ''}
          </p>
          {runtime.active !== null && (
            <>
              <p className="session__hint" role="note">
                Command: {runtime.active.program}{runtime.active.args.length > 0 ? ` ${runtime.active.args.join(' ')}` : ''}
              </p>
              <p className="session__hint" role="note">
                Preview: {runtime.active.previewUrl}
              </p>
              <p className="session__hint" role="note">
                Started: {formatTime(runtime.active.startedAt ?? runtime.active.createdAt)} · Maximum runtime: 30 minutes.
              </p>
              <div className="session__settings-row">
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => void handleOpenPreview(runtime.active?.id ?? 0)}
                  disabled={runtime.acting || runtime.active.status !== 'running'}
                  aria-label="Open preview"
                >
                  Open Preview
                </button>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => void handleReloadPreview(runtime.active?.id ?? 0)}
                  disabled={runtime.acting || runtime.active.status !== 'running'}
                  aria-label="Reload preview"
                >
                  Reload Preview
                </button>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => void handleStopRuntime(runtime.active?.id ?? 0)}
                  disabled={runtime.acting || (runtime.active.status !== 'running' && runtime.active.status !== 'starting')}
                  aria-label="Stop runtime"
                >
                  Stop Runtime
                </button>
              </div>
              {(runtime.active.stdoutTail !== '' || runtime.active.stderrTail !== '') && (
                <>
                  <p className="session__eyebrow">Runtime output</p>
                  {runtime.active.stdoutTail !== '' && (
                    <pre className="session__hint" aria-label="Runtime stdout">{runtime.active.stdoutTail}</pre>
                  )}
                  {runtime.active.stderrTail !== '' && (
                    <pre className="session__hint" aria-label="Runtime stderr">{runtime.active.stderrTail}</pre>
                  )}
                  {runtime.active.logsTruncated && (
                    <p className="session__hint" role="note">
                      Older runtime output was omitted.
                    </p>
                  )}
                </>
              )}
              <details aria-label="Worker observation details">
                <summary className="session__eyebrow">Worker observation details</summary>
                <p className="session__hint" role="note">
                  Runtime observation: Observed runtime state and bounded logs appear in Work run details as inert text.
                </p>
                <p className="session__hint" role="note">
                  Live Preview inspection: Page title, loopback URL, rendered text, and bounded element list appear in Work run details as inert text. No input values are shown.
                </p>
                <p className="session__hint" role="note">
                  {PREVIEW_TRUNCATION_NOTICE}
                </p>
              </details>
            </>
          )}
          {runtime.history.length > 0 && (
            <>
              <p className="session__eyebrow">Recent runtimes</p>
              <ul className="session__context-list">
                {runtime.history.map((entry: ProjectRuntimeSummary) => (
                  <li key={entry.id}>
                    <span className="session__hint">
                      {entry.program} · port {entry.previewPort} · {runtimeStatusLabel(entry.status)}
                      {entry.stopReason !== null ? ` · ${entry.stopReason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {runtime.error !== null && (
            <p className="session__error" role="alert">
              {runtime.error}
            </p>
          )}
        </div>
      )}
      <p className="session__notice" role="status">
        {aiReady ? `OpenAI · ${provider.selectedModel ?? ''}` : 'Local session — AI provider not connected yet.'}
      </p>
      {settingsOpen && (
        <div className="session__settings" aria-label="AI settings">
          <div className="session__settings-row">
            <span className="session__eyebrow">Provider</span>
            <span className="session__provider-name">{provider.displayName}</span>
          </div>
          {!provider.secureStorageAvailable && (
            <p className="session__error" role="alert">
              Secure credential storage is not available on this system.
            </p>
          )}
          <label className="session__eyebrow" htmlFor="session-api-key">
            API key
          </label>
          <div className="session__settings-row">
            <input
              id="session-api-key"
              className="session__field"
              type={revealKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder="Paste OpenAI API key…"
              autoComplete="off"
              spellCheck={false}
              aria-label="OpenAI API key"
            />
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => setRevealKey((reveal) => !reveal)}
              aria-label={revealKey ? 'Hide typed key' : 'Reveal typed key'}
            >
              {revealKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveKey()}
              disabled={apiKeyInput.trim() === '' || !provider.secureStorageAvailable}
            >
              Save key
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleRemoveKey()}
              disabled={!provider.configured}
            >
              Remove key
            </button>
            <span className="session__hint">{provider.configured ? 'Configured' : 'Not configured'}</span>
          </div>
          {provider.error !== null && (
            <p className="session__error" role="alert">
              {provider.error}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={!provider.configured || provider.connectionPhase === 'testing'}
            >
              {provider.connectionPhase === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleRefreshModels()}
              disabled={!provider.configured || provider.loadingModels}
            >
              {provider.loadingModels ? 'Loading…' : 'Refresh models'}
            </button>
          </div>
          {provider.connectionPhase === 'done' && provider.connectionStatus !== null && (
            <p className="session__status" role="status">
              Connection: {connectionStatusLabel(provider.connectionStatus)}
            </p>
          )}
          {provider.connectionPhase === 'error' && provider.connectionError !== null && (
            <p className="session__error" role="alert">
              {provider.connectionError}
            </p>
          )}
          <label className="session__eyebrow" htmlFor="session-model-select">
            Model
          </label>
          <div className="session__settings-row">
            <select
              id="session-model-select"
              className="session__select"
              value={modelValue}
              onChange={(event) => setModelDraft(event.target.value)}
              disabled={!provider.configured || (provider.models.length === 0 && provider.selectedModel === null)}
              aria-label="Available models"
            >
              {modelValue === '' && <option value="">Select a model…</option>}
              {selectedModelMissing && selectedModel !== null ? (
                <option key={selectedModel} value={selectedModel}>
                  {selectedModel}
                </option>
              ) : null}
              {provider.models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id}
                </option>
              ))}
            </select>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleUseModel()}
              disabled={modelDraft === null || modelDraft === provider.selectedModel}
            >
              Use model
            </button>
          </div>
          {provider.modelsError !== null && (
            <p className="session__error" role="alert">
              {provider.modelsError}
            </p>
          )}
```

### SessionPanel part 11/16: render — Heart routing + Recovery config

```tsx
          <div className="session__settings-row">
            <span className="session__eyebrow">Heart routing</span>
            <span className="session__hint">
              {heart.config === null ? 'Not configured' : heart.config.workerMode === 'fixed' ? 'Fixed' : 'Auto-Swap'}
            </span>
          </div>
          <p className="session__eyebrow">Brain model</p>
          <div className="session__settings-row">
            <select
              className="session__select"
              value={heart.draft.brain.providerId}
              onChange={(event) =>
                heartDispatch({
                  type: 'draft-edited',
                  workspaceId,
                  field: { scope: 'brain' },
                  providerId: event.target.value,
                  model: heart.draft.brain.model
                })
              }
              aria-label="Brain provider"
            >
              <option value="openai">openai</option>
            </select>
            <input
              className="session__field"
              value={heart.draft.brain.model}
              onChange={(event) =>
                heartDispatch({
                  type: 'draft-edited',
                  workspaceId,
                  field: { scope: 'brain' },
                  providerId: heart.draft.brain.providerId,
                  model: event.target.value
                })
              }
              placeholder="Brain model…"
              aria-label="Brain model"
              list="heart-model-options"
            />
          </div>
          <div className="session__composer-row" role="group" aria-label="Worker routing mode">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => heartDispatch({ type: 'mode-selected', workspaceId, mode: 'fixed' })}
              aria-pressed={heart.draft.workerMode === 'fixed'}
            >
              Fixed
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => heartDispatch({ type: 'mode-selected', workspaceId, mode: 'auto_swap' })}
              aria-pressed={heart.draft.workerMode === 'auto_swap'}
            >
              Auto-Swap
            </button>
          </div>
          <p className="session__hint" role="note">
            Auto-Swap lets STARK Brain request a task profile. Heart maps that profile to one of your configured
            models. It does not retry failed models automatically.
          </p>
          {heart.draft.workerMode === 'fixed' ? (
            <>
              <p className="session__eyebrow">Worker model (Fixed)</p>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={heart.draft.workerFixed.providerId}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerFixed' },
                      providerId: event.target.value,
                      model: heart.draft.workerFixed.model
                    })
                  }
                  aria-label="Fixed worker provider"
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={heart.draft.workerFixed.model}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerFixed' },
                      providerId: heart.draft.workerFixed.providerId,
                      model: event.target.value
                    })
                  }
                  placeholder="Worker model…"
                  aria-label="Fixed worker model"
                  list="heart-model-options"
                />
              </div>
            </>
          ) : (
            <>
              <p className="session__eyebrow">Default Worker model</p>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={heart.draft.workerDefault.providerId}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerDefault' },
                      providerId: event.target.value,
                      model: heart.draft.workerDefault.model
                    })
                  }
                  aria-label="Default worker provider"
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={heart.draft.workerDefault.model}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerDefault' },
                      providerId: heart.draft.workerDefault.providerId,
                      model: event.target.value
                    })
                  }
                  placeholder="Default worker model…"
                  aria-label="Default worker model"
                  list="heart-model-options"
                />
              </div>
              {(Object.keys(heart.draft.workerRoutes) as ('general' | 'coding' | 'reasoning' | 'fast')[]).map(
                (profile) => (
                  <div key={profile}>
                    <p className="session__eyebrow">{profile[0]?.toUpperCase() + profile.slice(1)} override (optional)</p>
                    <div className="session__settings-row">
                      <select
                        className="session__select"
                        value={heart.draft.workerRoutes[profile].providerId}
                        onChange={(event) =>
                          heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'route', profile },
                            providerId: event.target.value,
                            model: heart.draft.workerRoutes[profile].model
                          })
                        }
                        aria-label={`${profile} worker provider`}
                      >
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="session__field"
                        value={heart.draft.workerRoutes[profile].model}
                        onChange={(event) =>
                          heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'route', profile },
                            providerId: heart.draft.workerRoutes[profile].providerId,
                            model: event.target.value
                          })
                        }
                        placeholder={`${profile} model… (optional)`}
                        aria-label={`${profile} worker model`}
                        list="heart-model-options"
                      />
                    </div>
                  </div>
                )
              )}
            </>
          )}
          <datalist id="heart-model-options">
            {provider.models.map((entry) => (
              <option key={entry.id} value={entry.id} />
            ))}
          </datalist>
          {heart.loading && (
            <p className="session__status" role="status">
              Loading Heart…
            </p>
          )}
          {heart.loadError !== null && (
            <p className="session__error" role="alert">
              {heart.loadError}
            </p>
          )}
          {heart.saveError !== null && (
            <p className="session__error" role="alert">
              {heart.saveError}
            </p>
          )}
          {heart.notice !== null && (
            <p className="session__status" role="status">
              {heart.notice}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveHeart()}
              disabled={heart.saving}
            >
              {heart.saving ? 'Saving…' : 'Save Heart'}
            </button>
          </div>
          <div className="session__settings-row">
            <span className="session__eyebrow">Continuity Recovery</span>
          </div>
          <div className="session__composer-row" role="group" aria-label="Continuity recovery mode">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'off' })}
              aria-pressed={recovery.draft.mode === 'off'}
            >
              Off
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'handoff' })}
              aria-pressed={recovery.draft.mode === 'handoff'}
            >
              Handoff only
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'auto_once' })}
              aria-pressed={recovery.draft.mode === 'auto_once'}
            >
              Auto once
            </button>
          </div>
          <p className="session__hint" role="note">
            {recovery.draft.mode === 'handoff'
              ? 'Create a Looplink recovery session after a recoverable provider failure, but do not call another model automatically.'
              : recovery.draft.mode === 'auto_once'
                ? 'Create one Looplink recovery session and make one attempt using your Recovery models. STARK will not retry or create another automatic handoff if that attempt fails.'
                : 'Recovery is off. Provider failures surface normally.'}
          </p>
          {(['ask', 'brain', 'worker'] as const).map((scope) => (
            <div key={scope}>
              <p className="session__eyebrow">
                {scope === 'ask' ? 'Ask Recovery' : scope === 'brain' ? 'Brain Recovery' : 'Worker Recovery'}
              </p>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={recovery.draft[scope].providerId}
                  onChange={(event) =>
                    recoveryDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope },
                      providerId: event.target.value,
                      model: recovery.draft[scope].model
                    })
                  }
                  aria-label={`${scope} recovery provider`}
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={recovery.draft[scope].model}
                  onChange={(event) =>
                    recoveryDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope },
                      providerId: recovery.draft[scope].providerId,
                      model: recovery.draft[scope].model
                    })
                  }
                  placeholder={`${scope} recovery model…`}
                  aria-label={`${scope} recovery model`}
                  list="recovery-model-options"
                />
              </div>
            </div>
          ))}
          <datalist id="recovery-model-options">
            {provider.models.map((entry) => (
              <option key={entry.id} value={entry.id} />
            ))}
          </datalist>
```

### SessionPanel part 12/16: render — recovery notices, usage summary, limits (verbatim)

```tsx
          {recovery.loading && (
            <p className="session__status" role="status">
              Loading recovery…
            </p>
          )}
          {recovery.loadError !== null && (
            <p className="session__error" role="alert">
              {recovery.loadError}
            </p>
          )}
          {recovery.saveError !== null && (
            <p className="session__error" role="alert">
              {recovery.saveError}
            </p>
          )}
          {recovery.notice !== null && (
            <p className="session__status" role="status">
              {recovery.notice}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveRecovery()}
              disabled={recovery.saving}
            >
              {recovery.saving ? 'Saving…' : 'Save Recovery'}
            </button>
          </div>
          <div className="session__settings-row">
            <span className="session__eyebrow">Usage &amp; Threshold Routing</span>
            <span className="session__hint">{usage.draft.thresholdRoutingEnabled ? 'On' : 'Off'}</span>
          </div>
          <p className="session__hint" role="note">
            STARK tracks only provider calls made by STARK. It does not query provider billing or quota APIs and
            cannot see usage generated outside STARK.
          </p>
          <p className="session__hint" role="note">
            Token counts are shown only when the provider reports them.
          </p>
          <div className="session__composer-row" role="group" aria-label="Threshold routing">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => usageDispatch({ type: 'routing-toggled', workspaceId, enabled: false })}
              aria-pressed={!usage.draft.thresholdRoutingEnabled}
            >
              Off
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => usageDispatch({ type: 'routing-toggled', workspaceId, enabled: true })}
              aria-pressed={usage.draft.thresholdRoutingEnabled}
            >
              On
            </button>
          </div>
          <p className="session__hint" role="note">
            When a base Heart model reaches your local routing threshold, STARK may use the configured alternate
            before making the provider call.
          </p>
          <p className="session__hint" role="note">
            This does not retry failed models and is not a provider quota guarantee.
          </p>
          <p className="session__hint" role="note">
            If no alternate is configured, STARK continues using the normal Heart route.
          </p>
          <div className="session__settings-row">
            <span className="session__eyebrow">Local usage — last 24 hours</span>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void refreshUsageSummary(workspaceId)}
              disabled={usage.summaryLoading}
              aria-label="Refresh usage"
            >
              {usage.summaryLoading ? 'Refreshing…' : 'Refresh usage'}
            </button>
          </div>
          {usage.summary !== null && (
            <ul className="session__context-list" aria-label="Local usage summary">
              {usage.summary.models.map((entry) => (
                <li key={`${entry.providerId}/${entry.model}`}>
                  <p className="session__hint" role="note">
                    {entry.providerId} / {entry.model} · {entry.calls24h} calls ·{' '}
                    {entry.tokenTelemetryComplete && entry.totalTokens24h !== null
                      ? `${entry.totalTokens24h} tokens`
                      : 'Token telemetry incomplete'}{' '}
                    · {entry.rateLimitFailures24h} rate-limit failures · {formatUsageThreshold(entry)} ·{' '}
                    {entry.thresholdReached ? 'Threshold reached' : 'Below threshold'}
                  </p>
                  {!entry.tokenTelemetryComplete && (
                    <p className="session__hint" role="note">
                      Token threshold cannot be evaluated completely because this provider/model did not report token
                      usage for every observed call.
                    </p>
                  )}
                </li>
              ))}
              {usage.summary.truncated && (
                <li>
                  <p className="session__hint" role="note">
                    Showing the first {usage.summary.models.length} provider/model rows.
                  </p>
                </li>
              )}
            </ul>
          )}
          {usage.summaryError !== null && (
            <p className="session__error" role="alert">
              {usage.summaryError}
            </p>
          )}
          <div className="session__settings-row">
            <span className="session__eyebrow">Local routing thresholds</span>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => usageDispatch({ type: 'limit-added', workspaceId })}
              aria-label="Add usage limit"
            >
              Add limit
            </button>
          </div>
          {usage.draft.limits.map((entry, index) => (
            <div key={index}>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={entry.providerId}
                  onChange={(event) =>
                    usageDispatch({
                      type: 'limit-edited',
                      workspaceId,
                      index,
                      limit: { ...entry, providerId: event.target.value }
                    })
                  }
                  aria-label={`Usage limit ${index + 1} provider`}
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={entry.model}
                  onChange={(event) =>
                    usageDispatch({
                      type: 'limit-edited',
                      workspaceId,
                      index,
                      limit: { ...entry, model: event.target.value }
                    })
                  }
                  placeholder="Model…"
                  aria-label={`Usage limit ${index + 1} model`}
                  list="usage-model-options"
                />
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => usageDispatch({ type: 'limit-removed', workspaceId, index })}
                  aria-label={`Remove usage limit ${index + 1}`}
                >
                  Remove
                </button>
              </div>
              <div className="session__settings-row">
                <input
                  className="session__field"
                  value={entry.maxCalls}
                  onChange={(event) =>
                    usageDispatch({
                      type: 'limit-edited',
                      workspaceId,
                      index,
                      limit: { ...entry, maxCalls: event.target.value }
                    })
                  }
                  placeholder="Max STARK calls / 24h…"
                  aria-label={`Usage limit ${index + 1} max calls`}
                />
                <input
                  className="session__field"
                  value={entry.maxTokens}
                  onChange={(event) =>
                    usageDispatch({
                      type: 'limit-edited',
                      workspaceId,
                      index,
                      limit: { ...entry, maxTokens: event.target.value }
                    })
                  }
                  placeholder="Max reported tokens / 24h…"
                  aria-label={`Usage limit ${index + 1} max tokens`}
                />
                <input
                  className="session__field"
                  value={entry.switchAt}
                  onChange={(event) =>
                    usageDispatch({
                      type: 'limit-edited',
                      workspaceId,
                      index,
                      limit: { ...entry, switchAt: event.target.value }
                    })
                  }
                  placeholder="Switch at %…"
                  aria-label={`Usage limit ${index + 1} switch percent`}
                />
              </div>
            </div>
          ))}
```

### SessionPanel part 13/16: render — threshold alternates + permissions (verbatim)

```tsx
          <div className="session__settings-row">
            <span className="session__eyebrow">Threshold alternates</span>
          </div>
          {USAGE_ROUTE_KEYS.map((routeKey) => (
            <div key={routeKey}>
              <p className="session__eyebrow">{usageRouteLabel(routeKey)}</p>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={usage.draft.alternates[routeKey].providerId}
                  onChange={(event) =>
                    usageDispatch({
                      type: 'alternate-edited',
                      workspaceId,
                      routeKey,
                      alternate: { ...usage.draft.alternates[routeKey], providerId: event.target.value }
                    })
                  }
                  aria-label={`${usageRouteLabel(routeKey)} alternate provider`}
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={usage.draft.alternates[routeKey].model}
                  onChange={(event) =>
                    usageDispatch({
                      type: 'alternate-edited',
                      workspaceId,
                      routeKey,
                      alternate: { ...usage.draft.alternates[routeKey], model: event.target.value }
                    })
                  }
                  placeholder={`${usageRouteLabel(routeKey)} alternate model…`}
                  aria-label={`${usageRouteLabel(routeKey)} alternate model`}
                  list="usage-model-options"
                />
              </div>
            </div>
          ))}
          <datalist id="usage-model-options">
            {provider.models.map((entry) => (
              <option key={entry.id} value={entry.id} />
            ))}
          </datalist>
          {usage.loading && (
            <p className="session__status" role="status">
              Loading usage…
            </p>
          )}
          {usage.loadError !== null && (
            <p className="session__error" role="alert">
              {usage.loadError}
            </p>
          )}
          {usage.saveError !== null && (
            <p className="session__error" role="alert">
              {usage.saveError}
            </p>
          )}
          {usage.notice !== null && (
            <p className="session__status" role="status">
              {usage.notice}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveUsage()}
              disabled={usage.saving}
            >
              {usage.saving ? 'Saving…' : 'Save usage routing'}
            </button>
          </div>
          <div className="session__settings-row">
            <span className="session__eyebrow">Agent Permissions</span>
            <span className="session__hint">{capabilities.draft.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <p className="session__hint" role="note">
            Permissions only control whether future STARK Worker tools may request an action. They do not bypass
            Workspace security or human review.
          </p>
          <div className="session__settings-row">
            <span className="session__eyebrow">Workspace Agent Capabilities</span>
          </div>
          <div className="session__composer-row" role="group" aria-label="Workspace agent capabilities">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: false })}
              aria-pressed={!capabilities.draft.enabled}
            >
              Disabled
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: true })}
              aria-pressed={capabilities.draft.enabled}
            >
              Enabled
            </button>
          </div>
          <div aria-disabled={!capabilities.draft.enabled}>
            {CAPABILITY_ORDER.map((capability) => (
              <div key={capability}>
                <p className="session__eyebrow">{capabilityLabel(capability)}</p>
                <div className="session__composer-row" role="group" aria-label={`${capability} permission`}>
                  {legalModesFor(capability).map((mode) => (
                    <button
                      key={mode}
                      className="explorer__secondary"
                      type="button"
                      onClick={() => capabilitiesDispatch({ type: 'mode-selected', workspaceId, capability, mode })}
                      aria-pressed={capabilities.draft.modes[capability] === mode}
                      disabled={!capabilities.draft.enabled}
                    >
                      {mode === 'deny' ? 'Deny' : mode === 'ask' ? 'Ask' : 'Allow'}
                    </button>
                  ))}
                </div>
                {capability === 'terminal.execute' && (
                  <p className="session__hint" role="note">
                    Terminal execution always requires approval for the exact command.
                  </p>
                )}
                {capability === 'change.propose' && (
                  <p className="session__hint" role="note">
                    Allowing proposals does not allow STARK to apply them. File changes still require review and Accept.
                  </p>
                )}
                {capability === 'runtime.observe' && (
                  <p className="session__hint" role="note">
                    Allows the Worker to inspect the managed runtime&apos;s status and bounded stdout/stderr logs.
                  </p>
                )}
                {capability === 'preview.inspect' && (
                  <p className="session__hint" role="note">
                    Allows the Worker to inspect bounded rendered content from STARK&apos;s local Live Preview. It does not allow clicking, typing, form submission, or DOM modification.
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="session__hint" role="note">
            STARK must ask before each future action.
          </p>
          {capabilities.loading && (
            <p className="session__status" role="status">
              Loading permissions…
            </p>
          )}
          {capabilities.loadError !== null && (
            <p className="session__error" role="alert">
              {capabilities.loadError}
            </p>
          )}
          {capabilities.saveError !== null && (
            <p className="session__error" role="alert">
              {capabilities.saveError}
            </p>
          )}
          {capabilities.notice !== null && (
            <p className="session__status" role="status">
              {capabilities.notice}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveCapabilities()}
              disabled={capabilities.saving}
            >
              {capabilities.saving ? 'Saving…' : 'Save permissions'}
            </button>
          </div>
        </div>
      )}
```

### SessionPanel part 14/16: render — sessions, messages, looplink continuity (verbatim)

```tsx
      {state.loadingSessions && state.sessions.length === 0 ? (
        <div className="session__empty">
          <p className="session__status" role="status">
            Loading sessions…
          </p>
        </div>
      ) : state.sessions.length === 0 ? (
        <div className="session__empty">
          <p className="session__empty-text">No coding sessions yet.</p>
          <button className="explorer__primary" type="button" onClick={() => void handleNew()}>
            New session
          </button>
          {state.sessionsError !== null && (
            <p className="session__error" role="alert">
              {state.sessionsError}
            </p>
          )}
        </div>
      ) : (
        <>
          {state.sessionsError !== null && (
            <p className="session__error" role="alert">
              {state.sessionsError}
            </p>
          )}
          <div className="session__messages" ref={messagesScrollRef} aria-label="Messages" aria-live="off">
            {state.hasMore && (
              <button
                className="explorer__secondary"
                type="button"
                onClick={handleLoadOlder}
                disabled={state.loadingMessages}
              >
                {state.loadingMessages ? 'Loading…' : 'Load older messages'}
              </button>
            )}
            {state.loadingMessages && state.messages.length === 0 ? (
              <p className="session__status" role="status">
                Loading messages…
              </p>
            ) : state.messagesError !== null ? (
              <p className="session__error" role="alert">
                {state.messagesError}
              </p>
            ) : (
              <ul className="session__list" aria-label="Message list">
                {state.messages.map((message) => (
                  <li
                    key={message.id}
                    className={
                      message.role === 'assistant' ? 'session__message session__message--assistant' : 'session__message'
                    }
                  >
                    <span className="session__role">{roleLabel(message.role)}</span>
                    <p className="session__content">{message.content}</p>
                    {(message.context ?? []).length > 0 && (
                      <div className="session__sent-context" aria-label={`Context sent with message ${message.id}`}>
                        {(message.context ?? []).map((item) => (
                          <ContextCard
                            key={item.id}
                            label={item.label}
                            detail={item.kind}
                            content={item.content}
                            removable={false}
                          />
                        ))}
                      </div>
                    )}
                    <span className="session__time">{formatTime(message.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {state.generating && (
              <p className="session__status" role="status">
                STARK is thinking…
              </p>
            )}
            {state.generationError !== null && (
              <div className="session__generation-error" role="alert">
                <p className="session__error">{state.generationError}</p>
                {showRetry && (
                  <button className="explorer__secondary" type="button" onClick={handleRetry}>
                    Retry response
                  </button>
                )}
              </div>
            )}
            {showRetry && state.generationError === null && (
              <button className="explorer__secondary" type="button" onClick={handleRetry}>
                Retry response
              </button>
            )}
          </div>
          {looplink.loading && (
            <p className="session__status" role="status">
              Loading continuity…
            </p>
          )}
          {looplink.loadError !== null && (
            <p className="session__error" role="alert">
              {looplink.loadError}
            </p>
          )}
          {looplink.looplink !== null && (
            <div className="session__context" aria-label="Looplink continuity">
              <div className="session__context-header">
                <p className="session__eyebrow">Looplink</p>
                <span className="session__hint">Status: {looplink.looplink.status}</span>
              </div>
              <p className="session__status">
                Continuing from: {looplink.looplink.sourceTitle}
              </p>
              {looplink.looplink.payload.omissions.messageCount > 0 && (
                <p className="session__hint" role="status">
                  {looplink.looplink.payload.omissions.messageCount} older messages omitted to stay within the
                  continuity limit.
                </p>
              )}
              {looplink.looplink.payload.omissions.contextCount > 0 && (
                <p className="session__hint" role="status">
                  {looplink.looplink.payload.omissions.contextCount} older context items omitted to stay within the
                  continuity limit.
                </p>
              )}
              {looplink.looplink.payload.omissions.workerResultOmitted && (
                <p className="session__hint" role="status">
                  Worker result omitted because it exceeded the Looplink limit.
                </p>
              )}
              {looplink.looplink.payload.omissions.changeCount > 0 && (
                <p className="session__hint" role="status">
                  {looplink.looplink.payload.omissions.changeCount} older change references omitted to stay within the
                  continuity limit.
                </p>
              )}
              <ul className="session__context-list">
                {looplink.looplink.payload.messages.map((entry, index) => (
                  <li key={index}>
                    <ContextCard
                      label={entry.role === 'assistant' ? 'STARK (historical)' : 'You (historical)'}
                      detail="history"
                      content={entry.content}
                      removable={false}
                    />
                  </li>
                ))}
                {looplink.looplink.payload.explicitContext.map((entry, index) => (
                  <li key={`ctx-${String(index)}`}>
                    <ContextCard
                      label={`Historical context snapshot · ${entry.label}`}
                      detail={entry.kind}
                      content={entry.content}
                      removable={false}
                    />
                  </li>
                ))}
              </ul>
              {looplink.looplink.payload.orchestration !== null && (
                <p className="session__status">
                  Latest plan: {looplink.looplink.payload.orchestration.planSummary ?? looplink.looplink.payload.orchestration.status}
                </p>
              )}
              {looplink.looplink.status === 'pending' && (
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => void handleDismissLooplink()}
                  disabled={looplink.acting}
                >
                  Dismiss
                </button>
              )}
            </div>
          )}
```

### SessionPanel part 15/16: render — attached context drawer + note form (verbatim)

```tsx
          <div className="session__context" aria-label="Attached context">
            <div className="session__context-header">
              <p className="session__eyebrow">Attached context{contextDrafts.length > 0 ? ` (${String(contextDrafts.length)})` : ''}</p>
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => setContextOpen((open) => !open)}
                aria-expanded={contextOpen}
                aria-label={contextOpen ? 'Collapse attached context' : 'Expand attached context'}
              >
                {contextOpen ? 'Collapse' : 'Expand'}
              </button>
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => setNoteOpen((open) => !open)}
                aria-expanded={noteOpen}
              >
                Add note
              </button>
            </div>
            {contextOpen && (
            <>
            {contextDraftError !== null && (
              <p className="session__error" role="alert">
                {contextDraftError}
              </p>
            )}
            {contextDrafts.length === 0 ? (
              <p className="session__empty-text">No context attached. Only what you attach here is sent to the AI.</p>
            ) : (
              <ul className="session__context-list">
                {contextDrafts.map((draft) => (
                  <li key={draft.draftId}>
                    <ContextCard
                      label={draft.label}
                      detail={draft.kind}
                      content={draft.content}
                      removable
                      onRemove={() => handleRemoveDraft(draft.draftId)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {noteOpen && (
              <div className="session__note-form">
                <label className="session__eyebrow" htmlFor="session-note-input">
                  Manual note
                </label>
            {work.preparing && (
              <p className="session__status" role="status">
                Brain is working…
              </p>
            )}
            {work.error !== null && (
              <div className="session__generation-error" role="alert">
                <p className="session__error">{work.error}</p>
                <button className="explorer__secondary" type="button" onClick={() => void handleRetryWork()}>
                  Retry Work
                </button>
              </div>
            )}
            {work.run !== null && (
              <div className="session__generation-error" role="status" aria-label="Work run details">
                <p className="session__status">
                  Work run · {work.run.status}
                  {work.run.action !== null ? ` · ${work.run.action}` : ''}
                </p>
                {work.run.planSummary !== null && <p className="session__status">Plan: {work.run.planSummary}</p>}
                <ul className="session__context-list">
                  {work.run.steps.map((step) => (
                    <li key={step.id}>
                      <span className="session__hint">
                        {step.kind === 'brain_plan' ? 'Brain Plan' : step.kind === 'worker' ? 'Worker result' : 'Brain Final response'} · {step.status}
                        {step.modelAudit !== null
                          ? ` · ${step.modelAudit.providerId} / ${step.modelAudit.model}`
                          : ' · Model information unavailable for this older run.'}
                      </span>
                      {step.kind === 'worker' && (
                        <span className="session__hint">
                          {step.modelAudit !== null && step.modelAudit.requestedProfile !== null
                            ? `Requested profile: ${step.modelAudit.requestedProfile} · Resolved route: ${step.modelAudit.routeKey}`
                            : 'Route: Fixed'}
                        </span>
                      )}
                      {step.kind === 'worker' && step.output !== null && (
                        <ContextCard label="Worker result" detail={step.status} content={step.output} removable={false} />
                      )}
                    </li>
                  ))}
                </ul>
                {work.run.usageRouteDecisions.map((decision, index) => (
                  <p className="session__hint" role="note" key={`${decision.role}-${decision.routeKey}-${String(index)}`}>
                    {decision.decision === 'threshold_alternate'
                      ? `${decision.role === 'brain' ? 'Brain' : 'Worker'} — Configured: ${decision.baseProviderId} / ${decision.baseModel} — Threshold route: ${decision.selectedProviderId} / ${decision.selectedModel} — Reason: Local call threshold reached`
                      : decision.decision === 'threshold_reached_no_alternate'
                        ? 'Local threshold reached; normal Heart route used because no alternate is configured.'
                        : null}
                  </p>
                ))}
              </div>
            )}
            <textarea
                  id="session-note-input"
                  className="session__input"
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  placeholder="Type a short note or snippet…"
                  aria-label="Manual context note"
                  rows={3}
                />
                <div className="session__composer-row">
                  <button
                    className="explorer__primary"
                    type="button"
                    onClick={() => void handleAddNote()}
                    disabled={isComposerEmpty(noteText)}
                  >
                    Attach note
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => {
                      setNoteOpen(false)
                      setNoteText('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            </>
            )}
          </div>
```

### SessionPanel part 16/16: render — composer dock (verbatim, end of file)

```tsx
          <div className={`session__composer session__composer--${proposal.mode}`}>
            {state.sendError !== null && (
              <p className="session__error" role="alert">
                {state.sendError}
              </p>
            )}
            {overLimit && (
              <p className="session__error" role="alert">
                This message is too large.
              </p>
            )}
            <div className="session__composer-row" role="group" aria-label="Composer mode">
              <button
                className="explorer__secondary session__mode session__mode--ask"
                type="button"
                onClick={() => handleProposalMode('ask')}
                aria-pressed={proposal.mode === 'ask'}
                disabled={proposal.preparing || work.preparing}
              >
                Ask
              </button>
              <button
                className="explorer__secondary session__mode session__mode--work"
                type="button"
                onClick={() => handleProposalMode('work')}
                aria-pressed={proposal.mode === 'work'}
                disabled={proposal.preparing || work.preparing}
              >
                Work
              </button>
              <button
                className="explorer__secondary session__mode session__mode--propose"
                type="button"
                onClick={() => handleProposalMode('propose')}
                aria-pressed={proposal.mode === 'propose'}
                disabled={proposal.preparing || work.preparing}
              >
                Propose change
              </button>
            </div>
            {proposeMode && !eligibility.eligible && (
              <p className="session__hint" role="status">
                {eligibility.reason ?? 'Attach one or more whole files to propose code changes.'}
              </p>
            )}
            {proposal.preparing && (
              <p className="session__status" role="status">
                STARK is preparing a change…
              </p>
            )}
            {proposal.error !== null && (
              <div className="session__generation-error" role="alert">
                <p className="session__error">{proposal.error}</p>
                <button className="explorer__secondary" type="button" onClick={() => void handleRetryProposal()}>
                  Retry proposal
                </button>
              </div>
            )}
            {proposal.result !== null && (
              <div className="session__generation-error" role="status" aria-label="Code proposal ready">
                <p className="session__status">
                  Proposal ready · {proposal.result.transaction.files[0]?.relativePath ?? 'file'} ·{' '}
                  {proposal.result.summary}
                </p>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => onReviewTransaction(proposal.result?.transaction.id ?? 0)}
                >
                  Review change
                </button>
              </div>
            )}
            {proposal.changeSet !== null && (
              <div className="session__generation-error" role="status" aria-label="Grouped code proposal ready">
                <p className="session__status">
                  Proposal ready · {proposal.changeSet.changeSet.items.length} files ·{' '}
                  {proposal.changeSet.changeSet.summary}
                </p>
                <ul className="session__context-list">
                  {proposal.changeSet.changeSet.items.map((item) => (
                    <li key={item.transaction.id}>
                      <span className="session__hint">
                        - {item.transaction.files[0]?.relativePath ?? 'file'}
                      </span>
                    </li>
                  ))}
                </ul>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => onReviewChangeSet(proposal.changeSet?.changeSet.id ?? 0)}
                >
                  Review change set
                </button>
              </div>
            )}
            <textarea
              ref={composerRef}
              className="session__input"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Message STARK… (Enter to send, Shift+Enter for a new line)"
              aria-label="Message composer"
              rows={3}
              disabled={state.sending || proposal.preparing || work.preparing}
            />
            <div className="session__composer-row">
              <p className="session__hint">
                {proposeMode
                  ? 'Propose change creates pending transactions — one file, or a grouped change set. A human must review and accept each file.'
                  : workMode
                    ? `Work runs a bounded Brain orchestration with at most one Worker step. Heart: ${heart.config === null ? 'not configured' : heart.config.workerMode === 'fixed' ? 'Fixed' : 'Auto-Swap'}`
                    : aiReady
                      ? 'Stored locally. STARK will reply.'
                      : 'Stored locally. No AI reply yet.'}
              </p>
              <button
                className="explorer__primary session__send"
                type="button"
                onClick={() => void handleSend()}
                disabled={sendDisabled}
              >
                {state.sending ? 'Sending…' : proposal.preparing || work.preparing ? 'Preparing…' : 'Send'}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
```

*(End of `SessionPanel.tsx` — 3115 lines total.)*

### `src/renderer/src/features/sessions/session.css` (520 lines, verbatim, part 1/3: session, header, menu, list, messages)

```css
.session {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.session__header {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--stark-space-xs);
  row-gap: 6px;
  padding: var(--stark-space-sm);
  border-bottom: 1px solid var(--stark-border);
  min-width: 0;
  overflow: hidden;
}

.session__eyebrow {
  margin: 0;
  font-family: var(--stark-font-sans);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--stark-text-dim);
  white-space: nowrap;
  flex: 0 0 auto;
}

.session__title {
  margin: 0;
  flex: 1 1 120px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--stark-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session__header .explorer__secondary {
  flex: 0 0 auto;
  min-height: 26px;
  padding: 3px 8px;
  font-size: 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Looplink stays a recognizable text action on its own quiet row. */
.session__header .session__looplink {
  flex: 1 1 100%;
  background: transparent;
  color: var(--stark-text-dim);
  font-weight: 600;
}

.session__header .session__looplink:hover:not(:disabled) {
  background: transparent;
  border-color: transparent;
  color: var(--stark-lime);
}

/* Session options menu: secondary actions without permanent chrome. */
.session__menu {
  position: relative;
  flex: 0 0 auto;
}

.session__menu-toggle {
  list-style: none;
}

.session__menu-toggle::-webkit-details-marker {
  display: none;
}

.session__menu-body {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  min-width: 220px;
  max-width: 280px;
  padding: var(--stark-space-sm);
  background: var(--stark-elevated);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-md);
}

.session__menu-history {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.session__menu-history .session__select {
  width: 100%;
}

/* Conversation reads as one calm column with a readable measure. */
.session__list,
.session__generation-error {
  width: 100%;
  max-width: 880px;
  margin-inline: auto;
}

.session__notice {
  flex: 0 0 auto;
  margin: 0;
  padding: var(--stark-space-xs) var(--stark-space-sm);
  font-size: 12px;
  line-height: 1.5;
  color: var(--stark-text-dim);
  background: var(--stark-elevated);
}

.session__history {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: var(--stark-space-xs);
  align-items: center;
  padding: 6px var(--stark-space-sm);
  min-width: 0;
}

.session__select {
  flex: 1;
  min-width: 0;
  padding: var(--stark-space-xs) var(--stark-space-sm);
  font-size: 13px;
  color: var(--stark-text);
  background: var(--stark-bg);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
}

.session__messages {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-sm);
  padding: var(--stark-space-sm);
}

.session__list {
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-sm);
  margin: 0;
  padding: 0;
  list-style: none;
}

.session__message {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--stark-space-sm) var(--stark-space-md);
  border: none;
  border-radius: var(--stark-radius-md);
  background: var(--stark-elevated);
  min-width: 0;
}

.session__message--assistant {
  background: var(--stark-surface);
  border-left: 2px solid var(--stark-magenta);
}

.session__message--assistant .session__role {
  color: var(--stark-magenta);
}

.session__role {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--stark-text-dim);
}

.session__content {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--stark-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.session__time {
  font-size: 11px;
  color: var(--stark-text-dim);
}

.session__status {
  margin: 0;
  font-family: var(--stark-font-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--stark-text-dim);
  text-align: center;
}
```

### `session.css` part 2/3: recovery cards, composer dock, modes, Send

```css
/* Recovery / approval / runtime cards: one subtle elevated surface. */
.session__recovery {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  min-width: 0;
  margin: var(--stark-space-xs) var(--stark-space-sm);
  padding: var(--stark-space-sm);
  background: var(--stark-elevated);
  border: 1px solid var(--stark-border);
  border-left: 2px solid var(--stark-accent);
  border-radius: var(--stark-radius-md);
}

.session__recovery .session__status {
  text-align: left;
  color: var(--stark-text);
}

.session__recovery .session__settings-row {
  margin-top: 2px;
}

.session__error {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--stark-danger);
}

.session__empty {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--stark-space-sm);
  padding: var(--stark-space-lg);
  text-align: center;
}

.session__empty-text {
  margin: 0;
  font-size: 13px;
  color: var(--stark-text-dim);
}

/* Composer dock: one substantial rounded surface holding the mode
   selector, the input, and the send action. Resting state is quiet
   neutral; focus takes the active mode accent. */
.session__composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  min-width: 0;
  margin: var(--stark-space-sm);
  padding: var(--stark-space-sm);
  border: 1px solid var(--stark-border);
  border-radius: 12px;
  background: var(--stark-elevated);
}

.session__composer:focus-within {
  border-color: var(--stark-lime);
}

.session__composer--work:focus-within {
  border-color: var(--stark-magenta);
}

.session__composer--propose:focus-within {
  border-color: var(--stark-text-dim);
}

.session__input {
  width: 100%;
  min-height: 64px;
  max-height: 200px;
  padding: 2px;
  font: inherit;
  font-family: var(--stark-font-sans);
  font-size: 13px;
  line-height: 1.5;
  color: var(--stark-text);
  background: transparent;
  border: none;
  border-radius: 0;
  resize: vertical;
}

.session__input:focus-visible {
  outline: none;
}

/* Mode selector: compact segmented controls integrated in the dock. */
.session__composer .session__mode {
  min-height: 26px;
  padding: 3px 10px;
  font-size: 11px;
}

.session__composer .session__mode[aria-pressed="true"] {
  color: var(--stark-lime);
  background: var(--stark-lime-dim);
  border-color: var(--stark-lime);
}

.session__composer .session__mode--work[aria-pressed="true"] {
  color: var(--stark-magenta);
  background: var(--stark-magenta-dim);
  border-color: var(--stark-magenta);
}

.session__composer .session__mode--propose[aria-pressed="true"] {
  color: var(--stark-text);
  background: var(--stark-bg);
  border-color: var(--stark-text-dim);
}

.session__send {
  min-height: 34px;
  padding: 8px 18px;
  font-size: 13px;
  background: var(--stark-lime);
  color: var(--stark-lime-text);
  border: 1px solid transparent;
}

.session__send:disabled {
  background: var(--stark-elevated);
  color: var(--stark-text-dim);
  border-color: var(--stark-border);
  opacity: 1;
}

.session__composer-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--stark-space-xs);
  min-width: 0;
}

.session__hint {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--stark-text-dim);
}
```

### `session.css` part 3/3: context drawer, cards, settings, fields

```css
/* Explicit attached context: visible chips above the composer. */
.session__context {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  padding: var(--stark-space-sm);
  border-top: 1px solid var(--stark-border);
  background: var(--stark-surface);
  max-height: 40%;
  overflow-y: auto;
  min-height: 0;
}

.session__context-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--stark-space-xs);
}

.session__context-list {
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.session__note-form {
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
}

.session__sent-context {
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  margin-top: var(--stark-space-xs);
}

.context-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--stark-space-xs) var(--stark-space-sm);
  background: var(--stark-bg);
  border: none;
  border-radius: var(--stark-radius-sm);
  min-width: 0;
}

.context-card__row {
  display: flex;
  align-items: center;
  gap: var(--stark-space-xs);
  min-width: 0;
}

.context-card__label {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--stark-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.context-card__detail {
  margin: 0;
  font-size: 11px;
  color: var(--stark-text-dim);
}

.context-card__preview {
  margin: var(--stark-space-xs) 0 0;
  padding: var(--stark-space-xs) var(--stark-space-sm);
  font-family: var(--stark-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--stark-text);
  background: var(--stark-surface);
  border: none;
  border-radius: var(--stark-radius-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow-y: auto;
}

.session__settings {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  padding: var(--stark-space-sm);
  border-bottom: 1px solid var(--stark-border);
  background: var(--stark-bg);
  min-width: 0;
}

.session__settings-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--stark-space-xs);
  min-width: 0;
}

.session__provider-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--stark-text);
}

.session__field {
  flex: 1;
  min-width: 0;
  padding: var(--stark-space-xs) var(--stark-space-sm);
  font: inherit;
  font-size: 13px;
  color: var(--stark-text);
  background: var(--stark-bg);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
}

.session__field:focus-visible {
  outline: 2px solid var(--stark-accent);
  outline-offset: 1px;
}

.session__generation-error {
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  align-items: flex-start;
}

@media (max-width: 1500px) {
  .session__composer {
    margin: var(--stark-space-xs) var(--stark-space-sm) var(--stark-space-sm);
  }
}
```

### `src/renderer/src/features/explorer/Explorer.css` (515 lines, verbatim, part 1/3: grid, rail, sidebar, editor shells)

```css
/* Primary work area grid: rail | contextual sidebar | canvas,
   with the terminal drawer spanning the bottom row. */
.workbench {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    "rail sidebar canvas"
    "drawer drawer drawer";
  gap: 8px;
  padding: 8px;
  overflow: hidden;
  background: var(--stark-bg);
  text-align: left;
}

.activity-rail {
  grid-area: rail;
  width: 48px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.workbench__sidebar {
  grid-area: sidebar;
  width: 264px;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--stark-surface);
  border: 1px solid var(--stark-border);
  border-radius: 12px;
}

.workbench__sidebar > .workspace--compact {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: var(--stark-space-sm) var(--stark-space-sm) var(--stark-space-xs);
  gap: var(--stark-space-xs);
}

/* Rail tabs fill the slim activity column. */
.workbench__tabs {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px;
  border: none;
  background: transparent;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}

.workbench__tabs::-webkit-scrollbar {
  display: none;
}

.workbench__sidebar-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: var(--stark-space-sm);
}

.workbench__editor {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--stark-bg);
}

.workbench__editor-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.workbench__editor-main {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-canvas {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: var(--stark-space-sm) var(--stark-space-md) var(--stark-space-md);
}

.editor-canvas .code-editor__frame {
  flex: 1;
  min-height: 0;
  min-width: 0;
}
```

### `Explorer.css` part 2/3: rail tabs, tree rows, attach, names, buttons

```css
.explorer__tab {
  flex: 0 0 auto;
  min-width: 0;
  width: 100%;
  min-height: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 6px 2px;
  font-family: var(--stark-font-sans);
  color: var(--stark-text-dim);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  touch-action: manipulation;
}

.explorer__tab-icon {
  font-size: 15px;
  line-height: 1;
  color: inherit;
}

.explorer__tab-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.2;
  white-space: nowrap;
}

.explorer__tab:hover:not(.explorer__tab--active) {
  color: var(--stark-text);
  background: var(--stark-elevated);
}

.explorer__tab--active {
  color: var(--stark-lime);
  background: var(--stark-lime-dim);
  border-color: transparent;
  position: relative;
}

.explorer__tab--active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: var(--stark-lime);
}

.explorer__tab--active .explorer__tab-icon {
  color: inherit;
}

.explorer__tab:focus-visible {
  outline: 2px solid var(--stark-accent);
  outline-offset: 2px;
}

.explorer__branch {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.explorer__children {
  padding-left: var(--stark-space-md);
}

.explorer__row {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: var(--stark-space-sm);
  padding: 3px var(--stark-space-sm);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--stark-radius-sm);
  color: var(--stark-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

button.explorer__row:hover {
  background: var(--stark-elevated);
}

.explorer__row--static {
  cursor: default;
}

/* File row with an explicit attach action beside the opener. */
.explorer__file-row {
  display: flex;
  align-items: center;
  gap: var(--stark-space-xs);
  min-width: 0;
}

.explorer__file-row .explorer__row--file {
  flex: 1;
  min-width: 0;
}

.explorer__attach {
  flex: 0 0 auto;
  min-height: 22px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--stark-text-dim);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  touch-action: manipulation;
}

button.explorer__attach:hover {
  color: var(--stark-accent);
  background: var(--stark-accent-dim);
}

.explorer__attach:focus-visible {
  outline: 2px solid var(--stark-accent);
  outline-offset: 2px;
}

.explorer__chevron {
  display: inline-block;
  width: 1.2em;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--stark-text-dim);
}

.explorer__name {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--stark-font-sans);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.explorer__badge {
  margin-left: var(--stark-space-xs);
  padding: 1px var(--stark-space-sm);
  font-family: var(--stark-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--stark-text-dim);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-pill);
}

.explorer__status {
  margin: 0;
  font-family: var(--stark-font-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--stark-text-dim);
}

.explorer__status--centered {
  margin: auto;
  text-align: center;
  padding: var(--stark-space-lg);
}

.explorer__error {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--stark-danger);
}

.explorer__inline-alert {
  flex: 0 0 auto;
  padding: var(--stark-space-xs) var(--stark-space-md);
  border-bottom: 1px solid var(--stark-border);
  background: var(--stark-surface);
}

.explorer__primary {
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

.explorer__primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.explorer__secondary {
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
```

### `Explorer.css` part 3/3: breakpoints, canvas card, canvas tabs, views, drawer

```css
@media (max-width: 1500px) {
  .workbench__sidebar {
    flex-basis: 248px;
    width: 248px;
  }
}

@media (max-width: 1280px) {
  .workbench__sidebar {
    flex-basis: 232px;
    width: 232px;
  }
}

@media (max-width: 900px) {
  .workbench__sidebar {
    flex-basis: 216px;
    width: 216px;
  }
}

/* Primary canvas: the dominant rounded surface (Session | Editor). */
.primary-canvas {
  grid-area: canvas;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--stark-surface);
  border: 1px solid var(--stark-border);
  border-radius: 14px;
}

.canvas-tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 8px 12px 0;
}

.canvas-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px 12px;
  font-family: var(--stark-font-sans);
  font-size: 12px;
  font-weight: 700;
  color: var(--stark-text-dim);
  background: transparent;
  border: none;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  touch-action: manipulation;
  white-space: nowrap;
}

.canvas-tab:hover {
  color: var(--stark-text);
  background: var(--stark-elevated);
}

.canvas-tab__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
  flex: 0 0 auto;
}

.canvas-tab--active {
  color: var(--stark-text);
}

.canvas-tab--session.canvas-tab--active .canvas-tab__dot {
  background: var(--stark-magenta);
  opacity: 1;
}

.canvas-tab--editor.canvas-tab--active .canvas-tab__dot {
  background: var(--stark-lime);
  opacity: 1;
}

.canvas-view {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 8px 12px 12px;
}

.canvas-view[hidden] {
  display: none;
}

.canvas-view > .session {
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.canvas-view > .workbench__editor {
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/* Docked terminal drawer: a 32px handle when closed. */
.bottom-drawer {
  grid-area: drawer;
  min-width: 0;
}

.bottom-drawer__handle {
  width: 100%;
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--stark-space-xs);
  font-family: var(--stark-font-sans);
  font-size: 12px;
  font-weight: 700;
  color: var(--stark-text-dim);
  background: var(--stark-surface);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  touch-action: manipulation;
}

.bottom-drawer__handle:hover {
  color: var(--stark-text);
}

.bottom-drawer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--stark-space-sm);
  min-height: 32px;
  padding: 0 var(--stark-space-md);
}

.bottom-drawer__label {
  font-family: var(--stark-font-sans);
  font-size: 12px;
  font-weight: 700;
  color: var(--stark-text-dim);
}

.bottom-drawer .terminal {
  border: 1px solid var(--stark-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--stark-surface);
}
```

### `src/renderer/src/features/terminal/TerminalPanel.css` (verbatim)

```css
.terminal {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-top: 1px solid var(--stark-border);
  background: transparent;
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

.terminal__viewport {
  flex: 0 0 auto;
  height: 200px;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  padding: 0 var(--stark-space-md) var(--stark-space-md);
  background: var(--stark-bg);
}

.terminal__xterm {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: #0a0c0a;
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
}

.terminal__xterm .xterm {
  height: 100%;
  padding: 4px 8px;
}
```

### `src/renderer/src/features/editor/editor.css` (verbatim)

```css
.code-editor__frame {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  height: auto;
  overflow: hidden;
  background: var(--stark-surface);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
  touch-action: auto;
}

.code-editor__frame:focus-visible {
  outline: 2px solid var(--stark-accent);
  outline-offset: 2px;
}

.code-editor__fallback {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--stark-space-xs);
  overflow: auto;
}

.code-editor__status {
  margin: 0;
  font-family: var(--stark-font-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--stark-text-dim);
}

.code-editor__plain {
  margin: 0;
  padding: var(--stark-space-md);
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: var(--stark-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
  color: var(--stark-text);
  background: var(--stark-surface);
  border: 1px solid var(--stark-border);
  border-radius: var(--stark-radius-sm);
}

.editor-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--stark-space-sm);
  min-height: 44px;
  padding: var(--stark-space-sm) var(--stark-space-md);
  border-bottom: 1px solid var(--stark-border);
  background: var(--stark-surface);
}

.editor-toolbar__identity {
  display: flex;
  align-items: baseline;
  gap: var(--stark-space-sm);
  min-width: 0;
  flex: 1;
}

.editor-toolbar__path {
  font-family: var(--stark-font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--stark-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.editor-toolbar__status {
  font-family: var(--stark-font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--stark-text-dim);
  white-space: nowrap;
  flex-shrink: 0;
}

.editor-toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--stark-space-xs);
  flex-shrink: 0;
  min-width: 0;
}

/* Branded editor empty state: two-color mark, title, one helper line. */
.editor-empty {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--stark-space-sm);
  padding: var(--stark-space-2xl) var(--stark-space-lg);
  text-align: center;
  min-width: 0;
  max-width: 420px;
}

.editor-empty .stark-mark--hero {
  margin-bottom: var(--stark-space-xs);
}

.editor-empty__brand {
  margin: 0;
  font-family: var(--stark-font-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.35em;
  text-indent: 0.35em;
  color: var(--stark-text);
}

.editor-empty__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--stark-text);
}

.editor-empty__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--stark-text-dim);
}
```

### `src/renderer/src/components/StarkMark.tsx` + `.css` (verbatim)

```tsx
import type { ReactElement } from 'react'
import './StarkMark.css'

interface StarkMarkProps {
  /** Official emblem asset slot (e.g. a bundled SVG once provided). */
  readonly src?: string
  readonly size?: 'bar' | 'hero'
  readonly label?: string
}

/**
 * STARK emblem slot.
 *
 * Renders the official emblem asset when `src` is provided; until the
 * official logo asset lands in the repository it renders a faithful
 * CSS representation (lime block, magenta core) as a temporary
 * stand-in. Never invents a different emblem.
 */
export function StarkMark({ src, size = 'bar', label = 'STARK' }: StarkMarkProps): ReactElement {
  return (
    <span className={`stark-mark stark-mark--${size}`} role="img" aria-label={label}>
      {src !== undefined && src !== '' ? (
        <img className="stark-mark__asset" src={src} alt="" aria-hidden="true" />
      ) : (
        <span className="stark-mark__fallback" aria-hidden="true" />
      )}
    </span>
  )
}
```

```css
.stark-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.stark-mark__asset {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* Temporary faithful stand-in: lime block carrying the magenta core. */
.stark-mark__fallback {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 25%;
  background: var(--stark-lime);
}

.stark-mark--bar {
  width: 12px;
  height: 12px;
}

.stark-mark--bar .stark-mark__fallback {
  box-shadow: inset -4px -4px 0 0 var(--stark-magenta);
}

.stark-mark--hero {
  width: 28px;
  height: 28px;
}

.stark-mark--hero .stark-mark__fallback {
  box-shadow: inset -9px -9px 0 0 var(--stark-magenta);
}
```

### `src/renderer/src/styles/global.css` (verbatim, 197 lines)

Global reset + tokens import + body + selection + `:focus-visible`
(2px lime outline) + unified button system + dark scrollbars +
`prefers-reduced-motion` kill-switch. NOTE for redesign: legacy
per-class button rules still exist in `Explorer.css`
(`.explorer__primary/.explorer__secondary`), `TerminalPanel.css`
(`.terminal__primary/.terminal__secondary`) and
`WorkspaceSection.css`; those files load after `global.css`, so on
ties (single-class specificity) the legacy padding/font rules win
while the global `min-height: 30px`, `touch-action`, transitions,
`aria-pressed` and `:disabled` rules still apply.

```css
@import './tokens.css';

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background: var(--stark-bg);
  color: var(--stark-text);
  font-family: var(--stark-font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

::selection {
  background: var(--stark-accent-dim);
}

:focus-visible {
  outline: 2px solid var(--stark-accent);
  outline-offset: 2px;
}

/**
 * STARK unified button system (visual polish only). (See file header
 * comment in source: one 30px metric set; .stark-btn covers unclassed
 * profile/account controls.)
 */
.stark-btn,
.explorer__primary,
.explorer__secondary,
.terminal__primary,
.terminal__secondary,
.workspace__secondary,
.onboarding__continue,
.boot__retry {
  min-height: 30px;
  padding: 6px 12px;
  font-family: var(--stark-font-sans);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 0.02em;
  border-radius: var(--stark-radius-sm);
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
}

.stark-btn--primary,
.explorer__primary,
.terminal__primary,
.onboarding__continue,
.boot__retry {
  color: var(--stark-accent-text);
  background: var(--stark-accent);
  border: 1px solid transparent;
}

.stark-btn--primary:hover:not(:disabled),
.explorer__primary:hover:not(:disabled),
.terminal__primary:hover:not(:disabled),
.onboarding__continue:hover:not(:disabled),
.boot__retry:hover:not(:disabled) {
  filter: brightness(1.08);
}

.stark-btn--secondary,
.explorer__secondary,
.terminal__secondary,
.workspace__secondary {
  color: var(--stark-text);
  background: var(--stark-elevated);
  border: 1px solid transparent;
  white-space: nowrap;
}

.stark-btn--secondary:hover:not(:disabled),
.explorer__secondary:hover:not(:disabled),
.terminal__secondary:hover:not(:disabled),
.workspace__secondary:hover:not(:disabled) {
  border-color: var(--stark-accent);
  color: var(--stark-accent);
  background: var(--stark-accent-dim);
}

.stark-btn--danger {
  color: var(--stark-danger);
  background: transparent;
  border: 1px solid var(--stark-danger);
  white-space: nowrap;
}

.stark-btn--danger:hover:not(:disabled) {
  background: var(--stark-danger);
  color: var(--stark-accent-text);
}

.stark-btn--ghost {
  color: var(--stark-text-dim);
  background: transparent;
  border: 1px solid transparent;
  white-space: nowrap;
}

.stark-btn--ghost:hover:not(:disabled) {
  color: var(--stark-text);
  border-color: var(--stark-border);
}

.stark-btn:active:not(:disabled),
.explorer__primary:active:not(:disabled),
.explorer__secondary:active:not(:disabled),
.terminal__primary:active:not(:disabled),
.terminal__secondary:active:not(:disabled),
.workspace__secondary:active:not(:disabled),
.onboarding__continue:active:not(:disabled) {
  transform: translateY(1px);
}

.stark-btn:disabled,
.explorer__primary:disabled,
.explorer__secondary:disabled,
.terminal__primary:disabled,
.terminal__secondary:disabled,
.workspace__secondary:disabled,
.onboarding__continue:disabled,
.boot__retry:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Selected toggle state (mode selectors, capability modes): lime-dim
   fill with a lime edge — touch-visible without hover. */
.explorer__secondary[aria-pressed="true"],
.terminal__secondary[aria-pressed="true"] {
  color: var(--stark-accent);
  background: var(--stark-accent-dim);
  border-color: var(--stark-accent);
}

/* Restrained dark workbench scrollbars: thin, neutral track, muted
   thumb with a brighter hover. Never the bright native OS scrollbar. */
* {
  scrollbar-width: thin;
  scrollbar-color: #2c352e transparent;
}

*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

*::-webkit-scrollbar-track {
  background: transparent;
}

*::-webkit-scrollbar-thumb {
  background: #2c352e;
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: content-box;
}

*::-webkit-scrollbar-thumb:hover {
  background: #3d4a40;
  border: 2px solid transparent;
  background-clip: content-box;
}

*::-webkit-scrollbar-corner {
  background: transparent;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

## 7. FULL CODE: IMPORTANT CHILD COMPONENTS

### `src/renderer/src/features/workspace/WorkspaceSection.tsx` (verbatim, 137 lines)

```tsx
import type { ReactElement } from 'react'
import { useApp } from '../../app/app-context'
import { confirmDiscardUnsavedDraft } from '../explorer/editor-guard'
import {
  closeActiveTerminalForSwitch,
  confirmCloseTerminalAndSwitch,
  hasActiveTerminal
} from '../terminal/terminal-guard'
import './WorkspaceSection.css'

/**
 * Workspace state for the main shell: open-folder action, current
 * workspace display, and the recent list. No file tree, no scanning —
 * display names and stored paths only. Switching workspaces shares the
 * Explorer editor's discard guard and the terminal switch guard: a
 * declined confirmation keeps the current workspace (and its dirty
 * draft / running terminal) in place. An accepted terminal prompt
 * kills the session with bounded cleanup before switching, and no
 * terminal is ever re-created automatically in the new workspace.
 */
export function WorkspaceSection(): ReactElement {
  const { workspace } = useApp()

  if (workspace.loading) {
    return (
      <section className="workspace" aria-label="Workspace">
        <p className="workspace__status" role="status">
          Loading workspaces…
        </p>
      </section>
    )
  }

  const others = workspace.recent.filter((entry) => entry.id !== workspace.current?.id)
  const busy = workspace.choosing || workspace.openingId !== null

  function handleChooseWorkspace(): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    if (hasActiveTerminal() && !confirmCloseTerminalAndSwitch()) {
      return
    }
    void (async () => {
      await closeActiveTerminalForSwitch()
      await workspace.chooseWorkspace()
    })()
  }

  function handleOpenWorkspace(workspaceId: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    if (hasActiveTerminal() && !confirmCloseTerminalAndSwitch()) {
      return
    }
    void (async () => {
      await closeActiveTerminalForSwitch()
      await workspace.openWorkspace(workspaceId)
    })()
  }

  return (
    <section className={workspace.current === null ? 'workspace' : 'workspace workspace--compact'} aria-label="Workspace">
      {workspace.error !== null && (
        <p className="workspace__error" role="alert">
          {workspace.error}
        </p>
      )}
      {workspace.current === null ? (
        <button
          className="workspace__primary"
          type="button"
            onClick={handleChooseWorkspace}
            disabled={workspace.choosing}
        >
          {workspace.choosing ? 'Opening…' : 'Open project folder'}
        </button>
      ) : (
        <div className="workspace__current workspace__current--compact">
          <div className="workspace__identity">
            <p className="workspace__name">{workspace.current.displayName}</p>
            <p className="workspace__path">{workspace.current.rootPath}</p>
          </div>
          <button
            className="workspace__secondary workspace__secondary--compact"
            type="button"
          onClick={handleChooseWorkspace}
            disabled={workspace.choosing}
          >
            {workspace.choosing ? 'Opening…' : 'Open another folder'}
          </button>
        </div>
      )}
      {others.length > 0 &&
        (workspace.current === null ? (
        <div className="workspace__recent">
          <p className="workspace__recent-title">Recent</p>
          <ul className="workspace__recent-list">
            {others.map((entry) => (
              <li key={entry.id}>
                <button
                  className="workspace__recent-item"
                  type="button"
                  onClick={() => handleOpenWorkspace(entry.id)}
                  disabled={busy}
                >
                  <span className="workspace__recent-name">{entry.displayName}</span>
                  <span className="workspace__recent-path">{entry.rootPath}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        ) : (
        <details className="workspace__recent workspace__recent--collapsible">
          <summary className="workspace__recent-toggle">Recent ({others.length})</summary>
          <ul className="workspace__recent-list">
            {others.map((entry) => (
              <li key={entry.id}>
                <button
                  className="workspace__recent-item"
                  type="button"
                  onClick={() => handleOpenWorkspace(entry.id)}
                  disabled={busy}
                >
                  <span className="workspace__recent-name">{entry.displayName}</span>
                  <span className="workspace__recent-path">{entry.rootPath}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
        ))}
    </section>
  )
}
```

(Current `WorkspaceSection.css`: card/`--compact` chrome, sans 16px name,
mono 12px ellipsis path, `workspace__secondary(--compact)`,
recent list/collapsible, recent-item hover. In the sidebar the card
chrome is stripped by `.workbench__sidebar > .workspace--compact` in
`Explorer.css`; identity (name + path) stays visible above the
`Open another folder` switch.)

### `src/renderer/src/features/search/SearchPanel.tsx` (verbatim, 160 lines)

```tsx
import { useReducer, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { WorkspaceSearchMatch } from '../../../../shared/workspace-search/types'
import { searchWorkspace } from '../../lib/stark-api'
import { initialSearchState, searchPanelReducer } from './search-state'
import './SearchPanel.css'

interface SearchPanelProps {
  readonly workspaceId: number
  readonly onSelectResult: (relativePath: string, line: number, column: number) => void
  readonly onAttachResult?: (match: WorkspaceSearchMatch) => void
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t search this project.'
}

/**
 * Human-facing workspace search panel. Explicit submission only (Enter or
 * button) — never on keystroke — calling the typed workspace.search bridge.
 * Results render as plain React text; clicking one reuses the existing
 * workspace-files read flow via onSelectResult. Old requests never
 * overwrite newer ones (request ids). The parent remounts this panel with
 * key={workspaceId} so switching workspaces clears input, options, and
 * results without cascading effects.
 */
export function SearchPanel({ workspaceId, onSelectResult, onAttachResult }: SearchPanelProps): ReactElement {
  const [state, dispatch] = useReducer(searchPanelReducer, workspaceId, (id) => ({
    ...initialSearchState(),
    workspaceId: id
  }))
  const [input, setInput] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const requestIdRef = useRef(0)

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    if (state.loading) {
      return
    }
    if (input.trim().length === 0) {
      return
    }
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const submittedWorkspaceId = workspaceId
    const submittedQuery = input
    const submittedCase = caseSensitive
    dispatch({
      type: 'search-started',
      workspaceId: submittedWorkspaceId,
      query: submittedQuery,
      caseSensitive: submittedCase,
      requestId
    })
    searchWorkspace({ workspaceId: submittedWorkspaceId, query: submittedQuery, caseSensitive: submittedCase }).then(
      (result) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'search-succeeded', workspaceId: result.workspaceId, requestId, result })
      },
      (error: unknown) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'search-failed', workspaceId: submittedWorkspaceId, requestId, message: toErrorMessage(error) })
      }
    )
  }

  function handleSelect(match: WorkspaceSearchMatch): void {
    if (state.workspaceId !== workspaceId) {
      return
    }
    onSelectResult(match.relativePath, match.line, match.column)
  }

  const showEmpty = state.submitted && !state.loading && state.error === null && state.matches.length === 0

  return (
    <section className="search" aria-label="Search">
      <form className="search__form" onSubmit={handleSubmit}>
        <label className="search__label" htmlFor="workspace-search-input">
          Search project
        </label>
        <input
          id="workspace-search-input"
          className="search__input"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="authentication"
          autoComplete="off"
          spellCheck={false}
          disabled={state.loading}
        />
        <label className="search__case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => setCaseSensitive(event.target.checked)}
            disabled={state.loading}
          />
          <span>Case sensitive</span>
        </label>
        <button className="search__submit" type="submit" disabled={state.loading || input.trim().length === 0}>
          {state.loading ? 'Searching…' : 'Search'}
        </button>
      </form>
      {state.loading && (
        <p className="search__status" role="status">
          Searching…
        </p>
      )}
      {state.error !== null && (
        <p className="search__error" role="alert">
          {state.error}
        </p>
      )}
      {!state.loading && state.error === null && state.submitted && state.matches.length > 0 && (
        <p className="search__status" role="status">
          {state.matches.length} {state.matches.length === 1 ? 'match' : 'matches'} in {state.filesMatched}{' '}
          {state.filesMatched === 1 ? 'file' : 'files'}
        </p>
      )}
      {state.truncated && !state.loading && state.error === null && (
        <p className="search__truncated" role="status">
          Results truncated — refine your query for complete results.
        </p>
      )}
      {showEmpty && <p className="search__status">No matches found.</p>}
      {state.matches.length > 0 && (
        <ul className="search__results">
          {state.matches.map((match, index) => (
            <li key={`${match.relativePath}:${match.line}:${match.column}:${String(index)}`} className="search__result-row">
              <button className="search__result" type="button" onClick={() => handleSelect(match)}>
                <span className="search__result-path">{match.relativePath}</span>
                <span className="search__result-location">
                  {match.line}:{match.column}
                </span>
                <span className="search__result-preview">{match.preview}</span>
              </button>
              {onAttachResult !== undefined && (
                <button
                  className="search__attach"
                  type="button"
                  onClick={() => onAttachResult(match)}
                  aria-label={`Attach match in ${match.relativePath} line ${match.line} to chat`}
                  title="Attach excerpt to chat"
                >
                  Attach
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
```

### `src/renderer/src/features/changes/ChangesPanel.tsx` (verbatim, 62 lines)

```tsx
import type { ReactElement } from 'react'
import type { ChangeTransaction } from '../../../../shared/change-transactions/types'
import { statusLabel } from './changes-state'
import './changes.css'

interface ChangesPanelProps {
  readonly history: readonly ChangeTransaction[]
  readonly loading: boolean
  readonly error: string | null
  readonly selectedId: number | null
  readonly onSelect: (transactionId: number) => void
}

function entryTitle(transaction: ChangeTransaction): string {
  const file = transaction.files[0]
  return file?.relativePath ?? `Change #${transaction.id}`
}

/**
 * Minimal per-workspace change history: up to 20 recent transactions,
 * newest first. Selecting an entry opens its review; entries render as
 * plain text. No audit product, no auto-application.
 */
export function ChangesPanel({ history, loading, error, selectedId, onSelect }: ChangesPanelProps): ReactElement {
  return (
    <section className="changes" aria-label="Changes">
      {loading && (
        <p className="changes__status" role="status">
          Loading changes…
        </p>
      )}
      {error !== null && (
        <p className="changes__error" role="alert">
          {error}
        </p>
      )}
      {!loading && error === null && history.length === 0 && (
        <p className="changes__status">No changes yet</p>
      )}
      {history.length > 0 && (
        <ul className="changes__list">
          {history.map((transaction) => (
            <li key={transaction.id} className="changes__item">
              <button
                className={
                  transaction.id === selectedId ? 'changes__row changes__row--active' : 'changes__row'
                }
                type="button"
                aria-current={transaction.id === selectedId}
                onClick={() => onSelect(transaction.id)}
              >
                <span className="changes__name">{entryTitle(transaction)}</span>
                <span className="changes__badge">{statusLabel(transaction.status)}</span>
                <span className="changes__time">{new Date(transaction.createdAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
```

(Related, same directory, not duplicated here: `ChangeSetPanel.tsx`
— grouped sets list above history; `ChangeSetReview.tsx` and
`TransactionReview.tsx` — review surfaces rendered in the editor
column with `EditorToolbar` + Monaco `DiffEditor` + Accept/Reject/
Rollback; styles in `features/changes/changes.css`: `.changes*`,
`.review*` incl. `.review__diff` flex:1.)

### `src/renderer/src/features/git/GitPanel.tsx` (verbatim, 290 lines, part 1/2: fetch + status branches)

```tsx
import { useEffect, useReducer, useRef, type ReactElement } from 'react'
import type { GitFileStatus } from '../../../../shared/git/types'
import { getGitStatus } from '../../lib/git-api'
import { gitPanelReducer, gitStatusLabel, initialGitPanelState } from './git-state'
import './git.css'

interface GitPanelProps {
  readonly workspaceId: number
  readonly onSelectDiff: (relativePath: string, target: 'staged' | 'unstaged') => void
  readonly onOpenFile: (relativePath: string) => void
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t read Git status.'
}

function displayPath(entry: GitFileStatus): string {
  if (entry.originalPath !== null) {
    return `${entry.originalPath} → ${entry.relativePath}`
  }
  return entry.relativePath
}

/**
 * Read-only Git sidebar panel. Fetches explicitly (mount, Refresh,
 * workspace change) — never polls, never watches .git, no timers.
 * Rows are buttons (keyboard/touch accessible, no hover needed) with
 * no mutation controls. Untracked rows offer Open file (existing
 * Stage 6/10 read path via onOpenFile); staged/working rows open a
 * read-only patch via onSelectDiff.
 */
export function GitPanel({ workspaceId, onSelectDiff, onOpenFile }: GitPanelProps): ReactElement {
  const [state, dispatch] = useReducer(gitPanelReducer, workspaceId, (id) => ({
    ...initialGitPanelState(),
    workspaceId: id
  }))
  const requestIdRef = useRef(0)

  function fetchStatus(targetWorkspaceId: number): void {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    dispatch({ type: 'status-loading', workspaceId: targetWorkspaceId, requestId })
    getGitStatus(targetWorkspaceId).then(
      (data) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'status-succeeded', workspaceId: data.kind === 'ready' ? data.workspaceId : targetWorkspaceId, requestId, data })
      },
      (error: unknown) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'status-failed', workspaceId: targetWorkspaceId, requestId, message: toErrorMessage(error) })
      }
    )
  }

  useEffect(() => {
    dispatch({ type: 'workspace-changed', workspaceId })
    requestIdRef.current = 0
    fetchStatus(workspaceId)
    // Fetch once per workspace activation; Refresh re-fetches below.
  }, [workspaceId])

  function handleRefresh(): void {
    if (state.phase === 'loading') {
      return
    }
    fetchStatus(workspaceId)
  }

  if (state.phase === 'loading' || state.phase === 'idle') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
        </div>
        <p className="git-panel__status" role="status">
          Loading Git status…
        </p>
      </section>
    )
  }

  if (state.phase === 'error') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__error" role="alert">
          {state.error ?? 'We couldn’t read Git status.'}
        </p>
      </section>
    )
  }

  const data = state.data
  if (data === null) {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__error" role="alert">
          We couldn’t read Git status.
        </p>
      </section>
    )
  }

  if (data.kind === 'unavailable') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__empty">Git is not available on this system.</p>
      </section>
    )
  }

  if (data.kind === 'not-repository') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__empty">No Git repository detected.</p>
      </section>
    )
  }

  if (data.kind === 'root-mismatch') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__empty">
          This folder is inside a Git repository. Open the repository root as the workspace to use Git integration.
        </p>
      </section>
    )
  }
```

### `GitPanel.tsx` part 2/2: ready branch (branch, groups, rows)

```tsx
  const branchLabel =
    data.branch.kind === 'branch'
      ? (data.branch.name ?? 'Branch')
      : data.branch.kind === 'detached'
        ? `Detached · ${data.branch.head ?? 'unknown'}`
        : 'No commits yet'
  const upstreamLabel =
    data.branch.upstream === null
      ? 'No upstream (local refs only — no network fetch).'
      : `${data.branch.upstream} · ↑ ${String(data.branch.ahead ?? 0)} ↓ ${String(data.branch.behind ?? 0)} (local refs only — no network fetch).`

  const conflicts = data.files.filter((entry) => entry.conflicted)
  const staged = data.files.filter((entry) => !entry.conflicted && entry.staged)
  const working = data.files.filter((entry) => !entry.conflicted && entry.unstaged)
  const untracked = data.files.filter((entry) => !entry.conflicted && entry.untracked)

  return (
    <section className="git-panel" aria-label="Git">
      <div className="git-panel__header">
        <p className="git-panel__title">Git</p>
        <button className="explorer__secondary" type="button" onClick={handleRefresh}>
          Refresh
        </button>
      </div>
      <p className="git-panel__branch">{branchLabel}</p>
      <p className="git-panel__meta">{upstreamLabel}</p>
      {data.clean ? (
        <p className="git-panel__empty">Working tree clean.</p>
      ) : (
        <>
          {conflicts.length > 0 && (
            <>
              <p className="git-panel__group-title">Conflicts</p>
              <ul className="git-panel__list">
                {conflicts.map((entry) => (
                  <li key={`conflict:${entry.relativePath}`}>
                    <span className="git-panel__row" aria-label={`${displayPath(entry)} conflict`}>
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">Conflict</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {staged.length > 0 && (
            <>
              <p className="git-panel__group-title">Staged</p>
              <ul className="git-panel__list">
                {staged.map((entry) => (
                  <li key={`staged:${entry.relativePath}`}>
                    <button
                      className="git-panel__row"
                      type="button"
                      onClick={() => onSelectDiff(entry.relativePath, 'staged')}
                      aria-label={`Staged diff ${displayPath(entry)}`}
                    >
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">
                        {gitStatusLabel({
                          staged: entry.staged,
                          unstaged: entry.unstaged,
                          untracked: entry.untracked,
                          conflicted: entry.conflicted,
                          indexStatus: entry.indexStatus,
                          worktreeStatus: entry.worktreeStatus
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {working.length > 0 && (
            <>
              <p className="git-panel__group-title">Changes</p>
              <ul className="git-panel__list">
                {working.map((entry) => (
                  <li key={`working:${entry.relativePath}`}>
                    <button
                      className="git-panel__row"
                      type="button"
                      onClick={() => onSelectDiff(entry.relativePath, 'unstaged')}
                      aria-label={`Working tree diff ${displayPath(entry)}`}
                    >
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">
                        {gitStatusLabel({
                          staged: entry.staged,
                          unstaged: entry.unstaged,
                          untracked: entry.untracked,
                          conflicted: entry.conflicted,
                          indexStatus: entry.indexStatus,
                          worktreeStatus: entry.worktreeStatus
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {untracked.length > 0 && (
            <>
              <p className="git-panel__group-title">Untracked</p>
              <ul className="git-panel__list">
                {untracked.map((entry) => (
                  <li key={`untracked:${entry.relativePath}`}>
                    <button
                      className="git-panel__row"
                      type="button"
                      onClick={() => onOpenFile(entry.relativePath)}
                      aria-label={`Open untracked file ${displayPath(entry)}`}
                    >
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">Untracked</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
```

### `src/renderer/src/features/editor/EditorToolbar.tsx` (verbatim, 34 lines)

```tsx
import type { ReactElement, ReactNode } from 'react'

interface EditorToolbarProps {
  /** File or change path shown left-aligned; never a host path. */
  readonly path: string
  /** Short state label (e.g. Read-only, Unsaved changes, Pending review). */
  readonly status: string | null
  readonly actions: ReactNode
  readonly statusLabel?: string
}

/**
 * Single editor toolbar for the workbench main pane. Every editor
 * state (read-only, editing, transaction review) renders through
 * this component so the file path is always visible and the primary
 * action (Edit / Review change / Accept) is never below the fold.
 */
export function EditorToolbar({ path, status, actions, statusLabel = 'Editor status' }: EditorToolbarProps): ReactElement {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Editor toolbar">
      <div className="editor-toolbar__identity">
        <span className="editor-toolbar__path" title={path}>
          {path}
        </span>
        {status !== null && (
          <span className="editor-toolbar__status" role="status" aria-label={statusLabel}>
            {status}
          </span>
        )}
      </div>
      <div className="editor-toolbar__actions">{actions}</div>
    </div>
  )
}
```

(Monaco host: `CodeEditor.tsx` props — `documentUri` (synthetic
`inmemory://` URI, remount via `key`), `language`, `initialValue`,
`eol`, `readOnly`, `focusRequest`, `onContentChange`,
`onSelectionChange`, `ariaLabel`; single model per mount, disposed on
unmount; load failure degrades to `.code-editor__plain`.)

### `src/renderer/src/features/profile/ProfileSection.tsx` (verbatim, 79 lines)

```tsx
import { useReducer, type ReactElement } from 'react'
import type { LocalProfile } from '../../../../shared/profile/types'
import { updateLocalDisplayName } from '../../lib/profile-api'
import {
  initialProfileEditorState,
  isProfileDraftSubmittable,
  profileEditorReducer
} from './profile-state'

interface ProfileSectionProps {
  readonly current: LocalProfile | null
  readonly onChanged: (profile: LocalProfile) => void
}

/**
 * Small local Profile setting (Stage 30): "STARK calls you".
 *
 * Edits the LOCAL display preference bounded by the existing Stage 4
 * rules (main validates authoritatively). This is NOT cloud profile
 * editing and is never synchronized to Supabase. Double submits are
 * ignored while a save is in flight.
 */
export function ProfileSection({ current, onChanged }: ProfileSectionProps): ReactElement {
  const [state, dispatch] = useReducer(profileEditorReducer, current, initialProfileEditorState)

  async function handleSave(): Promise<void> {
    if (state.saving || !isProfileDraftSubmittable(state.draft)) {
      return
    }
    dispatch({ type: 'save-started' })
    try {
      const saved = await updateLocalDisplayName(state.draft.trim())
      onChanged(saved)
      dispatch({ type: 'save-succeeded', profile: saved })
    } catch (error: unknown) {
      dispatch({
        type: 'save-failed',
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save your name.'
      })
    }
  }

  if (!state.editing) {
    return (
      <section className="profile-section" aria-label="Local profile">
        <p className="profile-section__line">
          STARK calls you <strong>{state.current?.displayName ?? '…'}</strong>
        </p>
        {state.notice !== null ? <p role="status">{state.notice}</p> : null}
        <button className="stark-btn stark-btn--secondary" type="button" onClick={() => dispatch({ type: 'edit-started' })}>
          Edit name
        </button>
      </section>
    )
  }

  return (
    <section className="profile-section" aria-label="Local profile">
      <label className="profile-section__label" htmlFor="stark-local-name">
        STARK calls you
      </label>
      <input
        id="stark-local-name"
        type="text"
        value={state.draft}
        maxLength={40}
        disabled={state.saving}
        onChange={(event) => dispatch({ type: 'draft-changed', draft: event.target.value })}
      />
      {state.saveError !== null ? <p role="alert">{state.saveError}</p> : null}
      <button className="stark-btn stark-btn--primary" type="button" disabled={state.saving} onClick={() => void handleSave()}>
        {state.saving ? 'Saving…' : 'Save name'}
      </button>
      <button className="stark-btn stark-btn--ghost" type="button" disabled={state.saving} onClick={() => dispatch({ type: 'edit-cancelled' })}>
        Cancel
      </button>
    </section>
  )
}
```

### `src/renderer/src/features/system-status/SystemStatus.tsx` (verbatim, 27 lines)

```tsx
import type { ReactElement } from 'react'
import { SYSTEM_READY_LABEL } from '../../../../shared/constants'
import { StatusIndicator } from '../../components/StatusIndicator'
import { useAppInfo } from '../../hooks/useAppInfo'
import './SystemStatus.css'

/**
 * System-status feature module.
 * Composes the reusable StatusIndicator with live metadata
 * from the main process. Future feature modules (sessions,
 * providers, agents, …) follow this same directory pattern.
 */
export function SystemStatus(): ReactElement {
  const { appInfo } = useAppInfo()
  const ready = appInfo !== null && appInfo.platform !== 'browser'

  return (
    <section className="system-status" aria-label="System status">
      <StatusIndicator status={appInfo === null ? 'starting' : 'ready'} label={ready ? SYSTEM_READY_LABEL : 'Starting…'} />
      {appInfo !== null && (
        <p className="system-status__meta">
          v{appInfo.version} · {appInfo.platform} · Electron {appInfo.electron}
        </p>
      )}
    </section>
  )
}
```

(`SystemStatus.css`: column layout, 8px top margin on welcome card;
overridden to row inside `.workbench-status`. Meta is mono 11px dim.
`StatusIndicator`: `span.status-indicator[data-status]` (dot 8px +
label); ready = lime dot; starting = warning; error = danger; no
pill/border — flat in the strip.)

### `src/renderer/src/features/sessions/ContextCard.tsx` (verbatim, 55 lines)

```tsx
import { useState, type ReactElement } from 'react'

interface ContextCardProps {
  /** Display label (path + lines, or note label). Never a host path. */
  readonly label: string
  /** Secondary detail line, e.g. kind. Null hides the detail. */
  readonly detail: string | null
  /** Exact item content, rendered as inert plain text. */
  readonly content: string
  /** Removable drafts show a Remove button; history items do not. */
  readonly removable: boolean
  readonly onRemove?: () => void
  readonly removeLabel?: string
}

/**
 * One visible context attachment: label, kind detail, preview toggle,
 * and optional remove. Content renders as plain pre-wrapped text —
 * never HTML. Preview defaults collapsed so long files stay compact;
 * the toggle is a real button (keyboard/touch accessible, never
 * hover-only).
 */
export function ContextCard({ label, detail, content, removable, onRemove, removeLabel = 'Remove' }: ContextCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="context-card">
      <div className="context-card__row">
        <span className="context-card__label" title={label}>
          {label}
        </span>
        <button
          className="explorer__secondary"
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} context preview for ${label}`}
        >
          {expanded ? 'Hide' : 'Preview'}
        </button>
        {removable && onRemove !== undefined && (
          <button
            className="explorer__secondary"
            type="button"
            onClick={onRemove}
            aria-label={`${removeLabel} ${label}`}
          >
            {removeLabel}
          </button>
        )}
      </div>
      {detail !== null && <p className="context-card__detail">{detail}</p>}
      {expanded && <pre className="context-card__preview">{content}</pre>}
    </div>
  )
}
```

### `src/renderer/src/components/StatusIndicator.tsx` (verbatim, 21 lines)

```tsx
import type { ReactElement } from 'react'
import type { SystemStatus as SystemStatusKind } from '../../../shared/types'
import './StatusIndicator.css'

interface StatusIndicatorProps {
  readonly status: SystemStatusKind
  readonly label: string
}

/**
 * Reusable status pill: colored pulse dot plus a short label.
 * Belongs to the shared component layer, not to any single feature.
 */
export function StatusIndicator({ status, label }: StatusIndicatorProps): ReactElement {
  return (
    <span className="status-indicator" data-status={status} role="status">
      <span className="status-indicator__dot" aria-hidden="true" />
      <span className="status-indicator__label">{label}</span>
    </span>
  )
}
```

(Related API surface the redesign must reuse — `src/renderer/src/lib/`,
one typed module per domain over `window.stark` e.g.
`sessions-api`, `providers-api`, `heart-api`, `recovery-api`,
`usage-api`, `capabilities-api`, `runtimes-api`, `looplink-api`,
`worker-tools-api`, `terminal-api`, `git-api`, `changes-api`,
`change-sets-api`, `orchestration-api`, `session-context-api`,
`account-api`, `profile-api`.)

## 8. SESSIONPANEL BREAKDOWN

`section.session` (flex column, no own background; canvas gives surface).
Render order is fixed; most blocks are conditional.

| Section | Function / handler | CSS selector | Render condition | State | Approx size |
|---------|-------------------|--------------|------------------|-------|-------------|
| Header | title = selected session or `No session`; `handleNew` | `.session__header`, `__eyebrow`, `__title` | Always | `selectedSession` | One wrapped row |
| New | `handleNew` → `createCodingSession`, clears composer, focuses it | `button.explorer__primary.session__new` | Always (disabled while loading) | `state.loadingSessions` | 30px button |
| `···` menu | native `<details>` | `.session__menu(-toggle,-body)` | Always (popup) | Uncontrolled DOM | 220–280px dropdown |
| Settings (in menu) | `setSettingsOpen` toggle | same row | Always | `settingsOpen` | One row |
| History (in menu) | `handleSelect` | `.session__menu-history`, `#session-history-select.session__select` | `sessions.length > 0` | `selectedSessionId` | One labeled select |
| Looplink | `handleContinueWithLooplink` → `createSessionContinuation` (zero provider calls) | `.session__looplink` (own quiet row) | Always (disabled without selection/while acting/sending) | `looplink.acting` | One dim text row |
| Message list | `ul.session__list`, `Load older messages` → `handleLoadOlder` | `.session__messages` (scroll), `.session__message` (+`--assistant`), `__role/__content/__time` | Sessions exist | `state.messages`, `hasMore` | Dominant region, 880px measure |
| User messages | `roleLabel` = `YOU`, elevated bg | `.session__message` | Per message | — | Bubble |
| STARK messages | `roleLabel` = `STARK`, surface bg + 2px magenta edge + magenta role | `.session__message--assistant` | Per assistant message | — | Bubble |
| Tool messages | Work steps inline in `Work run details`; worker output in non-removable `ContextCard` | `.session__generation-error`, `.session__context-list` | `work.run !== null` | `work` reducer | Collapsible with run |
| Approvals | `handleApprovalDecision` → approve/deny + resume; exact summary + per-tool safety copy | `div[aria-label="Worker approval"].session__recovery`, Deny / `Approve approval` | `pendingApproval !== null` | `pendingApproval`, `approvalActing` | Card above conversation |
| Heart | `handleSaveHeart`; Fixed vs Auto-Swap `aria-pressed` + brain/worker/default/per-profile model fields | Inside `.session__settings` | `settingsOpen` | `heart` reducer | ~15 rows when open |
| Recovery | `handleSaveRecovery`; Off/Handoff/Auto-once + ask/brain/worker models | Inside `.session__settings` | `settingsOpen` | `recovery` reducer | ~10 rows |
| Runtime | `handleStopRuntime` / `handleOpenPreview` / `handleReloadPreview`; stdout/stderr tails; observation `<details>`; recent list | `div[aria-label="Project runtime"].session__recovery` | `runtime.active \|\| history` | `runtime` reducer + main-pushed updates | Card, grows with logs |
| Usage | `refreshUsageSummary`, limits add/edit/remove, alternates, `handleSaveUsage` | Inside `.session__settings` | `settingsOpen` | `usage` reducer | Largest config block |
| Permissions | enable toggle, per-capability Deny/Ask/Allow, `handleSaveCapabilities` | Inside `.session__settings` | `settingsOpen` | `capabilities` reducer | ~8 rows |
| Account UI | None inside SessionPanel (account lives in `AccountSection`, rendered elsewhere) | — | — | — | — |
| Attached context | `handleRemoveDraft`, `handleAddNote` (`prepareContextNote`), note form | `.session__context`, `ContextCard`, `.session__note-form` | Always (body collapses via `contextOpen`) | drafts (HomePage), `noteOpen/Text` | ≤40% height, own scroll |
| Composer | `handleSend` → Ask/Work/Propose fan-out; Enter-to-send | `.session__composer(--ask/--work/--propose)` | Always (at bottom) | `composer`, `proposal.mode` | 12px dock |
| Ask/Work/Propose | `handleProposalMode`; `aria-pressed`; Work magenta, Ask lime, Propose neutral | `.session__mode(--ask/--work/--propose)` | Always | `proposal.mode` | 26px segmented |
| Send | `handleSend`, disabled matrix (`sendDisabled`) | `.session__send` (lime) | Always | sending/preparing/eligibility | 34px, docked right |

## 9. EXPLORER BREAKDOWN

- Rail: `ActivityRail` vertically stacks 4 tab buttons; `onSelect` sets HomePage `activity`; sidebar body switches on it. Selected = lime text/wash + 2px bar. Rail is 48px; body 264px.
- Switching: review handoffs call `onActivityChange('changes')` (+ canvas to editor); `handleOpenGitFile` forces `'explorer'`.
- Workspace name: `WorkspaceSection` compact head of sidebar (sans 16px name, mono 12px ellipsis path, `Open another folder` secondary-compact, collapsible `Recent (n)` details). Full path never a row: tooltip/`title` only.
- Open another folder: native OS picker via main; guarded by discard + terminal-switch confirms.
- Recent: `<details>` collapsible when workspace active; full list on welcome card.
- Tree: `TreeNode` recursive `ul.explorer__branch`; per-dir lazy load on expand (`loadDirectory`); generated dirs hidden server-side; symlinks render static `link` pill, never traversed.
- Attach: per-file 22px `Attach` button (aria-label includes path); preview `Attach selection` (needs Monaco selection) / `Attach file`; search-result `Attach`. Each performs exactly one bounded prepare call.
- Selected file: click dispatches `file-selected`, clears editor/focus/selection, closes reviews, reads via bridge; also switches canvas to Editor.
- Scroll: sidebar body is the only scroll container (`overflow: auto`, dark thin scrollbars); tree itself is normal flow.
- Ellipsis: `.explorer__name` nowrap + ellipsis + `min-width: 0` inside flex row with fixed Attach action — filenames cannot wrap.
- Sidebar collapse: `{sidebarOpen && <aside>}` — whole pane unmounts; grid column collapses; toggle in AppChrome.

## 10. EDITOR BREAKDOWN

- Monaco container: `CodeEditor` mounts one model+editor per `documentUri` (`inmemory://stark-workspace/…`, never host paths), `key` includes workspace+path+revision; unmount disposes both; load failure → `.code-editor__plain` fallback. Must remain: single active document, EOL pinning, read-only preview vs editable modes.
- File title: `EditorToolbar` mono 13px bold ellipsis path + mono 11px status + actions; never below the fold.
- Read-only/edit: preview (`readOnly`, selection tracked) vs editing (`EditorState` draft, dirty flag, shared discard guard).
- Edit: `handleEdit` (blocked for mixed-EOL) → `Review change` (creates pending transaction, disk untouched) / Cancel (reloads disk).
- Attach selection/file: preview-only actions, need revision + selection.
- Review/diff: `TransactionReview` (Accept/Reject/Rollback), `ChangeSetReview` (per-file review, no Accept-All), `GitDiffViewer` (read-only patch); all reuse `EditorToolbar`.
- Empty state: `.editor-empty` — StarkMark hero + STARK + `Select a file to open` + helper; centered, max 420px; disappears entirely once Monaco mounts.

## 11. TERMINAL BREAKDOWN

- Collapsed drawer: `button.bottom-drawer__handle` (32px, full drawer width, `⌁ Terminal`, `aria-expanded=false`) → calls `onToggleTerminal` (HomePage state).
- Expanded drawer: `.bottom-drawer__bar` (label + ghost Hide) + `TerminalPanel` (`key=terminal:{workspaceId}`).
- Start: `terminal__primary` Start (per status) → `api.create({workspaceId, cols, rows})`; xterm 13px JetBrains Mono, lime cursor, 5000-line scrollback, FitAddon + rAF-debounced resize via `terminal:resize`.
- Active: shell label (lime mono) / `Starting…` / `Terminal exited`; Clear (display-only), Kill (exact session only), Close (kills + disposes).
- Toolbar: `terminal__bar` wrap row: identity left, actions right (Start | Clear+Kill | Start+Close by status).
- Parent: `.bottom-drawer` is a grid item (`grid-area: drawer`, spans all 3 columns, `auto` row). Renderer constraints a redesign must keep: explicit Start only, no auto-spawn, workspace-scoped sessions reset on switch (`key` + `workspace-changed`), no agent path (no `runCommand` anywhere).

## 12. RESPONSIVE BEHAVIOR

Exact media queries in the renderer (only 5 exist — everything else is
fluid flex/grid with `min-width: 0` + ellipsis + wrapping toolbars):

- `Explorer.css`: `≤1500px` sidebar 248px; `≤1280px` sidebar 232px;
  `≤900px` sidebar 216px. Rail stays 48px at all widths (never
  truncates). Canvas is `minmax(0,1fr)` — it absorbs all change.
- `session.css`: `≤1500px` composer margins tighten.
- `global.css`: `prefers-reduced-motion` disables transitions.

Resulting behavior (no other breakpoints; panes collapse only by user
toggle, never automatically):

| Width | Rail | Sidebar | Canvas | Session | Terminal | Top bar | Composer |
|-------|------|---------|--------|---------|----------|---------|----------|
| 1920×1080 | 48 | 264 (toggleable) | ≈1600 minus gaps | 880 measure centered | drawer row | one row, full path tooltip | docked, wide |
| 1440×900 | 48 | 248 | ≈1100 | 880 centered | drawer row | crumb ellipsizes | docked |
| 1366×768 | 48 | 232 (toggleable) | ≈1000 | list fits, context `max-height: 40%` scrolls | drawer row | crumb + toggles fit; toolbars wrap | docked, wraps |
| <1280 | 48 | 232→216, user-collapsible | flexes, min 0 | header/composer rows wrap; menu dropdown (220–280px) may overlay | drawer row | identity ellipsizes; controls persist | rows wrap |

No horizontal page overflow at any width (grid + `overflow: hidden`
roots). Sidebar/drawer/context are user-collapsible, so narrow
widths never force three squeezed columns.

## 13. CURRENT VISUAL PROBLEMS (observed, unfixed — do not fix here)

A. Hierarchy: canvas tabs + session header + rail compete; settings
   block is a long stacked form inside the conversation column.
B. Spacing: session column mixes 8px gaps with full-bleed sections;
   composer margin (8px) differs from canvas padding (8/12/12).
C. Typography: mono still dominates status/meta/toolbar labels;
   eyebrows are all-caps everywhere.
D. Navigation: rail icons are unicode glyphs (▤⌕⇄⎇), not drawn icons;
   canvas Session/Editor tabs duplicate the rail concept at small size.
E. Conversation UX: approvals/recovery/runtime cards sit above
   messages and push the conversation down; no unread/pending badge
   when backgrounded on the Editor tab.
F. Composer UX: single textarea, no attachment preview inside the
   dock; mode hint paragraph consumes dock space.
G. Explorer UX: 22px Attach always visible per file row; tree has no
   file-type icons; symlink rows are dead weight visually.
H. Editor UX: toolbar path + status + 3 actions crowd narrow canvas;
   diff viewer inherits generic canvas padding.
I. Terminal UX: open drawer always reserves 200px + bar even for
   quick commands; no per-command history UI.
J. Branding: magenta appears only in small accents; lime dominates
   all primary actions; wordmark repeats in chrome.
K. Responsiveness: no automatic narrow-width behavior — a 900px
   window with all panes open squeezes the canvas to ~550px until
   the user collapses panes manually.

## 14. FEATURE PRESERVATION CONTRACT (where each is accessed today)

Explorer (rail → sidebar tree, lazy per-dir load); Search (rail →
explicit-submit form + result rows); Changes (rail → history ≤20 +
sets; review in editor view); Git (rail → status/diff rows, Refresh);
Monaco (editor view; read-only/edit/diff); Edit (read-only toolbar);
review/diff (`TransactionReview`, `ChangeSetReview`, `GitDiffViewer`);
Change Transactions (Accept/Reject/Rollback in review); Change Sets
(per-file review, no Accept-All); Sessions (menu New/History/select);
History (menu select); Ask/Work/Propose (composer modes + Send);
Looplink (header row + continuity section + Dismiss); context
attachments (tree/preview/search Attach → drawer chips + Preview/
Remove); notes (Add note → form → Attach note); AI Settings (menu
Settings → provider/key/models); providers/models (same block);
Heart (Fixed/Auto-Swap + model fields, Save Heart); Recovery (mode +
ask/brain/worker models, Save Recovery; handoff card + Open/Dismiss);
permissions (Enabled + Deny/Ask/Allow, Save permissions); approvals
(approval card Deny/Approve); terminal (drawer handle → Start/Kill/
Clear/Close); runtime (card: Open/Reload/Stop Preview, logs, history);
preview (main-derived URL in isolated window); runtime observation
(card details + `Worker observation details`); preview inspection
(same); usage (24h summary + Refresh, limits, alternates, Save usage
routing); threshold routing (same block); account (Note:
`AccountSection.tsx` exists and is fully functional but is
CURRENTLY NOT MOUNTED anywhere in the renderer — no import of it
outside its own file; the redesign must choose where to surface
Google/GitHub sign-in, Cancel, Sign out); profile (status strip inline editor + welcome card).

## 15. INTERACTION FLOWS (current components/state — must not break)

1. Open file: rail→Explorer → click file row (`handleSelectFile`,
   discard-guard) → `loadPreviewFile` → canvas auto-switches to
   Editor → read-only Monaco (+ `Attach selection/file`).
2. Edit file: read-only toolbar `Edit` (`handleEdit`, blocked for
   mixed EOL) → type → `Review change` (`handleReviewChange` creates
   pending transaction, disk untouched) → review in editor view.
3. Attach file: tree `Attach` / preview `Attach file` / search
   `Attach` / selection `Attach selection` → one bounded prepare call
   → chip in context drawer (Preview/Remove) → sent with next message.
4. Start new Session: header `New` (or `New session` empty state) →
   `handleNew` → `createCodingSession`, composer cleared + focused.
5. Ask: mode Ask → type → Send/Enter → `handleSend` persists message
   (+ drafts) → `runGeneration` appends one real reply or Retry.
6. Work: mode Work → Send → `handleWorkSend` → Brain plan → optional
   Worker (approvals park the run) → synthesis → run details persist.
7. Propose Change: attach exactly one whole file → mode Propose →
   Send → `handleProposeSend` → pending transaction (or Change Set
   for 2–5 files) → `Proposal ready` + Review.
8. Review a proposal: `Review change` → `onReviewTransaction` →
   HomePage sets id + canvas to Editor → Explorer effect opens
   `TransactionReview` → Accept/Reject/Rollback (`handleAccept` etc.).
9. Approve a Worker tool: approval card appears (run parked) →
   read exact summary → Deny (resumes with denied result) or Approve
   (one bounded execution, at-most-once approval).
10. Open terminal: drawer handle (or chrome ⌁) → `TerminalPanel` →
    Start → PTY created with fitted dims.
11. Start runtime: Work `runtime_start` approval → Approve → managed
    process on approved port → card shows command/preview/started.
12. Open Preview: runtime card `Open Preview` → main-derived
    loopback URL in isolated window (Reload available).
13. Open AI Settings: header `···` → Settings → provider/key/models,
    Heart, Recovery, Usage, Permissions blocks.
14. Switch Session: header `···` → History select → `handleSelect` →
    latest 100 messages load, proposal/work state reset per session.
15. Continue with Looplink: header row action →
    `handleContinueWithLooplink` (zero provider calls) → new
    `Continue: …` session selected; first Ask/Work consumes handoff.

## 16. CURRENT CSS SELECTOR INDEX (selector → file → purpose)

Layout shell: `.shell` → `MainLayout.css` (100vh column root);
`.shell__main` → flex fill. `.stage-shell` → `HomePage.css` (column);
`.stage-workarea` → flex row. `.app-chrome*` → `AppChrome.css` (bar,
brand, wordmark, divider, identity, workspace, spacer, controls).
Grid: `.workbench` → `Explorer.css` (3×2 grid);
`.activity-rail` → rail column; `.workbench__tabs` → vertical tab
stack; `.workbench__sidebar` → sidebar card; `.primary-canvas` →
canvas card; `.canvas-tabs`, `.canvas-tab(--active/--session/--editor)`,
`.canvas-tab__dot`, `.canvas-view([hidden])` → views;
`.bottom-drawer(__handle/__bar/__label)` → terminal drawer.
Rail/tabs: `.explorer__tab(--active, ::before indicator, __icon,
__label)`. Tree: `.explorer__branch/__children/__node/__row
(--directory/--file/--static)/__chevron/__name/__file-row/__attach/
__badge/__status(--centered)/__error/__inline-alert`. Legacy buttons:
`.explorer__primary/:disabled`, `.explorer__secondary`.
Sidebar body: `.workbench__sidebar-body`. Editor:
`.workbench__editor(-body/-main)`, `.editor-canvas`,
`.code-editor__frame(/:focus-visible/__fallback/__status/__plain)` →
`editor.css`; `.editor-toolbar(__identity/__path/__status/__actions)`;
`.editor-empty(__brand/__title/__hint)` + `.stark-mark--hero`.
Terminal: `.terminal(__bar/__identity/__title/__shell/__status/
__actions/__primary/__secondary/__error/__viewport/__xterm)` +
`.xterm` (xterm lib).
Session: `.session/__header/__eyebrow/__title/__menu(-toggle/-body/
-history)/__looplink/__notice/__history/__select/__messages/__list/
__message(--assistant)/__role/__content/__time/__status/__error/
__empty(-text)/__recovery/__composer(--ask/--work/--propose,
:focus-within)/__input/__mode(--ask/--work/--propose)/__send(:disabled)/
__composer-row/__hint/__context(-header/-list)/__note-form/
__sent-context/__field/__generation-error/__settings(-row)/
__provider-name` → `session.css`; `.context-card(__row/__label/
__detail/__preview)` (same file).
Chrome buttons: `.stark-btn(--primary/--secondary/--danger/--ghost),
:disabled, :active, [aria-pressed]` → `global.css`; dark scrollbars
(`*::-webkit-scrollbar*`) → `global.css`.
Status: `.workbench-status(__workspace/__divider/__spacer)`,
`.profile-section(__line/__label)`, `.system-status(__meta)`,
`.status-indicator(__dot/__label)` + `[data-status]`.
Workspace: `.workspace(--compact/__status/__error/__primary/
__current(--compact)/__identity/__name/__path/__secondary(--compact)/
__recent(--collapsible)/__recent-title/-toggle/-list/-item/-name/-path)`.
Search: `.search(__form/__label/__input/__case/__submit/__status/
__error/__truncated/__results/__result-row/__result(-path/-location/
-preview)/__attach)`. Changes: `.changes(__status/__error/__list/
__item/__row(--active)/__name/__badge/__time)` + change-set/review
classes (`.changes__pane*`, `.review*`, `.review__diff`).
Git: `.git-panel(__header/__title/__status/__error/__empty/
__branch/__meta/__group-title/__list/__row/__path/__badge)` +
`.git-diff-viewer*`. Onboarding: `.onboarding(__card/__brand/
__question/__form/__label/__input/__error/__continue)`. Welcome:
`.welcome`, `.home(__title/__tagline)`. Emblem:
`.stark-mark(--bar/--hero/__asset/__fallback)`.

## 17. REDESIGN FILE IMPACT MAP (no changes made)

MUST CHANGE (layout-defining): `pages/HomePage.tsx/.css`
(shell composition + state), `features/explorer/Explorer.tsx/.css`
(grid, panes, canvas), `features/explorer/ActivityRail.tsx` (nav),
`layouts/AppChrome.tsx/.css` (bar),
`features/sessions/SessionPanel.tsx` + `session.css` (conversation/
composer/context chrome — logic stays).
LIKELY CHANGE: `features/editor/editor.css`,
`features/terminal/TerminalPanel.css`, `layouts/MainLayout.tsx/.css`
(if chrome moves), `components/StarkMark.*` (only to point `src` at
the real asset), `styles/tokens.css` (only to add steps, never to
recolor brand), `features/workspace/WorkspaceSection.css`,
`features/*/ *.css` for density/spacing.
MAY CHANGE: `SearchPanel/GitPanel/ChangesPanel/EditorToolbar/
ProfileSection/SystemStatus/ContextCard` (only if their chrome is
restyled; behavior untouched), `features/terminal/TerminalPanel.tsx`
(drawer handle already exists — only if bar changes).
DO NOT NEED CHANGE: everything under `src/main/`, `src/preload/`,
`src/shared/`, all `*-state.ts` reducers, all `lib/*-api.ts`
bridges, `editor-setup/document/language/eol/focus/theme`,
`*.test.ts`. Renderer depends on main only through the typed
`window.stark` bridges listed in §7/§18 — no new channel may be
required for a visual redesign.

## 18. BACKEND / SECURITY BOUNDARY (must NOT require changes)

Main process, preload bridge, `window.stark` surface, all IPC
channels (`IPC_CHANNELS` in `src/shared/constants/index.ts` —
~70 channels, renderer invokes only listed ones), SQLite + schema
v18 + migrations, AI/Brain/Worker/Heart/Recovery/Looplink services,
provider credentials (safeStorage ciphertext BLOB only), terminal
exact-approval + at-most-once execution, runtime sandbox + Preview
isolation, OAuth deep-link validation, capability gate, usage
accounting. The redesigned UI must reuse the existing typed
renderer APIs in `src/renderer/src/lib/` (sessions, providers,
heart, recovery, usage, capabilities, runtimes, looplink,
worker-tools, terminal, git, changes, change-sets, orchestration,
session-context, account, profile) with identical call shapes. If a
visual idea needs a new IPC channel, new persisted state, or a
schema change: STOP and report it — it is out of scope.

## 19. CURRENT SCREEN ASCII WIREFRAME (1920×1080, workspace active)

```
┌──────────────────────────────────────────────────────────────────┐
│ ● STARK │ my-project                              [☰] [⌁]       │ 40px chrome
├──┬───────────────┬───────────────────────────────────────────────┤
│  │ WorkspaceSec  │  ( Session ● | Editor ○ )                     │
│R │  MyProject    ├───────────────────────────────────────────────┤
│A │  path…        │                                               │
│I │  [Open anot…] │   STARK conversation (≤880px centered)        │
│L │ ───────────── │   YOU...........  STARK ▏...................  │
│  │ ▸ src         │                                               │
│48│ 📄 index.ts   │   …messages…                                  │
│px│  [Attach]     │                                               │
│  │               │   Attached context (n) [Collapse] [Add note]   │
│  │               │   ┌───────────────────────────────────────┐   │
│  │               │   │ Ask Work Propose │  [Message STARK…]  │   │
│  │               │   │ hint…                            Send │   │
│  │               │   └───────────────────────────────────────┘   │
├──┴───────────────┴───────────────────────────────────────────────┤
│ ⌁ Terminal (32px handle when closed; 32px bar + 200px xterm open) │
├──────────────────────────────────────────────────────────────────┤
│ my-project │ STARK calls you … │  ● System ready  v0.1.0 · …    │ 28px status
└──────────────────────────────────────────────────────────────────┘
   └─264px sidebar─┘         └────── canvas (flexible) ──────┘
```

## 20. SCREENSHOT CORRELATION (screenshot → source)

- Thin top bar with mark + name = `.app-chrome` (`AppChrome.tsx`);
  its bottom edge is `border-bottom: 1px solid var(--stark-border)`.
- 48px far-left icon column = `nav.activity-rail` + `.workbench__tabs`
  (`ActivityRail.tsx`); selected lime bar =
  `.explorer__tab--active::before` in `Explorer.css`.
- ~264px file column = `aside.workbench__sidebar` (grid area
  `sidebar`); workspace head = `WorkspaceSection` compact.
- `Session ● | Editor ○` tab row = `.canvas-tabs` in `Explorer.tsx`
  (magenta vs lime `.canvas-tab__dot`).
- Rounded large panel = `section.primary-canvas` (`border-radius:
  14px`); conversation inside = `SessionPanel` `section.session`.
- Bottom `⌁ Terminal` strip = `button.bottom-drawer__handle`
  (grid area `drawer`); open 200px area = `.terminal__viewport`.
- Bottom 28px line with green workspace name = `.workbench-status`
  (`HomePage.tsx`); version text = `SystemStatus`
  (`v{appInfo.version} · {platform} · Electron {electron}`).
- The 8px gutters between rail/sidebar/canvas/drawer come from
  `.workbench { gap: 8px; padding: 8px; }`.

## 21. Design decisions that require Giorno

1. Conversation and editor: keep the Session|Editor tabbed canvas,
   or place conversation and editor side-by-side?
2. Should Attached Context become a collapsible right inspector
   beside the conversation, or stay a drawer above the composer?
3. Should the terminal overlay the canvas (floating) or stay a
   docked bottom drawer?
4. Should Session History live in the header menu (current), a
   sidebar list, or a command-palette switcher?
5. Desired density: keep the current comfortable 8px/12–13px rhythm,
   or move denser (compact rows) / roomier?
6. May the AI Settings/Heart/Recovery/Usage/Permissions long form
   become a dedicated settings surface (modal/route), or must it
   stay an inline expanding section?
7. Where should the (currently unmounted) Account sign-in surface
   live: chrome menu, sidebar footer, or session menu?

*End of dossier. Production files modified: 0. Schema: v18 unchanged.*




