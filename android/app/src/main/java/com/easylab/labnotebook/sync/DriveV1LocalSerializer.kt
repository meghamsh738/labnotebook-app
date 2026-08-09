package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement

internal data class DriveV1SerializedDocument(
    val accountId: String,
    val entityKind: String,
    val entityId: String,
    val path: String,
    val json: String,
    val attachmentBlobPath: String? = null,
)

internal class DriveV1NewEntryPathSelection private constructor(
    val entityId: String,
    val dateBucket: String,
    val sameDayEntityIds: Set<String>,
    val targetPath: String,
) {
    companion object {
        fun fromCompleteSameDayInventory(
            entityId: String,
            dateBucket: String,
            sameDayEntityIds: Collection<String>,
        ): DriveV1NewEntryPathSelection {
            val normalizedIds = sameDayEntityIds.toSet()
            require(entityId in normalizedIds) {
                "The complete same-day inventory must contain the new entry."
            }
            val targetPath = if (normalizedIds.size == 1) {
                DriveV1Paths.entry(dateBucket)
            } else {
                DriveV1Paths.entry(dateBucket, entityId)
            }
            return DriveV1NewEntryPathSelection(
                entityId = entityId,
                dateBucket = dateBucket,
                sameDayEntityIds = normalizedIds,
                targetPath = targetPath,
            )
        }
    }
}

internal data class DriveV1ManifestInventory(
    val devices: Collection<DeviceEntity>,
    val entries: Collection<JournalEntryEntity>,
    val attachments: Collection<AttachmentEntity>,
    val fileBoxItems: Collection<FileBoxItemEntity>,
    val transfers: Collection<TransferEntity>,
)

internal data class DriveV1ManifestProjection(
    val devices: Collection<DriveV1Device>,
    val entryCount: Int,
    val attachmentCount: Int,
    val fileBoxCount: Int,
    val transferCount: Int,
) {
    init {
        require(listOf(entryCount, attachmentCount, fileBoxCount, transferCount).all { it >= 0 }) {
            "Projected Drive manifest counts must be non-negative."
        }
        devices.forEach { it.requireV1() }
        require(devices.map { it.id }.toSet().size == devices.size) {
            "Projected Drive manifest device ids must be unique."
        }
    }
}

/**
 * Pure Room-to-Drive v1 serialization. This class does not perform I/O and is intentionally
 * independent from the production sync wiring until write parity is proven.
 */
