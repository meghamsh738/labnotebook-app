import { expect, test } from '@playwright/test'
import type { Attachment, DeviceProfile, Entry, TombstoneRecord } from '../src/domain/types'
import { MemoryBlobStore } from '../src/sync/blobStore'
import type { JournalSnapshot } from '../src/sync/dataCore'
import { MemoryJournalStore, syncOnce } from '../src/sync/syncEngine'
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
