package com.easylab.labnotebook.data.migration

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.deleteQueueEventId
import com.easylab.labnotebook.data.local.upsertQueueEventId
import com.easylab.labnotebook.sync.DriveV1LocalSerializer
import com.easylab.labnotebook.sync.DriveV1NewEntryPathSelection
import com.easylab.labnotebook.sync.DriveV1Paths
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
class LegacyWorkspaceImporterTest {
    private lateinit var database: LabNotebookDatabase
    private lateinit var blobStore: RecordingLegacyBlobStore
    private val accountA = AccountId("google-subject-a")
    private val accountB = AccountId("google-subject-b")

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        blobStore = RecordingLegacyBlobStore()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun webBackupFixtureImportsEveryRecordTypeIntoOneAccountAndScrubsLegacyPaths() = runTest {
        val source = fixture()
        val result = LegacyWorkspaceImporter(database, blobStore).import(
            accountId = accountA,
            activeDeviceId = "native-pixel",
            rawJson = source,
        )

        assertEquals(1, result.entries)
        assertEquals(1, result.attachments)
        assertEquals(1, result.fileBoxItems)
        assertEquals(1, result.transfers)
        assertEquals(1, result.conflicts)
        assertEquals(1, result.tombstones)
        assertEquals(1, result.verifiedBlobs)
        assertEquals(1, result.skippedOrphanBlobs)
        assertEquals(5, result.pendingQueueItems)
        assertTrue(result.sourceRetained)
        assertEquals(source, fixture())

        val dao = database.dao()
        val entry = checkNotNull(dao.entry(accountA.value, "entry-local"))
        assertNull(entry.syncPath)
        assertEquals("queued", entry.syncStatus)
        assertEquals("native/account/attachment-att-local", dao.attachment(accountA.value, "att-local")?.cachedPath)
        assertTrue(dao.attachment(accountA.value, "att-local")?.storagePath.orEmpty().startsWith("attachments/2026-07-16/"))
        assertNull(dao.attachment(accountA.value, "att-local")?.thumbnail)
        assertNull(dao.fileBoxItems(accountA.value).single().localObjectUrl)
        assertEquals("legacy-web-device", dao.devices(accountA.value).single().id)
        assertEquals("pending", dao.conflicts(accountA.value).single().resolution)
        assertEquals("att-deleted", dao.tombstones(accountA.value).single().entityId)
        assertEquals(5, dao.pendingQueue(accountA.value).size)
        val entryQueue = dao.pendingQueue(accountA.value).single { it.entityKind == "entry" }
        assertNull(entryQueue.baseVersion)
        assertEquals(1, entry.version)
        val serialized = DriveV1LocalSerializer.serializeEntry(
            accountA,
            entry,
            entryQueue,
            DriveV1Paths.entry(entry.dateBucket, entry.id),
            newEntryPathSelection = DriveV1NewEntryPathSelection.fromCompleteSameDayInventory(
                entityId = entry.id,
                dateBucket = entry.dateBucket,
                sameDayEntityIds = listOf(entry.id, "same-day-collision"),
            ),
        )
        assertEquals(DriveV1Paths.entry(entry.dateBucket, entry.id), serialized.path)

        assertNull(dao.entry(accountB.value, "entry-local"))
        assertTrue(dao.fileBoxItems(accountB.value).isEmpty())
        assertTrue(dao.tombstones(accountB.value).isEmpty())
    }

