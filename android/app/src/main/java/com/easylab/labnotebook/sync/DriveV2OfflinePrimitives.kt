package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import android.util.Base64
import java.util.Collections
import java.util.LinkedHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

internal data class DriveV2WorkspaceItem(
    val driveFileId: String,
    val name: String,
    val parentIds: List<String>,
    val mimeType: String,
    val trashed: Boolean,
    val appProperties: Map<String, String>,
)

internal data class DriveV2ArtifactDescriptor(
    val kind: String,
    val canonicalId: String,
    val generatedDriveFileId: String,
    val parentFolderDriveFileId: String,
    val path: String,
    val mimeType: String,
    val byteCount: Long,
    val contentSha256: String,
    val resumableOperationId: String? = null,
)

internal class DriveV2OperationJournal(
    val accountId: AccountId,
    val savedRootDriveFileId: String,
    val workspaceId: String,
    val operationId: String,
    managedFolderIds: Map<String, String>,
    artifactDescriptors: List<DriveV2ArtifactDescriptor>,
) {
    val managedFolderIds: Map<String, String> = immutableMap(managedFolderIds)
    val artifactDescriptors: List<DriveV2ArtifactDescriptor> = immutableList(artifactDescriptors)
}

internal class DriveV2RemoteArtifact(
    val kind: String,
    val driveFileId: String,
    val parentFolderDriveFileId: String,
    val path: String,
    val mimeType: String,
    val byteCount: Long,
    val expectedId: String,
    val expectedContentSha256: String,
    appProperties: Map<String, String>,
    bytes: ByteArray,
) {
    private val contentBytes: ByteArray = bytes.copyOf()
    val bytes: ByteArray get() = contentBytes.copyOf()
    val appProperties: Map<String, String> = immutableMap(appProperties)

    fun descriptor(resumableOperationId: String? = null) = DriveV2ArtifactDescriptor(
        kind = kind,
        canonicalId = expectedId,
        generatedDriveFileId = driveFileId,
        parentFolderDriveFileId = parentFolderDriveFileId,
        path = path,
        mimeType = mimeType,
        byteCount = byteCount,
        contentSha256 = expectedContentSha256,
        resumableOperationId = resumableOperationId,
    )

    fun remoteIdentityEquals(other: DriveV2RemoteArtifact): Boolean =
        kind == other.kind &&
            parentFolderDriveFileId == other.parentFolderDriveFileId &&
            path == other.path &&
            mimeType == other.mimeType &&
            byteCount == other.byteCount &&
            expectedId == other.expectedId &&
            expectedContentSha256 == other.expectedContentSha256 &&
            appProperties == other.appProperties &&
            contentBytes.contentEquals(other.contentBytes)
}

internal data class DriveV2PreflightSnapshot(
    val currentAccountId: AccountId,
    val currentSavedRootDriveFileId: String,
    val currentWorkspaceId: String,
    val currentOperationId: String,
    val currentManagedFolderIds: Map<String, String>,
    val currentArtifactDescriptors: List<DriveV2ArtifactDescriptor>,
    val journal: DriveV2OperationJournal,
    val roots: List<DriveV2WorkspaceItem>,
    val folders: List<DriveV2WorkspaceItem>,
    val artifacts: List<DriveV2RemoteArtifact>,
)

private object DriveV2ValidatedReadinessSeal

internal class DriveV2PlanReadiness internal constructor(
    val state: DriveV2WorkspaceState,
    val projection: DriveV2Projection,
    journal: DriveV2OperationJournal,
    validationSeal: Any,
) {
    init {
        require(validationSeal === DriveV2ValidatedReadinessSeal) {
            "Drive v2 readiness can only originate from successful preflight."
        }
    }

    val accountId: AccountId = journal.accountId
    val savedRootDriveFileId: String = journal.savedRootDriveFileId
    val workspaceId: String = journal.workspaceId
    val operationId: String = journal.operationId
    val managedFolderIds: Map<String, String> = immutableMap(journal.managedFolderIds)
    val artifactDescriptors: List<DriveV2ArtifactDescriptor> = immutableList(journal.artifactDescriptors)
}

