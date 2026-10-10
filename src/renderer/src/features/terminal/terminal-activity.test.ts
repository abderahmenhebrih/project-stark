import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Terminal activity redesign: the rail Terminal owns its drawer
 * (management surface) while the right workspace stays the live
 * viewport. Multi-terminal PTYs are exact-owned, bounded, and
 * human-only. Static source guarantees (repo pattern) plus pure
 * reducer coverage in terminal-state.test.ts and manager coverage in
 * the main terminal-manager.test.ts. No live PTYs in these tests.
 */

function readSource(...relative: string[]): string {
  const file = join(process.cwd(), 'src', ...relative)
  assert.ok(existsSync(file), `${relative.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function renderer(relative: string): string {
  return readSource('renderer', 'src', ...relative.split('/'))
}

/** Source with line/block comments removed, so negative assertions test code — not prose. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** Slices one function body (up to the next same-level function). */
function functionBody(source: string, marker: string): string {
  const at = source.indexOf(marker)
  assert.ok(at >= 0, `${marker} must exist`)
  const rest = source.slice(at + marker.length)
  const next = rest.search(/\n {2}(?:async )?function /)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('terminal activity owns the drawer', () => {
  it('selecting Terminal renders management, not the Explorer tree', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    const branchAt = explorer.indexOf("activity === 'terminal'")
    assert.ok(branchAt >= 0, 'drawer must branch on the terminal activity')
    const branch = explorer.slice(branchAt, branchAt + 1200)
    assert.ok(branch.includes('<TerminalDrawer'), 'terminal activity must render the management drawer')
    assert.ok(!branch.includes('<TreeNode'), 'terminal drawer must not render the project tree')
    const treeAt = explorer.indexOf("activity === 'explorer'")
    assert.ok(treeAt >= 0 && treeAt < branchAt, 'explorer tree must stay on the explorer activity')
    const treeBranch = explorer.slice(treeAt, treeAt + 400)
    assert.ok(treeBranch.includes('<TreeNode') || explorer.includes('TreeNode path=""'), 'returning to Explorer must restore the tree')
  })

  it('rail Terminal is an activity that also reveals the viewport', () => {
    const rail = renderer('features/explorer/ActivityRail.tsx')
    assert.ok(rail.includes("kind: 'terminal'"), 'terminal must be a rail activity')
    const explorer = renderer('features/explorer/Explorer.tsx')
    const selectAt = explorer.indexOf('function handleTerminalActivitySelect')
    assert.ok(selectAt >= 0, 'activity selection must route through the terminal handler')
    const body = explorer.slice(selectAt, selectAt + 500)
    assert.ok(body.includes('onActivityChange(kind)'), 'selection must still drive the drawer activity')
    assert.ok(body.includes('onToggleTerminal()'), 'selecting terminal must reveal the viewport')
  })

  it('drawer carries working New/Split/Duplicate actions and the open list', () => {
    const drawer = renderer('features/terminal/TerminalDrawer.tsx')
    assert.ok(drawer.includes('aria-label="New terminal"'), 'New Terminal action must be visible')
    assert.ok(drawer.includes('onNew'), 'New must invoke the real creation flow')
    assert.ok(drawer.includes('aria-label="Split terminal"'), 'Split Terminal action must be visible')
    assert.ok(drawer.includes('aria-label="Duplicate terminal"'), 'Duplicate Terminal action must be visible')
    assert.ok(drawer.includes('aria-label="Open terminals"'), 'open-terminal list must render')
    assert.ok(drawer.includes('terminal-drawer__row--active'), 'active terminal must be indicated')
    const drawerCss = renderer('features/terminal/TerminalDrawer.css')
    assert.ok(drawerCss.includes('--stark-magenta'), 'active indication must use the secondary magenta token')
    const activeRule = drawerCss.match(/\.terminal-drawer__row--active\s*\{[^}]*\}/)
    assert.ok(activeRule !== null && activeRule[0].includes('var(--stark-magenta)'), 'active row must carry the magenta indicator')
    assert.ok(!drawerCss.includes('--stark-lime'), 'terminal selection must not reuse the primary lime')
    assert.ok(drawer.includes('onSelect(entry.id)'), 'row click must select the real session')
    assert.ok(drawer.includes('onKill(entry.id)'), 'row close must kill the exact session')
  })

  it('drawer stays compact within the fixed drawer width', () => {
    const css = renderer('features/terminal/TerminalDrawer.css')
    assert.ok(css.includes('min-height: 32px'), 'rows must stay compact')
    assert.ok(!css.includes('min-height: 4') && !css.includes('min-height: 5'), 'no giant buttons or cards')
    assert.ok(css.includes('overflow-x: hidden'), 'drawer must never scroll sideways')
    assert.ok(css.includes('text-overflow: ellipsis'), 'long titles must ellipsize')
    const explorerCss = renderer('features/explorer/Explorer.css')
    const drawerBlock = explorerCss.match(/\.workspace-tools-drawer\s*\{[^}]*\}/)
    assert.ok(drawerBlock !== null && drawerBlock[0].includes('width: 392px'), 'drawer width must stay 392px')
  })
})

describe('multi-terminal creation and selection', () => {
  it('new terminals spawn independent PTYs and activate without touching others', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    // Scope to the spawn body: the unmount-stranding guard below it
    // legitimately kills exactly the just-spawned PTY.
    const body = functionBody(explorer, 'async function spawnTerminal()')
    assert.ok(body.includes('api.create({ workspaceId'), 'creation must go through the narrow bridge')
    const createdAt = body.indexOf('api.create({ workspaceId')
    assert.ok(!body.slice(0, createdAt).includes('kill'), 'spawn must never kill to make room (no eviction)')
    assert.ok(body.includes("terminalDispatch({ type: 'start-succeeded'"), 'success must register the new instance')
    assert.ok(body.includes('terminalMountRef.current'), 'mid-spawn unmount must not strand a PTY')
  })

  it('cap blocks creation calmly with no PTY spawn', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    const newAt = explorer.indexOf('async function handleNewTerminal()')
    assert.ok(newAt >= 0, 'new-terminal handler must exist')
    const body = explorer.slice(newAt, newAt + 500)
    assert.ok(body.includes('canCreateTerminal(terminals)'), 'creation must pre-check the cap')
    assert.ok(body.includes('TERMINAL_LIMIT_NOTICE'), 'cap must show the calm copy')
    const createAt = body.indexOf('spawnTerminal()')
    const guardAt = body.indexOf('canCreateTerminal(terminals)')
    assert.ok(guardAt >= 0 && (createAt === -1 || guardAt < createAt), 'cap guard must precede any spawn')
  })

  it('switching viewports keeps every PTY mounted', () => {
    const panel = renderer('features/terminal/TerminalPanel.tsx')
    // Exactly one instance per session, keyed stably in creation
    // order: selection flips CSS visibility only, so React never
    // unmounts (and never disposes) an xterm on row clicks.
    assert.ok(panel.includes('sessions.map((entry)'), 'one pane per session in stable order')
    assert.ok(panel.includes('<Fragment key={entry.id}>'), 'panes must key stably by session id')
    assert.ok(panel.includes('<TerminalInstanceView'), 'each pane must own its instance view')
    assert.ok(!panel.includes('hidden.map'), 'no second remounting instance list may exist')
    assert.ok(panel.includes("display: 'none'"), 'background panes must hide without unmounting')
    const view = renderer('features/terminal/TerminalInstanceView.tsx')
    assert.ok(view.includes('term?.dispose()') || view.includes('?.dispose()'), 'disposal must happen on unmount only')
  })

  it('row click selects with the correct id and focuses that terminal', () => {
    const drawer = renderer('features/terminal/TerminalDrawer.tsx')
    assert.ok(drawer.includes('onClick={() => onSelect(entry.id)}'), 'full row must select with its own session id')
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const body = functionBody(explorer, 'function handleSelectTerminal(')
    assert.ok(body.includes("terminalDispatch({ type: 'session-selected', sessionId })"), 'select must dispatch with the clicked id')
    assert.ok(!body.includes('api.') && !body.includes('kill') && !body.includes('create'), 'selection must mutate zero processes')
    assert.ok(explorer.includes('terminalInstancesRef.current.get(terminals.activeId)?.focus()'), 'focus must follow the active terminal')
  })

  it('row close never triggers row select', () => {
    const drawer = renderer('features/terminal/TerminalDrawer.tsx')
    const liAt = drawer.indexOf('<li key={entry.id}')
    assert.ok(liAt >= 0, 'terminal rows must exist')
    const li = drawer.slice(liAt, drawer.indexOf('</li>', liAt))
    const selectClose = li.indexOf('</button>')
    const killAt = li.indexOf('onKill(entry.id)')
    assert.ok(selectClose !== -1 && killAt !== -1 && selectClose < killAt, 'kill × must sit outside the select button (sibling, no bubbling)')
  })

  it('failures clean the pending entry and keep selection valid', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes("terminalDispatch({ type: 'start-failed'"), 'spawn failure must clear the pending entry')
  })

  it('final close reaches the safe empty state without auto-spawn', () => {
    const panel = renderer('features/terminal/TerminalPanel.tsx')
    assert.ok(panel.includes('terminal--empty'), 'empty viewport state must exist')
    assert.ok(panel.includes('No terminals running.'), 'empty copy must stay calm')
    assert.ok(panel.includes('New terminal'), 'empty state must offer creation')
    assert.ok(!panel.includes('api.create'), 'viewport must never spawn by itself')
  })
})

describe('split terminals', () => {
  it('split seeds an independent second PTY beside the source', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const body = functionBody(explorer, 'async function handleSplitTerminal(')
    assert.ok(body.includes("status !== 'running'"), 'split requires a live source terminal')
    assert.ok(body.includes('spawnTerminal()'), 'split must spawn a real second PTY (never mirror one)')
    assert.ok(body.includes("terminalDispatch({ type: 'split-opened'"), 'split must show both terminals')
    assert.ok(!body.includes('kill'), 'split must not disturb the source PTY')
  })

  it('viewport visibility derives from the explicit split pair or the active id', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('visibleIds={visibleTerminalIds(terminals)}'), 'viewport must render the derived visible list')
    const panel = renderer('features/terminal/TerminalPanel.tsx')
    assert.ok(panel.includes('visibleIds.indexOf(entry.id)'), 'panes must resolve visibility per session id')
  })

  it('only Split Terminal can produce a visible pair', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const splitBody = functionBody(explorer, 'async function handleSplitTerminal(')
    assert.ok(splitBody.includes("terminalDispatch({ type: 'split-opened'"), 'split must open the explicit pair')
    for (const marker of ['async function spawnTerminal()', 'async function handleNewTerminal()', 'async function handleDuplicateTerminal(', 'function handleSelectTerminal(']) {
      const body = functionBody(explorer, marker)
      assert.ok(!body.includes('split-opened'), `${marker} must never open a split pair`)
    }
  })

  it('both panes render with a resizable divider and clean listeners', () => {
    const panel = renderer('features/terminal/TerminalPanel.tsx')
    assert.ok(panel.includes('terminal-split'), 'split layout must exist')
    assert.ok(panel.includes('terminal-split__divider'), 'divider must exist')
    assert.ok(panel.includes('setPointerCapture'), 'drag must capture the pointer')
    assert.ok(panel.includes('releasePointerCapture'), 'drag must release the pointer')
    assert.ok(panel.includes('onSplitRatioChange'), 'divider must drive the stored ratio')
    const css = renderer('features/terminal/TerminalPanel.css')
    assert.ok(css.includes('min-width: 160px'), 'panes must keep reasonable minimum widths')
    assert.ok(css.includes('@media (max-width: 1099px)'), 'narrow widths must stack safely')
  })

  it('typing routes per instance and kills stay exact', () => {
    const view = renderer('features/terminal/TerminalInstanceView.tsx')
    assert.ok(view.includes('api.write({ sessionId: sessionRef.current, data })'), 'keystrokes must carry the owning session id')
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const body = functionBody(explorer, 'function handleKillTerminal(')
    assert.ok(body.includes('api?.kill({ sessionId })') || body.includes('api.kill({ sessionId })'), 'kill must target the exact owned PTY')
    assert.ok(!body.includes('killAll') && !body.includes('taskkill'), 'kill must never fan out by name')
    assert.ok(body.includes("terminalDispatch({ type: 'close-requested'"), 'kill must drop only that instance')
  })

  it('close removes presentation before awaiting the backend kill', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const body = functionBody(explorer, 'function handleKillTerminal(')
    // Ordering is the fix: synchronous removal dispatch first, the
    // backend round trip (IPC + native ConPTY teardown) after — never
    // awaited on the click path.
    const removedAt = body.indexOf("terminalDispatch({ type: 'close-requested'")
    assert.ok(removedAt >= 0, 'close must dispatch immediate presentation removal')
    const killAt = body.indexOf('api?.kill({ sessionId })') >= 0 ? body.indexOf('api?.kill({ sessionId })') : body.indexOf('api.kill({ sessionId })')
    assert.ok(killAt > removedAt, 'backend kill must follow presentation removal, never precede it')
    assert.ok(!body.slice(0, removedAt).includes('await'), 'nothing may be awaited before removal')
  })

  it('double close collapses to one backend kill', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('terminalClosingRef'), 'close path must own a single-flight guard')
    const body = functionBody(codeOnly(explorer), 'function handleKillTerminal(')
    assert.ok(body.includes('terminalClosingRef.current.has(sessionId)'), 'repeat × for one id must return early')
    assert.ok(body.includes('terminalClosingRef.current.add(sessionId)'), 'first × must claim the id')
    assert.ok(body.includes('terminalClosingRef.current.delete(sessionId)'), 'guard must release after the kill settles')
  })

  it('kill outcomes finalize removal or restore with calm copy', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    const body = functionBody(codeOnly(explorer), 'function handleKillTerminal(')
    assert.ok(body.includes("terminalDispatch({ type: 'close-finalized'"), 'initiated kills must finalize disposal')
    assert.ok(body.includes('That terminal session is no longer available.'), 'already-gone kills must finalize the same way')
    assert.ok(body.includes("terminalDispatch({ type: 'close-aborted'"), 'failed initiation must restore the terminal')
    assert.ok(body.includes('We couldn’t close the terminal.'), 'restore must carry calm retry copy')
  })

  it('split and duplicate refuse closing terminals', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    for (const marker of ['async function handleSplitTerminal(', 'async function handleDuplicateTerminal(']) {
      const body = functionBody(explorer, marker)
      assert.ok(body.includes('closingIds.includes(sourceId)'), `${marker} must refuse a closing source`)
    }
  })

  it('already-exited close cleans up locally with no backend kill', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const body = functionBody(explorer, 'function handleKillTerminal(')
    // Exited rows must finalize presentation immediately without
    // another PTY kill and without an error notice.
    assert.ok(body.includes("status !== 'running'"), 'close must branch on live versus exited status')
    const statusAt = body.indexOf("status !== 'running'")
    const finalizedAt = body.indexOf("terminalDispatch({ type: 'close-finalized'")
    const killAt = body.indexOf('api?.kill({ sessionId })') >= 0 ? body.indexOf('api?.kill({ sessionId })') : body.indexOf('api.kill({ sessionId })')
    assert.ok(statusAt >= 0 && finalizedAt > statusAt && killAt > finalizedAt, 'exited fast-path must finalize before any backend kill')
  })

  it('exit invalidates the in-flight kill so stale responses never resurrect', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('terminalCloseGenRef'), 'close path must own a bounded generation token')
    const killBody = functionBody(codeOnly(explorer), 'function handleKillTerminal(')
    assert.ok(killBody.includes('terminalCloseGenRef.current.get(sessionId) !== generation'), 'late kill responses must be ignored after EXIT wins')
    const code = codeOnly(explorer)
    const exitAt = code.indexOf('const offExit = api.onExit')
    assert.ok(exitAt >= 0, 'exit subscription must exist')
    const exitSlice = code.slice(exitAt, exitAt + 800)
    assert.ok(exitSlice.includes('terminalCloseGenRef'), 'EXIT while closing must bump the generation')
    assert.ok(exitSlice.includes("terminalDispatch({ type: 'exit-received'"), 'EXIT must still flow through the reducer')
  })

  it('close generation entries are always released after settle', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const killBody = functionBody(explorer, 'function handleKillTerminal(')
    // The EXIT-bump path leaves a newer generation belonging to the
    // same settled attempt: conditional release would leak one map
    // entry per raced close (unbounded UUID-keyed growth).
    assert.ok(killBody.includes('terminalCloseGenRef.current.delete(sessionId)'), 'settled closes must release the generation')
    assert.ok(!killBody.includes('=== generation'), 'release must be unconditional, never generation-guarded')
  })

  it('workspace switch kills every terminal concurrently, not one by one', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const guardAt = explorer.indexOf('registerTerminalKillHandler(async () => {')
    assert.ok(guardAt >= 0, 'kill-all handler must be registered')
    const body = explorer.slice(guardAt, guardAt + 800)
    assert.ok(body.includes('api.kill({ sessionId })'), 'switch cleanup must kill by exact session handle')
    assert.ok(body.includes('Promise.all'), 'switch kills must run concurrently (no sequential slow-kill stalls)')
  })

  it('workspace-switch guard names the multi-terminal truth', () => {
    const guard = readSource('renderer', 'src', 'features/terminal/terminal-guard.ts')
    assert.ok(guard.includes('closeAllTerminalsForSwitch'), 'switch closer must name the kill-all behavior')
    assert.ok(!codeOnly(guard).includes('closeActiveTerminalForSwitch'), 'singular closer name must be gone')
    const flow = readSource('renderer', 'src', 'features/workspace/workspace-switch.ts')
    assert.ok(flow.includes('closeAllTerminalsForSwitch'), 'switch flows must call the kill-all closer')
  })
})

describe('duplicate terminals', () => {
  it('duplicate spawns a fresh PTY from the same workspace seed', () => {
    const explorer = codeOnly(renderer('features/explorer/Explorer.tsx'))
    const body = functionBody(explorer, 'async function handleDuplicateTerminal(')
    assert.ok(body.includes("status !== 'running'"), 'duplicate requires a live source terminal')
    assert.ok(body.includes('spawnTerminal()'), 'duplicate must spawn a new PTY through the same narrow create')
    assert.ok(!body.includes('kill'), 'source terminal must remain running')
    assert.ok(!explorer.includes('cloneProcess') && !explorer.includes('copyHistory'), 'no process/history cloning may exist')
  })
})

describe('terminal security invariants', () => {
  it('drawer and viewport reference human terminals only', () => {
    for (const file of ['features/terminal/TerminalDrawer.tsx', 'features/terminal/TerminalPanel.tsx', 'features/terminal/TerminalInstanceView.tsx']) {
      const source = codeOnly(renderer(file))
      assert.ok(!source.toLowerCase().includes('worker'), `${file} must not reference worker execution`)
      assert.ok(!source.includes('runtime'), `${file} must not reference runtime processes`)
      assert.ok(!source.includes('extensionHost') && !source.includes('extension-host'), `${file} must not reference the extension host`)
    }
  })

  it('no generic process surface is introduced', () => {
    for (const file of ['main/terminal/terminal-manager.ts', 'main/ipc/terminal.ts', 'features/terminal/TerminalDrawer.tsx', 'features/terminal/TerminalPanel.tsx', 'features/explorer/Explorer.tsx']) {
      const source = codeOnly(file.startsWith('main/') ? readSource(...file.split('/')) : renderer(file))
      assert.ok(!source.includes('shell: true') && !source.includes('shell:true'), `${file} must not enable shell:true`)
      assert.ok(!source.includes('taskkill') && !source.includes('pkill'), `${file} must not kill by process name`)
      assert.ok(!source.includes('child_process'), `${file} must not add child_process surface`)
    }
  })

  it('blocking PTY work lives in the host, never on the main broker', () => {
    const broker = readSource('main', 'terminal', 'terminal-manager.ts')
    assert.ok(!broker.includes('node-pty-adapter'), 'broker must not import the native adapter')
    assert.ok(!broker.includes('PtyFactory'), 'broker must not take a spawn factory')
    assert.ok(!broker.includes("require('node-pty')"), 'broker must not load the native module')
    assert.ok(broker.includes('TerminalHostClient'), 'broker must go through the host client')
    const host = readSource('main', 'terminal', 'terminal-host.mjs')
    assert.ok(host.includes('pty.kill()'), 'only the host may invoke the native kill')
  })

  it('workspace switch kills exactly the owned terminals through the guard', () => {
    const explorer = renderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('registerTerminalKillHandler'), 'confirmed switch must reach the terminal kill path')
    const guardAt = explorer.indexOf('registerTerminalKillHandler(async () => {')
    assert.ok(guardAt >= 0, 'kill-all handler must be registered')
    const body = explorer.slice(guardAt, guardAt + 700)
    assert.ok(body.includes('api.kill({ sessionId })'), 'switch cleanup must kill by exact session handle')
    assert.ok(explorer.includes('setTerminalActive('), 'guard flag must track live PTYs')
  })

  it('schema stays v19 with no migration', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })
})
