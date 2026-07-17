package com.easylab.labnotebook.data.repository

import com.easylab.labnotebook.data.local.AccountEntity
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AccountScopedRecord
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDao
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

data class AuthSession(
    val accountId: AccountId,
    val email: String,
    val displayName: String? = null,
    val pictureUrl: String? = null,
)

sealed interface DriveAccessState {
    data object Restoring : DriveAccessState
    data object SignedOut : DriveAccessState
    data object SignInRequired : DriveAccessState
    data object Authorizing : DriveAccessState
    data class Granted(
        val accountId: AccountId,
        val grantedScopes: Set<String>,
        val expiresAtEpochMillis: Long? = null,
    ) : DriveAccessState
    data class Error(val message: String) : DriveAccessState
}

interface AuthRepository {
    val session: StateFlow<AuthSession?>
    val driveAccess: StateFlow<DriveAccessState>
    suspend fun restore()
    suspend fun connect(): Result<AuthSession>
    suspend fun disconnect()
    suspend fun invalidateAccessToken(accountId: AccountId)
    fun accessToken(accountId: AccountId): String?
}

enum class DriveWriteCapability { DisabledPendingContractParity, Enabled }

sealed class DriveRepositoryException(message: String, cause: Throwable? = null) : Exception(message, cause)

class DriveSignInRequiredException(message: String = "Google Drive sign-in is required.") :
    DriveRepositoryException(message)

class DriveHttpException(
    val statusCode: Int,
    message: String,
    cause: Throwable? = null,
    val reason: String? = null,
    val responseBody: String? = null,
) : DriveRepositoryException(message, cause) {
    val retryable: Boolean
        get() = statusCode == 408 ||
            statusCode == 429 ||
            statusCode in 500..599 ||
            (statusCode == 403 && reason in TRANSIENT_FORBIDDEN_REASONS)

    private companion object {
        val TRANSIENT_FORBIDDEN_REASONS = setOf(
            "rateLimitExceeded",
            "userRateLimitExceeded",
        )
    }
}

class DriveProtocolException(message: String, cause: Throwable? = null) :
    DriveRepositoryException(message, cause)

data class DriveFileRef(
    val id: String,
    val path: String,
    val name: String,
    val mimeType: String? = null,
    val size: Long? = null,
    val updatedAt: String,
    val appProperties: Map<String, String> = emptyMap(),
    val version: Long? = null,
)

interface DriveRepository {
    val writeCapability: DriveWriteCapability
    suspend fun listManagedFiles(accountId: AccountId, prefix: String? = null): Result<List<DriveFileRef>>
    suspend fun readJson(accountId: AccountId, path: String): Result<String?>
    suspend fun putJson(accountId: AccountId, path: String, json: String): Result<DriveFileRef>
    suspend fun putBlob(accountId: AccountId, path: String, bytes: ByteArray, mimeType: String, sha256: String): Result<DriveFileRef>
}

class NativeDriveRepositorySkeleton : DriveRepository {
    override val writeCapability = DriveWriteCapability.DisabledPendingContractParity
    private fun <T> unavailable(): Result<T> = Result.failure(
        IllegalStateException("Native Google Drive access is disabled until DriveV1 contract parity is verified."),
    )
    override suspend fun listManagedFiles(accountId: AccountId, prefix: String?) = unavailable<List<DriveFileRef>>()
    override suspend fun readJson(accountId: AccountId, path: String) = unavailable<String?>()
    override suspend fun putJson(accountId: AccountId, path: String, json: String) = unavailable<DriveFileRef>()
    override suspend fun putBlob(accountId: AccountId, path: String, bytes: ByteArray, mimeType: String, sha256: String) = unavailable<DriveFileRef>()
}

interface JournalRepository {
    fun observeEntries(accountId: AccountId): Flow<List<JournalEntryEntity>>
    suspend fun getEntry(accountId: AccountId, entryId: String): JournalEntryEntity?
    suspend fun upsertEntry(accountId: AccountId, entry: JournalEntryEntity)
}

interface EntryMutationRepository {
    suspend fun createEntry(
        accountId: AccountId,
        entry: JournalEntryEntity,
    ): JournalEntryEntity = throw UnsupportedOperationException("Entry creation is not available.")

    suspend fun saveEntry(
        accountId: AccountId,
        entry: JournalEntryEntity,
        contentJson: String,
        editedAt: String,
        deviceId: String,
    ): JournalEntryEntity
}