internal object DriveV2Preflight {
    fun validateBeforePlan(snapshot: DriveV2PreflightSnapshot): DriveV2PlanReadiness {
        validateJournalAndFolders(snapshot)
        val state = validateArtifacts(snapshot)
        return DriveV2PlanReadiness(
            state,
            DriveV2GraphValidator.project(state),
            snapshot.journal,
            DriveV2ValidatedReadinessSeal,
        )
    }

    private fun validateJournalAndFolders(snapshot: DriveV2PreflightSnapshot) {
        require(snapshot.currentAccountId == snapshot.journal.accountId, "account-switch")
        require(
            snapshot.currentSavedRootDriveFileId == snapshot.journal.savedRootDriveFileId,
            "saved-root-switch",
        )
        require(snapshot.currentWorkspaceId == snapshot.journal.workspaceId, "workspace-marker-switch")
        require(snapshot.currentOperationId == snapshot.journal.operationId, "stale-operation-id")
        require(snapshot.currentManagedFolderIds == snapshot.journal.managedFolderIds, "managed-folder-switch")
        require(
            snapshot.currentArtifactDescriptors == snapshot.journal.artifactDescriptors,
            "changed-artifact-descriptor",
        )
        require(DriveV2Contract.WORKSPACE_ID.matches(snapshot.journal.workspaceId), "workspace-marker-switch")
        val root = snapshot.roots.singleOrNull { it.driveFileId == snapshot.journal.savedRootDriveFileId }
            ?: fail("saved-root-switch")
        val expectedRootProperties = mapOf(
            "easylabDriveProtocol" to "v2-append-only",
            "easylabWorkspaceId" to snapshot.journal.workspaceId,
            "easylabArtifactKind" to "workspace-root",
        )
        require(
            root.name == DriveV2Contract.ROOT_NAME &&
                root.parentIds == listOf("root") &&
                root.mimeType == DriveV2Contract.FOLDER_MIME_TYPE &&
                !root.trashed &&
                root.appProperties == expectedRootProperties,
            "workspace-marker-switch",
        )
        val markedRoots = snapshot.roots.filter {
            !it.trashed &&
                it.appProperties["easylabDriveProtocol"] == "v2-append-only" &&
                it.appProperties["easylabArtifactKind"] == "workspace-root"
        }
        require(markedRoots.size == 1, "duplicate-marked-root")

        require(snapshot.journal.managedFolderIds.keys == DriveV2Contract.MANAGED_FOLDER_ROLES, "managed-folder-switch")
        for (role in DriveV2Contract.MANAGED_FOLDER_ROLES) {
            val folderId = snapshot.journal.managedFolderIds.getValue(role)
            val folder = snapshot.folders.singleOrNull { it.driveFileId == folderId }
                ?: fail("managed-folder-switch")
            val expectedProperties = mapOf(
                "easylabDriveProtocol" to "v2-append-only",
                "easylabWorkspaceId" to snapshot.journal.workspaceId,
                "easylabArtifactKind" to "managed-folder",
                "easylabFolderRole" to role,
            )
            require(
                folder.name == role &&
                    folder.parentIds == listOf(root.driveFileId) &&
                    folder.mimeType == DriveV2Contract.FOLDER_MIME_TYPE &&
                    !folder.trashed &&
                    folder.appProperties == expectedProperties,
                "managed-folder-switch",
            )
        }
        require(snapshot.folders.size == DriveV2Contract.MANAGED_FOLDER_ROLES.size, "managed-folder-switch")
    }

