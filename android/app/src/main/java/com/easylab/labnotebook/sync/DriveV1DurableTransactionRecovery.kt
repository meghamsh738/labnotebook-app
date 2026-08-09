package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.DriveWriteOperationEntity
import com.easylab.labnotebook.data.local.DriveWritePayloadEntity
import com.easylab.labnotebook.data.local.LabNotebookDao
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.requireCanonicalQueueTimestamp
import com.easylab.labnotebook.data.repository.DriveFileRef
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val DURABLE_JSON = Json {
    encodeDefaults = true
    explicitNulls = true
    ignoreUnknownKeys = false
}

private val DURABLE_SHA256 = Regex("^[0-9a-f]{64}$")

@Serializable
internal data class DriveV1DurablePrecondition(
    val kind: String,
    val fileId: String? = null,
    val version: Long? = null,
) {
    init {
        when (kind) {
            "must-not-exist" -> require(fileId == null && version == null) {
                "A create-only durable precondition cannot contain an existing target."
            }
            "must-match" -> {
                require(!fileId.isNullOrBlank()) { "A durable update precondition requires a file id." }
                require(version != null && version > 0L) { "A durable update precondition requires a positive version." }
            }
            else -> throw IllegalArgumentException("Unsupported durable Drive precondition: $kind")
        }
    }

    fun toRuntime(): DriveWritePrecondition = when (kind) {
        "must-not-exist" -> DriveWritePrecondition.MustNotExist
        "must-match" -> DriveWritePrecondition.MustMatch(requireNotNull(fileId), requireNotNull(version))
        else -> error("Unsupported durable Drive precondition: $kind")
    }

    companion object {
        fun from(value: DriveWritePrecondition): DriveV1DurablePrecondition = when (value) {
            DriveWritePrecondition.MustNotExist -> DriveV1DurablePrecondition("must-not-exist")
            is DriveWritePrecondition.MustMatch -> DriveV1DurablePrecondition(
                kind = "must-match",
                fileId = value.fileId,
                version = value.version,
            )
        }
    }
}

/**
 * Persistable description of one write. Blob bytes are deliberately represented
 * by an account-scoped local content key and an immutable digest, never embedded
 * in the operation journal.
 */
@Serializable
internal data class DriveV1DurableWrite(
    val kind: String,
    val path: String,
    val contentSha256: String,
    val precondition: DriveV1DurablePrecondition,
    val localJsonKey: String? = null,
    val localBlobKey: String? = null,
    val mimeType: String? = null,
    val byteCount: Long? = null,
    val resumableOperationId: String? = null,
    val baselineContentSha256: String? = null,
    val baselineEntityKind: String? = null,
    val baselineEntityId: String? = null,
) {
    init {
        require(path.isNotBlank()) { "A durable Drive write path must not be blank." }
        require(DURABLE_SHA256.matches(contentSha256)) { "A durable Drive write requires canonical SHA-256." }
        require(baselineContentSha256 == null || DURABLE_SHA256.matches(baselineContentSha256)) {
            "A durable Drive baseline digest requires canonical SHA-256."
        }
        require((baselineEntityKind == null) == (baselineEntityId == null)) {
            "A durable baseline identity must contain both kind and id."
        }
        when (kind) {
            "json" -> {
                require(!localJsonKey.isNullOrBlank() && localBlobKey == null && mimeType == null && byteCount == null) {
                    "A durable JSON write cannot contain blob fields."
                }
                require(resumableOperationId == null) { "A durable JSON write cannot be resumable." }
                require(baselineContentSha256 == null) { "A durable JSON write cannot contain a blob baseline digest." }
            }
            "blob" -> {
                require(localJsonKey == null && !localBlobKey.isNullOrBlank()) {
                    "A durable blob write requires an account-scoped local content key."
                }
                require(!mimeType.isNullOrBlank() && byteCount != null && byteCount >= 0L) {
                    "A durable blob write requires MIME type and byte count."
                }
                if (byteCount >= DriveV1DurableTransactionPlan.RESUMABLE_THRESHOLD_BYTES) {
                    require(!resumableOperationId.isNullOrBlank()) {
                        "A large durable blob write requires a stable resumable operation id."
                    }
                } else {
                    require(resumableOperationId == null) {
                        "A multipart durable blob write cannot contain a resumable operation id."
                    }
                }
                require(baselineEntityKind == null) { "Blob bytes are not raw JSON baselines." }
                if (precondition.kind == "must-match") {
                    require(baselineContentSha256 != null) {
                        "An existing durable blob write requires its verified baseline digest."
                    }
                } else {
                    require(baselineContentSha256 == null) {
                        "A create-only durable blob cannot contain an existing baseline digest."
                    }
                }
            }
            else -> throw IllegalArgumentException("Unsupported durable Drive write kind: $kind")
        }
    }

    companion object {
        fun json(
            path: String,
            json: String,
            localJsonKey: String,
            precondition: DriveWritePrecondition,
            baselineEntityKind: String,
            baselineEntityId: String,
        ) = DriveV1DurableWrite(
            kind = "json",
            path = path,
            contentSha256 = sha256(json.toByteArray(StandardCharsets.UTF_8)),
            precondition = DriveV1DurablePrecondition.from(precondition),
            localJsonKey = localJsonKey,
            baselineEntityKind = baselineEntityKind,
            baselineEntityId = baselineEntityId,
        )

        fun blob(
            path: String,
            localBlobKey: String,
            mimeType: String,
            byteCount: Long,
            sha256: String,
            precondition: DriveWritePrecondition,
            resumableOperationId: String? = null,
            baselineContentSha256: String? = null,
        ) = DriveV1DurableWrite(
            kind = "blob",
            path = path,
            contentSha256 = sha256.lowercase(),
            precondition = DriveV1DurablePrecondition.from(precondition),
            localBlobKey = localBlobKey,
            mimeType = mimeType,
            byteCount = byteCount,
            resumableOperationId = resumableOperationId,
            baselineContentSha256 = baselineContentSha256?.lowercase(),
        )
    }
}

