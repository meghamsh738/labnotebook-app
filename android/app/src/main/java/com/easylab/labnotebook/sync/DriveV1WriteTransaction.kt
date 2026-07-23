package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveProtocolException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/**
 * Conditional write surface used only by the unwired native Drive transaction path.
 *
 * Production sync continues to construct [GoogleDriveReadOnlyRepository].
 */
internal interface DriveConditionalWriteClient {
    suspend fun putJsonConditional(
        accountId: AccountId,
        path: String,
        json: String,
        precondition: DriveWritePrecondition,
    ): Result<DriveFileRef>

    suspend fun putBlobConditional(
        accountId: AccountId,
        path: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String,
        precondition: DriveWritePrecondition,
    ): Result<DriveFileRef>
}

internal sealed interface DriveV1TransactionWrite {
    val path: String
    val precondition: DriveWritePrecondition

    data class Json(
        override val path: String,
        val json: String,
        override val precondition: DriveWritePrecondition,
    ) : DriveV1TransactionWrite

    data class Blob(
        override val path: String,
        val bytes: ByteArray,
        val mimeType: String,
        val sha256: String,
        override val precondition: DriveWritePrecondition,
    ) : DriveV1TransactionWrite {
        override fun equals(other: Any?): Boolean =
            other is Blob &&
                path == other.path &&
                bytes.contentEquals(other.bytes) &&
                mimeType == other.mimeType &&
                sha256 == other.sha256 &&
                precondition == other.precondition

        override fun hashCode(): Int {
            var result = path.hashCode()
            result = 31 * result + bytes.contentHashCode()
            result = 31 * result + mimeType.hashCode()
            result = 31 * result + sha256.hashCode()
            result = 31 * result + precondition.hashCode()
            return result
        }
    }
}

