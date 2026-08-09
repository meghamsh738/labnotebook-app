import { expect, test } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Attachment, DeviceProfile, Entry, FileBoxItem, SyncEntityEnvelope, TombstoneRecord, TransferRecord } from '../src/domain/types'
import { createManifest } from '../src/sync/connectedSync'
import {
  applyTombstonesToSnapshot,
  buildAttachmentDrivePath,
  buildAttachmentEnvelope,
  buildEntryDriveFileName,
  buildEntryEnvelope,
  canonicalTombstoneId,
  effectiveDeletedTargetSets,
  projectAttachmentPayload,
  projectEntryPayload,
  projectFileBoxPayload,
  safeDriveSegment,
} from '../src/sync/dataCore'
import { journalDbNameForScope } from '../src/sync/repositories'
import {
  attachmentMetadataHash,
  buildFileBoxEnvelope,
  buildTransferEnvelope,
  entryContentHash,
  fileBoxMetadataHash,
  transferMetadataHash,
} from '../src/sync/syncEngine'
import {
  validateAttachmentEnvelope,
  validateConflict,
  validateDevice,
  validateEntryEnvelope,
  validateFileBoxEnvelope,
  validateManifest,
  validateTombstone,
  validateTransferEnvelope,
  type ValidationResult,
} from '../src/sync/schemas'

const contractRoot = fileURLToPath(new URL('../../contracts/drive-v1/', import.meta.url))
const parityContractRoot = fileURLToPath(new URL('../../contracts/drive-v1-parity/', import.meta.url))
const expectedJsonPaths = [
  'attachments/2026-05-23/att-contract-result.csv.json',
  'conflicts/conf-entry-entry-contract.json',
  'devices/dev-contract.json',
  'entries/2026-05-23.json',
  'filebox/filebox-contract.json',
  'manifest.json',
  'tombstones/attachment--att-deleted.json',
  'transfers/transfer-contract.json',
]

async function readFixture(relativePath: string) {
  return JSON.parse(await readFile(path.join(contractRoot, relativePath), 'utf8')) as unknown
}

type OfflineRoundTripFixture = {
  liveDriveUsed: boolean
  productionWritesEnabled: boolean
  androidOrigin: {
    entryPath: string
    attachmentBlobPath: string
    attachmentMetadataPath: string
    entryContentHash: string
    attachmentMetadataHash: string
    manifestCounts: Record<'entryCount' | 'attachmentCount' | 'fileBoxCount' | 'transferCount', number>
  }
  webEdit: {
    fileId: string
    version: number
    path: string
    title: string
    updatedAt: string
    updatedByDeviceId: string
    entryContentHash: string
    precondition: { kind: string; fileId: string; version: number }
    verifiedExistingPathPreserved: boolean
  }
  electronDelete: TombstoneRecord & { path: string; physicalDriveDeletion: boolean }
  androidReturn: {
    visibleEntryIds: string[]
    visibleAttachmentIds: string[]
    visibleFileBoxIds: string[]
    visibleTransferIds: string[]
    effectiveDeletedTargets: string[]
    finalManifestCounts: Record<'entryCount' | 'attachmentCount' | 'fileBoxCount' | 'transferCount', number>
    staleLiveRecordsResurrect: boolean
  }
  canonicalConflict: { id: string; path: string }
  payloadProjection: {
    unknownField: { key: string; value: unknown; preserved: boolean }
    localOnlyFields: string[]
    localOnlyFieldsPublished: boolean
  }
  transactionScenarios: Record<string, Record<string, unknown>>
}

async function readOfflineRoundTripFixture() {
  return JSON.parse(
    await readFile(path.join(parityContractRoot, 'offline-round-trip.json'), 'utf8'),
  ) as OfflineRoundTripFixture
}

test('outbound payload projection strips local-only fields and preserves unknown remote fields', async () => {
  const fixture = JSON.parse(
    await readFile(path.join(parityContractRoot, 'canonicalization.json'), 'utf8'),
  ) as {
    entryPayload: { input: Entry; expected: Entry }
    attachmentPayload: { input: Attachment; expected: Attachment }
    fileBoxPayload: { input: FileBoxItem; expected: FileBoxItem }
  }

  expect(projectEntryPayload(fixture.entryPayload.input)).toEqual(fixture.entryPayload.expected)
  expect(projectAttachmentPayload(fixture.attachmentPayload.input))
    .toEqual(fixture.attachmentPayload.expected)
  expect(projectFileBoxPayload(fixture.fileBoxPayload.input)).toEqual(fixture.fileBoxPayload.expected)
})