@Serializable
internal data class DriveV1DurableRemoteFile(
    val path: String,
    val fileId: String,
    val version: Long,
    val mimeType: String? = null,
    val byteCount: Long? = null,
    val appProperties: Map<String, String> = emptyMap(),
    val contentSha256: String? = null,
) {
    init {
        require(path.isNotBlank() && fileId.isNotBlank()) { "A durable remote identity requires path and file id." }
        require(version > 0L) { "A durable remote identity requires a positive version." }
        require(byteCount == null || byteCount >= 0L) { "A durable remote byte count cannot be negative." }
        require(contentSha256 == null || DURABLE_SHA256.matches(contentSha256)) {
            "A durable remote content digest requires canonical SHA-256."
        }
    }

    companion object {
        fun from(ref: DriveFileRef, contentSha256: String? = null) = DriveV1DurableRemoteFile(
            path = ref.path,
            fileId = ref.id,
            version = requireNotNull(ref.version?.takeIf { it > 0L }) {
                "Verified Drive file has no positive version: ${ref.path}"
            },
            mimeType = ref.mimeType,
            byteCount = ref.size,
            appProperties = ref.appProperties.toSortedMap(),
            contentSha256 = contentSha256?.lowercase(),
        )
    }
}

@Serializable
internal data class DriveV1DurableTransactionPlan(
    val schemaVersion: Int = 1,
    val baselineFiles: List<DriveV1DurableRemoteFile> = emptyList(),
    val prerequisites: List<DriveV1DurableWrite>,
    val manifest: DriveV1DurableWrite,
) {
    init {
        require(schemaVersion == 1) { "Unsupported durable Drive plan version: $schemaVersion" }
        require(manifest.kind == "json" && manifest.path == DriveV1Paths.manifest) {
            "A durable Drive plan must publish manifest.json last."
        }
        val paths = prerequisites.map(DriveV1DurableWrite::path) + manifest.path
        require(paths.distinct().size == paths.size) { "A durable Drive plan cannot contain duplicate paths." }
        require(baselineFiles.map { it.path }.distinct().size == baselineFiles.size) {
            "A durable Drive plan cannot contain duplicate baseline paths."
        }
        require(baselineFiles == baselineFiles.sortedBy { it.path }) {
            "Durable Drive baseline files must use canonical path order."
        }
        require(prerequisites == prerequisites.sortedWith(DURABLE_WRITE_ORDER)) {
            "Durable Drive prerequisites must use canonical tombstone/blob/JSON path order."
        }
        (prerequisites + manifest).filter {
            it.kind == "blob" && it.precondition.kind == "must-match"
        }.forEach { write ->
            val baseline = baselineFiles.singleOrNull { it.path == write.path }
                ?: throw IllegalArgumentException("Existing durable blob is absent from its baseline inventory.")
            require(baseline.contentSha256 == write.baselineContentSha256) {
                "Existing durable blob digest differs from its baseline inventory: ${write.path}"
            }
        }
    }

    fun canonicalJson(): String = DURABLE_JSON.encodeToString(this)

    fun planHash(): String = sha256(canonicalJson().toByteArray(StandardCharsets.UTF_8))

    suspend fun hydrate(
        accountId: AccountId,
        jsonSource: DriveV1DurableJsonSource,
        blobSource: DriveV1DurableBlobSource,
    ): DriveV1WriteTransaction {
        suspend fun DriveV1DurableWrite.runtime(): DriveV1TransactionWrite = when (kind) {
            "json" -> {
                val json = jsonSource.load(accountId, requireNotNull(localJsonKey)).getOrThrow()
                require(sha256(json.toByteArray(StandardCharsets.UTF_8)) == contentSha256) {
                    "Durable JSON content changed before execution: $path"
                }
                DriveV1TransactionWrite.Json(
                    path = path,
                    json = json,
                    precondition = precondition.toRuntime(),
                )
            }
            "blob" -> {
                val bytes = blobSource.load(accountId, requireNotNull(localBlobKey)).getOrThrow().copyOf()
                require(bytes.size.toLong() == byteCount) { "Durable blob size changed before execution: $path" }
                require(sha256(bytes) == contentSha256) { "Durable blob content changed before execution: $path" }
                DriveV1TransactionWrite.Blob(
                    path = path,
                    bytes = bytes,
                    mimeType = requireNotNull(mimeType),
                    sha256 = contentSha256,
                    precondition = precondition.toRuntime(),
                    resumableOperationId = resumableOperationId,
                )
            }
            else -> error("Unsupported durable Drive write kind: $kind")
        }
        return DriveV1WriteTransaction(
            accountId = accountId,
            prerequisites = prerequisites.map { it.runtime() },
            manifest = manifest.runtime() as DriveV1TransactionWrite.Json,
        )
    }

    companion object {
        const val RESUMABLE_THRESHOLD_BYTES = 5L * 1024L * 1024L

        fun create(
            prerequisites: List<DriveV1DurableWrite>,
            manifest: DriveV1DurableWrite,
            baselineFiles: Collection<DriveFileRef> = emptyList(),
            baselineContentSha256ByPath: Map<String, String> = emptyMap(),
        ) = DriveV1DurableTransactionPlan(
            baselineFiles = baselineFiles.map { ref ->
                DriveV1DurableRemoteFile.from(ref, baselineContentSha256ByPath[ref.path])
            }.sortedBy { it.path },
            prerequisites = prerequisites.sortedWith(DURABLE_WRITE_ORDER),
            manifest = manifest,
        )

        fun decode(value: String): DriveV1DurableTransactionPlan {
            val decoded = DURABLE_JSON.decodeFromString<DriveV1DurableTransactionPlan>(value)
            require(decoded.canonicalJson() == value) { "Durable Drive plan JSON is not canonical." }
            return decoded
        }
    }
}

