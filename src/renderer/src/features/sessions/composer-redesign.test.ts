import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * ChatGPT-style floating composer redesign guarantees.
 *
 * One rounded composer shell (textarea above, single control rail
 * below: + | mode pill … mic | send) in STARK's obsidian + lime/
 * magenta system. Presentation only: mode semantics, send gating,
 * keyboard rules, attachment/voice backends, and schema/IPC are
 * untouched. Runs against repository source (cwd is the repo root).
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function composerRegion(): string {
  const panel = readRenderer('features/sessions/SessionPanel.tsx')
  const start = panel.indexOf('session__composer--${')
  assert.ok(start >= 0, 'composer shell must exist')
  return panel.slice(start)
}

describe('floating composer shell', () => {
  it('is one cohesive surface with chat width, not a form card', () => {
    const css = readRenderer('features/sessions/session.css')
    const composer = css.match(/\.session__composer\s*\{[^}]*\}/)
    assert.ok(composer !== null, 'composer dock CSS must exist')
    const radius = composer[0].match(/border-radius:\s*(\d+)px/)
    assert.ok(radius !== null, 'composer must declare an outer radius')
    const radiusPx = Number(radius[1])
    assert.ok(radiusPx >= 24 && radiusPx <= 28, `outer radius must sit 24–28px, got ${radiusPx}px`)
    assert.ok(composer[0].includes('border: 1px solid var(--stark-border)'), 'resting composer must be quiet neutral')
    assert.ok(!composer[0].includes('var(--stark-lime)'), 'resting composer must carry no bright outline')
    assert.ok(composer[0].includes('min(980px'), 'desktop composer must use a generous centered measure')
    assert.ok(composer[0].includes('box-shadow'), 'composer must float with a restrained shadow')
  })

  it('keeps focus calm: soft lime glow, magenta for Work', () => {
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.session__composer:focus-within'), 'focus must be visible')
    assert.ok(css.includes('.session__composer--work:focus-within'), 'Work focus must read magenta')
    assert.ok(!css.includes('0 0 24px var(--stark-lime)'), 'no heavy neon glow may appear')
  })

  it('renders no nested card borders inside the shell', () => {
    const region = composerRegion()
    assert.ok(!region.includes('session__composer-row'), 'composer must not use the old multi-row card layout')
  })
})

