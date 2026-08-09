import { expect, test } from '@playwright/test'
import type { Attachment, DeviceProfile, Entry } from '../src/domain/types'
import { MemoryBlobStore } from '../src/sync/blobStore'
import { createManifest } from '../src/sync/connectedSync'
import type { JournalSnapshot } from '../src/sync/dataCore'
import {
  DriveTransactionJournal,
  MemoryDriveTransactionPersistence,
} from '../src/sync/driveTransactionJournal'
import {
  MemoryJournalStore,
  entryContentHash,
  syncOnce,
  type SyncEngineMeta,
} from '../src/sync/syncEngine'
import {
  MockSyncProvider,
  type BlobMetadata,
  type ListOptions,
  type PutOptions,
  type RemoteFileRef,
} from '../src/sync/syncProvider'

function device(id = 'transaction-device'): DeviceProfile {
  return {
    id,
    name: 'Transaction test device',
    platform: 'desktop',
    createdAt: '2026-08-09T08:00:00.000Z',
    lastSeenAt: '2026-08-09T08:00:00.000Z',
    appVersion: 'test',
  }
}

function entry(id = 'transaction-entry'): Entry {
  return {
    id,
    authorId: 'local-user',
    title: 'Transactional entry',
    dateBucket: '2026-08-09',
    createdDatetime: '2026-08-09T08:00:00.000Z',
    lastEditedDatetime: '2026-08-09T09:00:00.000Z',
    content: [{ id: `block-${id}`, type: 'paragraph', text: 'planned before any Drive write' }],
    tags: [],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [],
    updatedByDeviceId: 'transaction-device',
    syncStatus: 'queued',
  }
}

function attachment(entryId: string): Attachment {
  return {
    id: 'transaction-attachment',
    entryId,
    type: 'file',
    filename: 'transaction.bin',
    filesize: '18 B',
    storagePath: 'local/transaction.bin',
    contentType: 'application/octet-stream',
    cacheKey: 'transaction-blob',
    syncStatus: 'queued',
    createdAt: '2026-08-09T08:30:00.000Z',
    updatedAt: '2026-08-09T09:00:00.000Z',
  }
}

function snapshot(profile: DeviceProfile, entries: Entry[] = [], attachments: Attachment[] = []): JournalSnapshot {
  return {
    entries: Object.fromEntries(entries.map((item) => [item.id, item])),
    attachments,
    fileBoxItems: [],
    transfers: [],
    conflicts: [],
    tombstones: [],
    device: profile,
  }
}

type RecordedWrite = {
  kind: 'json' | 'blob'
  path: string
  precondition: PutOptions['precondition'] | undefined
  resumableOperationId?: string
}

class RecordingProvider extends MockSyncProvider {
  readonly writes: RecordedWrite[] = []
  failBeforePath = ''
  failAfterPath = ''
  racePath = ''
  switchAccountAfterPath = ''
  reportedAccountScope: string | undefined
  afterWrite?: (path: string) => void | Promise<void>
  private faultUsed = false
  private raceUsed = false

  currentAccountScope() {
    return this.reportedAccountScope
  }

  override async putJson<T>(path: string, value: T, options?: PutOptions): Promise<RemoteFileRef> {
    if (!this.faultUsed && this.failBeforePath === path) {
      this.faultUsed = true
      throw new TypeError(`simulated failure before ${path}`)
    }
    if (!this.raceUsed && this.racePath === path) {
      this.raceUsed = true
      await super.seedJsonForTest(path, { raced: true })
    }
    const remote = await super.putJson(path, value, options)
    this.writes.push({ kind: 'json', path, precondition: options?.precondition, resumableOperationId: options?.resumableOperationId })
    await this.afterWrite?.(path)
    if (this.switchAccountAfterPath === path) this.reportedAccountScope = 'account-b'
    if (!this.faultUsed && this.failAfterPath === path) {
      this.faultUsed = true
      throw new TypeError(`simulated lost response after ${path}`)
    }
    return remote
  }

  override async putBlob(path: string, blob: Blob, metadata: BlobMetadata, options?: PutOptions) {
    if (!this.faultUsed && this.failBeforePath === path) {
      this.faultUsed = true
      throw new TypeError(`simulated failure before ${path}`)
    }
    const remote = await super.putBlob(path, blob, metadata, options)
    this.writes.push({ kind: 'blob', path, precondition: options?.precondition, resumableOperationId: options?.resumableOperationId })
    await this.afterWrite?.(path)
    if (!this.faultUsed && this.failAfterPath === path) {
      this.faultUsed = true
      throw new TypeError(`simulated lost response after ${path}`)
    }
    return remote
  }
}

