package com.easylab.labnotebook.data.migration

import androidx.room.withTransaction
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDao
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.deleteQueueEventId
import com.easylab.labnotebook.data.local.upsertQueueEventId
import com.easylab.labnotebook.sync.DriveV1Attachment
import com.easylab.labnotebook.sync.DriveV1Conflict
import com.easylab.labnotebook.sync.DriveV1Entry
import com.easylab.labnotebook.sync.DriveV1FileBoxItem
import com.easylab.labnotebook.sync.DriveV1Tombstone
import com.easylab.labnotebook.sync.DriveV1Transfer

enum class LegacyImportPolicy {
    RequireEmptyWorkspace,
    MergeVerifiedUnsyncedOnly,
}

data class LegacyImportResult(
    val entries: Int,
    val attachments: Int,
    val fileBoxItems: Int,
    val transfers: Int,
    val conflicts: Int,
    val tombstones: Int,
    val verifiedBlobs: Int,
    val skippedRecords: Int,
    val skippedOrphanBlobs: Int,
    val pendingQueueItems: Int,
    val sourceRetained: Boolean = true,
)

class LegacyWorkspaceImporter(
    private val database: LabNotebookDatabase,
    private val blobStore: LegacyBlobStore,
) {
    suspend fun import(
        accountId: AccountId,
        activeDeviceId: String,
        rawJson: String,
        policy: LegacyImportPolicy = LegacyImportPolicy.RequireEmptyWorkspace,
    ): LegacyImportResult {
        require(activeDeviceId.isNotBlank()) { "Active device id must not be blank." }
        val export = LegacyWorkspaceExportV1.parse(rawJson)
        val initialPlan = buildPlan(database.dao(), accountId, export.snapshot, policy)
        val blobSelection = selectBlobs(initialPlan.attachments, export.blobs)
        val stored = linkedMapOf<String, StoredLegacyBlob>()

        try {
            blobSelection.values.distinctBy { it.id }.forEach { blob ->
                stored[blob.id] = blobStore.putVerified(accountId, blob, blob.decodedBytes())
            }
            val pendingQueueItems = database.withTransaction {
                val dao = database.dao()
                val committedPlan = buildPlan(dao, accountId, export.snapshot, policy)
                check(committedPlan.sameRecordsAs(initialPlan)) {
                    "The native workspace changed while the legacy export was being prepared. Try the import again."
                }
                applyPlan(
                    dao = dao,
                    accountId = accountId,
                    activeDeviceId = activeDeviceId,
                    export = export,
                    plan = committedPlan,
                    attachmentBlobs = blobSelection.mapValues { (_, blob) -> stored.getValue(blob.id) },
                )
                dao.pendingQueue(accountId.value).size
            }
            return LegacyImportResult(
                entries = initialPlan.entries.size,
                attachments = initialPlan.attachments.size,
                fileBoxItems = initialPlan.fileBoxItems.size,
                transfers = initialPlan.transfers.size,
                conflicts = initialPlan.conflicts.size,
                tombstones = initialPlan.tombstones.size,
                verifiedBlobs = stored.size,
                skippedRecords = initialPlan.skippedRecords,
                skippedOrphanBlobs = export.blobs.size - stored.size,
                pendingQueueItems = pendingQueueItems,
            )
        } catch (error: Throwable) {
            stored.values.reversed().forEach { blob ->
                runCatching { blobStore.removeIfCreated(blob) }
            }
            throw error
        }
    }

    private suspend fun applyPlan(
        dao: LabNotebookDao,
        accountId: AccountId,
        activeDeviceId: String,
        export: LegacyWorkspaceExportV1,
        plan: ImportPlan,
        attachmentBlobs: Map<String, StoredLegacyBlob>,
    ) {
        export.snapshot.device?.let { device ->
            if (device.id !in dao.devices(accountId.value).mapTo(hashSetOf()) { it.id }) {
                dao.upsertDevice(device.toLegacyEntity(accountId))
            }
        }
        plan.entries.forEach { entry ->
            val entity = entry.toLegacyEntity(accountId, activeDeviceId)
            dao.upsertEntry(entity)
            if (isVerifiedUnsynced(entity.syncStatus)) {
                dao.upsertQueueItem(
                    upsertQueue(
                        accountId = accountId,
                        entityKind = "entry",
                        entityId = entity.id,
                        updatedAt = entity.updatedAt,
                        updatedByDeviceId = entity.updatedByDeviceId,
                        baseVersion = null,
                        failed = entity.syncStatus == "failed",
                    ),
                )
            }
        }
        plan.attachments.forEach { attachment ->
            val entry = export.snapshot.entries.getValue(attachment.entryId)
            val entity = attachment.toLegacyEntity(
                accountId = accountId,
                entry = entry,
                exportedAt = export.exportedAt,
                storedBlob = attachmentBlobs[attachment.id],
            )
            dao.upsertAttachment(entity)
            if (isVerifiedUnsynced(entity.syncStatus)) {
                dao.upsertQueueItem(
                    upsertQueue(
                        accountId = accountId,
                        entityKind = "attachment",
                        entityId = entity.id,
                        updatedAt = entity.updatedAt,
                        updatedByDeviceId = activeDeviceId,
                        failed = entity.syncStatus == "failed",
                    ),
                )
            }
        }
        plan.fileBoxItems.forEach { item ->
            dao.upsertFileBoxItem(item.toLegacyEntity(accountId))
            if (item.status in LOCAL_FILE_BOX_STATUSES) {
                dao.upsertQueueItem(
                    upsertQueue(accountId, "fileBoxItem", item.id, item.updatedAt, activeDeviceId, failed = item.status == "failed"),
                )
            }
        }
        plan.transfers.forEach { transfer ->
            dao.upsertTransfer(transfer.toLegacyEntity(accountId))
            if (transfer.status in LOCAL_TRANSFER_STATUSES) {
                dao.upsertQueueItem(
                    upsertQueue(accountId, "transfer", transfer.id, transfer.updatedAt, activeDeviceId, failed = transfer.status == "failed"),
                )
            }
        }
        plan.conflicts.forEach { dao.upsertConflict(it.toLegacyEntity(accountId)) }
        plan.tombstones.forEach { tombstone ->
            dao.upsertTombstone(tombstone.toLegacyEntity(accountId))
            dao.upsertQueueItem(
                SyncQueueEntity(
                    accountId = accountId.value,
                    id = deleteQueueEventId(tombstone.entityKind, tombstone.entityId, tombstone.deletedAt),
                    entityKind = tombstone.entityKind,
                    entityId = tombstone.entityId,
                    operation = "delete",
                    status = "queued",
                    queuedAt = tombstone.deletedAt,
                    updatedAt = tombstone.deletedAt,
                    updatedByDeviceId = tombstone.deletedByDeviceId.ifBlank { activeDeviceId },
                ),
            )
        }

        val pending = dao.pendingQueue(accountId.value)
        dao.upsertSyncState(
            SyncStateEntity(
                accountId = accountId.value,
                lastMessage = "Legacy workspace imported. Native Drive writes remain disabled.",
                updatedAt = export.exportedAt,
                queueCount = pending.size,
            ),
        )
    }
}

