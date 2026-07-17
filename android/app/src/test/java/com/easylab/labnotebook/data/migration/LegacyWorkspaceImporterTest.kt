package com.easylab.labnotebook.data.migration

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncStateEntity
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
        assertNull(dao.pendingQueue(accountA.value).single { it.entityKind == "entry" }.baseVersion)

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

    private fun existingEntry(
        accountId: String,
        id: String = "existing-native",
        title: String,
        syncStatus: String = "local",
    ) = JournalEntryEntity(
        accountId = accountId,
        id = id,
        title = title,
        dateBucket = "2026-07-16",
        createdAt = "2026-07-16T09:00:00.000Z",
        updatedAt = "2026-07-16T09:00:00.000Z",
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