class ManifestRaceProvider extends RecordingProvider {
  replacementManifest: unknown

  override async listManagedFiles(options: ListOptions = {}) {
    if (this.replacementManifest) {
      const replacement = this.replacementManifest
      this.replacementManifest = undefined
      await this.seedJsonForTest('manifest.json', replacement)
    }
    return super.listManagedFiles(options)
  }
}

class DuplicatePathProvider extends RecordingProvider {
  override async listManagedFiles(options: ListOptions = {}) {
    const files = await super.listManagedFiles(options)
    const target = files.find((file) => file.path.startsWith('entries/'))
    return target ? [...files, { ...target, id: `${target.id}-duplicate` }] : files
  }
}

function journal() {
  const persistence = new MemoryDriveTransactionPersistence()
  return { persistence, journal: new DriveTransactionJournal(persistence) }
}

test('transaction plan gives every write a precondition and publishes manifest last', async () => {
  const provider = new RecordingProvider()
  const profile = device()
  const localEntry = entry()
  const localAttachment = attachment(localEntry.id)
  const localSnapshot = snapshot(profile, [localEntry], [localAttachment])
  localSnapshot.tombstones.push({
    id: 'transaction-delete',
    entityKind: 'transfer',
    entityId: 'old-transfer',
    deletedAt: '2026-08-09T09:30:00.000Z',
    deletedByDeviceId: profile.id,
  })
  const store = new MemoryJournalStore(localSnapshot)
  const blobs = new MemoryBlobStore()
  await blobs.put(localAttachment.cacheKey!, new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' }))
  const operationJournal = journal()

  await syncOnce({
    provider,
    store,
    device: profile,
    blobStore: blobs,
    transactionJournal: operationJournal.journal,
    accountScope: 'account-a',
  })

  expect(provider.writes.every((write) => Boolean(write.precondition))).toBe(true)
  expect(provider.writes[0].path).toMatch(/^tombstones\//)
  expect(provider.writes.at(-1)?.path).toBe('manifest.json')
  const blobIndex = provider.writes.findIndex((write) => write.kind === 'blob')
  const metadataIndex = provider.writes.findIndex((write) => write.path.endsWith('.bin.json'))
  expect(blobIndex).toBeGreaterThanOrEqual(0)
  expect(provider.writes[blobIndex].resumableOperationId).toMatch(/^[0-9a-f]{64}$/)
  expect(metadataIndex).toBeGreaterThan(blobIndex)
  expect(provider.writes.findIndex((write) => write.path.startsWith('devices/'))).toBeLessThan(provider.writes.length - 1)

  const finalSnapshot = await store.getSnapshot()
  expect(finalSnapshot.attachments[0].driveFileId).toMatch(/^mock-file-/)
  expect(finalSnapshot.attachments[0].driveFileId).not.toContain('__easylab')
  expect((await store.getMeta()).lastSyncedAt).toBeTruthy()
  const records = await operationJournal.persistence.list('account-a')
  expect(records).toHaveLength(1)
  expect(records[0].state).toBe('completed')
  expect(records[0].receipts).toHaveLength(records[0].plan.writes.length)
  expect(JSON.stringify(records[0])).not.toMatch(/access.?token|refresh.?token|session.?url|email/i)
})

test('lost JSON response is reconciled after reload without duplicate writes or an early manifest', async () => {
  const provider = new RecordingProvider()
  const profile = device('reload-json-device')
  const localEntry = entry('reload-json-entry')
  const store = new MemoryJournalStore(snapshot(profile, [localEntry]))
  const operationJournal = journal()
  const entryPath = 'entries/2026-08-09.json'
  provider.failAfterPath = entryPath

  await expect(syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-reload-json',
  })).rejects.toThrow(/lost response/i)
  expect((await store.getMeta()).lastSyncedAt).toBeUndefined()
  expect((await provider.listManagedFiles()).some((file) => file.path === 'manifest.json')).toBe(false)
  expect(provider.writes.filter((write) => write.path === entryPath)).toHaveLength(1)

  await syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-reload-json',
  })
  expect(provider.writes.filter((write) => write.path === entryPath)).toHaveLength(1)
  expect(provider.writes.at(-1)?.path).toBe('manifest.json')
  expect((await operationJournal.persistence.list('account-reload-json'))[0].state).toBe('completed')
})

