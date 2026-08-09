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

test('journal repositories isolate accounts without changing object-store schemas', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories, JOURNAL_DB_VERSION, JOURNAL_STORES } = await import('/src/sync/repositories.ts')
    const dbName = `p0-account-scope-${crypto.randomUUID()}`
    const accountA = await createJournalRepositories({ dbName, accountScope: 'google:account-a' })
    const accountB = await createJournalRepositories({ dbName, accountScope: 'google:account-b' })
    const unscoped = await createJournalRepositories({ dbName })
    await accountA.meta.put({ id: 'owner', updatedAt: new Date().toISOString(), value: 'account-a' })
    await accountB.meta.put({ id: 'owner', updatedAt: new Date().toISOString(), value: 'account-b' })

    return {
      accountA: (await accountA.meta.get('owner'))?.value,
      accountB: (await accountB.meta.get('owner'))?.value,
      unscoped: (await unscoped.meta.get('owner'))?.value,
      storeNames: Object.values(JOURNAL_STORES).sort(),
      version: JOURNAL_DB_VERSION,
    }
  })

  expect(result).toEqual({
    accountA: 'account-a',
    accountB: 'account-b',
    unscoped: undefined,
    storeNames: ['attachments', 'blobs', 'conflicts', 'devices', 'entries', 'fileBoxItems', 'meta', 'syncQueue', 'tombstones', 'transfers'],
    version: 3,
  })
})

test('Drive transaction journal survives browser recreation and isolates account scopes', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const {
      DriveTransactionJournal,
      IndexedDbDriveTransactionPersistence,
    } = await import('/src/sync/driveTransactionJournal.ts')
    const { hashJsonSha256 } = await import('/src/sync/hashing.ts')
    const suffix = crypto.randomUUID()
    const scopeA = `transaction-account-a-${suffix}`
    const scopeB = `transaction-account-b-${suffix}`
    const manifest = { version: 1, provider: 'google-drive' }
    const inputStateHash = await hashJsonSha256({ local: 'before' })
    const contentHash = await hashJsonSha256(manifest)
    const planHash = await hashJsonSha256({ inputStateHash, contentHash, suffix })
    const plan = {
      operationId: planHash,
      planHash,
      inputStateHash,
      createdAt: '2026-08-09T10:00:00.000Z',
      writes: [{
        id: await hashJsonSha256({ path: 'manifest.json', contentHash }),
        kind: 'manifest' as const,
        path: 'manifest.json',
        value: manifest,
        contentHash,
        appProperties: { entityType: 'manifest' },
        precondition: { kind: 'must-not-exist' as const, operationId: `create-${suffix}` },
      }],
      finalSnapshot: { entries: {} },
      finalMeta: { entryHashes: {} },
      result: { pushedEntries: 0 },
    }
    const first = new DriveTransactionJournal(new IndexedDbDriveTransactionPersistence())
    await first.begin(scopeA, plan)
    await first.markRunning(scopeA, plan.operationId)

    const recreated = new DriveTransactionJournal(new IndexedDbDriveTransactionPersistence())
    const recovered = await recreated.latestIncomplete(scopeA)
    const otherAccount = await recreated.latestIncomplete(scopeB)
    let immutable = false
    try {
      await recreated.begin(scopeA, { ...plan, writes: [{ ...plan.writes[0], path: 'changed.json' }] })
    } catch {
      immutable = true
    }
    const competingHash = await hashJsonSha256({ competing: true, suffix })
    let competingPlanBlocked = false
    try {
      await recreated.begin(scopeA, {
        ...plan,
        operationId: competingHash,
        planHash: competingHash,
        createdAt: '2026-08-09T10:00:01.000Z',
      })
    } catch {
      competingPlanBlocked = true
    }
    await recreated.markCompleted(scopeA, plan.operationId)
    await recreated.begin(scopeA, {
      ...plan,
      operationId: competingHash,
      planHash: competingHash,
      createdAt: '2026-08-09T10:00:01.000Z',
    })
    await recreated.markCompleted(scopeA, competingHash)
    const retainedCompleted = await new IndexedDbDriveTransactionPersistence().list(scopeA)
    return {
      state: recovered?.state,
      operationId: recovered?.plan.operationId,
      otherAccount: Boolean(otherAccount),
      immutable,
      competingPlanBlocked,
      retainedCompleted: retainedCompleted.length,
      serialized: JSON.stringify(recovered),
    }
  })

  expect(result.state).toBe('running')
  expect(result.operationId).toMatch(/^[0-9a-f]{64}$/)
  expect(result.otherAccount).toBe(false)
  expect(result.immutable).toBe(true)
  expect(result.competingPlanBlocked).toBe(true)
  expect(result.retainedCompleted).toBe(1)
  expect(result.serialized).not.toMatch(/access.?token|refresh.?token|session.?url|email/i)
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