private val DURABLE_WRITE_ORDER = compareBy<DriveV1DurableWrite>(
    { when { it.path.startsWith("tombstones/") -> 0; it.kind == "blob" -> 1; else -> 2 } },
    DriveV1DurableWrite::path,
)

internal object DriveV1DurableOperationIds {
    fun transaction(queue: SyncQueueEntity, planHash: String): String {
        require(DURABLE_SHA256.matches(planHash)) { "A transaction operation id requires a canonical plan hash." }
        return "drive-tx-${sha256(framed(queue.id, queue.updatedAt, queue.entityKind, queue.entityId, planHash))}"
    }

    fun blob(
        queue: SyncQueueEntity,
        path: String,
        precondition: DriveWritePrecondition,
        contentSha256: String,
    ): String {
        require(path.isNotBlank()) { "A blob operation id requires a canonical path." }
        require(DURABLE_SHA256.matches(contentSha256)) { "A blob operation id requires canonical SHA-256." }
        return "drive-blob-${sha256(
            framed(
                queue.id,
                queue.updatedAt,
                path,
                preconditionIdentity(DriveV1DurablePrecondition.from(precondition)),
                contentSha256,
            ),
        )}"
    }

    fun jsonPayload(queue: SyncQueueEntity, path: String, contentSha256: String): String {
        require(path.isNotBlank() && DURABLE_SHA256.matches(contentSha256)) {
            "A durable JSON payload key requires canonical path and SHA-256."
        }
        return "drive-json-${sha256(framed(queue.id, queue.updatedAt, path, contentSha256))}"
    }

    private fun preconditionIdentity(value: DriveV1DurablePrecondition): String =
        listOf(value.kind, value.fileId.orEmpty(), value.version?.toString().orEmpty()).joinToString(":")

    private fun framed(vararg values: String): ByteArray = values.joinToString("") { "${it.length}:$it" }
        .toByteArray(StandardCharsets.UTF_8)
}

@Serializable
internal data class DriveV1VerifiedWriteReceipt(
    val path: String,
    val fileId: String,
    val version: Long,
    val contentSha256: String,
    val remoteUpdatedAt: String,
) {
    init {
        require(path.isNotBlank() && fileId.isNotBlank()) { "A Drive receipt requires path and file id." }
        require(version > 0L) { "A Drive receipt requires a positive remote version." }
        require(DURABLE_SHA256.matches(contentSha256)) { "A Drive receipt requires canonical SHA-256." }
        require(remoteUpdatedAt.isNotBlank()) { "A Drive receipt requires a remote update timestamp." }
    }

    companion object {
        fun from(write: DriveV1DurableWrite, file: DriveFileRef): DriveV1VerifiedWriteReceipt {
            require(file.path == write.path) { "Drive returned an unexpected path for ${write.path}." }
            return DriveV1VerifiedWriteReceipt(
                path = file.path,
                fileId = file.id,
                version = requireNotNull(file.version?.takeIf { it > 0L }) {
                    "Drive did not return a positive version for ${write.path}."
                },
                contentSha256 = write.contentSha256,
                remoteUpdatedAt = file.updatedAt,
            )
        }
    }
}

internal enum class DriveV1OperationState(val stored: String) {
    Prepared("prepared"), Running("running"), Ambiguous("ambiguous"),
    ManifestCommitted("manifest-committed"), Completed("completed"),
    Blocked("blocked"), Superseded("superseded");

    companion object {
        fun parse(value: String): DriveV1OperationState = entries.singleOrNull { it.stored == value }
            ?: throw IllegalArgumentException("Unknown durable Drive operation state: $value")
    }
}

internal class DriveV1OperationJournal(private val dao: LabNotebookDao) {
    suspend fun prepare(
        accountId: AccountId,
        queue: SyncQueueEntity,
        plan: DriveV1DurableTransactionPlan,
        payloads: List<DriveWritePayloadEntity>,
        preparedAt: String,
    ): DriveWriteOperationEntity {
        require(queue.accountId == accountId.value) { "Queue item belongs to a different account." }
        requireCanonicalQueueTimestamp(queue.updatedAt, "Queue mutation timestamp")
        requireCanonicalQueueTimestamp(preparedAt, "Drive operation preparation timestamp")
        val planJson = plan.canonicalJson()
        val planHash = plan.planHash()
        val operationId = DriveV1DurableOperationIds.transaction(queue, planHash)
        validatePayloads(accountId, plan, payloads)
        val existing = dao.activeDriveWriteOperationForQueueMutation(accountId.value, queue.id, queue.updatedAt)
        if (existing != null) {
            validateIdentity(existing, operationId, planHash, planJson)
            plan.jsonPayloadKeys().forEach { payloadKey ->
                require(dao.driveWritePayload(accountId.value, payloadKey) != null) {
                    "An existing Drive operation is missing its immutable JSON payload."
                }
            }
            return existing
        }
        dao.insertDriveWriteOperationWithPayloads(
            operation = DriveWriteOperationEntity(
                accountId = accountId.value,
                operationId = operationId,
                queueRecordId = queue.id,
                queueMutationAt = queue.updatedAt,
                entityKind = queue.entityKind,
                entityId = queue.entityId,
                planHash = planHash,
                planJson = planJson,
                state = DriveV1OperationState.Prepared.stored,
                createdAt = preparedAt,
                updatedAt = preparedAt,
            ),
            payloads = payloads,
        )
        return requireNotNull(dao.driveWriteOperation(accountId.value, operationId))
    }