test('lost blob response resumes from its exact receipt and resolves attachment metadata', async () => {
  const provider = new RecordingProvider()
  const profile = device('reload-blob-device')
  const localEntry = entry('reload-blob-entry')
  const localAttachment = attachment(localEntry.id)
  const store = new MemoryJournalStore(snapshot(profile, [localEntry], [localAttachment]))
  const blobs = new MemoryBlobStore()
  await blobs.put(
    localAttachment.cacheKey!,
    new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'application/octet-stream' }),
  )
  const operationJournal = journal()
  const blobPath = 'attachments/2026-08-09/transaction-attachment-transaction.bin'
  provider.failAfterPath = blobPath

  await expect(syncOnce({
    provider, store, device: profile, blobStore: blobs,
    transactionJournal: operationJournal.journal, accountScope: 'account-reload-blob',
  })).rejects.toThrow(/lost response/i)
  expect(provider.writes.filter((write) => write.path === blobPath)).toHaveLength(1)
  expect(provider.writes.find((write) => write.path === blobPath)?.resumableOperationId)
    .toMatch(/^[0-9a-f]{64}$/)
  expect((await provider.listManagedFiles()).some((file) => file.path === 'manifest.json')).toBe(false)

  await syncOnce({
    provider, store, device: profile, blobStore: blobs,
    transactionJournal: operationJournal.journal, accountScope: 'account-reload-blob',
  })
  expect(provider.writes.filter((write) => write.path === blobPath)).toHaveLength(1)
  const metadata = await provider.getJson<{ payload: Attachment }>(`${blobPath}.json`)
  expect(metadata?.value.payload.driveFileId).toBe((await provider.listManagedFiles({ prefix: blobPath }))[0].id)
})

test('lost manifest response reconciles before the local checkpoint is finalized', async () => {
  const provider = new RecordingProvider()
  const profile = device('reload-manifest-device')
  const store = new MemoryJournalStore(snapshot(profile, [entry('reload-manifest-entry')]))
  const operationJournal = journal()
  provider.failAfterPath = 'manifest.json'

  await expect(syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-reload-manifest',
  })).rejects.toThrow(/lost response/i)
  expect((await store.getMeta()).lastSyncedAt).toBeUndefined()
  expect(provider.writes.filter((write) => write.path === 'manifest.json')).toHaveLength(1)

  await syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-reload-manifest',
  })
  expect(provider.writes.filter((write) => write.path === 'manifest.json')).toHaveLength(1)
  expect((await store.getMeta()).lastSyncedAt).toBeTruthy()
})

test('reload after local save but before journal completion finalizes without another remote write', async () => {
  const provider = new RecordingProvider()
  const profile = device('post-save-reload-device')
  const store = new MemoryJournalStore(snapshot(profile, [entry('post-save-reload-entry')]))
  const persistence = new MemoryDriveTransactionPersistence()
  class FailCompletionOnceJournal extends DriveTransactionJournal {
    private failCompletion = true

    override markCompleted(storageScope: string, operationId: string) {
      if (this.failCompletion) {
        this.failCompletion = false
        return Promise.reject(new Error('simulated browser close before journal completion'))
      }
      return super.markCompleted(storageScope, operationId)
    }
  }
  const failingJournal = new FailCompletionOnceJournal(persistence)

  await expect(syncOnce({
    provider, store, device: profile, transactionJournal: failingJournal, accountScope: 'account-post-save',
  })).rejects.toThrow(/browser close/i)
  expect((await store.getMeta()).lastSyncedAt).toBeTruthy()
  const firstWriteCount = provider.writes.length

  const newerStore = new MemoryJournalStore(await store.getSnapshot(), await store.getMeta())
  const newerSnapshot = await newerStore.getSnapshot()
  newerSnapshot.entries['post-save-reload-entry'] = {
    ...newerSnapshot.entries['post-save-reload-entry'],
    title: 'newer writer committed after the original guard was released',
    lastEditedDatetime: '2026-08-09T11:00:00.000Z',
  }
  await newerStore.saveSnapshot(newerSnapshot)
  await syncOnce({
    provider,
    store: newerStore,
    device: profile,
    transactionJournal: journal().journal,
    accountScope: 'account-post-save',
  })
  const writeCountAfterNewerCommit = provider.writes.length
  expect(writeCountAfterNewerCommit).toBeGreaterThan(firstWriteCount)

  const recoveredJournal = new DriveTransactionJournal(persistence)
  provider.reportedAccountScope = 'different-account'
  await expect(syncOnce({
    provider, store, device: profile, transactionJournal: recoveredJournal, accountScope: 'account-post-save',
  })).rejects.toThrow(/account changed/i)
  expect(provider.writes).toHaveLength(writeCountAfterNewerCommit)
  provider.reportedAccountScope = 'account-post-save'
  await syncOnce({
    provider, store, device: profile, transactionJournal: recoveredJournal, accountScope: 'account-post-save',
  })
  expect(provider.writes).toHaveLength(writeCountAfterNewerCommit)
  expect((await persistence.list('account-post-save'))[0].state).toBe('completed')
  const remote = await provider.getJson<{ payload: Entry }>('entries/2026-08-09.json')
  expect(remote?.value.payload.title).toBe('newer writer committed after the original guard was released')
})

