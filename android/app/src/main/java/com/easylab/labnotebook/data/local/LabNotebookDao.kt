package com.easylab.labnotebook.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

internal fun deleteQueueEventId(entityKind: String, entityId: String, deletedAt: String): String {
    fun frame(value: String) = "${value.length}:$value"
    return "delete-event-${frame(entityKind)}${frame(entityId)}${frame(deletedAt)}"
}

internal fun upsertQueueEventId(entityKind: String, entityId: String): String {
    fun frame(value: String) = "${value.length}:$value"
    return "upsert-event-${frame(entityKind)}${frame(entityId)}"
}

@Dao
interface LabNotebookDao {
    @Upsert suspend fun upsertAccount(account: AccountEntity)
    @Query("SELECT * FROM accounts WHERE accountId = :accountId") suspend fun account(accountId: String): AccountEntity?
    @Query("DELETE FROM accounts WHERE accountId = :accountId") suspend fun deleteAccount(accountId: String)

    @Upsert suspend fun upsertDriveRawDocument(document: DriveRawDocumentEntity)
    @Query(
        "SELECT * FROM drive_raw_documents WHERE accountId = :accountId " +
            "AND entityKind = :entityKind AND entityId = :entityId LIMIT 1",
    )
    suspend fun driveRawDocument(
        accountId: String,
        entityKind: String,
        entityId: String,
    ): DriveRawDocumentEntity?
    @Query("SELECT * FROM drive_raw_documents WHERE accountId = :accountId ORDER BY path")
    suspend fun driveRawDocuments(accountId: String): List<DriveRawDocumentEntity>

    @Query("SELECT * FROM protocols WHERE accountId = :accountId ORDER BY updatedAt DESC, title COLLATE NOCASE")
    fun observeProtocols(accountId: String): Flow<List<ProtocolEntity>>
    @Query("SELECT * FROM protocols WHERE accountId = :accountId AND id = :protocolId LIMIT 1")
    suspend fun protocol(accountId: String, protocolId: String): ProtocolEntity?
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertProtocolRow(protocol: ProtocolEntity)

    @Transaction
    suspend fun insertProtocol(protocol: ProtocolEntity) {
        check(account(protocol.accountId) != null) { "Protocol account is not active." }
        insertProtocolRow(protocol)
    }
    @Query(
        "UPDATE protocols SET title = :title, updatedAt = :updatedAt, contentJson = :contentJson, " +
            "tagsJson = :tagsJson, searchTermsJson = :searchTermsJson " +
            "WHERE accountId = :accountId AND id = :protocolId AND updatedAt = :expectedUpdatedAt " +
            "AND createdAt = :createdAt AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId)",
    )
    suspend fun compareAndSetProtocol(
        accountId: String,
        protocolId: String,
        expectedUpdatedAt: String,
        createdAt: String,
        title: String,
        updatedAt: String,
        contentJson: String,
        tagsJson: String,
        searchTermsJson: String,
    ): Int
    @Query(
        "DELETE FROM protocols WHERE accountId = :accountId AND id = :protocolId AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId)",
    )
    suspend fun deleteProtocol(accountId: String, protocolId: String): Int

