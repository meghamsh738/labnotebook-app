import { expect, test } from '@playwright/test'
import type { Attachment, DeviceProfile, Entry, TombstoneRecord } from '../src/domain/types'
import { MemoryBlobStore } from '../src/sync/blobStore'
import type { JournalSnapshot } from '../src/sync/dataCore'
import { MemoryJournalStore, resolveSyncConflict, selectPreferredConflict, syncOnce } from '../src/sync/syncEngine'
import { MockSyncProvider } from '../src/sync/syncProvider'

function device(id: string, name: string): DeviceProfile {
  return {
    id,
    name,
    platform: 'desktop',
    createdAt: '2026-05-23T08:00:00.000Z',
    lastSeenAt: '2026-05-23T08:00:00.000Z',
    appVersion: 'test',
  }
}

function entry(params: { id: string; date: string; text: string; editedAt?: string; deviceId?: string }): Entry {
  return {
    id: params.id,
    authorId: 'user-1',
    title: `Entry ${params.date}`,
    dateBucket: params.date,
    isDaily: true,
    createdDatetime: `${params.date}T08:00:00.000Z`,
    lastEditedDatetime: params.editedAt ?? `${params.date}T09:00:00.000Z`,
    content: [{ id: `block-${params.id}`, type: 'paragraph', text: params.text }],
    tags: [],
    searchTerms: [],
    linkedFiles: [],
    pinnedRegions: [],
    updatedByDeviceId: params.deviceId,
  }
}

function attachment(params: { id: string; entryId: string; filename: string; sha256?: string }): Attachment {
  return {
    id: params.id,
    entryId: params.entryId,
    type: 'file',
    filename: params.filename,
    filesize: '1 KB',
    bytes: 12,
    storagePath: `attachments/${params.filename}`,
    contentType: 'text/plain',
    sha256: params.sha256 ?? 'hash-a',
    syncStatus: 'queued',
    createdAt: '2026-05-23T09:00:00.000Z',
    updatedAt: '2026-05-23T09:00:00.000Z',
  }
}

function snapshot(deviceProfile: DeviceProfile, entries: Entry[] = [], attachments: Attachment[] = []): JournalSnapshot {
  return {
    entries: Object.fromEntries(entries.map((dailyEntry) => [dailyEntry.id, dailyEntry])),
    attachments,
    fileBoxItems: [],
    transfers: [],
    conflicts: [],
    tombstones: [],
    device: deviceProfile,
  }
}

class NamedMockSyncProvider extends MockSyncProvider {
  constructor(private readonly workspaceName: string) {
    super()
  }

  override async ensureWorkspace() {
    await super.ensureWorkspace()
    return { id: 'mock-workspace', rootPath: this.workspaceName }
  }
}

test('mock sync provider lets two devices converge on daily entries', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const laptop = device('dev-laptop', 'Laptop')
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [
    entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'desktop entry', deviceId: desktop.id }),
  ]))
  const laptopStore = new MemoryJournalStore(snapshot(laptop))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  const laptopPull = await syncOnce({ provider, store: laptopStore, device: laptop })
  expect(laptopPull.pulledEntries).toBe(1)

  const laptopSnapshot = await laptopStore.getSnapshot()
  laptopSnapshot.entries['entry-2026-05-24'] = entry({
    id: 'entry-2026-05-24',
    date: '2026-05-24',
    text: 'laptop entry',
    deviceId: laptop.id,
  })
  await laptopStore.saveSnapshot(laptopSnapshot)

  await syncOnce({ provider, store: laptopStore, device: laptop })
  const desktopPull = await syncOnce({ provider, store: desktopStore, device: desktop })
  const finalDesktop = await desktopStore.getSnapshot()

  expect(desktopPull.pulledEntries).toBe(1)
  expect(Object.keys(finalDesktop.entries).sort()).toEqual(['entry-2026-05-23', 'entry-2026-05-24'])
})

test('manifest keeps its creation time and accumulates device history across syncs', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const mobile = device('dev-mobile', 'Mobile')
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [
    entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'desktop entry', deviceId: desktop.id }),
  ]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  const firstManifest = await provider.loadManifest<{
    createdAt: string
    devices: DeviceProfile[]
  }>()
  await syncOnce({ provider, store: mobileStore, device: mobile })
  const secondManifest = await provider.loadManifest<{
    createdAt: string
    devices: DeviceProfile[]
  }>()

  expect(secondManifest?.createdAt).toBe(firstManifest?.createdAt)
  expect(secondManifest?.devices.map((item) => item.id).sort()).toEqual(['dev-desktop', 'dev-mobile'])
})

test('manifest uses the configured workspace name on bootstrap and later syncs', async () => {
  const provider = new NamedMockSyncProvider('Microglia Study Notebook')
  const desktop = device('dev-desktop', 'Desktop')
  const store = new MemoryJournalStore(snapshot(desktop, [
    entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'custom workspace', deviceId: desktop.id }),
  ]))

  await syncOnce({ provider, store, device: desktop })
  await syncOnce({ provider, store, device: desktop })

  await expect(provider.loadManifest<{ rootFolderName: string }>()).resolves.toMatchObject({
    rootFolderName: 'Microglia Study Notebook',
  })
})

