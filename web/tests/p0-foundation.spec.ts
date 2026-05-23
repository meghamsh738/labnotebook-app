import { expect, test } from '@playwright/test'

test('journal repositories support blob CRUD in IndexedDB', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const repositories = await createJournalRepositories()
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
    const repositories = await createJournalRepositories()
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