    @Query(
        "SELECT * FROM journal_entries AS entry WHERE entry.accountId = :accountId " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = entry.accountId " +
            "AND marker.entityKind = 'entry' AND marker.entityId = entry.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = entry.accountId " +
            "AND pending.entityKind = 'entry' AND pending.entityId = entry.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) " +
            "ORDER BY entry.dateBucket DESC, entry.updatedAt DESC",
    )
    fun observeEntries(accountId: String): Flow<List<JournalEntryEntity>>
    @Query("SELECT COUNT(*) FROM journal_entries WHERE accountId = :accountId") suspend fun entryCount(accountId: String): Int
    @Query("SELECT * FROM journal_entries WHERE accountId = :accountId AND id = :entryId LIMIT 1") suspend fun entry(accountId: String, entryId: String): JournalEntryEntity?
    @Query(
        "SELECT * FROM journal_entries AS entry WHERE entry.accountId = :accountId AND entry.id = :entryId " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = entry.accountId " +
            "AND marker.entityKind = 'entry' AND marker.entityId = entry.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = entry.accountId " +
            "AND pending.entityKind = 'entry' AND pending.entityId = entry.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) LIMIT 1",
    )
    suspend fun visibleEntry(accountId: String, entryId: String): JournalEntryEntity?
    @Query(
        "SELECT * FROM journal_entries AS entry WHERE entry.accountId = :accountId " +
            "AND entry.dateBucket = :dateBucket " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = entry.accountId " +
            "AND marker.entityKind = 'entry' AND marker.entityId = entry.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = entry.accountId " +
            "AND pending.entityKind = 'entry' AND pending.entityId = entry.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) " +
            "ORDER BY entry.updatedAt DESC LIMIT 1",
    )
    suspend fun entryForDate(accountId: String, dateBucket: String): JournalEntryEntity?
    @Upsert suspend fun upsertEntry(entry: JournalEntryEntity)
    @Query("DELETE FROM journal_entries WHERE accountId = :accountId AND id = :entryId") suspend fun physicalDeleteEntry(accountId: String, entryId: String): Int

    @Query(
        "SELECT * FROM attachments AS attachment WHERE attachment.accountId = :accountId " +
            "AND attachment.entryId = :entryId " +
            "AND NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = attachment.accountId " +
            "AND marker.entityKind = 'entry' AND marker.entityId = attachment.entryId) " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = attachment.accountId " +
            "AND marker.entityKind = 'attachment' AND marker.entityId = attachment.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = attachment.accountId " +
            "AND pending.entityKind = 'attachment' AND pending.entityId = attachment.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) " +
            "ORDER BY attachment.createdAt DESC",
    )
    fun observeAttachments(accountId: String, entryId: String): Flow<List<AttachmentEntity>>
    @Query(
        "SELECT * FROM attachments AS attachment WHERE attachment.accountId = :accountId " +
            "AND NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = attachment.accountId " +
            "AND marker.entityKind = 'entry' AND marker.entityId = attachment.entryId) " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = attachment.accountId " +
            "AND marker.entityKind = 'attachment' AND marker.entityId = attachment.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = attachment.accountId " +
            "AND pending.entityKind = 'attachment' AND pending.entityId = attachment.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) " +
            "ORDER BY attachment.updatedAt DESC",
    )
    fun observeVisibleAttachments(accountId: String): Flow<List<AttachmentEntity>>
    @Query("SELECT COUNT(*) FROM attachments WHERE accountId = :accountId") suspend fun attachmentCount(accountId: String): Int
    @Query("SELECT * FROM attachments WHERE accountId = :accountId AND entryId = :entryId") suspend fun attachmentsForEntry(accountId: String, entryId: String): List<AttachmentEntity>
    @Query("SELECT * FROM attachments WHERE accountId = :accountId AND id = :attachmentId LIMIT 1") suspend fun attachment(accountId: String, attachmentId: String): AttachmentEntity?
    @Query(
        "SELECT * FROM attachments AS attachment WHERE attachment.accountId = :accountId " +
            "AND attachment.id = :attachmentId " +
            "AND NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = attachment.accountId " +
            "AND marker.entityKind = 'entry' AND marker.entityId = attachment.entryId) " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = attachment.accountId " +
            "AND marker.entityKind = 'attachment' AND marker.entityId = attachment.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = attachment.accountId " +
            "AND pending.entityKind = 'attachment' AND pending.entityId = attachment.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) LIMIT 1",
    )
    suspend fun visibleAttachment(accountId: String, attachmentId: String): AttachmentEntity?
    @Upsert suspend fun upsertAttachment(attachment: AttachmentEntity)
    @Query("DELETE FROM attachments WHERE accountId = :accountId AND id = :attachmentId") suspend fun physicalDeleteAttachment(accountId: String, attachmentId: String): Int
    @Query("DELETE FROM attachments WHERE accountId = :accountId AND entryId = :entryId") suspend fun physicalDeleteAttachmentsForEntry(accountId: String, entryId: String): Int

