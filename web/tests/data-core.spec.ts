import { expect, test } from '@playwright/test'
import type { Attachment, DeviceProfile, Entry, SyncEntityEnvelope, TombstoneRecord } from '../src/domain/types'
import {
  applyTombstonesToSnapshot,
  buildAttachmentDrivePath,
  buildEntryDriveFileName,
  buildEntryEnvelope,
  buildPendingSyncQueue,
  hashBlobSha256,
  mergeEntryEnvelopes,
} from '../src/sync/dataCore'
import { hashJsonSha256, stableStringify } from '../src/sync/hashing'
import {
  buildInvalidRemoteJsonConflict,
  validateAttachmentEnvelope,
  validateEntryEnvelope,
  validateManifest,
  validateTombstone,
} from '../src/sync/schemas'

const device: DeviceProfile = {
  id: 'dev-a',
  name: 'Desktop',
  platform: 'desktop',
  createdAt: '2026-05-23T00:00:00.000Z',
  lastSeenAt: '2026-05-23T00:00:00.000Z',
}

function entry(id: string, dateBucket: string, editedAt: string): Entry {
  return {
    id,
    authorId: 'user-1',
    title: `Entry ${dateBucket}`,
    dateBucket,
    isDaily: true,
    createdDatetime: `${dateBucket}T08:00:00.000Z`,
    lastEditedDatetime: editedAt,
    content: [{ id: `block-${id}`, type: 'paragraph', text: 'note' }],
    tags: [],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [],
  }
}

function attachment(id: string, entryId: string, filename: string): Attachment {
  return {
    id,
    entryId,
    type: 'file',
    filename,
    filesize: '1 KB',
    bytes: 12,
    storagePath: filename,
    contentType: 'text/plain',
    sha256: 'abc',
    syncStatus: 'queued',
    createdAt: '2026-05-23T09:00:00.000Z',
    updatedAt: '2026-05-23T09:00:00.000Z',
  }
}

test('builds deterministic Drive paths for daily entries and attachments', () => {
  const daily = entry('entry-1', '2026-05-23', '2026-05-23T09:00:00.000Z')
  const att = attachment('att-1', daily.id, 'raw:data?.csv')

  expect(buildEntryDriveFileName(daily, { [daily.id]: daily })).toBe('2026-05-23.json')
  expect(buildAttachmentDrivePath(att, daily)).toBe('attachments/2026-05-23/att-1-raw-data-.csv')
})

test('queues entries, unsynced attachments, and tombstones after last sync', () => {
  const daily = entry('entry-1', '2026-05-23', '2026-05-23T09:00:00.000Z')
  const att = attachment('att-1', daily.id, 'raw.csv')
  const tombstone: TombstoneRecord = {
    id: 'del-entry-old',
    entityKind: 'entry',
    entityId: 'old',
    deletedAt: '2026-05-23T10:00:00.000Z',
    deletedByDeviceId: device.id,
  }

  const queue = buildPendingSyncQueue(
    {
      entries: { [daily.id]: daily },
      attachments: [att],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [tombstone],
      device,
    },
    device,
    '2026-05-23T08:00:00.000Z'
  )

  expect(queue.map((item) => item.id).sort()).toEqual(['attachment-att-1', 'delete-entry-old', 'entry-entry-1'])
})

test('preserves conflict copies when two devices edit the same entry', () => {
  const local = buildEntryEnvelope(entry('entry-1', '2026-05-23', '2026-05-23T11:00:00.000Z'), device)
  const remote: SyncEntityEnvelope<Entry> = {
    ...buildEntryEnvelope(entry('entry-1', '2026-05-23', '2026-05-23T10:00:00.000Z'), { ...device, id: 'dev-b' }),
    updatedByDeviceId: 'dev-b',
  }

  const result = mergeEntryEnvelopes(local, remote)

  expect(result.entry.lastEditedDatetime).toBe('2026-05-23T11:00:00.000Z')
  expect(result.conflict?.resolution).toBe('kept-copy')
  expect(result.conflict?.localCopy).toBeTruthy()
  expect(result.conflict?.remoteCopy).toBeTruthy()
})

test('tombstones remove deleted entries and their attachments from snapshots', () => {
  const daily = entry('entry-1', '2026-05-23', '2026-05-23T09:00:00.000Z')
  const removed = applyTombstonesToSnapshot(
    {
      entries: { [daily.id]: daily },
      attachments: [attachment('att-1', daily.id, 'raw.csv')],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [],
      device,
    },
    [{ id: 'del-entry-1', entityKind: 'entry', entityId: daily.id, deletedAt: '2026-05-23T12:00:00.000Z', deletedByDeviceId: device.id }]
  )

  expect(Object.keys(removed.entries)).toEqual([])
  expect(removed.attachments).toEqual([])
})

test('hashes attachment blobs for sync identity', async () => {
  await expect(hashBlobSha256(new Blob(['abc']))).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('canonical JSON hashing is stable across object key order', async () => {
  const left = { title: 'May 23', tags: ['qPCR', 'ELISA'], body: { b: 2, a: 1 } }
  const right = { body: { a: 1, b: 2 }, tags: ['qPCR', 'ELISA'], title: 'May 23' }

  expect(stableStringify(left)).toBe(stableStringify(right))
  await expect(hashJsonSha256(left)).resolves.toBe(await hashJsonSha256(right))
})

test('validates sync envelopes and rejects malformed remote JSON', () => {
  const daily = entry('entry-1', '2026-05-23', '2026-05-23T09:00:00.000Z')
  const validEntry = validateEntryEnvelope(buildEntryEnvelope(daily, device))
  const invalidEntry = validateEntryEnvelope({ kind: 'entry', payload: { id: daily.id } })
  const validAttachment = validateAttachmentEnvelope({
    id: 'att-1',
    kind: 'attachment',
    version: 1,
    updatedAt: '2026-05-23T09:00:00.000Z',
    updatedByDeviceId: device.id,
    payload: attachment('att-1', daily.id, 'raw.csv'),
  })
  const validTombstone = validateTombstone({
    id: 'del-entry-1',
    entityKind: 'entry',
    entityId: daily.id,
    deletedAt: '2026-05-23T10:00:00.000Z',
    deletedByDeviceId: device.id,
  })
  const validManifest = validateManifest({
    version: 1,
    provider: 'google-drive',
    rootFolderName: 'Easylab Lab Notebook',
    createdAt: '2026-05-23T09:00:00.000Z',
    updatedAt: '2026-05-23T09:00:00.000Z',
    devices: [device],
    entryCount: 1,
    attachmentCount: 1,
    fileBoxCount: 0,
    transferCount: 0,
  })

  expect(validEntry.ok).toBe(true)
  expect(invalidEntry.ok).toBe(false)
  expect(validAttachment.ok).toBe(true)
  expect(validTombstone.ok).toBe(true)
  expect(validManifest.ok).toBe(true)
})

test('builds a conflict record when remote JSON is quarantined', () => {
  const conflict = buildInvalidRemoteJsonConflict({
    entityKind: 'entry',
    entityId: 'entry-1',
    deviceId: device.id,
    error: 'Entry payload content must be an array.',
    remoteCopy: { id: 'entry-1', content: 'bad' },
  })

  expect(conflict.resolution).toBe('pending')
  expect(conflict.summary).toContain('Remote JSON was not applied')
  expect(conflict.remoteCopy).toEqual({ id: 'entry-1', content: 'bad' })
})