describe('compact mode selector', () => {
  it('replaces the permanent tab row with one pill control', () => {
    const region = composerRegion()
    assert.ok(!region.includes('session__mode session__mode--ask'), 'permanent Ask tab must be gone')
    assert.ok(!region.includes('session__mode--work'), 'permanent Work tab must be gone')
    assert.ok(!region.includes('session__mode--propose'), 'permanent Propose tab must be gone')
    assert.ok(!region.includes('aria-pressed={proposal.mode'), 'segmented pressed tabs must be gone')
    assert.ok(region.includes('session__modepill'), 'compact mode pill must exist')
    assert.ok(region.includes('aria-haspopup="menu"'), 'pill must expose the menu contract')
    assert.ok(region.includes('aria-expanded={modeMenuOpen}'), 'pill must expose menu state')
    assert.ok(region.includes('aria-label="Choose message mode"'), 'pill must be labelled')
    assert.ok(region.includes('name="chevron-down"'), 'pill must carry a disclosure cue')
  })

  it('menu lists every mode and marks the active one', () => {
    const region = composerRegion()
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(region.includes('role="menu"'), 'mode menu must exist')
    assert.ok(region.includes('role="menuitemradio"'), 'options must be radio items')
    assert.ok(region.includes('aria-checked={proposal.mode === option.mode}'), 'active mode must be indicated')
    for (const label of ["'Ask'", "'Work'", "'Propose change'"]) {
      assert.ok(panel.includes(label), `menu must offer ${label}`)
    }
  })

  it('selection flows through the existing mode state, then refocuses', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('selectProposalMode'), 'menu must select through one helper')
    assert.ok(panel.includes('handleProposalMode(mode)'), 'selection must reuse the existing mode handler')
    assert.ok(panel.includes("proposalDispatch({ type: 'mode-changed'"), 'mode semantics must be unchanged')
    const helperAt = panel.indexOf('function selectProposalMode')
    assert.ok(helperAt >= 0, 'selection helper must exist')
    const helper = panel.slice(helperAt, helperAt + 400)
    assert.ok(helper.includes('setModeMenuOpen(false)'), 'menu must close on selection')
    assert.ok(helper.includes('composerRef.current?.focus()'), 'focus must return to the textarea')
  })

  it('menu closes on Escape and outside pointer-down, listeners cleaned up', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes("event.key === 'Escape'"), 'Escape must close the menu')
    assert.ok(panel.includes("document.addEventListener('keydown', onKeyDown)"), 'Escape listener must mount while open')
    assert.ok(panel.includes("document.addEventListener('pointerdown', onPointerDown)"), 'outside-click listener must mount while open')
    assert.ok(panel.includes("document.removeEventListener('keydown', onKeyDown)"), 'Escape listener must be removed')
    assert.ok(panel.includes("document.removeEventListener('pointerdown', onPointerDown)"), 'outside-click listener must be removed')
    assert.ok(panel.includes('modeButtonRef.current?.focus()'), 'Escape must return focus to the trigger')
  })

  it('menu is keyboard navigable with per-mode accents', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('handleModeMenuKeyDown'), 'arrow-key navigation must exist')
    assert.ok(panel.includes("'ArrowDown'"), 'ArrowDown must move through options')
    assert.ok(panel.includes("'ArrowUp'"), 'ArrowUp must move through options')
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.session__modepill--ask'), 'Ask pill must carry lime')
    assert.ok(css.includes('.session__modemenu-item--work'), 'Work menu item must exist')
    const pillAsk = css.match(/\.session__modepill--ask\s*\{[^}]*\}/)
    assert.ok(pillAsk !== null && pillAsk[0].includes('var(--stark-lime)'), 'Ask pill must read lime')
    const pillWork = css.match(/\.session__modepill--work\s*\{[^}]*\}/)
    assert.ok(pillWork !== null && pillWork[0].includes('var(--stark-magenta)'), 'Work pill must read magenta')
  })
})

describe('textarea center with auto-grow', () => {
  it('uses the short placeholder with behavior in the tooltip', () => {
    const region = composerRegion()
    assert.ok(region.includes('placeholder="Message STARK…"'), 'placeholder must be the short prompt')
    assert.ok(!region.includes('Enter to send, Shift+Enter for a new line)"'), 'placeholder must not carry the long helper')
    assert.ok(region.includes('title="Enter to send, Shift+Enter for a new line"'), 'behavior must live in the tooltip')
    assert.ok(region.includes('aria-label="Message composer"'), 'composer label must stay')
    assert.ok(region.includes('<textarea'), 'composer must stay a plain textarea')
    assert.ok(region.includes('className="session__input"'), 'composer must keep the plain-text input style')
  })

  it('auto-grows with a floor, a cap, and internal scroll', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('element.style.height'), 'textarea must autosize through layout effects')
    assert.ok(panel.includes('Math.min(element.scrollHeight, 240)'), 'growth must cap near 240px')
    assert.ok(panel.includes('rows={1}'), 'textarea must start from a single row')
    const css = readRenderer('features/sessions/session.css')
    const input = css.match(/\.session__input\s*\{[^}]*\}/)
    assert.ok(input !== null, 'input CSS must exist')
    assert.ok(input[0].includes('min-height: 52px'), 'text area floor must sit near 52px')
    assert.ok(input[0].includes('max-height: 240px'), 'text region cap must sit near 240px')
    assert.ok(input[0].includes('overflow-y: auto'), 'overflow must scroll internally')
    assert.ok(input[0].includes('resize: none'), 'native resize grip must be disabled')
  })

  it('preserves Enter-to-send, Shift+Enter newline, and IME safety', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('handleComposerKeyDown'), 'composer must keep its key handler')
    assert.ok(panel.includes('event.nativeEvent.isComposing'), 'IME composition must stay guarded')
    assert.ok(panel.includes('shouldSubmitComposerKey'), 'submit decisions must stay in the pure helper')
  })
})