test('reserved characters use the same safe Drive path segments as the native contract', async () => {
  const provider = new MockSyncProvider()
  const weirdDevice = device('device/a?b', 'Desktop')
  const dailyEntry = entry({ id: 'entry/path', date: '2026-05-23', text: 'path parity', deviceId: weirdDevice.id })
  const local = snapshot(weirdDevice, [dailyEntry])
  local.fileBoxItems.push({
    id: 'filebox/a?b',
    entryId: dailyEntry.id,
    filename: 'result.csv',
    filesize: '1 KB',
    sourceDeviceId: weirdDevice.id,
    sourceDeviceName: weirdDevice.name,
    status: 'available',
    createdAt: '2026-05-23T09:00:00.000Z',
    updatedAt: '2026-05-23T09:00:00.000Z',
  })
  local.transfers.push({
    id: 'transfer/a?b',
    filename: 'result.csv',
    fromDeviceId: weirdDevice.id,
    fromDeviceName: weirdDevice.name,
    provider: 'google-drive',
    status: 'available',
    createdAt: '2026-05-23T09:00:00.000Z',
    updatedAt: '2026-05-23T09:00:00.000Z',
  })
  local.conflicts.push({
    id: 'conflict/a?b',
    entityKind: 'entry',
    entityId: dailyEntry.id,
    localUpdatedAt: '2026-05-23T09:00:00.000Z',
    remoteUpdatedAt: '2026-05-23T09:01:00.000Z',
    detectedAt: '2026-05-23T09:02:00.000Z',
    resolution: 'pending',
    summary: 'Path parity fixture',
  })
  local.tombstones.push({
    id: 'delete/attachment',
    entityKind: 'attachment',
    entityId: 'attachment/a?b',
    deletedAt: '2026-05-23T09:03:00.000Z',
    deletedByDeviceId: weirdDevice.id,
  })

  await syncOnce({ provider, store: new MemoryJournalStore(local), device: weirdDevice })
  const paths = (await provider.listManagedFiles()).map((file) => file.path).sort()

  expect(paths).toContain('devices/device%2Fa%3Fb.json')
  expect(paths).toContain('filebox/filebox%2Fa%3Fb.json')
  expect(paths).toContain('transfers/transfer%2Fa%3Fb.json')
  expect(paths).toContain('conflicts/conflict%2Fa%3Fb.json')
  expect(paths).toContain('tombstones/attachment--attachment%2Fa%3Fb.json')
  expect(paths.some((path) => path.includes('/a/'))).toBe(false)
})

test('attachment metadata follows its owning daily entry across devices', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const mobile = device('dev-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'has file', deviceId: desktop.id })
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [
    attachment({ id: 'att-raw', entryId: dailyEntry.id, filename: 'raw.csv' }),
  ]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  const mobileSnapshot = await mobileStore.getSnapshot()
  const remoteAttachmentFiles = await provider.listManagedFiles({ prefix: 'attachments/' })

  expect(mobileSnapshot.attachments).toHaveLength(1)
  expect(mobileSnapshot.attachments[0].entryId).toBe(dailyEntry.id)
  expect(remoteAttachmentFiles.map((file) => file.path)).toContain('attachments/2026-05-23/att-raw-raw.csv.json')
})

test('attachment blobs upload to Drive paths and restore into another device cache', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const mobile = device('dev-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'has image', deviceId: desktop.id })
  const desktopBlobStore = new MemoryBlobStore()
  const localBlob = await desktopBlobStore.put('cache-att-image', new Blob(['image bytes'], { type: 'image/png' }))
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [
    {
      ...attachment({ id: 'att-image', entryId: dailyEntry.id, filename: 'image.png', sha256: localBlob.sha256 }),
      cacheKey: localBlob.id,
      contentType: localBlob.mimeType,
    },
  ]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))
  const mobileBlobStore = new MemoryBlobStore()

  const pushed = await syncOnce({ provider, store: desktopStore, device: desktop, blobStore: desktopBlobStore })
  const remoteBlob = await provider.getBlob('attachments/2026-05-23/att-image-image.png')
  const pulled = await syncOnce({ provider, store: mobileStore, device: mobile, blobStore: mobileBlobStore })
  const mobileSnapshot = await mobileStore.getSnapshot()
  const restoredBlob = await mobileBlobStore.get('cache-att-image')

  expect(pushed.uploadedBlobs).toBe(1)
  expect(await remoteBlob?.text()).toBe('image bytes')
  expect(pulled.downloadedBlobs).toBe(1)
  expect(mobileSnapshot.attachments[0]).toMatchObject({
    id: 'att-image',
    cacheKey: 'cache-att-image',
    sha256: localBlob.sha256,
    syncStatus: 'synced',
  })
  expect(await restoredBlob?.text()).toBe('image bytes')
})

test('attachment blobs restore by Drive file id after remote metadata is renamed', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const mobile = device('dev-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'has image', deviceId: desktop.id })
  const desktopBlobStore = new MemoryBlobStore()
  const localBlob = await desktopBlobStore.put('cache-att-image', new Blob(['stable image bytes'], { type: 'image/png' }))
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [{
    ...attachment({ id: 'att-image', entryId: dailyEntry.id, filename: 'original.png', sha256: localBlob.sha256 }),
    cacheKey: localBlob.id,
    contentType: localBlob.mimeType,
  }]))

  await syncOnce({ provider, store: desktopStore, device: desktop, blobStore: desktopBlobStore })
  const metadataPath = 'attachments/2026-05-23/att-image-original.png.json'
  const remoteMetadata = await provider.getJson<{ payload: Attachment }>(metadataPath)
  expect(remoteMetadata?.value.payload.driveFileId).toBeTruthy()
  await provider.putJson(metadataPath, {
    ...remoteMetadata!.value,
    updatedAt: '2026-05-23T12:00:00.000Z',
    payload: {
      ...remoteMetadata!.value.payload,
      filename: 'renamed.png',
      storagePath: 'attachments/renamed.png',
      updatedAt: '2026-05-23T12:00:00.000Z',
    },
  })

  const mobileStore = new MemoryJournalStore(snapshot(mobile))
  const mobileBlobStore = new MemoryBlobStore()
  const pulled = await syncOnce({ provider, store: mobileStore, device: mobile, blobStore: mobileBlobStore })
  const mobileSnapshot = await mobileStore.getSnapshot()

  expect(pulled.downloadedBlobs).toBe(1)
  expect(mobileSnapshot.attachments[0]).toMatchObject({ filename: 'renamed.png', syncStatus: 'synced' })
  expect(await mobileBlobStore.get('cache-att-image').then((blob) => blob?.text())).toBe('stable image bytes')
})