interface AttachmentRepository {
    fun observeForEntry(accountId: AccountId, entryId: String): Flow<List<AttachmentEntity>>
    suspend fun getAttachment(accountId: AccountId, attachmentId: String): AttachmentEntity?
    suspend fun upsertAttachment(accountId: AccountId, attachment: AttachmentEntity)
}

interface FileHubRepository {
    fun observeLibrary(accountId: AccountId): Flow<List<AttachmentEntity>>
    fun observeIncoming(accountId: AccountId): Flow<List<FileBoxItemEntity>>
    fun observeActivity(accountId: AccountId): Flow<List<TransferEntity>>
}

data class DeletionMetadata(
    val deletedAt: String,
    val deletedByDeviceId: String,
    val reason: String? = null,
) {
    init {
        require(deletedAt.isNotBlank()) { "Deletion timestamp must not be blank." }
        require(deletedByDeviceId.isNotBlank()) { "Deleting device id must not be blank." }
    }
}

interface DurableDeletionRepository {
    suspend fun deleteEntry(accountId: AccountId, entryId: String, metadata: DeletionMetadata): Boolean
    suspend fun deleteAttachment(accountId: AccountId, attachmentId: String, metadata: DeletionMetadata): Boolean
}

private fun requireAccount(accountId: AccountId, recordAccountId: String, label: String) {
    require(recordAccountId == accountId.value) { "$label belongs to a different account." }
}

class RoomJournalRepository(private val dao: LabNotebookDao) : JournalRepository {
    override fun observeEntries(accountId: AccountId) = dao.observeEntries(accountId.value)
    override suspend fun getEntry(accountId: AccountId, entryId: String) = dao.visibleEntry(accountId.value, entryId)
    override suspend fun upsertEntry(accountId: AccountId, entry: JournalEntryEntity) {
        requireAccount(accountId, entry.accountId, "Entry")
        dao.upsertEntry(entry)
    }
}

class RoomEntryMutationRepository(private val dao: LabNotebookDao) : EntryMutationRepository {
    override suspend fun createEntry(
        accountId: AccountId,
        entry: JournalEntryEntity,
    ): JournalEntryEntity {
        requireAccount(accountId, entry.accountId, "Entry")
        require(entry.id.isNotBlank()) { "Entry id must not be blank." }
        require(entry.createdAt.isNotBlank()) { "Creation timestamp must not be blank." }
        require(entry.updatedAt.isNotBlank()) { "Update timestamp must not be blank." }
        require(entry.updatedByDeviceId.isNotBlank()) { "Creating device id must not be blank." }
        require(entry.version == 1) { "A new entry must start at version 1." }
        require(Json.parseToJsonElement(entry.contentJson) is JsonArray) { "Entry content must be a JSON array." }
        check(dao.entry(accountId.value, entry.id) == null) { "An entry with this id already exists." }
        return dao.stageEntryUpsert(entry.copy(syncStatus = "queued"), entry.updatedAt)
    }

    override suspend fun saveEntry(
        accountId: AccountId,
        entry: JournalEntryEntity,
        contentJson: String,
        editedAt: String,
        deviceId: String,
    ): JournalEntryEntity {
        requireAccount(accountId, entry.accountId, "Entry")
        require(editedAt.isNotBlank()) { "Edit timestamp must not be blank." }
        require(deviceId.isNotBlank()) { "Editing device id must not be blank." }
        require(Json.parseToJsonElement(contentJson) is JsonArray) { "Entry content must be a JSON array." }
        val staged = entry.copy(
            contentJson = contentJson,
            updatedAt = editedAt,
            updatedByDeviceId = deviceId,
            version = entry.version + 1,
            syncStatus = "queued",
        )
        return dao.stageEntryUpsert(staged, editedAt)
    }
}

class RoomAttachmentRepository(private val dao: LabNotebookDao) : AttachmentRepository {
    override fun observeForEntry(accountId: AccountId, entryId: String) = dao.observeAttachments(accountId.value, entryId)
    override suspend fun getAttachment(accountId: AccountId, attachmentId: String) =
        dao.visibleAttachment(accountId.value, attachmentId)
    override suspend fun upsertAttachment(accountId: AccountId, attachment: AttachmentEntity) {
        requireAccount(accountId, attachment.accountId, "Attachment")
        dao.upsertAttachment(attachment)
    }
}

