package com.easylab.labnotebook.sync

import java.math.BigDecimal
import java.security.MessageDigest
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Required
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

object DriveV1Json {
    val format = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }
    @PublishedApi
    internal val losslessProjectionFormat = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = true
    }

    inline fun <reified T> decodeLossless(rawJson: String): DriveV1LosslessDocument<T> {
        val rawObject = format.parseToJsonElement(rawJson) as? JsonObject
            ?: throw IllegalArgumentException("Drive v1 JSON document must be an object.")
        require(rawObject["deletedAt"] !is JsonNull) {
            "Drive v1 deletedAt must be omitted; deletions use tombstones."
        }
        val value = format.decodeFromString<T>(rawJson)
        return DriveV1LosslessDocument(
            value = value,
            rawObject = rawObject,
            rawJson = rawJson,
            originalValue = value,
            originalKnownObject = losslessProjectionFormat.encodeToJsonElement(value) as JsonObject,
            encodeKnownObject = { losslessProjectionFormat.encodeToJsonElement(it) as JsonObject },
        )
    }
}

class DriveV1LosslessDocument<T>(
    var value: T,
    val rawObject: JsonObject,
    private val rawJson: String,
    private val originalValue: T,
    private val originalKnownObject: JsonObject,
    private val encodeKnownObject: (T) -> JsonObject,
) {
    fun encodePreservingUnknownFields(): String {
        if (value == originalValue) {
            originalKnownObject.requireUniqueStableObjectIdsRecursively()
            return rawJson
        }
        return DriveV1Json.format.encodeToString(
            mergeTypedEdits(rawObject, originalKnownObject, encodeKnownObject(value)),
        )
    }

    private fun mergeTypedEdits(raw: JsonElement, originalKnown: JsonElement?, editedKnown: JsonElement): JsonElement =
        when {
            raw is JsonObject && editedKnown is JsonObject -> mergeTypedObjects(
                raw,
                originalKnown as? JsonObject ?: JsonObject(emptyMap()),
                editedKnown,
            )
            raw is JsonArray && editedKnown is JsonArray -> mergeTypedArrays(
                raw,
                originalKnown as? JsonArray ?: JsonArray(emptyList()),
                editedKnown,
            )
            else -> editedKnown
        }

    private fun mergeTypedObjects(
        raw: JsonObject,
        originalKnown: JsonObject,
        editedKnown: JsonObject,
    ): JsonObject = JsonObject(buildMap {
        raw.forEach { (key, rawValue) ->
            val editedValue = editedKnown[key]
            when {
                editedValue == null && key in originalKnown -> Unit
                editedValue is JsonNull && key in originalKnown -> Unit
                editedValue != null -> put(key, mergeTypedEdits(rawValue, originalKnown[key], editedValue))
                else -> put(key, rawValue)
            }
        }
        editedKnown.forEach { (key, editedValue) ->
            if (key !in raw && editedValue !is JsonNull) put(key, editedValue)
        }
    })

    private fun mergeTypedArrays(
        raw: JsonArray,
        originalKnown: JsonArray,
        editedKnown: JsonArray,
    ): JsonArray {
        originalKnown.requireUniqueStableObjectIds("original")
        editedKnown.requireUniqueStableObjectIds("edited")
        val claimedOriginalIndexes = mutableSetOf<Int>()
        return JsonArray(editedKnown.map { editedElement ->
            val originalIndex = correspondingArrayIndex(
                editedElement = editedElement,
                originalKnown = originalKnown,
                editedKnown = editedKnown,
                claimedOriginalIndexes = claimedOriginalIndexes,
            )
            if (originalIndex == null || originalIndex !in raw.indices) {
                editedElement
            } else {
                claimedOriginalIndexes += originalIndex
                mergeTypedEdits(raw[originalIndex], originalKnown[originalIndex], editedElement)
            }
        })
    }

    private fun correspondingArrayIndex(
        editedElement: JsonElement,
        originalKnown: JsonArray,
        editedKnown: JsonArray,
        claimedOriginalIndexes: Set<Int>,
    ): Int? {
        val editedObject = editedElement as? JsonObject ?: return null
        val editedId = stableObjectId(editedObject)
        if (editedId != null) {
            val matchingIndexes = originalKnown.indices.filter { originalIndex ->
                stableObjectId(originalKnown[originalIndex] as? JsonObject) == editedId
            }
            if (matchingIndexes.size != 1) return null
            if (editedKnown.count { stableObjectId(it as? JsonObject) == editedId } != 1) return null

            val matchingIndex = matchingIndexes.single()
            if (matchingIndex in claimedOriginalIndexes) return null
            val matchingObject = originalKnown[matchingIndex] as? JsonObject ?: return null
            val matchingScore = editedObject.similarityWithoutId(matchingObject)
            val competingScore = originalKnown.indices
                .asSequence()
                .filter { it != matchingIndex }
                .mapNotNull { originalKnown[it] as? JsonObject }
                .maxOfOrNull { editedObject.similarityWithoutId(it) }
                ?: -1
            require(competingScore < matchingScore) {
                "Cannot preserve unknown array fields after an ambiguous stable-id edit."
            }
            return matchingIndex
        }
        return null
    }

    private fun JsonArray.requireUniqueStableObjectIds(label: String) {
        val ids = mapNotNull { stableObjectId(it as? JsonObject) }
        require(ids.size == ids.toSet().size) {
            "Cannot preserve unknown array fields with duplicate stable ids in the $label array."
        }
    }

    private fun JsonElement.requireUniqueStableObjectIdsRecursively(path: String = "root") {
        when (this) {
            is JsonArray -> {
                requireUniqueStableObjectIds(path)
                forEachIndexed { index, element ->
                    element.requireUniqueStableObjectIdsRecursively("$path[$index]")
                }
            }
            is JsonObject -> forEach { (key, element) ->
                element.requireUniqueStableObjectIdsRecursively("$path.$key")
            }
            else -> Unit
        }
    }

    private fun JsonObject.similarityWithoutId(other: JsonObject): Int =
        (keys + other.keys)
            .asSequence()
            .filter { it != "id" }
            .distinct()
            .count { this[it] == other[it] }

    private fun stableObjectId(value: JsonObject?): String? =
        (value?.get("id") as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?.takeUnless(String::isDriveV1Blank)
}

private val entityKinds = setOf("entry", "attachment", "fileBoxItem", "transfer", "device", "tombstone")
private val syncStatuses = setOf("local", "queued", "syncing", "synced", "remote-available", "failed", "conflict")
private val isoTimestamp = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$""")
private val dateBucketPattern = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")

private fun String.isDriveV1Blank(): Boolean = all { character ->
    Character.isWhitespace(character) || Character.isSpaceChar(character) || character == '\uFEFF'
}

private fun requireText(value: String, message: String) = require(!value.isDriveV1Blank()) { message }
private fun isLeapYear(year: Int) = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
private fun validDate(year: Int, month: Int, day: Int): Boolean {
    val maxDay = when (month) {
        1, 3, 5, 7, 8, 10, 12 -> 31
        4, 6, 9, 11 -> 30
        2 -> if (isLeapYear(year)) 29 else 28
        else -> return false
    }
    return day in 1..maxDay
}

private fun isDateBucket(value: String): Boolean {
    val match = dateBucketPattern.matchEntire(value) ?: return false
    return validDate(match.groupValues[1].toInt(), match.groupValues[2].toInt(), match.groupValues[3].toInt())
}

private fun isIsoTimestamp(value: String): Boolean {
    val match = isoTimestamp.matchEntire(value) ?: return false
    val values = match.groupValues
    if (!validDate(values[1].toInt(), values[2].toInt(), values[3].toInt())) return false
    if (values[4].toInt() !in 0..23 || values[5].toInt() !in 0..59 || values[6].toInt() !in 0..59) return false
    return values[7].isEmpty() || (values[7].toInt() in 0..23 && values[8].toInt() in 0..59)
}

private fun requireTimestamp(value: String, label: String) =
    require(isIsoTimestamp(value)) { "$label must be an ISO timestamp." }

@Serializable
data class DriveV1Device(
    val id: String,
    val name: String,
    val platform: String,
    val createdAt: String,
    val lastSeenAt: String,
    val userAgent: String? = null,
    val appVersion: String? = null,
) {
    fun requireV1(): DriveV1Device = apply {
        requireText(id, "Device id is required.")
        requireText(name, "Device name is required.")
        require(platform in setOf("desktop", "mobile", "tablet", "web")) { "Device platform is invalid." }
        requireTimestamp(createdAt, "Device createdAt")
        requireTimestamp(lastSeenAt, "Device lastSeenAt")
    }
}

@Serializable
data class DriveV1Manifest(
    @Required val version: Int = 1,
    @Required val provider: String = "google-drive",
    @Required val rootFolderName: String = "Easylab Lab Notebook",
    val createdAt: String,
    val updatedAt: String,
    @Required val devices: List<DriveV1Device> = emptyList(),
    @Required val entryCount: Int = 0,
    @Required val attachmentCount: Int = 0,
    @Required val fileBoxCount: Int = 0,
    @Required val transferCount: Int = 0,
) {
    fun requireV1(): DriveV1Manifest = apply {
        require(version == 1) { "Manifest version must be 1." }
        require(provider == "google-drive") { "Manifest provider must be google-drive." }
        requireText(rootFolderName, "Manifest rootFolderName is required.")
        requireTimestamp(createdAt, "Manifest createdAt")
        requireTimestamp(updatedAt, "Manifest updatedAt")
        devices.forEach { it.requireV1() }
        require(devices.map { it.id }.toSet().size == devices.size) {
            "Manifest device ids must be unique."
        }
        require(listOf(entryCount, attachmentCount, fileBoxCount, transferCount).all { it >= 0 }) {
            "Manifest counts must be non-negative."
        }
    }
}

@Serializable
data class DriveV1Entry(
    val id: String,
    val createdDatetime: String,
    val lastEditedDatetime: String,
    val authorId: String,
    val title: String,
    val dateBucket: String,
    val experimentId: String? = null,
    val projectId: String? = null,
    val isDaily: Boolean? = null,
    @Required val content: List<JsonElement> = emptyList(),
    @Required val tags: List<String> = emptyList(),
    val projectTags: List<String>? = null,
    val experimentTags: List<String>? = null,
    @Required val searchTerms: List<String> = emptyList(),
    @Required val linkedFiles: List<String> = emptyList(),
    @Required val pinnedRegions: List<JsonElement> = emptyList(),
    val syncPath: String? = null,
    val version: Int? = null,
    val updatedByDeviceId: String? = null,
    val syncStatus: String? = null,
    val source: String? = null,
    val whatsappCaptures: List<JsonElement>? = null,
    val telegramCaptures: List<JsonElement>? = null,
) {
    fun requireV1(): DriveV1Entry = apply {
        requireText(id, "Entry id is required.")
        requireText(authorId, "Entry authorId is required.")
        requireTimestamp(createdDatetime, "Entry createdDatetime")
        requireTimestamp(lastEditedDatetime, "Entry lastEditedDatetime")
        require(isDateBucket(dateBucket)) { "Entry dateBucket must be a valid YYYY-MM-DD date." }
        require(version == null || version >= 0) { "Entry version must be non-negative." }
        require(syncStatus == null || syncStatus in syncStatuses) { "Entry syncStatus is invalid." }
        require(source == null || source in setOf("manual", "whatsapp", "telegram")) { "Entry source is invalid." }
        val blockIds = content.mapIndexed { index, block -> requireValidBlock(block, index) }
        require(blockIds.size == blockIds.toSet().size) { "Entry content block ids must be unique." }
        pinnedRegions.forEachIndexed { index, region -> requireValidPinnedRegion(region, index, id) }
        whatsappCaptures?.forEachIndexed { index, capture -> requireValidCapture(capture, index, false) }
        telegramCaptures?.forEachIndexed { index, capture -> requireValidCapture(capture, index, true) }
    }
}

@Serializable
data class DriveV1Attachment(
    val id: String,
    val entryId: String,
    val type: String,
    val filename: String,
    val filesize: String,
    val bytes: Long? = null,
    val storagePath: String,
    val thumbnail: String? = null,
    val linkedRegionId: String? = null,
    val tag: String? = null,
    val sampleId: String? = null,
    val pinnedOffline: Boolean? = null,
    val cachedPath: String? = null,
    val source: String? = null,
    val sourceMessageId: String? = null,
    val sourceMediaId: String? = null,
    val contentType: String? = null,
    val mimeType: String? = null,
    val sha256: String? = null,
    val cacheKey: String? = null,
    val driveFileId: String? = null,
    val syncStatus: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    fun requireV1(): DriveV1Attachment = apply {
        requireText(id, "Attachment id is required.")
        requireText(entryId, "Attachment entryId is required.")
        require(type in setOf("image", "pdf", "file", "raw")) { "Attachment type is invalid." }
        requireText(filename, "Attachment filename is required.")
        requireText(filesize, "Attachment filesize is required.")
        requireText(storagePath, "Attachment storagePath is required.")
        require(bytes == null || bytes >= 0) { "Attachment bytes must be non-negative." }
        require(source == null || source in setOf("whatsapp", "telegram")) { "Attachment source is invalid." }
        require(syncStatus == null || syncStatus in syncStatuses) { "Attachment syncStatus is invalid." }
        createdAt?.let { requireTimestamp(it, "Attachment createdAt") }
        updatedAt?.let { requireTimestamp(it, "Attachment updatedAt") }
    }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class DriveV1Envelope<T>(
    val id: String,
    val kind: String,
    @Required val version: Int = 1,
    val updatedAt: String,
    val updatedByDeviceId: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val deletedAt: String = "",
    val payload: T,
) {
    fun requireV1(expectedKind: String): DriveV1Envelope<T> = apply {
        require(expectedKind in entityKinds) { "Expected envelope kind is not supported by Drive v1." }
        require(version == 1) { "Envelope version must be 1." }
        require(kind == expectedKind) { "Envelope kind must be $expectedKind." }
        requireText(id, "Envelope id is required.")
        requireTimestamp(updatedAt, "Envelope updatedAt")
        requireText(updatedByDeviceId, "Envelope updatedByDeviceId is required.")
        require(deletedAt.isEmpty()) { "Envelope deletedAt must be represented by a Drive v1 tombstone." }
        val payloadId = when (payload) {
            is DriveV1Entry -> payload.requireV1().id
            is DriveV1Attachment -> payload.requireV1().id
            is DriveV1FileBoxItem -> payload.requireV1().id
            is DriveV1Transfer -> payload.requireV1().id
            is DriveV1Device -> payload.requireV1().id
            is DriveV1Tombstone -> payload.requireV1().id
            else -> throw IllegalArgumentException("Unsupported Drive v1 envelope payload.")
        }
        require(id == payloadId) { "Envelope id must match payload id." }
    }
}

@Serializable
data class DriveV1FileBoxItem(
    val id: String,
    val entryId: String,
    val attachmentId: String? = null,
    val filename: String,
    val filesize: String,
    val contentType: String? = null,
    val sourceDeviceId: String,
    val sourceDeviceName: String,
    val status: String,
    val createdAt: String,
    val updatedAt: String,
    val driveFileId: String? = null,
    val localObjectUrl: String? = null,
    val lastError: String? = null,
) {
    fun requireV1(): DriveV1FileBoxItem = apply {
        requireText(id, "File Box id is required.")
        requireText(entryId, "File Box entryId is required.")
        requireText(filename, "File Box filename is required.")
        requireText(filesize, "File Box filesize is required.")
        requireText(sourceDeviceId, "File Box sourceDeviceId is required.")
        requireText(sourceDeviceName, "File Box sourceDeviceName is required.")
        require(status in setOf("queued", "uploading", "available", "attached", "rejected", "failed", "removed")) {
            "File Box status is invalid."
        }
        requireTimestamp(createdAt, "File Box createdAt")
        requireTimestamp(updatedAt, "File Box updatedAt")
    }
}

@Serializable
data class DriveV1Transfer(
    val id: String,
    val fileBoxItemId: String? = null,
    val entryId: String? = null,
    val attachmentId: String? = null,
    val filename: String,
    val fromDeviceId: String,
    val fromDeviceName: String,
    val toDeviceId: String? = null,
    val toDeviceName: String? = null,
    val provider: String,
    val status: String,
    val bytesTotal: Long? = null,
    val bytesTransferred: Long? = null,
    val createdAt: String,
    val updatedAt: String,
    val completedAt: String? = null,
    val driveFileId: String? = null,
    val lastError: String? = null,
) {
    fun requireV1(): DriveV1Transfer = apply {
        requireText(id, "Transfer id is required.")
        requireText(filename, "Transfer filename is required.")
        requireText(fromDeviceId, "Transfer fromDeviceId is required.")
        requireText(fromDeviceName, "Transfer fromDeviceName is required.")
        require(provider == "google-drive") { "Transfer provider must be google-drive." }
        require(status in setOf("queued", "uploading", "available", "attached", "failed", "conflict", "removed")) {
            "Transfer status is invalid."
        }
        require(bytesTotal == null || bytesTotal >= 0) { "Transfer bytesTotal must be non-negative." }
        require(bytesTransferred == null || bytesTransferred >= 0) { "Transfer bytesTransferred must be non-negative." }
        requireTimestamp(createdAt, "Transfer createdAt")
        requireTimestamp(updatedAt, "Transfer updatedAt")
        completedAt?.let { requireTimestamp(it, "Transfer completedAt") }
    }
}

@Serializable
data class DriveV1Conflict(
    val id: String,
    val entityKind: String,
    val entityId: String,
    val localUpdatedAt: String,
    val remoteUpdatedAt: String,
    val detectedAt: String,
    val resolution: String,
    val summary: String,
    val localCopy: JsonElement? = null,
    val remoteCopy: JsonElement? = null,
) {
    fun requireV1(): DriveV1Conflict = apply {
        requireText(id, "Conflict id is required.")
        require(entityKind in entityKinds) { "Conflict entityKind is not supported by Drive v1." }
        requireText(entityId, "Conflict entityId is required.")
        requireTimestamp(localUpdatedAt, "Conflict localUpdatedAt")
        requireTimestamp(remoteUpdatedAt, "Conflict remoteUpdatedAt")
        requireTimestamp(detectedAt, "Conflict detectedAt")
        require(resolution in setOf("pending", "local-won", "remote-won", "kept-copy")) { "Conflict resolution is invalid." }
        requireText(summary, "Conflict summary is required.")
    }
}

@Serializable
data class DriveV1Tombstone(
    val id: String,
    val entityKind: String,
    val entityId: String,
    val deletedAt: String,
    val deletedByDeviceId: String,
    val reason: String? = null,
) {
    fun requireV1(): DriveV1Tombstone = apply {
        requireText(id, "Tombstone id is required.")
        require(entityKind in entityKinds) { "Tombstone entityKind is not supported by Drive v1." }
        requireText(entityId, "Tombstone entityId is required.")
        requireTimestamp(deletedAt, "Tombstone deletedAt")
        requireText(deletedByDeviceId, "Tombstone deletedByDeviceId is required.")
    }
}

@Serializable
data class DriveV1SyncQueueItem(
    val id: String,
    val entityKind: String,
    val entityId: String,
    val operation: String,
    val status: String,
    val queuedAt: String,
    val updatedAt: String,
    val updatedByDeviceId: String,
    val baseVersion: Int? = null,
    val lastError: String? = null,
) {
    fun requireV1(): DriveV1SyncQueueItem = apply {
        requireText(id, "Queue id is required.")
        require(entityKind in entityKinds) { "Queue entityKind is not supported by Drive v1." }
        requireText(entityId, "Queue entityId is required.")
        require(operation in setOf("upsert", "delete")) { "Queue operation is invalid." }
        require(status in syncStatuses) { "Queue status is invalid." }
        requireTimestamp(queuedAt, "Queue queuedAt")
        requireTimestamp(updatedAt, "Queue updatedAt")
        requireText(updatedByDeviceId, "Queue updatedByDeviceId is required.")
        require(baseVersion == null || baseVersion >= 0) { "Queue baseVersion must be non-negative." }
    }
}

@Serializable
data class DriveV1SyncState(
    val id: String,
    val updatedAt: String,
    val lastSyncedAt: String? = null,
    val queueCount: Int? = null,
    val value: JsonElement? = null,
) {
    fun requireV1(): DriveV1SyncState = apply {
        requireText(id, "Sync state id is required.")
        requireTimestamp(updatedAt, "Sync state updatedAt")
        lastSyncedAt?.let { requireTimestamp(it, "Sync state lastSyncedAt") }
        require(queueCount == null || queueCount >= 0) { "Sync state queueCount must be non-negative." }
    }
}

private fun JsonObject.requiredText(key: String, label: String): String {
    val value = this[key] as? JsonPrimitive
    require(value?.isString == true) { "$label must be a string." }
    return value.content.also { require(!it.isDriveV1Blank()) { "$label is required." } }
}

private fun requireTextRuns(value: JsonElement?, label: String) {
    if (value == null) return
    val runs = value as? JsonArray ?: throw IllegalArgumentException("$label must be an array.")
    runs.forEachIndexed { runIndex, run ->
        val record = run as? JsonObject ?: throw IllegalArgumentException("$label must contain objects.")
        require((record["text"] as? JsonPrimitive)?.isString == true) {
            "$label[$runIndex].text must be a string."
        }
    }
}

private fun requireValidBlock(value: JsonElement, index: Int): String {
    val block = value as? JsonObject ?: throw IllegalArgumentException("Entry content[$index] must be an object.")
    val blockId = block.requiredText("id", "Entry content[$index].id")
    val type = block.requiredText("type", "Entry content[$index].type")
    require(type in setOf("heading", "paragraph", "table", "workbook", "image", "file", "checklist", "list", "quote", "divider")) {
        "Entry content[$index].type is not supported by Drive v1."
    }
    requireTextRuns(block["runs"], "Entry content[$index].runs")
    when (type) {
        "heading", "paragraph", "quote" ->
            require((block["text"] as? JsonPrimitive)?.isString == true) { "Entry content[$index].text must be a string." }
        "table", "workbook" -> {
            val rows = block["data"] as? JsonArray ?: throw IllegalArgumentException("Entry content[$index].data must be a string matrix.")
            require(rows.all { row -> row is JsonArray && row.all { cell -> (cell as? JsonPrimitive)?.isString == true } }) {
                "Entry content[$index].data must be a string matrix."
            }
        }
        "image", "file" -> block.requiredText("attachmentId", "Entry content[$index].attachmentId")
        "checklist", "list" -> {
            val items = block["items"] as? JsonArray ?: throw IllegalArgumentException("Entry content[$index].items must be an array.")
            val itemIds = mutableListOf<String>()
            items.forEachIndexed { itemIndex, itemValue ->
                val item = itemValue as? JsonObject
                    ?: throw IllegalArgumentException("Entry content[$index].items[$itemIndex] must be an object.")
                itemIds += item.requiredText("id", "Entry content[$index].items[$itemIndex].id")
                require((item["text"] as? JsonPrimitive)?.isString == true) {
                    "Entry content[$index].items[$itemIndex].text must be a string."
                }
                if (type == "checklist") {
                    val done = item["done"] as? JsonPrimitive
                    require(done?.isString == false && done.booleanOrNull != null) {
                        "Entry content[$index].items[$itemIndex].done must be a boolean."
                    }
                }
                requireTextRuns(item["runs"], "Entry content[$index].items[$itemIndex].runs")
            }
            require(itemIds.size == itemIds.toSet().size) {
                "Entry content[$index] item ids must be unique."
            }
        }
    }
    return blockId
}

private fun requireStringArray(value: JsonElement?, label: String) {
    val array = value as? JsonArray ?: throw IllegalArgumentException("$label must be a string array.")
    require(array.all { (it as? JsonPrimitive)?.isString == true }) { "$label must be a string array." }
}

private fun requireValidPinnedRegion(value: JsonElement, index: Int, entryId: String) {
    val region = value as? JsonObject ?: throw IllegalArgumentException("Entry pinnedRegions[$index] must be an object.")
    region.requiredText("id", "Entry pinnedRegions[$index].id")
    require(region.requiredText("entryId", "Entry pinnedRegions[$index].entryId") == entryId) {
        "Entry pinnedRegions[$index].entryId must match the entry id."
    }
    region.requiredText("label", "Entry pinnedRegions[$index].label")
    requireStringArray(region["blockIds"], "Entry pinnedRegions[$index].blockIds")
    requireStringArray(region["linkedAttachments"], "Entry pinnedRegions[$index].linkedAttachments")
}

private fun requireValidCapture(value: JsonElement, index: Int, telegram: Boolean) {
    val label = if (telegram) "telegramCaptures[$index]" else "whatsappCaptures[$index]"
    val capture = value as? JsonObject ?: throw IllegalArgumentException("Entry $label must be an object.")
    capture.requiredText("messageId", "Entry $label.messageId")
    requireTimestamp(capture.requiredText("sentAt", "Entry $label.sentAt"), "Entry $label.sentAt")
    requireTimestamp(capture.requiredText("receivedAt", "Entry $label.receivedAt"), "Entry $label.receivedAt")
    requireStringArray(capture["blockIds"], "Entry $label.blockIds")
    requireStringArray(capture["attachmentIds"], "Entry $label.attachmentIds")
}

object DriveV1Paths {
    const val manifest = "manifest.json"
    fun device(deviceId: String) = "devices/${safeSegment(deviceId, "device")}.json"
    fun entry(entry: DriveV1Entry, allEntries: Map<String, DriveV1Entry>? = null): String {
        val date = safeSegment(entry.dateBucket.ifEmpty { entry.createdDatetime.take(10).ifEmpty { "undated" } })
        val duplicate = allEntries?.values?.count { it.dateBucket == entry.dateBucket }?.let { it > 1 } == true
        return "entries/$date${if (duplicate) "-${safeSegment(entry.id)}" else ""}.json"
    }
    fun entry(dateBucket: String, entryId: String? = null): String =
        "entries/${safeSegment(dateBucket, "undated")}${entryId?.let { "-${safeSegment(it)}" } ?: ""}.json"

    fun attachmentFolder(entry: DriveV1Entry? = null): String =
        safeSegment(entry?.dateBucket?.ifEmpty { entry.createdDatetime.take(10).ifEmpty { "undated" } } ?: "undated")
    fun attachmentBlob(attachment: DriveV1Attachment, entry: DriveV1Entry? = null): String =
        "attachments/${attachmentFolder(entry)}/${safeSegment(attachment.id, "attachment")}-${safeSegment(attachment.filename, "file")}"
    fun attachmentBlob(dateBucket: String, attachmentId: String, filename: String): String =
        "attachments/${safeSegment(dateBucket, "undated")}/${safeSegment(attachmentId, "attachment")}-${safeSegment(filename, "file")}"
    fun attachmentMetadata(attachment: DriveV1Attachment, entry: DriveV1Entry? = null): String =
        "${attachmentBlob(attachment, entry)}.json"
    fun attachmentMetadata(dateBucket: String, attachmentId: String, filename: String): String =
        "${attachmentBlob(dateBucket, attachmentId, filename)}.json"
    fun fileBox(itemId: String) = "filebox/${safeSegment(itemId, "filebox")}.json"
    fun transfer(transferId: String) = "transfers/${safeSegment(transferId, "transfer")}.json"
    fun conflict(conflictId: String) = "conflicts/${safeSegment(conflictId, "conflict")}.json"
    fun tombstone(entityKind: String, entityId: String): String {
        require(entityKind in entityKinds) { "Tombstone entity kind is invalid." }
        return "tombstones/${safeSegment(entityKind, "entity")}--${safeSegment(entityId, "entity")}.json"
    }

    fun safeSegment(value: String, fallback: String = "untitled"): String {
        // Keep this byte-for-byte compatible with web/src/sync/dataCore.ts safeDriveSegment.
        val input = value.ifEmpty { fallback }
        return buildString {
            var index = 0
            while (index < input.length) {
                val first = input[index]
                val codePoint = when {
                    first.isHighSurrogate() && index + 1 < input.length && input[index + 1].isLowSurrogate() -> {
                        index += 1
                        Character.toCodePoint(first, input[index])
                    }
                    first.isSurrogate() -> throw IllegalArgumentException(
                        "Drive path segments must contain valid Unicode.",
                    )
                    else -> first.code
                }
                index += 1
                appendEncodedUtf8(codePoint)
            }
        }
    }

    private fun StringBuilder.appendEncodedUtf8(codePoint: Int) {
        val bytes = when {
            codePoint <= 0x7f -> intArrayOf(codePoint)
            codePoint <= 0x7ff -> intArrayOf(
                0xc0 or (codePoint shr 6),
                0x80 or (codePoint and 0x3f),
            )
            codePoint <= 0xffff -> intArrayOf(
                0xe0 or (codePoint shr 12),
                0x80 or ((codePoint shr 6) and 0x3f),
                0x80 or (codePoint and 0x3f),
            )
            else -> intArrayOf(
                0xf0 or (codePoint shr 18),
                0x80 or ((codePoint shr 12) and 0x3f),
                0x80 or ((codePoint shr 6) and 0x3f),
                0x80 or (codePoint and 0x3f),
            )
        }
        bytes.forEach { byte ->
            if (
                byte in 'A'.code..'Z'.code ||
                byte in 'a'.code..'z'.code ||
                byte in '0'.code..'9'.code ||
                byte == '.'.code || byte == '_'.code || byte == '-'.code
            ) {
                append(byte.toChar())
            } else {
                append('%')
                append(HEX_DIGITS[byte shr 4])
                append(HEX_DIGITS[byte and 0x0f])
            }
        }
    }

    private const val HEX_DIGITS = "0123456789ABCDEF"
}

object DriveV1Hashing {
    fun stableStringify(value: JsonElement): String = when (value) {
        JsonNull -> "null"
        is JsonPrimitive -> when {
            value.isString || value.booleanOrNull != null -> value.toString()
            else -> canonicalizeJavaScriptNumber(value.content)
        }
        is JsonArray -> value.joinToString(prefix = "[", postfix = "]", separator = ",") { stableStringify(it) }
        is JsonObject -> value.entries.sortedBy { it.key }.joinToString(prefix = "{", postfix = "}", separator = ",") {
            "${JsonPrimitive(it.key)}:${stableStringify(it.value)}"
        }
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun sha256(text: String): String = sha256(text.toByteArray(Charsets.UTF_8))
    fun sha256(value: JsonElement): String = sha256(stableStringify(value))

    fun entryContentHash(entry: DriveV1Entry): String = sha256(buildJsonObject {
        put("id", entry.id)
        entry.experimentId?.let { put("experimentId", it) }
        entry.projectId?.let { put("projectId", it) }
        put("createdDatetime", entry.createdDatetime)
        put("lastEditedDatetime", entry.lastEditedDatetime)
        put("authorId", entry.authorId)
        put("title", entry.title)
        put("dateBucket", entry.dateBucket)
        entry.isDaily?.let { put("isDaily", it) }
        put("content", JsonArray(entry.content))
        put("tags", stringArray(entry.tags))
        entry.projectTags?.let { put("projectTags", stringArray(it)) }
        entry.experimentTags?.let { put("experimentTags", stringArray(it)) }
        put("searchTerms", stringArray(entry.searchTerms))
        put("linkedFiles", stringArray(entry.linkedFiles))
        put("pinnedRegions", JsonArray(entry.pinnedRegions))
        entry.version?.let { put("version", it) }
        entry.source?.let { put("source", it) }
        entry.whatsappCaptures?.let { put("whatsappCaptures", JsonArray(it)) }
        entry.telegramCaptures?.let { put("telegramCaptures", JsonArray(it)) }
    })

    fun attachmentMetadataHash(attachment: DriveV1Attachment): String = sha256(buildJsonObject {
        put("id", attachment.id)
        put("entryId", attachment.entryId)
        put("type", attachment.type)
        put("filename", attachment.filename)
        put("filesize", attachment.filesize)
        attachment.bytes?.let { put("bytes", it) }
        put("storagePath", attachment.storagePath)
        attachment.linkedRegionId?.let { put("linkedRegionId", it) }
        attachment.tag?.let { put("tag", it) }
        attachment.sampleId?.let { put("sampleId", it) }
        attachment.source?.let { put("source", it) }
        attachment.sourceMessageId?.let { put("sourceMessageId", it) }
        attachment.sourceMediaId?.let { put("sourceMediaId", it) }
        attachment.contentType?.let { put("contentType", it) }
        attachment.mimeType?.let { put("mimeType", it) }
        attachment.sha256?.let { put("sha256", it) }
        attachment.driveFileId?.let { put("driveFileId", it) }
        attachment.createdAt?.let { put("createdAt", it) }
        attachment.updatedAt?.let { put("updatedAt", it) }
    })

    fun fileBoxMetadataHash(item: DriveV1FileBoxItem): String = sha256(buildJsonObject {
        put("id", item.id)
        put("entryId", item.entryId)
        item.attachmentId?.let { put("attachmentId", it) }
        put("filename", item.filename)
        put("filesize", item.filesize)
        item.contentType?.let { put("contentType", it) }
        put("sourceDeviceId", item.sourceDeviceId)
        put("sourceDeviceName", item.sourceDeviceName)
        put("status", item.status)
        put("createdAt", item.createdAt)
        item.driveFileId?.let { put("driveFileId", it) }
        item.localObjectUrl?.let { put("localObjectUrl", it) }
        item.lastError?.let { put("lastError", it) }
        put("updatedAt", item.updatedAt)
    })

    fun transferMetadataHash(transfer: DriveV1Transfer): String = sha256(buildJsonObject {
        put("id", transfer.id)
        transfer.fileBoxItemId?.let { put("fileBoxItemId", it) }
        transfer.entryId?.let { put("entryId", it) }
        transfer.attachmentId?.let { put("attachmentId", it) }
        put("filename", transfer.filename)
        put("fromDeviceId", transfer.fromDeviceId)
        put("fromDeviceName", transfer.fromDeviceName)
        transfer.toDeviceId?.let { put("toDeviceId", it) }
        transfer.toDeviceName?.let { put("toDeviceName", it) }
        put("provider", transfer.provider)
        put("status", transfer.status)
        transfer.bytesTotal?.let { put("bytesTotal", it) }
        transfer.bytesTransferred?.let { put("bytesTransferred", it) }
        put("createdAt", transfer.createdAt)
        transfer.completedAt?.let { put("completedAt", it) }
        transfer.driveFileId?.let { put("driveFileId", it) }
        transfer.lastError?.let { put("lastError", it) }
        put("updatedAt", transfer.updatedAt)
    })

    private fun stringArray(values: List<String>) = JsonArray(values.map(::JsonPrimitive))

    private fun canonicalizeJavaScriptNumber(source: String): String {
        val decimal = source.toBigDecimalOrNull()
            ?: throw IllegalArgumentException("JSON number is invalid: $source")
        val number = source.toDoubleOrNull()
        require(number != null && number.isFinite()) { "JSON number is outside the finite JavaScript Number range: $source" }
        val roundTripped = BigDecimal.valueOf(number)
        require(decimal.compareTo(roundTripped) == 0) {
            "JSON number cannot be represented losslessly by JavaScript Number: $source"
        }
        if (number == 0.0) return "0"

        val normalized = roundTripped.stripTrailingZeros()
        val absolute = normalized.abs()
        if (absolute >= BigDecimal("1e21") || absolute < BigDecimal("1e-6")) {
            val digits = normalized.unscaledValue().abs().toString()
            val exponent = digits.length - 1 - normalized.scale()
            val fraction = digits.drop(1).trimEnd('0')
            val mantissa = buildString {
                if (normalized.signum() < 0) append('-')
                append(digits.first())
                if (fraction.isNotEmpty()) append('.').append(fraction)
            }
            return "$mantissa" + "e" + if (exponent >= 0) "+$exponent" else exponent.toString()
        }
        return normalized.toPlainString()
    }
}
