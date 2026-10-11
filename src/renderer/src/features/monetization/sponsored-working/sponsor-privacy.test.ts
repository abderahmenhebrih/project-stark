import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildSponsorContext, isAllowedSponsorContext } from './sponsor-provider'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

/** Strips line/block comments so doc prose naming the boundary is not mistaken for code. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** Extracts one interface/type block by name (up to the closing brace). */
function blockOf(source: string, name: string): string {
  const start = source.indexOf(name)
  if (start < 0) {
    return ''
  }
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  if (open < 0 || close < 0) {
    return ''
  }
  return source.slice(open, close + 1)
}

/** Fields that must NEVER reach SponsorProvider (privacy hard boundary). */
const FORBIDDEN_CONTEXT_FIELDS = [
  'prompt',
  'messages',
  'message',
  'response',
  'workspacePath',
  'rootPath',
  'filename',
  'fileName',
  'relativePath',
  'sourceCode',
  'code',
  'terminalOutput',
  'terminal',
  'attachments',
  'attachment',
  'apiKey',
  'api_key',
  'modelContext',
  'context',
  'diff',
  'toolOutput',
  'toolResult'
] as const

describe('sponsor privacy boundary', () => {
  it('placement context carries only the whitelisted placement field', () => {
    const context = buildSponsorContext()
    assert.deepEqual(Object.keys(context), ['placement'])
    assert.equal(context.placement, 'ai-working')
    assert.equal(isAllowedSponsorContext(context), true)
  })

  it('builder takes no sensitive inputs (arity is zero by construction)', () => {
    assert.equal(buildSponsorContext.length, 0)
  })

  it('rejects any context carrying extra fields', () => {
    assert.equal(isAllowedSponsorContext({ placement: 'ai-working', prompt: 'hi' }), false)
    assert.equal(isAllowedSponsorContext({ placement: 'ai-working', workspacePath: '/x' }), false)
    assert.equal(isAllowedSponsorContext({ placement: 'other' }), false)
    assert.equal(isAllowedSponsorContext(null), false)
  })

  it('SponsorProvider type cannot receive sensitive AI/workspace data', () => {
    const providerSource = codeOnly(readRenderer('features/monetization/sponsored-working/sponsor-provider.ts'))
    assert.ok(providerSource.includes('SponsorPlacementContext'))
    assert.ok(providerSource.includes("placement: 'ai-working'"))
    // Scope to the provider contract + context builder: the fixture's own
    // `message` field and doc prose live elsewhere and are not inputs.
    const providerBlock = blockOf(providerSource, 'interface SponsorProvider')
    assert.ok(providerBlock.includes('SponsorPlacementContext'))
    // The single parameter TYPE is the whitelist; parameter names are
    // irrelevant, so 'context'/'message' as bare identifiers are excluded
    // here (the context TYPE shape is asserted separately below).
    for (const field of FORBIDDEN_CONTEXT_FIELDS) {
      if (field === 'context' || field === 'message') {
        continue
      }
      const pattern = new RegExp(`\\b${field}\\b\\s*[:?]`)
      assert.ok(!pattern.test(providerBlock), `SponsorProvider must not carry ${field}`);
    }
    assert.ok(providerBlock.includes('context: SponsorPlacementContext'))
    const builderStart = providerSource.indexOf('export function buildSponsorContext')
    const builderBlock = providerSource.slice(builderStart, providerSource.indexOf('}', builderStart) + 1)
    for (const field of FORBIDDEN_CONTEXT_FIELDS) {
      assert.ok(!builderBlock.includes(field), `context builder must not reference ${field}`)
    }
    const typesSource = readRenderer('features/monetization/sponsored-working/sponsor-types.ts')
    const contextBlock = typesSource.slice(
      typesSource.indexOf('interface SponsorPlacementContext'),
      typesSource.indexOf('interface SponsorPlacementContext') + 800
    )
    assert.ok(contextBlock.includes("placement: 'ai-working'"))
    for (const field of ['prompt', 'workspacePath', 'sourceCode', 'terminalOutput', 'apiKey', 'toolOutput']) {
      assert.ok(!contextBlock.includes(field), `context type must not include ${field}`)
    }
  })

  it('telemetry type cannot carry prompt/response/code/paths', () => {
    // The event interface lives in sponsor-types.ts; the sink lives in
    // sponsor-telemetry.ts. Both are asserted at their declaration site.
    const typesSource = codeOnly(
      readRenderer('features/monetization/sponsored-working/sponsor-types.ts')
    )
    const eventBlock = blockOf(typesSource, 'interface SponsorTelemetryEvent')
    assert.ok(eventBlock.includes('runId'))
    const telemetrySource = codeOnly(
      readRenderer('features/monetization/sponsored-working/sponsor-telemetry.ts')
    )
    for (const forbidden of ['prompt', 'response', 'sourceCode', 'workspacePath', 'terminal', 'apiKey', 'toolOutput']) {
      assert.ok(!eventBlock.includes(forbidden), `telemetry event must not carry ${forbidden}`);
    }
    const sinkBlock = blockOf(telemetrySource, 'interface SponsorTelemetrySink')
    for (const forbidden of ['prompt', 'response', 'workspacePath', 'apiKey']) {
      assert.ok(!sinkBlock.includes(forbidden), `telemetry sink must not carry ${forbidden}`);
    }
  })

  it('component builds context with no arguments (no data flow to provider)', () => {
    const slot = readRenderer('features/monetization/sponsored-working/SponsoredWorkingSlot.tsx')
    assert.ok(slot.includes('buildSponsorContext()'), 'slot must call the zero-arg context builder')
    assert.ok(!slot.includes('buildSponsorContext(composer'), 'slot must not pass composer text')
    assert.ok(!slot.includes('buildSponsorContext(message'), 'slot must not pass messages')
  })
})
