package com.easylab.labnotebook.data.migration

import android.util.Base64
import com.easylab.labnotebook.sync.DriveV1Attachment
import com.easylab.labnotebook.sync.DriveV1Conflict
import com.easylab.labnotebook.sync.DriveV1Device
import com.easylab.labnotebook.sync.DriveV1Entry
import com.easylab.labnotebook.sync.DriveV1FileBoxItem
import com.easylab.labnotebook.sync.DriveV1Hashing
import com.easylab.labnotebook.sync.DriveV1Json
import com.easylab.labnotebook.sync.DriveV1Tombstone
import com.easylab.labnotebook.sync.DriveV1Transfer
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString

/**
 * Wire-compatible with the existing web JournalBackupDocument. This is a one-time
 * migration input, not a second Drive format.
 */
@Serializable
data class LegacyWorkspaceExportV1(
    val version: Int,
    val app: String,
    val exportedAt: String,
    val snapshot: LegacyWorkspaceSnapshotV1,
    val blobs: List<LegacyWorkspaceBlobV1>,
) {
    fun requireValid(): LegacyWorkspaceExportV1 = apply {
        require(version == 1) { "Legacy export version must be 1." }
        require(app == APP_ID) { "Legacy export is not an Easylab Lab Notebook backup." }
        requireIsoTimestamp(exportedAt, "Legacy export exportedAt")
        snapshot.requireValid()
        blobs.requireUniqueIds("Legacy blob")
        blobs.forEach(LegacyWorkspaceBlobV1::requireValid)

        val blobsById = blobs.associateBy { it.id }
        snapshot.attachments.forEach { attachment ->
            val blob = attachment.legacyBlobKeyCandidates()
                .firstNotNullOfOrNull(blobsById::get)
                ?: return@forEach
            attachment.sha256?.let { expected ->
                require(expected.equals(blob.sha256, ignoreCase = true)) {
                    "Legacy attachment ${attachment.id} and blob ${blob.id} have different hashes."
                }
            }
        }
    }

    companion object {
        const val APP_ID = "easylab-lab-notebook"

        fun parse(rawJson: String): LegacyWorkspaceExportV1 {
            require(rawJson.isNotBlank()) { "Legacy export is empty." }
            return DriveV1Json.format.decodeFromString<LegacyWorkspaceExportV1>(rawJson).requireValid()
        }
    }
}

@Serializable
data class LegacyWorkspaceSnapshotV1(
    val entries: Map<String, DriveV1Entry>,
    val attachments: List<DriveV1Attachment>,
    val fileBoxItems: List<DriveV1FileBoxItem>,
    val transfers: List<DriveV1Transfer>,
    val conflicts: List<DriveV1Conflict>,
    val tombstones: List<DriveV1Tombstone>,
    val device: DriveV1Device? = null,
) {
    fun requireValid(): LegacyWorkspaceSnapshotV1 = apply {
        entries.forEach { (key, entry) ->
            entry.requireV1()
            require(key == entry.id) { "Legacy entry map key must match entry id ${entry.id}." }
        }
        attachments.requireUniqueIds("Legacy attachment")
        attachments.forEach(DriveV1Attachment::requireV1)
        fileBoxItems.requireUniqueIds("Legacy File Box item")
        fileBoxItems.forEach(DriveV1FileBoxItem::requireV1)
        transfers.requireUniqueIds("Legacy transfer")
        transfers.forEach(DriveV1Transfer::requireV1)
        conflicts.requireUniqueIds("Legacy conflict")
        conflicts.forEach(DriveV1Conflict::requireV1)
        tombstones.requireUniqueIds("Legacy tombstone")
        tombstones.forEach(DriveV1Tombstone::requireV1)
        require(tombstones.map { it.entityKind to it.entityId }.toSet().size == tombstones.size) {
            "Legacy tombstone targets must be unique."
        }
        device?.requireV1()
        requireGraph()
    }

    private fun requireGraph() {
        val entryIds = entries.keys
        val attachmentIds = attachments.mapTo(hashSetOf()) { it.id }
        val fileBoxIds = fileBoxItems.mapTo(hashSetOf()) { it.id }
        attachments.forEach { attachment ->
            require(attachment.entryId in entryIds) {
                "Legacy attachment ${attachment.id} references missing entry ${attachment.entryId}."
            }
        }
        fileBoxItems.forEach { item ->
            require(item.entryId in entryIds) {
                "Legacy File Box item ${item.id} references missing entry ${item.entryId}."
            }
            require(item.attachmentId == null || item.attachmentId in attachmentIds) {
                "Legacy File Box item ${item.id} references missing attachment ${item.attachmentId}."
            }
        }
        transfers.forEach { transfer ->
            require(transfer.entryId == null || transfer.entryId in entryIds) {
                "Legacy transfer ${transfer.id} references missing entry ${transfer.entryId}."
            }
            require(transfer.attachmentId == null || transfer.attachmentId in attachmentIds) {
                "Legacy transfer ${transfer.id} references missing attachment ${transfer.attachmentId}."
            }
            require(transfer.fileBoxItemId == null || transfer.fileBoxItemId in fileBoxIds) {
                "Legacy transfer ${transfer.id} references missing File Box item ${transfer.fileBoxItemId}."
            }
        }
    }
}

