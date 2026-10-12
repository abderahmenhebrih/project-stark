import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Explorer CRUD bridge guarantees (source-level: the module reaches
 * the DOM-typed stark bridge, which the Node test config cannot
 * import). Asserts the narrow contract statically: workspace-scoped
 * calls only, calm unavailability, and zero AI transaction surface.
 */
describe('explorer CRUD bridge', () => {
  it('offers only narrow workspace-scoped calls with calm unavailability', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'lib', 'explorer-crud-api.ts'), 'utf8')
    for (const call of ['createExplorerFile', 'createExplorerFolder', 'renameExplorerEntry', 'trashExplorerEntry']) {
      assert.ok(source.includes(call), `bridge must offer ${call}`)
    }
    assert.ok(source.includes('getStarkApi()?.workspace.files'), 'calls must flow through the files bridge')
    assert.ok(source.includes('We couldn’t'), 'missing bridges must reject with displayable copy')
    for (const forbidden of ['changes-api', 'change-transaction', 'createFileChange', 'window.stark']) {
      assert.ok(!source.includes(forbidden), `crud bridge must not contain ${forbidden}`)
    }
  })
})