async function listJsonFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return listJsonFiles(path.join(directory, entry.name), relativePath)
    return entry.name.endsWith('.json') ? [relativePath] : []
  }))
  return files.flat().sort()
}

test('Drive v1 golden fixture tree preserves logical paths and validates every JSON shape', async () => {
  expect(await listJsonFiles(contractRoot)).toEqual(expectedJsonPaths)

  const validators: Record<string, (value: unknown) => ValidationResult<unknown>> = {
    'attachments/2026-05-23/att-contract-result.csv.json': validateAttachmentEnvelope,
    'conflicts/conf-entry-entry-contract.json': validateConflict,
    'devices/dev-contract.json': validateDevice,
    'entries/2026-05-23.json': validateEntryEnvelope,
    'filebox/filebox-contract.json': validateFileBoxEnvelope,
    'manifest.json': validateManifest,
    'tombstones/attachment--att-deleted.json': validateTombstone,
    'transfers/transfer-contract.json': validateTransferEnvelope,
  }

  for (const relativePath of expectedJsonPaths) {
    const result = validators[relativePath](await readFixture(relativePath))
    expect(result, `${relativePath}: ${result.ok ? '' : result.error}`).toMatchObject({ ok: true })
  }
})

test('Drive v1 golden entry and attachment still derive their locked paths', async () => {
  const entryEnvelope = await readFixture('entries/2026-05-23.json') as { payload: Entry }
  const attachmentEnvelope = await readFixture('attachments/2026-05-23/att-contract-result.csv.json') as { payload: Attachment }

  expect(buildEntryDriveFileName(entryEnvelope.payload, { [entryEnvelope.payload.id]: entryEnvelope.payload })).toBe('2026-05-23.json')
  expect(buildAttachmentDrivePath(attachmentEnvelope.payload, entryEnvelope.payload)).toBe('attachments/2026-05-23/att-contract-result.csv')
})

test('Drive v1 golden envelopes match the production writers exactly', async () => {
  const device = await readFixture('devices/dev-contract.json') as DeviceProfile
  const entryEnvelope = await readFixture('entries/2026-05-23.json') as SyncEntityEnvelope<Entry>
  const attachmentEnvelope = await readFixture('attachments/2026-05-23/att-contract-result.csv.json') as SyncEntityEnvelope<Attachment>
  const fileBoxEnvelope = await readFixture('filebox/filebox-contract.json') as SyncEntityEnvelope<FileBoxItem>
  const transferEnvelope = await readFixture('transfers/transfer-contract.json') as SyncEntityEnvelope<TransferRecord>
  expect(buildEntryEnvelope(entryEnvelope.payload, device)).toEqual(entryEnvelope)
  expect(buildAttachmentEnvelope(attachmentEnvelope.payload, device)).toEqual(attachmentEnvelope)
  expect(buildFileBoxEnvelope(fileBoxEnvelope.payload, device)).toEqual(fileBoxEnvelope)
  expect(buildTransferEnvelope(transferEnvelope.payload, device)).toEqual(transferEnvelope)
})