private data class ImportPlan(
    val entries: List<DriveV1Entry>,
    val attachments: List<DriveV1Attachment>,
    val fileBoxItems: List<DriveV1FileBoxItem>,
    val transfers: List<DriveV1Transfer>,
    val conflicts: List<DriveV1Conflict>,
    val tombstones: List<DriveV1Tombstone>,
    val skippedRecords: Int,
) {
    fun sameRecordsAs(other: ImportPlan): Boolean =
        entries.map { it.id } == other.entries.map { it.id } &&
            attachments.map { it.id } == other.attachments.map { it.id } &&
            fileBoxItems.map { it.id } == other.fileBoxItems.map { it.id } &&
            transfers.map { it.id } == other.transfers.map { it.id } &&
            conflicts.map { it.id } == other.conflicts.map { it.id } &&
            tombstones.map { it.entityKind to it.entityId } == other.tombstones.map { it.entityKind to it.entityId }
}

private suspend fun buildPlan(
    dao: LabNotebookDao,
    accountId: AccountId,
    snapshot: LegacyWorkspaceSnapshotV1,
    policy: LegacyImportPolicy,
): ImportPlan = when (policy) {
    LegacyImportPolicy.RequireEmptyWorkspace -> {
        requireWorkspaceEmpty(dao, accountId)
        ImportPlan(
            entries = snapshot.entries.values.sortedBy { it.id },
            attachments = snapshot.attachments.sortedBy { it.id },
            fileBoxItems = snapshot.fileBoxItems.sortedBy { it.id },
            transfers = snapshot.transfers.sortedBy { it.id },
            conflicts = snapshot.conflicts.sortedBy { it.id },
            tombstones = snapshot.tombstones.sortedBy { it.id },
            skippedRecords = 0,
        )
    }
    LegacyImportPolicy.MergeVerifiedUnsyncedOnly -> {
        val entries = snapshot.entries.values
            .filter { isVerifiedUnsynced(it.syncStatus) && dao.entry(accountId.value, it.id) == null }
            .sortedBy { it.id }
        val availableEntryIds = entries.mapTo(hashSetOf()) { it.id }.apply {
            snapshot.entries.keys.forEach { id ->
                if (dao.entry(accountId.value, id) != null) add(id)
            }
        }
        val attachments = snapshot.attachments
            .filter { isVerifiedUnsynced(it.syncStatus) && dao.attachment(accountId.value, it.id) == null }
            .filter { attachment ->
                require(attachment.entryId in availableEntryIds) {
                    "Unsynced attachment ${attachment.id} has no restored or importable parent entry."
                }
                true
            }
            .sortedBy { it.id }
        val availableAttachmentIds = attachments.mapTo(hashSetOf()) { it.id }.apply {
            snapshot.attachments.forEach { attachment ->
                if (dao.attachment(accountId.value, attachment.id) != null) add(attachment.id)
            }
        }

        val existingFileBox = dao.fileBoxItems(accountId.value).mapTo(hashSetOf()) { it.id }
        val fileBoxItems = snapshot.fileBoxItems
            .filter { it.status in LOCAL_FILE_BOX_STATUSES && it.id !in existingFileBox }
            .filter { item ->
                require(item.entryId in availableEntryIds && (item.attachmentId == null || item.attachmentId in availableAttachmentIds)) {
                    "Unsynced File Box item ${item.id} has a missing restored or importable dependency."
                }
                true
            }
            .sortedBy { it.id }
        val availableFileBoxIds = fileBoxItems.mapTo(hashSetOf()) { it.id }.apply { addAll(existingFileBox) }

        val existingTransfers = dao.transfers(accountId.value).mapTo(hashSetOf()) { it.id }
        val transfers = snapshot.transfers
            .filter { it.status in LOCAL_TRANSFER_STATUSES && it.id !in existingTransfers }
            .filter { transfer ->
                require(
                    (transfer.entryId == null || transfer.entryId in availableEntryIds) &&
                        (transfer.attachmentId == null || transfer.attachmentId in availableAttachmentIds) &&
                        (transfer.fileBoxItemId == null || transfer.fileBoxItemId in availableFileBoxIds),
                ) { "Unsynced transfer ${transfer.id} has a missing restored or importable dependency." }
                true
            }
            .sortedBy { it.id }
        val existingConflicts = dao.conflicts(accountId.value).mapTo(hashSetOf()) { it.id }
        val conflicts = snapshot.conflicts
            .filter { it.resolution == "pending" && it.id !in existingConflicts }
            .sortedBy { it.id }
        val existingTombstones = dao.tombstones(accountId.value)
            .mapTo(hashSetOf()) { it.entityKind to it.entityId }
        val tombstones = snapshot.tombstones
            .filter { (it.entityKind to it.entityId) !in existingTombstones }
            .sortedBy { it.id }
        val selected = entries.size + attachments.size + fileBoxItems.size + transfers.size + conflicts.size + tombstones.size
        val total = snapshot.entries.size + snapshot.attachments.size + snapshot.fileBoxItems.size +
            snapshot.transfers.size + snapshot.conflicts.size + snapshot.tombstones.size
        ImportPlan(entries, attachments, fileBoxItems, transfers, conflicts, tombstones, total - selected)
    }
}

