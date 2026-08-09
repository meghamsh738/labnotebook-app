package com.easylab.labnotebook.sync

import androidx.room.withTransaction
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncStateEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveRepository
import java.text.SimpleDateFormat
import java.util.Date
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal data class RemoteRecord<T>(
    val ref: DriveFileRef,
    val value: T,
    val rawJson: String,
    val cacheAsBaseline: Boolean = true,
)

private data class QuarantinedRecordBatch<T>(
    val valid: List<RemoteRecord<T>>,
    val conflicts: List<RemoteRecord<DriveV1Conflict>>,
)

internal data class DriveV1MetadataSnapshot(
    val manifest: DriveV1Manifest,
    val manifestRef: DriveFileRef,
    val manifestRawJson: String,
    val devices: List<RemoteRecord<DriveV1Device>>,
    val entries: List<RemoteRecord<DriveV1Envelope<DriveV1Entry>>>,
    val attachments: List<RemoteRecord<DriveV1Envelope<DriveV1Attachment>>>,
    val fileBoxItems: List<RemoteRecord<DriveV1Envelope<DriveV1FileBoxItem>>>,
    val transfers: List<RemoteRecord<DriveV1Envelope<DriveV1Transfer>>>,
    val conflicts: List<RemoteRecord<DriveV1Conflict>>,
    val tombstones: List<RemoteRecord<DriveV1Tombstone>>,
    /** Complete verified listing, including attachment blob identities and versions. */
    val managedFiles: List<DriveFileRef> = emptyList(),
) {
    val recordCount: Int
        get() = devices.size + entries.size + attachments.size + fileBoxItems.size +
            transfers.size + conflicts.size + tombstones.size
}

internal data class MetadataApplyReport(
    val appliedCount: Int,
    val tombstoneCount: Int,
    val skippedLocalChangeCount: Int,
    val syncedAt: String,
)