    private fun validateArtifacts(snapshot: DriveV2PreflightSnapshot): DriveV2WorkspaceState {
        val representatives = snapshot.artifacts.groupBy(DriveV2RemoteArtifact::path).values.map { copies ->
            require(copies.drop(1).all(copies.first()::remoteIdentityEquals), "divergent-duplicate")
            copies.first()
        }
        val objects = mutableListOf<DriveV2ObjectRecord>()
        val commits = mutableListOf<DriveV2CommitRecord>()
        val blobs = mutableListOf<DriveV2BlobRecord>()
        representatives.forEach { artifact ->
            require(artifact.kind in setOf("object", "blob", "commit"), "unknown-artifact-kind")
            require(artifact.driveFileId.isNotBlank(), "artifact-schema-mismatch")
            require(artifact.byteCount == artifact.bytes.size.toLong(), "content-length-mismatch")
            val digest = DriveV2CanonicalJson.sha256(artifact.bytes)
            require(digest == artifact.expectedContentSha256, "content-hash-mismatch")
            val folderId = snapshot.journal.managedFolderIds.getValue(
                when (artifact.kind) {
                    "object" -> "objects"
                    "blob" -> "blobs"
                    "commit" -> "commits"
                    else -> fail("unknown-artifact-kind")
                },
            )
            require(artifact.parentFolderDriveFileId == folderId, "artifact-parent-mismatch")
            val expectedPath = when (artifact.kind) {
                "object" -> DriveV2Contract.objectPath(artifact.expectedId)
                "blob" -> DriveV2Contract.blobPath(artifact.expectedId)
                "commit" -> DriveV2Contract.commitPath(artifact.expectedId)
                else -> fail("unknown-artifact-kind")
            }
            require(artifact.path == expectedPath, "artifact-path-mismatch")
            val expectedMime = if (artifact.kind == "blob") artifact.mimeType else DriveV2Contract.JSON_MIME_TYPE
            require(artifact.mimeType == expectedMime && expectedMime.isNotBlank(), "artifact-mime-mismatch")
            require(
                artifact.appProperties == DriveV2Contract.appProperties(
                    snapshot.journal.workspaceId,
                    artifact.kind,
                    artifact.expectedId,
                    digest,
                ),
                "artifact-properties-mismatch",
            )
            when (artifact.kind) {
                "object" -> {
                    val body = DriveV2CanonicalJson.decodeCanonicalObject(artifact.bytes)
                    val record = DriveV2ObjectRecord(artifact.expectedId, body)
                    DriveV2GraphValidator.validateObject(record, snapshot.journal.workspaceId)
                    objects += record
                }
                "commit" -> {
                    val body = DriveV2CanonicalJson.decodeCanonicalObject(artifact.bytes)
                    val record = DriveV2CommitRecord(artifact.expectedId, body)
                    DriveV2GraphValidator.validateCommit(record, snapshot.journal.workspaceId)
                    commits += record
                }
                "blob" -> {
                    require(artifact.expectedId == DriveV2Contract.blobId(artifact.bytes), "canonical-id-mismatch")
                    blobs += DriveV2BlobRecord(artifact.expectedId, artifact.bytes, artifact.mimeType)
                }
            }
        }
        return DriveV2GraphValidator.validateWorkspace(
            workspaceId = snapshot.journal.workspaceId,
            objects = objects,
            blobs = blobs,
            commits = commits,
        )
    }

    private fun require(condition: Boolean, code: String) {
        if (!condition) fail(code)
    }

    private fun fail(code: String): Nothing = throw DriveV2ContractException(code)
}

internal class DriveV2CreateArtifact(
    val kind: String,
    val generatedDriveFileId: String,
    val parentFolderDriveFileId: String,
    val canonicalId: String,
    val path: String,
    val mimeType: String,
    bytes: ByteArray,
    appProperties: Map<String, String>,
    val resumableOperationId: String? = null,
) {
    private val contentBytes: ByteArray = bytes.copyOf()
    val bytes: ByteArray get() = contentBytes.copyOf()
    val byteCount: Long get() = contentBytes.size.toLong()
    val appProperties: Map<String, String> = immutableMap(appProperties)
    val contentSha256: String = DriveV2CanonicalJson.sha256(contentBytes)

    init {
        require(kind in setOf("blob", "object", "commit"))
        require(generatedDriveFileId.isNotBlank() && parentFolderDriveFileId.isNotBlank())
        require(path == when (kind) {
            "blob" -> DriveV2Contract.blobPath(canonicalId)
            "object" -> DriveV2Contract.objectPath(canonicalId)
            else -> DriveV2Contract.commitPath(canonicalId)
        })
        require(mimeType.isNotBlank())
        val workspaceId = this.appProperties["easylabWorkspaceId"]
        require(workspaceId != null && DriveV2Contract.WORKSPACE_ID.matches(workspaceId))
        require(
            this.appProperties == DriveV2Contract.appProperties(
                workspaceId,
                kind,
                canonicalId,
                contentSha256,
            ),
        )
        if (kind == "blob" && contentBytes.size >= RESUMABLE_THRESHOLD_BYTES) {
            require(!resumableOperationId.isNullOrBlank())
        } else {
            require(resumableOperationId == null)
        }
        if (kind != "blob") {
            require(mimeType == DriveV2Contract.JSON_MIME_TYPE)
            require(contentBytes.size < RESUMABLE_THRESHOLD_BYTES)
            val body = DriveV2CanonicalJson.decodeCanonicalObject(contentBytes)
            val expected = if (kind == "object") {
                DriveV2GraphValidator.validateObject(DriveV2ObjectRecord(canonicalId, body), workspaceId)
            } else {
                DriveV2GraphValidator.validateCommit(DriveV2CommitRecord(canonicalId, body), workspaceId)
            }
            require(expected == canonicalId)
        } else {
            require(DriveV2Contract.blobId(contentBytes) == canonicalId)
        }
    }

    fun descriptor() = DriveV2ArtifactDescriptor(
        kind = kind,
        canonicalId = canonicalId,
        generatedDriveFileId = generatedDriveFileId,
        parentFolderDriveFileId = parentFolderDriveFileId,
        path = path,
        mimeType = mimeType,
        byteCount = byteCount,
        contentSha256 = contentSha256,
        resumableOperationId = resumableOperationId,
    )

    fun snapshot() = DriveV2CreateArtifact(
        kind,
        generatedDriveFileId,
        parentFolderDriveFileId,
        canonicalId,
        path,
        mimeType,
        contentBytes,
        appProperties.toMap(),
        resumableOperationId,
    )

    companion object {
        const val RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024
    }
}

