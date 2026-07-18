package com.easylab.labnotebook.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountEntity
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDao
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import com.easylab.labnotebook.data.local.deleteQueueEventId
import com.easylab.labnotebook.data.local.upsertQueueEventId
import com.easylab.labnotebook.data.repository.InMemoryAccountScopedRepository
import com.easylab.labnotebook.data.repository.InMemoryJournalRepository
import com.easylab.labnotebook.data.repository.DeletionMetadata
import com.easylab.labnotebook.data.repository.RoomDurableDeletionRepository
import com.easylab.labnotebook.data.repository.RoomEntryMutationRepository
import com.easylab.labnotebook.data.repository.RoomFileHubRepository
import com.easylab.labnotebook.data.repository.RoomJournalRepository
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@Entity(tableName = "accounts", primaryKeys = ["accountId"])
data class LegacyAccountEntity(
    val accountId: String,
    val email: String,
    val displayName: String? = null,
    val pictureUrl: String? = null,
    val connectedAt: String,
)

@Entity(
    tableName = "journal_entries",
    primaryKeys = ["accountId", "id"],
    indices = [Index(value = ["accountId", "dateBucket"]), Index(value = ["accountId", "updatedAt"])],
)
data class LegacyJournalEntryEntity(
    val accountId: String,
    val id: String,
    val title: String,
    val dateBucket: String,
    val createdAt: String,
    val updatedAt: String,
    val authorId: String,
    val contentJson: String = "[]",
    val tagsJson: String = "[]",
    val version: Int = 1,
    val updatedByDeviceId: String,
    val syncStatus: String = "local",
)

@Entity(
    tableName = "attachments",
    primaryKeys = ["accountId", "id"],
    indices = [Index(value = ["accountId", "entryId"]), Index(value = ["accountId", "syncStatus"])],
)
data class LegacyAttachmentEntity(
    val accountId: String,
    val id: String,
    val entryId: String,
    val type: String,
    val filename: String,
    val displaySize: String,
    val byteSize: Long? = null,
    val storagePath: String,
    val mimeType: String? = null,
    val sha256: String? = null,
    val localUri: String? = null,
    val driveFileId: String? = null,
    val pinnedOffline: Boolean = false,
    val syncStatus: String = "local",
    val createdAt: String,
    val updatedAt: String,
)

@Entity(
    tableName = "sync_queue",
    primaryKeys = ["accountId", "id"],
    indices = [Index(value = ["accountId", "status", "queuedAt"])],
)
data class LegacySyncQueueEntity(
    val accountId: String,
    val id: String,
    val entityKind: String,
    val entityId: String,
    val operation: String,
    val status: String = "queued",
    val queuedAt: String,
    val updatedAt: String,
    val updatedByDeviceId: String,
    val baseVersion: Int? = null,
    val lastError: String? = null,
)

@Entity(tableName = "sync_state", primaryKeys = ["accountId"])
data class LegacySyncStateEntity(
    val accountId: String,
    val lastAttemptAt: String? = null,
    val lastSyncedAt: String? = null,
    val lastMessage: String = "Native Drive writes are disabled until contract parity.",
    val changeToken: String? = null,
)

@Dao
interface LegacyV1Dao {
    @Insert suspend fun insertAccount(account: LegacyAccountEntity)
    @Insert suspend fun insertEntry(entry: LegacyJournalEntryEntity)
    @Insert suspend fun insertAttachment(attachment: LegacyAttachmentEntity)
    @Insert suspend fun insertQueue(item: LegacySyncQueueEntity)
    @Insert suspend fun insertState(state: LegacySyncStateEntity)
}

