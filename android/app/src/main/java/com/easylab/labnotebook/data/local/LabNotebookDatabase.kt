package com.easylab.labnotebook.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.room.withTransaction

@Database(
    entities = [
        AccountEntity::class, JournalEntryEntity::class, AttachmentEntity::class, DeviceEntity::class,
        FileBoxItemEntity::class, TransferEntity::class, ConflictEntity::class, TombstoneEntity::class,
        SyncQueueEntity::class, SyncStateEntity::class, DriveRawDocumentEntity::class, ProtocolEntity::class,
        DriveWriteOperationEntity::class, DriveWritePayloadEntity::class,
    ],
    version = 6,
    exportSchema = true,
)
abstract class LabNotebookDatabase : RoomDatabase() {
    abstract fun dao(): LabNotebookDao

    suspend fun clearAccount(accountId: AccountId) = withTransaction {
        dao().clearProtocols(accountId.value)
        dao().clearDriveRawDocuments(accountId.value)
        dao().clearDriveWriteOperations(accountId.value)
        dao().clearDriveWritePayloads(accountId.value)
        dao().clearTombstones(accountId.value)
        dao().clearConflicts(accountId.value)
        dao().clearTransfers(accountId.value)
        dao().clearFileBoxItems(accountId.value)
        dao().clearDevices(accountId.value)
        dao().clearAttachments(accountId.value)
        dao().clearEntries(accountId.value)
        dao().clearQueue(accountId.value)
        dao().clearSyncState(accountId.value)
        dao().deleteAccount(accountId.value)
    }