test('a local edit made during remote execution is preserved and queued against the committed baseline', async () => {
  const provider = new RecordingProvider()
  const profile = device('in-flight-local-device')
  const localEntry = entry('in-flight-local-entry')
  const store = new MemoryJournalStore(snapshot(profile, [localEntry]))
  const operationJournal = journal()
  let edited = false
  provider.afterWrite = async (path) => {
    if (edited || path !== 'entries/2026-08-09.json') return
    edited = true
    const current = await store.getSnapshot()
    current.entries[localEntry.id] = {
      ...current.entries[localEntry.id],
      title: 'edit typed while upload was running',
      lastEditedDatetime: '2026-08-09T10:00:00.000Z',
    }
    await store.saveSnapshot(current)
  }

  await syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-in-flight-local',
  })
  expect((await store.getSnapshot()).entries[localEntry.id].title).toBe('edit typed while upload was running')

  provider.afterWrite = undefined
  await syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-in-flight-local',
  })
  const remote = await provider.getJson<{ payload: Entry }>('entries/2026-08-09.json')
  expect(remote?.value.payload.title).toBe('edit typed while upload was running')
})

test('a local edit racing the final IndexedDB-style CAS save is merged instead of overwritten', async () => {
  const provider = new RecordingProvider()
  const profile = device('final-cas-device')
  const localEntry = entry('final-cas-entry')
  class FinalSaveRaceStore extends MemoryJournalStore {
    private injectRace = true

    override async saveStateIfRevision(
      committed: JournalSnapshot,
      meta: SyncEngineMeta,
      expectedRevision: number,
    ) {
      if (this.injectRace) {
        this.injectRace = false
        const current = await this.getSnapshot()
        current.entries[localEntry.id] = {
          ...current.entries[localEntry.id],
          title: 'edit committed during final CAS window',
          lastEditedDatetime: '2026-08-09T10:30:00.000Z',
        }
        await this.saveSnapshot(current)
      }
      return super.saveStateIfRevision(committed, meta, expectedRevision)
    }
  }
  const store = new FinalSaveRaceStore(snapshot(profile, [localEntry]))

  await syncOnce({ provider, store, device: profile, accountScope: 'account-final-cas' })
  expect((await store.getSnapshot()).entries[localEntry.id].title).toBe('edit committed during final CAS window')

  await syncOnce({ provider, store, device: profile, accountScope: 'account-final-cas' })
  const remote = await provider.getJson<{ payload: Entry }>('entries/2026-08-09.json')
  expect(remote?.value.payload.title).toBe('edit committed during final CAS window')
})

