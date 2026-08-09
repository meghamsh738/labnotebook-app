package com.easylab.labnotebook.data

import android.content.Context
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountEntity
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.DriveWriteOperationEntity
import com.easylab.labnotebook.data.local.DriveWritePayloadEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.ProtocolEntity
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@Entity(
    tableName = "drive_raw_documents",
    primaryKeys = ["accountId", "entityKind", "entityId"],
    indices = [Index(value = ["accountId", "path"], unique = true)],
)
data class LegacyDriveRawDocumentV5(
    val accountId: String,
    val entityKind: String,
    val entityId: String,
    val path: String,
    val driveFileId: String,
    val driveModifiedAt: String,
    val rawJson: String,
)

@Database(
    entities = [
        AccountEntity::class,
        JournalEntryEntity::class,
        AttachmentEntity::class,
        DeviceEntity::class,
        FileBoxItemEntity::class,
        TransferEntity::class,
        ConflictEntity::class,
        TombstoneEntity::class,
        SyncQueueEntity::class,
        SyncStateEntity::class,
        LegacyDriveRawDocumentV5::class,
        ProtocolEntity::class,
    ],
    version = 5,
    exportSchema = false,
)
abstract class LegacyLabNotebookDatabaseV5 : RoomDatabase()

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DriveWriteOperationMigrationTest {
    @Test
    fun migrationFiveToSixPreservesQueueLeasesBaselinesAndAccountScope() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.deleteDatabase(DATABASE_NAME)
        val legacy = Room.databaseBuilder(context, LegacyLabNotebookDatabaseV5::class.java, DATABASE_NAME)
            .allowMainThreadQueries()
            .build()
        legacy.openHelper.writableDatabase.apply {
            execSQL(
                "INSERT INTO accounts(accountId,email,displayName,pictureUrl,connectedAt) " +
                    "VALUES('account-a','a@example.invalid',NULL,NULL,'2026-08-01T10:00:00.000Z')",
            )
            execSQL(
                "INSERT INTO accounts(accountId,email,displayName,pictureUrl,connectedAt) " +
                    "VALUES('account-b','b@example.invalid',NULL,NULL,'2026-08-01T10:00:00.000Z')",
            )
            insertQueue(
                accountId = "account-a",
                id = "active",
                status = "syncing",
                token = "active-token",
                claimedAt = "2026-08-01T10:01:00.000Z",
                expiresAt = "2026-08-01T11:01:00.000Z",
                attempts = 3,
            )
            insertQueue("account-a", "completed", "completed", null, null, null, 2)
            insertQueue("account-b", "other-account", "queued", null, null, null, 0)
            execSQL(
                "INSERT INTO drive_raw_documents(" +
                    "accountId,entityKind,entityId,path,driveFileId,driveModifiedAt,rawJson) VALUES(" +
                    "'account-a','entry','entry-1','entries/2026-08-01/entry-1.json','file-a'," +
                    "'2026-08-01T10:00:00.000Z','{\"version\":1}')",
            )
        }
        legacy.close()

        val migrated = Room.databaseBuilder(context, LabNotebookDatabase::class.java, DATABASE_NAME)
            .addMigrations(LabNotebookDatabase.MIGRATION_5_6)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = migrated.dao()
            val active = requireNotNull(dao.queueItem("account-a", "active"))
            assertEquals("syncing", active.status)
            assertEquals("active-token", active.claimToken)
            assertEquals("2026-08-01T10:01:00.000Z", active.claimedAt)
            assertEquals("2026-08-01T11:01:00.000Z", active.leaseExpiresAt)
            assertEquals(3, active.attemptCount)

            val completed = requireNotNull(dao.queueItem("account-a", "completed"))
            assertEquals("completed", completed.status)
            assertNull(completed.claimToken)
            assertNull(completed.leaseExpiresAt)
            assertEquals(2, completed.attemptCount)

            val raw = requireNotNull(dao.driveRawDocument("account-a", "entry", "entry-1"))
            assertEquals("file-a", raw.driveFileId)
            assertNull(raw.driveVersion)
            assertEquals("{\"version\":1}", raw.rawJson)

            val operation = DriveWriteOperationEntity(
                accountId = "account-a",
                operationId = "shared-operation",
                queueRecordId = "queue",
                queueMutationAt = "2026-08-01T10:00:00.000Z",
                entityKind = "entry",
                entityId = "entry-1",
                planHash = "a".repeat(64),
                planJson = "{}",
                state = "prepared",
                createdAt = "2026-08-01T10:00:00.000Z",
                updatedAt = "2026-08-01T10:00:00.000Z",
            )
            dao.insertDriveWriteOperationUnchecked(operation)
            dao.insertDriveWriteOperationUnchecked(operation.copy(accountId = "account-b"))
            assertEquals("account-a", dao.driveWriteOperation("account-a", "shared-operation")?.accountId)
            assertEquals("account-b", dao.driveWriteOperation("account-b", "shared-operation")?.accountId)

            val payload = DriveWritePayloadEntity(
                accountId = "account-a",
                payloadKey = "shared-payload-key",
                contentSha256 = "b".repeat(64),
                payloadJson = "{}",
                createdAt = "2026-08-01T10:00:00.000Z",
            )
            dao.insertDriveWritePayloadIfAbsent(payload)
            dao.insertDriveWritePayloadIfAbsent(payload.copy(accountId = "account-b"))
            assertEquals("account-a", dao.driveWritePayload("account-a", payload.payloadKey)?.accountId)
            assertEquals("account-b", dao.driveWritePayload("account-b", payload.payloadKey)?.accountId)
        } finally {
            migrated.close()
            context.deleteDatabase(DATABASE_NAME)
        }
    }

    private fun androidx.sqlite.db.SupportSQLiteDatabase.insertQueue(
        accountId: String,
        id: String,
        status: String,
        token: String?,
        claimedAt: String?,
        expiresAt: String?,
        attempts: Int,
    ) {
        execSQL(
            "INSERT INTO sync_queue(accountId,id,entityKind,entityId,operation,status,queuedAt,updatedAt," +
                "updatedByDeviceId,baseVersion,lastError,claimToken,claimedAt,leaseExpiresAt,attemptCount) " +
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            arrayOf<Any?>(
                accountId,
                id,
                "entry",
                "entry-1",
                "upsert",
                status,
                "2026-08-01T10:00:00.000Z",
                "2026-08-01T10:00:00.000Z",
                "device",
                1,
                null,
                token,
                claimedAt,
                expiresAt,
                attempts,
            ),
        )
    }

    private companion object {
        const val DATABASE_NAME = "drive-write-migration-test"
    }
}