test('Drive v1 golden semantic hashes are locked to every writer payload field', async () => {
  const entryEnvelope = await readFixture('entries/2026-05-23.json') as SyncEntityEnvelope<Entry>
  const attachmentEnvelope = await readFixture('attachments/2026-05-23/att-contract-result.csv.json') as SyncEntityEnvelope<Attachment>
  const fileBoxEnvelope = await readFixture('filebox/filebox-contract.json') as SyncEntityEnvelope<FileBoxItem>
  const transferEnvelope = await readFixture('transfers/transfer-contract.json') as SyncEntityEnvelope<TransferRecord>
  expect(await entryContentHash(entryEnvelope.payload)).toBe('c2674d4e6ad545cdc38959c8a6f83db799b0aae9652b5f7beb79c0a1187bffd9')
  expect(await attachmentMetadataHash(attachmentEnvelope.payload)).toBe('542946b85a5eb6cd2188eed3af31fe43578787f52919a1c06273cef2cd50bb05')
  expect(await fileBoxMetadataHash(fileBoxEnvelope.payload)).toBe('06ed1bb7d371fa597231ac37a7201857dbc8cb0d1b37d45b88e8ad786d9dc25b')
  expect(await transferMetadataHash(transferEnvelope.payload)).toBe('3da4ff961880e5cca8a13ca81d23d548d7f0dbba87b25c8a68b00d381d16655b')

  const editedEntry = structuredClone(entryEnvelope.payload)
  editedEntry.authorId = 'changed-author'
  editedEntry.searchTerms = ['changed-search']
  editedEntry.experimentId = 'experiment-added'
  const editedAttachment = structuredClone(attachmentEnvelope.payload)
  editedAttachment.type = 'raw'
  editedAttachment.storagePath = 'attachments/changed.csv'
  editedAttachment.tag = 'changed-tag'

  expect(await entryContentHash(editedEntry)).not.toBe(await entryContentHash(entryEnvelope.payload))
  expect(await attachmentMetadataHash(editedAttachment)).not.toBe(await attachmentMetadataHash(attachmentEnvelope.payload))
})

test('Drive v1 semantic hashes canonicalize explicit null optional fields', async () => {
  const entryEnvelope = await readFixture('entries/2026-05-23.json') as SyncEntityEnvelope<Entry>
  const attachmentEnvelope = await readFixture('attachments/2026-05-23/att-contract-result.csv.json') as SyncEntityEnvelope<Attachment>
  const fileBoxEnvelope = await readFixture('filebox/filebox-contract.json') as SyncEntityEnvelope<FileBoxItem>
  const transferEnvelope = await readFixture('transfers/transfer-contract.json') as SyncEntityEnvelope<TransferRecord>

  const entryWithNulls = {
    ...entryEnvelope.payload,
    experimentId: null,
    projectId: null,
    projectTags: null,
    experimentTags: null,
  } as unknown as Entry
  const attachmentWithNulls = {
    ...attachmentEnvelope.payload,
    linkedRegionId: null,
    tag: null,
    sampleId: null,
    source: null,
  } as unknown as Attachment
  const fileBoxWithNulls = {
    ...fileBoxEnvelope.payload,
    localObjectUrl: null,
    lastError: null,
  } as unknown as FileBoxItem
  const transferWithNulls = {
    ...transferEnvelope.payload,
    lastError: null,
  } as unknown as TransferRecord

  expect(await entryContentHash(entryWithNulls)).toBe(await entryContentHash(entryEnvelope.payload))
  expect(await attachmentMetadataHash(attachmentWithNulls)).toBe(await attachmentMetadataHash(attachmentEnvelope.payload))
  expect(await fileBoxMetadataHash(fileBoxWithNulls)).toBe(await fileBoxMetadataHash(fileBoxEnvelope.payload))
  expect(await transferMetadataHash(transferWithNulls)).toBe(await transferMetadataHash(transferEnvelope.payload))
})

test('Drive v1 validation rejects wrong versions, mismatched ids, malformed timestamps, and nested blocks', async () => {
  type EntryFixture = {
    id: string
    version: number
    updatedAt: string
    payload: { id: string; content: Array<Record<string, unknown>> }
  }
  const golden = await readFixture('entries/2026-05-23.json') as EntryFixture
  const wrongVersion = structuredClone(golden)
  wrongVersion.version = 2
  const mismatchedId = structuredClone(golden)
  mismatchedId.payload.id = 'different-entry'
  const badTimestamp = structuredClone(golden)
  badTimestamp.updatedAt = 'May 23 at noon'
  const malformedNestedBlock = structuredClone(golden)
  malformedNestedBlock.payload.content[0].runs = [{ bold: true }]
  const deletedEnvelope = structuredClone(golden) as EntryFixture & { deletedAt?: string }
  deletedEnvelope.deletedAt = '2026-05-23T10:00:00.000Z'

  expect(validateEntryEnvelope(wrongVersion)).toEqual({ ok: false, error: 'entry envelope version must be 1.' })
  expect(validateEntryEnvelope(mismatchedId)).toEqual({ ok: false, error: 'entry envelope id must match payload id.' })
  expect(validateEntryEnvelope(badTimestamp)).toEqual({ ok: false, error: 'entry envelope updatedAt must be an ISO timestamp.' })
  expect(validateEntryEnvelope(malformedNestedBlock)).toEqual({ ok: false, error: 'Entry payload content[0].runs must contain text runs.' })
  expect(validateEntryEnvelope(deletedEnvelope)).toEqual({
    ok: false,
    error: 'entry envelope deletedAt must be represented by a Drive v1 tombstone.',
  })
})