internal class DriveV1MetadataReader(private val drive: DriveRepository) {
    suspend fun read(accountId: AccountId): DriveV1MetadataSnapshot {
        val listedRefs = drive.listManagedFiles(accountId).getOrThrow()
            .filter { it.path == DriveV1Paths.manifest || isManagedPath(it.path) }
            .sortedBy { it.path }
        requireUniquePaths(listedRefs)

        // Attachment metadata is stored beside its blob as `<blob path>.json`. A blob can
        // itself be named `*.json`, so suffix and MIME type alone are not safe classifiers.
        // Current web writers label metadata with appProperties; the sibling fallback keeps
        // older complete workspaces readable without ever classifying a labelled blob as JSON.
        val listedPaths = listedRefs.mapTo(hashSetOf()) { it.path }
        val attachmentMetadataPaths = listedRefs.asSequence()
            .filter { it.path.startsWith("attachments/") && it.path.endsWith(".json") }
            .filter { ref ->
                ref.appProperties["entityType"] == "attachment" ||
                    (ref.appProperties["entityType"] != "attachmentBlob" &&
                        ref.path.removeSuffix(".json") in listedPaths)
            }
            .map { it.path }
            .toSet()
        val refs = listedRefs.filter { ref ->
            ref.path == DriveV1Paths.manifest ||
                (isManagedJsonPath(ref.path) &&
                    (!ref.path.startsWith("attachments/") || ref.path in attachmentMetadataPaths))
        }

        val manifestRef = refs.singleOrNull { it.path == DriveV1Paths.manifest }
            ?: throw IllegalArgumentException("Drive workspace manifest.json is missing or duplicated.")
        val manifestRawJson = readRequired(accountId, manifestRef)
        val manifest = DriveV1Json.format.decodeFromString<DriveV1Manifest>(manifestRawJson).requireV1()

        val devices = latestByKey(records(accountId, refs, "devices/") {
            DriveV1Json.format.decodeFromString<DriveV1Device>(it).requireV1()
        }, { it.id }, { it.lastSeenAt })
        val entryBatch = recordsQuarantining(accountId, refs, "entries/", "entry") {
            DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1Entry>>(it).requireV1("entry")
        }
        val allEntries = latestByKey(entryBatch.valid, { it.id }, { it.updatedAt })
        val attachmentBatch = recordsQuarantining(accountId, refs, "attachments/", "attachment") {
            DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(it).requireV1("attachment")
        }
        val allAttachments = latestByKey(attachmentBatch.valid, { it.id }, { it.updatedAt })
        val fileBoxBatch = recordsQuarantining(accountId, refs, "filebox/", "fileBoxItem") {
            DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(it).requireV1("fileBoxItem")
        }
        val allFileBoxItems = latestByKey(fileBoxBatch.valid, { it.id }, { it.updatedAt })
        val transferBatch = recordsQuarantining(accountId, refs, "transfers/", "transfer") {
            DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(it).requireV1("transfer")
        }
        val allTransfers = latestByKey(transferBatch.valid, { it.id }, { it.updatedAt })
        val quarantinedConflicts = entryBatch.conflicts + attachmentBatch.conflicts +
            fileBoxBatch.conflicts + transferBatch.conflicts
        val conflicts = latestByKey(
            records(accountId, refs, "conflicts/") {
                DriveV1Json.format.decodeFromString<DriveV1Conflict>(it).requireV1()
            } + quarantinedConflicts,
            { it.id },
            { it.detectedAt },
        )
        val tombstones = latestTombstonesByTarget(records(accountId, refs, "tombstones/") {
            DriveV1Json.format.decodeFromString<DriveV1Tombstone>(it).requireV1()
        })

        // Web v1 intentionally leaves stale entity files in Drive and applies tombstones to
        // the logical snapshot before writing manifest counts. Mirror that behavior here.
        val deletedEntries = tombstones.targets("entry")
        val directlyDeletedAttachments = tombstones.targets("attachment")
        val directlyDeletedFileBoxItems = tombstones.targets("fileBoxItem")
        val directlyDeletedTransfers = tombstones.targets("transfer")
        val entries = allEntries.filterNot { it.value.id in deletedEntries }
        val attachments = allAttachments.filterNot { record ->
            record.value.id in directlyDeletedAttachments || record.value.payload.entryId in deletedEntries
        }
        val removedAttachmentIds = allAttachments.mapTo(hashSetOf()) { it.value.id }
            .apply { removeAll(attachments.mapTo(hashSetOf()) { it.value.id }) }
        val fileBoxItems = allFileBoxItems.filterNot { record ->
            val item = record.value.payload
            record.value.id in directlyDeletedFileBoxItems ||
                item.entryId in deletedEntries ||
                item.attachmentId in removedAttachmentIds
        }
        val removedFileBoxItemIds = allFileBoxItems.mapTo(hashSetOf()) { it.value.id }
            .apply { removeAll(fileBoxItems.mapTo(hashSetOf()) { it.value.id }) }
        val transfers = allTransfers.filterNot { record ->
            val transfer = record.value.payload
            record.value.id in directlyDeletedTransfers ||
                transfer.entryId in deletedEntries ||
                transfer.attachmentId in removedAttachmentIds ||
                transfer.fileBoxItemId in removedFileBoxItemIds
        }

        val observedEntryCount = entries.size + entryBatch.conflicts.size
        val observedAttachmentCount = attachments.size + attachmentBatch.conflicts.size
        val observedFileBoxCount = fileBoxItems.size + fileBoxBatch.conflicts.size
        val observedTransferCount = transfers.size + transferBatch.conflicts.size
        require(manifest.entryCount == observedEntryCount) {
            "Drive manifest expected ${manifest.entryCount} entries but found $observedEntryCount."
        }
        require(manifest.attachmentCount == observedAttachmentCount) {
            "Drive manifest expected ${manifest.attachmentCount} attachments but found $observedAttachmentCount."
        }
        require(manifest.fileBoxCount == observedFileBoxCount) {
            "Drive manifest expected ${manifest.fileBoxCount} File Box items but found $observedFileBoxCount."
        }
        require(manifest.transferCount == observedTransferCount) {
            "Drive manifest expected ${manifest.transferCount} transfers but found $observedTransferCount."
        }

        return DriveV1MetadataSnapshot(
            manifest = manifest,
            manifestRef = manifestRef,
            manifestRawJson = manifestRawJson,
            devices = devices,
            entries = entries,
            attachments = attachments,
            fileBoxItems = fileBoxItems,
            transfers = transfers,
            conflicts = conflicts,
            tombstones = tombstones,
            managedFiles = listedRefs,
        )
    }

    private suspend fun readRequired(accountId: AccountId, ref: DriveFileRef): String {
        return drive.readJson(accountId, ref.path).getOrThrow()
            ?: throw IllegalArgumentException("Managed Drive file ${ref.path} disappeared during metadata pull.")
    }

    private suspend fun <T> records(
        accountId: AccountId,
        refs: List<DriveFileRef>,
        prefix: String,
        decode: (String) -> T,
    ): List<RemoteRecord<T>> = buildList {
        refs.filter { it.path.startsWith(prefix) && it.path.endsWith(".json") }.forEach { ref ->
            val raw = drive.readJson(accountId, ref.path).getOrThrow()
                ?: throw IllegalArgumentException("Managed Drive file ${ref.path} disappeared during metadata pull.")
            add(RemoteRecord(ref, decode(raw), raw))
        }
    }