    @Upsert suspend fun upsertDevice(device: DeviceEntity)
    @Query("SELECT * FROM devices WHERE accountId = :accountId ORDER BY lastSeenAt DESC") suspend fun devices(accountId: String): List<DeviceEntity>
    @Query("DELETE FROM devices WHERE accountId = :accountId AND id = :deviceId") suspend fun physicalDeleteDevice(accountId: String, deviceId: String): Int
    @Upsert suspend fun upsertFileBoxItem(item: FileBoxItemEntity)
    @Query("SELECT COUNT(*) FROM file_box_items WHERE accountId = :accountId") suspend fun fileBoxItemCount(accountId: String): Int
    @Query("SELECT * FROM file_box_items WHERE accountId = :accountId ORDER BY updatedAt DESC") suspend fun fileBoxItems(accountId: String): List<FileBoxItemEntity>
    @Query(
        "SELECT * FROM file_box_items AS item WHERE item.accountId = :accountId " +
            "AND item.status NOT IN ('attached', 'rejected', 'removed') " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = item.accountId " +
            "AND marker.entityKind = 'fileBoxItem' AND marker.entityId = item.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = item.accountId " +
            "AND pending.entityKind = 'fileBoxItem' AND pending.entityId = item.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) " +
            "ORDER BY item.updatedAt DESC",
    )
    fun observeIncomingFileBoxItems(accountId: String): Flow<List<FileBoxItemEntity>>
    @Query("DELETE FROM file_box_items WHERE accountId = :accountId AND id = :itemId") suspend fun physicalDeleteFileBoxItem(accountId: String, itemId: String): Int
    @Upsert suspend fun upsertTransfer(transfer: TransferEntity)
    @Query("SELECT COUNT(*) FROM transfers WHERE accountId = :accountId") suspend fun transferCount(accountId: String): Int
    @Query("SELECT * FROM transfers WHERE accountId = :accountId ORDER BY updatedAt DESC") suspend fun transfers(accountId: String): List<TransferEntity>
    @Query(
        "SELECT * FROM transfers AS transfer WHERE transfer.accountId = :accountId " +
            "AND transfer.status != 'removed' " +
            "AND (NOT EXISTS (SELECT 1 FROM tombstones AS marker WHERE marker.accountId = transfer.accountId " +
            "AND marker.entityKind = 'transfer' AND marker.entityId = transfer.id) " +
            "OR EXISTS (SELECT 1 FROM sync_queue AS pending WHERE pending.accountId = transfer.accountId " +
            "AND pending.entityKind = 'transfer' AND pending.entityId = transfer.id AND pending.operation = 'upsert' " +
            "AND pending.status IN ('queued', 'syncing', 'failed'))) " +
            "ORDER BY transfer.updatedAt DESC",
    )
    fun observeVisibleTransfers(accountId: String): Flow<List<TransferEntity>>
    @Query("DELETE FROM transfers WHERE accountId = :accountId AND id = :transferId") suspend fun physicalDeleteTransfer(accountId: String, transferId: String): Int
    @Upsert suspend fun upsertConflict(conflict: ConflictEntity)
    @Query("SELECT COUNT(*) FROM conflicts WHERE accountId = :accountId") suspend fun conflictCount(accountId: String): Int
    @Query("SELECT * FROM conflicts WHERE accountId = :accountId ORDER BY detectedAt DESC") suspend fun conflicts(accountId: String): List<ConflictEntity>
    @Upsert suspend fun upsertTombstone(tombstone: TombstoneEntity)
    @Query("SELECT COUNT(*) FROM tombstones WHERE accountId = :accountId") suspend fun tombstoneCount(accountId: String): Int
    @Query("SELECT * FROM tombstones WHERE accountId = :accountId ORDER BY deletedAt DESC") suspend fun tombstones(accountId: String): List<TombstoneEntity>
    @Query("SELECT * FROM tombstones WHERE accountId = :accountId AND entityKind = :entityKind AND entityId = :entityId LIMIT 1")
    suspend fun tombstone(accountId: String, entityKind: String, entityId: String): TombstoneEntity?
    @Query("DELETE FROM tombstones WHERE accountId = :accountId AND id = :tombstoneId") suspend fun physicalDeleteTombstone(accountId: String, tombstoneId: String): Int