test('Drive v1 validation rejects duplicate stable ids', async () => {
  const entry = await readFixture('entries/2026-05-23.json') as SyncEntityEnvelope<Entry>
  const duplicateBlocks = structuredClone(entry) as unknown as {
    payload: { content: Array<Record<string, unknown>> }
  }
  duplicateBlocks.payload.content.push(structuredClone(duplicateBlocks.payload.content[0]))

  const duplicateItems = structuredClone(entry) as unknown as {
    payload: { content: Array<Record<string, unknown>> }
  }
  duplicateItems.payload.content = [{
    id: 'checklist',
    type: 'checklist',
    items: [
      { id: 'duplicate', text: 'First', done: false },
      { id: 'duplicate', text: 'Second', done: true },
    ],
  }]

  const manifest = await readFixture('manifest.json') as {
    devices: Array<Record<string, unknown>>
  }
  const duplicateDevices = structuredClone(manifest)
  duplicateDevices.devices.push(structuredClone(duplicateDevices.devices[0]))

  expect(validateEntryEnvelope(duplicateBlocks)).toEqual({
    ok: false,
    error: 'Entry payload content block ids must be unique.',
  })
  expect(validateEntryEnvelope(duplicateItems)).toEqual({
    ok: false,
    error: 'Entry payload content[0].items must be valid checklist items.',
  })
  expect(validateManifest(duplicateDevices)).toEqual({
    ok: false,
    error: 'Manifest device ids must be unique.',
  })
})

test('account scoping changes only the IndexedDB name and leaves the v1 default unchanged', () => {
  expect(journalDbNameForScope()).toBe('easylab-journal-core')
  expect(journalDbNameForScope('journal-test', 'google:subject/123')).toBe('journal-test--account-google%3Asubject%2F123')
  expect(() => journalDbNameForScope('journal-test', '   ')).toThrow('Journal account scope must not be empty.')
})