@Database(
    entities = [
        LegacyAccountEntity::class,
        LegacyJournalEntryEntity::class,
        LegacyAttachmentEntity::class,
        LegacySyncQueueEntity::class,
        LegacySyncStateEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class LegacyDatabaseV1 : RoomDatabase() {
    abstract fun dao(): LegacyV1Dao
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RoomRepositoriesTest {
    private val repository = InMemoryJournalRepository()

    @Test
    fun entriesAreAccountScoped() = runTest {
        val first = AccountId("google-subject-a")
        val second = AccountId("google-subject-b")
        repository.upsertEntry(first, entry(first.value))

        assertEquals("entry-1", repository.getEntry(first, "entry-1")?.id)
        assertNull(repository.getEntry(second, "entry-1"))
    }

    @Test
    fun repositoryRejectsCrossAccountWrites() = runTest {
        val result = runCatching { repository.upsertEntry(AccountId("account-b"), entry("account-a")) }
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("different account"))
    }

    @Test
    fun nativeEntrySaveUpdatesAndQueuesAtomicallyWithinTheAccount() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            val original = entry("account-a").copy(version = 4, syncStatus = "synced")
            dao.upsertEntry(original)
            dao.upsertEntry(entry("account-b").copy(title = "Private account B entry"))
            dao.upsertQueueItem(queue("account-a").copy(id = "stale-upsert", status = "failed"))

            val saved = RoomEntryMutationRepository(dao).saveEntry(
                accountId = AccountId("account-a"),
                entry = original,
                contentJson = "[{\"id\":\"paragraph-1\",\"type\":\"paragraph\",\"text\":\"Observed change\"}]",
                editedAt = "2026-07-16T11:00:00Z",
                deviceId = "pixel-7a",
            )

            assertEquals(5, saved.version)
            assertEquals("queued", saved.syncStatus)
            assertEquals("pixel-7a", saved.updatedByDeviceId)
            assertEquals(saved, dao.entry("account-a", "entry-1"))
            assertEquals("Private account B entry", dao.entry("account-b", "entry-1")?.title)
            val pending = dao.pendingQueueForEntity("account-a", "entry", "entry-1")
            assertEquals(1, pending.size)
            assertEquals(upsertQueueEventId("entry", "entry-1"), pending.single().id)
            assertEquals(4, pending.single().baseVersion)
            assertEquals("2026-07-16T11:00:00Z", pending.single().queuedAt)
        } finally {
            database.close()
        }
    }

    @Test
    fun nativeEntryCreationStagesVersionOneAndQueueAtomically() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            val createdAt = "2026-07-16T10:00:00Z"
            val candidate = entry("account-a").copy(
                id = "new-entry",
                version = 1,
                createdAt = createdAt,
                updatedAt = createdAt,
                updatedByDeviceId = "pixel-7a",
                syncStatus = "local",
            )

            val created = RoomEntryMutationRepository(dao).createEntry(AccountId("account-a"), candidate)

            assertEquals("queued", created.syncStatus)
            assertEquals(1, created.version)
            assertEquals(created, dao.entry("account-a", "new-entry"))
            val pending = dao.pendingQueueForEntity("account-a", "entry", "new-entry").single()
            assertNull(pending.baseVersion)
            assertEquals(createdAt, pending.queuedAt)
            assertTrue(runCatching {
                RoomEntryMutationRepository(dao).createEntry(AccountId("account-a"), candidate)
            }.isFailure)
        } finally {
            database.close()
        }
    }

    @Test
    fun nativeEntrySaveRejectsStaleAndTombstonedEdits() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            val current = entry("account-a").copy(version = 3, syncStatus = "synced")
            dao.upsertEntry(current)
            val repository = RoomEntryMutationRepository(dao)

            assertTrue(runCatching {
                repository.saveEntry(
                    AccountId("account-a"),
                    current.copy(version = 1),
                    "[]",
                    "2026-07-16T11:00:00Z",
                    "pixel-7a",
                )
            }.isFailure)
            val saved = repository.saveEntry(
                AccountId("account-a"),
                current,
                "[]",
                "2026-07-16T12:00:00Z",
                "pixel-7a",
            )
            assertEquals(4, saved.version)

            dao.upsertTombstone(
                TombstoneEntity("account-a", "deleted-entry", "entry", "entry-1", timestamp, "pixel-7a"),
            )
            assertTrue(runCatching {
                repository.saveEntry(
                    AccountId("account-a"),
                    saved,
                    "[]",
                    "2026-07-16T13:00:00Z",
                    "pixel-7a",
                )
            }.isFailure)
        } finally {
            database.close()
        }
    }

    @Test
    fun nativeEntrySaveRollsBackWhenQueueStagingFails() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            val original = entry("account-a").copy(contentJson = "[]", version = 2, syncStatus = "synced")
            dao.upsertEntry(original)
            database.openHelper.writableDatabase.execSQL(
                "CREATE TRIGGER fail_entry_queue BEFORE INSERT ON sync_queue " +
                    "WHEN NEW.id = '${upsertQueueEventId("entry", "entry-1")}' " +
                    "BEGIN SELECT RAISE(ABORT, 'forced rollback'); END",
            )

            assertTrue(runCatching {
                RoomEntryMutationRepository(dao).saveEntry(
                    AccountId("account-a"),
                    original,
                    "[{\"id\":\"p1\",\"type\":\"paragraph\",\"text\":\"Changed\"}]",
                    "2026-07-16T11:00:00Z",
                    "pixel-7a",
                )
            }.isFailure)
            assertEquals(original, dao.entry("account-a", "entry-1"))
            assertTrue(dao.pendingQueue("account-a").isEmpty())
        } finally {
            database.close()
        }
    }

    @Test
    fun everyAccountScopedRecordStoreIsolatedAndRejectsCrossAccountWrites() = runTest {
        val records = InMemoryAccountScopedRepository<FileBoxItemEntity>()
        val first = AccountId("google-subject-a")
        val second = AccountId("google-subject-b")
        val item = FileBoxItemEntity(
            accountId = first.value,
            id = "filebox-1",
            entryId = "entry-1",
            filename = "result.csv",
            filesize = "12 bytes",
            sourceDeviceId = "pixel-1",
            sourceDeviceName = "Pixel",
            status = "queued",
            createdAt = "2026-07-15T09:00:00Z",
            updatedAt = "2026-07-15T10:00:00Z",
        )
        records.upsert(first, item)

        assertEquals(item, records.get(first, item.id))
        assertNull(records.get(second, item.id))
        assertTrue(records.all(second).isEmpty())
        assertTrue(runCatching { records.upsert(second, item) }.isFailure)
    }

    @Test
    fun roomMigrationFromV1PreservesRowsAndAddsV5Schema() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "migration-${System.nanoTime()}.db"
        context.deleteDatabase(databaseName)
        val legacy = Room.databaseBuilder(context, LegacyDatabaseV1::class.java, databaseName)
            .allowMainThreadQueries()
            .build()
        legacy.dao().insertAccount(
            LegacyAccountEntity("account-a", "a@example.test", connectedAt = timestamp),
        )
        legacy.dao().insertEntry(legacyEntry("account-a"))
        legacy.dao().insertAttachment(legacyAttachment("account-a"))
        legacy.dao().insertQueue(legacyQueue("account-a"))
        legacy.dao().insertState(LegacySyncStateEntity("account-a", lastSyncedAt = timestamp))
        legacy.close()

        val migrated = Room.databaseBuilder(context, LabNotebookDatabase::class.java, databaseName)
            .addMigrations(
                LabNotebookDatabase.MIGRATION_1_2,
                LabNotebookDatabase.MIGRATION_2_3,
                LabNotebookDatabase.MIGRATION_3_4,
                LabNotebookDatabase.MIGRATION_4_5,
            )
            .allowMainThreadQueries()
            .build()
        try {
            val dao = migrated.dao()
            val migratedEntry = dao.entry("account-a", "entry-1")
            assertNotNull(migratedEntry)
            assertEquals("[]", migratedEntry?.projectTagsJson)
            assertEquals("result.csv", dao.attachment("account-a", "attachment-1")?.filename)
            assertEquals(1, dao.pendingQueue("account-a").size)
            assertNull(dao.pendingQueue("account-a").single().claimToken)
            assertNull(dao.pendingQueue("account-a").single().leaseExpiresAt)
            assertEquals(0, dao.pendingQueue("account-a").single().attemptCount)
            assertEquals(0, dao.observeSyncState("account-a").first()?.queueCount)
            assertTrue(dao.observeProtocols("account-a").first().isEmpty())
            dao.upsertDevice(device("account-a"))
            assertEquals(1, dao.devices("account-a").size)
            val raw = rawDocument("account-a")
            dao.upsertDriveRawDocument(raw)
            assertEquals(raw, dao.driveRawDocument("account-a", "entry", "entry-1"))
        } finally {
            migrated.close()
            context.deleteDatabase(databaseName)
        }
    }

    @Test
    fun roomAccountScopeAndClearAccountAreTransactional() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            seedAccount(database.dao(), "account-a")
            seedAccount(database.dao(), "account-b")
            database.dao().upsertDriveRawDocument(rawDocument("account-a"))
            database.dao().upsertDriveRawDocument(rawDocument("account-b"))
            assertEquals("account-a", database.dao().entry("account-a", "entry-1")?.accountId)
            assertEquals("account-b", database.dao().entry("account-b", "entry-1")?.accountId)
            assertTrue(runCatching {
                RoomJournalRepository(database.dao()).upsertEntry(AccountId("account-a"), entry("account-b"))
            }.isFailure)

            database.openHelper.writableDatabase.execSQL(
                "CREATE TRIGGER fail_account_a_clear BEFORE DELETE ON attachments " +
                    "WHEN OLD.accountId = 'account-a' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END",
            )
            assertTrue(runCatching { database.clearAccount(AccountId("account-a")) }.isFailure)
            assertAccountPresent(database.dao(), "account-a")
            database.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_account_a_clear")

            database.clearAccount(AccountId("account-a"))
            assertAccountAbsent(database.dao(), "account-a")
            assertAccountPresent(database.dao(), "account-b")
            assertTrue(database.dao().driveRawDocuments("account-a").isEmpty())
            assertEquals(listOf(rawDocument("account-b")), database.dao().driveRawDocuments("account-b"))
        } finally {
            database.close()
        }
    }

    @Test
    fun durableEntryDeletionStagesEntryAndDependentAttachmentDeletesPerAccount() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            listOf("account-a", "account-b").forEach { accountId ->
                dao.upsertEntry(entry(accountId))
                dao.upsertAttachment(attachment(accountId))
                dao.upsertFileBoxItem(fileBoxItem(accountId))
                dao.upsertTransfer(transfer(accountId))
                seedPendingGraphUpserts(dao, accountId)
            }
            dao.upsertQueueItem(
                queue("account-a").copy(
                    id = "delete-entry-entry-1",
                    operation = "delete",
                    status = "completed",
                    queuedAt = "2026-07-14T10:00:00Z",
                    updatedAt = "2026-07-14T10:00:00Z",
                ),
            )
            dao.upsertQueueItem(
                queue("account-a").copy(
                    id = "pending-entry-delete-history",
                    operation = "delete",
                    status = "failed",
                    queuedAt = "2026-07-14T11:00:00Z",
                    updatedAt = "2026-07-14T11:00:00Z",
                ),
            )
            dao.upsertQueueItem(
                queue("account-a").copy(
                    id = "unrelated-same-id",
                    entityKind = "conflict",
                    status = "failed",
                ),
            )
            val deleted = RoomDurableDeletionRepository(dao).deleteEntry(
                AccountId("account-a"),
                "entry-1",
                deletionMetadata,
            )

            assertTrue(deleted)
            assertNull(dao.entry("account-a", "entry-1"))
            assertNull(dao.attachment("account-a", "attachment-1"))
            assertTrue(dao.fileBoxItems("account-a").isEmpty())
            assertTrue(dao.transfers("account-a").isEmpty())
            assertNotNull(dao.entry("account-b", "entry-1"))
            assertNotNull(dao.attachment("account-b", "attachment-1"))
            assertEquals(1, dao.fileBoxItems("account-b").size)
            assertEquals(1, dao.transfers("account-b").size)
            assertEquals(
                setOf(
                    "entry" to "entry-1",
                    "attachment" to "attachment-1",
                    "fileBoxItem" to "filebox-1",
                    "transfer" to "transfer-1",
                ),
                dao.tombstones("account-a").map { it.entityKind to it.entityId }.toSet(),
            )
            assertEquals(
                setOf(
                    "entry" to "entry-1",
                    "attachment" to "attachment-1",
                    "fileBoxItem" to "filebox-1",
                    "transfer" to "transfer-1",
                    "conflict" to "entry-1",
                ),
                dao.pendingQueue("account-a").map { it.entityKind to it.entityId }.toSet(),
            )
            assertTrue(
                dao.pendingQueue("account-a")
                    .filterNot { it.id == "unrelated-same-id" }
                    .all { it.operation == "delete" },
            )
            assertEquals(
                setOf(
                    "delete-entry-entry-1",
                    deleteQueueEventId("attachment", "attachment-1", deletionMetadata.deletedAt),
                    deleteQueueEventId("fileBoxItem", "filebox-1", deletionMetadata.deletedAt),
                    deleteQueueEventId("transfer", "transfer-1", deletionMetadata.deletedAt),
                    deleteQueueEventId("entry", "entry-1", deletionMetadata.deletedAt),
                    "pending-entry-delete-history",
                    "unrelated-same-id",
                ),
                dao.queueItems("account-a").map { it.id }.toSet(),
            )
            assertEquals("completed", dao.queueItem("account-a", "delete-entry-entry-1")?.status)
            assertEquals("failed", dao.queueItem("account-a", "pending-entry-delete-history")?.status)
            assertEquals(
                "queued",
                dao.queueItem(
                    "account-a",
                    deleteQueueEventId("entry", "entry-1", deletionMetadata.deletedAt),
                )?.status,
            )
            assertTrue(dao.tombstones("account-b").isEmpty())
            assertEquals(
                setOf(
                    "stale-entry-upsert",
                    "stale-attachment-upsert",
                    "stale-fileBoxItem-upsert",
                    "stale-transfer-upsert",
                ),
                dao.pendingQueue("account-b").map { it.id }.toSet(),
            )
        } finally {
            database.close()
        }
    }

    @Test
    fun durableDeleteQueueIdsCannotAliasEntityIdsAndDeletionTimestamps() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            val timestampInsideId = "2026-07-15T10:00:00Z"
            val firstId = "entry-1@$timestampInsideId"
            dao.upsertEntry(entry("account-a").copy(id = firstId))
            assertTrue(
                RoomDurableDeletionRepository(dao).deleteEntry(
                    AccountId("account-a"),
                    firstId,
                    deletionMetadata.copy(deletedAt = "2026-07-16T10:00:00Z"),
                ),
            )

            dao.upsertEntry(entry("account-a"))
            assertTrue(
                RoomDurableDeletionRepository(dao).deleteEntry(
                    AccountId("account-a"),
                    "entry-1",
                    deletionMetadata.copy(deletedAt = timestampInsideId),
                ),
            )

            val firstEventId = deleteQueueEventId("entry", firstId, "2026-07-16T10:00:00Z")
            val secondEventId = deleteQueueEventId("entry", "entry-1", timestampInsideId)
            assertTrue(firstEventId != secondEventId)
            assertEquals(firstId, dao.queueItem("account-a", firstEventId)?.entityId)
            assertEquals("entry-1", dao.queueItem("account-a", secondEventId)?.entityId)
            assertEquals("queued", dao.queueItem("account-a", firstEventId)?.status)
            assertEquals("queued", dao.queueItem("account-a", secondEventId)?.status)
        } finally {
            database.close()
        }
    }

    @Test
    fun durableAttachmentDeletionIsAccountScopedAndMissingCrossAccountDeleteIsNoOp() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            dao.upsertAttachment(attachment("account-a"))
            dao.upsertAttachment(attachment("account-b"))
            dao.upsertFileBoxItem(fileBoxItem("account-a"))
            dao.upsertTransfer(transfer("account-a"))
            dao.upsertFileBoxItem(
                fileBoxItem("account-a").copy(
                    id = "filebox-unrelated",
                    attachmentId = null,
                    filename = "notes.txt",
                ),
            )
            dao.upsertTransfer(
                transfer("account-a").copy(
                    id = "transfer-unrelated",
                    fileBoxItemId = "filebox-unrelated",
                    attachmentId = null,
                    filename = "notes.txt",
                ),
            )
            seedPendingGraphUpserts(dao, "account-a")
            seedPendingGraphUpserts(dao, "account-b")
            dao.upsertTombstone(
                TombstoneEntity(
                    accountId = "account-a",
                    id = "preexisting-tombstone-id",
                    entityKind = "attachment",
                    entityId = "attachment-1",
                    deletedAt = "2026-07-14T10:00:00Z",
                    deletedByDeviceId = "older-device",
                ),
            )
            val repository = RoomDurableDeletionRepository(dao)

            assertTrue(!repository.deleteAttachment(AccountId("account-c"), "attachment-1", deletionMetadata))
            assertTrue(repository.deleteAttachment(AccountId("account-a"), "attachment-1", deletionMetadata))

            assertNull(dao.attachment("account-a", "attachment-1"))
            assertNotNull(dao.attachment("account-b", "attachment-1"))
            assertEquals(setOf("filebox-unrelated"), dao.fileBoxItems("account-a").map { it.id }.toSet())
            assertEquals(setOf("transfer-unrelated"), dao.transfers("account-a").map { it.id }.toSet())
            val accountATombstones = dao.tombstones("account-a")
            assertEquals(
                setOf(
                    "attachment" to "attachment-1",
                    "fileBoxItem" to "filebox-1",
                    "transfer" to "transfer-1",
                ),
                accountATombstones.map { it.entityKind to it.entityId }.toSet(),
            )
            val attachmentTombstone = accountATombstones.single { it.entityKind == "attachment" }
            assertEquals("preexisting-tombstone-id", attachmentTombstone.id)
            assertEquals(deletionMetadata.deletedAt, attachmentTombstone.deletedAt)
            assertEquals(
                accountATombstones.map { it.entityKind to it.entityId }.toSet() +
                    ("entry" to "entry-1"),
                dao.pendingQueue("account-a").map { it.entityKind to it.entityId }.toSet(),
            )
            assertTrue(
                dao.pendingQueue("account-a")
                    .filterNot { it.id == "stale-entry-upsert" }
                    .all { it.operation == "delete" },
            )
            assertTrue(dao.tombstones("account-b").isEmpty())
            assertEquals(
                setOf(
                    "stale-entry-upsert",
                    "stale-attachment-upsert",
                    "stale-fileBoxItem-upsert",
                    "stale-transfer-upsert",
                ),
                dao.pendingQueue("account-b").map { it.id }.toSet(),
            )
            assertTrue(dao.tombstones("account-c").isEmpty())
            assertTrue(dao.pendingQueue("account-c").isEmpty())
        } finally {
            database.close()
        }
    }

    @Test
    fun durableEntryDeletionRollsBackStagedRecordsAndPhysicalDeletesTogether() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            dao.upsertEntry(entry("account-a"))
            dao.upsertAttachment(attachment("account-a"))
            database.openHelper.writableDatabase.execSQL(
                "CREATE TRIGGER fail_durable_entry_delete BEFORE DELETE ON attachments " +
                    "WHEN OLD.accountId = 'account-a' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END",
            )

            assertTrue(runCatching {
                RoomDurableDeletionRepository(dao).deleteEntry(
                    AccountId("account-a"),
                    "entry-1",
                    deletionMetadata,
                )
            }.isFailure)

            assertNotNull(dao.entry("account-a", "entry-1"))
            assertNotNull(dao.attachment("account-a", "attachment-1"))
            assertTrue(dao.tombstones("account-a").isEmpty())
            assertTrue(dao.pendingQueue("account-a").isEmpty())
        } finally {
            database.close()
        }
    }

    @Test
    fun durableAttachmentDeletionRollsBackQueueCleanupStagingAndPhysicalDeletesTogether() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            dao.upsertAttachment(attachment("account-a"))
            dao.upsertFileBoxItem(fileBoxItem("account-a"))
            dao.upsertTransfer(transfer("account-a"))
            seedPendingGraphUpserts(dao, "account-a")
            database.openHelper.writableDatabase.execSQL(
                "CREATE TRIGGER fail_durable_attachment_delete BEFORE DELETE ON attachments " +
                    "WHEN OLD.accountId = 'account-a' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END",
            )

            assertTrue(runCatching {
                RoomDurableDeletionRepository(dao).deleteAttachment(
                    AccountId("account-a"),
                    "attachment-1",
                    deletionMetadata,
                )
            }.isFailure)

            assertNotNull(dao.attachment("account-a", "attachment-1"))
            assertEquals(setOf("filebox-1"), dao.fileBoxItems("account-a").map { it.id }.toSet())
            assertEquals(setOf("transfer-1"), dao.transfers("account-a").map { it.id }.toSet())
            assertTrue(dao.tombstones("account-a").isEmpty())
            assertEquals(
                setOf(
                    "stale-entry-upsert",
                    "stale-attachment-upsert",
                    "stale-fileBoxItem-upsert",
                    "stale-transfer-upsert",
                ),
                dao.pendingQueue("account-a").map { it.id }.toSet(),
            )
            assertTrue(dao.pendingQueue("account-a").all { it.operation == "upsert" })
        } finally {
            database.close()
        }
    }

    @Test
    fun fileHubRepositoryFiltersAccountsTombstonesAndCompletedIncomingRecords() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.dao()
            val repository = RoomFileHubRepository(dao)

            dao.upsertAttachment(
                attachment("account-a").copy(
                    id = "library-a",
                    filename = "visible-a.csv",
                ),
            )
            dao.upsertAttachment(
                attachment("account-a").copy(
                    id = "library-deleted",
                    filename = "deleted-a.csv",
                ),
            )
            dao.upsertAttachment(
                attachment("account-b").copy(
                    id = "library-b",
                    filename = "private-b.csv",
                ),
            )
            dao.upsertTombstone(
                tombstone("account-a").copy(
                    id = "tombstone-library",
                    entityKind = "attachment",
                    entityId = "library-deleted",
                ),
            )

            dao.upsertFileBoxItem(
                fileBoxItem("account-a").copy(
                    id = "incoming-a",
                    attachmentId = null,
                    filename = "incoming-a.tiff",
                    status = "available",
                ),
            )
            dao.upsertFileBoxItem(
                fileBoxItem("account-a").copy(
                    id = "incoming-attached",
                    filename = "already-attached.csv",
                    status = "attached",
                ),
            )
            dao.upsertFileBoxItem(
                fileBoxItem("account-a").copy(
                    id = "incoming-deleted",
                    filename = "deleted-incoming.csv",
                    status = "available",
                ),
            )
            dao.upsertFileBoxItem(
                fileBoxItem("account-b").copy(
                    id = "incoming-b",
                    filename = "private-incoming-b.csv",
                    status = "available",
                ),
            )
            dao.upsertTombstone(
                tombstone("account-a").copy(
                    id = "tombstone-incoming",
                    entityKind = "fileBoxItem",
                    entityId = "incoming-deleted",
                ),
            )

            dao.upsertTransfer(
                transfer("account-a").copy(
                    id = "activity-a",
                    filename = "activity-a.csv",
                    status = "completed",
                ),
            )
            dao.upsertTransfer(
                transfer("account-a").copy(
                    id = "activity-removed",
                    filename = "removed-activity.csv",
                    status = "removed",
                ),
            )
            dao.upsertTransfer(
                transfer("account-a").copy(
                    id = "activity-deleted",
                    filename = "deleted-activity.csv",
                    status = "completed",
                ),
            )
            dao.upsertTransfer(
                transfer("account-b").copy(
                    id = "activity-b",
                    filename = "private-activity-b.csv",
                    status = "completed",
                ),
            )
            dao.upsertTombstone(
                tombstone("account-a").copy(
                    id = "tombstone-activity",
                    entityKind = "transfer",
                    entityId = "activity-deleted",
                ),
            )

            assertEquals(
                listOf("visible-a.csv"),
                repository.observeLibrary(AccountId("account-a")).first().map { it.filename },
            )
            assertEquals(
                listOf("incoming-a.tiff"),
                repository.observeIncoming(AccountId("account-a")).first().map { it.filename },
            )
            assertEquals(
                listOf("activity-a.csv"),
                repository.observeActivity(AccountId("account-a")).first().map { it.filename },
            )
        } finally {
            database.close()
        }
    }

    private suspend fun seedAccount(dao: LabNotebookDao, accountId: String) {
        dao.upsertAccount(AccountEntity(accountId, "$accountId@example.test", connectedAt = timestamp))
        dao.upsertEntry(entry(accountId))
        dao.upsertAttachment(attachment(accountId))
        dao.upsertDevice(device(accountId))
        dao.upsertFileBoxItem(fileBoxItem(accountId))
        dao.upsertTransfer(transfer(accountId))
        dao.upsertConflict(conflict(accountId))
        dao.upsertTombstone(tombstone(accountId))
        dao.upsertQueueItem(queue(accountId))
        dao.upsertSyncState(SyncStateEntity(accountId, lastSyncedAt = timestamp, updatedAt = timestamp, queueCount = 1))
    }

    private suspend fun assertAccountPresent(dao: LabNotebookDao, accountId: String) {
        assertNotNull(dao.account(accountId))
        assertNotNull(dao.entry(accountId, "entry-1"))
        assertNotNull(dao.attachment(accountId, "attachment-1"))
        assertEquals(1, dao.devices(accountId).size)
        assertEquals(1, dao.fileBoxItems(accountId).size)
        assertEquals(1, dao.transfers(accountId).size)
        assertEquals(1, dao.conflicts(accountId).size)
        assertEquals(1, dao.tombstones(accountId).size)
        assertEquals(1, dao.pendingQueue(accountId).size)
        assertNotNull(dao.observeSyncState(accountId).first())
    }

    private suspend fun assertAccountAbsent(dao: LabNotebookDao, accountId: String) {
        assertNull(dao.account(accountId))
        assertNull(dao.entry(accountId, "entry-1"))
        assertNull(dao.attachment(accountId, "attachment-1"))
        assertTrue(dao.devices(accountId).isEmpty())
        assertTrue(dao.fileBoxItems(accountId).isEmpty())
        assertTrue(dao.transfers(accountId).isEmpty())
        assertTrue(dao.conflicts(accountId).isEmpty())
        assertTrue(dao.tombstones(accountId).isEmpty())
        assertTrue(dao.pendingQueue(accountId).isEmpty())
        assertNull(dao.observeSyncState(accountId).first())
    }

    private suspend fun seedPendingGraphUpserts(dao: LabNotebookDao, accountId: String) {
        listOf(
            Triple("entry", "entry-1", "queued"),
            Triple("attachment", "attachment-1", "failed"),
            Triple("fileBoxItem", "filebox-1", "queued"),
            Triple("transfer", "transfer-1", "failed"),
        ).forEach { (entityKind, entityId, status) ->
            dao.upsertQueueItem(
                queue(accountId).copy(
                    id = "stale-$entityKind-upsert",
                    entityKind = entityKind,
                    entityId = entityId,
                    status = status,
                    lastError = if (status == "failed") "older failure" else null,
                ),
            )
        }
    }

    private fun entry(accountId: String) = JournalEntryEntity(
        accountId = accountId,
        id = "entry-1",
        title = "Daily note",
        dateBucket = "2026-07-15",
        createdAt = "2026-07-15T09:00:00Z",
        updatedAt = "2026-07-15T10:00:00Z",
        authorId = accountId,
        updatedByDeviceId = "pixel-1",
    )

    private fun attachment(accountId: String) = AttachmentEntity(
        accountId = accountId, id = "attachment-1", entryId = "entry-1", type = "file",
        filename = "result.csv", displaySize = "12 bytes", byteSize = 12,
        storagePath = "attachments/result.csv", createdAt = timestamp, updatedAt = timestamp,
    )
    private fun device(accountId: String) = DeviceEntity(
        accountId, "device-1", "Pixel", "mobile", timestamp, timestamp,
    )
    private fun fileBoxItem(accountId: String) = FileBoxItemEntity(
        accountId, "filebox-1", "entry-1", "attachment-1", "result.csv", "12 bytes",
        sourceDeviceId = "device-1", sourceDeviceName = "Pixel", status = "available",
        createdAt = timestamp, updatedAt = timestamp,
    )
    private fun transfer(accountId: String) = TransferEntity(
        accountId, "transfer-1", "filebox-1", "entry-1", "attachment-1", "result.csv",
        "device-1", "Pixel", provider = "google-drive", status = "available",
        createdAt = timestamp, updatedAt = timestamp,
    )
    private fun conflict(accountId: String) = ConflictEntity(
        accountId, "conflict-1", "entry", "entry-1", timestamp, timestamp, timestamp,
        "pending", "Concurrent edit", localCopyJson = "{}",
    )
    private fun tombstone(accountId: String) = TombstoneEntity(
        accountId, "tombstone-1", "attachment", "old-attachment", timestamp, "device-1",
    )
    private fun queue(accountId: String) = SyncQueueEntity(
        accountId, "queue-1", "entry", "entry-1", "upsert", queuedAt = timestamp,
        updatedAt = timestamp, updatedByDeviceId = "device-1",
    )
    private fun rawDocument(accountId: String) = DriveRawDocumentEntity(
        accountId = accountId,
        entityKind = "entry",
        entityId = "entry-1",
        path = "entries/2026-07-15.json",
        driveFileId = "drive-entry-$accountId",
        driveModifiedAt = timestamp,
        rawJson = """{"id":"entry-1","account":"$accountId"}""",
    )

    private fun legacyEntry(accountId: String) = LegacyJournalEntryEntity(
        accountId, "entry-1", "Legacy note", "2026-07-15", timestamp, timestamp,
        accountId, updatedByDeviceId = "device-1",
    )
    private fun legacyAttachment(accountId: String) = LegacyAttachmentEntity(
        accountId, "attachment-1", "entry-1", "file", "result.csv", "12 bytes",
        storagePath = "attachments/result.csv", createdAt = timestamp, updatedAt = timestamp,
    )
    private fun legacyQueue(accountId: String) = LegacySyncQueueEntity(
        accountId, "queue-1", "entry", "entry-1", "upsert",
        queuedAt = timestamp, updatedAt = timestamp, updatedByDeviceId = "device-1",
    )

    companion object {
        private const val timestamp = "2026-07-15T10:00:00Z"
        private val deletionMetadata = DeletionMetadata(
            deletedAt = timestamp,
            deletedByDeviceId = "pixel-1",
            reason = "User deleted",
        )
    }
}