    private suspend fun <T> recordsQuarantining(
        accountId: AccountId,
        refs: List<DriveFileRef>,
        prefix: String,
        entityKind: String,
        decode: (String) -> T,
    ): QuarantinedRecordBatch<T> {
        val valid = mutableListOf<RemoteRecord<T>>()
        val conflicts = mutableListOf<RemoteRecord<DriveV1Conflict>>()
        refs.filter { it.path.startsWith(prefix) && it.path.endsWith(".json") }.forEach { ref ->
            val raw = drive.readJson(accountId, ref.path).getOrThrow()
                ?: throw IllegalArgumentException("Managed Drive file ${ref.path} disappeared during metadata pull.")
            try {
                valid += RemoteRecord(ref, decode(raw), raw)
            } catch (error: SerializationException) {
                conflicts += quarantinedConflict(ref, entityKind, raw, error)
            } catch (error: IllegalArgumentException) {
                conflicts += quarantinedConflict(ref, entityKind, raw, error)
            }
        }
        return QuarantinedRecordBatch(valid, conflicts)
    }

    private fun quarantinedConflict(
        ref: DriveFileRef,
        entityKind: String,
        rawJson: String,
        error: Exception,
    ): RemoteRecord<DriveV1Conflict> {
        val conflict = DriveV1Conflict(
            id = "conf-invalid-$entityKind-${ref.path}",
            entityKind = entityKind,
            entityId = ref.path,
            localUpdatedAt = ref.updatedAt,
            remoteUpdatedAt = ref.updatedAt,
            detectedAt = ref.updatedAt,
            resolution = "pending",
            summary = "Remote $entityKind JSON was quarantined and not applied.",
            remoteCopy = buildJsonObject {
                put("path", ref.path)
                put("rawJson", rawJson)
                put("error", error.message ?: "Invalid Drive v1 JSON.")
            },
        ).requireV1()
        return RemoteRecord(ref, conflict, rawJson, cacheAsBaseline = false)
    }

    private fun isManagedPath(path: String): Boolean = MANAGED_PREFIXES.any(path::startsWith)

    private fun isManagedJsonPath(path: String): Boolean = isManagedPath(path) && path.endsWith(".json")

    private fun List<RemoteRecord<DriveV1Tombstone>>.targets(kind: String): Set<String> =
        asSequence().map { it.value }.filter { it.entityKind == kind }.mapTo(hashSetOf()) { it.entityId }

    private fun requireUniquePaths(refs: List<DriveFileRef>) {
        val duplicates = refs.groupingBy { it.path }.eachCount().filterValues { it > 1 }.keys
        require(duplicates.isEmpty()) { "Drive workspace contains duplicate managed paths: ${duplicates.sorted().joinToString()}." }
    }

    private fun <T> latestByKey(
        records: List<RemoteRecord<T>>,
        key: (T) -> String,
        updatedAt: (T) -> String,
    ): List<RemoteRecord<T>> = records.fold(linkedMapOf<String, RemoteRecord<T>>()) { latest, record ->
        val recordKey = key(record.value)
        val previous = latest[recordKey]
        if (previous == null) {
            latest[recordKey] = record
        } else {
            val comparison = compareIsoTimestamps(updatedAt(record.value), updatedAt(previous.value))
            when {
                comparison > 0 -> latest[recordKey] = record
                comparison == 0 && record.value != previous.value -> throw IllegalArgumentException(
                    "Drive workspace contains conflicting records for $recordKey at ${updatedAt(record.value)}.",
                )
            }
        }
        latest
    }.values.sortedBy { it.ref.path }

    private fun latestTombstonesByTarget(
        records: List<RemoteRecord<DriveV1Tombstone>>,
    ): List<RemoteRecord<DriveV1Tombstone>> =
        records.fold(linkedMapOf<String, RemoteRecord<DriveV1Tombstone>>()) { latest, record ->
            val value = record.value
            val key = "${value.entityKind}\u0000${value.entityId}"
            val previous = latest[key]
            if (previous == null) {
                latest[key] = record
            } else {
                val comparison = compareIsoTimestamps(value.deletedAt, previous.value.deletedAt)
                when {
                    comparison > 0 -> latest[key] = record
                    comparison == 0 -> require(
                        value.deletedByDeviceId == previous.value.deletedByDeviceId &&
                            value.reason == previous.value.reason,
                    ) {
                        "Drive workspace contains conflicting tombstones for $key at ${value.deletedAt}."
                    }
                }
            }
            latest
        }.values.sortedBy { it.ref.path }

    companion object {
        private val MANAGED_PREFIXES = listOf(
            "devices/",
            "entries/",
            "attachments/",
            "filebox/",
            "transfers/",
            "conflicts/",
            "tombstones/",
        )
    }
}