test('a corrupt attachment cache is replaced from the Drive file id', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const mobile = device('dev-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'has image', deviceId: desktop.id })
  const desktopBlobStore = new MemoryBlobStore()
  const localBlob = await desktopBlobStore.put('cache-att-image', new Blob(['trusted image bytes'], { type: 'image/png' }))
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [{
    ...attachment({ id: 'att-image', entryId: dailyEntry.id, filename: 'original.png', sha256: localBlob.sha256 }),
    cacheKey: localBlob.id,
    contentType: localBlob.mimeType,
  }]))

  await syncOnce({ provider, store: desktopStore, device: desktop, blobStore: desktopBlobStore })

  const mobileBlobStore = new MemoryBlobStore()
  await mobileBlobStore.put('cache-att-image', new Blob(['corrupt cache bytes'], { type: 'image/png' }))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))
  const pulled = await syncOnce({ provider, store: mobileStore, device: mobile, blobStore: mobileBlobStore })
  const mobileSnapshot = await mobileStore.getSnapshot()

  expect(pulled.downloadedBlobs).toBe(1)
  expect(mobileSnapshot.attachments[0]).toMatchObject({ id: 'att-image', syncStatus: 'synced' })
  expect(await mobileBlobStore.get('cache-att-image').then((blob) => blob?.text())).toBe('trusted image bytes')
})

test('a synced attachment with a stale cached hash is verified and repaired from Drive', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-stale-cache-desktop', 'Desktop')
  const mobile = device('dev-stale-cache-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-stale-cache', date: '2026-05-23', text: 'cache repair', deviceId: desktop.id })
  const desktopBlobStore = new MemoryBlobStore()
  const trusted = await desktopBlobStore.put('cache-att-stale', new Blob(['trusted'], { type: 'text/plain' }))
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [{
    ...attachment({ id: 'att-stale-cache', entryId: dailyEntry.id, filename: 'result.txt', sha256: trusted.sha256 }),
    cacheKey: trusted.id,
    contentType: trusted.mimeType,
  }]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))
  const mobileBlobStore = new MemoryBlobStore()

  await syncOnce({ provider, store: desktopStore, device: desktop, blobStore: desktopBlobStore })
  await syncOnce({ provider, store: mobileStore, device: mobile, blobStore: mobileBlobStore })

  await mobileBlobStore.put('cache-att-stale', new Blob(['corrupt'], { type: 'text/plain' }))
  const staleRecord = await mobileBlobStore.getRecord('cache-att-stale')
  expect(staleRecord).toBeTruthy()
  mobileBlobStore.getRecord = async (key: string) => key === 'cache-att-stale' && staleRecord
    ? { ...staleRecord, sha256: trusted.sha256 }
    : undefined

  const result = await syncOnce({ provider, store: mobileStore, device: mobile, blobStore: mobileBlobStore })
  const repaired = await mobileBlobStore.get('cache-att-stale')
  const finalMobile = await mobileStore.getSnapshot()

  expect(result.downloadedBlobs).toBe(1)
  expect(await repaired?.text()).toBe('trusted')
  expect(finalMobile.attachments[0]).toMatchObject({
    id: 'att-stale-cache',
    cacheKey: 'cache-att-stale',
    sha256: trusted.sha256,
    syncStatus: 'synced',
  })
})

test('an upload publishes the verified blob hash instead of stale cache metadata', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-stale-upload-hash', 'Desktop')
  const dailyEntry = entry({
    id: 'entry-stale-upload-hash',
    date: '2026-05-23',
    text: 'verified upload metadata',
    deviceId: desktop.id,
  })
  const blobStore = new MemoryBlobStore()
  const trusted = await blobStore.put('cache-att-stale-upload', new Blob(['trusted upload'], { type: 'text/plain' }))
  const staleSha256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  const originalGetRecord = blobStore.getRecord.bind(blobStore)
  blobStore.getRecord = async (key: string) => {
    const record = await originalGetRecord(key)
    return record ? { ...record, sha256: staleSha256 } : undefined
  }
  const store = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [{
    ...attachment({
      id: 'att-stale-upload-hash',
      entryId: dailyEntry.id,
      filename: 'result.txt',
      sha256: trusted.sha256,
    }),
    cacheKey: trusted.id,
    contentType: trusted.mimeType,
  }]))

  const result = await syncOnce({ provider, store, device: desktop, blobStore })
  const finalSnapshot = await store.getSnapshot()
  const remoteBlob = (await provider.listManagedFiles({ prefix: 'attachments/' }))
    .find((file) => file.appProperties?.entityType === 'attachmentBlob')

  expect(result.uploadedBlobs).toBe(1)
  expect(finalSnapshot.attachments[0]).toMatchObject({
    id: 'att-stale-upload-hash',
    sha256: trusted.sha256,
    syncStatus: 'synced',
  })
  expect(finalSnapshot.attachments[0].sha256).not.toBe(staleSha256)
  expect(remoteBlob?.appProperties?.sha256).toBe(trusted.sha256)
})

