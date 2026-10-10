import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ChatAttachment } from '../../shared/chat-attachments/types'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { ChatAttachmentService } from '../chat-attachments/service'
import type { AttachmentPicker } from '../chat-attachments/picker'
import { createAttachmentBindings } from './attachments'

function openHarness(): {
  db: DatabaseSync
  service: ChatAttachmentService
  dir: string
  storeRoot: string
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-attach-ipc-'))
  const storeRoot = join(dir, 'attachments')
  const created = workspaces.create({ rootPath: join(dir, 'project'), displayName: 'project', now: 1000 })
  return { db, service: new ChatAttachmentService(storeRoot, workspaces, sessions), dir, storeRoot, workspaceId: created.id }
}

const inertPicker: AttachmentPicker = {
  pickFiles: async () => undefined
}

describe('attachment IPC bindings', () => {
  it('exposes exactly choose and remove-draft', () => {
    const { db, dir, service } = openHarness()
    try {
      const bindings = createAttachmentBindings(service, inertPicker)
      assert.deepEqual(
        bindings.map((binding) => binding.channel).sort(),
        ['stark:attachments:choose', 'stark:attachments:remove-draft'].sort()
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('choose resolves cancellation to an empty list', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const bindings = createAttachmentBindings(service, inertPicker)
      const choose = bindings.find((binding) => binding.channel === 'stark:attachments:choose')
      assert.ok(choose !== undefined)
      assert.deepEqual(await choose.invoke({ workspaceId }), [])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('choose stores picked files with no paths leaking', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const source = join(dir, 'a.txt')
      writeFileSync(source, 'hello')
      const picker: AttachmentPicker = { pickFiles: async () => [source] }
      const bindings = createAttachmentBindings(service, picker)
      const choose = bindings.find((binding) => binding.channel === 'stark:attachments:choose')
      assert.ok(choose !== undefined)
      const stored = (await choose.invoke({ workspaceId })) as readonly ChatAttachment[]
      assert.ok(stored[0] !== undefined)
      const serialized = JSON.stringify(stored[0])
      assert.ok(!serialized.includes(dir))
      await assert.rejects(choose.invoke({ workspaceId: 999999 }), /not valid|unavailable|attach/)
      await assert.rejects(choose.invoke({ nope: 1 }), /attach/)
      await assert.rejects(choose.invoke(null), /attach/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('remove-draft validates strictly and adds no generic surface', async () => {
    const { db, dir, service } = openHarness()
    try {
      const bindings = createAttachmentBindings(service, inertPicker)
      const remove = bindings.find((binding) => binding.channel === 'stark:attachments:remove-draft')
      assert.ok(remove !== undefined)
      await assert.rejects(remove.invoke('xyz'), /not valid|attach/)
      await assert.rejects(remove.invoke({ attachmentId: 'x' }), /not valid|attach/)
      await assert.rejects(remove.invoke('0'.repeat(32)), /find|attach/)
      for (const forbidden of ['generic', 'readFile', 'copyFile', 'writeFile', 'openPath', 'browse', 'exec', 'shell']) {
        for (const binding of bindings) {
          assert.ok(!binding.channel.includes(forbidden), `${binding.channel} must not contain ${forbidden}`)
        }
      }
      assert.ok(IPC_CHANNELS.attachmentsChoose.startsWith('stark:'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('full surface test owns the attachment channels (see production-surface)', () => {
    assert.ok(IPC_CHANNELS.attachmentsChoose.startsWith('stark:'))
    assert.ok(IPC_CHANNELS.attachmentsRemoveDraft.startsWith('stark:'))
  })
})