    @Upsert suspend fun upsertQueueItem(item: SyncQueueEntity)
    @Query("SELECT COUNT(*) FROM sync_queue WHERE accountId = :accountId") suspend fun queueCount(accountId: String): Int
    @Query("SELECT * FROM sync_queue WHERE accountId = :accountId ORDER BY queuedAt") suspend fun queueItems(accountId: String): List<SyncQueueEntity>
    @Query("SELECT * FROM sync_queue WHERE accountId = :accountId AND id = :recordId LIMIT 1")
    suspend fun queueItem(accountId: String, recordId: String): SyncQueueEntity?
    @Query("SELECT * FROM sync_queue WHERE accountId = :accountId AND status IN ('queued', 'syncing', 'failed') ORDER BY queuedAt") suspend fun pendingQueue(accountId: String): List<SyncQueueEntity>
    @Query(
        "SELECT * FROM sync_queue WHERE accountId = :accountId AND entityKind = :entityKind " +
            "AND entityId = :entityId AND status IN ('queued', 'syncing', 'failed') ORDER BY queuedAt",
    )
    suspend fun pendingQueueForEntity(accountId: String, entityKind: String, entityId: String): List<SyncQueueEntity>
    @Query("SELECT COUNT(*) FROM sync_queue WHERE accountId = :accountId AND status IN ('queued', 'syncing', 'failed')") fun observePendingCount(accountId: String): Flow<Int>
    @Query(
        "SELECT * FROM sync_queue WHERE accountId = :accountId AND " +
            "(status IN ('queued', 'failed') OR (status = 'syncing' AND " +
            "(leaseExpiresAt IS NULL OR leaseExpiresAt <= :claimAt))) AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId) " +
            "ORDER BY queuedAt, id LIMIT 1",
    )
    suspend fun nextClaimableQueueItem(accountId: String, claimAt: String): SyncQueueEntity?
    @Query(
        "UPDATE sync_queue SET status = 'syncing', claimToken = :claimToken, claimedAt = :claimAt, " +
            "leaseExpiresAt = :leaseExpiresAt, attemptCount = attemptCount + 1, lastError = NULL " +
            "WHERE accountId = :accountId AND id = :recordId AND " +
            "(status IN ('queued', 'failed') OR (status = 'syncing' AND " +
            "(leaseExpiresAt IS NULL OR leaseExpiresAt <= :claimAt))) AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId)",
    )
    suspend fun compareAndSetQueueClaim(
        accountId: String,
        recordId: String,
        claimToken: String,
        claimAt: String,
        leaseExpiresAt: String,
    ): Int
    @Query(
        "UPDATE sync_queue SET status = 'completed', claimToken = NULL, claimedAt = NULL, " +
            "leaseExpiresAt = NULL, lastError = NULL WHERE accountId = :accountId AND id = :recordId " +
            "AND status = 'syncing' AND claimToken = :claimToken AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId)",
    )
    suspend fun completeQueueClaim(accountId: String, recordId: String, claimToken: String): Int
    @Query(
        "UPDATE sync_queue SET status = 'failed', claimToken = NULL, claimedAt = NULL, " +
            "leaseExpiresAt = NULL, lastError = :lastError WHERE accountId = :accountId AND id = :recordId " +
            "AND status = 'syncing' AND claimToken = :claimToken AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId)",
    )
    suspend fun failQueueClaim(accountId: String, recordId: String, claimToken: String, lastError: String): Int
    @Query(
        "UPDATE sync_queue SET status = 'queued', claimToken = NULL, claimedAt = NULL, " +
            "leaseExpiresAt = NULL WHERE accountId = :accountId AND id = :recordId " +
            "AND status = 'syncing' AND claimToken = :claimToken AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId)",
    )
    suspend fun requeueQueueClaim(accountId: String, recordId: String, claimToken: String): Int
    @Query(
        "UPDATE sync_queue SET status = 'queued', claimToken = NULL, claimedAt = NULL, " +
            "leaseExpiresAt = NULL WHERE accountId = :accountId AND status = 'syncing' " +
            "AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= :now) AND EXISTS " +
            "(SELECT 1 FROM accounts WHERE accounts.accountId = :accountId)",
    )
    suspend fun recoverExpiredQueueClaims(accountId: String, now: String): Int