private data class IsoInstantKey(val epochSecond: Long, val fractionalSecond: String)

private val metadataIsoTimestamp = Regex(
    """^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$""",
)

internal fun compareIsoTimestamps(left: String, right: String): Int {
    val leftKey = isoInstantKey(left)
    val rightKey = isoInstantKey(right)
    val seconds = leftKey.epochSecond.compareTo(rightKey.epochSecond)
    if (seconds != 0) return seconds
    val width = maxOf(leftKey.fractionalSecond.length, rightKey.fractionalSecond.length)
    return leftKey.fractionalSecond.padEnd(width, '0')
        .compareTo(rightKey.fractionalSecond.padEnd(width, '0'))
}

private fun isoInstantKey(value: String): IsoInstantKey {
    val match = metadataIsoTimestamp.matchEntire(value)
        ?: throw IllegalArgumentException("Timestamp $value is not a valid Drive v1 timestamp.")
    val groups = match.groupValues
    val calendar = GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.ROOT).apply {
        isLenient = false
        clear()
        set(
            groups[1].toInt(),
            groups[2].toInt() - 1,
            groups[3].toInt(),
            groups[4].toInt(),
            groups[5].toInt(),
            groups[6].toInt(),
        )
    }
    val offsetSeconds = if (groups[8].isEmpty()) {
        0
    } else {
        val seconds = groups[9].toInt() * 3_600 + groups[10].toInt() * 60
        if (groups[8] == "-") -seconds else seconds
    }
    return IsoInstantKey(
        epochSecond = calendar.timeInMillis / 1_000 - offsetSeconds,
        fractionalSecond = groups[7].trimEnd('0'),
    )
}

