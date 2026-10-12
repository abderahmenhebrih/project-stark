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

describe('agent target selector', () => {
  it('replaces the Ask/Work/Propose primary dropdown with STARK + Kilo targets', () => {
    const region = composerRegion()
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('MODE_OPTIONS'), 'the old Ask/Work/Propose option list must be gone')
    assert.ok(!panel.includes('selectProposalMode'), 'the old mode selection helper must be gone')
    assert.ok(!region.includes('aria-label="Choose message mode"'), 'the old mode pill label must be gone')
    for (const label of ["'Ask'", "'Work'", "'Propose change'"]) {
      assert.ok(!panel.includes(label), `primary selector must not offer ${label}`)
    }
    assert.ok(region.includes('aria-label="Agent target"'), 'target group must be labelled')
    assert.ok(region.includes('aria-label="Choose agent target"'), 'target pill must be labelled')
    assert.ok(region.includes('STARK'), 'STARK target must exist')
    // The menu renders the shared KILO_DISPLAY_NAME constant (literal
    // 'Kilo Code' is pinned in the agent-target contract tests).
    assert.ok(region.includes('KILO_DISPLAY_NAME'), 'Kilo target must exist in the menu')
    // The menu renders the live kilo.reason (honest unavailable copy);
    // the fail-closed reason literal lives in the panel state + send net.
    assert.ok(panel.includes('Kilo bridge not available'), 'unavailable Kilo must carry its honest reason')
    assert.ok(region.includes('canSelectKilo(kilo)'), 'Kilo selection must gate on real availability')
  })

  it('unified STARK send keeps runtime paths as slash overrides only', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('resolveStarkSendMode(content)'), 'sends must resolve through the deterministic resolver')
    assert.ok(panel.includes("await handleWorkSend(sessionId, sendContent)"), 'default send must use the unified Work path')
    assert.ok(panel.includes('runBrainWorkRaw({ workspaceId, sessionId, effort })'), 'Work runs must carry the effort selector')
    assert.ok(panel.includes('generateAssistantResponseRaw({ workspaceId, sessionId, effort })'), 'Ask override must carry the effort selector')
    assert.ok(panel.includes("proposalDispatch({ type: 'mode-changed'"), 'slash overrides must reuse the preserved mode state')
  })

  it('effort selector sits next to the target with five real levels', () => {
    const region = composerRegion()
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(region.includes('aria-label="STARK effort"'), 'effort group must sit beside the target')
    assert.ok(region.includes('aria-label="Choose STARK effort"'), 'effort pill must be labelled')
    assert.ok(panel.includes('STARK_EFFORTS'), 'menu must render the exact five levels')
    assert.ok(panel.includes('STARK_EFFORT_TOOLTIPS[effort]'), 'effort must tooltip its copy')
    assert.ok(panel.includes('effortVisibleFor(agentTarget)'), 'effort must hide for external targets')
  })

  it('selection flows through target/effort state, then refocuses', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('function selectAgentTarget'), 'target selection must flow through one helper')
    assert.ok(panel.includes('function selectEffort'), 'effort selection must flow through one helper')
    assert.ok(panel.includes('setTargetMenuOpen(false)'), 'target menu must close on selection')
    assert.ok(panel.includes('setEffortMenuOpen(false)'), 'effort menu must close on selection')
    assert.ok(panel.includes('composerRef.current?.focus()'), 'focus must return to the textarea')
  })

  it('switching target during an active run is blocked and drafts survive', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('isTargetSwitchBlocked'), 'target switches must guard in-flight runs')
    assert.ok(panel.includes('Finish the current run before switching agents.'), 'blocked switches must explain calmly')
    const helperAt = panel.indexOf('function selectAgentTarget')
    assert.ok(helperAt >= 0, 'selection helper must exist')
    const helper = panel.slice(helperAt, helperAt + 1400)
    assert.ok(!helper.includes('setComposer'), 'switching target must never clear the draft')
    assert.ok(!helper.includes('setAttachments'), 'switching target must never drop staged attachments')
  })

  it('menus close on Escape and outside pointer-down, listeners cleaned up', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes("event.key === 'Escape'"), 'Escape must close the menus')
    assert.ok(panel.includes("document.addEventListener('keydown', onKeyDown)"), 'Escape listener must mount while open')
    assert.ok(panel.includes("document.addEventListener('pointerdown', onPointerDown)"), 'outside-click listener must mount while open')
    assert.ok(panel.includes("document.removeEventListener('keydown', onKeyDown)"), 'Escape listener must be removed')
    assert.ok(panel.includes("document.removeEventListener('pointerdown', onPointerDown)"), 'outside-click listener must be removed')
    assert.ok(panel.includes('targetButtonRef.current?.focus()'), 'Escape must return focus to the target trigger')
    assert.ok(panel.includes('effortButtonRef.current?.focus()'), 'Escape must return focus to the effort trigger')
  })

  it('menus are keyboard navigable with checked active items', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('handleTargetEffortMenuKeyDown'), 'arrow-key navigation must exist')
    assert.ok(panel.includes("'ArrowDown'"), 'ArrowDown must move through options')
    assert.ok(panel.includes("'ArrowUp'"), 'ArrowUp must move through options')
    const region = composerRegion()
    assert.ok(region.includes('role="menuitemradio"'), 'options must be radio items')
    assert.ok(region.includes('aria-checked={agentTarget.kind'), 'active target must be indicated')
    assert.ok(region.includes('aria-checked={effort === level}'), 'active effort must be indicated')
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
    assert.ok(panel.includes('aria-label="Choose agent target"'), 'target must be labelled')
    assert.ok(panel.includes('aria-label="Choose STARK effort"'), 'effort must be labelled')
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
