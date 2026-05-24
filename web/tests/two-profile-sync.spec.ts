import { expect, test } from '@playwright/test'

test('two isolated browser profiles sync entries and attachment blobs through the engine', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const dbSuffix = crypto.randomUUID()
    const desktopDbName = `journal-desktop-${dbSuffix}`
    const mobileDbName = `journal-mobile-${dbSuffix}`
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const { IndexedDbBlobStore } = await import('/src/sync/blobStore.ts')
    const { createIndexedDbJournalStore, syncOnce } = await import('/src/sync/syncEngine.ts')
    const { MockSyncProvider } = await import('/src/sync/syncProvider.ts')

    const desktopDevice = {
      id: 'dev-desktop',
      name: 'Desktop profile',
      platform: 'desktop' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const mobileDevice = {
      id: 'dev-mobile',
      name: 'Mobile profile',
      platform: 'mobile' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const entry = {
      id: 'entry-2026-05-24',
      authorId: 'user-1',
      title: 'Two profile sync',
      dateBucket: '2026-05-24',
      isDaily: true,
      createdDatetime: '2026-05-24T08:00:00.000Z',
      lastEditedDatetime: '2026-05-24T09:00:00.000Z',
      content: [{ id: 'block-1', type: 'paragraph' as const, text: 'desktop note' }],
      tags: [],
      searchTerms: [],
      linkedFiles: ['att-image'],
      pinnedRegions: [],
    }

    const desktopRepositories = await createJournalRepositories({ dbName: desktopDbName })
    const mobileRepositories = await createJournalRepositories({ dbName: mobileDbName })
    const desktopStore = await createIndexedDbJournalStore(desktopDevice, desktopRepositories)
    const mobileStore = await createIndexedDbJournalStore(mobileDevice, mobileRepositories)
    const desktopBlobs = new IndexedDbBlobStore(desktopRepositories)
    const mobileBlobs = new IndexedDbBlobStore(mobileRepositories)
    const blobRecord = await desktopBlobs.put('cache-att-image', new Blob(['two profile image'], { type: 'image/png' }))
    await desktopStore.saveSnapshot({
      entries: { [entry.id]: entry },
      attachments: [{
        id: 'att-image',
        entryId: entry.id,
        type: 'image' as const,
        filename: 'image.png',
        filesize: '1 KB',
        bytes: blobRecord.size,
        storagePath: 'image.png',
        cachedPath: 'idb://cache-att-image',
        cacheKey: 'cache-att-image',
        contentType: blobRecord.mimeType,
        mimeType: blobRecord.mimeType,
        sha256: blobRecord.sha256,
        syncStatus: 'queued' as const,
        createdAt: '2026-05-24T09:00:00.000Z',
        updatedAt: '2026-05-24T09:00:00.000Z',
      }],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [],
      device: desktopDevice,
    })

    const provider = new MockSyncProvider()
    const pushed = await syncOnce({ provider, store: desktopStore, device: desktopDevice, blobStore: desktopBlobs })
    const pulled = await syncOnce({ provider, store: mobileStore, device: mobileDevice, blobStore: mobileBlobs })
    const mobileSnapshot = await mobileStore.getSnapshot()
    const mobileBlob = await mobileBlobs.get('cache-att-image')

    return {
      pushed,
      pulled,
      entryTitle: mobileSnapshot.entries[entry.id]?.title,
      attachmentCount: mobileSnapshot.attachments.length,
      blobText: await mobileBlob?.text(),
      mobileConflictCount: mobileSnapshot.conflicts.length,
      remotePaths: (await provider.listManagedFiles()).map((file) => file.path).sort(),
    }
  })

  expect(result.pushed.uploadedBlobs).toBe(1)
  expect(result.pulled.pulledEntries).toBe(1)
  expect(result.pulled.downloadedBlobs).toBe(1)
  expect(result.entryTitle).toBe('Two profile sync')
  expect(result.attachmentCount).toBe(1)
  expect(result.blobText).toBe('two profile image')
  expect(result.mobileConflictCount).toBe(0)
  expect(result.remotePaths).toContain('attachments/2026-05-24/att-image-image.png')
  expect(result.remotePaths).toContain('entries/2026-05-24.json')
})