internal class DriveV1MetadataApplier(
    private val database: LabNotebookDatabase,
    private val now: () -> String = ::metadataNowIso,
) {
    suspend fun apply(accountId: AccountId, snapshot: DriveV1MetadataSnapshot): MetadataApplyReport =
        database.withTransaction {
            val dao = database.dao()
            val pending = dao.pendingQueue(accountId.value)
            val pendingTargets = pending
                .mapTo(mutableSetOf()) { it.entityKind to it.entityId }
            val pendingUpserts = pending.asSequence()
                .filter { it.operation == "upsert" }
                .map { it.entityKind to it.entityId }
                .toSet()
            val tombstonedTargets = dao.tombstones(accountId.value)
                .mapTo(mutableSetOf()) { it.entityKind to it.entityId }
            tombstonedTargets += snapshot.tombstones.map { it.value.entityKind to it.value.entityId }
            validateParentTombstones(
                dao = dao,
                accountId = accountId,
                snapshot = snapshot,
                pendingUpserts = pendingUpserts,
            )
            validateRemoteGraph(snapshot)
            cacheRemoteDocuments(dao, accountId, snapshot, pendingTargets)
            var applied = 0
            var skipped = 0

            snapshot.tombstones.sortedBy { tombstoneDeleteOrder(it.value.entityKind) }.forEach { record ->
                val value = record.value
                upsertTombstoneByTarget(dao, accountId, value, pendingUpserts)
                applied += 1
                val key = value.entityKind to value.entityId
                if (key in pendingUpserts) {
                    skipped += 1
                }
            }

            fun shouldApply(kind: String, id: String): Boolean {
                val key = kind to id
                if (key in pendingUpserts || key in tombstonedTargets) {
                    skipped += 1
                    return false
                }
                return true
            }

            fun hasTombstonedParent(
                entryId: String? = null,
                attachmentId: String? = null,
                fileBoxItemId: String? = null,
            ): Boolean =
                (entryId != null && ("entry" to entryId) in tombstonedTargets) ||
                    (attachmentId != null && ("attachment" to attachmentId) in tombstonedTargets) ||
                    (fileBoxItemId != null && ("fileBoxItem" to fileBoxItemId) in tombstonedTargets)

            val deviceRecords = LinkedHashMap<String, DriveV1Device>()
            snapshot.manifest.devices.forEach { deviceRecords[it.id] = it }
            snapshot.devices.forEach { deviceRecords[it.value.id] = it.value }
            deviceRecords.values.forEach { value ->
                if (shouldApply("device", value.id)) {
                    dao.upsertDevice(value.toEntity(accountId))
                    applied += 1
                }
            }
            snapshot.entries.forEach { record ->
                val value = record.value
                if (shouldApply("entry", value.id)) {
                    dao.upsertEntry(value.toEntity(accountId, record.ref.path))
                    applied += 1
                }
            }
            snapshot.attachments.forEach { record ->
                val value = record.value
                if (hasTombstonedParent(entryId = value.payload.entryId)) {
                    skipped += 1
                } else if (shouldApply("attachment", value.id)) {
                    val existing = dao.attachment(accountId.value, value.id)
                    dao.upsertAttachment(value.toEntity(accountId, existing))
                    applied += 1
                }
            }
            snapshot.fileBoxItems.forEach { record ->
                val value = record.value
                if (hasTombstonedParent(
                        entryId = value.payload.entryId,
                        attachmentId = value.payload.attachmentId,
                    )
                ) {
                    skipped += 1
                } else if (shouldApply("fileBoxItem", value.id)) {
                    dao.upsertFileBoxItem(value.toEntity(accountId))
                    applied += 1
                }
            }
            snapshot.transfers.forEach { record ->
                val value = record.value
                if (hasTombstonedParent(
                        entryId = value.payload.entryId,
                        attachmentId = value.payload.attachmentId,
                        fileBoxItemId = value.payload.fileBoxItemId,
                    )
                ) {
                    skipped += 1
                } else if (shouldApply("transfer", value.id)) {
                    dao.upsertTransfer(value.toEntity(accountId))
                    applied += 1
                }
            }
            snapshot.conflicts.forEach { record ->
                dao.upsertConflict(record.value.toEntity(accountId))
                applied += 1
            }

            val syncedAt = now()
            val previousState = dao.syncState(accountId.value)
            dao.upsertSyncState(
                SyncStateEntity(
                    accountId = accountId.value,
                    lastAttemptAt = syncedAt,
                    lastSyncedAt = syncedAt,
                    lastMessage = if (skipped == 0) {
                        "Drive metadata is up to date. Native writes remain disabled."
                    } else {
                        "$skipped remote record(s) were held back to protect local changes."
                    },
                    changeToken = previousState?.changeToken,
                    updatedAt = syncedAt,
                    queueCount = pending.size,
                    valueJson = previousState?.valueJson,
                ),
            )
            MetadataApplyReport(
                appliedCount = applied,
                tombstoneCount = snapshot.tombstones.size,
                skippedLocalChangeCount = skipped,
                syncedAt = syncedAt,
            )
        }

    private suspend fun cacheRemoteDocuments(
        dao: com.easylab.labnotebook.data.local.LabNotebookDao,
        accountId: AccountId,
        snapshot: DriveV1MetadataSnapshot,
        pendingTargets: Set<Pair<String, String>>,
    ) {
        dao.upsertDriveRawDocument(
            DriveRawDocumentEntity(
                accountId = accountId.value,
                entityKind = "manifest",
                entityId = "manifest",
                path = snapshot.manifestRef.path,
                driveFileId = snapshot.manifestRef.id,
                driveVersion = snapshot.manifestRef.version?.takeIf { it > 0L },
                driveModifiedAt = snapshot.manifestRef.updatedAt,
                rawJson = snapshot.manifestRawJson,
            ),
        )
        snapshot.devices.forEach {
            if (("device" to it.value.id) !in pendingTargets) {
                dao.upsertDriveRawDocument(it.toRawDocument(accountId, "device", it.value.id))
            }
        }
        snapshot.entries.forEach {
            if (("entry" to it.value.id) !in pendingTargets) {
                dao.upsertDriveRawDocument(it.toRawDocument(accountId, "entry", it.value.id))
            }
        }
        snapshot.attachments.forEach {
            if (("attachment" to it.value.id) !in pendingTargets) {
                dao.upsertDriveRawDocument(it.toRawDocument(accountId, "attachment", it.value.id))
            }
        }
        snapshot.fileBoxItems.forEach {
            if (("fileBoxItem" to it.value.id) !in pendingTargets) {
                dao.upsertDriveRawDocument(it.toRawDocument(accountId, "fileBoxItem", it.value.id))
            }
        }
        snapshot.transfers.forEach {
            if (("transfer" to it.value.id) !in pendingTargets) {
                dao.upsertDriveRawDocument(it.toRawDocument(accountId, "transfer", it.value.id))
            }
        }
        snapshot.conflicts.forEach {
            if (it.cacheAsBaseline) {
                dao.upsertDriveRawDocument(it.toRawDocument(accountId, "conflict", it.value.id))
            }
        }
        snapshot.tombstones.forEach {
            val target = it.value.entityKind to it.value.entityId
            if (target !in pendingTargets) {
                val existingId = dao.tombstone(
                    accountId.value,
                    it.value.entityKind,
                    it.value.entityId,
                )?.id
                val baselineRecord = if (existingId != null && existingId != it.value.id) {
                    val lossless = DriveV1Json.decodeLossless<DriveV1Tombstone>(it.rawJson)
                    lossless.value = lossless.value.copy(id = existingId).requireV1()
                    it.copy(rawJson = lossless.encodePreservingUnknownFields())
                } else {
                    it
                }
                dao.upsertDriveRawDocument(
                    baselineRecord.toRawDocument(accountId, "tombstone", existingId ?: it.value.id),
                )
            }
        }
    }

    private suspend fun validateParentTombstones(
        dao: com.easylab.labnotebook.data.local.LabNotebookDao,
        accountId: AccountId,
        snapshot: DriveV1MetadataSnapshot,
        pendingUpserts: Set<Pair<String, String>>,
    ) {
        snapshot.tombstones.forEach { record ->
            val tombstone = record.value
            if (tombstone.entityKind !in setOf("entry", "attachment", "fileBoxItem")) return@forEach
            val dependents = localDependentKeys(dao, accountId, tombstone) +
                remoteDependentKeys(snapshot, tombstone)
            val pendingDependents = dependents.intersect(pendingUpserts)
            require(pendingDependents.isEmpty()) {
                "Remote ${tombstone.entityKind} deletion conflicts with pending local child changes: " +
                    pendingDependents.sortedBy { "${it.first}/${it.second}" }.joinToString { "${it.first}/${it.second}" } + "."
            }
        }
    }

    private fun validateRemoteGraph(snapshot: DriveV1MetadataSnapshot) {
        val entryIds = snapshot.entries.mapTo(hashSetOf()) { it.value.id }
        val attachmentIds = snapshot.attachments.mapTo(hashSetOf()) { it.value.id }
        val fileBoxItemIds = snapshot.fileBoxItems.mapTo(hashSetOf()) { it.value.id }

        snapshot.attachments.forEach { record ->
            require(record.value.payload.entryId in entryIds) {
                "Remote attachment ${record.value.id} references missing entry ${record.value.payload.entryId}."
            }
        }
        snapshot.fileBoxItems.forEach { record ->
            val item = record.value.payload
            require(item.entryId in entryIds) {
                "Remote File Box item ${record.value.id} references missing entry ${item.entryId}."
            }
            require(item.attachmentId == null || item.attachmentId in attachmentIds) {
                "Remote File Box item ${record.value.id} references missing attachment ${item.attachmentId}."
            }
        }
        snapshot.transfers.forEach { record ->
            val transfer = record.value.payload
            require(transfer.entryId == null || transfer.entryId in entryIds) {
                "Remote transfer ${record.value.id} references missing entry ${transfer.entryId}."
            }
            require(transfer.attachmentId == null || transfer.attachmentId in attachmentIds) {
                "Remote transfer ${record.value.id} references missing attachment ${transfer.attachmentId}."
            }
            require(transfer.fileBoxItemId == null || transfer.fileBoxItemId in fileBoxItemIds) {
                "Remote transfer ${record.value.id} references missing File Box item ${transfer.fileBoxItemId}."
            }
        }
    }

    private suspend fun localDependentKeys(
        dao: com.easylab.labnotebook.data.local.LabNotebookDao,
        accountId: AccountId,
        tombstone: DriveV1Tombstone,
    ): Set<Pair<String, String>> {
        val attachments = when (tombstone.entityKind) {
            "entry" -> dao.attachmentsForEntry(accountId.value, tombstone.entityId)
            else -> emptyList()
        }
        val attachmentIds = attachments.mapTo(hashSetOf()) { it.id }
        val fileBoxItems = dao.fileBoxItems(accountId.value).filter { item ->
            when (tombstone.entityKind) {
                "entry" -> item.entryId == tombstone.entityId || item.attachmentId in attachmentIds
                "attachment" -> item.attachmentId == tombstone.entityId
                else -> false
            }
        }
        val fileBoxIds = fileBoxItems.mapTo(hashSetOf()) { it.id }
        val transfers = dao.transfers(accountId.value).filter { transfer ->
            when (tombstone.entityKind) {
                "entry" -> transfer.entryId == tombstone.entityId ||
                    transfer.attachmentId in attachmentIds || transfer.fileBoxItemId in fileBoxIds
                "attachment" -> transfer.attachmentId == tombstone.entityId || transfer.fileBoxItemId in fileBoxIds
                "fileBoxItem" -> transfer.fileBoxItemId == tombstone.entityId
                else -> false
            }
        }
        return buildSet {
            attachments.forEach { add("attachment" to it.id) }
            fileBoxItems.forEach { add("fileBoxItem" to it.id) }
            transfers.forEach { add("transfer" to it.id) }
        }
    }

    private fun remoteDependentKeys(
        snapshot: DriveV1MetadataSnapshot,
        tombstone: DriveV1Tombstone,
    ): Set<Pair<String, String>> {
        val attachments = snapshot.attachments.map { it.value.payload }.filter { attachment ->
            tombstone.entityKind == "entry" && attachment.entryId == tombstone.entityId
        }
        val attachmentIds = attachments.mapTo(hashSetOf()) { it.id }
        val fileBoxItems = snapshot.fileBoxItems.map { it.value.payload }.filter { item ->
            when (tombstone.entityKind) {
                "entry" -> item.entryId == tombstone.entityId || item.attachmentId in attachmentIds
                "attachment" -> item.attachmentId == tombstone.entityId
                else -> false
            }
        }
        val fileBoxIds = fileBoxItems.mapTo(hashSetOf()) { it.id }
        val transfers = snapshot.transfers.map { it.value.payload }.filter { transfer ->
            when (tombstone.entityKind) {
                "entry" -> transfer.entryId == tombstone.entityId ||
                    transfer.attachmentId in attachmentIds || transfer.fileBoxItemId in fileBoxIds
                "attachment" -> transfer.attachmentId == tombstone.entityId || transfer.fileBoxItemId in fileBoxIds
                "fileBoxItem" -> transfer.fileBoxItemId == tombstone.entityId
                else -> false
            }
        }
        return buildSet {
            attachments.forEach { add("attachment" to it.id) }
            fileBoxItems.forEach { add("fileBoxItem" to it.id) }
            transfers.forEach { add("transfer" to it.id) }
        }
    }

    private fun tombstoneDeleteOrder(entityKind: String): Int = when (entityKind) {
        "transfer" -> 0
        "fileBoxItem" -> 1
        "attachment" -> 2
        "entry" -> 3
        "device" -> 4
        "tombstone" -> 5
        else -> 6
    }

    private suspend fun upsertTombstoneByTarget(
        dao: com.easylab.labnotebook.data.local.LabNotebookDao,
        accountId: AccountId,
        incoming: DriveV1Tombstone,
        pendingUpserts: Set<Pair<String, String>>,
    ) {
        val existing = dao.tombstone(accountId.value, incoming.entityKind, incoming.entityId)
        if (existing == null) {
            dao.upsertTombstone(incoming.toEntity(accountId))
            return
        }
        if (("tombstone" to existing.id) in pendingUpserts) return

        when (compareIsoTimestamps(incoming.deletedAt, existing.deletedAt)) {
            in Int.MIN_VALUE until 0 -> Unit
            0 -> require(
                existing.deletedByDeviceId == incoming.deletedByDeviceId && existing.reason == incoming.reason,
            ) {
                "Local and remote tombstones disagree for ${incoming.entityKind}/${incoming.entityId} at ${incoming.deletedAt}."
            }
            else -> dao.upsertTombstone(incoming.toEntity(accountId).copy(id = existing.id))
        }
    }
}

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
    driveVersion = ref.version?.takeIf { it > 0L },
    driveModifiedAt = ref.updatedAt,
    rawJson = rawJson,
)

