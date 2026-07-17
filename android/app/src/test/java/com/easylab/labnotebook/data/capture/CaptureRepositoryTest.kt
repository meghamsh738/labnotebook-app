package com.easylab.labnotebook.data.capture

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.TombstoneEntity
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CaptureRepositoryTest {
    private lateinit var database: LabNotebookDatabase
    private lateinit var blobStore: RecordingCaptureBlobStore
    private val accountA = AccountId("google-subject-a")
    private val accountB = AccountId("google-subject-b")

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        blobStore = RecordingCaptureBlobStore()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun newTodayCaptureStagesEntryAttachmentBlobAndQueueInsideOneAccount() = runTest {
        val result = repository().attachToToday(
            accountId = accountA,
            activeDeviceId = "native-pixel",
            dateBucket = "2026-07-16",
            capturedAt = "2026-07-16T12:00:00Z",
            files = listOf(CaptureFile("raw data 01.csv", "text/csv", "a,b\n1,2".encodeToByteArray())),
        )

        val attachment = result.attachments.single()
        val linkedIds = Json.decodeFromString<List<String>>(result.entry.linkedFilesJson)
        assertEquals(listOf(attachment.id), linkedIds)
        assertEquals("raw data 01.csv", attachment.filename)
        assertTrue(attachment.storagePath.endsWith("raw_data_01.csv"))
        assertTrue(attachment.cachedPath.orEmpty().contains(accountA.value))
        assertTrue(attachment.pinnedOffline)
        assertEquals("android", attachment.source)
        assertEquals("queued", result.entry.syncStatus)
        assertEquals("queued", attachment.syncStatus)
        assertEquals(setOf("entry", "attachment"), database.dao().queueItems(accountA.value).map { it.entityKind }.toSet())
        assertEquals(2, database.dao().queueCount(accountA.value))
        assertEquals(0, database.dao().entryCount(accountB.value))
        assertEquals(0, database.dao().attachmentCount(accountB.value))
        assertEquals(listOf(accountA.value), blobStore.accountIds)
    }

    @Test
    fun existingTodayCapturePreservesContentAndLinksWhileIncrementingVersion() = runTest {
        val existing = entry(
            accountId = accountA.value,
            version = 4,
            linkedFilesJson = "[\"att-existing\"]",
            contentJson = "[{\"id\":\"paragraph-1\",\"type\":\"paragraph\",\"text\":\"Observation\"}]",
        )
        database.dao().upsertEntry(existing)
        database.dao().upsertEntry(entry(accountB.value, id = "private-b", title = "Private account B note"))

        val result = repository().attachToToday(
            accountA,
            "native-tablet",
            "2026-07-16",
            "2026-07-16T12:30:00Z",
            listOf(CaptureFile("micrograph.tiff", "image/tiff", byteArrayOf(1, 2, 3))),
        )

        val linkedIds = Json.decodeFromString<List<String>>(result.entry.linkedFilesJson)
        assertEquals(5, result.entry.version)
        assertEquals(existing.contentJson, result.entry.contentJson)
        assertEquals("native-tablet", result.entry.updatedByDeviceId)
        assertEquals("att-existing", linkedIds.first())
        assertEquals(result.attachments.single().id, linkedIds.last())
        assertEquals("Private account B note", database.dao().entry(accountB.value, "private-b")?.title)
        assertEquals(2, database.dao().queueCount(accountA.value))
        assertEquals(0, database.dao().queueCount(accountB.value))
    }

    @Test
    fun invalidCalendarDateIsRejectedBeforeBlobOrRoomMutation() = runTest {
        val result = runCatching {
            repository().attachToToday(
                accountA,
                "native-pixel",
                "2026-02-30",
                "2026-02-28T12:00:00Z",
                listOf(CaptureFile("result.csv", "text/csv", byteArrayOf(1))),
            )
        }

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("yyyy-MM-dd"))
        assertTrue(blobStore.putIds.isEmpty())
        assertEquals(0, database.dao().entryCount(accountA.value))
        assertEquals(0, database.dao().queueCount(accountA.value))
    }

    @Test
    fun oversizedFileIsRejectedBeforeBlobOrRoomMutation() = runTest {
        val result = runCatching {
            repository(CaptureLimits(maxFileBytes = 4, maxBatchBytes = 8, maxFiles = 2)).attachToToday(
                accountA,
                "native-pixel",
                "2026-07-16",
                "2026-07-16T12:00:00Z",
                listOf(CaptureFile("large.bin", "application/octet-stream", ByteArray(5))),
            )
        }

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("too large"))
        assertTrue(blobStore.putIds.isEmpty())
        assertEquals(0, database.dao().entryCount(accountA.value))
        assertEquals(0, database.dao().queueCount(accountA.value))
    }

    @Test
    fun concurrentTodayMutationRollsBackNewlyCachedBlobWithoutOverwritingEntry() = runTest {
        val existing = entry(accountA.value, version = 2)
        database.dao().upsertEntry(existing)
        blobStore.onPut = {
            database.dao().upsertEntry(existing.copy(version = 3, title = "Changed elsewhere"))
        }

        val result = runCatching {
            repository().attachToToday(
                accountA,
                "native-pixel",
                "2026-07-16",
                "2026-07-16T12:00:00Z",
                listOf(CaptureFile("result.pdf", "application/pdf", byteArrayOf(4, 5, 6))),
            )
        }

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("changed while files were being prepared"))
        assertEquals("Changed elsewhere", database.dao().entry(accountA.value, existing.id)?.title)
        assertEquals(blobStore.putIds, blobStore.removedIds)
        assertEquals(0, database.dao().attachmentCount(accountA.value))
        assertEquals(0, database.dao().queueCount(accountA.value))
    }

    @Test
    fun secondBlobFailureRollsBackFirstBlobAndLeavesRoomUntouched() = runTest {
        blobStore.failOnCall = 2

        val result = runCatching {
            repository().attachToToday(
                accountA,
                "native-pixel",
                "2026-07-16",
                "2026-07-16T12:00:00Z",
                listOf(
                    CaptureFile("first.txt", "text/plain", byteArrayOf(1)),
                    CaptureFile("second.txt", "text/plain", byteArrayOf(2)),
                ),
            )
        }

        assertTrue(result.isFailure)
        assertEquals(2, blobStore.putIds.size)
        assertEquals(listOf(blobStore.putIds.first()), blobStore.removedIds)
        assertEquals(0, database.dao().entryCount(accountA.value))
        assertEquals(0, database.dao().attachmentCount(accountA.value))
        assertEquals(0, database.dao().queueCount(accountA.value))
    }

    @Test
    fun captureOnADeletedDayCreatesFreshEntryWithoutRevivingTheTombstone() = runTest {
        val deleted = entry(accountA.value, id = "deleted-entry")
        database.dao().upsertEntry(deleted)
        database.dao().upsertTombstone(
            TombstoneEntity(
                accountId = accountA.value,
                id = "tombstone-deleted-entry",
                entityKind = "entry",
                entityId = deleted.id,
                deletedAt = "2026-07-16T11:00:00Z",
                deletedByDeviceId = "native-pixel",
            ),
        )

        val result = repository().attachToToday(
            accountA,
            "native-pixel",
            "2026-07-16",
            "2026-07-16T12:00:00Z",
            listOf(CaptureFile("replacement.jpg", "image/jpeg", byteArrayOf(9, 8, 7))),
        )

        assertFalse(result.entry.id == deleted.id)
        assertEquals("deleted-entry", database.dao().tombstones(accountA.value).single().entityId)
        assertEquals(result.entry.id, result.attachments.single().entryId)
        assertEquals(2, database.dao().queueCount(accountA.value))
    }

    private fun repository(limits: CaptureLimits = CaptureLimits()) =
        RoomCaptureRepository(database, blobStore, limits)

    private fun entry(
        accountId: String,
        id: String = "entry-today",
        title: String = "TNF dose response",
        version: Int = 1,
        linkedFilesJson: String = "[]",
        contentJson: String = "[]",
    ) = JournalEntryEntity(
        accountId = accountId,
        id = id,
        title = title,
        dateBucket = "2026-07-16",
        createdAt = "2026-07-16T09:00:00Z",
        updatedAt = "2026-07-16T09:00:00Z",
        authorId = accountId,
        contentJson = contentJson,
        version = version,
        updatedByDeviceId = "native-pixel",
        syncStatus = "synced",
        linkedFilesJson = linkedFilesJson,
    )
}

private class RecordingCaptureBlobStore : CaptureBlobStore {
    val putIds = mutableListOf<String>()
    val removedIds = mutableListOf<String>()
    val accountIds = mutableListOf<String>()
    var failOnCall: Int? = null
    var onPut: suspend () -> Unit = {}

    override suspend fun put(
        accountId: AccountId,
        attachmentId: String,
        bytes: ByteArray,
        sha256: String,
    ): StoredCaptureBlob {
        assertFalse(bytes.isEmpty())
        assertFalse(sha256.isBlank())
        accountIds += accountId.value
        putIds += attachmentId
        onPut()
        if (putIds.size == failOnCall) error("Blob cache is unavailable.")
        return StoredCaptureBlob(
            attachmentId = attachmentId,
            path = "capture/${accountId.value}/$attachmentId",
            createdByCapture = true,
        )
    }

    override suspend fun removeIfCreated(blob: StoredCaptureBlob) {
        if (blob.createdByCapture) removedIds += blob.attachmentId
    }
}
