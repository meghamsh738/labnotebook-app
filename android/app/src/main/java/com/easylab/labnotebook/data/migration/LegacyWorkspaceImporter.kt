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
import com.easylab.labnotebook.sync.DriveV1Device
import com.easylab.labnotebook.sync.DriveV1Entry
import com.easylab.labnotebook.sync.DriveV1FileBoxItem
import com.easylab.labnotebook.sync.DriveV1Tombstone
import com.easylab.labnotebook.sync.DriveV1Transfer
import com.easylab.labnotebook.sync.compareIsoTimestamps

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
        val initialPlan = buildPlan(database.dao(), accountId, export.snapshot, export.blobs, export.exportedAt, policy)
        val blobSelection = selectBlobs(initialPlan.attachments, export.blobs)
        val stored = linkedMapOf<String, StoredLegacyBlob>()

        try {
            blobSelection.values.distinctBy { it.id }.forEach { blob ->
                stored[blob.id] = blobStore.putVerified(accountId, blob, blob.decodedBytes())
            }
            val pendingQueueItems = database.withTransaction {
                val dao = database.dao()
                val committedPlan = buildPlan(dao, accountId, export.snapshot, export.blobs, export.exportedAt, policy)
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
            val imported = entry.toLegacyEntity(accountId, activeDeviceId)
            // Verified-unsynced legacy entries have no Drive baseline. Browser-local
            // edit counts are therefore not valid Drive versions for their first upload.
            val entity = if (isVerifiedUnsynced(imported.syncStatus)) {
                imported.copy(version = 1)
            } else {
                imported
            }
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

private data class LiveImportSelection(
    val entries: List<DriveV1Entry>,
    val attachments: List<DriveV1Attachment>,
    val attachmentUpsertIds: Set<String>,
    val fileBoxItems: List<DriveV1FileBoxItem>,
    val transfers: List<DriveV1Transfer>,
    val device: DriveV1Device?,
    val exportedAt: String,
)

private fun liveImportSelection(
    accountId: AccountId,
    snapshot: LegacyWorkspaceSnapshotV1,
    blobs: List<LegacyWorkspaceBlobV1>,
    entries: List<DriveV1Entry>,
    attachments: List<DriveV1Attachment>,
    fileBoxItems: List<DriveV1FileBoxItem>,
    transfers: List<DriveV1Transfer>,
    exportedAt: String,
): LiveImportSelection {
    val attachmentIdsWithSelectedBlobs = selectBlobs(attachments, blobs).keys
    val attachmentUpsertIds = attachments.mapNotNullTo(mutableSetOf()) { attachment ->
        val plannedBlob = if (attachment.id in attachmentIdsWithSelectedBlobs) {
            StoredLegacyBlob(attachment.id, "planned/${attachment.id}", createdByImport = false)
        } else {
            null
        }
        val mapped = attachment.toLegacyEntity(
            accountId = accountId,
            entry = snapshot.entries.getValue(attachment.entryId),
            exportedAt = exportedAt,
            storedBlob = plannedBlob,
        )
        attachment.id.takeIf { isVerifiedUnsynced(mapped.syncStatus) }
    }
    return LiveImportSelection(
        entries = entries,
        attachments = attachments,
        attachmentUpsertIds = attachmentUpsertIds,
        fileBoxItems = fileBoxItems,
        transfers = transfers,
        device = snapshot.device,
        exportedAt = exportedAt,
    )
}

private suspend fun buildPlan(
    dao: LabNotebookDao,
    accountId: AccountId,
    snapshot: LegacyWorkspaceSnapshotV1,
    blobs: List<LegacyWorkspaceBlobV1>,
    exportedAt: String,
    policy: LegacyImportPolicy,
): ImportPlan = when (policy) {
    LegacyImportPolicy.RequireEmptyWorkspace -> {
        requireWorkspaceEmpty(dao, accountId)
        val entries = snapshot.entries.values.sortedBy { it.id }
        val attachments = snapshot.attachments.sortedBy { it.id }
        val fileBoxItems = snapshot.fileBoxItems.sortedBy { it.id }
        val transfers = snapshot.transfers.sortedBy { it.id }
        val tombstones = safeTombstones(
            dao,
            accountId,
            snapshot.tombstones,
            liveImportSelection(
                accountId,
                snapshot,
                blobs,
                entries,
                attachments,
                fileBoxItems,
                transfers,
                exportedAt,
            ),
        )
        ImportPlan(
            entries = entries,
            attachments = attachments,
            fileBoxItems = fileBoxItems,
            transfers = transfers,
            conflicts = snapshot.conflicts.sortedBy { it.id },
            tombstones = tombstones,
            skippedRecords = snapshot.tombstones.size - tombstones.size,
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
        val tombstones = safeTombstones(
            dao,
            accountId,
            snapshot.tombstones,
            liveImportSelection(
                accountId,
                snapshot,
                blobs,
                entries,
                attachments,
                fileBoxItems,
                transfers,
                exportedAt,
            ),
        )
        val selected = entries.size + attachments.size + fileBoxItems.size + transfers.size + conflicts.size + tombstones.size
        val total = snapshot.entries.size + snapshot.attachments.size + snapshot.fileBoxItems.size +
            snapshot.transfers.size + snapshot.conflicts.size + snapshot.tombstones.size
        ImportPlan(entries, attachments, fileBoxItems, transfers, conflicts, tombstones, total - selected)
    }
}

private suspend fun safeTombstones(
    dao: LabNotebookDao,
    accountId: AccountId,
    candidates: List<DriveV1Tombstone>,
    selection: LiveImportSelection,
): List<DriveV1Tombstone> {
    val existingTombstoneRows = dao.tombstones(accountId.value)
    val existingTargets = existingTombstoneRows
        .mapTo(hashSetOf()) { it.entityKind to it.entityId }
    val existingTombstonesById = existingTombstoneRows.associateBy { it.id }
    val pendingUpserts = dao.pendingQueue(accountId.value)
        .asSequence()
        .filter { it.operation == "upsert" }
        .mapTo(mutableSetOf()) { it.entityKind to it.entityId }
        .apply {
            selection.entries.filter { it.syncStatus == null || isVerifiedUnsynced(it.syncStatus) }
                .forEach { add("entry" to it.id) }
            selection.attachmentUpsertIds.forEach { add("attachment" to it) }
            selection.fileBoxItems.filter { it.status in LOCAL_FILE_BOX_STATUSES }
                .forEach { add("fileBoxItem" to it.id) }
            selection.transfers.filter { it.status in LOCAL_TRANSFER_STATUSES }
                .forEach { add("transfer" to it.id) }
        }
    val fileBoxRows = dao.fileBoxItems(accountId.value)
    val transferRows = dao.transfers(accountId.value)
    val deviceUpdatedAt = dao.devices(accountId.value).associate { it.id to it.lastSeenAt }
    val liveTargetUpdatedAt = linkedMapOf<Pair<String, String>, String?>()
    candidates.forEach { tombstone ->
        val target = tombstone.entityKind to tombstone.entityId
        if (target !in liveTargetUpdatedAt) {
            liveTargetUpdatedAt[target] = when (tombstone.entityKind) {
                "entry" -> dao.entry(accountId.value, tombstone.entityId)?.updatedAt
                "attachment" -> dao.attachment(accountId.value, tombstone.entityId)?.updatedAt
                "fileBoxItem" -> fileBoxRows.firstOrNull { it.id == tombstone.entityId }?.updatedAt
                "transfer" -> transferRows.firstOrNull { it.id == tombstone.entityId }?.updatedAt
                "device" -> deviceUpdatedAt[tombstone.entityId]
                "tombstone" -> existingTombstoneRows.firstOrNull { it.id == tombstone.entityId }?.deletedAt
                else -> null
            }
        }
    }
    selection.entries.forEach { liveTargetUpdatedAt.putIfMissing("entry" to it.id, it.lastEditedDatetime) }
    selection.attachments.forEach {
        liveTargetUpdatedAt.putIfMissing("attachment" to it.id, it.updatedAt ?: it.createdAt ?: selection.exportedAt)
    }
    selection.fileBoxItems.forEach { liveTargetUpdatedAt.putIfMissing("fileBoxItem" to it.id, it.updatedAt) }
    selection.transfers.forEach { liveTargetUpdatedAt.putIfMissing("transfer" to it.id, it.updatedAt) }
    selection.device?.takeIf { it.id !in deviceUpdatedAt }?.let {
        liveTargetUpdatedAt.putIfMissing("device" to it.id, it.lastSeenAt)
    }

    val unsafeParentTargets = mutableSetOf<Pair<String, String>>()
    for (tombstone in candidates) {
        if (tombstone.entityKind !in setOf("entry", "attachment", "fileBoxItem")) continue
        val dependents = dependentRecords(dao, accountId, tombstone, selection, fileBoxRows, transferRows)
        val hasPendingChild = dependents.keys.any { it in pendingUpserts }
        val hasNewerOrEqualChild = dependents.values.any { updatedAt ->
            compareIsoTimestamps(tombstone.deletedAt, updatedAt) <= 0
        }
        if (hasPendingChild || hasNewerOrEqualChild) {
            unsafeParentTargets += tombstone.entityKind to tombstone.entityId
        }
    }

    return candidates
        .filter { (it.entityKind to it.entityId) !in existingTargets }
        .filter { tombstone ->
            existingTombstonesById[tombstone.id]?.let { existing ->
                existing.entityKind == tombstone.entityKind && existing.entityId == tombstone.entityId
            } != false
        }
        .filter { tombstone ->
            val target = tombstone.entityKind to tombstone.entityId
            val localUpdatedAt = liveTargetUpdatedAt[target]
            target !in pendingUpserts && target !in unsafeParentTargets &&
                (localUpdatedAt == null || compareIsoTimestamps(tombstone.deletedAt, localUpdatedAt) > 0)
        }
        .sortedBy { it.id }
}

private data class AttachmentDependency(val id: String, val entryId: String, val updatedAt: String)

private data class FileBoxDependency(
    val id: String,
    val entryId: String,
    val attachmentId: String?,
    val updatedAt: String,
)

private data class TransferDependency(
    val id: String,
    val entryId: String?,
    val attachmentId: String?,
    val fileBoxItemId: String?,
    val updatedAt: String,
)

private suspend fun dependentRecords(
    dao: LabNotebookDao,
    accountId: AccountId,
    tombstone: DriveV1Tombstone,
    selection: LiveImportSelection,
    localFileBoxItems: List<com.easylab.labnotebook.data.local.FileBoxItemEntity>,
    localTransfers: List<com.easylab.labnotebook.data.local.TransferEntity>,
): Map<Pair<String, String>, String> {
    val attachments = when (tombstone.entityKind) {
        "entry" -> (
            dao.attachmentsForEntry(accountId.value, tombstone.entityId)
                .map { AttachmentDependency(it.id, it.entryId, it.updatedAt) } +
                selection.attachments.filter { it.entryId == tombstone.entityId }
                    .map {
                        AttachmentDependency(
                            it.id,
                            it.entryId,
                            it.updatedAt ?: it.createdAt ?: selection.exportedAt,
                        )
                    }
            ).distinctBy { it.id }
        else -> emptyList()
    }
    val attachmentIds = attachments.mapTo(hashSetOf()) { it.id }
    val fileBoxItems = (
        localFileBoxItems.map { FileBoxDependency(it.id, it.entryId, it.attachmentId, it.updatedAt) } +
            selection.fileBoxItems.map { FileBoxDependency(it.id, it.entryId, it.attachmentId, it.updatedAt) }
        ).filter { item ->
        when (tombstone.entityKind) {
            "entry" -> item.entryId == tombstone.entityId || item.attachmentId in attachmentIds
            "attachment" -> item.attachmentId == tombstone.entityId
            else -> false
        }
    }.distinctBy { it.id }
    val fileBoxIds = fileBoxItems.mapTo(hashSetOf()) { it.id }
    val transfers = (
        localTransfers.map {
            TransferDependency(it.id, it.entryId, it.attachmentId, it.fileBoxItemId, it.updatedAt)
        } + selection.transfers.map {
            TransferDependency(it.id, it.entryId, it.attachmentId, it.fileBoxItemId, it.updatedAt)
        }
        ).filter { transfer ->
        when (tombstone.entityKind) {
            "entry" -> transfer.entryId == tombstone.entityId ||
                transfer.attachmentId in attachmentIds || transfer.fileBoxItemId in fileBoxIds
            "attachment" -> transfer.attachmentId == tombstone.entityId || transfer.fileBoxItemId in fileBoxIds
            "fileBoxItem" -> transfer.fileBoxItemId == tombstone.entityId
            else -> false
        }
    }.distinctBy { it.id }
    return buildMap {
        attachments.forEach { put("attachment" to it.id, it.updatedAt) }
        fileBoxItems.forEach { put("fileBoxItem" to it.id, it.updatedAt) }
        transfers.forEach { put("transfer" to it.id, it.updatedAt) }
    }
}

private fun MutableMap<Pair<String, String>, String?>.putIfMissing(
    target: Pair<String, String>,
    updatedAt: String,
) {
    if (this[target] == null) this[target] = updatedAt
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