test('staged Android-web-Electron-Android fixture produces the locked paths, hashes, deletion projection, and manifest counts', async () => {
  const roundTrip = await readOfflineRoundTripFixture()
  const device = await readFixture('devices/dev-contract.json') as DeviceProfile
  const entryEnvelope = await readFixture('entries/2026-05-23.json') as SyncEntityEnvelope<Entry>
  const attachmentEnvelope = await readFixture('attachments/2026-05-23/att-contract-result.csv.json') as SyncEntityEnvelope<Attachment>
  const fileBoxEnvelope = await readFixture('filebox/filebox-contract.json') as SyncEntityEnvelope<FileBoxItem>
  const transferEnvelope = await readFixture('transfers/transfer-contract.json') as SyncEntityEnvelope<TransferRecord>
  const originManifest = await readFixture('manifest.json') as Record<'entryCount' | 'attachmentCount' | 'fileBoxCount' | 'transferCount', number>

  expect(roundTrip.liveDriveUsed).toBe(false)
  expect(roundTrip.productionWritesEnabled).toBe(false)
  expect(`entries/${buildEntryDriveFileName(entryEnvelope.payload, { [entryEnvelope.id]: entryEnvelope.payload })}`)
    .toBe(roundTrip.androidOrigin.entryPath)
  expect(buildAttachmentDrivePath(attachmentEnvelope.payload, entryEnvelope.payload))
    .toBe(roundTrip.androidOrigin.attachmentBlobPath)
  expect(`${buildAttachmentDrivePath(attachmentEnvelope.payload, entryEnvelope.payload)}.json`)
    .toBe(roundTrip.androidOrigin.attachmentMetadataPath)
  expect(await entryContentHash(entryEnvelope.payload)).toBe(roundTrip.androidOrigin.entryContentHash)
  expect(await attachmentMetadataHash(attachmentEnvelope.payload)).toBe(roundTrip.androidOrigin.attachmentMetadataHash)
  expect({
    entryCount: originManifest.entryCount,
    attachmentCount: originManifest.attachmentCount,
    fileBoxCount: originManifest.fileBoxCount,
    transferCount: originManifest.transferCount,
  }).toEqual(roundTrip.androidOrigin.manifestCounts)

  const webEditedEntry: Entry = {
    ...entryEnvelope.payload,
    title: roundTrip.webEdit.title,
    lastEditedDatetime: roundTrip.webEdit.updatedAt,
    updatedByDeviceId: roundTrip.webEdit.updatedByDeviceId,
  }
  expect(await entryContentHash(webEditedEntry)).toBe(roundTrip.webEdit.entryContentHash)
  expect(roundTrip.webEdit.precondition).toEqual({
    kind: 'must-match',
    fileId: roundTrip.webEdit.fileId,
    version: roundTrip.webEdit.version,
  })
  expect(roundTrip.webEdit.path).toBe(roundTrip.androidOrigin.entryPath)
  expect(roundTrip.webEdit.verifiedExistingPathPreserved).toBe(true)

  expect(canonicalTombstoneId(roundTrip.electronDelete.entityKind, roundTrip.electronDelete.entityId))
    .toBe(roundTrip.electronDelete.id)
  expect(`tombstones/${safeDriveSegment(roundTrip.electronDelete.entityKind)}--${safeDriveSegment(roundTrip.electronDelete.entityId)}.json`)
    .toBe(roundTrip.electronDelete.path)
  expect(roundTrip.electronDelete.physicalDriveDeletion).toBe(false)
  expect(`conflicts/${safeDriveSegment(roundTrip.canonicalConflict.id, 'conflict')}.json`)
    .toBe(roundTrip.canonicalConflict.path)

  const afterElectronDelete = applyTombstonesToSnapshot({
    entries: { [webEditedEntry.id]: webEditedEntry },
    attachments: [attachmentEnvelope.payload],
    fileBoxItems: [fileBoxEnvelope.payload],
    transfers: [transferEnvelope.payload],
    conflicts: [],
    tombstones: [],
    device,
  }, [roundTrip.electronDelete])
  const deletedTargets = effectiveDeletedTargetSets({
    entries: { [webEditedEntry.id]: webEditedEntry },
    attachments: [attachmentEnvelope.payload],
    fileBoxItems: [fileBoxEnvelope.payload],
    transfers: [transferEnvelope.payload],
    conflicts: [],
    tombstones: [],
    device,
  }, [roundTrip.electronDelete])
  const effectiveTargets = [
    ...[...deletedTargets.deletedAttachments].map((id) => `attachment:${id}`),
    ...[...deletedTargets.deletedEntries].map((id) => `entry:${id}`),
    ...[...deletedTargets.deletedFileBoxItems].map((id) => `fileBoxItem:${id}`),
    ...[...deletedTargets.deletedTransfers].map((id) => `transfer:${id}`),
  ].sort()
  expect(effectiveTargets).toEqual(roundTrip.androidReturn.effectiveDeletedTargets)
  expect(Object.keys(afterElectronDelete.entries)).toEqual(roundTrip.androidReturn.visibleEntryIds)
  expect(afterElectronDelete.attachments.map((item) => item.id)).toEqual(roundTrip.androidReturn.visibleAttachmentIds)
  expect(afterElectronDelete.fileBoxItems.map((item) => item.id)).toEqual(roundTrip.androidReturn.visibleFileBoxIds)
  expect(afterElectronDelete.transfers.map((item) => item.id)).toEqual(roundTrip.androidReturn.visibleTransferIds)
  expect(roundTrip.androidReturn.staleLiveRecordsResurrect).toBe(false)

  const manifest = createManifest({
    device,
    entries: afterElectronDelete.entries,
    attachments: afterElectronDelete.attachments,
    fileBoxItems: afterElectronDelete.fileBoxItems,
    transfers: afterElectronDelete.transfers,
  })
  expect({
    entryCount: manifest.entryCount,
    attachmentCount: manifest.attachmentCount,
    fileBoxCount: manifest.fileBoxCount,
    transferCount: manifest.transferCount,
  }).toEqual(roundTrip.androidReturn.finalManifestCounts)
})