test('the workspace transaction guard rejects an interleaved writer before either plan can overlap', async () => {
  let firstGuardAcquired!: () => void
  let releaseFirstGuard!: () => void
  const firstGuard = new Promise<void>((resolve) => { firstGuardAcquired = resolve })
  const release = new Promise<void>((resolve) => { releaseFirstGuard = resolve })
  class PausingGuardProvider extends RecordingProvider {
    private paused = false

    override async acquireTransactionGuard(operationId: string) {
      await super.acquireTransactionGuard(operationId)
      if (!this.paused) {
        this.paused = true
        firstGuardAcquired()
        await release
      }
    }
  }
  const provider = new PausingGuardProvider()
  const firstProfile = device('guard-first-device')
  const secondProfile = device('guard-second-device')
  const secondStore = new MemoryJournalStore(snapshot(secondProfile, [entry('guard-second-entry')]))
  const secondJournal = journal()
  const firstSync = syncOnce({
    provider,
    store: new MemoryJournalStore(snapshot(firstProfile, [entry('guard-first-entry')])),
    device: firstProfile,
    transactionJournal: journal().journal,
    accountScope: 'account-shared-guard',
  })
  await firstGuard

  await expect(syncOnce({
    provider,
    store: secondStore,
    device: secondProfile,
    transactionJournal: secondJournal.journal,
    accountScope: 'account-shared-guard',
  })).rejects.toThrow(/workspace guard/i)
  expect(provider.writes).toEqual([])

  releaseFirstGuard()
  await firstSync
  expect(provider.writes.at(-1)?.path).toBe('manifest.json')
  const firstTransactionWriteCount = provider.writes.length

  await expect(syncOnce({
    provider,
    store: secondStore,
    device: secondProfile,
    transactionJournal: secondJournal.journal,
    accountScope: 'account-shared-guard',
  })).rejects.toThrow(/changed after this transaction was planned/i)
  expect(provider.writes).toHaveLength(firstTransactionWriteCount)
})