test('non-entity IndexedDB records prove initialization and preserve intentionally empty entities', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const { hydrateOrMigrateJournalSnapshot } = await import('/src/sync/dataCore.ts')
    const device = {
      id: 'dev-initialization-evidence',
      name: 'Initialization evidence',
      platform: 'web' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const fallbackEntry = {
      id: 'entry-must-not-return',
      authorId: 'user-1',
      title: 'Deleted local fallback',
      dateBucket: '2026-05-24',
      createdDatetime: '2026-05-24T08:00:00.000Z',
      lastEditedDatetime: '2026-05-24T09:00:00.000Z',
      content: [],
      tags: [],
      searchTerms: [],
      linkedFiles: [],
      pinnedRegions: [],
    }
    const scenarios = ['tombstone', 'conflict', 'device', 'metadata'] as const
    const outcomes = []
    for (const scenario of scenarios) {
      const accountScope = `initialization-${scenario}-${crypto.randomUUID()}`
      const repositories = await createJournalRepositories({ accountScope })
      if (scenario === 'tombstone') {
        await repositories.tombstones.put({
          id: 'del-entry-must-not-return',
          entityKind: 'entry',
          entityId: fallbackEntry.id,
          deletedAt: '2026-05-24T10:00:00.000Z',
          deletedByDeviceId: device.id,
        })
      } else if (scenario === 'conflict') {
        await repositories.conflicts.put({
          id: 'conf-entry-must-not-return',
          entityKind: 'entry',
          entityId: fallbackEntry.id,
          localUpdatedAt: '2026-05-24T09:00:00.000Z',
          remoteUpdatedAt: '2026-05-24T09:01:00.000Z',
          detectedAt: '2026-05-24T09:02:00.000Z',
          resolution: 'pending',
          summary: 'Initialization evidence',
        })
      } else if (scenario === 'device') {
        await repositories.devices.put(device)
      } else {
        await repositories.meta.put({ id: 'snapshot', updatedAt: '2026-05-24T10:00:00.000Z', queueCount: 0 })
      }
      const hydrated = await hydrateOrMigrateJournalSnapshot({
        entries: { [fallbackEntry.id]: fallbackEntry },
        attachments: [],
        fileBoxItems: [],
        transfers: [],
        conflicts: [],
        tombstones: [],
        device,
      }, { device, accountScope })
      outcomes.push({
        scenario,
        source: hydrated.source,
        entryIds: Object.keys(hydrated.snapshot.entries),
        tombstones: hydrated.snapshot.tombstones.length,
        conflicts: hydrated.snapshot.conflicts.length,
      })
    }
    return outcomes
  })

  expect(result).toEqual([
    { scenario: 'tombstone', source: 'indexeddb', entryIds: [], tombstones: 1, conflicts: 0 },
    { scenario: 'conflict', source: 'indexeddb', entryIds: [], tombstones: 0, conflicts: 1 },
    { scenario: 'device', source: 'indexeddb', entryIds: [], tombstones: 0, conflicts: 0 },
    { scenario: 'metadata', source: 'indexeddb', entryIds: [], tombstones: 0, conflicts: 0 },
  ])
})

test('multi-store replacement aborts atomically when any record cannot be persisted', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const repositories = await createJournalRepositories({ dbName: `p0-atomic-${crypto.randomUUID()}` })
    const device = {
      id: 'dev-before',
      name: 'Before',
      platform: 'web' as const,
      createdAt: '2026-05-24T08:00:00.000Z',
      lastSeenAt: '2026-05-24T08:00:00.000Z',
    }
    const entry = {
      id: 'entry-before',
      kind: 'entry' as const,
      version: 1 as const,
      updatedAt: '2026-05-24T09:00:00.000Z',
      updatedByDeviceId: device.id,
      payload: {
        id: 'entry-before',
        authorId: 'user-1',
        title: 'Before',
        dateBucket: '2026-05-24',
        createdDatetime: '2026-05-24T08:00:00.000Z',
        lastEditedDatetime: '2026-05-24T09:00:00.000Z',
        content: [],
        tags: [],
        searchTerms: [],
        linkedFiles: [],
        pinnedRegions: [],
      },
    }
    await repositories.replaceStores({ entries: [entry], devices: [device] })
    let rejected = false
    try {
      await repositories.replaceStores({
        entries: [],
        devices: [{ ...device, id: 'dev-invalid', uncloneable: () => undefined } as never],
      })
    } catch {
      rejected = true
    }
    return {
      rejected,
      entryIds: (await repositories.entries.all()).map((record) => record.id),
      deviceIds: (await repositories.devices.all()).map((record) => record.id),
    }
  })

  expect(result).toEqual({ rejected: true, entryIds: ['entry-before'], deviceIds: ['dev-before'] })
})

test('journal state replacement rejects a stale revision from another browser context', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const { createJournalRepositories } = await import('/src/sync/repositories.ts')
    const dbName = `p0-revision-cas-${crypto.randomUUID()}`
    const first = await createJournalRepositories({ dbName })
    const second = await createJournalRepositories({ dbName })
    const envelope = (id: string, title: string) => ({
      id,
      kind: 'entry' as const,
      version: 1 as const,
      updatedAt: '2026-08-09T10:00:00.000Z',
      updatedByDeviceId: 'revision-device',
      payload: {
        id,
        authorId: 'local-user',
        title,
        dateBucket: '2026-08-09',
        createdDatetime: '2026-08-09T09:00:00.000Z',
        lastEditedDatetime: '2026-08-09T10:00:00.000Z',
        content: [], tags: [], searchTerms: [], linkedFiles: [], pinnedRegions: [],
      },
    })
    await first.replaceStores({ entries: [envelope('entry-base', 'base')] })
    const staleRevision = await first.getRevision()
    await second.replaceStores({ entries: [envelope('entry-newer', 'newer')] })
    const staleWrite = await first.replaceStoresIfRevision(
      { entries: [envelope('entry-stale', 'stale')] },
      staleRevision,
    )
    return {
      applied: staleWrite.applied,
      revision: await first.getRevision(),
      entryIds: (await first.entries.all()).map((entry) => entry.id),
    }
  })

  expect(result.applied).toBe(false)
  expect(result.revision).toBe(2)
  expect(result.entryIds).toEqual(['entry-newer'])
})