    private fun validatePayloads(
        accountId: AccountId,
        plan: DriveV1DurableTransactionPlan,
        payloads: List<DriveWritePayloadEntity>,
    ) {
        val expected = plan.jsonPayloadKeys().toSet()
        require(payloads.map { it.payloadKey }.toSet() == expected && payloads.size == expected.size) {
            "Durable Drive JSON payloads do not exactly match the immutable plan."
        }
        payloads.forEach { payload ->
            require(payload.accountId == accountId.value) { "A durable JSON payload belongs to another account." }
            requireCanonicalQueueTimestamp(payload.createdAt, "Durable JSON payload creation timestamp")
            require(sha256(payload.payloadJson.toByteArray(StandardCharsets.UTF_8)) == payload.contentSha256) {
                "A durable JSON payload digest does not match its content."
            }
            val write = (plan.prerequisites + plan.manifest).single { it.localJsonKey == payload.payloadKey }
            require(write.contentSha256 == payload.contentSha256) {
                "A durable JSON payload digest does not match its plan."
            }
        }
    }

    fun decodePlan(operation: DriveWriteOperationEntity): DriveV1DurableTransactionPlan {
        val plan = DriveV1DurableTransactionPlan.decode(operation.planJson)
        require(plan.planHash() == operation.planHash) { "Durable Drive operation plan hash changed." }
        return plan
    }

    fun receipts(operation: DriveWriteOperationEntity): List<DriveV1VerifiedWriteReceipt> {
        val decoded = DURABLE_JSON.decodeFromString<List<DriveV1VerifiedWriteReceipt>>(operation.receiptsJson)
        require(decoded.map { it.path }.distinct().size == decoded.size) {
            "Durable Drive operation contains duplicate receipts."
        }
        require(DURABLE_JSON.encodeToString(decoded) == operation.receiptsJson) {
            "Durable Drive receipt JSON is not canonical."
        }
        return decoded
    }

    suspend fun transition(
        operation: DriveWriteOperationEntity,
        newState: DriveV1OperationState,
        receipts: List<DriveV1VerifiedWriteReceipt> = receipts(operation),
        updatedAt: String,
    ): DriveWriteOperationEntity {
        requireCanonicalQueueTimestamp(updatedAt, "Drive operation update timestamp")
        val oldState = DriveV1OperationState.parse(operation.state)
        require(newState in ALLOWED_TRANSITIONS.getValue(oldState)) {
            "Unsafe durable Drive operation transition: ${oldState.stored} -> ${newState.stored}"
        }
        val receiptsJson = DURABLE_JSON.encodeToString(receipts)
        check(
            dao.compareAndSetDriveWriteOperation(
                accountId = operation.accountId,
                operationId = operation.operationId,
                planHash = operation.planHash,
                expectedState = operation.state,
                expectedRevision = operation.revision,
                newState = newState.stored,
                receiptsJson = receiptsJson,
                updatedAt = updatedAt,
            ) == 1,
        ) { "Durable Drive operation changed concurrently." }
        return requireNotNull(dao.driveWriteOperation(operation.accountId, operation.operationId))
    }

    suspend fun appendReceipt(
        operation: DriveWriteOperationEntity,
        receipt: DriveV1VerifiedWriteReceipt,
        updatedAt: String,
    ): DriveWriteOperationEntity {
        val existing = receipts(operation)
        existing.singleOrNull { it.path == receipt.path }?.let { prior ->
            require(prior == receipt) { "A verified Drive receipt changed for ${receipt.path}." }
            return operation
        }
        return transition(
            operation = operation,
            newState = DriveV1OperationState.parse(operation.state),
            receipts = existing + receipt,
            updatedAt = updatedAt,
        )
    }

    private fun validateIdentity(
        existing: DriveWriteOperationEntity,
        operationId: String,
        planHash: String,
        planJson: String,
    ) {
        require(
            existing.operationId == operationId &&
                existing.planHash == planHash &&
                existing.planJson == planJson,
        ) { "A queue mutation is already bound to a different immutable Drive plan." }
    }

    private companion object {
        val ALLOWED_TRANSITIONS = mapOf(
            DriveV1OperationState.Prepared to setOf(
                DriveV1OperationState.Running,
                DriveV1OperationState.Blocked,
                DriveV1OperationState.Superseded,
            ),
            DriveV1OperationState.Running to setOf(
                DriveV1OperationState.Running,
                DriveV1OperationState.Ambiguous,
                DriveV1OperationState.ManifestCommitted,
                DriveV1OperationState.Blocked,
                DriveV1OperationState.Superseded,
            ),
            DriveV1OperationState.Ambiguous to setOf(
                DriveV1OperationState.Running,
                DriveV1OperationState.Ambiguous,
                DriveV1OperationState.Blocked,
                DriveV1OperationState.Superseded,
            ),
            DriveV1OperationState.ManifestCommitted to setOf(
                DriveV1OperationState.Completed,
                DriveV1OperationState.Superseded,
            ),
            DriveV1OperationState.Completed to emptySet(),
            DriveV1OperationState.Blocked to emptySet(),
            DriveV1OperationState.Superseded to emptySet(),
        )
    }
}

internal fun interface DriveV1DurableBlobSource {
    suspend fun load(accountId: AccountId, localBlobKey: String): Result<ByteArray>
}

internal fun interface DriveV1DurableJsonSource {
    suspend fun load(accountId: AccountId, localJsonKey: String): Result<String>
}

