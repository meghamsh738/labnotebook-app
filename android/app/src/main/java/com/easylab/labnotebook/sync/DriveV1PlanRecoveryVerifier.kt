package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveRepository
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject

internal fun interface DriveV1RemoteContentHasher {
    suspend fun sha256(accountId: AccountId, file: DriveFileRef): Result<String>
}

/**
 * Concrete read-only verifier for an immutable durable plan. Its baseline file
 * inventory is the complete verified listing captured before the first write.
 * Any unrelated addition, removal, duplicate, identity change, or version
 * change fails closed. This means a temporary manifest/count mismatch is
 * accepted only when the listing difference is exactly one of this plan's
 * create-only paths; all other paths must remain at their captured versions.
 */
internal class DriveV1PlanRecoveryVerifier(
    private val repository: DriveRepository,
    private val contentHasher: DriveV1RemoteContentHasher,
) : DriveV1RecoveryVerifier {
    override suspend fun validatePlanScope(
        accountId: AccountId,
        plan: DriveV1DurableTransactionPlan,
    ): Result<Unit> = recoveryResult {
        require(plan.baselineFiles.isNotEmpty()) { "Durable repair requires a complete verified remote inventory." }
        val baseline = plan.baselineFiles.associateBy { it.path }
        require(DriveV1Paths.manifest in baseline) { "Durable repair baseline is missing manifest.json." }
        val writes = (plan.prerequisites + plan.manifest).associateBy { it.path }
        val current = uniqueListing(accountId).associateBy { it.path }
        val allowedCreatePaths = writes.values.filter {
            it.precondition.kind == "must-not-exist"
        }.mapTo(hashSetOf()) { it.path }

        val unexpected = current.keys - baseline.keys - allowedCreatePaths
        require(unexpected.isEmpty()) {
            "Drive repair found unexplained managed paths: ${unexpected.sorted().joinToString()}."
        }
        val missing = baseline.keys - current.keys
        require(missing.isEmpty()) {
            "Drive repair found unexplained missing managed paths: ${missing.sorted().joinToString()}."
        }

        baseline.forEach { (path, expected) ->
            val actual = current.getValue(path)
            val planned = writes[path]
            require(actual.id == expected.fileId) { "Drive repair file identity changed: $path" }
            require(actual.version != null && actual.version > 0L) { "Drive repair target has no positive version: $path" }
            if (planned == null) {
                require(matchesBaseline(actual, expected)) { "Unplanned Drive file changed during repair: $path" }
            } else if (planned.precondition.kind == "must-match") {
                require(planned.precondition.fileId == expected.fileId) {
                    "Durable repair precondition does not match its captured file: $path"
                }
                require(planned.precondition.version == expected.version) {
                    "Durable repair precondition does not match its captured version: $path"
                }
                require(requireNotNull(actual.version) >= expected.version) {
                    "Drive repair target version moved backwards: $path"
                }
            } else {
                error("A create-only write unexpectedly occupied its baseline path: $path")
            }
        }
    }

    override suspend fun check(
        accountId: AccountId,
        write: DriveV1DurableWrite,
        receipt: DriveV1VerifiedWriteReceipt?,
    ): DriveV1RecoveryCheck {
        val firstListing = try {
            uniqueListing(accountId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return DriveV1RecoveryCheck.Blocked(error.message ?: "Drive repair listing failed.")
        }
        val remote = firstListing.singleOrNull { it.path == write.path }
        if (remote == null) {
            return when {
                receipt != null -> DriveV1RecoveryCheck.Blocked(
                    "A previously verified Drive write disappeared: ${write.path}",
                )
                write.precondition.kind == "must-not-exist" -> DriveV1RecoveryCheck.ReadyToWrite
                else -> DriveV1RecoveryCheck.Blocked("Existing Drive target is missing: ${write.path}")
            }
        }
        val version = remote.version?.takeIf { it > 0L }
            ?: return DriveV1RecoveryCheck.Blocked("Drive repair target has no positive version: ${write.path}")
        val content = try {
            verifyContent(accountId, write, remote)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return DriveV1RecoveryCheck.Blocked(error.message ?: "Drive repair content verification failed.")
        }
        val stable = try {
            uniqueListing(accountId).singleOrNull { it.path == write.path }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return DriveV1RecoveryCheck.Blocked(error.message ?: "Drive repair stability check failed.")
        }
        if (stable != remote) {
            return DriveV1RecoveryCheck.Blocked("Drive target changed during repair verification: ${write.path}")
        }

        if (receipt != null) {
            return if (
                remote.id == receipt.fileId &&
                version == receipt.version &&
                receipt.contentSha256 == write.contentSha256 &&
                content.sha256 == write.contentSha256 &&
                content.metadataExact
            ) {
                DriveV1RecoveryCheck.Exact(remote)
            } else {
                DriveV1RecoveryCheck.Blocked("A verified Drive receipt no longer matches: ${write.path}")
            }
        }

        return when (val precondition = write.precondition.toRuntime()) {
            DriveWritePrecondition.MustNotExist -> if (
                content.sha256 == write.contentSha256 && content.metadataExact
            ) {
                DriveV1RecoveryCheck.Exact(remote)
            } else {
                DriveV1RecoveryCheck.Blocked("Create-only Drive path has a different occupant: ${write.path}")
            }
            is DriveWritePrecondition.MustMatch -> when {
                remote.id != precondition.fileId ->
                    DriveV1RecoveryCheck.Blocked("Drive target identity changed: ${write.path}")
                version < precondition.version ->
                    DriveV1RecoveryCheck.Blocked("Drive target version moved backwards: ${write.path}")
                content.sha256 == write.contentSha256 && content.metadataExact -> DriveV1RecoveryCheck.Exact(remote)
                content.sha256 == write.contentSha256 ->
                    DriveV1RecoveryCheck.Blocked("Drive content matches but managed metadata differs: ${write.path}")
                version == precondition.version && write.kind == "blob" &&
                    content.sha256 == write.baselineContentSha256 && content.baselineMetadataExact ->
                    DriveV1RecoveryCheck.ReadyToWrite
                version == precondition.version && write.kind == "blob" ->
                    DriveV1RecoveryCheck.Blocked(
                        "Existing Drive blob no longer matches its verified attachment baseline: ${write.path}",
                    )
                version == precondition.version -> DriveV1RecoveryCheck.ReadyToWrite
                else -> DriveV1RecoveryCheck.Blocked("Drive target changed outside the durable plan: ${write.path}")
            }
        }
    }

    private suspend fun verifyContent(
        accountId: AccountId,
        write: DriveV1DurableWrite,
        remote: DriveFileRef,
    ): VerifiedContent = when (write.kind) {
        "json" -> {
            val raw = repository.readJson(accountId, write.path).getOrThrow()
                ?: error("Managed Drive JSON disappeared during repair: ${write.path}")
            val expectedProperties = validateJson(write, raw)
            VerifiedContent(
                sha256 = sha256(raw.toByteArray(StandardCharsets.UTF_8)),
                metadataExact = normalizedMimeType(remote.mimeType) == "application/json" &&
                    remote.appProperties == expectedProperties,
                baselineMetadataExact = true,
            )
        }
        "blob" -> {
            require(remote.size == write.byteCount) { "Drive blob size changed: ${write.path}" }
            require(normalizedMimeType(remote.mimeType) == normalizedMimeType(write.mimeType)) {
                "Drive blob MIME type changed: ${write.path}"
            }
            VerifiedContent(
                sha256 = contentHasher.sha256(accountId, remote).getOrThrow().lowercase(),
                metadataExact = remote.appProperties == mapOf(
                    "entityType" to "attachmentBlob",
                    "sha256" to write.contentSha256,
                ),
                baselineMetadataExact = write.baselineContentSha256?.let { baselineDigest ->
                    remote.appProperties == mapOf(
                        "entityType" to "attachmentBlob",
                        "sha256" to baselineDigest,
                    )
                } ?: false,
            )
        }
        else -> error("Unsupported durable write kind: ${write.kind}")
    }

    private fun validateJson(write: DriveV1DurableWrite, raw: String): Map<String, String> {
        val parsed = DriveV1Json.format.parseToJsonElement(raw)
        require(parsed is JsonObject) { "Managed Drive JSON is not an object: ${write.path}" }
        return when (write.baselineEntityKind) {
            "manifest" -> {
                DriveV1Json.format.decodeFromString<DriveV1Manifest>(raw).requireV1()
                mapOf("entityType" to "manifest")
            }
            "entry" -> DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1Entry>>(raw)
                .requireV1("entry").let { value ->
                    mapOf(
                        "entityType" to "entry",
                        "entityId" to value.id,
                        "contentHash" to DriveV1Hashing.entryContentHash(value.payload),
                    )
                }
            "attachment" -> DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(raw)
                .requireV1("attachment").let { value ->
                    mapOf(
                        "entityType" to "attachment",
                        "entityId" to value.id,
                        "contentHash" to DriveV1Hashing.attachmentMetadataHash(value.payload),
                    )
                }
            "fileBoxItem" -> DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(raw)
                .requireV1("fileBoxItem").let { value ->
                    mapOf(
                        "entityType" to "fileBoxItem",
                        "entityId" to value.id,
                        "contentHash" to DriveV1Hashing.fileBoxMetadataHash(value.payload),
                    )
                }
            "transfer" -> DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(raw)
                .requireV1("transfer").let { value ->
                    mapOf(
                        "entityType" to "transfer",
                        "entityId" to value.id,
                        "contentHash" to DriveV1Hashing.transferMetadataHash(value.payload),
                    )
                }
            "device" -> DriveV1Json.format.decodeFromString<DriveV1Device>(raw).requireV1().let { value ->
                mapOf("entityType" to "device", "entityId" to value.id)
            }
            "conflict" -> DriveV1Json.format.decodeFromString<DriveV1Conflict>(raw).requireV1().let { value ->
                mapOf("entityType" to "conflict", "entityId" to value.entityId)
            }
            "tombstone" -> DriveV1Json.format.decodeFromString<DriveV1Tombstone>(raw).requireV1().let { value ->
                mapOf("entityType" to "tombstone", "entityId" to value.entityId)
            }
            else -> error("Durable JSON has no supported semantic type: ${write.path}")
        }
    }

    private suspend fun uniqueListing(accountId: AccountId): List<DriveFileRef> {
        val files = repository.listManagedFiles(accountId).getOrThrow()
        val duplicates = files.groupBy { it.path }.filterValues { it.size != 1 }.keys
        require(duplicates.isEmpty()) { "Drive repair found duplicate managed paths: ${duplicates.sorted().joinToString()}." }
        return files.sortedBy { it.path }
    }

    private fun matchesBaseline(actual: DriveFileRef, expected: DriveV1DurableRemoteFile): Boolean =
        actual.id == expected.fileId &&
            actual.version == expected.version &&
            actual.mimeType == expected.mimeType &&
            actual.size == expected.byteCount &&
            actual.appProperties == expected.appProperties

    private fun normalizedMimeType(value: String?): String =
        value?.substringBefore(';')?.trim()?.lowercase().orEmpty()

    private data class VerifiedContent(
        val sha256: String,
        val metadataExact: Boolean,
        val baselineMetadataExact: Boolean,
    )

    private suspend fun <T> recoveryResult(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