test('corrupt local attachment blobs remain failed and are not uploaded as synced metadata', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const dailyEntry = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'has corrupt file', deviceId: desktop.id })
  const blobStore = new MemoryBlobStore()
  const localBlob = await blobStore.put('cache-att-corrupt', new Blob(['corrupt bytes'], { type: 'text/plain' }))
  const store = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [{
    ...attachment({
      id: 'att-corrupt',
      entryId: dailyEntry.id,
      filename: 'corrupt.txt',
      sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    }),
    cacheKey: localBlob.id,
  }]))

  const result = await syncOnce({ provider, store, device: desktop, blobStore })
  const finalSnapshot = await store.getSnapshot()
  const remoteAttachmentFiles = await provider.listManagedFiles({ prefix: 'attachments/' })

  expect(result.uploadedBlobs).toBe(0)
  expect(result.pushedAttachments).toBe(0)
  expect(finalSnapshot.attachments[0]).toMatchObject({
    id: 'att-corrupt',
    syncStatus: 'failed',
  })
  expect(finalSnapshot.attachments[0].driveFileId).toBeUndefined()
  expect(remoteAttachmentFiles).toEqual([])
})

test('attachment metadata can sync without downloading remote blobs', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const mobile = device('dev-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'has image', deviceId: desktop.id })
  const desktopBlobStore = new MemoryBlobStore()
  const localBlob = await desktopBlobStore.put('cache-att-image', new Blob(['image bytes'], { type: 'image/png' }))
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [
    {
      ...attachment({ id: 'att-image', entryId: dailyEntry.id, filename: 'image.png', sha256: localBlob.sha256 }),
      cacheKey: localBlob.id,
      contentType: localBlob.mimeType,
    },
  ]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))
  const mobileBlobStore = new MemoryBlobStore()

  await syncOnce({ provider, store: desktopStore, device: desktop, blobStore: desktopBlobStore })
  const pulled = await syncOnce({
    provider,
    store: mobileStore,
    device: mobile,
    blobStore: mobileBlobStore,
    downloadRemoteBlobs: false,
  })
  const mobileSnapshot = await mobileStore.getSnapshot()
  const restoredBlob = await mobileBlobStore.get('cache-att-image')

  expect(pulled.downloadedBlobs).toBe(0)
  expect(mobileSnapshot.attachments[0]).toMatchObject({
    id: 'att-image',
    sha256: localBlob.sha256,
    syncStatus: 'remote-available',
  })
  expect(mobileSnapshot.attachments[0].cacheKey).toBeUndefined()
  expect(restoredBlob).toBeUndefined()
})

test('same-day competing edits create a conflict and keep the local copy visible', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const mobile = device('dev-mobile', 'Mobile')
  const baseline = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'baseline', deviceId: desktop.id })
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [baseline]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })

  const desktopSnapshot = await desktopStore.getSnapshot()
  desktopSnapshot.entries[baseline.id] = entry({
    id: baseline.id,
    date: baseline.dateBucket,
    text: 'desktop edit',
    editedAt: '2026-05-23T10:00:00.000Z',
    deviceId: desktop.id,
  })
  await desktopStore.saveSnapshot(desktopSnapshot)
  await syncOnce({ provider, store: desktopStore, device: desktop })

  const mobileSnapshot = await mobileStore.getSnapshot()
  mobileSnapshot.entries[baseline.id] = entry({
    id: baseline.id,
    date: baseline.dateBucket,
    text: 'mobile edit',
    editedAt: '2026-05-23T10:05:00.000Z',
    deviceId: mobile.id,
  })
  await mobileStore.saveSnapshot(mobileSnapshot)
  const result = await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()
  const conflicts = await provider.listManagedFiles({ prefix: 'conflicts/' })

  expect(result.conflicts).toBe(1)
  expect(finalMobile.entries[baseline.id].content[0]).toMatchObject({ text: 'mobile edit' })
  expect(finalMobile.conflicts[0]).toMatchObject({ entityKind: 'entry', entityId: baseline.id, resolution: 'pending' })
  expect(conflicts.map((file) => file.path)).toEqual(['conflicts/conf-entry-entry-2026-05-23.json'])
})

test('concurrent conflict resolutions choose the same deterministic winner regardless of listing order', () => {
  const base = {
    id: 'conf-entry-entry-1',
    entityKind: 'entry' as const,
    entityId: 'entry-1',
    localUpdatedAt: '2026-05-23T10:00:00.000Z',
    remoteUpdatedAt: '2026-05-23T10:00:00.000Z',
    detectedAt: '2026-05-23T09:00:00.000Z',
    summary: 'Concurrent resolution',
  }
  const localWon = { ...base, resolution: 'local-won' as const, localCopy: { value: 'local' } }
  const remoteWon = { ...base, resolution: 'remote-won' as const, remoteCopy: { value: 'remote' } }

  const forward = selectPreferredConflict(localWon, remoteWon)
  const reverse = selectPreferredConflict(remoteWon, localWon)

  expect(forward).toEqual(reverse)
  expect(forward.resolution).not.toBe('pending')
})