internal class DriveV2CreateTransaction(
    val readiness: DriveV2PlanReadiness,
    blobs: List<DriveV2CreateArtifact>,
    objects: List<DriveV2CreateArtifact>,
    commit: DriveV2CreateArtifact,
) {
    val accountId: AccountId = readiness.accountId
    val operationId: String = readiness.operationId
    val blobs: List<DriveV2CreateArtifact> = blobs.map(DriveV2CreateArtifact::snapshot)
    val objects: List<DriveV2CreateArtifact> = objects.map(DriveV2CreateArtifact::snapshot)
    val commit: DriveV2CreateArtifact = commit.snapshot()

    init {
        require(operationId.isNotBlank())
        require(blobs.all { it.kind == "blob" })
        require(objects.all { it.kind == "object" })
        require(commit.kind == "commit")
        val writes = blobs + objects + commit
        require(writes.map(DriveV2CreateArtifact::path).distinct().size == writes.size)
        require(writes.map(DriveV2CreateArtifact::generatedDriveFileId).distinct().size == writes.size)
        require(readiness.savedRootDriveFileId.isNotBlank())
        require(readiness.managedFolderIds.keys == DriveV2Contract.MANAGED_FOLDER_ROLES)
        writes.forEach { artifact ->
            val role = when (artifact.kind) {
                "blob" -> "blobs"
                "object" -> "objects"
                else -> "commits"
            }
            require(artifact.parentFolderDriveFileId == readiness.managedFolderIds.getValue(role))
            require(artifact.appProperties["easylabWorkspaceId"] == readiness.workspaceId)
        }
        val descriptors = writes.map(DriveV2CreateArtifact::descriptor).sortedBy { it.canonicalId }
        require(descriptors == readiness.artifactDescriptors.sortedBy { it.canonicalId })
        val resumableIds = blobs.mapNotNull(DriveV2CreateArtifact::resumableOperationId)
        require(resumableIds.distinct().size == resumableIds.size)
        val commitBody = DriveV2CanonicalJson.decodeCanonicalObject(commit.bytes)
        require(commitBody.getValue("operationId").jsonPrimitive.content == operationId)
        require(commitBody.stringIds("objectIds") == objects.map(DriveV2CreateArtifact::canonicalId).sorted())
        require(commitBody.stringIds("blobIds") == blobs.map(DriveV2CreateArtifact::canonicalId).sorted())
    }

    fun snapshot() = DriveV2CreateTransaction(
        readiness = readiness,
        blobs = blobs.map(DriveV2CreateArtifact::snapshot),
        objects = objects.map(DriveV2CreateArtifact::snapshot),
        commit = commit.snapshot(),
    )
}