describe('single bottom rail', () => {
  it('orders attachment, mode, text, voice, send on one row', () => {
    const region = composerRegion()
    assert.ok(region.includes('className="session__rail"'), 'one bottom rail must exist')
    const attachAt = region.indexOf('session__attach ')
    const modeAt = region.indexOf('session__modepill')
    const inputAt = region.indexOf('session__input')
    const voiceAt = region.indexOf('<VoiceInputButton')
    const sendAt = region.indexOf('session__send--fab')
    assert.ok(attachAt >= 0 && modeAt >= 0 && inputAt >= 0 && voiceAt >= 0 && sendAt >= 0, 'rail must hold every control')
    assert.ok(inputAt < attachAt, 'text area must sit above the rail')
    assert.ok(attachAt < modeAt && modeAt < voiceAt && voiceAt < sendAt, 'rail order must read + | mode … mic | send')
  })

  it('+ invokes the existing picker with accessible labeling', () => {
    const region = composerRegion()
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(region.includes('onClick={() => void handleAttach()}'), '+ must invoke the existing attach flow')
    assert.ok(panel.includes('chooseChatAttachments(workspaceId)'), 'existing picker helper must stay wired')
    assert.ok(region.includes('aria-label="Attach files"'), '+ must be labelled')
    assert.ok(region.includes('title="Attach files"'), '+ must tooltip')
    assert.ok(region.includes('name="plus"'), '+ must read as a compact plus control')
    const css = readRenderer('features/sessions/session.css')
    const iconbtn = css.match(/\.session__iconbtn\s*\{[^}]*\}/)
    assert.ok(iconbtn !== null && iconbtn[0].includes('border-radius: 50%'), '+ must be circular')
  })

  it('attachments render inside the shell above the text area', () => {
    const region = composerRegion()
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const stripAt = region.indexOf('session__attachments"')
    const inputAt = region.indexOf('session__input')
    assert.ok(stripAt >= 0 && stripAt < inputAt, 'draft strip must sit inside the shell above the textarea')
    assert.ok(region.includes('session__attachment-thumb'), 'image drafts must thumbnail')
    assert.ok(region.includes('handleRemoveAttachment'), 'each draft must keep its remove control')
    assert.ok(panel.includes('removeChatAttachmentDraft'), 'removal must still release the draft asset')
  })

  it('microphone stays a compact rail control with visible states', () => {
    const region = composerRegion()
    assert.ok(region.includes('<VoiceInputButton'), 'microphone must stay in the rail')
    const voice = readRenderer('features/sessions/VoiceInputButton.tsx')
    for (const phase of ["'idle'", "'recording'", "'transcribing'"]) {
      assert.ok(voice.includes(phase), `voice phase ${phase} must be preserved`)
    }
    assert.ok(voice.includes('aria-label="Start voice input"'), 'mic idle must stay labelled')
    assert.ok(voice.includes('stopTracks()'), 'microphone cleanup must stay')
    assert.ok(voice.includes('track.stop()'), 'owned tracks must still stop')
    assert.ok(voice.includes('session__iconbtn'), 'mic must use the circular rail control')
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('session-voice-pulse'), 'recording must pulse distinctly')
    assert.ok(css.includes('.session__iconbtn--recording'), 'recording control must read active')
  })

  it('send is a circular arrow control with preserved enablement', () => {
    const region = composerRegion()
    assert.ok(region.includes('session__send--fab'), 'send must be the circular control')
    assert.ok(region.includes('name="arrow-up"'), 'send must use the up-arrow glyph')
    assert.ok(region.includes('aria-label="Send message"'), 'send must be labelled')
    assert.ok(region.includes('title="Send message"'), 'send must tooltip')
    assert.ok(!region.includes('>Send<'), 'the word Send must not sit permanently in the rail')
    assert.ok(region.includes('disabled={sendDisabled}'), 'existing enablement must be preserved')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('state.selectedSessionId === null ||'), 'send must still require a session')
    assert.ok(panel.includes('attachments.length === 0'), 'send must still allow attachments-only messages')
    const css = readRenderer('features/sessions/session.css')
    const fab = css.match(/\.session__send--fab\s*\{[^}]*\}/)
    assert.ok(fab !== null, 'fab CSS must exist')
    assert.ok(fab[0].includes('width: 40px') && fab[0].includes('height: 40px'), 'fab must sit near 40px')
    assert.ok(css.includes('.session__send:disabled'), 'disabled send styling must stay')
  })
})

