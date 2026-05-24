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

test('two isolated browser profiles preserve offline edit conflicts', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const dbSuffix = crypto.randomUUID()
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const { createIndexedDbJournalStore, syncOnce } = await import('/src/sync/syncEngine.ts')
    const { MockSyncProvider } = await import('/src/sync/syncProvider.ts')

    const desktopDevice = {
      id: 'dev-conflict-desktop',
      name: 'Desktop conflict profile',
      platform: 'desktop' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const mobileDevice = {
      id: 'dev-conflict-mobile',
      name: 'Mobile conflict profile',
      platform: 'mobile' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const makeEntry = (text: string, editedAt: string, deviceId: string) => ({
      id: 'entry-2026-05-24-conflict',
      authorId: 'user-1',
      title: 'Offline conflict day',
      dateBucket: '2026-05-24',
      isDaily: true,
      createdDatetime: '2026-05-24T08:00:00.000Z',
      lastEditedDatetime: editedAt,
      content: [{ id: 'block-1', type: 'paragraph' as const, text }],
      tags: [],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions: [],
      updatedByDeviceId: deviceId,
    })

    const desktopStore = await createIndexedDbJournalStore(
      desktopDevice,
      await createJournalRepositories({ dbName: `journal-conflict-desktop-${dbSuffix}` })
    )
    const mobileStore = await createIndexedDbJournalStore(
      mobileDevice,
      await createJournalRepositories({ dbName: `journal-conflict-mobile-${dbSuffix}` })
    )
    const provider = new MockSyncProvider()
    await desktopStore.saveSnapshot({
      entries: { 'entry-2026-05-24-conflict': makeEntry('baseline', '2026-05-24T09:00:00.000Z', desktopDevice.id) },
      attachments: [],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [],
      device: desktopDevice,
    })
    await syncOnce({ provider, store: desktopStore, device: desktopDevice })
    await syncOnce({ provider, store: mobileStore, device: mobileDevice })

    const desktopSnapshot = await desktopStore.getSnapshot()
    desktopSnapshot.entries['entry-2026-05-24-conflict'] = makeEntry('desktop offline edit', '2026-05-24T10:00:00.000Z', desktopDevice.id)
    await desktopStore.saveSnapshot(desktopSnapshot)
    await syncOnce({ provider, store: desktopStore, device: desktopDevice })

    const mobileSnapshot = await mobileStore.getSnapshot()
    mobileSnapshot.entries['entry-2026-05-24-conflict'] = makeEntry('mobile offline edit', '2026-05-24T10:05:00.000Z', mobileDevice.id)
    await mobileStore.saveSnapshot(mobileSnapshot)
    const syncResult = await syncOnce({ provider, store: mobileStore, device: mobileDevice })
    const finalMobile = await mobileStore.getSnapshot()

    return {
      conflicts: syncResult.conflicts,
      visibleText: finalMobile.entries['entry-2026-05-24-conflict']?.content[0]?.text,
      conflictResolution: finalMobile.conflicts[0]?.resolution,
      conflictEntityId: finalMobile.conflicts[0]?.entityId,
      remoteConflictPaths: (await provider.listManagedFiles({ prefix: 'conflicts/' })).map((file) => file.path),
    }
  })

  expect(result.conflicts).toBe(1)
  expect(result.visibleText).toBe('mobile offline edit')
  expect(result.conflictResolution).toBe('pending')
  expect(result.conflictEntityId).toBe('entry-2026-05-24-conflict')
  expect(result.remoteConflictPaths).toEqual(['conflicts/conf-entry-entry-2026-05-24-conflict.json'])
})

test('two isolated browser profiles propagate tombstones without resurrecting entries', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const dbSuffix = crypto.randomUUID()
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const { createIndexedDbJournalStore, syncOnce } = await import('/src/sync/syncEngine.ts')
    const { MockSyncProvider } = await import('/src/sync/syncProvider.ts')

    const desktopDevice = {
      id: 'dev-delete-desktop',
      name: 'Desktop delete profile',
      platform: 'desktop' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const mobileDevice = {
      id: 'dev-delete-mobile',
      name: 'Mobile delete profile',
      platform: 'mobile' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const entry = {
      id: 'entry-2026-05-24-delete',
      authorId: 'user-1',
      title: 'Delete propagation day',
      dateBucket: '2026-05-24',
      isDaily: true,
      createdDatetime: '2026-05-24T08:00:00.000Z',
      lastEditedDatetime: '2026-05-24T09:00:00.000Z',
      content: [{ id: 'block-1', type: 'paragraph' as const, text: 'delete me' }],
      tags: [],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions: [],
      updatedByDeviceId: desktopDevice.id,
    }
    const desktopStore = await createIndexedDbJournalStore(
      desktopDevice,
      await createJournalRepositories({ dbName: `journal-delete-desktop-${dbSuffix}` })
    )
    const mobileStore = await createIndexedDbJournalStore(
      mobileDevice,
      await createJournalRepositories({ dbName: `journal-delete-mobile-${dbSuffix}` })
    )
    const provider = new MockSyncProvider()
    await desktopStore.saveSnapshot({
      entries: { [entry.id]: entry },
      attachments: [],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [],
      device: desktopDevice,
    })
    await syncOnce({ provider, store: desktopStore, device: desktopDevice })
    await syncOnce({ provider, store: mobileStore, device: mobileDevice })

    const desktopSnapshot = await desktopStore.getSnapshot()
    delete desktopSnapshot.entries[entry.id]
    desktopSnapshot.tombstones.push({
      id: `del-entry-${entry.id}`,
      entityKind: 'entry' as const,
      entityId: entry.id,
      deletedAt: '2026-05-24T10:00:00.000Z',
      deletedByDeviceId: desktopDevice.id,
      reason: 'Deleted on desktop profile',
    })
    await desktopStore.saveSnapshot(desktopSnapshot)
    await syncOnce({ provider, store: desktopStore, device: desktopDevice })
    await syncOnce({ provider, store: mobileStore, device: mobileDevice })
    const finalMobile = await mobileStore.getSnapshot()

    return {
      existsOnMobile: Boolean(finalMobile.entries[entry.id]),
      tombstones: finalMobile.tombstones.map((tombstone) => tombstone.entityId),
      remoteTombstonePaths: (await provider.listManagedFiles({ prefix: 'tombstones/' })).map((file) => file.path),
    }
  })

  expect(result.existsOnMobile).toBe(false)
  expect(result.tombstones).toContain('entry-2026-05-24-delete')
  expect(result.remoteTombstonePaths).toEqual(['tombstones/entry--entry-2026-05-24-delete.json'])
})
