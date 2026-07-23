package com.easylab.labnotebook.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveRepository
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import kotlinx.serialization.decodeFromString
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DriveReadOnlyMetadataSyncTest {
    private lateinit var database: LabNotebookDatabase
    private val accountA = AccountId("account-a")
    private val accountB = AccountId("account-b")

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun goldenMetadataAppliesEveryRecordTypeOnlyToRequestedAccountAndPreservesLocalOnlyState() = runTest {
        val dao = database.dao()
        val localAttachment = attachment(accountA.value, id = "att-contract").copy(
            filename = "stale-local.csv",
            sha256 = CONTRACT_ATTACHMENT_SHA,
            localUri = "content://easylab/att-contract",
            cachedPath = "/data/user/0/easylab/cache/att-contract.csv",
            pinnedOffline = true,
            syncStatus = "local",
        )
        dao.upsertAttachment(localAttachment)
        dao.upsertAttachment(attachment(accountA.value, id = "att-deleted"))
        dao.upsertSyncState(
            SyncStateEntity(
                accountId = accountA.value,
                lastAttemptAt = "2026-05-22T08:00:00.000Z",
                lastSyncedAt = "2026-05-22T08:00:00.000Z",
                changeToken = "drive-change-token-must-not-advance",
                updatedAt = "2026-05-22T08:00:00.000Z",
                valueJson = "{\"cursor\":\"opaque-local-value\"}",
            ),
        )
        val untouchedB = seedEveryRecordType(accountB.value, useGoldenIds = true)

        val files = goldenFiles().toMutableMap()
        files[FILE_BOX_PATH] = checkNotNull(files[FILE_BOX_PATH]).replace(
            "\"lastError\"",
            "\"localObjectUrl\":\"blob:https://browser.invalid/local-only\",\"lastError\"",
        ).let { raw ->
            if (raw == files[FILE_BOX_PATH]) {
                raw.replace("\"driveFileId\":\"drive-file-contract\"", "\"driveFileId\":\"drive-file-contract\",\"localObjectUrl\":\"blob:https://browser.invalid/local-only\"")
            } else {
                raw
            }
        }
        val drive = FakeDriveRepository(files)

        val snapshot = DriveV1MetadataReader(drive).read(accountA)
        val report = DriveV1MetadataApplier(database, now = { SYNCED_AT }).apply(accountA, snapshot)

        assertEquals(7, snapshot.recordCount)
        assertEquals(7, report.appliedCount)
        assertEquals(1, report.tombstoneCount)
        assertEquals(0, report.skippedLocalChangeCount)
        assertEquals(listOf(accountA), drive.listRequests)
        assertEquals(files.keys.sorted(), drive.jsonReads.sorted())
        assertEquals(List(files.size) { accountA }, drive.jsonReadAccounts)
        assertFalse(drive.jsonReads.contains("attachments/2026-05-23/att-contract-result.csv"))
        assertEquals(0, drive.blobWrites)
        assertEquals(0, drive.jsonWrites)

        assertEquals(listOf("dev-contract"), dao.devices(accountA.value).map { it.id })
        assertEquals("Drive v1 contract entry", dao.entry(accountA.value, "entry-contract")?.title)
        val refreshedAttachment = dao.attachment(accountA.value, "att-contract")
        assertEquals("result.csv", refreshedAttachment?.filename)
        assertEquals(localAttachment.localUri, refreshedAttachment?.localUri)
        assertEquals(localAttachment.cachedPath, refreshedAttachment?.cachedPath)
        assertTrue(refreshedAttachment?.pinnedOffline == true)
        assertNotNull(dao.attachment(accountA.value, "att-deleted"))
        assertNull(dao.visibleAttachment(accountA.value, "att-deleted"))
        assertNull(dao.fileBoxItems(accountA.value).single().localObjectUrl)
        assertEquals("transfer-contract", dao.transfers(accountA.value).single().id)
        assertEquals("conf-entry-entry-contract", dao.conflicts(accountA.value).single().id)
        assertNotNull(dao.tombstone(accountA.value, "attachment", "att-deleted"))

        val syncState = checkNotNull(dao.syncState(accountA.value))
        assertEquals("drive-change-token-must-not-advance", syncState.changeToken)
        assertEquals("{\"cursor\":\"opaque-local-value\"}", syncState.valueJson)
        assertEquals(SYNCED_AT, syncState.lastAttemptAt)
        assertEquals(SYNCED_AT, syncState.lastSyncedAt)
        assertEquals(SYNCED_AT, syncState.updatedAt)

        assertEveryRecordTypeUnchanged(accountB.value, untouchedB)
    }

    @Test
    fun rawRemoteJsonIsAccountScopedAndPreservesFutureFieldsAcrossTypedEdits() = runTest {
        val dao = database.dao()
        val accountBRaw = DriveRawDocumentEntity(
            accountId = accountB.value,
            entityKind = "entry",
            entityId = "entry-contract",
            path = ENTRY_PATH,
            driveFileId = "account-b-drive-file",
            driveModifiedAt = LOCAL_TIME,
            rawJson = """{"account":"b"}""",
        )
        dao.upsertDriveRawDocument(accountBRaw)
        val futureEntryJson = fixture(ENTRY_PATH)
            .replace(
                "\"kind\":\"entry\"",
                "\"kind\":\"entry\",\"futureEnvelope\":{\"origin\":\"web-v2\"}",
            )
            .replace(
                "\"title\":\"Drive v1 contract entry\"",
                "\"title\":\"Drive v1 contract entry\",\"futurePayload\":{\"score\":7}",
            )
        val files = goldenFiles().toMutableMap().apply { this[ENTRY_PATH] = futureEntryJson }

        DriveV1MetadataApplier(database).apply(
            accountA,
            DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA),
        )

        val stored = checkNotNull(dao.driveRawDocument(accountA.value, "entry", "entry-contract"))
        assertEquals(futureEntryJson, stored.rawJson)
        assertEquals(ENTRY_PATH, stored.path)
        assertEquals(ref(ENTRY_PATH).id, stored.driveFileId)
        assertEquals(LOCAL_TIME, stored.driveModifiedAt)
        assertEquals(accountBRaw, dao.driveRawDocument(accountB.value, "entry", "entry-contract"))

        val lossless = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Entry>>(stored.rawJson)
        lossless.value = lossless.value.copy(
            updatedAt = SYNCED_AT,
            payload = lossless.value.payload.copy(
                title = "Native title edit",
                lastEditedDatetime = SYNCED_AT,
            ),
        )
        val encoded = lossless.encodePreservingUnknownFields()

        assertTrue(encoded.contains("\"futureEnvelope\":{\"origin\":\"web-v2\"}"))
        assertTrue(encoded.contains("\"futurePayload\":{\"score\":7}"))
        assertTrue(encoded.contains("\"title\":\"Native title edit\""))
        assertTrue(encoded.contains("\"updatedAt\":\"$SYNCED_AT\""))
    }

    @Test
    fun tombstoneIsAppliedBeforeMatchingLiveRecordAndPreventsResurrection() = runTest {
        val dao = database.dao()
        dao.upsertEntry(entry(accountA.value, id = "entry-contract", title = "old local copy"))
        dao.upsertEntry(entry(accountB.value, id = "entry-contract", title = "account B copy"))
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            ENTRY_PATH to fixture(ENTRY_PATH),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
        val report = DriveV1MetadataApplier(database, now = { SYNCED_AT }).apply(accountA, snapshot)

        assertNotNull(dao.entry(accountA.value, "entry-contract"))
        assertNull(dao.visibleEntry(accountA.value, "entry-contract"))
        assertNotNull(dao.tombstone(accountA.value, "entry", "entry-contract"))
        assertEquals("account B copy", dao.entry(accountB.value, "entry-contract")?.title)
        assertEquals(1, report.tombstoneCount)
        assertEquals(0, report.skippedLocalChangeCount)
    }

    @Test
    fun pendingLocalUpsertSurvivesBothRemoteTombstoneAndLiveRecord() = runTest {
        val dao = database.dao()
        val local = entry(accountA.value, id = "entry-contract", title = "unsynced local edit")
        val queueItem = queue(accountA.value, entityKind = "entry", entityId = local.id)
        val acceptedBaseline = DriveRawDocumentEntity(
            accountId = accountA.value,
            entityKind = "entry",
            entityId = local.id,
            path = ENTRY_PATH,
            driveFileId = "accepted-baseline-file",
            driveModifiedAt = "2026-05-23T09:00:00.000Z",
            rawJson = fixture(ENTRY_PATH).replace("Drive v1 contract entry", "accepted baseline"),
        )
        dao.upsertEntry(local)
        dao.insertQueueItemIfAbsent(queueItem)
        dao.upsertDriveRawDocument(acceptedBaseline)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            ENTRY_PATH to fixture(ENTRY_PATH),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
        val report = DriveV1MetadataApplier(database, now = { SYNCED_AT }).apply(accountA, snapshot)

        assertEquals(local, dao.entry(accountA.value, local.id))
        assertEquals(local, dao.visibleEntry(accountA.value, local.id))
        assertEquals(queueItem, dao.queueItem(accountA.value, queueItem.id))
        assertEquals(acceptedBaseline, dao.driveRawDocument(accountA.value, "entry", local.id))
        assertNull(dao.driveRawDocument(accountA.value, "tombstone", "del-entry-entry-contract"))
        assertNotNull(dao.tombstone(accountA.value, "entry", local.id))
        assertEquals(1, report.skippedLocalChangeCount)
        assertEquals(1, dao.syncState(accountA.value)?.queueCount)
    }

    @Test
    fun pendingLocalDeletePreservesLastAcceptedEntityBaseline() = runTest {
        val dao = database.dao()
        val local = entry(accountA.value, id = "entry-contract", title = "locally deleted entry")
        val acceptedBaseline = DriveRawDocumentEntity(
            accountId = accountA.value,
            entityKind = "entry",
            entityId = local.id,
            path = ENTRY_PATH,
            driveFileId = "accepted-delete-baseline-file",
            driveModifiedAt = "2026-05-23T09:00:00.000Z",
            rawJson = fixture(ENTRY_PATH).replace("Drive v1 contract entry", "accepted delete baseline"),
        )
        val localDelete = TombstoneEntity(
            accountId = accountA.value,
            id = "local-delete-entry-contract",
            entityKind = "entry",
            entityId = local.id,
            deletedAt = LOCAL_TIME,
            deletedByDeviceId = "local-device",
        )
        val deleteQueue = queue(accountA.value, "entry", local.id).copy(
            id = "local-delete-queue-entry-contract",
            operation = "delete",
        )
        dao.upsertEntry(local)
        dao.upsertTombstone(localDelete)
        dao.insertQueueItemIfAbsent(deleteQueue)
        dao.upsertDriveRawDocument(acceptedBaseline)

        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(entryCount = 1),
            ENTRY_PATH to fixture(ENTRY_PATH),
        )
        val report = DriveV1MetadataApplier(database, now = { SYNCED_AT })
            .apply(accountA, DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA))

        assertEquals(local, dao.entry(accountA.value, local.id))
        assertNull(dao.visibleEntry(accountA.value, local.id))
        assertEquals(deleteQueue, dao.queueItem(accountA.value, deleteQueue.id))
        assertEquals(acceptedBaseline, dao.driveRawDocument(accountA.value, "entry", local.id))
        assertEquals(1, report.skippedLocalChangeCount)
    }

    @Test
    fun malformedRecordJsonLeavesRoomUnchanged() = runTest {
        val before = seedEveryRecordType(accountA.value)
        val files = goldenFiles().toMutableMap().apply {
            this[ENTRY_PATH] = "{not-json"
        }

        val failure = runCatching {
            val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
            DriveV1MetadataApplier(database).apply(accountA, snapshot)
        }

        assertTrue(failure.isFailure)
        assertEveryRecordTypeUnchanged(accountA.value, before)
    }

    @Test
    fun invalidManifestLeavesRoomUnchanged() = runTest {
        val before = seedEveryRecordType(accountA.value)
        val files = goldenFiles().toMutableMap().apply {
            this[MANIFEST_PATH] = checkNotNull(this[MANIFEST_PATH])
                .replace("\"provider\":\"google-drive\"", "\"provider\":\"not-drive\"")
        }

        val failure = runCatching {
            val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
            DriveV1MetadataApplier(database).apply(accountA, snapshot)
        }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("provider"))
        assertEveryRecordTypeUnchanged(accountA.value, before)
    }

    @Test
    fun missingManifestFailsBeforeAnyManagedJsonIsRead() = runTest {
        val files = goldenFiles().toMutableMap().apply { remove(MANIFEST_PATH) }
        val drive = FakeDriveRepository(files)

        val failure = runCatching { DriveV1MetadataReader(drive).read(accountA) }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("manifest.json is missing or duplicated"))
        assertTrue(drive.jsonReads.isEmpty())
    }

    @Test
    fun managedPathThatDisappearsDuringReadFails() = runTest {
        val files = goldenFiles()
        val missingPath = ATTACHMENT_PATH
        val drive = FakeDriveRepository(
            jsonByPath = files - missingPath,
            listedRefs = listedRefsFor(files.keys),
        )

        val failure = runCatching { DriveV1MetadataReader(drive).read(accountA) }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("$missingPath disappeared"))
    }

    @Test
    fun duplicateManagedPathFailsBeforeAnyManagedJsonIsRead() = runTest {
        val files = goldenFiles()
        val duplicate = ref(ENTRY_PATH).copy(id = "duplicate-entry-ref")
        val drive = FakeDriveRepository(files, listedRefsFor(files.keys) + duplicate)

        val failure = runCatching { DriveV1MetadataReader(drive).read(accountA) }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("duplicate managed paths"))
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains(ENTRY_PATH))
        assertTrue(drive.jsonReads.isEmpty())
    }

    @Test
    fun jsonAttachmentBlobIsNeverReadAsMetadata() = runTest {
        val metadataPath = "attachments/2026-05-23/att-contract-sample.json.json"
        val blobPath = metadataPath.removeSuffix(".json")
        val metadata = fixture(ATTACHMENT_PATH)
            .replace("result.csv", "sample.json")
            .replace("text/csv", "application/json")
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(attachmentCount = 1),
            metadataPath to metadata,
        )
        val drive = FakeDriveRepository(
            jsonByPath = files,
            listedRefs = listOf(
                ref(MANIFEST_PATH),
                ref(blobPath).copy(
                    mimeType = "application/json",
                    size = 8_000_000,
                    appProperties = mapOf("entityType" to "attachmentBlob"),
                ),
                ref(metadataPath).copy(appProperties = mapOf("entityType" to "attachment")),
            ),
        )

        val snapshot = DriveV1MetadataReader(drive).read(accountA)

        assertEquals(1, snapshot.attachments.size)
        assertEquals(listOf(MANIFEST_PATH, metadataPath), drive.jsonReads)
        assertFalse(drive.jsonReads.contains(blobPath))
    }

    @Test
    fun metadataOnlyAttachmentIsReadWithoutSiblingBlob() = runTest {
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(attachmentCount = 1),
            ATTACHMENT_PATH to fixture(ATTACHMENT_PATH),
        )
        val drive = FakeDriveRepository(
            jsonByPath = files,
            listedRefs = listOf(
                ref(MANIFEST_PATH),
                ref(ATTACHMENT_PATH).copy(appProperties = mapOf("entityType" to "attachment")),
            ),
        )

        val snapshot = DriveV1MetadataReader(drive).read(accountA)

        assertEquals(listOf("att-contract"), snapshot.attachments.map { it.value.id })
        assertEquals(listOf(MANIFEST_PATH, ATTACHMENT_PATH), drive.jsonReads)
    }

    @Test
    fun interruptedSyncingUpsertIsProtectedFromRemoteOverwriteAndDeletion() = runTest {
        val dao = database.dao()
        val local = entry(accountA.value, id = "entry-contract", title = "interrupted local edit")
        val syncing = queue(accountA.value, "entry", local.id).copy(status = "syncing")
        dao.upsertEntry(local)
        dao.insertQueueItemIfAbsent(syncing)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            ENTRY_PATH to fixture(ENTRY_PATH),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
        )

        val report = DriveV1MetadataApplier(database, now = { SYNCED_AT })
            .apply(accountA, DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA))

        assertEquals(local, dao.entry(accountA.value, local.id))
        assertEquals(local, dao.visibleEntry(accountA.value, local.id))
        assertEquals(syncing, dao.queueItem(accountA.value, syncing.id))
        assertEquals(1, report.skippedLocalChangeCount)
        assertEquals(1, dao.syncState(accountA.value)?.queueCount)
    }

    @Test
    fun parentTombstoneFiltersStaleRemoteChildrenWithoutPhysicalDeletion() = runTest {
        val before = seedEveryRecordType(accountA.value, useGoldenIds = true)
        database.dao().clearQueue(accountA.value)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            ENTRY_PATH to fixture(ENTRY_PATH),
            ATTACHMENT_PATH to fixture(ATTACHMENT_PATH),
            FILE_BOX_PATH to fixture(FILE_BOX_PATH),
            TRANSFER_PATH to fixture(TRANSFER_PATH),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
        val report = DriveV1MetadataApplier(database).apply(accountA, snapshot)

        assertTrue(snapshot.entries.isEmpty())
        assertTrue(snapshot.attachments.isEmpty())
        assertTrue(snapshot.fileBoxItems.isEmpty())
        assertTrue(snapshot.transfers.isEmpty())
        assertEquals(1, report.tombstoneCount)
        assertEquals(before.entry, database.dao().entry(accountA.value, before.entry.id))
        assertEquals(before.attachment, database.dao().attachment(accountA.value, before.attachment.id))
        assertNull(database.dao().visibleEntry(accountA.value, before.entry.id))
        assertNull(database.dao().visibleAttachment(accountA.value, before.attachment.id))
    }

    @Test
    fun parentTombstoneConflictingWithPendingLocalChildFailsWithoutMutation() = runTest {
        val dao = database.dao()
        val parent = entry(accountA.value, id = "entry-contract")
        val child = attachment(accountA.value, id = "att-contract").copy(entryId = parent.id)
        val pendingChild = queue(accountA.value, "attachment", child.id).copy(status = "syncing")
        dao.upsertEntry(parent)
        dao.upsertAttachment(child)
        dao.insertQueueItemIfAbsent(pendingChild)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
            "tombstones/attachment--att-contract.json" to tombstoneJson("attachment", "att-contract"),
        )

        val failure = runCatching {
            val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
            DriveV1MetadataApplier(database).apply(accountA, snapshot)
        }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("pending local child changes"))
        assertEquals(parent, dao.entry(accountA.value, parent.id))
        assertEquals(child, dao.attachment(accountA.value, child.id))
        assertEquals(pendingChild, dao.queueItem(accountA.value, pendingChild.id))
        assertTrue(dao.tombstones(accountA.value).isEmpty())
    }

    @Test
    fun duplicateRecordUsesChronologicalInstantAcrossOffsets() = runTest {
        val olderPath = "entries/2026-05-23-older-offset.json"
        val older = fixture(ENTRY_PATH)
            .replace("Drive v1 contract entry", "older offset copy")
            .replace("2026-05-23T09:30:00.000Z", "2026-05-23T10:00:00.000+01:00")
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(entryCount = 1),
            ENTRY_PATH to fixture(ENTRY_PATH),
            olderPath to older,
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)

        assertEquals(1, snapshot.entries.size)
        assertEquals("Drive v1 contract entry", snapshot.entries.single().value.payload.title)
    }

    @Test
    fun equalTimestampDuplicateWithDifferentPayloadIsRejected() = runTest {
        val conflictingPath = "entries/2026-05-23-conflict.json"
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(entryCount = 1),
            ENTRY_PATH to fixture(ENTRY_PATH),
            conflictingPath to fixture(ENTRY_PATH).replace("Drive v1 contract entry", "conflicting copy"),
        )

        val failure = runCatching { DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA) }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("conflicting records"))
    }

    @Test
    fun manifestCountMismatchIsRejectedBeforeRoomMutation() = runTest {
        val before = seedEveryRecordType(accountA.value)
        val files = goldenFiles().toMutableMap().apply {
            this[MANIFEST_PATH] = manifestJson(
                entryCount = 2,
                attachmentCount = 1,
                fileBoxCount = 1,
                transferCount = 1,
            )
        }

        val failure = runCatching {
            val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
            DriveV1MetadataApplier(database).apply(accountA, snapshot)
        }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("expected 2 entries but found 1"))
        assertEveryRecordTypeUnchanged(accountA.value, before)
    }

    @Test
    fun remoteCacheFlagsCannotDowngradeAValidLocalCache() = runTest {
        val dao = database.dao()
        val local = attachment(accountA.value, id = "att-contract").copy(
            sha256 = CONTRACT_ATTACHMENT_SHA,
            localUri = "content://easylab/cache/att-contract",
            cachedPath = "/data/user/0/easylab/cache/att-contract.csv",
            pinnedOffline = true,
            syncStatus = "synced",
        )
        dao.upsertAttachment(local)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(entryCount = 1, attachmentCount = 1),
            ENTRY_PATH to fixture(ENTRY_PATH),
            ATTACHMENT_PATH to fixture(ATTACHMENT_PATH)
                .replace("\"driveFileId\":\"drive-file-contract\"", "\"driveFileId\":\"drive-file-contract\",\"pinnedOffline\":false")
                .replace("\"syncStatus\":\"synced\"", "\"syncStatus\":\"remote-available\""),
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
        DriveV1MetadataApplier(database).apply(accountA, snapshot)

        val refreshed = checkNotNull(dao.attachment(accountA.value, local.id))
        assertEquals(local.localUri, refreshed.localUri)
        assertEquals(local.cachedPath, refreshed.cachedPath)
        assertTrue(refreshed.pinnedOffline)
        assertEquals("synced", refreshed.syncStatus)
    }

    @Test
    fun changedRemoteHashInvalidatesStaleLocalCachePointers() = runTest {
        val dao = database.dao()
        val local = attachment(accountA.value, id = "att-contract").copy(
            sha256 = "old-sha",
            localUri = "content://easylab/cache/att-contract",
            cachedPath = "/data/user/0/easylab/cache/att-contract.csv",
            pinnedOffline = true,
            syncStatus = "synced",
        )
        dao.upsertEntry(entry(accountA.value, id = "entry-contract"))
        dao.upsertAttachment(local)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(entryCount = 1, attachmentCount = 1),
            ENTRY_PATH to fixture(ENTRY_PATH),
            ATTACHMENT_PATH to fixture(ATTACHMENT_PATH)
                .replace(CONTRACT_ATTACHMENT_SHA, "f".repeat(64)),
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
        DriveV1MetadataApplier(database).apply(accountA, snapshot)

        val refreshed = checkNotNull(dao.attachment(accountA.value, local.id))
        assertNull(refreshed.localUri)
        assertNull(refreshed.cachedPath)
        assertTrue(refreshed.pinnedOffline)
        assertEquals("remote-available", refreshed.syncStatus)
    }

    @Test
    fun completeParentAndChildTombstoneSetHidesRowsWithoutDestroyingRecoveryData() = runTest {
        val dao = database.dao()
        val parent = entry(accountA.value, id = "entry-contract")
        val child = attachment(accountA.value, id = "att-contract").copy(entryId = parent.id)
        dao.upsertEntry(parent)
        dao.upsertAttachment(child)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
            "tombstones/attachment--att-contract.json" to tombstoneJson("attachment", "att-contract"),
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)
        DriveV1MetadataApplier(database).apply(accountA, snapshot)

        assertEquals(parent, dao.entry(accountA.value, parent.id))
        assertEquals(child, dao.attachment(accountA.value, child.id))
        assertNull(dao.visibleEntry(accountA.value, parent.id))
        assertNull(dao.visibleAttachment(accountA.value, child.id))
        assertNotNull(dao.tombstone(accountA.value, "entry", parent.id))
        assertNotNull(dao.tombstone(accountA.value, "attachment", child.id))
    }

    @Test
    fun duplicateTombstonesAreComparedByTargetAndChronologicalInstant() = runTest {
        val oldPath = "tombstones/attachment--att-contract-old.json"
        val newPath = "tombstones/attachment--att-contract-new.json"
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            oldPath to tombstoneJson("attachment", "att-contract")
                .replace("del-attachment-att-contract", "old-marker")
                .replace("2026-05-23T09:50:00.000Z", "2026-05-23T11:00:00.000+02:00"),
            newPath to tombstoneJson("attachment", "att-contract")
                .replace("del-attachment-att-contract", "new-marker"),
        )

        val snapshot = DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA)

        assertEquals(1, snapshot.tombstones.size)
        assertEquals("new-marker", snapshot.tombstones.single().value.id)
    }

    @Test
    fun newerRemoteTombstoneReusesExistingRoomIdentityForSameTarget() = runTest {
        val dao = database.dao()
        val local = TombstoneEntity(
            accountId = accountA.value,
            id = "entry--entry-contract",
            entityKind = "entry",
            entityId = "entry-contract",
            deletedAt = LOCAL_TIME,
            deletedByDeviceId = "local-device",
            reason = "older local marker",
        )
        dao.upsertTombstone(local)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
        )

        DriveV1MetadataApplier(database).apply(
            accountA,
            DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA),
        )

        val stored = checkNotNull(dao.tombstone(accountA.value, "entry", "entry-contract"))
        assertEquals(local.id, stored.id)
        assertEquals("2026-05-23T09:50:00.000Z", stored.deletedAt)
        assertEquals("dev-contract", stored.deletedByDeviceId)
        assertEquals("remote deletion", stored.reason)
    }

    @Test
    fun equalTimeTombstoneDisagreementFailsWithoutMutation() = runTest {
        val dao = database.dao()
        val local = TombstoneEntity(
            accountId = accountA.value,
            id = "entry--entry-contract",
            entityKind = "entry",
            entityId = "entry-contract",
            deletedAt = "2026-05-23T09:50:00.000Z",
            deletedByDeviceId = "local-device",
            reason = "local reason",
        )
        dao.upsertTombstone(local)
        val files = linkedMapOf(
            MANIFEST_PATH to manifestJson(),
            "tombstones/entry--entry-contract.json" to tombstoneJson("entry", "entry-contract"),
        )

        val failure = runCatching {
            DriveV1MetadataApplier(database).apply(
                accountA,
                DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA),
            )
        }

        assertTrue(failure.isFailure)
        assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains("disagree"))
        assertEquals(local, dao.tombstone(accountA.value, "entry", "entry-contract"))
        assertNull(dao.syncState(accountA.value))
    }

    @Test
    fun remoteOrphansFailBeforeRoomMutation() = runTest {
        val cases = listOf(
            linkedMapOf(
                MANIFEST_PATH to manifestJson(attachmentCount = 1),
                ATTACHMENT_PATH to fixture(ATTACHMENT_PATH),
            ) to "Remote attachment",
            linkedMapOf(
                MANIFEST_PATH to manifestJson(fileBoxCount = 1),
                FILE_BOX_PATH to fixture(FILE_BOX_PATH),
            ) to "Remote File Box item",
            linkedMapOf(
                MANIFEST_PATH to manifestJson(transferCount = 1),
                TRANSFER_PATH to fixture(TRANSFER_PATH),
            ) to "Remote transfer",
        )

        cases.forEach { (files, expectedMessage) ->
            val failure = runCatching {
                DriveV1MetadataApplier(database).apply(
                    accountA,
                    DriveV1MetadataReader(FakeDriveRepository(files)).read(accountA),
                )
            }
            assertTrue(expectedMessage, failure.isFailure)
            assertTrue(failure.exceptionOrNull()?.message.orEmpty().contains(expectedMessage))
            assertTrue(database.dao().tombstones(accountA.value).isEmpty())
            assertNull(database.dao().syncState(accountA.value))
        }
    }

    @Test
    fun roomTransactionRollsBackIfAStagedRemoteBatchFailsMidApply() = runTest {
        val dao = database.dao()
        val existingDevice = device(accountA.value).copy(id = "device-to-delete")
        dao.upsertDevice(existingDevice)
        val first = DriveV1Json.format.decodeFromString<DriveV1Tombstone>(
            tombstoneJson("device", existingDevice.id).replace("del-device-device-to-delete", "marker-one"),
        ).requireV1()
        database.openHelper.writableDatabase.execSQL(
            """
            CREATE TRIGGER fail_test_sync_state_insert
            BEFORE INSERT ON sync_state
            WHEN NEW.accountId = 'account-a'
            BEGIN
                SELECT RAISE(ABORT, 'forced rollback test failure');
            END
            """.trimIndent(),
        )
        val snapshot = DriveV1MetadataSnapshot(
            manifest = DriveV1Json.format.decodeFromString<DriveV1Manifest>(manifestJson()).requireV1(),
            manifestRef = ref(MANIFEST_PATH),
            manifestRawJson = manifestJson(),
            devices = emptyList(),
            entries = emptyList(),
            attachments = emptyList(),
            fileBoxItems = emptyList(),
            transfers = emptyList(),
            conflicts = emptyList(),
            tombstones = listOf(
                RemoteRecord(
                    ref("tombstones/device--one.json"),
                    first,
                    tombstoneJson("device", existingDevice.id).replace(
                        "del-device-device-to-delete",
                        "marker-one",
                    ),
                ),
            ),
        )

        val failure = runCatching { DriveV1MetadataApplier(database).apply(accountA, snapshot) }

        assertTrue(failure.isFailure)
        assertEquals(listOf(existingDevice), dao.devices(accountA.value))
        assertTrue(dao.tombstones(accountA.value).isEmpty())
        assertTrue(dao.driveRawDocuments(accountA.value).isEmpty())
        assertNull(dao.syncState(accountA.value))
    }

    private suspend fun seedEveryRecordType(accountId: String, useGoldenIds: Boolean = false): AccountRows {
        val dao = database.dao()
        val entryId = if (useGoldenIds) "entry-contract" else "local-entry"
        val attachmentId = if (useGoldenIds) "att-contract" else "local-attachment"
        val deviceId = if (useGoldenIds) "dev-contract" else "local-device"
        val fileBoxId = if (useGoldenIds) "filebox-contract" else "local-filebox"
        val rows = AccountRows(
            entry = entry(accountId, id = entryId),
            attachment = attachment(accountId, id = attachmentId).copy(entryId = entryId),
            device = device(accountId).copy(id = deviceId),
            fileBoxItem = fileBoxItem(accountId).copy(
                id = fileBoxId,
                entryId = entryId,
                attachmentId = attachmentId,
                sourceDeviceId = deviceId,
            ),
            transfer = transfer(accountId).copy(
                id = if (useGoldenIds) "transfer-contract" else "local-transfer",
                fileBoxItemId = fileBoxId,
                entryId = entryId,
                attachmentId = attachmentId,
                fromDeviceId = deviceId,
            ),
            conflict = conflict(accountId).copy(
                id = if (useGoldenIds) "conf-entry-entry-contract" else "local-conflict",
                entityId = entryId,
            ),
            tombstone = TombstoneEntity(
                accountId = accountId,
                id = if (useGoldenIds) "del-attachment-att-deleted" else "local-tombstone",
                entityKind = "attachment",
                entityId = if (useGoldenIds) "att-deleted" else "local-deleted-attachment",
                deletedAt = LOCAL_TIME,
                deletedByDeviceId = "local-device",
                reason = "local marker",
            ),
            queueItem = queue(accountId, entityKind = "entry", entityId = entryId),
            syncState = SyncStateEntity(
                accountId = accountId,
                lastAttemptAt = LOCAL_TIME,
                lastSyncedAt = LOCAL_TIME,
                lastMessage = "untouched",
                changeToken = "token-$accountId",
                updatedAt = LOCAL_TIME,
                queueCount = 1,
                valueJson = "{\"account\":\"$accountId\"}",
            ),
        )
        dao.upsertEntry(rows.entry)
        dao.upsertAttachment(rows.attachment)
        dao.upsertDevice(rows.device)
        dao.upsertFileBoxItem(rows.fileBoxItem)
        dao.upsertTransfer(rows.transfer)
        dao.upsertConflict(rows.conflict)
        dao.upsertTombstone(rows.tombstone)
        dao.insertQueueItemIfAbsent(rows.queueItem)
        dao.upsertSyncState(rows.syncState)
        return rows
    }

    private suspend fun assertEveryRecordTypeUnchanged(accountId: String, expected: AccountRows) {
        val dao = database.dao()
        assertEquals(expected.entry, dao.entry(accountId, expected.entry.id))
        assertEquals(expected.attachment, dao.attachment(accountId, expected.attachment.id))
        assertEquals(listOf(expected.device), dao.devices(accountId))
        assertEquals(listOf(expected.fileBoxItem), dao.fileBoxItems(accountId))
        assertEquals(listOf(expected.transfer), dao.transfers(accountId))
        assertEquals(listOf(expected.conflict), dao.conflicts(accountId))
        assertEquals(listOf(expected.tombstone), dao.tombstones(accountId))
        assertEquals(expected.queueItem, dao.queueItem(accountId, expected.queueItem.id))
        assertEquals(expected.syncState, dao.syncState(accountId))
    }

    private fun goldenFiles(): LinkedHashMap<String, String> = linkedMapOf(
        MANIFEST_PATH to fixture(MANIFEST_PATH),
        DEVICE_PATH to fixture(DEVICE_PATH),
        ENTRY_PATH to fixture(ENTRY_PATH),
        ATTACHMENT_PATH to fixture(ATTACHMENT_PATH),
        FILE_BOX_PATH to fixture(FILE_BOX_PATH),
        TRANSFER_PATH to fixture(TRANSFER_PATH),
        CONFLICT_PATH to fixture(CONFLICT_PATH),
        TOMBSTONE_PATH to fixture(TOMBSTONE_PATH),
    )

    private fun fixture(path: String): String =
        checkNotNull(javaClass.classLoader?.getResource("drive-v1/$path")) { "Missing fixture $path" }.readText()

    private fun manifestJson(
        entryCount: Int = 0,
        attachmentCount: Int = 0,
        fileBoxCount: Int = 0,
        transferCount: Int = 0,
    ): String = fixture(MANIFEST_PATH)
        .replace("\"entryCount\":1", "\"entryCount\":$entryCount")
        .replace("\"attachmentCount\":1", "\"attachmentCount\":$attachmentCount")
        .replace("\"fileBoxCount\":1", "\"fileBoxCount\":$fileBoxCount")
        .replace("\"transferCount\":1", "\"transferCount\":$transferCount")

    private fun tombstoneJson(entityKind: String, entityId: String): String =
        """{"id":"del-$entityKind-$entityId","entityKind":"$entityKind","entityId":"$entityId","deletedAt":"2026-05-23T09:50:00.000Z","deletedByDeviceId":"dev-contract","reason":"remote deletion"}"""

    private fun entry(accountId: String, id: String = "local-entry", title: String = "local title") =
        JournalEntryEntity(
            accountId = accountId,
            id = id,
            title = title,
            dateBucket = "2026-05-22",
            createdAt = LOCAL_TIME,
            updatedAt = LOCAL_TIME,
            authorId = "local-author",
            updatedByDeviceId = "local-device",
        )

    private fun attachment(accountId: String, id: String = "local-attachment") = AttachmentEntity(
        accountId = accountId,
        id = id,
        entryId = "local-entry",
        type = "file",
        filename = "local.csv",
        displaySize = "5 bytes",
        byteSize = 5,
        storagePath = "attachments/local.csv",
        syncStatus = "local",
        createdAt = LOCAL_TIME,
        updatedAt = LOCAL_TIME,
    )

    private fun device(accountId: String) = DeviceEntity(
        accountId = accountId,
        id = "local-device",
        name = "Local device",
        platform = "mobile",
        createdAt = LOCAL_TIME,
        lastSeenAt = LOCAL_TIME,
    )

    private fun fileBoxItem(accountId: String) = FileBoxItemEntity(
        accountId = accountId,
        id = "local-filebox",
        entryId = "local-entry",
        attachmentId = "local-attachment",
        filename = "local.csv",
        filesize = "5 bytes",
        sourceDeviceId = "local-device",
        sourceDeviceName = "Local device",
        status = "queued",
        createdAt = LOCAL_TIME,
        updatedAt = LOCAL_TIME,
        localObjectUrl = "blob:https://local.invalid/preserve-this-row",
    )

    private fun transfer(accountId: String) = TransferEntity(
        accountId = accountId,
        id = "local-transfer",
        fileBoxItemId = "local-filebox",
        entryId = "local-entry",
        attachmentId = "local-attachment",
        filename = "local.csv",
        fromDeviceId = "local-device",
        fromDeviceName = "Local device",
        provider = "google-drive",
        status = "queued",
        createdAt = LOCAL_TIME,
        updatedAt = LOCAL_TIME,
    )

    private fun conflict(accountId: String) = ConflictEntity(
        accountId = accountId,
        id = "local-conflict",
        entityKind = "entry",
        entityId = "local-entry",
        localUpdatedAt = LOCAL_TIME,
        remoteUpdatedAt = LOCAL_TIME,
        detectedAt = LOCAL_TIME,
        resolution = "pending",
        summary = "local conflict",
    )

    private fun queue(accountId: String, entityKind: String, entityId: String) = SyncQueueEntity(
        accountId = accountId,
        id = "local-upsert-$entityKind-$entityId",
        entityKind = entityKind,
        entityId = entityId,
        operation = "upsert",
        status = "queued",
        queuedAt = LOCAL_TIME,
        updatedAt = LOCAL_TIME,
        updatedByDeviceId = "local-device",
    )

    private data class AccountRows(
        val entry: JournalEntryEntity,
        val attachment: AttachmentEntity,
        val device: DeviceEntity,
        val fileBoxItem: FileBoxItemEntity,
        val transfer: TransferEntity,
        val conflict: ConflictEntity,
        val tombstone: TombstoneEntity,
        val queueItem: SyncQueueEntity,
        val syncState: SyncStateEntity,
    )

    private class FakeDriveRepository(
        private val jsonByPath: Map<String, String>,
        listedRefs: List<DriveFileRef>? = null,
    ) : DriveRepository {
        private val listedRefs = listedRefs ?: listedRefsFor(jsonByPath.keys)
        override val writeCapability = DriveWriteCapability.DisabledPendingContractParity
        val listRequests = mutableListOf<AccountId>()
        val jsonReads = mutableListOf<String>()
        val jsonReadAccounts = mutableListOf<AccountId>()
        var jsonWrites = 0
        var blobWrites = 0

        override suspend fun listManagedFiles(accountId: AccountId, prefix: String?): Result<List<DriveFileRef>> {
            listRequests += accountId
            return Result.success(listedRefs)
        }

        override suspend fun readJson(accountId: AccountId, path: String): Result<String?> {
            jsonReadAccounts += accountId
            jsonReads += path
            return Result.success(jsonByPath[path])
        }

        override suspend fun putJson(
            accountId: AccountId,
            path: String,
            json: String,
        ): Result<DriveFileRef> {
            jsonWrites += 1
            return Result.failure(AssertionError("Metadata pull must not write JSON."))
        }

        override suspend fun putBlob(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
        ): Result<DriveFileRef> {
            blobWrites += 1
            return Result.failure(AssertionError("Metadata pull must not write blobs."))
        }
    }

    companion object {
        private const val LOCAL_TIME = "2026-05-22T08:00:00.000Z"
        private const val SYNCED_AT = "2026-05-23T11:00:00.000Z"
        private const val MANIFEST_PATH = "manifest.json"
        private const val DEVICE_PATH = "devices/dev-contract.json"
        private const val ENTRY_PATH = "entries/2026-05-23.json"
        private const val ATTACHMENT_PATH = "attachments/2026-05-23/att-contract-result.csv.json"
        private const val FILE_BOX_PATH = "filebox/filebox-contract.json"
        private const val TRANSFER_PATH = "transfers/transfer-contract.json"
        private const val CONFLICT_PATH = "conflicts/conf-entry-entry-contract.json"
        private const val TOMBSTONE_PATH = "tombstones/attachment--att-deleted.json"
        private const val CONTRACT_ATTACHMENT_SHA =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

        private fun listedRefsFor(paths: Collection<String>): List<DriveFileRef> = buildList {
            paths.forEach { path ->
                add(ref(path))
                if (path.startsWith("attachments/") && path.endsWith(".json")) {
                    add(ref(path.removeSuffix(".json")).copy(mimeType = "application/octet-stream"))
                }
            }
        }

        private fun ref(path: String) = DriveFileRef(
            id = "drive-${path.hashCode()}",
            path = path,
            name = path.substringAfterLast('/'),
            mimeType = "application/json",
            size = null,
            updatedAt = LOCAL_TIME,
        )
    }
}