test('a local edit racing a pulled remote edit creates a pending conflict instead of dropping Drive data', async () => {
  const provider = new RecordingProvider()
  const profile = device('concurrent-merge-device')
  const baseEntry = entry('concurrent-merge-entry')
  const store = new MemoryJournalStore(snapshot(profile, [baseEntry]))
  const operationJournal = journal()
  await syncOnce({ provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-concurrent-merge' })

  const remoteEntry: Entry = {
    ...baseEntry,
    title: 'newer Drive edit',
    lastEditedDatetime: '2026-08-09T10:00:00.000Z',
  }
  await provider.seedJsonForTest('entries/2026-08-09.json', {
    id: remoteEntry.id,
    kind: 'entry',
    version: 1,
    updatedAt: remoteEntry.lastEditedDatetime,
    updatedByDeviceId: 'remote-device',
    payload: remoteEntry,
  })
  await provider.seedJsonForTest('manifest.json', createManifest({
    device: profile,
    entries: { [remoteEntry.id]: remoteEntry },
    attachments: [],
    fileBoxItems: [],
    transfers: [],
  }))
  provider.writes.length = 0
  let localEditInjected = false
  provider.afterWrite = async (path) => {
    if (localEditInjected || !path.startsWith('devices/')) return
    localEditInjected = true
    const current = await store.getSnapshot()
    current.entries[baseEntry.id] = {
      ...current.entries[baseEntry.id],
      title: 'newer local edit',
      lastEditedDatetime: '2026-08-09T11:00:00.000Z',
    }
    await store.saveSnapshot(current)
  }

  await syncOnce({ provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-concurrent-merge' })
  const final = await store.getSnapshot()
  expect(final.entries[baseEntry.id].title).toBe('newer local edit')
  const conflict = final.conflicts.find((candidate) => candidate.entityId === baseEntry.id && candidate.resolution === 'pending')
  expect(conflict).toBeTruthy()
  expect((conflict?.remoteCopy as { value?: Entry }).value?.title).toBe('newer Drive edit')
  expect((await provider.getJson<{ payload: Entry }>('entries/2026-08-09.json'))?.value.payload.title).toBe('newer Drive edit')
})

test('a local edit racing a pulled remote deletion stays visible behind a pending delete conflict', async () => {
  const provider = new RecordingProvider()
  const profile = device('concurrent-delete-device')
  const baseEntry = entry('concurrent-delete-entry')
  const store = new MemoryJournalStore(snapshot(profile, [baseEntry]))
  const operationJournal = journal()
  await syncOnce({ provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-concurrent-delete' })

  const remoteTombstone = {
    id: 'remote-concurrent-delete',
    entityKind: 'entry' as const,
    entityId: baseEntry.id,
    deletedAt: '2026-08-09T10:00:00.000Z',
    deletedByDeviceId: 'remote-delete-device',
  }
  await provider.seedJsonForTest(`tombstones/${remoteTombstone.id}.json`, remoteTombstone)
  await provider.seedJsonForTest('manifest.json', createManifest({
    device: profile,
    entries: {},
    attachments: [],
    fileBoxItems: [],
    transfers: [],
  }))
  provider.writes.length = 0
  let localEditInjected = false
  provider.afterWrite = async (path) => {
    if (localEditInjected || !path.startsWith('devices/')) return
    localEditInjected = true
    const current = await store.getSnapshot()
    current.entries[baseEntry.id] = {
      ...current.entries[baseEntry.id],
      title: 'local edit made while remote deletion was finalizing',
      lastEditedDatetime: '2026-08-09T11:00:00.000Z',
    }
    await store.saveSnapshot(current)
  }

  await syncOnce({ provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-concurrent-delete' })
  const final = await store.getSnapshot()
  expect(final.entries[baseEntry.id].title).toBe('local edit made while remote deletion was finalizing')
  expect(final.tombstones.some((candidate) => candidate.entityKind === 'entry' && candidate.entityId === baseEntry.id)).toBe(false)
  const conflict = final.conflicts.find((candidate) => candidate.entityId === baseEntry.id && candidate.resolution === 'pending')
  const conflictTombstone = (conflict?.remoteCopy as { tombstone?: typeof remoteTombstone }).tombstone
  expect(conflictTombstone?.entityId).toBe(baseEntry.id)
  expect(conflictTombstone?.deletedAt).toBe(remoteTombstone.deletedAt)
})

test('manifest payload and listed CAS identity must come from the same remote version', async () => {
  const provider = new ManifestRaceProvider()
  const profile = device('manifest-race-device')
  await provider.signIn()
  const initialManifest = createManifest({
    device: profile, entries: {}, attachments: [], fileBoxItems: [], transfers: [],
  })
  await provider.seedJsonForTest('manifest.json', initialManifest)
  provider.writes.length = 0
  provider.replacementManifest = {
    ...initialManifest,
    updatedAt: '2026-08-09T10:00:00.000Z',
    devices: [...initialManifest.devices, device('newer-manifest-device')],
  }

  await expect(syncOnce({
    provider,
    store: new MemoryJournalStore(snapshot(profile)),
    device: profile,
    accountScope: 'account-manifest-race',
  })).rejects.toThrow(/manifest identity changed/i)
  expect(provider.writes).toEqual([])
})

test('prerequisite failure suppresses the manifest and recovery preserves a newer local edit', async () => {
  const provider = new RecordingProvider()
  const profile = device('changed-input-device')
  const localEntry = entry('changed-input-entry')
  const store = new MemoryJournalStore(snapshot(profile, [localEntry]))
  const operationJournal = journal()
  provider.failBeforePath = 'entries/2026-08-09.json'

  await expect(syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-changed-input',
  })).rejects.toThrow(/failure before/i)
  expect((await provider.listManagedFiles()).some((file) => file.path === 'manifest.json')).toBe(false)
  const changed = await store.getSnapshot()
  changed.entries[localEntry.id] = { ...changed.entries[localEntry.id], title: 'newer local edit' }
  await store.saveSnapshot(changed)

  await syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-changed-input',
  })
  expect((await provider.listManagedFiles()).some((file) => file.path === 'manifest.json')).toBe(true)
  expect((await store.getSnapshot()).entries[localEntry.id].title).toBe('newer local edit')

  await syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-changed-input',
  })
  const remote = await provider.getJson<{ payload: Entry }>('entries/2026-08-09.json')
  expect(remote?.value.payload.title).toBe('newer local edit')
})

test('an incomplete plan cannot be discovered or resumed from another account scope', async () => {
  const provider = new RecordingProvider()
  const profile = device('account-isolation-device')
  const store = new MemoryJournalStore(snapshot(profile, [entry('account-isolation-entry')]))
  const operationJournal = journal()
  provider.failBeforePath = 'entries/2026-08-09.json'

  await expect(syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-a',
  })).rejects.toThrow()
  expect(await operationJournal.journal.latestIncomplete('account-b')).toBeUndefined()
  expect((await operationJournal.persistence.list('account-a'))).toHaveLength(1)
  expect((await operationJournal.persistence.list('account-b'))).toHaveLength(0)
})

