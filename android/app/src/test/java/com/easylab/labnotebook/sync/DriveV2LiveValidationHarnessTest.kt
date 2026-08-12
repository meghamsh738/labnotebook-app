package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Explicitly gated Drive v2 append-only validation seam.
 *
 * Ordinary JVM tests skip these methods. Only the ignored one-run launcher can
 * provide the marked container, pre-generated ids, short-lived token, and exact
 * confirmation needed to reach Drive. No production factory constructs this
 * client, and the client has no update or delete operation.
 */
class DriveV2LiveValidationHarnessTest {
    @Test
    fun nativeCreatesGenesisWithLargeBlobAndCommitLast() = runBlocking {
        val live = requireLivePhase("native-create")
        val client = LiveCreateOnlyClient(live)
        val bytes = ByteArray(DriveV2CreateArtifact.RESUMABLE_THRESHOLD_BYTES + 257) { index ->
            (index % 251).toByte()
        }
        val blobId = DriveV2Contract.blobId(bytes)
        val entryBody = objectBody(
            live = live,
            entityKind = "entry",
            entityId = ENTRY_ID,
            payload = buildJsonObject {
                put("title", "Native Drive v2 safety validation")
                put("futureRemote", "preserve-across-clients")
                put("createdAt", live.timestamp)
            },
        )
        val entryId = DriveV2Contract.objectId(entryBody)
        val attachmentBody = objectBody(
            live = live,
            entityKind = "attachment",
            entityId = ATTACHMENT_ID,
            blobIds = listOf(blobId),
            payload = buildJsonObject {
                put("entryId", ENTRY_ID)
                put("filename", "native-large.bin")
                put("mimeType", "application/octet-stream")
                put("sha256", blobId.removePrefix("blob-v2-"))
            },
        )
        val attachmentId = DriveV2Contract.objectId(attachmentBody)
        val operationId = "native-genesis-${live.runId}"
        val commitBody = commitBody(
            live = live,
            operationId = operationId,
            objectIds = listOf(entryId, attachmentId),
            blobIds = listOf(blobId),
            parentCommitIds = emptyList(),
        )
        val commitId = DriveV2Contract.commitId(commitBody)

        val blob = DriveV2CreateArtifact(
            kind = "blob",
            generatedDriveFileId = live.nativeBlobDriveFileId,
            parentFolderDriveFileId = live.managedFolderIds.getValue("blobs"),
            canonicalId = blobId,
            path = DriveV2Contract.blobPath(blobId),
            mimeType = "application/octet-stream",
            bytes = bytes,
            appProperties = DriveV2Contract.appProperties(
                live.workspaceId,
                "blob",
                blobId,
                DriveV2CanonicalJson.sha256(bytes),
            ),
            resumableOperationId = "native-resumable-${live.runId}",
        )
        val entry = jsonArtifact(
            live,
            "object",
            live.nativeEntryDriveFileId,
            entryBody,
        )
        val attachment = jsonArtifact(
            live,
            "object",
            live.nativeAttachmentDriveFileId,
            attachmentBody,
        )
        val commit = jsonArtifact(
            live,
            "commit",
            live.nativeCommitDriveFileId,
            commitBody,
        )
        val planned = listOf(blob, entry, attachment, commit)
        val remote = client.loadRemoteInventory()
        val readiness = DriveV2Preflight.validateBeforePlan(
            live.preflight(
                artifacts = remote,
                operationId = operationId,
                descriptors = planned.map(DriveV2CreateArtifact::descriptor),
            ),
        )
        val result = DriveV2CreateTransactionExecutor(client)
            .execute(DriveV2CreateTransaction(readiness, listOf(blob), listOf(entry, attachment), commit))
            .getOrThrow()

        assertEquals(
            listOf(blob.path, entry.path, attachment.path),
            result.prerequisiteReceipts.map(DriveV2CreateReceipt::path),
        )
        assertEquals(commit.path, result.commitReceipt.path)
        assertTrue(result.prerequisiteReceipts.all(DriveV2CreateReceipt::stableSecondRead))
        assertTrue(result.commitReceipt.stableSecondRead)
        val finalInventory = client.loadRemoteInventory()
        assertEquals(planned.map(DriveV2CreateArtifact::path).toSet(), finalInventory.map(DriveV2RemoteArtifact::path).toSet())
    }