internal data class DriveV1WriteTransaction(
    val accountId: AccountId,
    val prerequisites: List<DriveV1TransactionWrite>,
    val manifest: DriveV1TransactionWrite.Json,
) {
    init {
        require(manifest.path == DriveV1Paths.manifest) {
            "Drive v1 transaction manifest must use ${DriveV1Paths.manifest}."
        }
        require(prerequisites.none { it.path == DriveV1Paths.manifest }) {
            "Drive v1 transaction prerequisites cannot contain the manifest."
        }
        val allPaths = prerequisites.map(DriveV1TransactionWrite::path) + manifest.path
        require(allPaths.all(String::isNotBlank)) { "Drive v1 transaction paths must not be blank." }
        require(allPaths.distinct().size == allPaths.size) {
            "Drive v1 transaction paths must be unique."
        }
        prerequisites.forEach(::validateWrite)
        validateWrite(manifest)
    }

    private fun validateWrite(write: DriveV1TransactionWrite) {
        require(write.precondition is DriveWritePrecondition.MustMatch) {
            "Drive v1 conditional creation is disabled until idempotent creation is implemented: ${write.path}"
        }
        validateManagedPath(write.path, requireJson = write is DriveV1TransactionWrite.Json)
        when (write) {
            is DriveV1TransactionWrite.Json -> {
                require(write.json.toByteArray(StandardCharsets.UTF_8).size <= MAX_MULTIPART_BYTES) {
                    "Drive v1 transaction JSON exceeds the safe size limit: ${write.path}"
                }
                val value = runCatching { DriveV1Json.format.parseToJsonElement(write.json) }
                    .getOrElse { throw IllegalArgumentException("Drive v1 transaction JSON is invalid: ${write.path}", it) }
                require(value is JsonObject) {
                    "Drive v1 transaction JSON must contain an object: ${write.path}"
                }
                validateDriveV1Json(write.path, write.json)
            }
            is DriveV1TransactionWrite.Blob -> {
                require(write.path.startsWith("attachments/") && !write.path.endsWith(".json", ignoreCase = true)) {
                    "Drive v1 transaction blob path must be attachment content: ${write.path}"
                }
                require(write.bytes.size <= MAX_MULTIPART_BYTES) {
                    "Drive v1 transaction blob requires resumable upload: ${write.path}"
                }
                val normalizedMimeType = write.mimeType.substringBefore(';').trim()
                require(normalizedMimeType.isNotBlank() && '/' in normalizedMimeType) {
                    "Drive v1 transaction blob MIME type is invalid: ${write.path}"
                }
                require(SHA256_REGEX.matches(write.sha256)) {
                    "Drive v1 transaction blob SHA-256 is invalid: ${write.path}"
                }
                require(sha256(write.bytes).equals(write.sha256, ignoreCase = true)) {
                    "Drive v1 transaction blob SHA-256 does not match its bytes: ${write.path}"
                }
            }
        }
    }

    private fun validateManagedPath(path: String, requireJson: Boolean) {
        require(path.length <= MAX_MANAGED_PATH_LENGTH && !path.startsWith('/') && !path.endsWith('/')) {
            "Drive v1 transaction path is invalid: $path"
        }
        val segments = path.split('/')
        require(
            segments.none { segment ->
                segment.isBlank() || segment in setOf(".", "..") || '\\' in segment ||
                    segment.length > MAX_PATH_SEGMENT_LENGTH || segment.any(Char::isISOControl)
            },
        ) {
            "Drive v1 transaction path contains an invalid segment: $path"
        }
        require(path == DriveV1Paths.manifest || MANAGED_PREFIXES.any(path::startsWith)) {
            "Drive v1 transaction path is outside the managed workspace: $path"
        }
        require(!requireJson || path.endsWith(".json", ignoreCase = true)) {
            "Drive v1 transaction JSON path must end in .json: $path"
        }
    }

    private fun validateDriveV1Json(path: String, rawJson: String) {
        when {
            path == DriveV1Paths.manifest -> {
                DriveV1Json.decodeLossless<DriveV1Manifest>(rawJson).value.requireV1()
            }
            path.startsWith("devices/") -> {
                val device = DriveV1Json.decodeLossless<DriveV1Device>(rawJson).value.requireV1()
                require(path == DriveV1Paths.device(device.id)) {
                    "Drive v1 device JSON path does not match its id: $path"
                }
            }
            path.startsWith("entries/") -> {
                val envelope = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Entry>>(rawJson)
                    .value
                    .requireV1("entry")
                val bucket = envelope.payload.dateBucket.ifEmpty {
                    envelope.payload.createdDatetime.take(10).ifEmpty { "undated" }
                }
                require(
                    path == DriveV1Paths.entry(envelope.payload) ||
                        path == DriveV1Paths.entry(bucket, envelope.payload.id),
                ) {
                    "Drive v1 entry JSON path does not match its payload: $path"
                }
            }
            path.startsWith("attachments/") -> {
                val envelope = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Attachment>>(rawJson)
                    .value
                    .requireV1("attachment")
                val suffix = "/${DriveV1Paths.safeSegment(envelope.payload.id, "attachment")}-" +
                    "${DriveV1Paths.safeSegment(envelope.payload.filename, "file")}.json"
                require(path.endsWith(suffix)) {
                    "Drive v1 attachment JSON path does not match its payload: $path"
                }
            }
            path.startsWith("filebox/") -> {
                val envelope = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1FileBoxItem>>(rawJson)
                    .value
                    .requireV1("fileBoxItem")
                require(path == DriveV1Paths.fileBox(envelope.payload.id)) {
                    "Drive v1 File Box JSON path does not match its payload: $path"
                }
            }
            path.startsWith("transfers/") -> {
                val envelope = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Transfer>>(rawJson)
                    .value
                    .requireV1("transfer")
                require(path == DriveV1Paths.transfer(envelope.payload.id)) {
                    "Drive v1 transfer JSON path does not match its payload: $path"
                }
            }
            path.startsWith("conflicts/") -> {
                val conflict = DriveV1Json.decodeLossless<DriveV1Conflict>(rawJson).value.requireV1()
                require(path == DriveV1Paths.conflict(conflict.id)) {
                    "Drive v1 conflict JSON path does not match its id: $path"
                }
            }
            path.startsWith("tombstones/") -> {
                val tombstone = DriveV1Json.decodeLossless<DriveV1Tombstone>(rawJson).value.requireV1()
                require(path == DriveV1Paths.tombstone(tombstone.entityKind, tombstone.entityId)) {
                    "Drive v1 tombstone JSON path does not match its target: $path"
                }
            }
            else -> error("Managed Drive v1 JSON path was not classified: $path")
        }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private companion object {
        const val MAX_MULTIPART_BYTES = 5 * 1024 * 1024
        const val MAX_MANAGED_PATH_LENGTH = 1024
        const val MAX_PATH_SEGMENT_LENGTH = 255
        val SHA256_REGEX = Regex("^[0-9a-fA-F]{64}$")
        val MANAGED_PREFIXES = listOf(
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

internal data class DriveV1WriteTransactionResult(
    val prerequisiteFiles: List<DriveFileRef>,
    val manifestFile: DriveFileRef,
)

internal class DriveV1WriteTransactionException(
    val failedPath: String,
    val completedFiles: List<DriveFileRef>,
    cause: Throwable,
) : Exception("Drive v1 transaction failed at $failedPath.", cause)

/**
 * Executes one bounded Drive publication.
 *
 * Tombstones are published first so stale entity JSON cannot resurrect deleted
 * records. Blobs are then made durable before JSON that can reference them. The
 * manifest is the final publication document and is never attempted after a
 * prerequisite failure. This ordering is a logical boundary, not an atomic Drive
 * transaction: readers can observe already-written prerequisites.
 */
internal class DriveV1WriteTransactionExecutor(
    private val writer: DriveConditionalWriteClient,
) {
    suspend fun execute(transaction: DriveV1WriteTransaction): Result<DriveV1WriteTransactionResult> = try {
        Result.success(
            executeOrThrow(transaction),
        )
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }

    private suspend fun executeOrThrow(
        transaction: DriveV1WriteTransaction,
    ): DriveV1WriteTransactionResult {
        val snapshot = transaction.snapshot()
        val ordered = snapshot.prerequisites
            .withIndex()
            .sortedWith(compareBy({ phase(it.value) }, { it.index }))
            .map { it.value }

        val completed = ArrayList<DriveFileRef>(ordered.size)
        for (write in ordered) {
            val file = try {
                writer.write(snapshot.accountId, write).getOrThrow()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                throw DriveV1WriteTransactionException(write.path, completed.toList(), error)
            }
            if (file.path != write.path) {
                throw DriveV1WriteTransactionException(
                    failedPath = write.path,
                    completedFiles = completed.toList(),
                    cause = DriveProtocolException(
                        "Drive transaction returned an unexpected path for ${write.path}.",
                    ),
                )
            }
            completed += file
        }
        val manifest = try {
            writer.write(snapshot.accountId, snapshot.manifest).getOrThrow()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            throw DriveV1WriteTransactionException(
                failedPath = snapshot.manifest.path,
                completedFiles = completed.toList(),
                cause = error,
            )
        }
        if (manifest.path != DriveV1Paths.manifest) {
            throw DriveV1WriteTransactionException(
                failedPath = snapshot.manifest.path,
                completedFiles = completed.toList(),
                cause = DriveProtocolException("Drive transaction returned an unexpected manifest path."),
            )
        }
        return DriveV1WriteTransactionResult(
            prerequisiteFiles = completed,
            manifestFile = manifest,
        )
    }

    private fun DriveV1WriteTransaction.snapshot(): DriveV1WriteTransaction =
        DriveV1WriteTransaction(
            accountId = accountId,
            prerequisites = prerequisites.map { write ->
                when (write) {
                    is DriveV1TransactionWrite.Json -> write.copy()
                    is DriveV1TransactionWrite.Blob -> write.copy(bytes = write.bytes.copyOf())
                }
            },
            manifest = manifest.copy(),
        )

    private fun phase(write: DriveV1TransactionWrite): Int = when {
        write.path.startsWith("tombstones/") -> 0
        write is DriveV1TransactionWrite.Blob -> 1
        else -> 2
    }

    private suspend fun DriveConditionalWriteClient.write(
        accountId: AccountId,
        write: DriveV1TransactionWrite,
    ): Result<DriveFileRef> = when (write) {
        is DriveV1TransactionWrite.Json -> putJsonConditional(
            accountId = accountId,
            path = write.path,
            json = write.json,
            precondition = write.precondition,
        )
        is DriveV1TransactionWrite.Blob -> putBlobConditional(
            accountId = accountId,
            path = write.path,
            bytes = write.bytes,
            mimeType = write.mimeType,
            sha256 = write.sha256,
            precondition = write.precondition,
        )
    }
}
