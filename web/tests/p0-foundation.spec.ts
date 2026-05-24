import { expect, test } from '@playwright/test'

test('journal repositories support blob CRUD in IndexedDB', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const repositories = await createJournalRepositories({ dbName: `p0-blob-crud-${crypto.randomUUID()}` })
    const id = `test-blob-${crypto.randomUUID()}`
    await repositories.blobs.put({
      id,
      blob: new Blob(['repository data'], { type: 'text/plain' }),
      sha256: 'pending',
      size: 15,
      mimeType: 'text/plain',
      updatedAt: new Date().toISOString(),
    })
    const saved = await repositories.blobs.get(id)
    await repositories.blobs.delete(id)
    const deleted = await repositories.blobs.get(id)
    return {
      savedSize: saved?.size,
      savedMime: saved?.mimeType,
      deleted: !deleted,
    }
  })

  expect(result).toEqual({ savedSize: 15, savedMime: 'text/plain', deleted: true })
})

test('IndexedDbBlobStore persists and verifies attachment blobs', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const { IndexedDbBlobStore } = await import('/src/sync/blobStore.ts')
    const repositories = await createJournalRepositories({ dbName: `p0-blob-store-${crypto.randomUUID()}` })
    const store = new IndexedDbBlobStore(repositories)
    const key = `cache-${crypto.randomUUID()}`
    const record = await store.put(key, new Blob(['abc'], { type: 'text/plain' }))
    const verifyOk = await store.verify(key, record.sha256)
    const verifyMismatch = await store.verify(key, 'not-the-hash')
    await store.delete(key)
    const verifyMissing = await store.verify(key, record.sha256)
    return {
      sha256: record.sha256,
      size: record.size,
      mimeType: record.mimeType,
      verifyOk,
      verifyMismatch,
      verifyMissing,
    }
  })

  expect(result.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(result.size).toBe(3)
  expect(result.mimeType).toBe('text/plain')
  expect(result.verifyOk.ok).toBe(true)
  expect(result.verifyMismatch.ok).toBe(false)
  expect(result.verifyMissing).toEqual({ ok: false, missing: true })
})

test('IndexedDbJournalStore persists snapshots and sync checkpoints', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const { createIndexedDbJournalStore } = await import('/src/sync/syncEngine.ts')
    const repositories = await createJournalRepositories({ dbName: `p0-journal-store-${crypto.randomUUID()}` })
    await Promise.all([
      repositories.entries.clear(),
      repositories.attachments.clear(),
      repositories.fileBoxItems.clear(),
      repositories.transfers.clear(),
      repositories.conflicts.clear(),
      repositories.tombstones.clear(),
      repositories.devices.clear(),
      repositories.meta.clear(),
    ])
    const device = {
      id: `dev-${crypto.randomUUID()}`,
      name: 'Browser test',
      platform: 'web' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const entry = {
      id: `entry-${crypto.randomUUID()}`,
      authorId: 'user-1',
      title: 'Repository entry',
      dateBucket: '2026-05-24',
      isDaily: true,
      createdDatetime: '2026-05-24T08:00:00.000Z',
      lastEditedDatetime: '2026-05-24T09:00:00.000Z',
      content: [{ id: 'block-1', type: 'paragraph' as const, text: 'saved' }],
      tags: [],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions: [],
    }
    const store = await createIndexedDbJournalStore(device, repositories)
    await store.saveSnapshot({
      entries: { [entry.id]: entry },
      attachments: [],
      fileBoxItems: [],
      transfers: [],
      conflicts: [],
      tombstones: [],
      device,
    })
    await store.saveMeta({
      entryHashes: { [entry.id]: 'hash-entry' },
      attachmentHashes: {},
      lastSyncedAt: '2026-05-24T10:00:00.000Z',
      driveChangesToken: '12',
    })
    const restored = await store.getSnapshot()
    const meta = await store.getMeta()
    return {
      entryTitle: restored.entries[entry.id]?.title,
      deviceId: restored.device?.id,
      metaHash: meta.entryHashes[entry.id],
      token: meta.driveChangesToken,
    }
  })

  expect(result).toEqual({
    entryTitle: 'Repository entry',
    deviceId: expect.stringMatching(/^dev-/),
    metaHash: 'hash-entry',
    token: '12',
  })
})