test('a newer pending conflict generation outranks an older resolution', () => {
  const oldResolution = {
    id: 'conf-entry-entry-1',
    entityKind: 'entry' as const,
    entityId: 'entry-1',
    localUpdatedAt: '2026-05-23T10:00:00.000Z',
    remoteUpdatedAt: '2026-05-23T10:05:00.000Z',
    detectedAt: '2026-05-23T10:06:00.000Z',
    resolution: 'local-won' as const,
    summary: 'Old resolved generation',
    localCopy: { hash: 'old-local' },
    remoteCopy: { hash: 'old-remote' },
  }
  const newGeneration = {
    ...oldResolution,
    localUpdatedAt: '2026-05-23T11:00:00.000Z',
    remoteUpdatedAt: '2026-05-23T11:05:00.000Z',
    detectedAt: '2026-05-23T11:06:00.000Z',
    resolution: 'pending' as const,
    summary: 'New pending generation',
    localCopy: { hash: 'new-local' },
    remoteCopy: { hash: 'new-remote' },
  }

  expect(selectPreferredConflict(oldResolution, newGeneration)).toEqual(newGeneration)
  expect(selectPreferredConflict(newGeneration, oldResolution)).toEqual(newGeneration)
})

test('entry tombstones prevent stale Drive JSON from resurrecting deleted days', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-desktop', 'Desktop')
  const laptop = device('dev-laptop', 'Laptop')
  const dailyEntry = entry({ id: 'entry-2026-05-23', date: '2026-05-23', text: 'delete me', deviceId: desktop.id })
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry]))
  const laptopStore = new MemoryJournalStore(snapshot(laptop))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: laptopStore, device: laptop })

  const tombstone: TombstoneRecord = {
    id: `del-entry-${dailyEntry.id}`,
    entityKind: 'entry',
    entityId: dailyEntry.id,
    deletedAt: '2026-05-23T11:00:00.000Z',
    deletedByDeviceId: desktop.id,
    reason: 'Deleted on desktop',
  }
  const desktopSnapshot = await desktopStore.getSnapshot()
  delete desktopSnapshot.entries[dailyEntry.id]
  desktopSnapshot.tombstones.push(tombstone)
  await desktopStore.saveSnapshot(desktopSnapshot)
  await syncOnce({ provider, store: desktopStore, device: desktop })

  await syncOnce({ provider, store: laptopStore, device: laptop })
  const finalLaptop = await laptopStore.getSnapshot()
  const remoteTombstones = await provider.listManagedFiles({ prefix: 'tombstones/' })

  expect(finalLaptop.entries[dailyEntry.id]).toBeUndefined()
  expect(finalLaptop.tombstones).toContainEqual(tombstone)
  expect(remoteTombstones.map((file) => file.path)).toEqual(['tombstones/entry--entry-2026-05-23.json'])
})

test('pulls Drive conflict records into a device that did not detect the conflict', async () => {
  const provider = new MockSyncProvider()
  const laptop = device('dev-laptop', 'Laptop')
  const laptopStore = new MemoryJournalStore(snapshot(laptop))
  const remoteConflict = {
    id: 'conf-entry-remote-only',
    entityKind: 'entry' as const,
    entityId: 'entry-remote-only',
    localUpdatedAt: '2026-05-23T10:00:00.000Z',
    remoteUpdatedAt: '2026-05-23T10:01:00.000Z',
    detectedAt: '2026-05-23T10:02:00.000Z',
    resolution: 'pending' as const,
    summary: 'Conflict detected on another device.',
    localCopy: { text: 'desktop' },
    remoteCopy: { text: 'mobile' },
  }

  await provider.signIn()
  await provider.putJson(`conflicts/${remoteConflict.id}.json`, remoteConflict)
  const result = await syncOnce({ provider, store: laptopStore, device: laptop })
  const finalLaptop = await laptopStore.getSnapshot()

  expect(result.conflicts).toBe(1)
  expect(finalLaptop.conflicts).toEqual([remoteConflict])
})

test('attachment, File Box, and transfer tombstones remove their exact v1 entities', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-delete-desktop', 'Desktop')
  const mobile = device('dev-delete-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-delete-kinds', date: '2026-05-23', text: 'linked data', deviceId: desktop.id })
  dailyEntry.linkedFiles = ['att-delete']
  dailyEntry.pinnedRegions = [{
    id: 'region-delete',
    entryId: dailyEntry.id,
    label: 'Delete links',
    blockIds: [`block-${dailyEntry.id}`],
    linkedAttachments: ['att-delete'],
  }]
  const desktopSnapshot = snapshot(desktop, [dailyEntry], [
    attachment({ id: 'att-delete', entryId: dailyEntry.id, filename: 'delete.csv' }),
  ])
  desktopSnapshot.fileBoxItems.push({
    id: 'filebox-delete',
    entryId: dailyEntry.id,
    filename: 'inbox.csv',
    filesize: '1 KB',
    sourceDeviceId: desktop.id,
    sourceDeviceName: desktop.name,
    status: 'available',
    createdAt: '2026-05-23T09:00:00.000Z',
    updatedAt: '2026-05-23T09:00:00.000Z',
  })
  desktopSnapshot.transfers.push({
    id: 'transfer-delete',
    filename: 'history.csv',
    fromDeviceId: desktop.id,
    fromDeviceName: desktop.name,
    provider: 'google-drive',
    status: 'available',
    createdAt: '2026-05-23T09:00:00.000Z',
    updatedAt: '2026-05-23T09:00:00.000Z',
  })
  const desktopStore = new MemoryJournalStore(desktopSnapshot)
  const mobileStore = new MemoryJournalStore(snapshot(mobile))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })

  const deletingSnapshot = await desktopStore.getSnapshot()
  deletingSnapshot.attachments = []
  deletingSnapshot.fileBoxItems = []
  deletingSnapshot.transfers = []
  deletingSnapshot.tombstones.push(
    { id: 'del-att-delete', entityKind: 'attachment', entityId: 'att-delete', deletedAt: '2026-05-23T11:00:00.000Z', deletedByDeviceId: desktop.id },
    { id: 'del-filebox-delete', entityKind: 'fileBoxItem', entityId: 'filebox-delete', deletedAt: '2026-05-23T11:01:00.000Z', deletedByDeviceId: desktop.id },
    { id: 'del-transfer-delete', entityKind: 'transfer', entityId: 'transfer-delete', deletedAt: '2026-05-23T11:02:00.000Z', deletedByDeviceId: desktop.id },
  )
  await desktopStore.saveSnapshot(deletingSnapshot)
  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()

  expect(finalMobile.attachments).toEqual([])
  expect(finalMobile.fileBoxItems).toEqual([])
  expect(finalMobile.transfers).toEqual([])
  expect(finalMobile.entries[dailyEntry.id].linkedFiles).toEqual([])
  expect(finalMobile.entries[dailyEntry.id].pinnedRegions[0].linkedAttachments).toEqual([])
  expect(finalMobile.tombstones.map((record) => record.entityKind).sort()).toEqual(['attachment', 'fileBoxItem', 'transfer'])
})