private fun DriveV1Device.toEntity(accountId: AccountId) = DeviceEntity(
    accountId = accountId.value,
    id = id,
    name = name,
    platform = platform,
    createdAt = createdAt,
    lastSeenAt = lastSeenAt,
    userAgent = userAgent,
    appVersion = appVersion,
)

private fun DriveV1Envelope<DriveV1Entry>.toEntity(accountId: AccountId, remotePath: String): JournalEntryEntity {
    val entry = payload
    return JournalEntryEntity(
        accountId = accountId.value,
        id = entry.id,
        title = entry.title,
        dateBucket = entry.dateBucket,
        createdAt = entry.createdDatetime,
        updatedAt = updatedAt,
        authorId = entry.authorId,
        contentJson = DriveV1Json.format.encodeToString(entry.content),
        tagsJson = DriveV1Json.format.encodeToString(entry.tags),
        version = entry.version ?: 1,
        updatedByDeviceId = updatedByDeviceId,
        syncStatus = entry.syncStatus ?: "synced",
        experimentId = entry.experimentId,
        projectId = entry.projectId,
        isDaily = entry.isDaily,
        projectTagsJson = DriveV1Json.format.encodeToString(entry.projectTags.orEmpty()),
        experimentTagsJson = DriveV1Json.format.encodeToString(entry.experimentTags.orEmpty()),
        searchTermsJson = DriveV1Json.format.encodeToString(entry.searchTerms),
        linkedFilesJson = DriveV1Json.format.encodeToString(entry.linkedFiles),
        pinnedRegionsJson = DriveV1Json.format.encodeToString(entry.pinnedRegions),
        syncPath = entry.syncPath ?: remotePath,
        source = entry.source,
        whatsappCapturesJson = DriveV1Json.format.encodeToString(entry.whatsappCaptures.orEmpty()),
        telegramCapturesJson = DriveV1Json.format.encodeToString(entry.telegramCaptures.orEmpty()),
    )
}

