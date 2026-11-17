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

test('local restore validates before writes, isolates overlapping blob IDs, and flags missing files', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { MemoryBlobStore } = await import('/src/sync/blobStore.ts')
    const { createJournalBackup, parseJournalBackup, restoreJournalBackup } = await import('/src/sync/backup.ts')
    const { MemoryJournalStore } = await import('/src/sync/syncEngine.ts')

    const device = {
      id: 'dev-restore-safety',
      name: 'Restore safety test device',
      platform: 'desktop' as const,
      createdAt: '2026-05-24T10:00:00.000Z',
      lastSeenAt: '2026-05-24T10:00:00.000Z',
    }
    const previousEntry = {
      id: 'previous-entry',
      authorId: 'local-user',
      title: 'Keep this note until validation passes',
      dateBucket: '2026-05-23',
      isDaily: true,
      createdDatetime: '2026-05-23T10:00:00.000Z',
      lastEditedDatetime: '2026-05-23T10:00:00.000Z',
      content: [{ id: 'previous-block', type: 'paragraph' as const, text: 'previous content' }],
      tags: [],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions: [],
    }
    const nextEntry = {
      ...previousEntry,
      id: 'restored-entry',
      title: 'Restored note',
      dateBucket: '2026-05-24',
      createdDatetime: '2026-05-24T10:00:00.000Z',
      lastEditedDatetime: '2026-05-24T10:00:00.000Z',
    }
    const sourceBlobs = new MemoryBlobStore()
    await sourceBlobs.put('shared-cache-id', new Blob(['replacement attachment bytes'], { type: 'application/pdf' }))
    await sourceBlobs.put('later-cache-id', new Blob(['second attachment bytes'], { type: 'image/png' }))
    const backup = await createJournalBackup({
      entries: { [nextEntry.id]: nextEntry },
      attachments: [
        {
          id: 'att-overlap', entryId: nextEntry.id, type: 'pdf' as const, filename: 'report.pdf',
          filesize: '1 KB', bytes: 27, storagePath: 'old path', cacheKey: 'shared-cache-id',
          cachedPath: 'idb://shared-cache-id', createdAt: nextEntry.createdDatetime,
        },
        {
          id: 'att-missing', entryId: nextEntry.id, type: 'file' as const, filename: 'missing.csv',
          filesize: '1 KB', bytes: 12, storagePath: 'old path', cacheKey: 'stale-cache-id',
          cachedPath: 'idb://stale-cache-id', createdAt: nextEntry.createdDatetime,
        },
      ],
      fileBoxItems: [], transfers: [], conflicts: [], tombstones: [], device,
    }, sourceBlobs)

    const currentStore = new MemoryJournalStore({
      entries: { [previousEntry.id]: previousEntry },
      attachments: [], fileBoxItems: [], transfers: [], conflicts: [], tombstones: [], device,
    })
    const currentBlobs = new MemoryBlobStore()
    await currentBlobs.put('shared-cache-id', new Blob(['pre-existing same-ID bytes'], { type: 'application/pdf' }))
    await currentBlobs.put('stale-cache-id', new Blob(['old unavailable source'], { type: 'text/csv' }))

    const corruptBackup = JSON.parse(JSON.stringify(backup))
    corruptBackup.blobs[1].dataBase64 = '%%%corrupt-later-blob%%%'
    let corruptError = ''
    try {
      await restoreJournalBackup({
        backup: parseJournalBackup(corruptBackup),
        store: currentStore,
        blobStore: currentBlobs,
        device,
        localWorkspace: true,
      })
    } catch (error) {
      corruptError = error instanceof Error ? error.message : String(error)
    }
    const afterCorruptSnapshot = await currentStore.getSnapshot()
    const afterCorruptShared = await currentBlobs.get('shared-cache-id')
    const afterCorruptBlobs = await currentBlobs.list()

    const legacyBackup = JSON.parse(JSON.stringify(backup))
    legacyBackup.blobs.forEach((blob: { size?: number }) => { delete blob.size })
    const validRestore = await restoreJournalBackup({
      backup: parseJournalBackup(legacyBackup),
      store: currentStore,
      blobStore: currentBlobs,
      device,
      localWorkspace: true,
    })
    const restoredSnapshot = await currentStore.getSnapshot()
    const attachedId = restoredSnapshot.attachments[0]?.cacheKey
    const restoredBlob = attachedId ? await currentBlobs.get(attachedId) : undefined
    const unreferencedStaleBlob = await currentBlobs.get('stale-cache-id')

    return {
      corruptError,
      oldTitleAfterCorrupt: afterCorruptSnapshot.entries[previousEntry.id]?.title,
      overlappingBlobAfterCorrupt: await afterCorruptShared?.text(),
      blobCountAfterCorrupt: afterCorruptBlobs.length,
      validRestore,
      restoredTitle: restoredSnapshot.entries[nextEntry.id]?.title,
      restoredCacheKey: attachedId,
      restoredBlobText: await restoredBlob?.text(),
      unavailableAttachment: restoredSnapshot.attachments[1],
      staleBlobText: await unreferencedStaleBlob?.text(),
    }
  })

  expect(result.corruptError).toContain('invalid encoded data')
  expect(result.oldTitleAfterCorrupt).toBe('Keep this note until validation passes')
  expect(result.overlappingBlobAfterCorrupt).toBe('pre-existing same-ID bytes')
  expect(result.blobCountAfterCorrupt).toBe(2)
  expect(result.validRestore).toMatchObject({ entries: 1, attachments: 2, blobs: 2 })
  expect(result.restoredTitle).toBe('Restored note')
  expect(result.restoredCacheKey).not.toBe('shared-cache-id')
  expect(result.restoredBlobText).toBe('replacement attachment bytes')
  expect(result.unavailableAttachment).toMatchObject({ cacheKey: undefined, cachedPath: undefined, offlineUnavailable: true })
  expect(result.staleBlobText).toBe('old unavailable source')
})