internal class RoomDriveV1DurableJsonSource(private val dao: LabNotebookDao) : DriveV1DurableJsonSource {
    override suspend fun load(accountId: AccountId, localJsonKey: String): Result<String> = try {
        val payload = requireNotNull(dao.driveWritePayload(accountId.value, localJsonKey)) {
            "Durable JSON payload is missing from the active account."
        }
        require(sha256(payload.payloadJson.toByteArray(StandardCharsets.UTF_8)) == payload.contentSha256) {
            "Durable JSON payload changed in local storage."
        }
        Result.success(payload.payloadJson)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }
}

internal sealed interface DriveV1QueuePlanDecision {
    data class Ready(
        val plan: DriveV1DurableTransactionPlan,
        val payloads: List<DriveWritePayloadEntity> = emptyList(),
    ) : DriveV1QueuePlanDecision
    data class CompleteWithoutRemote(val reason: String) : DriveV1QueuePlanDecision
    data class Conflict(val reason: String) : DriveV1QueuePlanDecision
    data class Blocked(val reason: String) : DriveV1QueuePlanDecision
}

/** The provider must use a fresh read-only snapshot and the existing three-way planner. */
internal fun interface DriveV1QueuePlanProvider {
    suspend fun prepare(accountId: AccountId, claimedQueueItem: SyncQueueEntity): DriveV1QueuePlanDecision
}

internal fun DriveV1ThreeWayDecision.toQueuePlanDecision(
    plan: DriveV1DurableTransactionPlan,
): DriveV1QueuePlanDecision = when (this) {
    DriveV1ThreeWayDecision.PushLocal -> DriveV1QueuePlanDecision.Ready(plan)
    DriveV1ThreeWayDecision.AlreadyConverged ->
        DriveV1QueuePlanDecision.CompleteWithoutRemote("Local and remote state already converge.")
    DriveV1ThreeWayDecision.AcceptRemote ->
        DriveV1QueuePlanDecision.CompleteWithoutRemote("The verified remote change wins the three-way plan.")
    DriveV1ThreeWayDecision.AcceptRemoteDelete ->
        DriveV1QueuePlanDecision.CompleteWithoutRemote("The verified remote tombstone wins the three-way plan.")
    is DriveV1ThreeWayDecision.Conflict -> DriveV1QueuePlanDecision.Conflict(reason)
    is DriveV1ThreeWayDecision.Blocked -> DriveV1QueuePlanDecision.Blocked(reason)
}

internal data class DriveV1LeaseWindow(val now: String, val expiresAt: String) {
    init {
        requireCanonicalQueueTimestamp(now, "Drive queue lease timestamp")
        requireCanonicalQueueTimestamp(expiresAt, "Drive queue lease expiry")
        require(expiresAt > now) { "Drive queue lease must expire after it begins." }
    }
}

internal fun interface DriveV1LeaseClock {
    fun next(): DriveV1LeaseWindow
}

internal sealed interface DriveV1RecoveryCheck {
    data class Exact(val file: DriveFileRef) : DriveV1RecoveryCheck
    data object ReadyToWrite : DriveV1RecoveryCheck
    data class Blocked(val reason: String) : DriveV1RecoveryCheck
}

/**
 * Read-only repair boundary. Implementations inspect only planned paths and must
 * fail closed on unexplained counts, duplicates, malformed data, or divergence.
 */
internal interface DriveV1RecoveryVerifier {
    suspend fun validatePlanScope(accountId: AccountId, plan: DriveV1DurableTransactionPlan): Result<Unit>
    suspend fun check(
        accountId: AccountId,
        write: DriveV1DurableWrite,
        receipt: DriveV1VerifiedWriteReceipt?,
    ): DriveV1RecoveryCheck
}

internal sealed interface DriveV1DurableRunResult {
    data object NoWork : DriveV1DurableRunResult
    data class Completed(val operationId: String) : DriveV1DurableRunResult
    data class CompletedWithoutRemote(val reason: String) : DriveV1DurableRunResult
    data class Conflict(val reason: String) : DriveV1DurableRunResult
    data class Blocked(val reason: String) : DriveV1DurableRunResult
    data class Ambiguous(val operationId: String, val path: String) : DriveV1DurableRunResult
    data class Superseded(val operationId: String) : DriveV1DurableRunResult
    data class LocalCompletionPending(val operationId: String) : DriveV1DurableRunResult
}