private fun DriveV1Envelope<DriveV1Attachment>.toEntity(
    accountId: AccountId,
    existing: AttachmentEntity?,
): AttachmentEntity {
    val attachment = payload
    val hasLocalCache = existing?.cachedPath != null || existing?.localUri != null
    val cacheMatchesRemote = hasLocalCache &&
        existing?.sha256 != null &&
        attachment.sha256 != null &&
        existing.sha256.equals(attachment.sha256, ignoreCase = true)
    return AttachmentEntity(
        accountId = accountId.value,
        id = attachment.id,
        entryId = attachment.entryId,
        type = attachment.type,
        filename = attachment.filename,
        displaySize = attachment.filesize,
        byteSize = attachment.bytes,
        storagePath = attachment.storagePath,
        mimeType = attachment.mimeType,
        sha256 = attachment.sha256,
        localUri = existing?.localUri.takeIf { cacheMatchesRemote },
        driveFileId = attachment.driveFileId,
        pinnedOffline = existing?.pinnedOffline == true || attachment.pinnedOffline == true,
        syncStatus = if (cacheMatchesRemote) {
            existing?.syncStatus?.takeIf { it in setOf("local", "queued", "syncing", "failed", "conflict") }
                ?: "synced"
        } else {
            attachment.syncStatus?.takeIf { it in setOf("queued", "syncing", "failed", "conflict") }
                ?: "remote-available"
        },
        createdAt = attachment.createdAt ?: updatedAt,
        updatedAt = attachment.updatedAt ?: updatedAt,
        thumbnail = attachment.thumbnail,
        linkedRegionId = attachment.linkedRegionId,
        tag = attachment.tag,
        sampleId = attachment.sampleId,
        cachedPath = existing?.cachedPath.takeIf { cacheMatchesRemote },
        source = attachment.source,
        sourceMessageId = attachment.sourceMessageId,
        sourceMediaId = attachment.sourceMediaId,
        contentType = attachment.contentType,
        cacheKey = attachment.cacheKey,
    )
}

