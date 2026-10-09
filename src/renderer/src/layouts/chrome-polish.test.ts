import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { getFileIconKind } from '../features/explorer/fileIconForName'

/**
 * Targeted chrome + project-switch + icon polish pass.
 *
 * Static guarantees: 60px desktop chrome with proportionally scaled
 * controls, clickable magenta project name wired to the existing
 * guarded workspace switch, and VSCode-like explorer icon
 * presentation. Renderer-only; no main/preload/IPC/schema changes.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('chrome polish', () => {
  it('top bar stands ~50% taller with scaled internals', () => {
    const css = readRenderer('layouts/AppChrome.css')
    const bar = css.match(/\.app-chrome\s*\{[^}]*\}/)
    assert.ok(bar !== null, 'chrome CSS must exist')
    assert.ok(bar[0].includes('min-height: 60px'), 'bar must stand 60px tall')
    assert.ok(bar[0].includes('max-height: 64px'), 'bar must cap at 64px')
    const control = css.match(/\.app-chrome__control\s*\{[^}]*\}/)
    assert.ok(control !== null && control[0].includes('min-height: 40px'), 'utility hit areas must scale to 40px')
    const tab = css.match(/\.app-chrome__tab\s*\{[^}]*\}/)
    assert.ok(tab !== null && tab[0].includes('min-height: 44px'), 'session tab must scale with the taller bar')
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('size={22}'), 'chrome icons must scale up from 17px')
  })

  it('project name is a clickable switch trigger on the guarded flow', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('onSwitchWorkspace'), 'chrome must accept the existing switch action')
    assert.ok(chrome.includes('<button'), 'project identity must be a real button')
    assert.ok(chrome.includes('className="app-chrome__identity"'), 'identity keeps its chrome-native styling')
    assert.ok(chrome.includes('aria-label={`Switch project'), 'switch control must be keyboard-accessible with a label')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('handleSwitchWorkspace'), 'shell must wire the guarded switch handler')
    assert.ok(home.includes('workspace.chooseWorkspace()'), 'switch must reuse the existing native picker flow')
    const css = readRenderer('layouts/AppChrome.css')
    const identity = css.match(/\.app-chrome__identity\s*\{[^}]*\}/)
    assert.ok(identity !== null && identity[0].includes('cursor: pointer'), 'project name must read clickable')
    assert.ok(css.includes('.app-chrome__identity:hover'), 'hover must give subtle feedback')
    assert.ok(css.includes('.app-chrome__identity:focus-visible'), 'focus must show an accessible ring')
  })

  it('project name uses the secondary brand color, nothing else recolored', () => {
    const css = readRenderer('layouts/AppChrome.css')
    const name = css.match(/\.app-chrome__workspace\s*\{[^}]*\}/)
    assert.ok(name !== null, 'project name CSS must exist')
    assert.ok(name[0].includes('color: var(--stark-magenta)'), 'project name must use STARK secondary magenta')
    const magentaUses = css.match(/^\s*color: var\(--stark-magenta\);$/gm) ?? []
    assert.equal(magentaUses.length, 2, 'only the project name plus the pre-existing account hover may use magenta text')
    assert.ok(css.includes('.app-chrome__tab-dot'), 'tab identity dot keeps its magenta marker')
    assert.ok(!name[0].includes('text-shadow') && !name[0].includes('box-shadow'), 'no neon overload on the project name')
  })

  it('explorer icons align in one column at a crisper size', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('explorer__chevron--spacer'), 'file rows must carry the chevron-width alignment spacer')
    assert.ok(explorer.includes('FOLDER_OPEN_ICON_URL'), 'expanded folders must keep the open-folder icon')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('.explorer__chevron--spacer'), 'spacer must be styled to the chevron width')
    const img = css.match(/\.explorer__file-icon img\s*\{[^}]*\}/) ?? css.match(/\.explorer__folder-icon img,\s*\.explorer__file-icon img\s*\{[^}]*\}/)
    assert.ok(img !== null && img[0].includes('width: 20px'), 'icons must render at a crisp 20px')
    assert.ok(img[0].includes('object-fit: contain'), 'icons must preserve aspect ratio')
  })

  it('file-type recognition covers docker and markdown variants', () => {
    assert.equal(getFileIconKind('Dockerfile'), 'config')
    assert.equal(getFileIconKind('Dockerfile.dev'), 'config')
    assert.equal(getFileIconKind('notes.mdx'), 'markdown')
    assert.equal(getFileIconKind('app.tsx'), 'typescript')
    assert.equal(getFileIconKind('app.js'), 'javascript')
    assert.equal(getFileIconKind('data.json'), 'json')
    assert.equal(getFileIconKind('package-lock.json'), 'package')
  })

  it('no backend, IPC, or schema surface added', () => {
    for (const file of ['layouts/AppChrome.tsx', 'pages/HomePage.tsx', 'features/explorer/Explorer.tsx', 'features/explorer/fileIconForName.ts']) {
      const source = readRenderer(file)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
    }
  })
})