test('remote attachment delete versus local edit keeps the local copy in a pending conflict', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-delete-desktop', 'Desktop')
  const mobile = device('dev-edit-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-delete-edit', date: '2026-05-23', text: 'linked data', deviceId: desktop.id })
  const baselineAttachment = attachment({ id: 'att-delete-edit', entryId: dailyEntry.id, filename: 'baseline.csv' })
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [baselineAttachment]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })

  const deletingSnapshot = await desktopStore.getSnapshot()
  deletingSnapshot.attachments = []
  deletingSnapshot.tombstones.push({
    id: 'del-att-delete-edit',
    entityKind: 'attachment',
    entityId: baselineAttachment.id,
    deletedAt: '2026-05-23T11:00:00.000Z',
    deletedByDeviceId: desktop.id,
  })
  await desktopStore.saveSnapshot(deletingSnapshot)
  await syncOnce({ provider, store: desktopStore, device: desktop })

  const editedSnapshot = await mobileStore.getSnapshot()
  editedSnapshot.attachments[0] = {
    ...editedSnapshot.attachments[0],
    filename: 'mobile-edit.csv',
    updatedAt: '2026-05-23T11:01:00.000Z',
  }
  await mobileStore.saveSnapshot(editedSnapshot)
  const result = await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()

  expect(result.pushedAttachments).toBe(0)
  expect(finalMobile.attachments[0].filename).toBe('mobile-edit.csv')
  expect(finalMobile.tombstones).toEqual([])
  expect(finalMobile.conflicts).toContainEqual(expect.objectContaining({
    entityKind: 'attachment',
    entityId: baselineAttachment.id,
    resolution: 'pending',
  }))
})

test('first sync with differing same-id entries creates a conflict instead of overwriting local data', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-no-base-desktop', 'Desktop')
  const mobile = device('dev-no-base-mobile', 'Mobile')
  const remoteEntry = entry({ id: 'entry-no-base', date: '2026-05-23', text: 'remote first', deviceId: desktop.id })
  const localEntry = entry({ id: 'entry-no-base', date: '2026-05-23', text: 'local first', deviceId: mobile.id })
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [remoteEntry]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile, [localEntry]))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  const result = await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()

  expect(result.pulledEntries).toBe(0)
  expect(result.pushedEntries).toBe(0)
  expect(finalMobile.entries[localEntry.id].content[0]).toMatchObject({ text: 'local first' })
  expect(finalMobile.conflicts).toContainEqual(expect.objectContaining({
    id: 'conf-entry-entry-no-base',
    entityKind: 'entry',
    resolution: 'pending',
  }))
})

test('first sync conflicts for differing attachment, File Box, and transfer ids', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-no-base-entities-desktop', 'Desktop')
  const mobile = device('dev-no-base-entities-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-no-base-entities', date: '2026-05-23', text: 'shared', deviceId: desktop.id })
  const remoteSnapshot = snapshot(desktop, [dailyEntry], [
    attachment({ id: 'att-no-base', entryId: dailyEntry.id, filename: 'remote.csv' }),
  ])
  remoteSnapshot.fileBoxItems.push({
    id: 'filebox-no-base', entryId: dailyEntry.id, filename: 'remote.csv', filesize: '1 KB',
    sourceDeviceId: desktop.id, sourceDeviceName: desktop.name, status: 'available',
    createdAt: '2026-05-23T09:00:00.000Z', updatedAt: '2026-05-23T09:00:00.000Z',
  })
  remoteSnapshot.transfers.push({
    id: 'transfer-no-base', filename: 'remote.csv', fromDeviceId: desktop.id, fromDeviceName: desktop.name,
    provider: 'google-drive', status: 'available', createdAt: '2026-05-23T09:00:00.000Z', updatedAt: '2026-05-23T09:00:00.000Z',
  })
  const localEntry = { ...dailyEntry, updatedByDeviceId: mobile.id }
  const localSnapshot = snapshot(mobile, [localEntry], [
    attachment({ id: 'att-no-base', entryId: dailyEntry.id, filename: 'local.csv' }),
  ])
  localSnapshot.fileBoxItems.push({
    ...remoteSnapshot.fileBoxItems[0], filename: 'local.csv', sourceDeviceId: mobile.id, sourceDeviceName: mobile.name,
  })
  localSnapshot.transfers.push({
    ...remoteSnapshot.transfers[0], filename: 'local.csv', fromDeviceId: mobile.id, fromDeviceName: mobile.name,
  })
  const desktopStore = new MemoryJournalStore(remoteSnapshot)
  const mobileStore = new MemoryJournalStore(localSnapshot)

  await syncOnce({ provider, store: desktopStore, device: desktop })
  const result = await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()

  expect(result.pushedAttachments).toBe(0)
  expect(finalMobile.attachments[0].filename).toBe('local.csv')
  expect(finalMobile.fileBoxItems[0].filename).toBe('local.csv')
  expect(finalMobile.transfers[0].filename).toBe('local.csv')
  expect(finalMobile.conflicts.filter((conflict) => conflict.resolution === 'pending').map((conflict) => conflict.entityKind).sort())
    .toEqual(['attachment', 'fileBoxItem', 'transfer'])
})