private fun DriveV1Envelope<DriveV1FileBoxItem>.toEntity(accountId: AccountId): FileBoxItemEntity =
    FileBoxItemEntity(
        accountId = accountId.value,
        id = payload.id,
        entryId = payload.entryId,
        attachmentId = payload.attachmentId,
        filename = payload.filename,
        filesize = payload.filesize,
        contentType = payload.contentType,
        sourceDeviceId = payload.sourceDeviceId,
        sourceDeviceName = payload.sourceDeviceName,
        status = payload.status,
        createdAt = payload.createdAt,
        updatedAt = payload.updatedAt,
        driveFileId = payload.driveFileId,
        localObjectUrl = null,
        lastError = payload.lastError,
    )

private fun DriveV1Envelope<DriveV1Transfer>.toEntity(accountId: AccountId): TransferEntity = TransferEntity(
    accountId = accountId.value,
    id = payload.id,
    fileBoxItemId = payload.fileBoxItemId,
    entryId = payload.entryId,
    attachmentId = payload.attachmentId,
    filename = payload.filename,
    fromDeviceId = payload.fromDeviceId,
    fromDeviceName = payload.fromDeviceName,
    toDeviceId = payload.toDeviceId,
    toDeviceName = payload.toDeviceName,
    provider = payload.provider,
    status = payload.status,
    bytesTotal = payload.bytesTotal,
    bytesTransferred = payload.bytesTransferred,
    createdAt = payload.createdAt,
    updatedAt = payload.updatedAt,
    completedAt = payload.completedAt,
    driveFileId = payload.driveFileId,
    lastError = payload.lastError,
)

private fun DriveV1Conflict.toEntity(accountId: AccountId) = ConflictEntity(
    accountId = accountId.value,
    id = id,
    entityKind = entityKind,
    entityId = entityId,
    localUpdatedAt = localUpdatedAt,
    remoteUpdatedAt = remoteUpdatedAt,
    detectedAt = detectedAt,
    resolution = resolution,
    summary = summary,
    localCopyJson = localCopy?.toString(),
    remoteCopyJson = remoteCopy?.toString(),
)

private fun DriveV1Tombstone.toEntity(accountId: AccountId) = TombstoneEntity(
    accountId = accountId.value,
    id = id,
    entityKind = entityKind,
    entityId = entityId,
    deletedAt = deletedAt,
    deletedByDeviceId = deletedByDeviceId,
    reason = reason,
)

private fun metadataNowIso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date())