    @Transaction
    suspend fun claimNextQueueItem(
        accountId: String,
        claimToken: String,
        claimAt: String,
        leaseExpiresAt: String,
    ): SyncQueueEntity? {
        require(accountId.isNotBlank()) { "Queue claim account id must not be blank." }
        require(claimToken.isNotBlank()) { "Queue claim token must not be blank." }
        require(claimAt.isNotBlank()) { "Queue claim timestamp must not be blank." }
        require(leaseExpiresAt > claimAt) { "Queue claim lease must expire after it starts." }
        val candidate = nextClaimableQueueItem(accountId, claimAt) ?: return null
        check(
            compareAndSetQueueClaim(accountId, candidate.id, claimToken, claimAt, leaseExpiresAt) == 1,
        ) { "Queue claim candidate changed inside its transaction." }
        return queueItem(accountId, candidate.id)
    }
    @Query(
        "DELETE FROM sync_queue WHERE accountId = :accountId AND entityKind = :entityKind " +
            "AND entityId = :entityId AND operation = 'upsert' AND status IN ('queued', 'syncing', 'failed')",
    )
    suspend fun deleteStalePendingUpserts(accountId: String, entityKind: String, entityId: String): Int
    @Upsert suspend fun upsertSyncState(state: SyncStateEntity)
    @Query("SELECT * FROM sync_state WHERE accountId = :accountId LIMIT 1") fun observeSyncState(accountId: String): Flow<SyncStateEntity?>
    @Query("SELECT * FROM sync_state WHERE accountId = :accountId LIMIT 1") suspend fun syncState(accountId: String): SyncStateEntity?

    @Transaction
    suspend fun stageEntryUpsert(entry: JournalEntryEntity, queuedAt: String): JournalEntryEntity {
        require(entry.accountId.isNotBlank()) { "Entry account id must not be blank." }
        require(entry.id.isNotBlank()) { "Entry id must not be blank." }
        require(queuedAt.isNotBlank()) { "Queue timestamp must not be blank." }
        require(entry.updatedByDeviceId.isNotBlank()) { "Updating device id must not be blank." }
        check(tombstone(entry.accountId, "entry", entry.id) == null) {
            "A deleted entry cannot be edited without an explicit restore operation."
        }

        val existing = entry(entry.accountId, entry.id)
        check(existing == null || entry.version == existing.version + 1) {
            "Entry changed after editing began. Reload it before saving."
        }
        val queuedEntry = entry.copy(syncStatus = "queued")
        deleteStalePendingUpserts(entry.accountId, "entry", entry.id)
        upsertEntry(queuedEntry)
        upsertQueueItem(
            SyncQueueEntity(
                accountId = entry.accountId,
                id = upsertQueueEventId("entry", entry.id),
                entityKind = "entry",
                entityId = entry.id,
                operation = "upsert",
                status = "queued",
                queuedAt = queuedAt,
                updatedAt = entry.updatedAt,
                updatedByDeviceId = entry.updatedByDeviceId,
                baseVersion = existing?.version,
            ),
        )
        return queuedEntry
    }

    @Transaction
    suspend fun stageAttachmentUpsert(
        attachment: AttachmentEntity,
        queuedAt: String,
        updatedByDeviceId: String,
    ): AttachmentEntity {
        require(attachment.accountId.isNotBlank()) { "Attachment account id must not be blank." }
        require(attachment.id.isNotBlank()) { "Attachment id must not be blank." }
        require(attachment.entryId.isNotBlank()) { "Attachment entry id must not be blank." }
        require(queuedAt.isNotBlank()) { "Queue timestamp must not be blank." }
        require(updatedByDeviceId.isNotBlank()) { "Updating device id must not be blank." }
        check(entry(attachment.accountId, attachment.entryId) != null) { "Attachment parent entry is missing." }
        check(tombstone(attachment.accountId, "entry", attachment.entryId) == null) {
            "A file cannot be attached to a deleted entry."
        }
        check(tombstone(attachment.accountId, "attachment", attachment.id) == null) {
            "A deleted attachment cannot be reused without an explicit restore operation."
        }
        check(attachment(attachment.accountId, attachment.id) == null) { "Attachment id already exists." }

        val queuedAttachment = attachment.copy(syncStatus = "queued")
        deleteStalePendingUpserts(attachment.accountId, "attachment", attachment.id)
        upsertAttachment(queuedAttachment)
        upsertQueueItem(
            SyncQueueEntity(
                accountId = attachment.accountId,
                id = upsertQueueEventId("attachment", attachment.id),
                entityKind = "attachment",
                entityId = attachment.id,
                operation = "upsert",
                status = "queued",
                queuedAt = queuedAt,
                updatedAt = attachment.updatedAt,
                updatedByDeviceId = updatedByDeviceId,
            ),
        )
        return queuedAttachment
    }