/** Offline/test-only coordinator. Production workers deliberately never construct this class. */
internal class DriveV1DurableWriteCoordinator(
    private val dao: LabNotebookDao,
    private val planProvider: DriveV1QueuePlanProvider,
    private val writer: DriveConditionalWriteClient,
    private val blobSource: DriveV1DurableBlobSource,
    private val verifier: DriveV1RecoveryVerifier,
    private val leaseClock: DriveV1LeaseClock,
    private val jsonSource: DriveV1DurableJsonSource = RoomDriveV1DurableJsonSource(dao),
) {
    private val journal = DriveV1OperationJournal(dao)

    suspend fun runNext(accountId: AccountId, claimToken: String): DriveV1DurableRunResult {
        require(claimToken.isNotBlank()) { "Drive queue claim token must not be blank." }
        val initialWindow = leaseClock.next()
        dao.recoverExpiredQueueClaims(accountId.value, initialWindow.now)
        val queue = dao.claimNextQueueItem(
            accountId = accountId.value,
            claimToken = claimToken,
            claimAt = initialWindow.now,
            leaseExpiresAt = initialWindow.expiresAt,
        ) ?: return DriveV1DurableRunResult.NoWork

        recoverOlderOperations(accountId, queue, claimToken)?.let { return it }

        val existing = dao.activeDriveWriteOperationForQueueMutation(accountId.value, queue.id, queue.updatedAt)
        var operation: DriveWriteOperationEntity
        val plan: DriveV1DurableTransactionPlan
        if (existing != null) {
            operation = existing
            plan = journal.decodePlan(existing)
        } else {
            val decision = try {
                planProvider.prepare(accountId, queue)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                val reason = error.message ?: "Drive plan preparation failed closed."
                dao.failQueueClaim(accountId.value, queue.id, claimToken, reason)
                return DriveV1DurableRunResult.Blocked(reason)
            }
            when (decision) {
                is DriveV1QueuePlanDecision.Ready -> {
                    plan = decision.plan
                    operation = journal.prepare(accountId, queue, plan, decision.payloads, leaseClock.next().now)
                }
                is DriveV1QueuePlanDecision.CompleteWithoutRemote -> {
                    val completed = dao.completeQueueClaimForMutation(
                        accountId.value,
                        queue.id,
                        queue.updatedAt,
                        claimToken,
                    )
                    return if (completed == 1) {
                        DriveV1DurableRunResult.CompletedWithoutRemote(decision.reason)
                    } else {
                        DriveV1DurableRunResult.Blocked("Queue mutation changed before local-only completion.")
                    }
                }
                is DriveV1QueuePlanDecision.Conflict -> {
                    dao.failQueueClaim(accountId.value, queue.id, claimToken, decision.reason)
                    return DriveV1DurableRunResult.Conflict(decision.reason)
                }
                is DriveV1QueuePlanDecision.Blocked -> {
                    dao.failQueueClaim(accountId.value, queue.id, claimToken, decision.reason)
                    return DriveV1DurableRunResult.Blocked(decision.reason)
                }
            }
        }

        when (DriveV1OperationState.parse(operation.state)) {
            DriveV1OperationState.Completed -> {
                val completed = dao.completeQueueClaimForMutation(
                    accountId.value,
                    queue.id,
                    queue.updatedAt,
                    claimToken,
                )
                return if (completed == 1) DriveV1DurableRunResult.Completed(operation.operationId)
                else DriveV1DurableRunResult.Superseded(operation.operationId)
            }
            DriveV1OperationState.Blocked -> {
                dao.failQueueClaim(accountId.value, queue.id, claimToken, "Durable Drive operation is blocked.")
                return DriveV1DurableRunResult.Blocked("Durable Drive operation is blocked.")
            }
            DriveV1OperationState.Superseded -> return DriveV1DurableRunResult.Superseded(operation.operationId)
            DriveV1OperationState.Prepared,
            DriveV1OperationState.Ambiguous,
            DriveV1OperationState.Running,
            DriveV1OperationState.ManifestCommitted,
            -> Unit
        }

        when (val execution = executeToManifest(accountId, queue, claimToken, operation, plan)) {
            is PlanExecution.ManifestCommitted -> operation = execution.operation
            is PlanExecution.Terminal -> return execution.result
        }

        val manifestReceipt = journal.receipts(operation).singleOrNull { it.path == DriveV1Paths.manifest }
            ?: return DriveV1DurableRunResult.LocalCompletionPending(operation.operationId)
        val manifestCheck = verifier.check(accountId, plan.manifest, manifestReceipt)
        if (manifestCheck !is DriveV1RecoveryCheck.Exact) {
            return DriveV1DurableRunResult.LocalCompletionPending(operation.operationId)
        }

        val baselines = baselines(accountId, operation, plan)
        return try {
            dao.finalizeDriveWriteOperation(
                operation = operation,
                claimToken = claimToken,
                baselines = baselines,
                payloadKeys = plan.jsonPayloadKeys(),
                completedAt = leaseClock.next().now,
            )
            DriveV1DurableRunResult.Completed(operation.operationId)
        } catch (_: IllegalStateException) {
            val currentQueue = dao.queueItem(accountId.value, queue.id)
            if (currentQueue == null || currentQueue.updatedAt != queue.updatedAt) {
                // Keep the manifest-committed journal recoverable. The next claim for the
                // newer mutation will verify the old manifest, advance raw baselines, and
                // only then mark this operation superseded without completing the new row.
                DriveV1DurableRunResult.Superseded(operation.operationId)
            } else {
                DriveV1DurableRunResult.LocalCompletionPending(operation.operationId)
            }
        }
    }

    private suspend fun recoverOlderOperations(
        accountId: AccountId,
        currentQueue: SyncQueueEntity,
        claimToken: String,
    ): DriveV1DurableRunResult? {
        val older = dao.recoverableDriveWriteOperations(accountId.value)
            .filter {
                it.queueRecordId == currentQueue.id &&
                    compareIsoTimestamps(it.queueMutationAt, currentQueue.updatedAt) < 0
            }
            .sortedBy { it.queueMutationAt }
        for (candidate in older) {
            var operation = candidate
            val state = DriveV1OperationState.parse(operation.state)
            if (state == DriveV1OperationState.Blocked) {
                dao.failQueueClaim(
                    accountId.value,
                    currentQueue.id,
                    claimToken,
                    "An older partial Drive operation is blocked and requires review.",
                )
                return DriveV1DurableRunResult.Blocked(
                    "An older partial Drive operation is blocked and requires review.",
                )
            }
            if (state == DriveV1OperationState.Prepared && journal.receipts(operation).isEmpty()) {
                journal.transition(operation, DriveV1OperationState.Superseded, updatedAt = leaseClock.next().now)
                dao.deleteDriveWritePayloads(accountId.value, journal.decodePlan(operation).jsonPayloadKeys())
                continue
            }
            val plan = journal.decodePlan(operation)
            when (val execution = executeToManifest(accountId, currentQueue, claimToken, operation, plan)) {
                is PlanExecution.ManifestCommitted -> operation = execution.operation
                is PlanExecution.Terminal -> return execution.result
            }
            val manifestReceipt = journal.receipts(operation).singleOrNull { it.path == DriveV1Paths.manifest }
                ?: return DriveV1DurableRunResult.LocalCompletionPending(operation.operationId)
            if (verifier.check(accountId, plan.manifest, manifestReceipt) !is DriveV1RecoveryCheck.Exact) {
                return DriveV1DurableRunResult.LocalCompletionPending(operation.operationId)
            }
            try {
                dao.finalizeSupersededDriveWriteOperation(
                    operation = operation,
                    currentQueueMutationAt = currentQueue.updatedAt,
                    claimToken = claimToken,
                    baselines = baselines(accountId, operation, plan),
                    payloadKeys = plan.jsonPayloadKeys(),
                    completedAt = leaseClock.next().now,
                )
            } catch (_: IllegalStateException) {
                return DriveV1DurableRunResult.LocalCompletionPending(operation.operationId)
            }
        }
        return null
    }

    private suspend fun executeToManifest(
        accountId: AccountId,
        queue: SyncQueueEntity,
        claimToken: String,
        initialOperation: DriveWriteOperationEntity,
        plan: DriveV1DurableTransactionPlan,
    ): PlanExecution {
        var operation = initialOperation
        when (DriveV1OperationState.parse(operation.state)) {
            DriveV1OperationState.Prepared, DriveV1OperationState.Ambiguous -> {
                operation = journal.transition(
                    operation,
                    DriveV1OperationState.Running,
                    updatedAt = leaseClock.next().now,
                )
            }
            DriveV1OperationState.Running, DriveV1OperationState.ManifestCommitted -> Unit
            DriveV1OperationState.Completed, DriveV1OperationState.Blocked, DriveV1OperationState.Superseded ->
                return PlanExecution.Terminal(
                    DriveV1DurableRunResult.Blocked("Durable Drive operation is not recoverable."),
                )
        }
        if (DriveV1OperationState.parse(operation.state) == DriveV1OperationState.ManifestCommitted) {
            return PlanExecution.ManifestCommitted(operation)
        }
        val scopeFailure = verifier.validatePlanScope(accountId, plan).exceptionOrNull()
        if (scopeFailure != null) {
            if (scopeFailure is CancellationException) throw scopeFailure
            return PlanExecution.Terminal(
                block(operation, queue, claimToken, scopeFailure.message ?: "Drive repair scope is unsafe."),
            )
        }
        val transaction = try {
            plan.hydrate(accountId, jsonSource, blobSource)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return PlanExecution.Terminal(
                block(operation, queue, claimToken, error.message ?: "Durable Drive plan could not be hydrated."),
            )
        }
        val runtimeWrites = (transaction.prerequisites + transaction.manifest).associateBy { it.path }
        if (DriveV1OperationState.parse(operation.state) != DriveV1OperationState.ManifestCommitted) {
            for (write in plan.prerequisites) {
                when (val result = applyWrite(
                    accountId,
                    queue,
                    claimToken,
                    operation,
                    write,
                    runtimeWrites.getValue(write.path),
                )) {
                    is ApplyResult.Verified -> operation = result.operation
                    is ApplyResult.Terminal -> return PlanExecution.Terminal(result.result)
                }
            }
            when (val result = applyWrite(
                accountId,
                queue,
                claimToken,
                operation,
                plan.manifest,
                runtimeWrites.getValue(plan.manifest.path),
            )) {
                is ApplyResult.Verified -> operation = result.operation
                is ApplyResult.Terminal -> return PlanExecution.Terminal(result.result)
            }
            operation = journal.transition(
                operation,
                DriveV1OperationState.ManifestCommitted,
                updatedAt = leaseClock.next().now,
            )
        }
        return PlanExecution.ManifestCommitted(operation)
    }

    private suspend fun baselines(
        accountId: AccountId,
        operation: DriveWriteOperationEntity,
        plan: DriveV1DurableTransactionPlan,
    ): List<DriveRawDocumentEntity> {
        val receipts = journal.receipts(operation).associateBy { it.path }
        return (plan.prerequisites + plan.manifest).mapNotNull { write ->
            val kind = write.baselineEntityKind ?: return@mapNotNull null
            val id = requireNotNull(write.baselineEntityId)
            val receipt = requireNotNull(receipts[write.path])
            val rawJson = jsonSource.load(accountId, requireNotNull(write.localJsonKey)).getOrThrow()
            require(sha256(rawJson.toByteArray(StandardCharsets.UTF_8)) == write.contentSha256) {
                "Durable baseline JSON changed before local completion: ${write.path}"
            }
            DriveRawDocumentEntity(
                accountId = accountId.value,
                entityKind = kind,
                entityId = id,
                path = write.path,
                driveFileId = receipt.fileId,
                driveVersion = receipt.version,
                driveModifiedAt = receipt.remoteUpdatedAt,
                rawJson = rawJson,
            )
        }
    }

    private suspend fun applyWrite(
        accountId: AccountId,
        queue: SyncQueueEntity,
        claimToken: String,
        initialOperation: DriveWriteOperationEntity,
        descriptor: DriveV1DurableWrite,
        runtime: DriveV1TransactionWrite,
    ): ApplyResult {
        var operation = initialOperation
        val priorReceipt = journal.receipts(operation).singleOrNull { it.path == descriptor.path }
        when (val check = verifier.check(accountId, descriptor, priorReceipt)) {
            is DriveV1RecoveryCheck.Exact -> {
                val receipt = DriveV1VerifiedWriteReceipt.from(descriptor, check.file)
                operation = journal.appendReceipt(operation, receipt, leaseClock.next().now)
                return ApplyResult.Verified(operation)
            }
            is DriveV1RecoveryCheck.Blocked -> {
                return ApplyResult.Terminal(block(operation, queue, claimToken, check.reason))
            }
            DriveV1RecoveryCheck.ReadyToWrite -> {
                if (priorReceipt != null) {
                    return ApplyResult.Terminal(
                        block(operation, queue, claimToken, "A verified Drive receipt no longer matches ${descriptor.path}."),
                    )
                }
            }
        }

        val renewal = leaseClock.next()
        if (!dao.renewQueueClaim(
                accountId.value,
                queue.id,
                claimToken,
                queue.updatedAt,
                renewal.now,
                renewal.expiresAt,
            )
        ) {
            operation = if (journal.receipts(operation).isEmpty()) {
                journal.transition(operation, DriveV1OperationState.Superseded, updatedAt = renewal.now)
            } else {
                journal.transition(operation, DriveV1OperationState.Ambiguous, updatedAt = renewal.now)
            }
            if (DriveV1OperationState.parse(operation.state) == DriveV1OperationState.Superseded) {
                dao.deleteDriveWritePayloads(accountId.value, journal.decodePlan(operation).jsonPayloadKeys())
            }
            return ApplyResult.Terminal(DriveV1DurableRunResult.Superseded(operation.operationId))
        }
        val file = try {
            writer.writeDurable(accountId, runtime).getOrThrow()
        } catch (error: DriveWriteReconciledAfterCancellationException) {
            operation = journal.appendReceipt(
                operation,
                DriveV1VerifiedWriteReceipt.from(descriptor, error.file),
                leaseClock.next().now,
            )
            throw CancellationException("Drive write committed before cancellation.").apply { initCause(error) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: DriveWriteAmbiguousCommitException) {
            operation = journal.transition(operation, DriveV1OperationState.Ambiguous, updatedAt = leaseClock.next().now)
            dao.requeueQueueClaim(accountId.value, queue.id, claimToken)
            return ApplyResult.Terminal(DriveV1DurableRunResult.Ambiguous(operation.operationId, descriptor.path))
        } catch (error: DriveWritePreconditionConflictException) {
            val reason = error.message ?: "Drive precondition failed at ${descriptor.path}."
            if (journal.receipts(operation).isEmpty()) {
                operation = journal.transition(
                    operation,
                    DriveV1OperationState.Superseded,
                    updatedAt = leaseClock.next().now,
                )
                dao.requeueQueueClaim(accountId.value, queue.id, claimToken)
                dao.deleteDriveWritePayloads(accountId.value, journal.decodePlan(operation).jsonPayloadKeys())
                return ApplyResult.Terminal(DriveV1DurableRunResult.Superseded(operation.operationId))
            }
            return ApplyResult.Terminal(
                block(
                    operation,
                    queue,
                    claimToken,
                    "$reason A partial transaction exists and cannot be replanned automatically.",
                ),
            )
        } catch (error: Throwable) {
            operation = journal.transition(operation, DriveV1OperationState.Ambiguous, updatedAt = leaseClock.next().now)
            dao.requeueQueueClaim(accountId.value, queue.id, claimToken)
            return ApplyResult.Terminal(DriveV1DurableRunResult.Ambiguous(operation.operationId, descriptor.path))
        }
        operation = journal.appendReceipt(
            operation,
            DriveV1VerifiedWriteReceipt.from(descriptor, file),
            leaseClock.next().now,
        )
        return ApplyResult.Verified(operation)
    }

    private suspend fun block(
        operation: DriveWriteOperationEntity,
        queue: SyncQueueEntity,
        claimToken: String,
        reason: String,
    ): DriveV1DurableRunResult {
        val state = DriveV1OperationState.parse(operation.state)
        if (state in setOf(DriveV1OperationState.Prepared, DriveV1OperationState.Running, DriveV1OperationState.Ambiguous)) {
            journal.transition(operation, DriveV1OperationState.Blocked, updatedAt = leaseClock.next().now)
        }
        dao.failQueueClaim(queue.accountId, queue.id, claimToken, reason)
        dao.deleteDriveWritePayloads(queue.accountId, journal.decodePlan(operation).jsonPayloadKeys())
        return DriveV1DurableRunResult.Blocked(reason)
    }

    private sealed interface ApplyResult {
        data class Verified(val operation: DriveWriteOperationEntity) : ApplyResult
        data class Terminal(val result: DriveV1DurableRunResult) : ApplyResult
    }

    private sealed interface PlanExecution {
        data class ManifestCommitted(val operation: DriveWriteOperationEntity) : PlanExecution
        data class Terminal(val result: DriveV1DurableRunResult) : PlanExecution
    }
}

private fun DriveV1DurableTransactionPlan.jsonPayloadKeys(): List<String> =
    (prerequisites + manifest).mapNotNull(DriveV1DurableWrite::localJsonKey).distinct()

private suspend fun DriveConditionalWriteClient.writeDurable(
    accountId: AccountId,
    write: DriveV1TransactionWrite,
): Result<DriveFileRef> = when (write) {
    is DriveV1TransactionWrite.Json -> putJsonConditional(accountId, write.path, write.json, write.precondition)
    is DriveV1TransactionWrite.Blob -> if (write.resumableOperationId == null) {
        putBlobConditional(accountId, write.path, write.bytes, write.mimeType, write.sha256, write.precondition)
    } else if (write.precondition is DriveWritePrecondition.MustMatch) {
        putBlobConditionalResumable(
            accountId,
            write.path,
            write.bytes,
            write.mimeType,
            write.sha256,
            write.precondition,
            write.resumableOperationId,
        )
    } else {
        putBlobConditionalResumableCreate(
            accountId,
            write.path,
            write.bytes,
            write.mimeType,
            write.sha256,
            write.precondition,
            write.resumableOperationId,
        )
    }
}

private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
