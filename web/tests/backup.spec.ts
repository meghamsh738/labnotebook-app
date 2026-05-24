import { expect, test } from '@playwright/test'

test('local backup restores entries, attachment metadata, and cached blobs', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { MemoryBlobStore } = await import('/src/sync/blobStore.ts')
    const { createJournalBackup, parseJournalBackup, restoreJournalBackup } = await import('/src/sync/backup.ts')
    const { MemoryJournalStore } = await import('/src/sync/syncEngine.ts')

    const device = {
      id: 'dev-backup',
      name: 'Backup test device',
      platform: 'desktop' as const,
      createdAt: '2026-05-24T10:00:00.000Z',
      lastSeenAt: '2026-05-24T10:00:00.000Z',
    }
    const entry = {
      id: 'entry-2026-05-24',
      authorId: 'user-1',
      title: 'Backup restore',
      dateBucket: '2026-05-24',
      isDaily: true,
      createdDatetime: '2026-05-24T10:00:00.000Z',
      lastEditedDatetime: '2026-05-24T10:30:00.000Z',
      content: [{ id: 'block-1', type: 'paragraph' as const, text: 'backup note' }],
      tags: [],
      searchTerms: [],
      linkedFiles: ['att-backup'],
      pinnedRegions: [],
    }
    const sourceBlobs = new MemoryBlobStore()
    const blobRecord = await sourceBlobs.put('cache-att-backup', new Blob(['backup image bytes'], { type: 'image/png' }))
    const snapshot = {
      entries: { [entry.id]: entry },
      attachments: [{
        id: 'att-backup',
        entryId: entry.id,
        type: 'image' as const,
        filename: 'backup.png',
        filesize: '1 KB',
        bytes: blobRecord.size,
        storagePath: 'backup.png',
        cacheKey: blobRecord.id,
        cachedPath: `idb://${blobRecord.id}`,
        contentType: blobRecord.mimeType,
        sha256: blobRecord.sha256,
        syncStatus: 'queued' as const,
        createdAt: '2026-05-24T10:00:00.000Z',
        updatedAt: '2026-05-24T10:30:00.000Z',
      }],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [],
      device,
    }
    const backup = await createJournalBackup(snapshot, sourceBlobs)
    const parsed = parseJournalBackup(JSON.parse(JSON.stringify(backup)))
    const targetStore = new MemoryJournalStore({
      entries: {},
      attachments: [],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [],
      device,
    })
    const targetBlobs = new MemoryBlobStore()
    const restoreResult = await restoreJournalBackup({ backup: parsed, store: targetStore, blobStore: targetBlobs, device })
    const restoredSnapshot = await targetStore.getSnapshot()
    const restoredBlob = await targetBlobs.get('cache-att-backup')

    return {
      backupBlobCount: backup.blobs.length,
      restoreResult,
      title: restoredSnapshot.entries[entry.id]?.title,
      attachmentSha: restoredSnapshot.attachments[0]?.sha256,
      blobText: await restoredBlob?.text(),
    }
  })

  expect(result.backupBlobCount).toBe(1)
  expect(result.restoreResult).toMatchObject({ entries: 1, attachments: 1, blobs: 1 })
  expect(result.title).toBe('Backup restore')
  expect(result.attachmentSha).toBeTruthy()
  expect(result.blobText).toBe('backup image bytes')
})