class RoomFileHubRepository(private val dao: LabNotebookDao) : FileHubRepository {
    override fun observeLibrary(accountId: AccountId) = dao.observeVisibleAttachments(accountId.value)
    override fun observeIncoming(accountId: AccountId) = dao.observeIncomingFileBoxItems(accountId.value)
    override fun observeActivity(accountId: AccountId) = dao.observeVisibleTransfers(accountId.value)
}

class RoomDurableDeletionRepository(private val dao: LabNotebookDao) : DurableDeletionRepository {
    override suspend fun deleteEntry(accountId: AccountId, entryId: String, metadata: DeletionMetadata): Boolean =
        dao.deleteEntryDurably(
            accountId = accountId.value,
            entryId = entryId,
            deletedAt = metadata.deletedAt,
            deletedByDeviceId = metadata.deletedByDeviceId,
            reason = metadata.reason,
        )

    override suspend fun deleteAttachment(
        accountId: AccountId,
        attachmentId: String,
        metadata: DeletionMetadata,
    ): Boolean = dao.deleteAttachmentDurably(
        accountId = accountId.value,
        attachmentId = attachmentId,
        deletedAt = metadata.deletedAt,
        deletedByDeviceId = metadata.deletedByDeviceId,
        reason = metadata.reason,
    )
}

interface SyncRecordRepository {
    suspend fun upsertDevice(accountId: AccountId, device: DeviceEntity)
    suspend fun upsertFileBoxItem(accountId: AccountId, item: FileBoxItemEntity)
    suspend fun upsertTransfer(accountId: AccountId, transfer: TransferEntity)
    suspend fun upsertConflict(accountId: AccountId, conflict: ConflictEntity)
    suspend fun upsertTombstone(accountId: AccountId, tombstone: TombstoneEntity)
    suspend fun upsertQueueItem(accountId: AccountId, item: SyncQueueEntity)
    suspend fun upsertSyncState(accountId: AccountId, state: SyncStateEntity)
}

class RoomSyncRecordRepository(private val dao: LabNotebookDao) : SyncRecordRepository {
    override suspend fun upsertDevice(accountId: AccountId, device: DeviceEntity) {
        requireAccount(accountId, device.accountId, "Device")
        dao.upsertDevice(device)
    }
    override suspend fun upsertFileBoxItem(accountId: AccountId, item: FileBoxItemEntity) {
        requireAccount(accountId, item.accountId, "File Box item")
        dao.upsertFileBoxItem(item)
    }
    override suspend fun upsertTransfer(accountId: AccountId, transfer: TransferEntity) {
        requireAccount(accountId, transfer.accountId, "Transfer")
        dao.upsertTransfer(transfer)
    }
    override suspend fun upsertConflict(accountId: AccountId, conflict: ConflictEntity) {
        requireAccount(accountId, conflict.accountId, "Conflict")
        dao.upsertConflict(conflict)
    }
    override suspend fun upsertTombstone(accountId: AccountId, tombstone: TombstoneEntity) {
        requireAccount(accountId, tombstone.accountId, "Tombstone")
        dao.upsertTombstone(tombstone)
    }
    override suspend fun upsertQueueItem(accountId: AccountId, item: SyncQueueEntity) {
        requireAccount(accountId, item.accountId, "Queue item")
        dao.upsertQueueItem(item)
    }
    override suspend fun upsertSyncState(accountId: AccountId, state: SyncStateEntity) {
        requireAccount(accountId, state.accountId, "Sync state")
        dao.upsertSyncState(state)
    }
}

// Account-qualified test/local store shared by every Drive v1 Room record type.
class InMemoryAccountScopedRepository<T : AccountScopedRecord> {
    private val records = mutableMapOf<Pair<String, String>, T>()

    suspend fun upsert(accountId: AccountId, record: T) {
        requireAccount(accountId, record.accountId, "Record")
        records[accountId.value to record.id] = record
    }

    suspend fun get(accountId: AccountId, id: String): T? = records[accountId.value to id]
    suspend fun all(accountId: AccountId): List<T> =
        records.filterKeys { it.first == accountId.value }.values.toList()
}

/** Lightweight contract implementation used by previews and JVM tests; keys remain account-qualified. */
class InMemoryJournalRepository : JournalRepository {
    private val entries = MutableStateFlow<Map<Pair<String, String>, JournalEntryEntity>>(emptyMap())

    override fun observeEntries(accountId: AccountId): Flow<List<JournalEntryEntity>> = entries.map { values ->
        values.filterKeys { it.first == accountId.value }.values.sortedByDescending { it.updatedAt }
    }