    @Test
    fun nativeReadsFinalGraphAndProvesNonResurrection() = runBlocking {
        val live = requireLivePhase("native-read-final")
        val remote = LiveCreateOnlyClient(live).loadRemoteInventory()
        assertEquals(remote.size, remote.map(DriveV2RemoteArtifact::path).distinct().size)

        val objects = remote.filter { it.kind == "object" }.map { artifact ->
            DriveV2ObjectRecord(
                artifact.expectedId,
                DriveV2CanonicalJson.decodeCanonicalObject(artifact.bytes),
            )
        }
        val blobs = remote.filter { it.kind == "blob" }.map { artifact ->
            DriveV2BlobRecord(artifact.expectedId, artifact.bytes, artifact.mimeType)
        }
        val commits = remote.filter { it.kind == "commit" }.map { artifact ->
            DriveV2CommitRecord(
                artifact.expectedId,
                DriveV2CanonicalJson.decodeCanonicalObject(artifact.bytes),
            )
        }
        val state = DriveV2GraphValidator.validateWorkspace(live.workspaceId, objects, blobs, commits)
        val projection = DriveV2GraphValidator.project(state)

        assertEquals(1, state.tips.size)
        assertTrue(commits.size >= 4)
        assertTrue(blobs.any { it.bytes.size > DriveV2CreateArtifact.RESUMABLE_THRESHOLD_BYTES })
        assertFalse("entry:$ENTRY_ID" in projection.visibleTargets)
        assertFalse("attachment:$ATTACHMENT_ID" in projection.visibleTargets)
        assertTrue("entry:$ENTRY_ID" in projection.suppressedTargets)
        assertTrue("attachment:$ATTACHMENT_ID" in projection.suppressedTargets)
        assertTrue(objects.any { record ->
            record.body.text("entityKind") == "entry" &&
                record.body.text("entityId") == ENTRY_ID &&
                record.body.text("operation").endsWith("upsert") &&
                record.body["payload"]?.jsonObject?.get("futureRemote")?.jsonPrimitive?.contentOrNull ==
                "preserve-across-clients"
        })
        assertTrue(objects.any { record ->
            record.body.text("entityKind") == "entry" &&
                record.body.text("entityId") == ENTRY_ID &&
                record.body.text("operation").endsWith("tombstone")
        })
        assertTrue(objects.any { record ->
            record.body.text("entityKind") == "attachment" &&
                record.body.text("entityId") == ATTACHMENT_ID &&
                record.body.text("operation").endsWith("tombstone")
        })
    }

    private fun objectBody(
        live: LiveContext,
        entityKind: String,
        entityId: String,
        payload: JsonObject,
        blobIds: List<String> = emptyList(),
        baseObjectIds: List<String> = emptyList(),
        operation: String = "upsert",
    ) = buildJsonObject {
        put("protocol", DriveV2Contract.PROTOCOL)
        put("schemaVersion", DriveV2Contract.SCHEMA_VERSION)
        put("workspaceId", live.workspaceId)
        put("entityKind", entityKind)
        put("entityId", entityId)
        put("operation", operation)
        put("baseObjectIds", stringArray(baseObjectIds))
        put("blobIds", stringArray(blobIds))
        put("payload", payload)
        put("tombstone", JsonNull)
        put("resolutionOf", JsonArray(emptyList()))
    }

    private fun commitBody(
        live: LiveContext,
        operationId: String,
        objectIds: List<String>,
        blobIds: List<String>,
        parentCommitIds: List<String>,
    ) = buildJsonObject {
        put("protocol", DriveV2Contract.PROTOCOL)
        put("schemaVersion", DriveV2Contract.SCHEMA_VERSION)
        put("workspaceId", live.workspaceId)
        put("operationId", operationId)
        put("createdAt", live.timestamp)
        put("parentCommitIds", stringArray(parentCommitIds))
        put("objectIds", stringArray(objectIds))
        put("blobIds", stringArray(blobIds))
    }