@Serializable
data class LegacyWorkspaceBlobV1(
    val id: String,
    val sha256: String,
    val size: Long,
    val mimeType: String,
    val updatedAt: String,
    val dataBase64: String,
) {
    fun requireValid(): LegacyWorkspaceBlobV1 = apply {
        require(id.isNotBlank()) { "Legacy blob id is required." }
        require(SHA256.matches(sha256)) { "Legacy blob $id has an invalid SHA-256." }
        require(size >= 0) { "Legacy blob $id has an invalid size." }
        require(mimeType.isNotBlank()) { "Legacy blob $id has no MIME type." }
        requireIsoTimestamp(updatedAt, "Legacy blob $id updatedAt")
        val decoded = decodedBytes()
        require(decoded.size.toLong() == size) { "Legacy blob $id size does not match its payload." }
        require(DriveV1Hashing.sha256(decoded).equals(sha256, ignoreCase = true)) {
            "Legacy blob $id hash does not match its payload."
        }
    }

    fun decodedBytes(): ByteArray = try {
        Base64.decode(dataBase64, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
        throw IllegalArgumentException("Legacy blob $id is not valid base64.", error)
    }

    private companion object {
        val SHA256 = Regex("^[0-9a-fA-F]{64}$")
    }
}

internal fun DriveV1Attachment.legacyBlobKeyCandidates(): List<String> =
    listOfNotNull(cacheKey, "attachment-$id", id).distinct()

private fun <T> List<T>.requireUniqueIds(label: String) where T : Any {
    val ids = map {
        when (it) {
            is DriveV1Attachment -> it.id
            is DriveV1FileBoxItem -> it.id
            is DriveV1Transfer -> it.id
            is DriveV1Conflict -> it.id
            is DriveV1Tombstone -> it.id
            is LegacyWorkspaceBlobV1 -> it.id
            else -> error("Unsupported legacy id type.")
        }
    }
    require(ids.size == ids.toSet().size) { "$label ids must be unique." }
}

private val ISO_TIMESTAMP =
    Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$""")

private fun requireIsoTimestamp(value: String, label: String) {
    val match = ISO_TIMESTAMP.matchEntire(value)
        ?: throw IllegalArgumentException("$label must be an ISO timestamp.")
    val values = match.groupValues
    val year = values[1].toInt()
    val month = values[2].toInt()
    val day = values[3].toInt()
    val maxDay = when (month) {
        1, 3, 5, 7, 8, 10, 12 -> 31
        4, 6, 9, 11 -> 30
        2 -> if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28
        else -> 0
    }
    require(day in 1..maxDay && values[4].toInt() in 0..23 &&
        values[5].toInt() in 0..59 && values[6].toInt() in 0..59 &&
        (values[7].isEmpty() || values[7].toInt() in 0..23 && values[8].toInt() in 0..59)
    ) { "$label must be an ISO timestamp." }
}