    @Transaction
    suspend fun deleteEntryDurably(
        accountId: String,
        entryId: String,
        deletedAt: String,
        deletedByDeviceId: String,
        reason: String?,
    ): Boolean {
        val existingEntry = entry(accountId, entryId) ?: return false
        val dependentAttachments = attachmentsForEntry(accountId, entryId)
        val attachmentIds = dependentAttachments.mapTo(mutableSetOf()) { it.id }
        val dependentFileBoxItems = fileBoxItems(accountId).filter { item ->
            item.entryId == entryId || item.attachmentId?.let(attachmentIds::contains) == true
        }
        val fileBoxItemIds = dependentFileBoxItems.mapTo(mutableSetOf()) { it.id }
        val dependentTransfers = transfers(accountId).filter { transfer ->
            transfer.entryId == entryId ||
                transfer.attachmentId?.let(attachmentIds::contains) == true ||
                transfer.fileBoxItemId?.let(fileBoxItemIds::contains) == true
        }

        dependentTransfers.forEach { transfer ->
            upsertDeleteRecords(
                accountId = accountId,
                entityKind = "transfer",
                entityId = transfer.id,
                deletedAt = deletedAt,
                deletedByDeviceId = deletedByDeviceId,
                reason = reason,
            )
        }
        dependentFileBoxItems.forEach { item ->
            upsertDeleteRecords(
                accountId = accountId,
                entityKind = "fileBoxItem",
                entityId = item.id,
                deletedAt = deletedAt,
                deletedByDeviceId = deletedByDeviceId,
                reason = reason,
            )
        }
        dependentAttachments.forEach { attachment ->
            upsertDeleteRecords(
                accountId = accountId,
                entityKind = "attachment",
                entityId = attachment.id,
                deletedAt = deletedAt,
                deletedByDeviceId = deletedByDeviceId,
                reason = reason,
            )
        }
        upsertDeleteRecords(
            accountId = accountId,
            entityKind = "entry",
            entityId = existingEntry.id,
            deletedAt = deletedAt,
            deletedByDeviceId = deletedByDeviceId,
            reason = reason,
            baseVersion = existingEntry.version,
        )

        dependentTransfers.forEach { transfer ->
            check(physicalDeleteTransfer(accountId, transfer.id) == 1) {
                "Transfer disappeared during durable deletion."
            }
        }
        dependentFileBoxItems.forEach { item ->
            check(physicalDeleteFileBoxItem(accountId, item.id) == 1) {
                "File Box item disappeared during durable deletion."
            }
        }
        dependentAttachments.forEach { attachment ->
            check(physicalDeleteAttachment(accountId, attachment.id) == 1) {
                "Attachment disappeared during durable deletion."
            }
        }
        check(physicalDeleteEntry(accountId, entryId) == 1) { "Entry disappeared during durable deletion." }
        return true
    }