    @Test
    fun malformedBlobFailsBeforeRoomOrBlobMutation() = runTest {
        val source = fixture().replace("\"dataBase64\": \"aGVsbG8=\"", "\"dataBase64\": \"aGVsbG8h\"")
        val result = runCatching {
            LegacyWorkspaceImporter(database, blobStore).import(accountA, "native-pixel", source)
        }

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("size does not match"))
        assertTrue(blobStore.putIds.isEmpty())
        assertEquals(0, database.dao().entryCount(accountA.value))
        assertEquals(0, database.dao().queueCount(accountA.value))
    }

    @Test
    fun importReplacesStaleIncrementalSyncState() = runTest {
        database.dao().upsertSyncState(
            SyncStateEntity(
                accountId = accountA.value,
                lastAttemptAt = "2026-07-15T08:00:00.000Z",
                lastSyncedAt = "2026-07-15T08:00:00.000Z",
                lastMessage = "Stale state",
                changeToken = "stale-drive-change-token",
                updatedAt = "2026-07-15T08:00:00.000Z",
                queueCount = 99,
                valueJson = "{\"stale\":true}",
            ),
        )

        LegacyWorkspaceImporter(database, blobStore).import(accountA, "native-pixel", fixture())

        val state = checkNotNull(database.dao().syncState(accountA.value))
        assertNull(state.lastAttemptAt)
        assertNull(state.lastSyncedAt)
        assertNull(state.changeToken)
        assertNull(state.valueJson)
        assertEquals("2026-07-16T12:00:00.000Z", state.updatedAt)
        assertEquals(5, state.queueCount)
        assertEquals("Legacy workspace imported. Native Drive writes remain disabled.", state.lastMessage)
    }

    @Test
    fun emptyWorkspacePolicyRejectsExistingDataBeforeCachingBlobs() = runTest {
        database.dao().upsertEntry(existingEntry(accountA.value, title = "Existing native note"))

        val result = runCatching {
            LegacyWorkspaceImporter(database, blobStore).import(accountA, "native-pixel", fixture())
        }

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("already contains notebook data"))
        assertTrue(blobStore.putIds.isEmpty())
        assertEquals("Existing native note", database.dao().entry(accountA.value, "existing-native")?.title)
    }

    @Test
    fun mergePolicyKeepsDriveRestoredCollisionAndImportsOnlyVerifiedUnsyncedDependents() = runTest {
        database.dao().upsertEntry(
            existingEntry(accountA.value, id = "entry-local", title = "Drive restored title", syncStatus = "synced"),
        )

        val result = LegacyWorkspaceImporter(database, blobStore).import(
            accountId = accountA,
            activeDeviceId = "native-pixel",
            rawJson = fixture(),
            policy = LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        assertEquals(0, result.entries)
        assertEquals(1, result.attachments)
        assertEquals(1, result.skippedRecords)
        assertEquals("Drive restored title", database.dao().entry(accountA.value, "entry-local")?.title)
        assertNotNull(database.dao().attachment(accountA.value, "att-local"))
        assertEquals(4, database.dao().pendingQueue(accountA.value).size)
    }

    @Test
    fun requireEmptyWorkspacePreservesSyncedEntryVersion() = runTest {
        val source = fixture()
            .replace("\"version\": 3", "\"version\": 7")
            .replace("\"syncStatus\": \"queued\"", "\"syncStatus\": \"synced\"")

        val result = LegacyWorkspaceImporter(database, blobStore).import(accountA, "native-pixel", source)

        val entry = checkNotNull(database.dao().entry(accountA.value, "entry-local"))
        assertEquals(7, entry.version)
        assertEquals("synced", entry.syncStatus)
        assertTrue(database.dao().pendingQueue(accountA.value).none { it.entityKind == "entry" })
        assertEquals(4, result.pendingQueueItems)
    }

    @Test
    fun mergePolicyRebasesVerifiedUnsyncedEntryWithoutDriveBaseline() = runTest {
        val result = LegacyWorkspaceImporter(database, blobStore).import(
            accountA,
            "native-pixel",
            fixture(),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        val entry = checkNotNull(database.dao().entry(accountA.value, "entry-local"))
        val queue = database.dao().pendingQueue(accountA.value).single { it.entityKind == "entry" }
        assertEquals(1, result.entries)
        assertEquals(1, entry.version)
        assertNull(queue.baseVersion)
    }

    @Test
    fun mergePolicyImportsOnlyTombstonesStrictlyNewerThanLiveNativeRecord() = runTest {
        data class Case(val name: String, val deletedAt: String, val imported: Boolean)
        val cases = listOf(
            Case("older", "2026-07-16T08:00:00.000Z", false),
            Case("equal", "2026-07-16T09:00:00.000Z", false),
            Case("newer", "2026-07-16T13:00:00.000Z", true),
        )

        cases.forEach { case ->
            val account = AccountId("google-subject-tombstone-" + case.name)
            database.dao().upsertEntry(existingEntry(account.value, id = "entry-local", title = "Native note"))

            val result = LegacyWorkspaceImporter(database, blobStore).import(
                account,
                "native-pixel",
                withoutLocalUpserts(fixtureWithEntryTombstone(case.deletedAt)),
                LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
            )

            assertEquals(case.name, if (case.imported) 1 else 0, result.tombstones)
            assertEquals(case.name, case.imported, database.dao().tombstones(account.value).isNotEmpty())
            assertEquals(case.name, case.imported, database.dao().pendingQueue(account.value).any { it.operation == "delete" })
            assertEquals("Native note", database.dao().entry(account.value, "entry-local")?.title)
        }
    }

    @Test
    fun mergePolicyRejectsTombstoneForEveryPendingNativeUpsertStatus() = runTest {
        listOf("queued", "syncing", "failed").forEach { status ->
            val account = AccountId("google-subject-upsert-" + status)
            val dao = database.dao()
            dao.upsertEntry(existingEntry(account.value, id = "entry-local", title = "Pending " + status + " note"))
            dao.insertQueueItemIfAbsent(
                SyncQueueEntity(
                    accountId = account.value,
                    id = upsertQueueEventId("entry", "entry-local"),
                    entityKind = "entry",
                    entityId = "entry-local",
                    operation = "upsert",
                    status = status,
                    queuedAt = "2026-07-16T09:00:00.000Z",
                    updatedAt = "2026-07-16T09:00:00.000Z",
                    updatedByDeviceId = "native-pixel",
                    baseVersion = 1,
                ),
            )

            val result = LegacyWorkspaceImporter(database, blobStore).import(
                account,
                "native-pixel",
                fixtureWithEntryTombstone("2026-07-16T11:20:00.000Z"),
                LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
            )

            assertEquals(status, 0, result.tombstones)
            assertTrue(status, dao.tombstones(account.value).isEmpty())
            assertTrue(status, dao.pendingQueue(account.value).none { it.operation == "delete" })
            assertEquals(status, 1, dao.pendingQueue(account.value).count {
                it.operation == "upsert" && it.entityId == "entry-local"
            })
        }
    }

    @Test
    fun mergeImportCannotEraseActiveLeaseOrResurrectCompletedDeleteEvent() = runTest {
        data class Case(
            val account: AccountId,
            val status: String,
            val claimToken: String?,
            val claimedAt: String?,
            val leaseExpiresAt: String?,
            val attemptCount: Int,
        )
        val cases = listOf(
            Case(
                account = AccountId("google-subject-active-import"),
                status = "syncing",
                claimToken = "active-import-owner",
                claimedAt = "2026-07-16T10:00:00.000Z",
                leaseExpiresAt = "2026-07-16T11:00:00.000Z",
                attemptCount = 3,
            ),
            Case(
                account = AccountId("google-subject-completed-import"),
                status = "completed",
                claimToken = null,
                claimedAt = null,
                leaseExpiresAt = null,
                attemptCount = 2,
            ),
        )

        cases.forEach { case ->
            val dao = database.dao()
            val preserved = SyncQueueEntity(
                accountId = case.account.value,
                id = deleteQueueEventId("attachment", "att-deleted", "2026-07-16T12:00:00.000Z"),
                entityKind = "attachment",
                entityId = "att-deleted",
                operation = "delete",
                status = case.status,
                queuedAt = "2026-07-16T12:00:00.000Z",
                updatedAt = "2026-07-16T12:00:00.000Z",
                updatedByDeviceId = "native-pixel",
                claimToken = case.claimToken,
                claimedAt = case.claimedAt,
                leaseExpiresAt = case.leaseExpiresAt,
                attemptCount = case.attemptCount,
            )
            dao.insertQueueItemIfAbsent(preserved)

            LegacyWorkspaceImporter(database, blobStore).import(
                case.account,
                "native-pixel",
                withoutLocalUpserts(fixture()),
                LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
            )

            assertTrue(dao.tombstones(case.account.value).any { it.entityId == "att-deleted" })
            assertEquals(case.status, preserved, dao.queueItem(case.account.value, preserved.id))
        }
    }

    @Test
    fun sameExportOlderTombstoneDoesNotCoexistWithSelectedEntry() = runTest {
        val source = withoutLocalUpserts(
            fixtureWithTombstone("entry", "entry-local", "2026-07-16T10:00:00.000Z"),
        )

        val result = LegacyWorkspaceImporter(database, blobStore).import(accountA, "native-pixel", source)

        assertEquals(0, result.tombstones)
        assertNotNull(database.dao().entry(accountA.value, "entry-local"))
        assertTrue(database.dao().tombstones(accountA.value).isEmpty())
        assertTrue(database.dao().pendingQueue(accountA.value).none { it.operation == "delete" })
    }

    @Test
    fun sameExportOlderTombstonesDoNotHideSelectedNonEntryKinds() = runTest {
        data class Case(val kind: String, val id: String, val deletedAt: String)
        val cases = listOf(
            Case("attachment", "att-local", "2026-07-16T11:00:00.000Z"),
            Case("fileBoxItem", "filebox-local", "2026-07-16T11:00:00.000Z"),
            Case("transfer", "transfer-local", "2026-07-16T11:00:00.000Z"),
            Case("device", "legacy-web-device", "2026-07-16T11:00:00.000Z"),
        )

        cases.forEach { case ->
            val account = AccountId("google-subject-same-export-" + case.kind)
            val result = LegacyWorkspaceImporter(database, blobStore).import(
                account,
                "native-pixel",
                withoutLocalUpserts(fixtureWithTombstone(case.kind, case.id, case.deletedAt)),
            )

            assertEquals(case.kind, 0, result.tombstones)
            assertTrue(case.kind, database.dao().tombstones(account.value).isEmpty())
            when (case.kind) {
                "attachment" -> assertNotNull(database.dao().attachment(account.value, case.id))
                "fileBoxItem" -> assertTrue(database.dao().fileBoxItems(account.value).any { it.id == case.id })
                "transfer" -> assertTrue(database.dao().transfers(account.value).any { it.id == case.id })
                "device" -> assertTrue(database.dao().devices(account.value).any { it.id == case.id })
            }
        }
    }

    @Test
    fun parentTombstoneDoesNotHideImportedChildUpserts() = runTest {
        database.dao().upsertEntry(
            existingEntry(accountA.value, id = "entry-local", title = "Restored parent", syncStatus = "synced"),
        )

        val result = LegacyWorkspaceImporter(database, blobStore).import(
            accountA,
            "native-pixel",
            fixtureWithTombstone("entry", "entry-local", "2026-07-16T13:00:00.000Z"),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        assertEquals(0, result.tombstones)
        assertEquals(1, result.attachments)
        assertNotNull(database.dao().attachment(accountA.value, "att-local"))
        assertTrue(database.dao().pendingQueue(accountA.value).any {
            it.operation == "upsert" && it.entityKind == "attachment" && it.entityId == "att-local"
        })
        assertTrue(database.dao().pendingQueue(accountA.value).none { it.operation == "delete" })
    }

    @Test
    fun nonEntryParentTombstonesDoNotHideImportedDescendantUpserts() = runTest {
        val attachmentAccount = AccountId("google-subject-attachment-parent")
        database.dao().upsertEntry(
            existingEntry(
                attachmentAccount.value,
                id = "entry-local",
                title = "Restored attachment parent",
                syncStatus = "synced",
            ),
        )
        database.dao().upsertAttachment(existingAttachment(attachmentAccount.value))

        val attachmentResult = LegacyWorkspaceImporter(database, blobStore).import(
            attachmentAccount,
            "native-pixel",
            fixtureWithTombstone("attachment", "att-local", "2026-07-16T13:00:00.000Z"),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        assertEquals(0, attachmentResult.tombstones)
        assertTrue(database.dao().pendingQueue(attachmentAccount.value).any {
            it.operation == "upsert" && it.entityKind == "fileBoxItem" && it.entityId == "filebox-local"
        })

        val fileBoxAccount = AccountId("google-subject-filebox-parent")
        database.dao().upsertEntry(
            existingEntry(
                fileBoxAccount.value,
                id = "entry-local",
                title = "Restored File Box parent",
                syncStatus = "synced",
            ),
        )
        database.dao().upsertAttachment(existingAttachment(fileBoxAccount.value))
        database.dao().upsertFileBoxItem(
            FileBoxItemEntity(
                accountId = fileBoxAccount.value,
                id = "filebox-local",
                entryId = "entry-local",
                attachmentId = "att-local",
                filename = "viability.csv",
                filesize = "5 bytes",
                sourceDeviceId = "native-pixel",
                sourceDeviceName = "Native Pixel",
                status = "attached",
                createdAt = "2026-07-16T10:30:00.000Z",
                updatedAt = "2026-07-16T11:10:00.000Z",
            ),
        )

        val fileBoxResult = LegacyWorkspaceImporter(database, blobStore).import(
            fileBoxAccount,
            "native-pixel",
            fixtureWithTombstone("fileBoxItem", "filebox-local", "2026-07-16T13:00:00.000Z"),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        assertEquals(0, fileBoxResult.tombstones)
        assertTrue(database.dao().pendingQueue(fileBoxAccount.value).any {
            it.operation == "upsert" && it.entityKind == "transfer" && it.entityId == "transfer-local"
        })
    }

    @Test
    fun parentTombstoneDoesNotHideNativePendingChildUpsert() = runTest {
        val dao = database.dao()
        dao.upsertEntry(
            existingEntry(accountA.value, id = "entry-parent", title = "Native parent", syncStatus = "synced"),
        )
        dao.upsertAttachment(
            AttachmentEntity(
                accountId = accountA.value,
                id = "native-child",
                entryId = "entry-parent",
                type = "file",
                filename = "native.csv",
                displaySize = "5 bytes",
                storagePath = "attachments/native.csv",
                syncStatus = "queued",
                createdAt = "2026-07-16T11:00:00.000Z",
                updatedAt = "2026-07-16T12:00:00.000Z",
            ),
        )
        dao.insertQueueItemIfAbsent(
            SyncQueueEntity(
                accountId = accountA.value,
                id = upsertQueueEventId("attachment", "native-child"),
                entityKind = "attachment",
                entityId = "native-child",
                operation = "upsert",
                status = "syncing",
                queuedAt = "2026-07-16T12:00:00.000Z",
                updatedAt = "2026-07-16T12:00:00.000Z",
                updatedByDeviceId = "native-pixel",
            ),
        )

        val result = LegacyWorkspaceImporter(database, blobStore).import(
            accountA,
            "native-pixel",
            fixtureWithTombstone("entry", "entry-parent", "2026-07-16T13:00:00.000Z"),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        assertEquals(0, result.tombstones)
        assertNotNull(dao.attachment(accountA.value, "native-child"))
        assertEquals("syncing", dao.pendingQueue(accountA.value).single {
            it.entityKind == "attachment" && it.entityId == "native-child"
        }.status)
        assertTrue(dao.pendingQueue(accountA.value).none { it.operation == "delete" })
    }

    @Test
    fun requireEmptyProtectsAttachmentThatMappingNormalizesToLocalWithoutBlobOrDriveId() = runTest {
        val source = withoutSelectedAttachmentBlob(
            withoutLocalUpserts(
                fixtureWithTombstone("attachment", "att-local", "2026-07-16T13:00:00.000Z"),
            ),
        )

        val result = LegacyWorkspaceImporter(database, blobStore).import(accountA, "native-pixel", source)

        val attachment = checkNotNull(database.dao().attachment(accountA.value, "att-local"))
        assertEquals("local", attachment.syncStatus)
        assertEquals(0, result.tombstones)
        assertEquals(0, result.verifiedBlobs)
        assertTrue(database.dao().tombstones(accountA.value).isEmpty())
        assertTrue(database.dao().pendingQueue(accountA.value).any {
            it.operation == "upsert" && it.entityKind == "attachment" && it.entityId == "att-local"
        })
        assertTrue(database.dao().pendingQueue(accountA.value).none { it.operation == "delete" })
    }

    @Test
    fun tombstoneKindCandidateMustBeNewerThanTargetMarker() = runTest {
        data class Case(val account: AccountId, val deletedAt: String, val imported: Boolean)
        val cases = listOf(
            Case(accountA, "2026-07-16T10:00:00.000Z", false),
            Case(accountB, "2026-07-16T12:00:00.000Z", true),
        )

        cases.forEach { case ->
            val dao = database.dao()
            dao.upsertTombstone(
                TombstoneEntity(
                    accountId = case.account.value,
                    id = "native-marker",
                    entityKind = "attachment",
                    entityId = "native-deleted-attachment",
                    deletedAt = "2026-07-16T11:00:00.000Z",
                    deletedByDeviceId = "native-pixel",
                ),
            )

            val result = LegacyWorkspaceImporter(database, blobStore).import(
                case.account,
                "native-pixel",
                fixtureWithTombstone("tombstone", "native-marker", case.deletedAt),
                LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
            )

            assertEquals(case.imported, result.tombstones == 1)
            assertEquals(if (case.imported) 2 else 1, dao.tombstones(case.account.value).size)
            assertEquals(case.imported, dao.pendingQueue(case.account.value).any {
                it.operation == "delete" && it.entityKind == "tombstone" && it.entityId == "native-marker"
            })
        }
    }

    @Test
    fun tombstonePrimaryKeyOwnedByDifferentNativeTargetIsNotOverwritten() = runTest {
        val dao = database.dao()
        dao.upsertTombstone(
            TombstoneEntity(
                accountId = accountA.value,
                id = "delete-att-deleted",
                entityKind = "entry",
                entityId = "native-preserved-target",
                deletedAt = "2026-07-16T09:00:00.000Z",
                deletedByDeviceId = "native-pixel",
            ),
        )

        val result = LegacyWorkspaceImporter(database, blobStore).import(
            accountA,
            "native-pixel",
            fixture(),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        assertEquals(0, result.tombstones)
        val preserved = dao.tombstones(accountA.value).single()
        assertEquals("delete-att-deleted", preserved.id)
        assertEquals("entry", preserved.entityKind)
        assertEquals("native-preserved-target", preserved.entityId)
        assertTrue(dao.pendingQueue(accountA.value).none { it.operation == "delete" })
    }

    @Test
    fun mergePolicyImportsMissingTargetTombstoneAndIsIdempotent() = runTest {
        val importer = LegacyWorkspaceImporter(database, blobStore)

        val first = importer.import(
            accountA,
            "native-pixel",
            fixture(),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )
        val second = importer.import(
            accountA,
            "native-pixel",
            fixture(),
            LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
        )

        assertEquals(1, first.tombstones)
        assertEquals(0, second.tombstones)
        assertEquals(1, database.dao().tombstones(accountA.value).count { it.entityId == "att-deleted" })
        assertEquals(1, database.dao().pendingQueue(accountA.value).count {
            it.operation == "delete" && it.entityId == "att-deleted"
        })
    }

    @Test
    fun tombstonePlanChangeDuringBlobStagingAbortsAndRemovesStagedBlob() = runTest {
        database.dao().upsertEntry(
            existingEntry(accountA.value, id = "entry-parent", title = "Native note before staging"),
        )
        blobStore.onPut = {
            database.dao().upsertEntry(
                existingEntry(
                    accountA.value,
                    id = "entry-parent",
                    title = "Native note changed during staging",
                    updatedAt = "2026-07-16T14:00:00.000Z",
                ),
            )
        }

        val result = runCatching {
            LegacyWorkspaceImporter(database, blobStore).import(
                accountA,
                "native-pixel",
                fixtureWithTombstone("entry", "entry-parent", "2026-07-16T13:00:00.000Z"),
                LegacyImportPolicy.MergeVerifiedUnsyncedOnly,
            )
        }

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("workspace changed"))
        assertEquals(listOf("attachment-att-local"), blobStore.putIds)
        assertEquals(listOf("attachment-att-local"), blobStore.removedIds)
        assertTrue(database.dao().tombstones(accountA.value).isEmpty())
        assertEquals("Native note changed during staging", database.dao().entry(accountA.value, "entry-parent")?.title)
    }

    @Test
    fun stagedBlobsRollBackWhenWorkspaceChangesBeforeTransactionCommit() = runTest {
        val source = fixture()
        blobStore.onPut = {
            database.dao().upsertEntry(existingEntry(accountA.value, title = "Concurrent native note"))
        }

        val result = runCatching {
            LegacyWorkspaceImporter(database, blobStore).import(accountA, "native-pixel", source)
        }

        assertTrue(result.isFailure)
        assertEquals(listOf("attachment-att-local"), blobStore.putIds)
        assertEquals(listOf("attachment-att-local"), blobStore.removedIds)
        assertEquals("Concurrent native note", database.dao().entry(accountA.value, "existing-native")?.title)
        assertNull(database.dao().entry(accountA.value, "entry-local"))
    }

    private fun fixture(): String =
        checkNotNull(javaClass.classLoader?.getResource("legacy-workspace/legacy-workspace-export-v1.json")).readText()

    private fun fixtureWithEntryTombstone(deletedAt: String): String =
        fixtureWithTombstone("entry", "entry-local", deletedAt)

    private fun fixtureWithTombstone(entityKind: String, entityId: String, deletedAt: String): String = fixture()
        .replace("\"entityKind\": \"attachment\"", "\"entityKind\": \"" + entityKind + "\"")
        .replace("\"entityId\": \"att-deleted\"", "\"entityId\": \"" + entityId + "\"")
        .replace("\"deletedAt\": \"2026-07-16T11:20:00.000Z\"", "\"deletedAt\": \"" + deletedAt + "\"")

    private fun withoutLocalUpserts(source: String): String = source
        .replace("\"syncStatus\": \"queued\"", "\"syncStatus\": \"synced\"")
        .replace("\"syncStatus\": \"failed\"", "\"syncStatus\": \"synced\"")
        .replaceFirst("\"status\": \"queued\"", "\"status\": \"attached\"")
        .replaceFirst("\"status\": \"queued\"", "\"status\": \"attached\"")

    private fun withoutSelectedAttachmentBlob(source: String): String = source.replace(
        "\"id\": \"attachment-att-local\",\n      \"sha256\"",
        "\"id\": \"unrelated-attachment-blob\",\n      \"sha256\"",
    )

    private fun existingAttachment(accountId: String) = AttachmentEntity(
        accountId = accountId,
        id = "att-local",
        entryId = "entry-local",
        type = "file",
        filename = "viability.csv",
        displaySize = "5 bytes",
        storagePath = "attachments/viability.csv",
        syncStatus = "synced",
        createdAt = "2026-07-16T10:30:00.000Z",
        updatedAt = "2026-07-16T11:10:00.000Z",
    )

    private fun existingEntry(
        accountId: String,
        id: String = "existing-native",
        title: String,
        syncStatus: String = "local",
        updatedAt: String = "2026-07-16T09:00:00.000Z",
    ) = JournalEntryEntity(
        accountId = accountId,
        id = id,
        title = title,
        dateBucket = "2026-07-16",
        createdAt = "2026-07-16T09:00:00.000Z",
        updatedAt = updatedAt,
        authorId = "native-researcher",
        updatedByDeviceId = "native-pixel",
        syncStatus = syncStatus,
    )
}

private class RecordingLegacyBlobStore : LegacyBlobStore {
    val putIds = mutableListOf<String>()
    val removedIds = mutableListOf<String>()
    var onPut: suspend () -> Unit = {}

    override suspend fun putVerified(
        accountId: AccountId,
        blob: LegacyWorkspaceBlobV1,
        bytes: ByteArray,
    ): StoredLegacyBlob {
        assertFalse(accountId.value.isBlank())
        assertEquals(blob.size, bytes.size.toLong())
        putIds += blob.id
        onPut()
        return StoredLegacyBlob(blob.id, "native/account/${blob.id}", createdByImport = true)
    }

    override suspend fun removeIfCreated(blob: StoredLegacyBlob) {
        if (blob.createdByImport) removedIds += blob.id
    }
}
