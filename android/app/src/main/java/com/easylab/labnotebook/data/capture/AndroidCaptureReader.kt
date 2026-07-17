package com.easylab.labnotebook.data.capture

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AndroidCaptureReader(
    context: Context,
    private val limits: CaptureLimits = CaptureLimits(),
) {
    private val resolver = context.applicationContext.contentResolver

    suspend fun read(uris: List<Uri>): List<CaptureFile> = withContext(Dispatchers.IO) {
        require(uris.isNotEmpty()) { "Choose at least one file." }
        require(uris.size <= limits.maxFiles) { "Choose no more than ${limits.maxFiles} files at once." }
        var batchBytes = 0L
        uris.map { uri ->
            require(uri.scheme == "content") { "Only securely shared files can be added." }
            val metadata = resolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null,
            )?.use { cursor ->
                if (!cursor.moveToFirst()) null else CaptureMetadata(
                    filename = cursor.stringOrNull(OpenableColumns.DISPLAY_NAME),
                    declaredBytes = cursor.longOrNull(OpenableColumns.SIZE)?.takeIf { it >= 0 },
                )
            }
            val filename = metadata?.filename.orEmpty().ifBlank { "evidence" }
            metadata?.declaredBytes?.let { declaredBytes ->
                require(declaredBytes in 0..limits.maxFileBytes.toLong()) { "$filename is too large." }
                require(batchBytes + declaredBytes <= limits.maxBatchBytes) {
                    "The selected files are too large in total."
                }
            }
            val bytes = checkNotNull(resolver.openInputStream(uri)) { "$filename could not be opened." }
                .use { stream ->
                    stream.readAtMost(
                        maxBytes = limits.maxFileBytes,
                        remainingBatchBytes = limits.maxBatchBytes - batchBytes,
                        filename = filename,
                    )
                }
            batchBytes += bytes.size
            CaptureFile(
                filename = filename,
                mimeType = resolver.getType(uri).orEmpty().ifBlank { "application/octet-stream" },
                bytes = bytes,
            )
        }
    }
}

private data class CaptureMetadata(
    val filename: String?,
    val declaredBytes: Long?,
)

private fun android.database.Cursor.stringOrNull(columnName: String): String? {
    val index = getColumnIndex(columnName)
    return if (index >= 0 && !isNull(index)) getString(index) else null
}

private fun android.database.Cursor.longOrNull(columnName: String): Long? {
    val index = getColumnIndex(columnName)
    return if (index >= 0 && !isNull(index)) getLong(index) else null
}

private fun InputStream.readAtMost(
    maxBytes: Int,
    remainingBatchBytes: Long,
    filename: String,
): ByteArray {
    val allowed = minOf(maxBytes.toLong(), remainingBatchBytes)
    require(allowed > 0) { "The selected files are too large in total." }
    val output = ByteArrayOutputStream(minOf(allowed, DEFAULT_BUFFER_SIZE.toLong()).toInt())
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        require(total <= maxBytes) { "$filename is too large." }
        require(total <= remainingBatchBytes) { "The selected files are too large in total." }
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}