internal class DriveV2CreateReceipt(
    val driveFileId: String,
    val parentFolderDriveFileId: String,
    val path: String,
    val canonicalId: String,
    val contentSha256: String,
    val mimeType: String,
    appProperties: Map<String, String>,
    val byteCount: Long,
    val trashed: Boolean,
    val stableSecondRead: Boolean,
) {
    val appProperties: Map<String, String> = immutableMap(appProperties)

    fun copy(
        driveFileId: String = this.driveFileId,
        parentFolderDriveFileId: String = this.parentFolderDriveFileId,
        path: String = this.path,
        canonicalId: String = this.canonicalId,
        contentSha256: String = this.contentSha256,
        mimeType: String = this.mimeType,
        appProperties: Map<String, String> = this.appProperties,
        byteCount: Long = this.byteCount,
        trashed: Boolean = this.trashed,
        stableSecondRead: Boolean = this.stableSecondRead,
    ) = DriveV2CreateReceipt(
        driveFileId,
        parentFolderDriveFileId,
        path,
        canonicalId,
        contentSha256,
        mimeType,
        appProperties,
        byteCount,
        trashed,
        stableSecondRead,
    )
}

internal fun interface DriveV2CreateOnlyClient {
    suspend fun createOrReconcile(accountId: AccountId, artifact: DriveV2CreateArtifact): Result<DriveV2CreateReceipt>
}

internal data class DriveV2CreateTransactionResult(
    val prerequisiteReceipts: List<DriveV2CreateReceipt>,
    val commitReceipt: DriveV2CreateReceipt,
)

internal class DriveV2CreateTransactionException(
    val failedPath: String,
    val completedReceipts: List<DriveV2CreateReceipt>,
    cause: Throwable,
) : Exception("Drive v2 create-only transaction failed at $failedPath.", cause)

/** Offline-only executor. No production factory constructs this type. */
internal class DriveV2CreateTransactionExecutor(
    private val client: DriveV2CreateOnlyClient,
) {
    suspend fun execute(transaction: DriveV2CreateTransaction): Result<DriveV2CreateTransactionResult> = try {
        val snapshot = transaction.snapshot()
        val completed = mutableListOf<DriveV2CreateReceipt>()
        for (artifact in snapshot.blobs + snapshot.objects) {
            val receipt = create(snapshot.accountId, artifact, completed)
            completed += receipt
        }
        val commitReceipt = create(snapshot.accountId, snapshot.commit, completed)
        Result.success(DriveV2CreateTransactionResult(completed.toList(), commitReceipt))
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }

    private suspend fun create(
        accountId: AccountId,
        artifact: DriveV2CreateArtifact,
        completed: List<DriveV2CreateReceipt>,
    ): DriveV2CreateReceipt {
        val receipt = try {
            client.createOrReconcile(accountId, artifact).getOrThrow()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            throw DriveV2CreateTransactionException(artifact.path, completed.toList(), error)
        }
        val exact = receipt.driveFileId == artifact.generatedDriveFileId &&
            receipt.parentFolderDriveFileId == artifact.parentFolderDriveFileId &&
            receipt.path == artifact.path &&
            receipt.canonicalId == artifact.canonicalId &&
            receipt.contentSha256 == artifact.contentSha256 &&
            receipt.mimeType == artifact.mimeType &&
            receipt.appProperties == artifact.appProperties &&
            receipt.byteCount == artifact.byteCount &&
            !receipt.trashed &&
            receipt.stableSecondRead
        if (!exact) {
            throw DriveV2CreateTransactionException(
                artifact.path,
                completed.toList(),
                DriveV2ContractException("create-reconciliation-mismatch"),
            )
        }
        return receipt
    }
}

private fun JsonObject.stringIds(name: String): List<String> =
    getValue(name).let { element ->
        (element as? JsonArray)
            ?.map { it.jsonPrimitive.content }
            ?: throw DriveV2ContractException("artifact-schema-mismatch")
    }

internal fun DriveV2RemoteArtifact.bytesBase64(): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

private fun <K, V> immutableMap(value: Map<K, V>): Map<K, V> =
    Collections.unmodifiableMap(LinkedHashMap(value))

private fun <T> immutableList(value: Collection<T>): List<T> =
    Collections.unmodifiableList(ArrayList(value))