describe('copy, status, and responsive discipline', () => {
  it('removes the permanent stored-locally footer', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('Stored locally'), 'stored-locally footer must be gone from the composer')
    assert.ok(panel.includes('Local session — AI provider not connected yet.'), 'provider state must live only in the session status area')
  })

  it('renders transient status only while active', () => {
    const region = composerRegion()
    assert.ok(region.includes('{proposal.preparing && ('), 'preparing status must be conditional')
    assert.ok(region.includes('{state.sendError !== null && ('), 'send errors must be conditional')
    assert.ok(region.includes('{attachError !== null && ('), 'attach errors must be conditional')
    assert.ok(region.includes('{overLimit && ('), 'limit errors must be conditional')
  })

  it('clicking shell whitespace focuses, controls keep focus', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('handleComposerBodyClick'), 'shell click-to-focus must exist')
    assert.ok(panel.includes("closest('button, textarea, a, input"), 'interactive targets must keep their own focus')
  })

  it('focus returns after attach, mode change, transcription, and send', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    // Same-session attach refocuses the composer; a picker that
    // resolves after a tab switch must NOT steal focus into the new tab.
    const attachAt = panel.indexOf('async function handleAttach()')
    assert.ok(attachAt >= 0, 'attach flow must exist')
    assert.ok(panel.slice(attachAt, attachAt + 2000).includes('composerRef.current?.focus()'), 'focus must return after attach')
    assert.ok(panel.includes('composerRef.current?.focus()'), 'focus must return after send and transcription')
  })

  it('stays usable at narrow widths with no horizontal overflow', () => {
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('@media (max-width: 700px)'), 'narrow rules must exist')
    assert.ok(css.includes('.session__rail'), 'rail must be covered at narrow widths')
    assert.ok(css.includes('.session__modepill'), 'pill truncation must be covered at narrow widths')
    assert.ok(!css.includes('overflow-x'), 'composer must never scroll sideways')
  })

  it('exposes the full accessible control set in logical order', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const voice = readRenderer('features/sessions/VoiceInputButton.tsx')
    assert.ok(panel.includes('aria-label="Attach files"'), 'attach must be labelled')
    assert.ok(panel.includes('aria-label="Choose message mode"'), 'mode must be labelled')
    assert.ok(voice.includes('aria-label="Start voice input"'), 'mic must be labelled')
    assert.ok(panel.includes('aria-label="Send message"'), 'send must be labelled')
  })
})

describe('no backend, split, schema, or ipc drift', () => {
  it('mode/send/attach semantics are presentation-only', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes("proposalDispatch({ type: 'mode-changed'"), 'mode state path must be unchanged')
    assert.ok(panel.includes('disabled={sendDisabled}'), 'send gate must be unchanged')
    assert.ok(panel.includes('messageSendPayload'), 'payload builder must be unchanged')
    assert.ok(panel.includes('shouldSubmitComposerKey'), 'keyboard gate must be unchanged')
  })

  it('Session split behavior is unaffected', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('secondaryOpen && secondaryUi.splitPct !== null'), 'split gating must be untouched')
    const css = readRenderer('features/sessions/session.css')
    assert.ok(!css.includes('flex-basis'), 'composer must not impose split sizing')
  })

  it('adds no channels, migrations, or backend surface', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const forbidden of ['ipcRenderer', '.invoke(', 'MediaRecorder', 'getUserMedia']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
    const constants = readRenderer('lib/stark-api.ts')
    assert.ok(!constants.includes('stark:composer'), 'no composer IPC channel may appear')
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })
})