    @Transaction
    suspend fun deleteAttachmentDurably(
        accountId: String,
        attachmentId: String,
        deletedAt: String,
        deletedByDeviceId: String,
        reason: String?,
    ): Boolean {
        val existingAttachment = attachment(accountId, attachmentId) ?: return false
        val dependentFileBoxItems = fileBoxItems(accountId).filter { it.attachmentId == attachmentId }
        val fileBoxItemIds = dependentFileBoxItems.mapTo(mutableSetOf()) { it.id }
        val dependentTransfers = transfers(accountId).filter { transfer ->
            transfer.attachmentId == attachmentId ||
                transfer.fileBoxItemId?.let(fileBoxItemIds::contains) == true
        }

        dependentTransfers.forEach { transfer ->
            upsertDeleteRecords(
                accountId = accountId,
                entityKind = "transfer",
                entityId = transfer.id,
                deletedAt = deletedAt,
                deletedByDeviceId = deletedByDeviceId,
                reason = reason,
            )
        }
        dependentFileBoxItems.forEach { item ->
            upsertDeleteRecords(
                accountId = accountId,
                entityKind = "fileBoxItem",
                entityId = item.id,
                deletedAt = deletedAt,
                deletedByDeviceId = deletedByDeviceId,
                reason = reason,
            )
        }
        upsertDeleteRecords(
            accountId = accountId,
            entityKind = "attachment",
            entityId = existingAttachment.id,
            deletedAt = deletedAt,
            deletedByDeviceId = deletedByDeviceId,
            reason = reason,
        )
        dependentTransfers.forEach { transfer ->
            check(physicalDeleteTransfer(accountId, transfer.id) == 1) {
                "Transfer disappeared during durable deletion."
            }
        }
        dependentFileBoxItems.forEach { item ->
            check(physicalDeleteFileBoxItem(accountId, item.id) == 1) {
                "File Box item disappeared during durable deletion."
            }
        }
        check(physicalDeleteAttachment(accountId, attachmentId) == 1) {
            "Attachment disappeared during durable deletion."
        }
        return true
    }

    private suspend fun upsertDeleteRecords(
        accountId: String,
        entityKind: String,
        entityId: String,
        deletedAt: String,
        deletedByDeviceId: String,
        reason: String?,
        baseVersion: Int? = null,
    ) {
        val baseRecordId = "delete-$entityKind-$entityId"
        val tombstoneId = tombstone(accountId, entityKind, entityId)?.id ?: baseRecordId
        deleteStalePendingUpserts(accountId, entityKind, entityId)
        upsertTombstone(
            TombstoneEntity(
                accountId = accountId,
                id = tombstoneId,
                entityKind = entityKind,
                entityId = entityId,
                deletedAt = deletedAt,
                deletedByDeviceId = deletedByDeviceId,
                reason = reason,
            ),
        )
        val recordId = deleteQueueEventId(entityKind, entityId, deletedAt)
        val existingEvent = queueItem(accountId, recordId)
        if (
            existingEvent?.operation == "delete" &&
            existingEvent.status == "completed" &&
            existingEvent.queuedAt == deletedAt
        ) {
            return
        }
        upsertQueueItem(
            SyncQueueEntity(
                accountId = accountId,
                id = recordId,
                entityKind = entityKind,
                entityId = entityId,
                operation = "delete",
                queuedAt = deletedAt,
                updatedAt = deletedAt,
                updatedByDeviceId = deletedByDeviceId,
                baseVersion = baseVersion,
            ),
        )
    }

    @Query("DELETE FROM journal_entries WHERE accountId = :accountId") suspend fun clearEntries(accountId: String)
    @Query("DELETE FROM attachments WHERE accountId = :accountId") suspend fun clearAttachments(accountId: String)
    @Query("DELETE FROM devices WHERE accountId = :accountId") suspend fun clearDevices(accountId: String)
    @Query("DELETE FROM file_box_items WHERE accountId = :accountId") suspend fun clearFileBoxItems(accountId: String)
    @Query("DELETE FROM transfers WHERE accountId = :accountId") suspend fun clearTransfers(accountId: String)
    @Query("DELETE FROM conflicts WHERE accountId = :accountId") suspend fun clearConflicts(accountId: String)
    @Query("DELETE FROM tombstones WHERE accountId = :accountId") suspend fun clearTombstones(accountId: String)
    @Query("DELETE FROM sync_queue WHERE accountId = :accountId") suspend fun clearQueue(accountId: String)
    @Query("DELETE FROM sync_state WHERE accountId = :accountId") suspend fun clearSyncState(accountId: String)
    @Query("DELETE FROM drive_raw_documents WHERE accountId = :accountId") suspend fun clearDriveRawDocuments(accountId: String)
    @Query("DELETE FROM protocols WHERE accountId = :accountId") suspend fun clearProtocols(accountId: String)
}