internal object DriveV1LocalSerializer {
    fun serializeEntry(
        accountId: AccountId,
        entity: JournalEntryEntity,
        queue: SyncQueueEntity,
        targetPath: String,
        rawBaseline: DriveRawDocumentEntity? = null,
        newEntryPathSelection: DriveV1NewEntryPathSelection? = null,
    ): DriveV1SerializedDocument {
        requireAccount(accountId, entity.accountId)
        requireQueue(accountId, queue, "entry", entity.id, "upsert")
        require(queue.updatedAt == entity.updatedAt) { "Entry queue timestamp must match the entry update." }
        require(queue.updatedByDeviceId == entity.updatedByDeviceId) {
            "Entry queue device must match the entry update device."
        }
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Envelope<DriveV1Entry>>(accountId, "entry", entity.id, it)
        }
        requireEntryVersionContract(entity, queue, original)
        validatePath("entry", targetPath)
        if (rawBaseline == null) {
            val selection = requireNotNull(newEntryPathSelection) {
                "A new entry requires a path selected from a complete same-day inventory."
            }
            require(selection.entityId == entity.id && selection.dateBucket == entity.dateBucket) {
                "The new-entry path selection does not match the serialized entry."
            }
            require(targetPath == selection.targetPath) {
                "A new entry must use its complete-inventory canonical Drive path."
            }
        } else {
            require(newEntryPathSelection == null) {
                "An existing entry must preserve its verified baseline path."
            }
        }
        val entry = entity.toDriveV1(original?.value?.payload, targetPath).requireV1()
        val envelope = DriveV1Envelope(
            id = entity.id,
            kind = "entry",
            updatedAt = queue.updatedAt,
            updatedByDeviceId = queue.updatedByDeviceId,
            payload = entry,
        ).requireV1("entry")
        require(rawBaseline == null || targetPath == rawBaseline.path) {
            "An existing entry must retain its verified Drive path."
        }
        return serialized(accountId, "entry", entity.id, targetPath, encode(envelope, original))
    }

    fun serializeAttachment(
        accountId: AccountId,
        entity: AttachmentEntity,
        parentEntry: JournalEntryEntity,
        queue: SyncQueueEntity,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        requireAccount(accountId, entity.accountId)
        requireAccount(accountId, parentEntry.accountId)
        require(entity.entryId == parentEntry.id) { "Attachment parent entry does not match." }
        requireQueue(accountId, queue, "attachment", entity.id, "upsert")
        require(queue.updatedAt == entity.updatedAt) { "Attachment queue timestamp must match the attachment update." }

        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Envelope<DriveV1Attachment>>(accountId, "attachment", entity.id, it)
        }
        val blobPath = rawBaseline?.path?.removeSuffix(".json")
            ?: DriveV1Paths.attachmentBlob(parentEntry.dateBucket, entity.id, entity.filename)
        validatePath("attachment", "$blobPath.json")
        val attachment = entity.toDriveV1(original?.value?.payload, blobPath).requireV1()
        val envelope = DriveV1Envelope(
            id = entity.id,
            kind = "attachment",
            updatedAt = queue.updatedAt,
            updatedByDeviceId = queue.updatedByDeviceId,
            payload = attachment,
        ).requireV1("attachment")
        val metadataPath = "$blobPath.json"
        return serialized(
            accountId = accountId,
            entityKind = "attachment",
            entityId = entity.id,
            path = metadataPath,
            json = encode(envelope, original),
            attachmentBlobPath = blobPath,
        )
    }

    fun serializeFileBoxItem(
        accountId: AccountId,
        entity: FileBoxItemEntity,
        queue: SyncQueueEntity,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        requireAccount(accountId, entity.accountId)
        requireQueue(accountId, queue, "fileBoxItem", entity.id, "upsert")
        require(queue.updatedAt == entity.updatedAt) { "File Box queue timestamp must match the item update." }
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Envelope<DriveV1FileBoxItem>>(accountId, "fileBoxItem", entity.id, it)
        }
        val envelope = DriveV1Envelope(
            id = entity.id,
            kind = "fileBoxItem",
            updatedAt = queue.updatedAt,
            updatedByDeviceId = queue.updatedByDeviceId,
            payload = entity.toDriveV1().requireV1(),
        ).requireV1("fileBoxItem")
        val path = rawBaseline?.path ?: DriveV1Paths.fileBox(entity.id)
        validatePath("fileBoxItem", path)
        return serialized(accountId, "fileBoxItem", entity.id, path, encode(envelope, original))
    }

    fun serializeTransfer(
        accountId: AccountId,
        entity: TransferEntity,
        queue: SyncQueueEntity,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        requireAccount(accountId, entity.accountId)
        requireQueue(accountId, queue, "transfer", entity.id, "upsert")
        require(queue.updatedAt == entity.updatedAt) { "Transfer queue timestamp must match the transfer update." }
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Envelope<DriveV1Transfer>>(accountId, "transfer", entity.id, it)
        }
        val envelope = DriveV1Envelope(
            id = entity.id,
            kind = "transfer",
            updatedAt = queue.updatedAt,
            updatedByDeviceId = queue.updatedByDeviceId,
            payload = entity.toDriveV1().requireV1(),
        ).requireV1("transfer")
        val path = rawBaseline?.path ?: DriveV1Paths.transfer(entity.id)
        validatePath("transfer", path)
        return serialized(accountId, "transfer", entity.id, path, encode(envelope, original))
    }

    fun serializeDevice(
        accountId: AccountId,
        entity: DeviceEntity,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        requireAccount(accountId, entity.accountId)
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Device>(accountId, "device", entity.id, it)
        }
        val value = entity.toDriveV1().requireV1()
        val path = rawBaseline?.path ?: DriveV1Paths.device(entity.id)
        validatePath("device", path)
        return serialized(accountId, "device", entity.id, path, encode(value, original))
    }

    fun serializeConflict(
        accountId: AccountId,
        entity: ConflictEntity,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        requireAccount(accountId, entity.accountId)
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Conflict>(accountId, "conflict", entity.id, it)
        }
        val value = entity.toDriveV1().requireV1()
        val path = rawBaseline?.path ?: DriveV1Paths.conflict(entity.id)
        validatePath("conflict", path)
        return serialized(accountId, "conflict", entity.id, path, encode(value, original))
    }

    fun serializeTombstone(
        accountId: AccountId,
        entity: TombstoneEntity,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        requireAccount(accountId, entity.accountId)
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Tombstone>(accountId, "tombstone", entity.id, it)
        }
        val value = entity.toDriveV1().requireV1()
        val path = rawBaseline?.path ?: DriveV1Paths.tombstone(entity.entityKind, entity.entityId)
        validatePath("tombstone", path)
        return serialized(accountId, "tombstone", entity.id, path, encode(value, original))
    }

    fun serializeManifest(
        accountId: AccountId,
        updatedAt: String,
        inventory: DriveV1ManifestInventory,
        createdAt: String? = null,
        rootFolderName: String? = null,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        requireManifestInventoryAccount(accountId, inventory)
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Manifest>(accountId, "manifest", "manifest", it)
        }
        val currentDevices = inventory.devices.map { it.toDriveV1().requireV1() }
        val currentDeviceIds = currentDevices.mapTo(hashSetOf()) { it.id }
        val devices = original?.value?.devices.orEmpty().filterNot { it.id in currentDeviceIds } + currentDevices
        return serializeManifestProjection(
            accountId = accountId,
            updatedAt = updatedAt,
            projection = DriveV1ManifestProjection(
                devices = devices,
                entryCount = inventory.entries.size,
                attachmentCount = inventory.attachments.size,
                fileBoxCount = inventory.fileBoxItems.size,
                transferCount = inventory.transfers.size,
            ),
            createdAt = createdAt,
            rootFolderName = rootFolderName,
            rawBaseline = rawBaseline,
        )
    }

    fun serializeManifestProjection(
        accountId: AccountId,
        updatedAt: String,
        projection: DriveV1ManifestProjection,
        createdAt: String? = null,
        rootFolderName: String? = null,
        rawBaseline: DriveRawDocumentEntity? = null,
    ): DriveV1SerializedDocument {
        val original = rawBaseline?.let {
            decodeBaseline<DriveV1Manifest>(accountId, "manifest", "manifest", it)
        }
        val value = DriveV1Manifest(
            rootFolderName = rootFolderName ?: original?.value?.rootFolderName ?: "Easylab Lab Notebook",
            createdAt = createdAt ?: original?.value?.createdAt
                ?: throw IllegalArgumentException("A new manifest requires createdAt."),
            updatedAt = updatedAt,
            devices = projection.devices.toList(),
            entryCount = projection.entryCount,
            attachmentCount = projection.attachmentCount,
            fileBoxCount = projection.fileBoxCount,
            transferCount = projection.transferCount,
        ).requireV1()
        return serialized(
            accountId,
            "manifest",
            "manifest",
            DriveV1Paths.manifest,
            encode(value, original),
        )
    }

    private fun JournalEntryEntity.toDriveV1(
        original: DriveV1Entry?,
        targetPath: String,
    ): DriveV1Entry {
        val projectTags = decodeStringList(projectTagsJson, "Entry projectTags")
        val experimentTags = decodeStringList(experimentTagsJson, "Entry experimentTags")
        val whatsappCaptures = decodeElementList(whatsappCapturesJson, "Entry WhatsApp captures")
        val telegramCaptures = decodeElementList(telegramCapturesJson, "Entry Telegram captures")
        return DriveV1Entry(
            id = id,
            createdDatetime = createdAt,
            lastEditedDatetime = updatedAt,
            authorId = authorId,
            title = title,
            dateBucket = dateBucket,
            experimentId = experimentId,
            projectId = projectId,
            isDaily = isDaily,
            content = decodeElementList(contentJson, "Entry content"),
            tags = decodeStringList(tagsJson, "Entry tags"),
            projectTags = optionalList(projectTags, original?.projectTags),
            experimentTags = optionalList(experimentTags, original?.experimentTags),
            searchTerms = decodeStringList(searchTermsJson, "Entry searchTerms"),
            linkedFiles = decodeStringList(linkedFilesJson, "Entry linkedFiles"),
            pinnedRegions = decodeElementList(pinnedRegionsJson, "Entry pinnedRegions"),
            syncPath = if (original?.syncPath != null || syncPath?.let(::isManagedEntryPath) == true) {
                targetPath
            } else {
                null
            },
            version = version,
            updatedByDeviceId = updatedByDeviceId,
            syncStatus = "synced",
            source = source,
            whatsappCaptures = optionalList(whatsappCaptures, original?.whatsappCaptures),
            telegramCaptures = optionalList(telegramCaptures, original?.telegramCaptures),
        )
    }

    private fun AttachmentEntity.toDriveV1(
        original: DriveV1Attachment?,
        blobPath: String,
    ): DriveV1Attachment = DriveV1Attachment(
        id = id,
        entryId = entryId,
        type = type,
        filename = filename,
        filesize = displaySize,
        bytes = byteSize,
        storagePath = blobPath,
        thumbnail = thumbnail?.takeUnless(::isLocalCacheHint),
        linkedRegionId = linkedRegionId,
        tag = tag,
        sampleId = sampleId,
        pinnedOffline = if (!pinnedOffline && original?.pinnedOffline == null) null else pinnedOffline,
        cachedPath = null,
        source = source,
        sourceMessageId = sourceMessageId,
        sourceMediaId = sourceMediaId,
        contentType = contentType,
        mimeType = mimeType,
        sha256 = sha256,
        cacheKey = null,
        driveFileId = driveFileId,
        syncStatus = "synced",
        createdAt = createdAt,
        updatedAt = updatedAt,
    )

    private fun DeviceEntity.toDriveV1() = DriveV1Device(
        id = id,
        name = name,
        platform = platform,
        createdAt = createdAt,
        lastSeenAt = lastSeenAt,
        userAgent = userAgent,
        appVersion = appVersion,
    )

    private fun FileBoxItemEntity.toDriveV1() = DriveV1FileBoxItem(
        id = id,
        entryId = entryId,
        attachmentId = attachmentId,
        filename = filename,
        filesize = filesize,
        contentType = contentType,
        sourceDeviceId = sourceDeviceId,
        sourceDeviceName = sourceDeviceName,
        status = status,
        createdAt = createdAt,
        updatedAt = updatedAt,
        driveFileId = driveFileId,
        localObjectUrl = null,
        lastError = lastError,
    )

    private fun TransferEntity.toDriveV1() = DriveV1Transfer(
        id = id,
        fileBoxItemId = fileBoxItemId,
        entryId = entryId,
        attachmentId = attachmentId,
        filename = filename,
        fromDeviceId = fromDeviceId,
        fromDeviceName = fromDeviceName,
        toDeviceId = toDeviceId,
        toDeviceName = toDeviceName,
        provider = provider,
        status = status,
        bytesTotal = bytesTotal,
        bytesTransferred = bytesTransferred,
        createdAt = createdAt,
        updatedAt = updatedAt,
        completedAt = completedAt,
        driveFileId = driveFileId,
        lastError = lastError,
    )

    private fun ConflictEntity.toDriveV1() = DriveV1Conflict(
        id = id,
        entityKind = entityKind,
        entityId = entityId,
        localUpdatedAt = localUpdatedAt,
        remoteUpdatedAt = remoteUpdatedAt,
        detectedAt = detectedAt,
        resolution = resolution,
        summary = summary,
        localCopy = decodeOptionalElement(localCopyJson, "Conflict local copy"),
        remoteCopy = decodeOptionalElement(remoteCopyJson, "Conflict remote copy"),
    )

    private fun TombstoneEntity.toDriveV1() = DriveV1Tombstone(
        id = id,
        entityKind = entityKind,
        entityId = entityId,
        deletedAt = deletedAt,
        deletedByDeviceId = deletedByDeviceId,
        reason = reason,
    )

    private fun requireQueue(
        accountId: AccountId,
        queue: SyncQueueEntity,
        entityKind: String,
        entityId: String,
        operation: String,
    ) {
        requireAccount(accountId, queue.accountId)
        require(queue.entityKind == entityKind) { "Queue entity kind does not match the serialized record." }
        require(queue.entityId == entityId) { "Queue entity id does not match the serialized record." }
        require(queue.operation == operation) { "Queue operation must be $operation." }
        DriveV1SyncQueueItem(
            id = queue.id,
            entityKind = queue.entityKind,
            entityId = queue.entityId,
            operation = queue.operation,
            status = queue.status,
            queuedAt = queue.queuedAt,
            updatedAt = queue.updatedAt,
            updatedByDeviceId = queue.updatedByDeviceId,
            baseVersion = queue.baseVersion,
            lastError = queue.lastError,
        ).requireV1()
    }

    private fun requireEntryVersionContract(
        entity: JournalEntryEntity,
        queue: SyncQueueEntity,
        baseline: DriveV1LosslessDocument<DriveV1Envelope<DriveV1Entry>>?,
    ) {
        if (baseline == null) {
            require(queue.baseVersion == null) { "A new entry queue must not declare a remote base version." }
            require(entity.version == 1) { "A new Drive entry must start at version 1." }
            return
        }
        val remoteVersion = baseline.value.payload.version ?: 1
        require(queue.baseVersion == remoteVersion) {
            "Entry queue baseVersion does not match the verified Drive baseline."
        }
        require(entity.version == remoteVersion + 1) {
            "Edited entry version must advance exactly once from the verified Drive baseline."
        }
        require(compareIsoTimestamps(baseline.value.updatedAt, entity.updatedAt) < 0) {
            "Edited entry timestamp must be newer than the verified Drive baseline."
        }
    }

    private fun requireManifestInventoryAccount(
        accountId: AccountId,
        inventory: DriveV1ManifestInventory,
    ) {
        val accountIds = buildList {
            addAll(inventory.devices.map { it.accountId })
            addAll(inventory.entries.map { it.accountId })
            addAll(inventory.attachments.map { it.accountId })
            addAll(inventory.fileBoxItems.map { it.accountId })
            addAll(inventory.transfers.map { it.accountId })
        }
        require(accountIds.all { it == accountId.value }) {
            "Manifest inventory must belong to the active account."
        }
    }

    private fun requireAccount(accountId: AccountId, actual: String) {
        require(actual == accountId.value) { "Record does not belong to the active account." }
    }

    private inline fun <reified T> decodeBaseline(
        accountId: AccountId,
        entityKind: String,
        entityId: String,
        baseline: DriveRawDocumentEntity,
    ): DriveV1LosslessDocument<T> {
        requireAccount(accountId, baseline.accountId)
        require(baseline.entityKind == entityKind) { "Raw Drive baseline entity kind does not match." }
        require(baseline.entityId == entityId) { "Raw Drive baseline entity id does not match." }
        validatePath(entityKind, baseline.path)
        val decoded = DriveV1Json.decodeLossless<T>(baseline.rawJson)
        validateBaselineValue(entityKind, entityId, decoded.value)
        return decoded
    }

    private fun validateBaselineValue(entityKind: String, entityId: String, value: Any?) {
        when (value) {
            is DriveV1Envelope<*> -> {
                value.requireV1(entityKind)
                require(value.id == entityId) { "Raw Drive baseline document id does not match." }
                val payloadUpdatedAt = when (val payload = value.payload) {
                    is DriveV1Entry -> payload.lastEditedDatetime
                    is DriveV1Attachment -> payload.updatedAt
                    is DriveV1FileBoxItem -> payload.updatedAt
                    is DriveV1Transfer -> payload.updatedAt
                    else -> null
                }
                require(payloadUpdatedAt == null || payloadUpdatedAt == value.updatedAt) {
                    "Raw Drive baseline envelope and payload timestamps do not match."
                }
            }
            is DriveV1Device -> {
                value.requireV1()
                require(value.id == entityId) { "Raw Drive baseline device id does not match." }
            }
            is DriveV1Conflict -> {
                value.requireV1()
                require(value.id == entityId) { "Raw Drive baseline conflict id does not match." }
            }
            is DriveV1Tombstone -> {
                value.requireV1()
                require(value.id == entityId) { "Raw Drive baseline tombstone id does not match." }
            }
            is DriveV1Manifest -> {
                value.requireV1()
                require(entityKind == "manifest" && entityId == "manifest") {
                    "Raw Drive baseline manifest identity does not match."
                }
            }
            else -> throw IllegalArgumentException("Unsupported raw Drive baseline document.")
        }
    }

    private inline fun <reified T> encode(
        value: T,
        original: DriveV1LosslessDocument<T>?,
    ): String = if (original == null) {
        DriveV1Json.format.encodeToString(value)
    } else {
        original.value = value
        original.encodePreservingUnknownFields()
    }

    private fun serialized(
        accountId: AccountId,
        entityKind: String,
        entityId: String,
        path: String,
        json: String,
        attachmentBlobPath: String? = null,
    ) = DriveV1SerializedDocument(
        accountId = accountId.value,
        entityKind = entityKind,
        entityId = entityId,
        path = path,
        json = json,
        attachmentBlobPath = attachmentBlobPath,
    )

    private fun decodeElementList(raw: String, label: String): List<JsonElement> = decodeStored(raw, label)

    private fun decodeStringList(raw: String, label: String): List<String> = decodeStored(raw, label)

    private fun decodeOptionalElement(raw: String?, label: String): JsonElement? = raw?.let {
        decodeStored<JsonElement>(it, label)
    }

    private inline fun <reified T> decodeStored(raw: String, label: String): T = try {
        DriveV1Json.format.decodeFromString(raw)
    } catch (error: SerializationException) {
        throw IllegalArgumentException("$label is not valid Drive v1 JSON.", error)
    } catch (error: IllegalArgumentException) {
        throw IllegalArgumentException("$label is not valid Drive v1 JSON.", error)
    }

    private fun <T> optionalList(value: List<T>, original: List<T>?): List<T>? =
        if (value.isEmpty() && original == null) null else value

    private fun isLocalCacheHint(value: String): Boolean {
        val normalized = value.trim().lowercase()
        return normalized.startsWith("blob:") ||
            normalized.startsWith("file:") ||
            normalized.startsWith("content:") ||
            normalized.startsWith("data:") ||
            normalized.startsWith("/") ||
            normalized.startsWith("~/") ||
            Regex("^[a-z]:[\\\\/]").containsMatchIn(normalized)
    }

    private fun isManagedEntryPath(value: String): Boolean = runCatching {
        validatePath("entry", value)
    }.isSuccess

    private fun validatePath(entityKind: String, path: String) {
        val valid = when (entityKind) {
            "manifest" -> path == DriveV1Paths.manifest
            "device" -> path.startsWith("devices/") && path.endsWith(".json")
            "entry" -> path.startsWith("entries/") && path.endsWith(".json")
            "attachment" -> path.startsWith("attachments/") && path.endsWith(".json")
            "fileBoxItem" -> path.startsWith("filebox/") && path.endsWith(".json")
            "transfer" -> path.startsWith("transfers/") && path.endsWith(".json")
            "conflict" -> path.startsWith("conflicts/") && path.endsWith(".json")
            "tombstone" -> path.startsWith("tombstones/") && path.endsWith(".json")
            else -> false
        }
        val segments = path.split('/')
        require(
            valid && path.length <= 1024 && !path.startsWith('/') && !path.endsWith('/') &&
                segments.all { segment ->
                    segment.isNotBlank() && segment !in setOf(".", "..") && '\\' !in segment &&
                        segment.length <= 255 && segment.none(Char::isISOControl)
                },
        ) {
            "Raw Drive baseline path is not valid for $entityKind."
        }
    }
}