test('resolved entry conflict is applied durably and does not reopen on sync-again', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-resolve-desktop', 'Desktop')
  const mobile = device('dev-resolve-mobile', 'Mobile')
  const remoteEntry = entry({ id: 'entry-resolve', date: '2026-05-23', text: 'remote version', deviceId: desktop.id })
  const localEntry = entry({ id: 'entry-resolve', date: '2026-05-23', text: 'local version', deviceId: mobile.id })
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [remoteEntry]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile, [localEntry]))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await resolveSyncConflict({
    store: mobileStore,
    device: mobile,
    conflictId: 'conf-entry-entry-resolve',
    resolution: 'local-won',
  })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()
  const remote = await provider.getJson<{ payload: Entry }>('entries/2026-05-23.json')

  expect(finalMobile.entries[localEntry.id].content[0]).toMatchObject({ text: 'local version' })
  expect(finalMobile.conflicts).toHaveLength(1)
  expect(finalMobile.conflicts[0].resolution).toBe('local-won')
  expect(remote?.value.payload.content[0]).toMatchObject({ text: 'local version' })
})

test('two devices converge after resolution and preserve a later conflict generation across repeated syncs', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-generation-desktop', 'Desktop')
  const mobile = device('dev-generation-mobile', 'Mobile')
  const entityId = 'entry-conflict-generation'
  const conflictId = `conf-entry-${entityId}`
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [
    entry({ id: entityId, date: '2026-05-23', text: 'desktop first version', deviceId: desktop.id }),
  ]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile, [
    entry({ id: entityId, date: '2026-05-23', text: 'mobile first version', deviceId: mobile.id }),
  ]))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await resolveSyncConflict({
    store: mobileStore,
    device: mobile,
    conflictId,
    resolution: 'local-won',
  })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })

  const convergedDesktop = await desktopStore.getSnapshot()
  const convergedMobile = await mobileStore.getSnapshot()
  expect(convergedDesktop.entries[entityId].content[0]).toMatchObject({ text: 'mobile first version' })
  expect(convergedMobile.entries[entityId].content[0]).toMatchObject({ text: 'mobile first version' })
  expect(convergedDesktop.conflicts.find((conflict) => conflict.id === conflictId)?.resolution).toBe('local-won')
  expect(convergedMobile.conflicts.find((conflict) => conflict.id === conflictId)?.resolution).toBe('local-won')

  convergedDesktop.entries[entityId] = entry({
    id: entityId,
    date: '2026-05-23',
    text: 'desktop second version',
    editedAt: '2026-07-13T10:00:00.000Z',
    deviceId: desktop.id,
  })
  convergedMobile.entries[entityId] = entry({
    id: entityId,
    date: '2026-05-23',
    text: 'mobile second version',
    editedAt: '2026-07-13T10:01:00.000Z',
    deviceId: mobile.id,
  })
  await desktopStore.saveSnapshot(convergedDesktop)
  await mobileStore.saveSnapshot(convergedMobile)

  await syncOnce({ provider, store: mobileStore, device: mobile })
  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await syncOnce({ provider, store: desktopStore, device: desktop })

  const finalDesktop = await desktopStore.getSnapshot()
  const finalMobile = await mobileStore.getSnapshot()
  const desktopConflict = finalDesktop.conflicts.find((conflict) => conflict.id === conflictId)
  const mobileConflict = finalMobile.conflicts.find((conflict) => conflict.id === conflictId)

  expect(finalDesktop.entries[entityId].content[0]).toMatchObject({ text: 'desktop second version' })
  expect(finalMobile.entries[entityId].content[0]).toMatchObject({ text: 'mobile second version' })
  expect(desktopConflict?.resolution).toBe('pending')
  expect(mobileConflict?.resolution).toBe('pending')
  expect(desktopConflict?.localUpdatedAt).toBe('2026-07-13T10:00:00.000Z')
  expect(desktopConflict?.remoteUpdatedAt).toBe('2026-07-13T10:01:00.000Z')
})

