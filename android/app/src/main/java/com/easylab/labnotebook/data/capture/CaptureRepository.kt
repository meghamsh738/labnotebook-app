package com.easylab.labnotebook.data.capture

import androidx.room.withTransaction
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.sync.DriveV1Hashing
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

const val CAPTURE_FILE_MAX_BYTES = 128 * 1024 * 1024
const val CAPTURE_BATCH_MAX_BYTES = 256 * 1024 * 1024
const val CAPTURE_BATCH_MAX_FILES = 20
private val CAPTURE_DATE_BUCKET = Regex("^\\d{4}-\\d{2}-\\d{2}$")

data class CaptureFile(
    val filename: String,
    val mimeType: String,
    val bytes: ByteArray,
)

data class CaptureResult(
    val entry: JournalEntryEntity,
    val attachments: List<AttachmentEntity>,
)

data class CaptureLimits(
    val maxFileBytes: Int = CAPTURE_FILE_MAX_BYTES,
    val maxBatchBytes: Long = CAPTURE_BATCH_MAX_BYTES.toLong(),
    val maxFiles: Int = CAPTURE_BATCH_MAX_FILES,
)

interface CaptureRepository {
    suspend fun attachToToday(
        accountId: AccountId,
        activeDeviceId: String,
        dateBucket: String,
        capturedAt: String,
        files: List<CaptureFile>,
    ): CaptureResult
}

class RoomCaptureRepository(
    private val database: LabNotebookDatabase,
    private val blobStore: CaptureBlobStore,
    private val limits: CaptureLimits = CaptureLimits(),
) : CaptureRepository {
    override suspend fun attachToToday(
        accountId: AccountId,
        activeDeviceId: String,
        dateBucket: String,
        capturedAt: String,
        files: List<CaptureFile>,
    ): CaptureResult {
        require(activeDeviceId.isNotBlank()) { "Active device id must not be blank." }
        require(dateBucket.isStrictDateBucket()) {
            "Capture date must use yyyy-MM-dd."
        }
        require(capturedAt.isNotBlank()) { "Capture timestamp must not be blank." }
        require(files.isNotEmpty()) { "Choose at least one file." }
        require(files.size <= limits.maxFiles) { "Choose no more than ${limits.maxFiles} files at once." }
        var totalBytes = 0L
        files.forEach { file ->
            require(file.filename.isNotBlank()) { "Captured filename must not be blank." }
            require(file.mimeType.isNotBlank()) { "Captured file type must not be blank." }
            require(file.bytes.isNotEmpty()) { "${file.filename} is empty." }
            require(file.bytes.size <= limits.maxFileBytes) { "${file.filename} is too large." }
            totalBytes += file.bytes.size
            require(totalBytes <= limits.maxBatchBytes) { "The selected files are too large in total." }
        }

        val initialEntry = database.dao().entryForDate(accountId.value, dateBucket)
        val entryId = initialEntry?.id ?: UUID.randomUUID().toString()
        val prepared = files.map { file ->
            val attachmentId = "att-${UUID.randomUUID()}"
            PreparedCapture(
                attachmentId = attachmentId,
                file = file,
                sha256 = DriveV1Hashing.sha256(file.bytes),
                storagePath = "$dateBucket-${entryId.removePrefix("entry-").take(8)}/attachments/" +
                    "$attachmentId-${safeFileName(file.filename)}",
            )
        }
        val stored = mutableListOf<StoredCaptureBlob>()

        try {
            prepared.forEach { capture ->
                stored += blobStore.put(accountId, capture.attachmentId, capture.file.bytes, capture.sha256)
            }
            return database.withTransaction {
                val dao = database.dao()
                val currentEntry = dao.entryForDate(accountId.value, dateBucket)
                check(currentEntry?.id == initialEntry?.id && currentEntry?.version == initialEntry?.version) {
                    "Today's entry changed while files were being prepared. Try again."
                }
                val attachmentIds = prepared.map { it.attachmentId }
                val existingLinked = initialEntry?.linkedFilesJson.toStringList()
                val stagedEntry = if (initialEntry == null) {
                    JournalEntryEntity(
                        accountId = accountId.value,
                        id = entryId,
                        title = "Today's note",
                        dateBucket = dateBucket,
                        createdAt = capturedAt,
                        updatedAt = capturedAt,
                        authorId = accountId.value,
                        contentJson = "[]",
                        version = 1,
                        updatedByDeviceId = activeDeviceId,
                        syncStatus = "queued",
                        isDaily = true,
                        linkedFilesJson = json.encodeToString(attachmentIds),
                    )
                } else {
                    initialEntry.copy(
                        linkedFilesJson = json.encodeToString((existingLinked + attachmentIds).distinct()),
                        updatedAt = capturedAt,
                        updatedByDeviceId = activeDeviceId,
                        version = initialEntry.version + 1,
                        syncStatus = "queued",
                    )
                }
                val queuedEntry = dao.stageEntryUpsert(stagedEntry, capturedAt)
                val attachments = prepared.mapIndexed { index, capture ->
                    val file = capture.file
                    val cached = stored[index]
                    dao.stageAttachmentUpsert(
                        AttachmentEntity(
                            accountId = accountId.value,
                            id = capture.attachmentId,
                            entryId = queuedEntry.id,
                            type = attachmentType(file.mimeType),
                            filename = file.filename.trim(),
                            displaySize = displaySize(file.bytes.size.toLong()),
                            byteSize = file.bytes.size.toLong(),
                            storagePath = capture.storagePath,
                            mimeType = file.mimeType,
                            sha256 = capture.sha256,
                            pinnedOffline = true,
                            syncStatus = "queued",
                            createdAt = capturedAt,
                            updatedAt = capturedAt,
                            cachedPath = cached.path,
                            source = "android",
                            contentType = file.mimeType,
                            cacheKey = "attachment-${capture.attachmentId}",
                        ),
                        queuedAt = capturedAt,
                        updatedByDeviceId = activeDeviceId,
                    )
                }
                CaptureResult(queuedEntry, attachments)
            }
        } catch (error: Throwable) {
            stored.asReversed().forEach { blob -> runCatching { blobStore.removeIfCreated(blob) } }
            throw error
        }
    }

    private data class PreparedCapture(
        val attachmentId: String,
        val file: CaptureFile,
        val sha256: String,
        val storagePath: String,
    )

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}

private fun String.isStrictDateBucket(): Boolean {
    if (!CAPTURE_DATE_BUCKET.matches(this)) return false
    val parser = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { isLenient = false }
    return runCatching { parser.parse(this) }
        .getOrNull()
        ?.let { parser.format(it) == this } == true
}

private fun String?.toStringList(): List<String> = runCatching {
    if (isNullOrBlank()) emptyList() else Json.decodeFromString<List<String>>(this)
}.getOrDefault(emptyList())

private fun safeFileName(value: String): String = value.trim()
    .replace(Regex("[\\\\/:*?\"<>|]+"), "_")
    .replace(Regex("\\s+"), "_")
    .replace(Regex("[^a-zA-Z0-9._()-]+"), "_")
    .trim('_')
    .ifBlank { "file" }

private fun attachmentType(mimeType: String): String = when {
    mimeType.startsWith("image/") -> "image"
    mimeType == "application/pdf" -> "pdf"
    else -> "file"
}

private fun displaySize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}
