import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAttachmentDialogOptions, electronAttachmentPicker, senderWindow } from './picker'

describe('attachment picker boundary', () => {
  it('opens multi-file selection without directory picking', () => {
    const options = buildAttachmentDialogOptions()
    assert.equal(options.title, 'Attach files')
    assert.deepEqual([...options.properties], ['openFile', 'multiSelections'])
    assert.ok(!options.properties.includes('openDirectory' as never))
  })

  it('exposes the production picker without renderer authority', () => {
    assert.equal(typeof electronAttachmentPicker.pickFiles, 'function')
    assert.equal(senderWindow(undefined), undefined)
  })
})
