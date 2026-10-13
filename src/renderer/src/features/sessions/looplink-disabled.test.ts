import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * LoopLink main-authority wiring proof: the renderer sends ONLY the
 * enabled chain snapshots (no disabled roster — no
 * security-irrelevant duplicated payload state), while main derives
 * executability independently from its authoritative catalog +
 * compatibility state. A forged renderer that omits/empties/falsifies
 * any disabled list gains nothing. Legacy payloads carrying disabled
 * arrays are still accepted but IGNORED for authority.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('looplink main-authoritative eligibility', () => {
  it('AI sends carry chain snapshots only (no renderer disabled authority)', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const call of [
      'generateAssistantResponseRaw({ workspaceId, sessionId, effort, model: composerModelStableId, brainModels: brainChainSnapshot })',
      'proposeAiChangeSet({ workspaceId, sessionId, effort, model: composerModelStableId, brainModels: brainChainSnapshot })',
      'proposeAiFileChange({ workspaceId, sessionId, effort, model: composerModelStableId, brainModels: brainChainSnapshot })',
      'runBrainWorkRaw({ workspaceId, sessionId, effort, model: composerModelStableId, brainModels: brainChainSnapshot, heartModels: heartChainSnapshot })'
    ]) {
      assert.ok(panel.includes(call), `send must carry chain snapshots without disabled lists: ${call.slice(0, 40)}…`)
    }
    assert.ok(!panel.includes('disabledBrainSnapshot'), 'renderer must not send disabled brain snapshots')
    assert.ok(!panel.includes('disabledHeartSnapshot'), 'renderer must not send disabled heart snapshots')
    assert.ok(!panel.includes('disabledRosterIds(libraryStableIds'), 'renderer must not derive disabled rosters for sends')
  })

  it('main derives executability independently (never trusts renderer disabled lists)', () => {
    const chain = readFileSync(join(process.cwd(), 'src', 'main', 'ai', 'looplink-chain.ts'), 'utf8')
    assert.ok(chain.includes('isModelExecutable'), 'chain reader must enforce main-authoritative executability')
    assert.ok(chain.includes('assertLoopLinkChainExecutable'), 'incompatible entries must fail closed before execution')
    assert.ok(chain.includes('IGNORED'), 'renderer disabled arrays must be documented as ignored for authority')
    const eligibility = readFileSync(
      join(process.cwd(), 'src', 'shared', 'hosted-models', 'model-eligibility.ts'),
      'utf8'
    )
    assert.ok(eligibility.includes('isHostedBuiltinModel'), 'eligibility must consult the hosted catalog')
    assert.ok(eligibility.includes('isCompatibleModelId'), 'eligibility must consult BYOK compatibility')
    for (const service of [
      'src/main/ai/ai-completion-service.ts',
      'src/main/ai/ai-brain-service.ts',
      'src/main/ai/ai-code-proposal-service.ts',
      'src/main/ai/ai-multi-file-proposal-service.ts',
      'src/main/worker-tools/worker-tool-runner.ts'
    ]) {
      const source = readFileSync(join(process.cwd(), service), 'utf8')
      assert.ok(source.includes('readLoopLinkChain'), `${service} must validate chains through the main authority`)
    }
  })
})
