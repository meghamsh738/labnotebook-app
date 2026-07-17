package com.easylab.labnotebook.data.local

import androidx.room.Entity
import androidx.room.Index

@JvmInline
value class AccountId(val value: String) {
    init { require(value.isNotBlank()) { "Account id must not be blank." } }
}

interface AccountScopedRecord {
    val accountId: String
    val id: String
}

@Entity(tableName = "accounts", primaryKeys = ["accountId"])
data class AccountEntity(val accountId: String, val email: String, val displayName: String? = null, val pictureUrl: String? = null, val connectedAt: String)

@Entity(tableName = "journal_entries", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "dateBucket"]), Index(value = ["accountId", "updatedAt"])])
data class JournalEntryEntity(
    override val accountId: String, override val id: String, val title: String, val dateBucket: String,
    val createdAt: String, val updatedAt: String, val authorId: String,
    val contentJson: String = "[]", val tagsJson: String = "[]", val version: Int = 1,
    val updatedByDeviceId: String, val syncStatus: String = "local",
    val experimentId: String? = null, val projectId: String? = null, val isDaily: Boolean? = null,
    val projectTagsJson: String = "[]", val experimentTagsJson: String = "[]",
    val searchTermsJson: String = "[]", val linkedFilesJson: String = "[]",
    val pinnedRegionsJson: String = "[]", val syncPath: String? = null, val source: String? = null,
    val whatsappCapturesJson: String = "[]", val telegramCapturesJson: String = "[]",
) : AccountScopedRecord

@Entity(tableName = "attachments", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "entryId"]), Index(value = ["accountId", "syncStatus"])])
data class AttachmentEntity(
    override val accountId: String, override val id: String, val entryId: String, val type: String,
    val filename: String, val displaySize: String, val byteSize: Long? = null,
    val storagePath: String, val mimeType: String? = null, val sha256: String? = null,
    val localUri: String? = null, val driveFileId: String? = null, val pinnedOffline: Boolean = false,
    val syncStatus: String = "local", val createdAt: String, val updatedAt: String,
    val thumbnail: String? = null, val linkedRegionId: String? = null, val tag: String? = null,
    val sampleId: String? = null, val cachedPath: String? = null, val source: String? = null,
    val sourceMessageId: String? = null, val sourceMediaId: String? = null, val contentType: String? = null,
    val cacheKey: String? = null,
) : AccountScopedRecord

@Entity(tableName = "devices", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "lastSeenAt"])])
data class DeviceEntity(
    override val accountId: String, override val id: String, val name: String, val platform: String,
    val createdAt: String, val lastSeenAt: String, val userAgent: String? = null, val appVersion: String? = null,
) : AccountScopedRecord

@Entity(tableName = "file_box_items", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "entryId"]), Index(value = ["accountId", "status"])])
data class FileBoxItemEntity(
    override val accountId: String, override val id: String, val entryId: String, val attachmentId: String? = null,
    val filename: String, val filesize: String, val contentType: String? = null,
    val sourceDeviceId: String, val sourceDeviceName: String, val status: String,
    val createdAt: String, val updatedAt: String, val driveFileId: String? = null,
    val localObjectUrl: String? = null, val lastError: String? = null,
) : AccountScopedRecord

@Entity(tableName = "transfers", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "status"]), Index(value = ["accountId", "updatedAt"])])
data class TransferEntity(
    override val accountId: String, override val id: String, val fileBoxItemId: String? = null,
    val entryId: String? = null, val attachmentId: String? = null, val filename: String,
    val fromDeviceId: String, val fromDeviceName: String, val toDeviceId: String? = null,
    val toDeviceName: String? = null, val provider: String, val status: String,
    val bytesTotal: Long? = null, val bytesTransferred: Long? = null,
    val createdAt: String, val updatedAt: String, val completedAt: String? = null,
    val driveFileId: String? = null, val lastError: String? = null,
) : AccountScopedRecord

@Entity(tableName = "conflicts", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "resolution", "detectedAt"])])
data class ConflictEntity(
    override val accountId: String, override val id: String, val entityKind: String, val entityId: String,
    val localUpdatedAt: String, val remoteUpdatedAt: String, val detectedAt: String,
    val resolution: String, val summary: String, val localCopyJson: String? = null,
    val remoteCopyJson: String? = null,
) : AccountScopedRecord

@Entity(tableName = "tombstones", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "entityKind", "entityId"], unique = true), Index(value = ["accountId", "deletedAt"])])
data class TombstoneEntity(
    override val accountId: String, override val id: String, val entityKind: String, val entityId: String,
    val deletedAt: String, val deletedByDeviceId: String, val reason: String? = null,
) : AccountScopedRecord

@Entity(tableName = "sync_queue", primaryKeys = ["accountId", "id"], indices = [Index(value = ["accountId", "status", "queuedAt"])])
data class SyncQueueEntity(
    override val accountId: String, override val id: String, val entityKind: String, val entityId: String,
    val operation: String, val status: String = "queued", val queuedAt: String,
    val updatedAt: String, val updatedByDeviceId: String, val baseVersion: Int? = null,
    val lastError: String? = null,
) : AccountScopedRecord

@Entity(tableName = "sync_state", primaryKeys = ["accountId"])
data class SyncStateEntity(
    val accountId: String, val lastAttemptAt: String? = null, val lastSyncedAt: String? = null,
    val lastMessage: String = "Native Drive writes are disabled until contract parity.",
    val changeToken: String? = null,
    val updatedAt: String? = null, val queueCount: Int = 0, val valueJson: String? = null,
)

@Entity(
    tableName = "drive_raw_documents",
    primaryKeys = ["accountId", "entityKind", "entityId"],
    indices = [Index(value = ["accountId", "path"], unique = true)],
)
data class DriveRawDocumentEntity(
    val accountId: String,
    val entityKind: String,
    val entityId: String,
    val path: String,
    val driveFileId: String,
    val driveModifiedAt: String,
    val rawJson: String,
)

/**
 * Account-local protocol document. Protocols intentionally remain outside Drive v1 and the sync queue.
 * contentJson uses the web-compatible block array shape so a later, explicitly reviewed parity milestone
 * can map these documents without changing the local schema.
 */
@Entity(
    tableName = "protocols",
    primaryKeys = ["accountId", "id"],
    indices = [Index(value = ["accountId", "updatedAt"]), Index(value = ["accountId", "title"])],
)
data class ProtocolEntity(
    override val accountId: String,
    override val id: String,
    val title: String,
    val createdAt: String,
    val updatedAt: String,
    val contentJson: String = "[]",
    val tagsJson: String = "[]",
    val searchTermsJson: String = "[]",
) : AccountScopedRecord