    override suspend fun getEntry(accountId: AccountId, entryId: String) = entries.value[accountId.value to entryId]

    override suspend fun upsertEntry(accountId: AccountId, entry: JournalEntryEntity) {
        requireAccount(accountId, entry.accountId, "Entry")
        entries.value = entries.value + ((accountId.value to entry.id) to entry)
    }

}

/** Lightweight attachment store for previews and isolated Compose tests. */
class InMemoryAttachmentRepository : AttachmentRepository {
    private val attachments = MutableStateFlow<Map<Pair<String, String>, AttachmentEntity>>(emptyMap())

    override fun observeForEntry(accountId: AccountId, entryId: String): Flow<List<AttachmentEntity>> =
        attachments.map { values ->
            values
                .filterKeys { it.first == accountId.value }
                .values
                .filter { it.entryId == entryId }
                .sortedByDescending { it.createdAt }
        }

    override suspend fun getAttachment(accountId: AccountId, attachmentId: String) =
        attachments.value[accountId.value to attachmentId]

    override suspend fun upsertAttachment(accountId: AccountId, attachment: AttachmentEntity) {
        requireAccount(accountId, attachment.accountId, "Attachment")
        attachments.value = attachments.value + ((accountId.value to attachment.id) to attachment)
    }
}

/** Read-only presentation store for previews and isolated Compose tests. */
class InMemoryFileHubRepository : FileHubRepository {
    private val attachments = MutableStateFlow<Map<Pair<String, String>, AttachmentEntity>>(emptyMap())
    private val fileBoxItems = MutableStateFlow<Map<Pair<String, String>, FileBoxItemEntity>>(emptyMap())
    private val transfers = MutableStateFlow<Map<Pair<String, String>, TransferEntity>>(emptyMap())

    override fun observeLibrary(accountId: AccountId): Flow<List<AttachmentEntity>> =
        attachments.map { records ->
            records.filterKeys { it.first == accountId.value }.values.sortedByDescending { it.updatedAt }
        }

    override fun observeIncoming(accountId: AccountId): Flow<List<FileBoxItemEntity>> =
        fileBoxItems.map { records ->
            records.filterKeys { it.first == accountId.value }.values
                .filter { it.status !in setOf("attached", "rejected", "removed") }
                .sortedByDescending { it.updatedAt }
        }

    override fun observeActivity(accountId: AccountId): Flow<List<TransferEntity>> =
        transfers.map { records ->
            records.filterKeys { it.first == accountId.value }.values
                .filter { it.status != "removed" }
                .sortedByDescending { it.updatedAt }
        }

    suspend fun upsertAttachment(accountId: AccountId, attachment: AttachmentEntity) {
        requireAccount(accountId, attachment.accountId, "Attachment")
        attachments.value = attachments.value + ((accountId.value to attachment.id) to attachment)
    }

    suspend fun upsertFileBoxItem(accountId: AccountId, item: FileBoxItemEntity) {
        requireAccount(accountId, item.accountId, "File Box item")
        fileBoxItems.value = fileBoxItems.value + ((accountId.value to item.id) to item)
    }

    suspend fun upsertTransfer(accountId: AccountId, transfer: TransferEntity) {
        requireAccount(accountId, transfer.accountId, "Transfer")
        transfers.value = transfers.value + ((accountId.value to transfer.id) to transfer)
    }
}

/** Secret-free implementation used by previews and isolated Compose tests. */
class PlaceholderAuthRepository : AuthRepository {
    private val mutableSession = MutableStateFlow<AuthSession?>(null)
    private val mutableDriveAccess = MutableStateFlow<DriveAccessState>(DriveAccessState.SignedOut)
    override val session: StateFlow<AuthSession?> = mutableSession
    override val driveAccess: StateFlow<DriveAccessState> = mutableDriveAccess
    override suspend fun restore() = Unit
    override suspend fun connect(): Result<AuthSession> = Result.failure(
        IllegalStateException("Google sign-in is unavailable in this preview."),
    )
    override suspend fun disconnect() {
        mutableSession.value = null
        mutableDriveAccess.value = DriveAccessState.SignedOut
    }
    override suspend fun invalidateAccessToken(accountId: AccountId) = Unit
    override fun accessToken(accountId: AccountId): String? = null
}

fun AuthSession.toEntity(connectedAt: String) = AccountEntity(
    accountId = accountId.value,
    email = email,
    displayName = displayName,
    pictureUrl = pictureUrl,
    connectedAt = connectedAt,
)