test('shared offline round trip preserves unknown fields, strips local-only values, and locks fail-closed transaction outcomes', async () => {
  const roundTrip = await readOfflineRoundTripFixture()
  const entryEnvelope = await readFixture('entries/2026-05-23.json') as SyncEntityEnvelope<Entry>
  const attachmentEnvelope = await readFixture('attachments/2026-05-23/att-contract-result.csv.json') as SyncEntityEnvelope<Attachment>
  const fileBoxEnvelope = await readFixture('filebox/filebox-contract.json') as SyncEntityEnvelope<FileBoxItem>
  const withUnknown = {
    ...entryEnvelope.payload,
    syncPath: '/private/local-entry.json',
    [roundTrip.payloadProjection.unknownField.key]: roundTrip.payloadProjection.unknownField.value,
  } as Entry & Record<string, unknown>
  const projectedEntry = projectEntryPayload(withUnknown) as Entry & Record<string, unknown>
  const projectedAttachment = projectAttachmentPayload({
    ...attachmentEnvelope.payload,
    cachedPath: '/private/cache',
    cacheKey: 'private-cache-key',
    thumbnail: 'data:image/png;base64,private',
  })
  const projectedFileBox = projectFileBoxPayload({
    ...fileBoxEnvelope.payload,
    localObjectUrl: 'blob:private',
  })

  expect(projectedEntry[roundTrip.payloadProjection.unknownField.key])
    .toEqual(roundTrip.payloadProjection.unknownField.value)
  expect(roundTrip.payloadProjection.unknownField.preserved).toBe(true)
  expect(projectedEntry).not.toHaveProperty('syncPath')
  expect(projectedAttachment).not.toHaveProperty('cachedPath')
  expect(projectedAttachment).not.toHaveProperty('cacheKey')
  expect(projectedAttachment).not.toHaveProperty('thumbnail')
  expect(projectedFileBox).not.toHaveProperty('localObjectUrl')
  expect(roundTrip.payloadProjection.localOnlyFields.sort())
    .toEqual(['cacheKey', 'cachedPath', 'localObjectUrl', 'syncPath', 'thumbnail'].sort())
  expect(roundTrip.payloadProjection.localOnlyFieldsPublished).toBe(false)

  expect(roundTrip.transactionScenarios.smallCreateOnlyRetry.expected).toBe('exact-reconciliation-no-duplicate')
  expect(roundTrip.transactionScenarios.largeResumableCreate.expected).toBe('same-operation-id-no-duplicate')
  expect(roundTrip.transactionScenarios.largeResumableUpdate.expected).toBe('same-operation-id-conditional-update')
  expect(roundTrip.transactionScenarios.interruptedOrAmbiguousUpload.expected).toBe('reconcile-exact-content-or-block')
  expect(roundTrip.transactionScenarios.partialPrerequisitesWithOldManifest.expected).toBe('repair-only-known-plan-paths-manifest-last')
  expect(roundTrip.transactionScenarios.manifestFailure.expected).toBe('local-checkpoint-unchanged-and-repairable')
  expect(roundTrip.transactionScenarios.staleFileIdentity.expected).toBe('precondition-conflict')
  expect(roundTrip.transactionScenarios.missingWithBaseline.expected).toBe('blocked-without-tombstone')
  expect(roundTrip.transactionScenarios.duplicatePathsOrFolders.expected).toBe('blocked-before-mutation')
  expect(roundTrip.transactionScenarios.malformedJson.expected).toBe('one-quarantine-conflict-zero-mutations')
  expect(roundTrip.transactionScenarios.manifestCountMismatch.expected).toBe('blocked-before-mutation')
  expect(roundTrip.transactionScenarios.deleteEditRace.expected).toBe('pending-conflict-no-remote-mutation')
  expect(roundTrip.transactionScenarios.equalTargetTombstones.divergentSameInstant).toBe('blocked')
  expect(roundTrip.transactionScenarios.accountIsolation.expected).toBe('operation-and-cache-inaccessible-cross-account')
})