test('account switching during execution blocks remaining writes and manifest publication', async () => {
  const provider = new RecordingProvider()
  const profile = device('account-switch-device')
  const store = new MemoryJournalStore(snapshot(profile, [entry('account-switch-entry')]))
  const operationJournal = journal()
  provider.reportedAccountScope = 'account-a'
  provider.switchAccountAfterPath = 'entries/2026-08-09.json'

  await expect(syncOnce({
    provider, store, device: profile, transactionJournal: operationJournal.journal, accountScope: 'account-a',
  })).rejects.toThrow(/account changed/i)
  expect(provider.writes.map((write) => write.path)).toEqual(['entries/2026-08-09.json'])
  expect((await provider.listManagedFiles()).some((file) => file.path === 'manifest.json')).toBe(false)
  expect((await operationJournal.persistence.list('account-a'))[0].state).toBe('ambiguous')
})

test('missing baselines, count mismatches, duplicate paths, and stale update races fail before manifest publication', async () => {
  const profile = device('blocked-preflight-device')
  const baselineEntry = entry('missing-baseline-entry')
  const baselineMeta: SyncEngineMeta = {
    entryHashes: { [baselineEntry.id]: await entryContentHash(baselineEntry) },
    attachmentHashes: {}, fileBoxHashes: {}, transferHashes: {},
    entryPaths: { [baselineEntry.id]: 'entries/2026-08-09.json' },
  }
  const missingProvider = new RecordingProvider()
  const missingStore = new MemoryJournalStore(snapshot(profile, [baselineEntry]), baselineMeta)
  await expect(syncOnce({ provider: missingProvider, store: missingStore, device: profile, accountScope: 'missing-account' }))
    .rejects.toThrow(/prior baseline is missing/i)
  expect(missingProvider.writes).toEqual([])

  const countProvider = new RecordingProvider()
  await countProvider.signIn()
  await countProvider.seedJsonForTest('manifest.json', {
    ...createManifest({ device: profile, entries: {}, attachments: [], fileBoxItems: [], transfers: [] }),
    entryCount: 1,
  })
  countProvider.writes.length = 0
  await expect(syncOnce({ provider: countProvider, store: new MemoryJournalStore(snapshot(profile)), device: profile, accountScope: 'count-account' }))
    .rejects.toThrow(/manifest counts do not match/i)
  expect(countProvider.writes).toEqual([])

  const duplicateProvider = new DuplicatePathProvider()
  await duplicateProvider.signIn()
  const remoteEntry = entry('duplicate-entry')
  await duplicateProvider.seedJsonForTest('entries/2026-08-09.json', { id: remoteEntry.id, kind: 'entry', version: 1, updatedAt: remoteEntry.lastEditedDatetime, updatedByDeviceId: profile.id, payload: remoteEntry })
  await duplicateProvider.seedJsonForTest('manifest.json', createManifest({
    device: profile, entries: { [remoteEntry.id]: remoteEntry }, attachments: [], fileBoxItems: [], transfers: [],
  }))
  duplicateProvider.writes.length = 0
  await expect(syncOnce({ provider: duplicateProvider, store: new MemoryJournalStore(snapshot(profile)), device: profile, accountScope: 'duplicate-account' }))
    .rejects.toThrow(/duplicated/i)
  expect(duplicateProvider.writes).toEqual([])

  const raceProvider = new RecordingProvider()
  const raceStore = new MemoryJournalStore(snapshot(profile, [entry('race-entry')]))
  await syncOnce({ provider: raceProvider, store: raceStore, device: profile, accountScope: 'race-account' })
  const edited = await raceStore.getSnapshot()
  edited.entries['race-entry'] = { ...edited.entries['race-entry'], title: 'local raced edit', lastEditedDatetime: '2026-08-09T10:00:00.000Z' }
  await raceStore.saveSnapshot(edited)
  raceProvider.writes.length = 0
  raceProvider.racePath = 'entries/2026-08-09.json'
  await expect(syncOnce({ provider: raceProvider, store: raceStore, device: profile, accountScope: 'race-account' }))
    .rejects.toThrow(/identity changed|precondition/i)
  expect(raceProvider.writes.some((write) => write.path === 'manifest.json')).toBe(false)
})
