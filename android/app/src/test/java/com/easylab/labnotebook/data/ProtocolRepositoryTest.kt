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
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.ProtocolEntity
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import com.easylab.labnotebook.data.repository.RoomProtocolRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@Entity(
    tableName = "sync_queue",
    primaryKeys = ["accountId", "id"],
    indices = [Index(value = ["accountId", "status", "queuedAt"])],
)
data class LegacyProtocolSyncQueueEntity(
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

@Dao
interface LegacyV3ProtocolMigrationDao {
    @Insert suspend fun insertAccount(account: AccountEntity)
    @Insert suspend fun insertEntry(entry: JournalEntryEntity)
    @Insert suspend fun insertRawDocument(document: DriveRawDocumentEntity)
}

@Database(
    entities = [
        AccountEntity::class, JournalEntryEntity::class, AttachmentEntity::class, DeviceEntity::class,
        FileBoxItemEntity::class, TransferEntity::class, ConflictEntity::class, TombstoneEntity::class,
        LegacyProtocolSyncQueueEntity::class, SyncStateEntity::class, DriveRawDocumentEntity::class,
    ],
    version = 3,
    exportSchema = false,
)
abstract class LegacyProtocolDatabaseV3 : RoomDatabase() {
    abstract fun dao(): LegacyV3ProtocolMigrationDao
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProtocolRepositoryTest {
    private val accountA = AccountId("protocol-account-a")
    private val accountB = AccountId("protocol-account-b")

    @Test
    fun migrationV3ToV5PreservesExistingRowsAndAddsProtocolStorage() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "protocol-v3-v5-${System.nanoTime()}.db"
        context.deleteDatabase(databaseName)
        Room.databaseBuilder(context, LegacyProtocolDatabaseV3::class.java, databaseName)
            .allowMainThreadQueries()
            .build()
            .also { legacy ->
                legacy.dao().insertAccount(accountEntity(accountA))
                legacy.dao().insertEntry(entryEntity(accountA))
                legacy.dao().insertRawDocument(rawDocument(accountA))
                legacy.close()
            }

        val migrated = Room.databaseBuilder(context, LabNotebookDatabase::class.java, databaseName)
            .addMigrations(LabNotebookDatabase.MIGRATION_3_4, LabNotebookDatabase.MIGRATION_4_5)
            .allowMainThreadQueries()
            .build()
        try {
            assertEquals("Preserved entry", migrated.dao().entry(accountA.value, "entry-before-v4")?.title)
            assertNotNull(migrated.dao().driveRawDocument(accountA.value, "entry", "entry-before-v4"))
            val created = RoomProtocolRepository(migrated.dao()).createProtocol(accountA, protocol(accountA))
            assertEquals(created, migrated.dao().protocol(accountA.value, created.id))
            assertEquals(0, migrated.dao().queueCount(accountA.value))
        } finally {
            migrated.close()
            context.deleteDatabase(databaseName)
        }
    }

    @Test
    fun roomProtocolCrudIsAccountScopedAndNeverStagesSyncQueueWork() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            database.dao().upsertAccount(accountEntity(accountA))
            database.dao().upsertAccount(accountEntity(accountB))
            val repository = RoomProtocolRepository(database.dao())
            val first = repository.createProtocol(accountA, protocol(accountA))
            repository.createProtocol(accountB, protocol(accountB).copy(title = "Private B protocol"))

            assertEquals(listOf(first), repository.observeProtocols(accountA).first())
            assertNull(repository.getProtocol(accountB, first.id + "-missing"))
            assertTrue(runCatching { repository.createProtocol(accountB, protocol(accountA)) }.isFailure)

            val updated = repository.updateProtocol(
                accountId = accountA,
                protocol = first.copy(title = "Updated A protocol", updatedAt = "2026-07-17T12:00:00Z"),
                expectedUpdatedAt = first.updatedAt,
            )
            assertEquals("Updated A protocol", repository.getProtocol(accountA, first.id)?.title)
            assertTrue(runCatching {
                repository.updateProtocol(
                    accountA,
                    updated.copy(title = "Stale edit", updatedAt = "2026-07-17T13:00:00Z"),
                    expectedUpdatedAt = first.updatedAt,
                )
            }.isFailure)
            assertEquals(0, database.dao().queueCount(accountA.value))
            assertEquals(0, database.dao().queueCount(accountB.value))

            assertFalse(repository.deleteProtocol(accountA, "missing"))
            assertTrue(repository.deleteProtocol(accountA, first.id))
            assertNull(repository.getProtocol(accountA, first.id))
            assertEquals("Private B protocol", repository.getProtocol(accountB, first.id)?.title)
        } finally {
            database.close()
        }
    }

    @Test
    fun concurrentCreatesAndUpdatesHaveExactlyOneWinner() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java).build()
        try {
            database.dao().upsertAccount(accountEntity(accountA))
            val repository = RoomProtocolRepository(database.dao())
            val createGate = CompletableDeferred<Unit>()
            val createResults = listOf("Create one", "Create two").map { title ->
                async(Dispatchers.IO) {
                    createGate.await()
                    runCatching { repository.createProtocol(accountA, protocol(accountA).copy(title = title)) }
                }
            }
            createGate.complete(Unit)
            assertEquals(1, createResults.awaitAll().count { it.isSuccess })

            val created = repository.getProtocol(accountA, "shared-protocol-id")!!
            val updateGate = CompletableDeferred<Unit>()
            val updateResults = listOf("Update one", "Update two").mapIndexed { index, title ->
                async(Dispatchers.IO) {
                    updateGate.await()
                    runCatching {
                        repository.updateProtocol(
                            accountA,
                            created.copy(title = title, updatedAt = "2026-07-17T1${index + 1}:00:00Z"),
                            expectedUpdatedAt = created.updatedAt,
                        )
                    }
                }
            }
            updateGate.complete(Unit)
            assertEquals(1, updateResults.awaitAll().count { it.isSuccess })
            assertTrue(repository.getProtocol(accountA, created.id)?.title in setOf("Update one", "Update two"))
        } finally {
            database.close()
        }
    }

    @Test
    fun mutationsRequireAnActiveAccountAndCannotRecreateAfterClear() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java).build()
        try {
            val repository = RoomProtocolRepository(database.dao())
            assertTrue(runCatching { repository.createProtocol(accountA, protocol(accountA)) }.isFailure)

            database.dao().upsertAccount(accountEntity(accountA))
            val created = repository.createProtocol(accountA, protocol(accountA))
            database.clearAccount(accountA)

            assertTrue(runCatching {
                repository.createProtocol(accountA, created.copy(id = "after-clear"))
            }.isFailure)
            assertTrue(runCatching {
                repository.updateProtocol(
                    accountA,
                    created.copy(updatedAt = "2026-07-17T12:00:00Z"),
                    expectedUpdatedAt = created.updatedAt,
                )
            }.isFailure)
            assertNull(repository.getProtocol(accountA, created.id))
            assertNull(repository.getProtocol(accountA, "after-clear"))
        } finally {
            database.close()
        }
    }

    @Test
    fun clearRacingCreatesCannotLeaveOrphanProtocols() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java).build()
        try {
            database.dao().upsertAccount(accountEntity(accountA))
            val repository = RoomProtocolRepository(database.dao())
            val gate = CompletableDeferred<Unit>()
            val protocolIds = (0 until 20).map { "racing-protocol-$it" }
            val creates = protocolIds.map { protocolId ->
                async(Dispatchers.IO) {
                    gate.await()
                    runCatching {
                        repository.createProtocol(accountA, protocol(accountA).copy(id = protocolId))
                    }
                }
            }
            val clear = async(Dispatchers.IO) {
                gate.await()
                database.clearAccount(accountA)
            }
            gate.complete(Unit)
            creates.awaitAll()
            clear.await()

            assertNull(database.dao().account(accountA.value))
            protocolIds.forEach { assertNull(repository.getProtocol(accountA, it)) }
        } finally {
            database.close()
        }
    }

    @Test
    fun clearAccountRemovesOnlyThatAccountsProtocolsTransactionally() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            database.dao().upsertAccount(accountEntity(accountA))
            database.dao().upsertAccount(accountEntity(accountB))
            val repository = RoomProtocolRepository(database.dao())
            repository.createProtocol(accountA, protocol(accountA))
            repository.createProtocol(accountB, protocol(accountB).copy(title = "Keep B"))

            database.clearAccount(accountA)

            assertNull(repository.getProtocol(accountA, "shared-protocol-id"))
            assertEquals("Keep B", repository.getProtocol(accountB, "shared-protocol-id")?.title)
            assertNull(database.dao().account(accountA.value))
            assertNotNull(database.dao().account(accountB.value))
        } finally {
            database.close()
        }
    }

    private fun protocol(accountId: AccountId) = ProtocolEntity(
        accountId = accountId.value,
        id = "shared-protocol-id",
        title = "Protocol A",
        createdAt = "2026-07-17T10:00:00Z",
        updatedAt = "2026-07-17T10:00:00Z",
        contentJson = "[{\"id\":\"aim\",\"type\":\"heading\",\"level\":2,\"text\":\"Aim\"}]",
        tagsJson = "[\"SOP\"]",
    )

    private fun accountEntity(accountId: AccountId) = AccountEntity(
        accountId = accountId.value,
        email = "${accountId.value}@example.test",
        connectedAt = "2026-07-17T09:00:00Z",
    )

    private fun entryEntity(accountId: AccountId) = JournalEntryEntity(
        accountId = accountId.value,
        id = "entry-before-v4",
        title = "Preserved entry",
        dateBucket = "2026-07-17",
        createdAt = "2026-07-17T09:00:00Z",
        updatedAt = "2026-07-17T09:00:00Z",
        authorId = accountId.value,
        updatedByDeviceId = "migration-test",
    )

    private fun rawDocument(accountId: AccountId) = DriveRawDocumentEntity(
        accountId = accountId.value,
        entityKind = "entry",
        entityId = "entry-before-v4",
        path = "entries/2026-07-17.json",
        driveFileId = "drive-file",
        driveModifiedAt = "2026-07-17T09:00:00Z",
        rawJson = "{}",
    )
}
