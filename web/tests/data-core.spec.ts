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
  safeDriveSegment,
} from '../src/sync/dataCore'
import {
  DEFAULT_WEB_OAUTH_CLIENT_ID,
  normalizeDriveConnection,
  parseGoogleOAuthClientConfig,
  resolveDriveClientId,
  resolveGoogleAccountStorageScope,
} from '../src/sync/connectedSync'
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
  expect(buildAttachmentDrivePath(att, daily)).toBe('attachments/2026-05-23/att-1-raw%3Adata%3F.csv')
})

test('Drive path segments are collision-resistant and match the native UTF-8 percent encoding contract', () => {
  expect(safeDriveSegment('safe_ID-123.abc')).toBe('safe_ID-123.abc')
  expect([
    safeDriveSegment('a/b'),
    safeDriveSegment('a?b'),
    safeDriveSegment('a-b'),
  ]).toEqual(['a%2Fb', 'a%3Fb', 'a-b'])
  expect(new Set([
    safeDriveSegment('a/b'),
    safeDriveSegment('a?b'),
    safeDriveSegment('a-b'),
  ]).size).toBe(3)
  expect(safeDriveSegment('100%')).toBe('100%25')
  expect(safeDriveSegment(`space\u00A0em\u2003tab\t`)).toBe('space%C2%A0em%E2%80%83tab%09')
  expect(safeDriveSegment('caf\u00E9/\u732B')).toBe('caf%C3%A9%2F%E7%8C%AB')
  expect(safeDriveSegment('')).toBe('untitled')
  expect(safeDriveSegment('x'.repeat(121))).toBe('x'.repeat(121))
  expect(() => safeDriveSegment('\uD800')).toThrow('valid Unicode')
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

test('Google account cache scopes resist collisions and can remain pinned across profile upgrades', () => {
  const plusEmail = resolveGoogleAccountStorageScope({ provider: 'google', email: 'a+b@example.com' })
  const underscoreEmail = resolveGoogleAccountStorageScope({ provider: 'google', email: 'a_b@example.com' })
  expect(plusEmail).not.toBe(underscoreEmail)

  expect(resolveGoogleAccountStorageScope({
    provider: 'google',
    email: 'researcher@example.com',
    subject: 'new-google-subject',
    storageScope: 'researcher_example.com',
  })).toBe('researcher_example.com')
})

test('canonical JSON hashing is stable across object key order', async () => {
  const left = { title: 'May 23', tags: ['qPCR', 'ELISA'], body: { b: 2, a: 1 } }
  const right = { body: { a: 1, b: 2 }, tags: ['qPCR', 'ELISA'], title: 'May 23' }

  expect(stableStringify(left)).toBe(stableStringify(right))
  await expect(hashJsonSha256(left)).resolves.toBe(await hashJsonSha256(right))
})

test('Drive OAuth client resolution separates desktop and web clients with default PWA client', () => {
  const connection = normalizeDriveConnection({
    clientId: 'legacy-client',
    desktopClientId: 'desktop-client',
    webClientId: 'web-client',
    status: 'syncing',
  })

  expect(connection.status).toBe('needs-auth')
  expect(connection.storageMode).toBe('local-only')
  expect(resolveDriveClientId(connection, 'desktop')).toEqual({ clientId: 'desktop-client', preferredKind: 'desktop' })
  expect(resolveDriveClientId(connection, 'web')).toEqual({ clientId: 'web-client', preferredKind: 'web' })
  const legacyConnection = normalizeDriveConnection({ clientId: 'legacy-client' })
  expect(legacyConnection.desktopClientId).toBe('legacy-client')
  expect(legacyConnection.webClientId).toBe('legacy-client')
  expect(resolveDriveClientId(legacyConnection, 'desktop').clientId).toBe('legacy-client')
  expect(resolveDriveClientId(legacyConnection, 'web').clientId).toBe('legacy-client')
  expect(resolveDriveClientId({ clientId: 'legacy-client' }, 'desktop').clientId).toBe('legacy-client')
  expect(resolveDriveClientId({ clientId: 'legacy-client' }, 'web').clientId).toBe('legacy-client')
  expect(resolveDriveClientId({ clientId: '' }, 'web').clientId).toBe(DEFAULT_WEB_OAUTH_CLIENT_ID)

  const connected = normalizeDriveConnection({
    connectedAt: '2026-05-31T20:00:00.000Z',
    connectedAccount: {
      provider: 'google',
      email: 'scientist@example.com',
      name: 'Scientist',
      picture: 'https://example.com/avatar.png',
      subject: 'google-subject',
    },
  })
  expect(connected.storageMode).toBe('google-drive')
  expect(connected.connectedAccount).toEqual({
    provider: 'google',
    email: 'scientist@example.com',
    name: 'Scientist',
    picture: 'https://example.com/avatar.png',
    subject: 'google-subject',
    storageScope: 'google-subject',
  })
})

test('parses downloaded Google OAuth client JSON without token fields', () => {
  const desktop = parseGoogleOAuthClientConfig(JSON.stringify({
    installed: {
      client_id: 'desktop-client.apps.googleusercontent.com',
      client_secret: 'desktop-secret',
      ['refresh' + '_token']: 'must-not-import',
    },
  }))
  expect(desktop).toEqual({
    desktopClientId: 'desktop-client.apps.googleusercontent.com',
    desktopClientSecret: 'desktop-secret',
    importedKind: 'desktop',
  })

  const web = parseGoogleOAuthClientConfig(JSON.stringify({
    web: {
      client_id: 'web-client.apps.googleusercontent.com',
      client_secret: 'web-secret-not-used-by-pwa',
      ['access' + '_token']: 'must-not-import',
    },
  }))
  expect(web).toEqual({
    webClientId: 'web-client.apps.googleusercontent.com',
    importedKind: 'web',
  })
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