test('non-entry conflict resolutions apply entity behavior and remain resolved after sync-again', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-resolve-entities-desktop', 'Desktop')
  const mobile = device('dev-resolve-entities-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-resolve-entities', date: '2026-05-23', text: 'shared', deviceId: desktop.id })
  const remoteSnapshot = snapshot(desktop, [dailyEntry], [attachment({ id: 'att-resolve', entryId: dailyEntry.id, filename: 'remote.csv' })])
  remoteSnapshot.fileBoxItems.push({
    id: 'filebox-resolve', entryId: dailyEntry.id, filename: 'remote.csv', filesize: '1 KB',
    sourceDeviceId: desktop.id, sourceDeviceName: desktop.name, status: 'available',
    createdAt: '2026-05-23T09:00:00.000Z', updatedAt: '2026-05-23T09:00:00.000Z',
  })
  remoteSnapshot.transfers.push({
    id: 'transfer-resolve', filename: 'remote.csv', fromDeviceId: desktop.id, fromDeviceName: desktop.name,
    provider: 'google-drive', status: 'available', createdAt: '2026-05-23T09:00:00.000Z', updatedAt: '2026-05-23T09:00:00.000Z',
  })
  const localSnapshot = snapshot(mobile, [{ ...dailyEntry, updatedByDeviceId: mobile.id }], [attachment({ id: 'att-resolve', entryId: dailyEntry.id, filename: 'local.csv' })])
  localSnapshot.fileBoxItems.push({ ...remoteSnapshot.fileBoxItems[0], filename: 'local.csv' })
  localSnapshot.transfers.push({ ...remoteSnapshot.transfers[0], filename: 'local.csv' })
  const desktopStore = new MemoryJournalStore(remoteSnapshot)
  const mobileStore = new MemoryJournalStore(localSnapshot)

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await resolveSyncConflict({ store: mobileStore, device: mobile, conflictId: 'conf-attachment-att-resolve', resolution: 'remote-won' })
  await resolveSyncConflict({ store: mobileStore, device: mobile, conflictId: 'conf-fileBoxItem-filebox-resolve', resolution: 'local-won' })
  const kept = await resolveSyncConflict({ store: mobileStore, device: mobile, conflictId: 'conf-transfer-transfer-resolve', resolution: 'kept-copy' })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()

  expect(finalMobile.attachments.find((item) => item.id === 'att-resolve')?.filename).toBe('remote.csv')
  expect(finalMobile.fileBoxItems.find((item) => item.id === 'filebox-resolve')?.filename).toBe('local.csv')
  expect(finalMobile.transfers.find((item) => item.id === 'transfer-resolve')?.filename).toBe('local.csv')
  expect(finalMobile.transfers.find((item) => item.id === kept.copiedEntityId)?.filename).toBe('remote.csv')
  expect(finalMobile.conflicts.map((conflict) => conflict.resolution).sort()).toEqual(['kept-copy', 'local-won', 'remote-won'])
})

test('local-won remote-delete resolution revives an attachment without reopening the conflict', async () => {
  const provider = new MockSyncProvider()
  const desktop = device('dev-resolve-delete-desktop', 'Desktop')
  const mobile = device('dev-resolve-delete-mobile', 'Mobile')
  const dailyEntry = entry({ id: 'entry-resolve-delete', date: '2026-05-23', text: 'linked', deviceId: desktop.id })
  const baseline = attachment({ id: 'att-resolve-delete', entryId: dailyEntry.id, filename: 'baseline.csv' })
  const desktopStore = new MemoryJournalStore(snapshot(desktop, [dailyEntry], [baseline]))
  const mobileStore = new MemoryJournalStore(snapshot(mobile))

  await syncOnce({ provider, store: desktopStore, device: desktop })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  const deleting = await desktopStore.getSnapshot()
  deleting.attachments = []
  deleting.tombstones.push({
    id: 'del-att-resolve-delete', entityKind: 'attachment', entityId: baseline.id,
    deletedAt: '2026-05-23T11:00:00.000Z', deletedByDeviceId: desktop.id,
  })
  await desktopStore.saveSnapshot(deleting)
  await syncOnce({ provider, store: desktopStore, device: desktop })
  const editing = await mobileStore.getSnapshot()
  editing.attachments[0] = { ...editing.attachments[0], filename: 'revived.csv', updatedAt: '2026-05-23T11:01:00.000Z' }
  await mobileStore.saveSnapshot(editing)
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await resolveSyncConflict({
    store: mobileStore,
    device: mobile,
    conflictId: 'conf-attachment-att-resolve-delete',
    resolution: 'local-won',
  })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await syncOnce({ provider, store: mobileStore, device: mobile })
  await syncOnce({ provider, store: desktopStore, device: desktop })
  const revivedDesktop = await desktopStore.getSnapshot()
  revivedDesktop.attachments[0] = {
    ...revivedDesktop.attachments[0],
    filename: 'edited-after-revival.csv',
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  }
  await desktopStore.saveSnapshot(revivedDesktop)
  await syncOnce({ provider, store: desktopStore, device: desktop })
  const remoteAfterEdit = await provider.getJson<{ payload: Attachment }>('attachments/2026-05-23/att-resolve-delete-edited-after-revival.csv.json')
  expect(remoteAfterEdit?.value.payload.filename).toBe('edited-after-revival.csv')
  await syncOnce({ provider, store: mobileStore, device: mobile })
  const finalMobile = await mobileStore.getSnapshot()

  expect(finalMobile.attachments.find((item) => item.id === baseline.id)?.filename).toBe('edited-after-revival.csv')
  expect((await desktopStore.getSnapshot()).tombstones).toEqual([])
  expect(finalMobile.conflicts).toContainEqual(expect.objectContaining({
    id: 'conf-attachment-att-resolve-delete', resolution: 'local-won',
  }))
  expect(finalMobile.conflicts.filter((conflict) => conflict.resolution === 'pending')).toEqual([])
})
