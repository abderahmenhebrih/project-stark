import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

function readMain(relative: string): string {
  return readFileSync(`src/main/${relative}`, 'utf8')
}

/** Precise static checks: bare substrings would flag legitimate reads. */
function hasCall(source: string, name: string): boolean {
  return source.includes(`.${name}(`)
}

function hasAssignmentTo(source: string, name: string): boolean {
  const patterns = [`${name} =`, `${name}=`, `.${name} =`, `.${name}=`, `["${name}"] =`, `['${name}'] =`]
  return patterns.some((pattern) => source.includes(pattern))
}

describe('preview inspection script non-mutation', () => {
  it('main-owned script never mutates the DOM', () => {
    const script = readMain('preview-inspection/preview-inspection-script.ts')
    for (const name of [
      'click',
      'focus',
      'blur',
      'submit',
      'requestSubmit',
      'dispatchEvent',
      'setAttribute',
      'removeAttribute',
      'appendChild',
      'remove',
      'replaceWith',
      'insertAdjacent'
    ]) {
      assert.ok(!hasCall(script, name), `inspection script must not call ${name}()`)
    }
    assert.ok(!script.includes('history.pushState'), 'no history.pushState')
    assert.ok(!script.includes('history.replaceState'), 'no history.replaceState')
    for (const name of ['innerHTML', 'outerHTML', 'textContent']) {
      // Reads use innerText; assignments to these sinks are forbidden.
      assert.ok(!hasAssignmentTo(script, name), `inspection script must not assign ${name}`)
      if (name !== 'innerHTML' && name !== 'outerHTML') {
        void name
      }
    }
    // The script avoids these sinks entirely (uses innerText/document.URL).
    assert.ok(!script.includes('outerHTML'), 'no outerHTML')
    assert.ok(!script.includes('textContent'), 'no textContent (uses innerText)')
    assert.ok(!hasAssignmentTo(script, 'location'), 'no location assignment')
    assert.ok(!hasAssignmentTo(script, 'value'), 'no value assignment')
    // No input values, storage, cookies, or network.
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'fetch(', 'XMLHttpRequest']) {
      assert.ok(!script.includes(forbidden), `inspection script must not contain ${forbidden}`)
    }
  })

  it('only the constant script may reach executeJavaScript', () => {
    const service = readMain('preview-inspection/preview-inspection-service.ts')
    // The service abstraction collects via collectSnapshot() (no script
    // parameter) — no worker/renderer-controlled script surface exists.
    assert.ok(!service.includes('script:'), 'no script parameter')
    assert.ok(!service.includes('expression'), 'no expression parameter')
    assert.ok(!service.includes('selector'), 'no selector parameter')
    const inspectionFiles = [
      readMain('preview-inspection/preview-inspection-service.ts'),
      readMain('preview-inspection/preview-inspection-validation.ts'),
      readMain('worker-tools/worker-tool-service.ts'),
      readMain('worker-tools/worker-tool-runner.ts'),
      readMain('ipc/worker-tools.ts'),
      readMain('ipc/runtimes.ts')
    ].join('\n')
    assert.ok(!inspectionFiles.includes('evaluateJavaScript'), 'no arbitrary evaluate endpoint')
  })

  it('no main/preload API accepts javascript/selector/expression', () => {
    const preload = readFileSync('src/preload/index.ts', 'utf8')
    for (const forbidden of ['javascript', 'expression', 'selector']) {
      assert.ok(!preload.toLowerCase().includes(forbidden), `preload must not contain ${forbidden}`)
    }
    for (const file of [
      'preview-inspection/preview-inspection-service.ts',
      'runtime-observation/runtime-observation-service.ts',
      'worker-tools/worker-tool-service.ts',
      'ipc/worker-tools.ts',
      'ipc/runtimes.ts'
    ]) {
      const source = readMain(file)
      assert.ok(!source.includes('javascript:'), `${file} must not take javascript`)
    }
  })
})
