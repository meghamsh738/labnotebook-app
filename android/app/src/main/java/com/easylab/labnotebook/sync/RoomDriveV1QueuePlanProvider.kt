package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.DriveWritePayloadEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.requireCanonicalQueueTimestamp
import com.easylab.labnotebook.data.repository.DriveFileRef
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.decodeFromString

/**
 * Concrete offline/test-only queue planner. It combines Room state, a cached
 * merge base, and a fresh read-only Drive snapshot. Nothing in production
 * constructs this provider or its write coordinator.
 */
internal class RoomDriveV1QueuePlanProvider(
    private val database: LabNotebookDatabase,
    private val remoteReader: DriveV1MetadataReader,
    private val publicationTimestamp: () -> String,
    private val localBlobKey: (AttachmentEntity) -> String? = { attachment -> "attachment:${attachment.id}" },
) : DriveV1QueuePlanProvider {
    override suspend fun prepare(
        accountId: AccountId,
        claimedQueueItem: SyncQueueEntity,
    ): DriveV1QueuePlanDecision = try {
        prepareVerified(accountId, claimedQueueItem)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        DriveV1QueuePlanDecision.Blocked(error.message ?: "Drive plan preparation failed closed.")
    }

    private suspend fun prepareVerified(
        accountId: AccountId,
        claimedQueueItem: SyncQueueEntity,
    ): DriveV1QueuePlanDecision {
        require(claimedQueueItem.accountId == accountId.value) { "Claimed queue item belongs to another account." }
        require(claimedQueueItem.status == "syncing" && !claimedQueueItem.claimToken.isNullOrBlank()) {
            "A Drive plan requires an active queue claim."
        }
        requireCanonicalQueueTimestamp(claimedQueueItem.updatedAt, "Queue mutation timestamp")
        val snapshot = try {
            remoteReader.read(accountId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(error.message ?: "Fresh Drive snapshot could not be verified.")
        }
        if (snapshot.conflicts.any { !it.cacheAsBaseline }) {
            return DriveV1QueuePlanDecision.Blocked(
                "Malformed remote JSON is quarantined; no Drive mutation is allowed.",
            )
        }
        val baselineBlobDigests = try {
            snapshot.verifiedBlobDigests()
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(
                error.message ?: "Verified attachment blob metadata is inconsistent.",
            )
        }
        snapshot.manifestRef.requirePositiveVersion("manifest.json")
        val publishAt = publicationTimestamp()
        requireCanonicalQueueTimestamp(publishAt, "Drive publication timestamp")
        if (compareIsoTimestamps(publishAt, snapshot.manifest.updatedAt) <= 0) {
            return DriveV1QueuePlanDecision.Blocked(
                "Drive publication time must be newer than the verified remote manifest.",
            )
        }
        val manifestBaseline = snapshot.manifestRecord(accountId)
        val manifestDocument = try {
            DriveV1LocalSerializer.serializeManifestProjection(
                accountId = accountId,
                updatedAt = publishAt,
                projection = snapshot.projectedManifestAfter(claimedQueueItem),
                rawBaseline = manifestBaseline,
            )
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(error.message ?: "Local manifest inventory is invalid.")
        }
        return when (claimedQueueItem.operation) {
            "upsert" -> planUpsert(accountId, claimedQueueItem, snapshot, manifestDocument, baselineBlobDigests)
            "delete" -> planDelete(accountId, claimedQueueItem, snapshot, manifestDocument, baselineBlobDigests)
            else -> DriveV1QueuePlanDecision.Blocked("Unsupported queue operation: ${claimedQueueItem.operation}")
        }
    }

    private suspend fun planUpsert(
        accountId: AccountId,
        queue: SyncQueueEntity,
        snapshot: DriveV1MetadataSnapshot,
        manifest: DriveV1SerializedDocument,
        baselineBlobDigests: Map<String, String>,
    ): DriveV1QueuePlanDecision = when (queue.entityKind) {
        "entry" -> planEntry(accountId, queue, snapshot, manifest, baselineBlobDigests)
        "attachment" -> planAttachment(accountId, queue, snapshot, manifest, baselineBlobDigests)
        "fileBoxItem" -> planFileBox(accountId, queue, snapshot, manifest, baselineBlobDigests)
        "transfer" -> planTransfer(accountId, queue, snapshot, manifest, baselineBlobDigests)
        else -> DriveV1QueuePlanDecision.Blocked("Unsupported queue entity kind: ${queue.entityKind}")
    }

    private suspend fun planEntry(
        accountId: AccountId,
        queue: SyncQueueEntity,
        snapshot: DriveV1MetadataSnapshot,
        manifest: DriveV1SerializedDocument,
        baselineBlobDigests: Map<String, String>,
    ): DriveV1QueuePlanDecision {
        val dao = database.dao()
        val local = dao.entry(accountId.value, queue.entityId)
            ?: return DriveV1QueuePlanDecision.Blocked("Local entry state is missing.")
        val base = dao.driveRawDocument(accountId.value, "entry", queue.entityId)
        val remote = snapshot.entries.singleOrNull { it.value.id == queue.entityId }
        val remoteTombstone = snapshot.tombstones.singleOrNull {
            it.value.entityKind == "entry" && it.value.entityId == queue.entityId
        }
        val targetPath = remote?.ref?.path ?: base?.path ?: run {
            val sameDayIds = dao.entries(accountId.value)
                .filter { it.dateBucket == local.dateBucket }
                .map { it.id }
            DriveV1NewEntryPathSelection.fromCompleteSameDayInventory(
                local.id,
                local.dateBucket,
                sameDayIds,
            ).targetPath
        }
        val pathSelection = if (base == null && remote == null) {
            DriveV1NewEntryPathSelection.fromCompleteSameDayInventory(
                local.id,
                local.dateBucket,
                dao.entries(accountId.value).filter { it.dateBucket == local.dateBucket }.map { it.id },
            )
        } else {
            null
        }
        val freshBaseline = remote?.toRawDocument(accountId, "entry", queue.entityId)
        val serialized = try {
            DriveV1LocalSerializer.serializeEntry(
                accountId,
                local,
                queue,
                targetPath,
                freshBaseline ?: base,
                pathSelection,
            )
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(error.message ?: "Local entry cannot be serialized safely.")
        }
        val localValue = decodeEnvelope<DriveV1Entry>(serialized.json, "entry").payload
        val decision = DriveV1ThreeWayPlanner.planEntry(
            base = base?.let { DriveV1ThreeWayState.Present(decodeEnvelope<DriveV1Entry>(it.rawJson, "entry").payload) }
                ?: DriveV1ThreeWayState.Missing,
            local = DriveV1ThreeWayState.Present(localValue),
            remote = remoteState(remote?.value?.payload, remoteTombstone?.value),
        )
        return finishDecision(
            accountId,
            queue,
            decision,
            serialized,
            remote?.ref,
            remote?.rawJson ?: remoteTombstone?.rawJson,
            remote?.value?.updatedAt ?: remoteTombstone?.value?.deletedAt,
            remote == null && snapshot.managedFiles.any { it.path == serialized.path },
            snapshot.managedFiles,
            manifest,
            baselineBlobDigests,
        )
    }

    private suspend fun planAttachment(
        accountId: AccountId,
        queue: SyncQueueEntity,
        snapshot: DriveV1MetadataSnapshot,
        manifest: DriveV1SerializedDocument,
        baselineBlobDigests: Map<String, String>,
    ): DriveV1QueuePlanDecision {
        val dao = database.dao()
        val local = dao.attachment(accountId.value, queue.entityId)
            ?: return DriveV1QueuePlanDecision.Blocked("Local attachment state is missing.")
        val parent = dao.entry(accountId.value, local.entryId)
            ?: return DriveV1QueuePlanDecision.Blocked("Attachment parent entry is missing.")
        snapshot.requireRemoteParent("entry", local.entryId)?.let {
            return DriveV1QueuePlanDecision.Blocked(it)
        }
        val base = dao.driveRawDocument(accountId.value, "attachment", queue.entityId)
        val remote = snapshot.attachments.singleOrNull { it.value.id == queue.entityId }
        val remoteTombstone = snapshot.tombstones.singleOrNull {
            it.value.entityKind == "attachment" && it.value.entityId == queue.entityId
        }
        val serialized = try {
            DriveV1LocalSerializer.serializeAttachment(
                accountId,
                local,
                parent,
                queue,
                remote?.toRawDocument(accountId, "attachment", queue.entityId) ?: base,
            )
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(error.message ?: "Local attachment cannot be serialized safely.")
        }
        val localValue = decodeEnvelope<DriveV1Attachment>(serialized.json, "attachment").payload
        val decision = DriveV1ThreeWayPlanner.planAttachment(
            base = base?.let {
                DriveV1ThreeWayState.Present(decodeEnvelope<DriveV1Attachment>(it.rawJson, "attachment").payload)
            } ?: DriveV1ThreeWayState.Missing,
            local = DriveV1ThreeWayState.Present(localValue),
            remote = remoteState(remote?.value?.payload, remoteTombstone?.value),
        )
        if (decision !is DriveV1ThreeWayDecision.PushLocal) {
            return finishDecision(
                accountId,
                queue,
                decision,
                serialized,
                remote?.ref,
                remote?.rawJson ?: remoteTombstone?.rawJson,
                remote?.value?.updatedAt ?: remoteTombstone?.value?.deletedAt,
                remote == null && snapshot.managedFiles.any { it.path == serialized.path },
                snapshot.managedFiles,
                manifest,
                baselineBlobDigests,
            )
        }

        if (remote == null && snapshot.managedFiles.any { it.path == serialized.path }) {
            return DriveV1QueuePlanDecision.Blocked("Attachment metadata path has a different occupant.")
        }

        val blobPath = requireNotNull(serialized.attachmentBlobPath)
        val blobRef = snapshot.managedFiles.singleOrNull { it.path == blobPath }
        if (base == null && blobRef != null) {
            return DriveV1QueuePlanDecision.Blocked("A new attachment blob path already has an occupant.")
        }
        if (base != null && blobRef == null) {
            return DriveV1QueuePlanDecision.Blocked("Existing attachment blob is missing without a tombstone.")
        }
        val byteCount = local.byteSize
            ?: return DriveV1QueuePlanDecision.Blocked("Attachment byte count is required for a guarded write.")
        val contentHash = local.sha256?.lowercase()?.takeIf(DURABLE_CONTENT_HASH::matches)
            ?: return DriveV1QueuePlanDecision.Blocked("Attachment SHA-256 is required for a guarded write.")
        val mimeType = local.mimeType?.takeIf(String::isNotBlank)
            ?: return DriveV1QueuePlanDecision.Blocked("Attachment MIME type is required for a guarded write.")
        val blobKey = localBlobKey(local)?.takeIf(String::isNotBlank)
            ?: return DriveV1QueuePlanDecision.Blocked("Attachment has no account-scoped local blob identity.")
        val blobPrecondition = blobRef.preconditionOrCreate(blobPath)
        val resumableId = if (byteCount >= DriveV1DurableTransactionPlan.RESUMABLE_THRESHOLD_BYTES) {
            DriveV1DurableOperationIds.blob(queue, blobPath, blobPrecondition, contentHash)
        } else {
            null
        }
        val writes = listOf(
            DriveV1DurableWrite.blob(
                path = blobPath,
                localBlobKey = blobKey,
                mimeType = mimeType,
                byteCount = byteCount,
                sha256 = contentHash,
                precondition = blobPrecondition,
                resumableOperationId = resumableId,
                baselineContentSha256 = blobRef?.let {
                    baselineBlobDigests[blobPath]
                        ?: return DriveV1QueuePlanDecision.Blocked(
                            "Existing attachment blob lacks a verified baseline digest.",
                        )
                },
            ),
        )
        val metadata = serialized.prepareDurableWrite(accountId, queue, remote?.ref)
        val manifestWrite = manifest.prepareDurableWrite(accountId, queue, snapshot.manifestRef)
        return DriveV1QueuePlanDecision.Ready(
            DriveV1DurableTransactionPlan.create(
                writes + metadata.write,
                manifestWrite.write,
                snapshot.managedFiles,
                baselineBlobDigests,
            ),
            listOf(metadata.payload, manifestWrite.payload),
        )
    }

    private suspend fun planFileBox(
        accountId: AccountId,
        queue: SyncQueueEntity,
        snapshot: DriveV1MetadataSnapshot,
        manifest: DriveV1SerializedDocument,
        baselineBlobDigests: Map<String, String>,
    ): DriveV1QueuePlanDecision {
        val dao = database.dao()
        val local = dao.fileBoxItem(accountId.value, queue.entityId)
            ?: return DriveV1QueuePlanDecision.Blocked("Local File Box state is missing.")
        snapshot.requireRemoteParent("entry", local.entryId)?.let {
            return DriveV1QueuePlanDecision.Blocked(it)
        }
        local.attachmentId?.let { attachmentId ->
            snapshot.requireRemoteParent("attachment", attachmentId)?.let {
                return DriveV1QueuePlanDecision.Blocked(it)
            }
        }
        val base = dao.driveRawDocument(accountId.value, "fileBoxItem", queue.entityId)
        val remote = snapshot.fileBoxItems.singleOrNull { it.value.id == queue.entityId }
        val remoteTombstone = snapshot.tombstones.singleOrNull {
            it.value.entityKind == "fileBoxItem" && it.value.entityId == queue.entityId
        }
        val serialized = try {
            DriveV1LocalSerializer.serializeFileBoxItem(
                accountId,
                local,
                queue,
                remote?.toRawDocument(accountId, "fileBoxItem", queue.entityId) ?: base,
            )
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(error.message ?: "Local File Box item cannot be serialized safely.")
        }
        val decision = DriveV1ThreeWayPlanner.planFileBoxItem(
            base = base?.let {
                DriveV1ThreeWayState.Present(
                    decodeEnvelope<DriveV1FileBoxItem>(it.rawJson, "fileBoxItem").payload,
                )
            } ?: DriveV1ThreeWayState.Missing,
            local = DriveV1ThreeWayState.Present(
                decodeEnvelope<DriveV1FileBoxItem>(serialized.json, "fileBoxItem").payload,
            ),
            remote = remoteState(remote?.value?.payload, remoteTombstone?.value),
        )
        return finishDecision(
            accountId,
            queue,
            decision,
            serialized,
            remote?.ref,
            remote?.rawJson ?: remoteTombstone?.rawJson,
            remote?.value?.updatedAt ?: remoteTombstone?.value?.deletedAt,
            remote == null && snapshot.managedFiles.any { it.path == serialized.path },
            snapshot.managedFiles,
            manifest,
            baselineBlobDigests,
        )
    }

    private suspend fun planTransfer(
        accountId: AccountId,
        queue: SyncQueueEntity,
        snapshot: DriveV1MetadataSnapshot,
        manifest: DriveV1SerializedDocument,
        baselineBlobDigests: Map<String, String>,
    ): DriveV1QueuePlanDecision {
        val dao = database.dao()
        val local = dao.transfer(accountId.value, queue.entityId)
            ?: return DriveV1QueuePlanDecision.Blocked("Local transfer state is missing.")
        local.entryId?.let { entryId ->
            snapshot.requireRemoteParent("entry", entryId)?.let {
                return DriveV1QueuePlanDecision.Blocked(it)
            }
        }
        local.attachmentId?.let { attachmentId ->
            snapshot.requireRemoteParent("attachment", attachmentId)?.let {
                return DriveV1QueuePlanDecision.Blocked(it)
            }
        }
        local.fileBoxItemId?.let { fileBoxId ->
            snapshot.requireRemoteParent("fileBoxItem", fileBoxId)?.let {
                return DriveV1QueuePlanDecision.Blocked(it)
            }
        }
        val base = dao.driveRawDocument(accountId.value, "transfer", queue.entityId)
        val remote = snapshot.transfers.singleOrNull { it.value.id == queue.entityId }
        val remoteTombstone = snapshot.tombstones.singleOrNull {
            it.value.entityKind == "transfer" && it.value.entityId == queue.entityId
        }
        val serialized = try {
            DriveV1LocalSerializer.serializeTransfer(
                accountId,
                local,
                queue,
                remote?.toRawDocument(accountId, "transfer", queue.entityId) ?: base,
            )
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(error.message ?: "Local transfer cannot be serialized safely.")
        }
        val decision = DriveV1ThreeWayPlanner.planTransfer(
            base = base?.let {
                DriveV1ThreeWayState.Present(decodeEnvelope<DriveV1Transfer>(it.rawJson, "transfer").payload)
            } ?: DriveV1ThreeWayState.Missing,
            local = DriveV1ThreeWayState.Present(
                decodeEnvelope<DriveV1Transfer>(serialized.json, "transfer").payload,
            ),
            remote = remoteState(remote?.value?.payload, remoteTombstone?.value),
        )
        return finishDecision(
            accountId,
            queue,
            decision,
            serialized,
            remote?.ref,
            remote?.rawJson ?: remoteTombstone?.rawJson,
            remote?.value?.updatedAt ?: remoteTombstone?.value?.deletedAt,
            remote == null && snapshot.managedFiles.any { it.path == serialized.path },
            snapshot.managedFiles,
            manifest,
            baselineBlobDigests,
        )
    }

    private suspend fun planDelete(
        accountId: AccountId,
        queue: SyncQueueEntity,
        snapshot: DriveV1MetadataSnapshot,
        manifest: DriveV1SerializedDocument,
        baselineBlobDigests: Map<String, String>,
    ): DriveV1QueuePlanDecision {
        val dao = database.dao()
        val local = dao.tombstone(accountId.value, queue.entityKind, queue.entityId)
            ?: return DriveV1QueuePlanDecision.Blocked("Local tombstone state is missing.")
        require(local.deletedAt == queue.updatedAt) { "Delete queue timestamp does not match its tombstone." }
        val remoteTombstone = snapshot.tombstones.singleOrNull {
            it.value.entityKind == queue.entityKind && it.value.entityId == queue.entityId
        }
        if (remoteTombstone != null) {
            if (remoteTombstone.value.deletedAt == local.deletedAt) {
                return if (
                    remoteTombstone.value.deletedByDeviceId == local.deletedByDeviceId &&
                    remoteTombstone.value.reason == local.reason
                ) {
                    DriveV1QueuePlanDecision.CompleteWithoutRemote("Remote tombstone already matches exactly.")
                } else {
                    recordConflict(
                        accountId,
                        queue,
                        "Equal-instant local and remote tombstones diverge.",
                        DriveV1LocalSerializer.serializeTombstone(accountId, local).json,
                        remoteTombstone.rawJson,
                        remoteTombstone.value.deletedAt,
                    )
                }
            }
            if (compareIsoTimestamps(remoteTombstone.value.deletedAt, local.deletedAt) > 0) {
                return DriveV1QueuePlanDecision.CompleteWithoutRemote("A newer verified remote tombstone is retained.")
            }
        }

        val base = dao.driveRawDocument(accountId.value, queue.entityKind, queue.entityId)
        val remoteLive = snapshot.liveRecord(queue.entityKind, queue.entityId)
        if (remoteTombstone == null) {
            if (base != null && remoteLive == null) {
                return DriveV1QueuePlanDecision.Blocked(
                    "Remote record is missing without a tombstone despite a prior baseline.",
                )
            }
            if (base == null && remoteLive != null) {
                return recordConflict(
                    accountId,
                    queue,
                    "Local deletion has no merge base for the verified remote record.",
                    null,
                    remoteLive.rawJson,
                    remoteLive.updatedAt,
                )
            }
            if (base != null && remoteLive != null && !sameSemanticValue(queue.entityKind, base.rawJson, remoteLive.rawJson)) {
                return recordConflict(
                    accountId,
                    queue,
                    "Remote edit conflicts with the local deletion.",
                    null,
                    remoteLive.rawJson,
                    remoteLive.updatedAt,
                )
            }
        }
        val freshTombstoneBaseline = remoteTombstone?.toRawDocument(accountId, "tombstone", local.id)
        val serialized = try {
            DriveV1LocalSerializer.serializeTombstone(accountId, local, freshTombstoneBaseline)
        } catch (error: Throwable) {
            return DriveV1QueuePlanDecision.Blocked(error.message ?: "Local tombstone cannot be serialized safely.")
        }
        val tombstoneWrite = serialized.prepareDurableWrite(accountId, queue, remoteTombstone?.ref)
        val manifestWrite = manifest.prepareDurableWrite(accountId, queue, snapshot.manifestRef)
        return DriveV1QueuePlanDecision.Ready(
            DriveV1DurableTransactionPlan.create(
                listOf(tombstoneWrite.write),
                manifestWrite.write,
                snapshot.managedFiles,
                baselineBlobDigests,
            ),
            listOf(tombstoneWrite.payload, manifestWrite.payload),
        )
    }

    private suspend fun finishDecision(
        accountId: AccountId,
        queue: SyncQueueEntity,
        decision: DriveV1ThreeWayDecision,
        serialized: DriveV1SerializedDocument,
        remoteRef: DriveFileRef?,
        remoteJson: String?,
        remoteUpdatedAt: String?,
        pathOccupiedByOther: Boolean,
        baselineFiles: Collection<DriveFileRef>,
        manifest: DriveV1SerializedDocument,
        baselineBlobDigests: Map<String, String>,
    ): DriveV1QueuePlanDecision = when (decision) {
        DriveV1ThreeWayDecision.PushLocal -> if (pathOccupiedByOther) {
            DriveV1QueuePlanDecision.Blocked("Canonical Drive path has a different occupant: ${serialized.path}")
        } else {
            val entityWrite = serialized.prepareDurableWrite(accountId, queue, remoteRef)
            val manifestWrite = manifest.prepareDurableWrite(
                accountId,
                queue,
                baselineFiles.single { it.path == DriveV1Paths.manifest },
            )
            DriveV1QueuePlanDecision.Ready(
                DriveV1DurableTransactionPlan.create(
                    listOf(entityWrite.write),
                    manifestWrite.write,
                    baselineFiles,
                    baselineBlobDigests,
                ),
                listOf(entityWrite.payload, manifestWrite.payload),
            )
        }
        DriveV1ThreeWayDecision.AlreadyConverged ->
            DriveV1QueuePlanDecision.CompleteWithoutRemote("Local and remote records already converge.")
        DriveV1ThreeWayDecision.AcceptRemote ->
            DriveV1QueuePlanDecision.CompleteWithoutRemote(
                "Verified remote change is retained for the read-only metadata applier.",
            )
        DriveV1ThreeWayDecision.AcceptRemoteDelete ->
            DriveV1QueuePlanDecision.CompleteWithoutRemote(
                "Verified remote tombstone is retained for the read-only metadata applier.",
            )
        is DriveV1ThreeWayDecision.Conflict -> recordConflict(
            accountId,
            queue,
            decision.reason,
            serialized.json,
            remoteJson,
            remoteUpdatedAt,
        )
        is DriveV1ThreeWayDecision.Blocked -> DriveV1QueuePlanDecision.Blocked(decision.reason)
    }

    private suspend fun recordConflict(
        accountId: AccountId,
        queue: SyncQueueEntity,
        reason: String,
        localJson: String?,
        remoteJson: String?,
        remoteUpdatedAt: String?,
    ): DriveV1QueuePlanDecision.Conflict {
        database.dao().upsertConflict(
            ConflictEntity(
                accountId = accountId.value,
                id = "conf-${queue.entityKind}-${queue.entityId}",
                entityKind = queue.entityKind,
                entityId = queue.entityId,
                localUpdatedAt = queue.updatedAt,
                remoteUpdatedAt = remoteUpdatedAt ?: queue.updatedAt,
                detectedAt = queue.updatedAt,
                resolution = "pending",
                summary = reason,
                localCopyJson = localJson,
                remoteCopyJson = remoteJson,
            ),
        )
        return DriveV1QueuePlanDecision.Conflict(reason)
    }

    private fun DriveV1MetadataSnapshot.projectedManifestAfter(queue: SyncQueueEntity): DriveV1ManifestProjection {
        val entryIds = entries.mapTo(linkedSetOf()) { it.value.id }
        val attachmentIds = attachments.mapTo(linkedSetOf()) { it.value.id }
        val fileBoxIds = fileBoxItems.mapTo(linkedSetOf()) { it.value.id }
        val transferIds = transfers.mapTo(linkedSetOf()) { it.value.id }

        if (queue.operation == "upsert") {
            when (queue.entityKind) {
                "entry" -> entryIds += queue.entityId
                "attachment" -> attachmentIds += queue.entityId
                "fileBoxItem" -> fileBoxIds += queue.entityId
                "transfer" -> transferIds += queue.entityId
            }
        } else if (queue.operation == "delete") {
            when (queue.entityKind) {
                "entry" -> {
                    entryIds -= queue.entityId
                    val removedAttachments = attachments.filter {
                        it.value.payload.entryId == queue.entityId
                    }.mapTo(hashSetOf()) { it.value.id }
                    attachmentIds.removeAll(removedAttachments)
                    val removedFileBox = fileBoxItems.filter {
                        it.value.payload.entryId == queue.entityId ||
                            it.value.payload.attachmentId in removedAttachments
                    }.mapTo(hashSetOf()) { it.value.id }
                    fileBoxIds.removeAll(removedFileBox)
                    transferIds.removeAll(transfers.filter { record ->
                        record.value.payload.entryId == queue.entityId ||
                            record.value.payload.attachmentId in removedAttachments ||
                            record.value.payload.fileBoxItemId in removedFileBox
                    }.map { it.value.id })
                }
                "attachment" -> {
                    attachmentIds.remove(queue.entityId)
                    val removedFileBox = fileBoxItems.filter {
                        it.value.payload.attachmentId == queue.entityId
                    }.mapTo(hashSetOf()) { it.value.id }
                    fileBoxIds.removeAll(removedFileBox)
                    transferIds.removeAll(transfers.filter { record ->
                        record.value.payload.attachmentId == queue.entityId ||
                            record.value.payload.fileBoxItemId in removedFileBox
                    }.map { it.value.id })
                }
                "fileBoxItem" -> {
                    fileBoxIds.remove(queue.entityId)
                    transferIds.removeAll(transfers.filter { record ->
                        record.value.payload.fileBoxItemId == queue.entityId
                    }.map { it.value.id })
                }
                "transfer" -> transferIds.remove(queue.entityId)
            }
        }
        return DriveV1ManifestProjection(
            devices = manifest.devices,
            entryCount = entryIds.size,
            attachmentCount = attachmentIds.size,
            fileBoxCount = fileBoxIds.size,
            transferCount = transferIds.size,
        )
    }

    private data class PreparedJsonWrite(
        val write: DriveV1DurableWrite,
        val payload: DriveWritePayloadEntity,
    )

    private fun DriveV1SerializedDocument.prepareDurableWrite(
        accountId: AccountId,
        queue: SyncQueueEntity,
        remoteRef: DriveFileRef?,
    ): PreparedJsonWrite {
        require(this.accountId == accountId.value) { "Durable JSON payload belongs to another account." }
        val contentSha256 = contentSha256(json)
        val payloadKey = DriveV1DurableOperationIds.jsonPayload(queue, path, contentSha256)
        val payload = DriveWritePayloadEntity(
            accountId = accountId.value,
            payloadKey = payloadKey,
            contentSha256 = contentSha256,
            payloadJson = json,
            createdAt = queue.updatedAt,
        )
        return PreparedJsonWrite(
            write = DriveV1DurableWrite.json(
                path = path,
                json = json,
                localJsonKey = payloadKey,
                precondition = remoteRef.preconditionOrCreate(path),
                baselineEntityKind = entityKind,
                baselineEntityId = entityId,
            ),
            payload = payload,
        )
    }

    private fun DriveV1MetadataSnapshot.verifiedBlobDigests(): Map<String, String> {
        val digestPairs = attachments.map { record ->
            val digest = record.value.payload.sha256?.lowercase()?.takeIf(DURABLE_CONTENT_HASH::matches)
                ?: throw IllegalArgumentException(
                    "Verified attachment metadata lacks a canonical blob digest: ${record.value.id}",
                )
            record.value.payload.storagePath to digest
        }
        require(digestPairs.map { it.first }.distinct().size == digestPairs.size) {
            "Multiple verified attachment records refer to the same blob path."
        }
        val metadataDigests = digestPairs.toMap()
        val blobFiles = managedFiles.filter { it.appProperties["entityType"] == "attachmentBlob" }
        blobFiles.forEach { file ->
            val metadataDigest = metadataDigests[file.path]
                ?: throw IllegalArgumentException("Verified attachment blob has no metadata record: ${file.path}")
            require(file.appProperties == mapOf("entityType" to "attachmentBlob", "sha256" to metadataDigest)) {
                "Verified attachment blob metadata differs from its attachment record: ${file.path}"
            }
        }
        require(metadataDigests.keys == blobFiles.mapTo(hashSetOf()) { it.path }) {
            "Verified attachment metadata and blob inventory do not match."
        }
        return metadataDigests.toSortedMap()
    }

    private fun DriveFileRef?.preconditionOrCreate(path: String): DriveWritePrecondition = if (this == null) {
        DriveWritePrecondition.MustNotExist
    } else {
        require(this.path == path) { "Verified Drive path changed during planning." }
        DriveWritePrecondition.MustMatch(id, requirePositiveVersion(path))
    }

    private fun DriveFileRef.requirePositiveVersion(path: String): Long =
        version?.takeIf { it > 0L }
            ?: throw IllegalArgumentException("Verified Drive target has no positive version: $path")

    private fun DriveV1MetadataSnapshot.manifestRecord(accountId: AccountId) = DriveRawDocumentEntity(
        accountId = accountId.value,
        entityKind = "manifest",
        entityId = "manifest",
        path = manifestRef.path,
        driveFileId = manifestRef.id,
        driveVersion = manifestRef.requirePositiveVersion(manifestRef.path),
        driveModifiedAt = manifestRef.updatedAt,
        rawJson = manifestRawJson,
    )

    private fun <T> RemoteRecord<T>.toRawDocument(
        accountId: AccountId,
        entityKind: String,
        entityId: String,
    ) = DriveRawDocumentEntity(
        accountId = accountId.value,
        entityKind = entityKind,
        entityId = entityId,
        path = ref.path,
        driveFileId = ref.id,
        driveVersion = ref.requirePositiveVersion(ref.path),
        driveModifiedAt = ref.updatedAt,
        rawJson = rawJson,
    )

    private data class UntypedRemoteRecord(val rawJson: String, val updatedAt: String)

    private fun DriveV1MetadataSnapshot.liveRecord(kind: String, id: String): UntypedRemoteRecord? = when (kind) {
        "entry" -> entries.singleOrNull { it.value.id == id }?.let { UntypedRemoteRecord(it.rawJson, it.value.updatedAt) }
        "attachment" -> attachments.singleOrNull { it.value.id == id }?.let { UntypedRemoteRecord(it.rawJson, it.value.updatedAt) }
        "fileBoxItem" -> fileBoxItems.singleOrNull { it.value.id == id }?.let { UntypedRemoteRecord(it.rawJson, it.value.updatedAt) }
        "transfer" -> transfers.singleOrNull { it.value.id == id }?.let { UntypedRemoteRecord(it.rawJson, it.value.updatedAt) }
        else -> null
    }

    private fun DriveV1MetadataSnapshot.requireRemoteParent(kind: String, id: String): String? {
        if (tombstones.any { it.value.entityKind == kind && it.value.entityId == id }) {
            return "Remote $kind parent is tombstoned; descendant publication is blocked."
        }
        val exists = when (kind) {
            "entry" -> entries.any { it.value.id == id }
            "attachment" -> attachments.any { it.value.id == id }
            "fileBoxItem" -> fileBoxItems.any { it.value.id == id }
            else -> false
        }
        return if (exists) null else "Verified remote $kind parent is missing; descendant publication is blocked."
    }

    private inline fun <reified T> decodeEnvelope(rawJson: String, kind: String): DriveV1Envelope<T> =
        DriveV1Json.format.decodeFromString<DriveV1Envelope<T>>(rawJson).requireV1(kind)

    private fun <T> remoteState(
        live: T?,
        tombstone: DriveV1Tombstone?,
    ): DriveV1ThreeWayState<T> = when {
        live != null && tombstone != null -> throw IllegalArgumentException(
            "Remote target has both live content and a tombstone after projection.",
        )
        tombstone != null -> DriveV1ThreeWayState.Tombstone(tombstone)
        live != null -> DriveV1ThreeWayState.Present(live)
        else -> DriveV1ThreeWayState.Missing
    }

    private fun sameSemanticValue(kind: String, left: String, right: String): Boolean = when (kind) {
        "entry" -> DriveV1Hashing.entryContentHash(decodeEnvelope<DriveV1Entry>(left, kind).payload) ==
            DriveV1Hashing.entryContentHash(decodeEnvelope<DriveV1Entry>(right, kind).payload)
        "attachment" -> DriveV1Hashing.attachmentMetadataHash(
            decodeEnvelope<DriveV1Attachment>(left, kind).payload,
        ) == DriveV1Hashing.attachmentMetadataHash(decodeEnvelope<DriveV1Attachment>(right, kind).payload)
        "fileBoxItem" -> DriveV1Hashing.fileBoxMetadataHash(
            decodeEnvelope<DriveV1FileBoxItem>(left, kind).payload,
        ) == DriveV1Hashing.fileBoxMetadataHash(decodeEnvelope<DriveV1FileBoxItem>(right, kind).payload)
        "transfer" -> DriveV1Hashing.transferMetadataHash(decodeEnvelope<DriveV1Transfer>(left, kind).payload) ==
            DriveV1Hashing.transferMetadataHash(decodeEnvelope<DriveV1Transfer>(right, kind).payload)
        else -> false
    }

    private companion object {
        val DURABLE_CONTENT_HASH = Regex("^[0-9a-fA-F]{64}$")

        fun contentSha256(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}