private suspend fun requireWorkspaceEmpty(dao: LabNotebookDao, accountId: AccountId) {
    val recordCount = dao.entryCount(accountId.value) +
        dao.attachmentCount(accountId.value) +
        dao.fileBoxItemCount(accountId.value) +
        dao.transferCount(accountId.value) +
        dao.conflictCount(accountId.value) +
        dao.tombstoneCount(accountId.value) +
        dao.queueCount(accountId.value)
    require(recordCount == 0) {
        "The native workspace already contains notebook data. Restore Drive first, then merge verified unsynced changes."
    }
}

private fun selectBlobs(
    attachments: List<DriveV1Attachment>,
    blobs: List<LegacyWorkspaceBlobV1>,
): Map<String, LegacyWorkspaceBlobV1> {
    val byId = blobs.associateBy { it.id }
    return attachments.mapNotNull { attachment ->
        attachment.legacyBlobKeyCandidates().firstNotNullOfOrNull(byId::get)?.let { attachment.id to it }
    }.toMap()
}

private fun upsertQueue(
    accountId: AccountId,
    entityKind: String,
    entityId: String,
    updatedAt: String,
    updatedByDeviceId: String,
    baseVersion: Int? = null,
    failed: Boolean = false,
) = SyncQueueEntity(
    accountId = accountId.value,
    id = upsertQueueEventId(entityKind, entityId),
    entityKind = entityKind,
    entityId = entityId,
    operation = "upsert",
    status = if (failed) "failed" else "queued",
    queuedAt = updatedAt,
    updatedAt = updatedAt,
    updatedByDeviceId = updatedByDeviceId,
    baseVersion = baseVersion,
)

private val LOCAL_FILE_BOX_STATUSES = setOf("queued", "uploading", "failed")
private val LOCAL_TRANSFER_STATUSES = setOf("queued", "uploading", "failed", "conflict")
