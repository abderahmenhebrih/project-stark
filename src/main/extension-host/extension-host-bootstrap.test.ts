import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Extension Host bootstrap packaging: the shipped artifact must be
 * the audited source copied verbatim — no bundling, no absolute
 * dev-machine paths, no runtime-only rewrites.
 */
describe('extension host bootstrap packaging', () => {
  it('ships the audited bootstrap verbatim in the built main output', () => {
    const sourcePath = join(process.cwd(), 'src', 'main', 'extension-host', 'bootstrap.js')
    const shippedPath = join(process.cwd(), 'out', 'main', 'extension-host-bootstrap.js')
    assert.ok(existsSync(sourcePath), 'audited bootstrap source must exist')
    assert.ok(existsSync(shippedPath), 'production build must contain the host bootstrap (run npm run build first)')
    const source = readFileSync(sourcePath, 'utf8')
    const shipped = readFileSync(shippedPath, 'utf8')
    assert.equal(shipped, source)
    assert.ok(!shipped.includes('C:\\') && !shipped.includes('C:/'), 'shipped bootstrap must not embed dev-machine paths')
    assert.ok(!shipped.includes('ts-node'), 'shipped bootstrap must not need ts-node at runtime')
  })
})