    companion object {
        @Volatile private var instance: LabNotebookDatabase? = null
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                listOf(
                    "experimentId TEXT", "projectId TEXT", "isDaily INTEGER",
                    "projectTagsJson TEXT NOT NULL DEFAULT '[]'", "experimentTagsJson TEXT NOT NULL DEFAULT '[]'",
                    "searchTermsJson TEXT NOT NULL DEFAULT '[]'", "linkedFilesJson TEXT NOT NULL DEFAULT '[]'",
                    "pinnedRegionsJson TEXT NOT NULL DEFAULT '[]'", "syncPath TEXT", "source TEXT",
                    "whatsappCapturesJson TEXT NOT NULL DEFAULT '[]'", "telegramCapturesJson TEXT NOT NULL DEFAULT '[]'",
                ).forEach { db.execSQL("ALTER TABLE journal_entries ADD COLUMN $it") }
                listOf(
                    "thumbnail TEXT", "linkedRegionId TEXT", "tag TEXT", "sampleId TEXT", "cachedPath TEXT",
                    "source TEXT", "sourceMessageId TEXT", "sourceMediaId TEXT", "contentType TEXT", "cacheKey TEXT",
                ).forEach { db.execSQL("ALTER TABLE attachments ADD COLUMN $it") }
                db.execSQL("ALTER TABLE sync_state ADD COLUMN updatedAt TEXT")
                db.execSQL("ALTER TABLE sync_state ADD COLUMN queueCount INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE sync_state ADD COLUMN valueJson TEXT")

                db.execSQL("CREATE TABLE IF NOT EXISTS devices (accountId TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL, createdAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, userAgent TEXT, appVersion TEXT, PRIMARY KEY(accountId, id))")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_devices_accountId_lastSeenAt ON devices(accountId, lastSeenAt)")
                db.execSQL("CREATE TABLE IF NOT EXISTS file_box_items (accountId TEXT NOT NULL, id TEXT NOT NULL, entryId TEXT NOT NULL, attachmentId TEXT, filename TEXT NOT NULL, filesize TEXT NOT NULL, contentType TEXT, sourceDeviceId TEXT NOT NULL, sourceDeviceName TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, driveFileId TEXT, localObjectUrl TEXT, lastError TEXT, PRIMARY KEY(accountId, id))")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_file_box_items_accountId_entryId ON file_box_items(accountId, entryId)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_file_box_items_accountId_status ON file_box_items(accountId, status)")
                db.execSQL("CREATE TABLE IF NOT EXISTS transfers (accountId TEXT NOT NULL, id TEXT NOT NULL, fileBoxItemId TEXT, entryId TEXT, attachmentId TEXT, filename TEXT NOT NULL, fromDeviceId TEXT NOT NULL, fromDeviceName TEXT NOT NULL, toDeviceId TEXT, toDeviceName TEXT, provider TEXT NOT NULL, status TEXT NOT NULL, bytesTotal INTEGER, bytesTransferred INTEGER, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, completedAt TEXT, driveFileId TEXT, lastError TEXT, PRIMARY KEY(accountId, id))")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_transfers_accountId_status ON transfers(accountId, status)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_transfers_accountId_updatedAt ON transfers(accountId, updatedAt)")
                db.execSQL("CREATE TABLE IF NOT EXISTS conflicts (accountId TEXT NOT NULL, id TEXT NOT NULL, entityKind TEXT NOT NULL, entityId TEXT NOT NULL, localUpdatedAt TEXT NOT NULL, remoteUpdatedAt TEXT NOT NULL, detectedAt TEXT NOT NULL, resolution TEXT NOT NULL, summary TEXT NOT NULL, localCopyJson TEXT, remoteCopyJson TEXT, PRIMARY KEY(accountId, id))")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_conflicts_accountId_resolution_detectedAt ON conflicts(accountId, resolution, detectedAt)")
                db.execSQL("CREATE TABLE IF NOT EXISTS tombstones (accountId TEXT NOT NULL, id TEXT NOT NULL, entityKind TEXT NOT NULL, entityId TEXT NOT NULL, deletedAt TEXT NOT NULL, deletedByDeviceId TEXT NOT NULL, reason TEXT, PRIMARY KEY(accountId, id))")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_tombstones_accountId_entityKind_entityId ON tombstones(accountId, entityKind, entityId)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_tombstones_accountId_deletedAt ON tombstones(accountId, deletedAt)")
            }
        }
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS drive_raw_documents (" +
                        "accountId TEXT NOT NULL, entityKind TEXT NOT NULL, entityId TEXT NOT NULL, " +
                        "path TEXT NOT NULL, driveFileId TEXT NOT NULL, driveModifiedAt TEXT NOT NULL, " +
                        "rawJson TEXT NOT NULL, PRIMARY KEY(accountId, entityKind, entityId))",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS index_drive_raw_documents_accountId_path " +
                        "ON drive_raw_documents(accountId, path)",
                )
            }
        }
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS protocols (" +
                        "accountId TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, " +
                        "createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, contentJson TEXT NOT NULL, " +
                        "tagsJson TEXT NOT NULL, searchTermsJson TEXT NOT NULL, PRIMARY KEY(accountId, id))",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_protocols_accountId_updatedAt ON protocols(accountId, updatedAt)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_protocols_accountId_title ON protocols(accountId, title)",
                )
            }
        }
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE sync_queue ADD COLUMN claimToken TEXT")
                db.execSQL("ALTER TABLE sync_queue ADD COLUMN claimedAt TEXT")
                db.execSQL("ALTER TABLE sync_queue ADD COLUMN leaseExpiresAt TEXT")
                db.execSQL("ALTER TABLE sync_queue ADD COLUMN attemptCount INTEGER NOT NULL DEFAULT 0")
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_sync_queue_accountId_status_leaseExpiresAt_queuedAt " +
                        "ON sync_queue(accountId, status, leaseExpiresAt, queuedAt)",
                )
            }
        }
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE drive_raw_documents ADD COLUMN driveVersion INTEGER")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS drive_write_operations (" +
                        "accountId TEXT NOT NULL, operationId TEXT NOT NULL, queueRecordId TEXT NOT NULL, " +
                        "queueMutationAt TEXT NOT NULL, entityKind TEXT NOT NULL, entityId TEXT NOT NULL, " +
                        "planHash TEXT NOT NULL, planJson TEXT NOT NULL, state TEXT NOT NULL, " +
                        "receiptsJson TEXT NOT NULL, revision INTEGER NOT NULL, " +
                        "createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, " +
                        "PRIMARY KEY(accountId, operationId))",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_drive_write_operations_accountId_state_updatedAt " +
                        "ON drive_write_operations(accountId, state, updatedAt)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_drive_write_operations_accountId_queueRecordId_queueMutationAt " +
                        "ON drive_write_operations(accountId, queueRecordId, queueMutationAt)",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS drive_write_payloads (" +
                        "accountId TEXT NOT NULL, payloadKey TEXT NOT NULL, contentSha256 TEXT NOT NULL, " +
                        "payloadJson TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY(accountId, payloadKey))",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_drive_write_payloads_accountId_contentSha256 " +
                        "ON drive_write_payloads(accountId, contentSha256)",
                )
            }
        }


        fun get(context: Context): LabNotebookDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, LabNotebookDatabase::class.java, "easylab-native-journal.db")
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6)
                .build().also { instance = it }
        }
    }
}