    private fun stringArray(values: List<String>) = buildJsonArray {
        values.distinct().sorted().forEach { add(JsonPrimitive(it)) }
    }

    private fun jsonArtifact(
        live: LiveContext,
        kind: String,
        generatedDriveFileId: String,
        body: JsonObject,
    ): DriveV2CreateArtifact {
        val bytes = DriveV2CanonicalJson.encode(body).toByteArray(StandardCharsets.UTF_8)
        val canonicalId = if (kind == "object") DriveV2Contract.objectId(body) else DriveV2Contract.commitId(body)
        return DriveV2CreateArtifact(
            kind = kind,
            generatedDriveFileId = generatedDriveFileId,
            parentFolderDriveFileId = live.managedFolderIds.getValue(if (kind == "object") "objects" else "commits"),
            canonicalId = canonicalId,
            path = if (kind == "object") DriveV2Contract.objectPath(canonicalId) else DriveV2Contract.commitPath(canonicalId),
            mimeType = DriveV2Contract.JSON_MIME_TYPE,
            bytes = bytes,
            appProperties = DriveV2Contract.appProperties(
                live.workspaceId,
                kind,
                canonicalId,
                DriveV2CanonicalJson.sha256(bytes),
            ),
        )
    }

    private suspend fun requireLivePhase(expectedPhase: String): LiveContext {
        val env = System.getenv()
        val runId = env["EASYLAB_DRIVE_V2_RUN_ID"].orEmpty()
        val authorized = env["EASYLAB_DRIVE_V2_LIVE_WRITE_TEST"] == "approved" &&
            env["EASYLAB_DRIVE_V2_LIVE_MODE"] == "debug-test" &&
            env["EASYLAB_DRIVE_V2_USER_CONFIRMATION"] == "approved:$runId" &&
            env["EASYLAB_DRIVE_V2_NATIVE_PHASE"] == expectedPhase
        assumeTrue("Real Drive v2 validation is explicitly gated and skipped by default.", authorized)

        require(runId.matches(Regex("^[a-z0-9][a-z0-9-]{15,95}$"))) { "Live validation run id is invalid." }
        val repositoryRoot = Path.of(env.required("EASYLAB_DRIVE_V2_REPO_ROOT")).toAbsolutePath().normalize()
        val planFile = Path.of(env.required("EASYLAB_DRIVE_V2_PLAN_FILE")).toAbsolutePath().normalize()
        val expectedPlanFile = repositoryRoot.resolve(
            ".labnote-smoke/drive-v2-append-only-validation/$runId/plan.json",
        ).normalize()
        require(planFile == expectedPlanFile && Files.isRegularFile(planFile)) {
            "Native v2 validation requires the exact ignored one-run plan."
        }
        val plan = Json.parseToJsonElement(
            String(Files.readAllBytes(planFile), StandardCharsets.UTF_8),
        ) as? JsonObject ?: error("Native v2 validation plan must be an object.")
        val planHash = env.required("EASYLAB_DRIVE_V2_PLAN_HASH")
        val sourceCommit = env.required("EASYLAB_DRIVE_V2_SOURCE_COMMIT")
        require(planHash.matches(Regex("^[0-9a-f]{64}$")) && plan["planHash"]?.jsonPrimitive?.contentOrNull == planHash) {
            "Native v2 validation plan hash does not match the gated plan."
        }
        require(sourceCommit.matches(Regex("^[0-9a-f]{40,64}$")) && plan["sourceCommit"]?.jsonPrimitive?.contentOrNull == sourceCommit) {
            "Native v2 validation source commit does not match the gated plan."
        }
        require(runGit(repositoryRoot, "rev-parse", "HEAD") == sourceCommit) {
            "Native v2 validation source commit changed before mutation."
        }
        require(runGit(repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all").isBlank()) {
            "Native v2 validation requires a clean Git worktree."
        }
        require(runGitExit(repositoryRoot, "check-ignore", "--quiet", planFile.toString()) == 0) {
            "Native v2 validation plan must be ignored by Git."
        }
        val workspaceId = env.required("EASYLAB_DRIVE_V2_WORKSPACE_ID")
        require(workspaceId == plan["workspaceId"]?.jsonPrimitive?.contentOrNull) {
            "Native v2 validation workspace marker does not match the plan."
        }
        val selectedAccountSha256 = env.required("EASYLAB_DRIVE_V2_ACCOUNT_SHA256")
        require(selectedAccountSha256.matches(Regex("^[0-9a-f]{64}$"))) {
            "Native v2 validation account binding is malformed."
        }
        val context = LiveContext(
            runId = runId,
            timestamp = env.required("EASYLAB_DRIVE_V2_TIMESTAMP"),
            accountId = AccountId("drive-v2-live:$selectedAccountSha256:$runId"),
            accessToken = env.required("EASYLAB_DRIVE_V2_ACCESS_TOKEN"),
            containerFolderId = env.required("EASYLAB_DRIVE_V2_CONTAINER_FOLDER_ID"),
            rootFolderId = env.required("EASYLAB_DRIVE_V2_WORKSPACE_ROOT_ID"),
            workspaceId = workspaceId,
            managedFolderIds = mapOf(
                "objects" to env.required("EASYLAB_DRIVE_V2_OBJECTS_FOLDER_ID"),
                "blobs" to env.required("EASYLAB_DRIVE_V2_BLOBS_FOLDER_ID"),
                "commits" to env.required("EASYLAB_DRIVE_V2_COMMITS_FOLDER_ID"),
            ),
            nativeBlobDriveFileId = env.required("EASYLAB_DRIVE_V2_NATIVE_BLOB_FILE_ID"),
            nativeEntryDriveFileId = env.required("EASYLAB_DRIVE_V2_NATIVE_ENTRY_FILE_ID"),
            nativeAttachmentDriveFileId = env.required("EASYLAB_DRIVE_V2_NATIVE_ATTACHMENT_FILE_ID"),
            nativeCommitDriveFileId = env.required("EASYLAB_DRIVE_V2_NATIVE_COMMIT_FILE_ID"),
        )
        require(context.timestamp.matches(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"))) {
            "Native v2 validation timestamp must be canonical UTC."
        }
        LiveCreateOnlyClient(context).verifyWorkspaceBoundary()
        return context
    }

    private fun Map<String, String>.required(name: String): String = get(name)?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: throw IllegalArgumentException("Missing live v2 validation environment: $name")

    private fun runGit(repositoryRoot: Path, vararg arguments: String): String {
        val process = ProcessBuilder(listOf("git", "-C", repositoryRoot.toString()) + arguments)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }.trim()
        require(process.waitFor() == 0) { "Native v2 validation Git safety check failed." }
        return output
    }

    private fun runGitExit(repositoryRoot: Path, vararg arguments: String): Int =
        ProcessBuilder(listOf("git", "-C", repositoryRoot.toString()) + arguments)
            .redirectErrorStream(true)
            .start()
            .let { process ->
                process.inputStream.close()
                process.waitFor()
            }

    private data class LiveContext(
        val runId: String,
        val timestamp: String,
        val accountId: AccountId,
        val accessToken: String,
        val containerFolderId: String,
        val rootFolderId: String,
        val workspaceId: String,
        val managedFolderIds: Map<String, String>,
        val nativeBlobDriveFileId: String,
        val nativeEntryDriveFileId: String,
        val nativeAttachmentDriveFileId: String,
        val nativeCommitDriveFileId: String,
    ) {
        fun preflight(
            artifacts: List<DriveV2RemoteArtifact>,
            operationId: String,
            descriptors: List<DriveV2ArtifactDescriptor>,
        ): DriveV2PreflightSnapshot {
            val root = DriveV2WorkspaceItem(
                rootFolderId,
                DriveV2Contract.ROOT_NAME,
                listOf(containerFolderId),
                DriveV2Contract.FOLDER_MIME_TYPE,
                false,
                rootProperties(workspaceId),
            )
            val folders = DriveV2Contract.MANAGED_FOLDER_ROLES.sorted().map { role ->
                DriveV2WorkspaceItem(
                    managedFolderIds.getValue(role),
                    role,
                    listOf(rootFolderId),
                    DriveV2Contract.FOLDER_MIME_TYPE,
                    false,
                    managedFolderProperties(workspaceId, role),
                )
            }
            val journal = DriveV2OperationJournal(
                accountId = accountId,
                savedRootDriveFileId = rootFolderId,
                workspaceId = workspaceId,
                operationId = operationId,
                managedFolderIds = managedFolderIds,
                artifactDescriptors = descriptors.sortedBy(DriveV2ArtifactDescriptor::canonicalId),
                rootParentDriveFileId = containerFolderId,
            )
            return DriveV2PreflightSnapshot(
                currentAccountId = accountId,
                currentSavedRootDriveFileId = rootFolderId,
                currentWorkspaceId = workspaceId,
                currentOperationId = operationId,
                currentManagedFolderIds = managedFolderIds,
                currentArtifactDescriptors = descriptors.sortedBy(DriveV2ArtifactDescriptor::canonicalId),
                journal = journal,
                roots = listOf(root),
                folders = folders,
                artifacts = artifacts,
            )
        }
    }

    private inner class LiveCreateOnlyClient(
        private val live: LiveContext,
        private val transport: DriveWriteTransport = HttpUrlConnectionDriveWriteTransport(
            connectTimeoutMillis = 15_000,
            readTimeoutMillis = 180_000,
            maxResponseBytes = 8 * 1024 * 1024,
        ),
    ) : DriveV2CreateOnlyClient {
        override suspend fun createOrReconcile(
            accountId: AccountId,
            artifact: DriveV2CreateArtifact,
        ): Result<DriveV2CreateReceipt> = try {
            require(accountId == live.accountId) { "Drive v2 validation account changed before creation." }
            val name = artifact.path.substringAfterLast('/')
            val occupants = listChildren(artifact.parentFolderDriveFileId).filter { it.name == name }
            if (occupants.isNotEmpty()) {
                Result.success(reconcile(occupants, artifact))
            } else {
                var mutationStarted = false
                try {
                    mutationStarted = true
                    if (artifact.byteCount >= DriveV2CreateArtifact.RESUMABLE_THRESHOLD_BYTES) {
                        createResumable(artifact, name)
                    } else {
                        createMultipart(artifact, name)
                    }
                    Result.success(verifyExact(artifact))
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    if (!mutationStarted) Result.failure(error) else {
                        val reconciled = tryVerifyExact(artifact)
                        if (reconciled != null) Result.success(reconciled)
                        else Result.failure(DriveV2ContractException("ambiguous-create", error))
                    }
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        }

        suspend fun verifyWorkspaceBoundary() {
            val driveRootId = metadata("root").id
            val container = metadata(live.containerFolderId)
            require(
                container.name.startsWith("Easylab Lab Notebook Safety Validation ") &&
                    container.mimeType == DriveV2Contract.FOLDER_MIME_TYPE &&
                    container.parents == listOf(driveRootId) &&
                    container.appProperties == mapOf("easylabValidationRun" to live.runId) &&
                    !container.trashed,
            ) { "Native v2 validation refused an unmarked container." }
            val root = metadata(live.rootFolderId)
            require(
                root.name == DriveV2Contract.ROOT_NAME &&
                    root.mimeType == DriveV2Contract.FOLDER_MIME_TYPE &&
                    root.parents == listOf(live.containerFolderId) &&
                    root.appProperties == rootProperties(live.workspaceId) &&
                    !root.trashed,
            ) { "Native v2 validation refused a mismatched workspace root." }
            val rootChildren = listChildren(live.rootFolderId)
            require(rootChildren.size == 3) { "Native v2 validation requires exactly three managed folders." }
            for (role in DriveV2Contract.MANAGED_FOLDER_ROLES) {
                val folder = rootChildren.singleOrNull { it.id == live.managedFolderIds.getValue(role) }
                    ?: error("Native v2 validation could not find its exact $role folder.")
                require(
                    folder.name == role &&
                        folder.mimeType == DriveV2Contract.FOLDER_MIME_TYPE &&
                        folder.parents == listOf(live.rootFolderId) &&
                        folder.appProperties == managedFolderProperties(live.workspaceId, role) &&
                        !folder.trashed,
                ) { "Native v2 validation refused a mismatched managed folder." }
            }
        }

        suspend fun loadRemoteInventory(): List<DriveV2RemoteArtifact> {
            val output = mutableListOf<DriveV2RemoteArtifact>()
            for (role in DriveV2Contract.MANAGED_FOLDER_ROLES.sorted()) {
                val kind = role.removeSuffix("s")
                val parentId = live.managedFolderIds.getValue(role)
                for (listed in listChildren(parentId)) {
                    require(listed.mimeType != DriveV2Contract.FOLDER_MIME_TYPE && !listed.trashed) {
                        "Drive v2 managed folders may contain artifacts only."
                    }
                    val canonicalId = listed.appProperties["easylabCanonicalId"]
                        ?: error("Drive v2 artifact omitted canonical identity.")
                    val digest = listed.appProperties["easylabContentSha256"]
                        ?: error("Drive v2 artifact omitted content identity.")
                    val expectedName = when (kind) {
                        "object" -> "$canonicalId.json"
                        "commit" -> "$canonicalId.json"
                        else -> "$canonicalId.bin"
                    }
                    require(listed.name == expectedName && listed.version.matches(POSITIVE_VERSION)) {
                        "Drive v2 artifact path or version is invalid."
                    }
                    require(
                        listed.appProperties == DriveV2Contract.appProperties(
                            live.workspaceId,
                            kind,
                            canonicalId,
                            digest,
                        ) &&
                            (kind == "blob" || listed.mimeType == DriveV2Contract.JSON_MIME_TYPE),
                    ) { "Drive v2 artifact metadata is not canonical." }
                    val first = metadata(listed.id)
                    val bytes = download(listed.id)
                    val second = metadata(listed.id)
                    require(first == second && bytes.size.toLong() == first.size && DriveV2CanonicalJson.sha256(bytes) == digest) {
                        "Drive v2 artifact failed stable content verification."
                    }
                    output += DriveV2RemoteArtifact(
                        kind = kind,
                        driveFileId = first.id,
                        parentFolderDriveFileId = parentId,
                        path = "$role/${first.name}",
                        mimeType = first.mimeType,
                        byteCount = first.size,
                        expectedId = canonicalId,
                        expectedContentSha256 = digest,
                        appProperties = first.appProperties,
                        bytes = bytes,
                    )
                }
            }
            require(output.size == output.map(DriveV2RemoteArtifact::path).distinct().size) {
                "Drive v2 validation refused duplicate canonical paths."
            }
            return output.sortedBy(DriveV2RemoteArtifact::path)
        }

        private suspend fun reconcile(
            occupants: List<LiveFile>,
            artifact: DriveV2CreateArtifact,
        ): DriveV2CreateReceipt {
            require(occupants.size == 1 && occupants.single().id == artifact.generatedDriveFileId) {
                "Drive v2 canonical path is occupied or duplicated."
            }
            return verifyExact(artifact)
        }

        private suspend fun tryVerifyExact(artifact: DriveV2CreateArtifact): DriveV2CreateReceipt? =
            runCatching {
                val name = artifact.path.substringAfterLast('/')
                val occupants = listChildren(artifact.parentFolderDriveFileId).filter { it.name == name }
                if (occupants.size != 1 || occupants.single().id != artifact.generatedDriveFileId) return null
                verifyExact(artifact)
            }.getOrNull()

        private suspend fun verifyExact(artifact: DriveV2CreateArtifact): DriveV2CreateReceipt {
            val first = metadata(artifact.generatedDriveFileId)
            require(
                first.name == artifact.path.substringAfterLast('/') &&
                    first.mimeType == artifact.mimeType &&
                    first.size == artifact.byteCount &&
                    first.parents == listOf(artifact.parentFolderDriveFileId) &&
                    first.appProperties == artifact.appProperties &&
                    first.version.matches(POSITIVE_VERSION) &&
                    !first.trashed,
            ) { "Drive v2 created metadata does not match its immutable artifact." }
            val bytes = download(first.id)
            require(
                bytes.size.toLong() == artifact.byteCount &&
                    DriveV2CanonicalJson.sha256(bytes) == artifact.contentSha256,
            ) { "Drive v2 created bytes do not match their immutable artifact." }
            val second = metadata(first.id)
            require(first == second) { "Drive v2 metadata changed during stable verification." }
            return DriveV2CreateReceipt(
                driveFileId = first.id,
                parentFolderDriveFileId = artifact.parentFolderDriveFileId,
                path = artifact.path,
                canonicalId = artifact.canonicalId,
                contentSha256 = artifact.contentSha256,
                mimeType = artifact.mimeType,
                appProperties = artifact.appProperties,
                byteCount = artifact.byteCount,
                trashed = false,
                stableSecondRead = true,
            )
        }

        private suspend fun createMultipart(artifact: DriveV2CreateArtifact, name: String) {
            require(artifact.resumableOperationId == null)
            val boundary = "easylab-v2-${UUID.randomUUID()}"
            val metadata = artifactMetadata(artifact, name).toString().toByteArray(StandardCharsets.UTF_8)
            val body = multipartBody(boundary, metadata, artifact.mimeType, artifact.bytes)
            request(
                "POST",
                "$UPLOAD_API/files?uploadType=multipart&fields=${encodeQuery(FILE_FIELDS)}",
                mapOf("Content-Type" to "multipart/related; boundary=$boundary"),
                body,
            ).requireSuccess("Drive v2 multipart creation")
        }

        private suspend fun createResumable(artifact: DriveV2CreateArtifact, name: String) {
            require(!artifact.resumableOperationId.isNullOrBlank())
            val initiation = request(
                "POST",
                "$UPLOAD_API/files?uploadType=resumable&fields=${encodeQuery(FILE_FIELDS)}",
                mapOf(
                    "Content-Type" to "application/json; charset=UTF-8",
                    "X-Upload-Content-Type" to artifact.mimeType,
                    "X-Upload-Content-Length" to artifact.byteCount.toString(),
                ),
                artifactMetadata(artifact, name).toString().toByteArray(StandardCharsets.UTF_8),
            ).requireSuccess("Drive v2 resumable initiation")
            val location = initiation.headers.entries.firstOrNull { it.key.equals("Location", ignoreCase = true) }
                ?.value?.trim()?.takeIf(String::isNotBlank)
                ?: error("Drive v2 resumable initiation omitted its session URL.")
            val session = URI(location)
            require(session.scheme == "https" && session.host?.endsWith(".googleapis.com") == true) {
                "Drive v2 resumable initiation returned a session outside Google APIs."
            }
            request(
                "PUT",
                session.toString(),
                mapOf("Content-Type" to artifact.mimeType),
                artifact.bytes,
            ).requireSuccess("Drive v2 resumable content creation")
        }

        private fun artifactMetadata(artifact: DriveV2CreateArtifact, name: String) = buildJsonObject {
            put("id", artifact.generatedDriveFileId)
            put("name", name)
            put("mimeType", artifact.mimeType)
            put("parents", buildJsonArray { add(JsonPrimitive(artifact.parentFolderDriveFileId)) })
            put("appProperties", buildJsonObject {
                artifact.appProperties.forEach { (key, value) -> put(key, value) }
            })
        }

        private suspend fun listChildren(parentId: String): List<LiveFile> {
            val output = mutableListOf<LiveFile>()
            val seen = mutableSetOf<String>()
            var pageToken: String? = null
            do {
                val query = "'$parentId' in parents and trashed = false"
                val url = buildString {
                    append("$DRIVE_API/files?q=${encodeQuery(query)}")
                    append("&spaces=drive&pageSize=1000&fields=${encodeQuery("nextPageToken,files($FILE_FIELDS)")}")
                    pageToken?.let { append("&pageToken=${encodeQuery(it)}") }
                }
                val body = request("GET", url).requireSuccess("Drive v2 child inventory").json()
                val files = body["files"]?.jsonArray ?: error("Drive v2 inventory page omitted files.")
                output += files.map { it.jsonObject.liveFile() }
                pageToken = body["nextPageToken"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
                require(pageToken == null || seen.add(pageToken!!)) { "Drive repeated a v2 inventory page token." }
            } while (pageToken != null)
            return output
        }

        private suspend fun metadata(fileId: String): LiveFile {
            val url = "$DRIVE_API/files/${encodeQuery(fileId)}?fields=${encodeQuery(FILE_FIELDS)}&supportsAllDrives=false"
            return request("GET", url).requireSuccess("Drive v2 metadata read").json().liveFile()
        }

        private suspend fun download(fileId: String): ByteArray = request(
            "GET",
            "$DRIVE_API/files/${encodeQuery(fileId)}?alt=media",
        ).requireSuccess("Drive v2 content read").body

        private suspend fun request(
            method: String,
            url: String,
            headers: Map<String, String> = emptyMap(),
            body: ByteArray? = null,
        ): DriveHttpResponse {
            require(method in setOf("GET", "POST", "PUT")) { "Drive v2 validation forbids update and delete requests." }
            return transport.execute(
                DriveHttpRequest(
                    method = method,
                    url = url,
                    headers = headers + mapOf(
                        "Authorization" to "Bearer ${live.accessToken}",
                        "X-Easylab-Validation-Run" to live.runId,
                    ),
                    body = body,
                ),
            )
        }
    }

    private data class LiveFile(
        val id: String,
        val name: String,
        val mimeType: String,
        val size: Long,
        val trashed: Boolean,
        val version: String,
        val parents: List<String>,
        val appProperties: Map<String, String>,
    )

    private fun JsonObject.liveFile(): LiveFile = LiveFile(
        id = requiredText("id"),
        name = requiredText("name"),
        mimeType = requiredText("mimeType"),
        size = get("size")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
        trashed = get("trashed")?.jsonPrimitive?.booleanOrNull == true,
        version = get("version")?.jsonPrimitive?.contentOrNull.orEmpty(),
        parents = get("parents")?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty(),
        appProperties = (get("appProperties") as? JsonObject)
            ?.mapValues { (_, value) -> value.jsonPrimitive.content }
            .orEmpty(),
    )

    private fun JsonObject.requiredText(name: String): String = get(name)?.jsonPrimitive?.contentOrNull
        ?.takeIf(String::isNotBlank)
        ?: error("Drive v2 metadata omitted $name.")

    private fun DriveHttpResponse.requireSuccess(label: String): DriveHttpResponse = also {
        require(statusCode in 200..299) { "$label failed with HTTP $statusCode." }
    }

    private fun DriveHttpResponse.json(): JsonObject = Json.parseToJsonElement(
        body.toString(StandardCharsets.UTF_8),
    ) as? JsonObject ?: error("Drive v2 response must be a JSON object.")

    private fun multipartBody(
        boundary: String,
        metadata: ByteArray,
        mimeType: String,
        content: ByteArray,
    ): ByteArray = ByteArrayOutputStream().use { output ->
        fun text(value: String) = output.write(value.toByteArray(StandardCharsets.UTF_8))
        text("--$boundary\r\n")
        text("Content-Type: application/json; charset=UTF-8\r\n\r\n")
        output.write(metadata)
        text("\r\n--$boundary\r\n")
        text("Content-Type: $mimeType\r\n\r\n")
        output.write(content)
        text("\r\n--$boundary--\r\n")
        output.toByteArray()
    }

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.name())
        .replace("+", "%20")

    private companion object {
        const val ENTRY_ID = "entry-live-validation"
        const val ATTACHMENT_ID = "attachment-live-validation"
        const val DRIVE_API = "https://www.googleapis.com/drive/v3"
        const val UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
        const val FILE_FIELDS = "id,name,mimeType,modifiedTime,size,trashed,version,parents,appProperties"
        val POSITIVE_VERSION = Regex("^[1-9]\\d*$")

        fun rootProperties(workspaceId: String) = mapOf(
            "easylabDriveProtocol" to "v2-append-only",
            "easylabWorkspaceId" to workspaceId,
            "easylabArtifactKind" to "workspace-root",
        )

        fun managedFolderProperties(workspaceId: String, role: String) = mapOf(
            "easylabDriveProtocol" to "v2-append-only",
            "easylabWorkspaceId" to workspaceId,
            "easylabArtifactKind" to "managed-folder",
            "easylabFolderRole" to role,
        )
    }
}

private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content
