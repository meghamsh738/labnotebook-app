package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.net.URLEncoder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Explicitly gated real-Drive validation entry point.
 *
 * Normal JVM test runs skip both methods. The external validation harness must
 * provide a short-lived token, an already-provisioned marked root, and the exact
 * one-run authorization environment. Production dependency injection remains
 * read-only and never constructs this writer.
 */
class DriveV1LiveValidationHarnessTest {
    @Test
    fun nativeWriterPublishesLargeBlobAndManifestLast() = runBlocking {
        val live = requireLivePhase("native-create")
        val bytes = ByteArray(5 * 1024 * 1024 + 257) { index -> (index % 251).toByte() }
        val blobSha256 = sha256(bytes)
        val blobPath = "attachments/${live.dateBucket}/att-live-validation-native-large.bin"
        val entryPath = "entries/${live.dateBucket}.json"
        val attachmentMetadataPath = "$blobPath.json"

        val entry = DriveV1Envelope(
            id = ENTRY_ID,
            kind = "entry",
            updatedAt = live.timestamp,
            updatedByDeviceId = NATIVE_DEVICE_ID,
            payload = DriveV1Entry(
                id = ENTRY_ID,
                createdDatetime = live.timestamp,
                lastEditedDatetime = live.timestamp,
                authorId = "live-validation-user",
                title = "Native Drive v1 safety validation",
                dateBucket = live.dateBucket,
                isDaily = true,
                content = listOf(buildJsonObject {
                    put("id", "block-live-validation")
                    put("type", "paragraph")
                    put("text", "Isolated Drive v1 validation content")
                }),
                tags = listOf("drive-v1-validation"),
                searchTerms = listOf("validation"),
                linkedFiles = listOf(ATTACHMENT_ID),
                pinnedRegions = emptyList(),
                version = 1,
                updatedByDeviceId = NATIVE_DEVICE_ID,
                syncStatus = "synced",
                source = "manual",
            ),
        ).requireV1("entry")
        val typedEntry = DriveV1Json.format.encodeToJsonElement(
            DriveV1Envelope.serializer(DriveV1Entry.serializer()),
            entry,
        ) as JsonObject
        val entryJson = buildJsonObject {
            typedEntry.forEach(::put)
            put("futureValidationField", "preserve-across-clients")
        }.toString()

        val attachment = DriveV1Envelope(
            id = ATTACHMENT_ID,
            kind = "attachment",
            updatedAt = live.timestamp,
            updatedByDeviceId = NATIVE_DEVICE_ID,
            payload = DriveV1Attachment(
                id = ATTACHMENT_ID,
                entryId = ENTRY_ID,
                type = "file",
                filename = "native-large.bin",
                filesize = "${bytes.size} bytes",
                bytes = bytes.size.toLong(),
                storagePath = blobPath,
                contentType = "application/octet-stream",
                mimeType = "application/octet-stream",
                sha256 = blobSha256,
                syncStatus = "synced",
                createdAt = live.timestamp,
                updatedAt = live.timestamp,
            ),
        ).requireV1("attachment")
        val manifest = DriveV1Manifest(
            rootFolderName = live.folderName,
            createdAt = live.timestamp,
            updatedAt = live.timestamp,
            devices = listOf(
                DriveV1Device(
                    id = NATIVE_DEVICE_ID,
                    name = "Native Drive v1 validation",
                    platform = "mobile",
                    createdAt = live.timestamp,
                    lastSeenAt = live.timestamp,
                    appVersion = "validation-only",
                ).requireV1(),
            ),
            entryCount = 1,
            attachmentCount = 1,
            fileBoxCount = 0,
            transferCount = 0,
        ).requireV1()

        val repository = writer(live)
        val transaction = DriveV1WriteTransaction(
            accountId = live.accountId,
            prerequisites = listOf(
                DriveV1TransactionWrite.Blob(
                    path = blobPath,
                    bytes = bytes,
                    mimeType = "application/octet-stream",
                    sha256 = blobSha256,
                    precondition = DriveWritePrecondition.MustNotExist,
                    resumableOperationId = "native-create-${live.runId}",
                ),
                DriveV1TransactionWrite.Json(
                    path = attachmentMetadataPath,
                    json = DriveV1Json.format.encodeToString(attachment),
                    precondition = DriveWritePrecondition.MustNotExist,
                ),
                DriveV1TransactionWrite.Json(
                    path = entryPath,
                    json = entryJson,
                    precondition = DriveWritePrecondition.MustNotExist,
                ),
            ),
            manifest = DriveV1TransactionWrite.Json(
                path = DriveV1Paths.manifest,
                json = DriveV1Json.format.encodeToString(manifest),
                precondition = DriveWritePrecondition.MustNotExist,
            ),
        )

        val result = DriveV1WriteTransactionExecutor(repository).execute(transaction).getOrThrow()
        assertEquals(
            listOf(blobPath, attachmentMetadataPath, entryPath),
            result.prerequisiteFiles.map { it.path },
        )
        assertEquals(DriveV1Paths.manifest, result.manifestFile.path)
        assertTrue(result.manifestFile.version != null && result.manifestFile.version!! > 0)
    }

    @Test
    fun nativeReadOnlyProjectionVerifiesFinalTombstoneState() = runBlocking {
        val live = requireLivePhase("native-read-final")
        val rootIds = StaticRootFolderIdStore(live.accountId, live.rootFolderId)
        val reader = GoogleDriveReadOnlyRepository(
            authRepository = live.auth,
            rootFolderIds = rootIds,
            transport = HttpUrlConnectionDriveReadOnlyTransport(),
            folderName = live.folderName,
        )
        val snapshot = DriveV1MetadataReader(reader).read(live.accountId)

        assertEquals(0, snapshot.manifest.entryCount)
        assertEquals(0, snapshot.manifest.attachmentCount)
        assertTrue(snapshot.entries.isEmpty())
        assertTrue(snapshot.attachments.isEmpty())
        assertTrue(snapshot.fileBoxItems.isEmpty())
        assertTrue(snapshot.transfers.isEmpty())
        assertTrue(snapshot.tombstones.any { it.value.entityKind == "entry" && it.value.entityId == ENTRY_ID })
        assertTrue(snapshot.manifestRawJson.contains(live.folderName))
    }

    private fun writer(live: LiveContext): GoogleDriveWriteRepository {
        return GoogleDriveWriteRepository(
            authRepository = live.auth,
            resumableOperations = DriveResumableOperationStore(MemoryResumableOperationPersistence()),
            rootFolderIds = StaticRootFolderIdStore(live.accountId, live.rootFolderId),
            transport = HttpUrlConnectionDriveWriteTransport(
                connectTimeoutMillis = 15_000,
                readTimeoutMillis = 120_000,
            ),
            folderName = live.folderName,
            resumableChunkBytes = 1024 * 1024,
        )
    }

    private suspend fun requireLivePhase(expectedPhase: String): LiveContext {
        val env = System.getenv()
        val runId = env["EASYLAB_DRIVE_V1_RUN_ID"].orEmpty()
        val authorized = env["EASYLAB_DRIVE_V1_LIVE_WRITE_TEST"] == "approved" &&
            env["EASYLAB_DRIVE_V1_LIVE_MODE"] == "debug-test" &&
            env["EASYLAB_DRIVE_V1_USER_CONFIRMATION"] == "approved:$runId" &&
            env["EASYLAB_DRIVE_V1_NATIVE_PHASE"] == expectedPhase
        assumeTrue("Real Drive validation is explicitly gated and skipped by default.", authorized)

        require(runId.matches(Regex("^[a-z0-9][a-z0-9-]{15,95}$"))) { "Live validation run id is invalid." }
        val repositoryRoot = Path.of(env.required("EASYLAB_DRIVE_V1_REPO_ROOT")).toAbsolutePath().normalize()
        val planFile = Path.of(env.required("EASYLAB_DRIVE_V1_PLAN_FILE")).toAbsolutePath().normalize()
        val expectedPlanFile = repositoryRoot.resolve(
            ".labnote-smoke/drive-v1-conditional-validation/$runId/plan.json",
        ).normalize()
        require(planFile == expectedPlanFile && Files.isRegularFile(planFile)) {
            "Native live validation requires the exact ignored one-run plan."
        }
        val plan = DriveV1Json.format.parseToJsonElement(
            String(Files.readAllBytes(planFile), StandardCharsets.UTF_8),
        ) as? JsonObject ?: error("Native live validation plan must be an object.")
        val planHash = env.required("EASYLAB_DRIVE_V1_PLAN_HASH")
        val sourceCommit = env.required("EASYLAB_DRIVE_V1_SOURCE_COMMIT")
        require(planHash.matches(Regex("^[0-9a-f]{64}$")) && plan["planHash"]?.jsonPrimitive?.contentOrNull == planHash) {
            "Native live validation plan hash does not match the gated plan."
        }
        require(sourceCommit.matches(Regex("^[0-9a-f]{40,64}$")) && plan["sourceCommit"]?.jsonPrimitive?.contentOrNull == sourceCommit) {
            "Native live validation source commit does not match the gated plan."
        }
        require(runGit(repositoryRoot, "rev-parse", "HEAD") == sourceCommit) {
            "Native live validation source commit changed before mutation."
        }
        require(runGit(repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all").isBlank()) {
            "Native live validation requires a clean Git worktree."
        }
        require(runGitExit(repositoryRoot, "check-ignore", "--quiet", planFile.toString()) == 0) {
            "Native live validation plan must be ignored by Git."
        }
        val folderName = env.required("EASYLAB_DRIVE_V1_ROOT_FOLDER_NAME")
        require(folderName == "Easylab Lab Notebook Safety Validation $runId") {
            "Native live validation requires the exact generated root folder."
        }
        require(plan["rootFolderName"]?.jsonPrimitive?.contentOrNull == folderName) {
            "Native live validation root does not match the one-run plan."
        }
        val rootFolderId = env.required("EASYLAB_DRIVE_V1_ROOT_FOLDER_ID")
        val accessToken = env.required("EASYLAB_DRIVE_V1_ACCESS_TOKEN")
        val dateBucket = env.required("EASYLAB_DRIVE_V1_DATE_BUCKET")
        require(dateBucket.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$"))) { "Live validation date bucket is invalid." }
        val timestamp = env.required("EASYLAB_DRIVE_V1_TIMESTAMP")
        val accountId = AccountId("drive-v1-live:$runId")
        return LiveContext(
            runId = runId,
            folderName = folderName,
            rootFolderId = rootFolderId,
            dateBucket = dateBucket,
            timestamp = timestamp,
            accountId = accountId,
            accessToken = accessToken,
            auth = StaticTokenAuthRepository(accountId, accessToken),
        ).also { verifyLiveRootMarker(it) }
    }

    private suspend fun verifyLiveRootMarker(live: LiveContext) {
        val encodedId = URLEncoder.encode(live.rootFolderId, StandardCharsets.UTF_8.name())
        val response = HttpUrlConnectionDriveReadOnlyTransport().execute(
            DriveHttpRequest(
                method = "GET",
                url = "https://www.googleapis.com/drive/v3/files/$encodedId" +
                    "?fields=id,name,mimeType,trashed,appProperties",
                headers = mapOf("Authorization" to "Bearer ${live.accessToken}"),
            ),
        )
        require(response.statusCode in 200..299) { "Native live validation could not verify its isolated root." }
        val metadata = DriveV1Json.format.parseToJsonElement(
            response.body.toString(StandardCharsets.UTF_8),
        ) as? JsonObject ?: error("Native live validation root metadata must be an object.")
        val marker = (metadata["appProperties"] as? JsonObject)
            ?.get("easylabValidationRun")
            ?.jsonPrimitive
            ?.contentOrNull
        require(
            metadata["id"]?.jsonPrimitive?.contentOrNull == live.rootFolderId &&
                metadata["name"]?.jsonPrimitive?.contentOrNull == live.folderName &&
                metadata["mimeType"]?.jsonPrimitive?.contentOrNull == "application/vnd.google-apps.folder" &&
                metadata["trashed"]?.jsonPrimitive?.booleanOrNull != true &&
                marker == live.runId,
        ) {
            "Native live validation refused an unmarked or mismatched Drive root."
        }
    }

    private fun Map<String, String>.required(name: String): String = get(name)?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: throw IllegalArgumentException("Missing live validation environment: $name")

    private fun runGit(repositoryRoot: Path, vararg arguments: String): String {
        val process = ProcessBuilder(listOf("git", "-C", repositoryRoot.toString()) + arguments)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }.trim()
        require(process.waitFor() == 0) { "Native live validation Git safety check failed." }
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

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private data class LiveContext(
        val runId: String,
        val folderName: String,
        val rootFolderId: String,
        val dateBucket: String,
        val timestamp: String,
        val accountId: AccountId,
        val accessToken: String,
        val auth: StaticTokenAuthRepository,
    )

    private class StaticTokenAuthRepository(
        accountId: AccountId,
        private val accessToken: String,
    ) : AuthRepository {
        override val session: StateFlow<AuthSession?> = MutableStateFlow(
            AuthSession(accountId = accountId, email = "redacted"),
        )
        override val driveAccess: StateFlow<DriveAccessState> = MutableStateFlow(DriveAccessState.SignedOut)
        override suspend fun restore() = Unit
        override suspend fun connect(): Result<AuthSession> = Result.failure(UnsupportedOperationException())
        override suspend fun disconnect() = Unit
        override suspend fun invalidateAccessToken(accountId: AccountId) = Unit
        override fun accessToken(accountId: AccountId): String = accessToken
    }

    private class StaticRootFolderIdStore(accountId: AccountId, rootFolderId: String) : DriveRootFolderIdStore {
        private val expectedAccountId = accountId
        private var value: String? = rootFolderId

        override fun get(accountId: AccountId): String? = value.takeIf { accountId == expectedAccountId }

        override fun set(accountId: AccountId, folderId: String?) {
            require(accountId == expectedAccountId) { "Live root folder store is account-scoped." }
            value = folderId
        }
    }

    private class MemoryResumableOperationPersistence : DriveResumableOperationPersistence {
        private val lock = Any()
        private val records = mutableMapOf<String, String>()

        override suspend fun read(key: String): String? = synchronized(lock) { records[requireKey(key)] }

        override suspend fun bindIfAbsent(key: String, value: String): String = synchronized(lock) {
            records.getOrPut(requireKey(key)) { value }
        }

        override suspend fun compareAndSet(key: String, expected: String, value: String): Boolean = synchronized(lock) {
            val validatedKey = requireKey(key)
            if (records[validatedKey] != expected) return@synchronized false
            records[validatedKey] = value
            true
        }

        private fun requireKey(key: String): String = key.also {
            require(it.matches(Regex("^[0-9a-f]{64}:[0-9a-f]{64}$"))) {
                "Live operation storage key is invalid."
            }
        }
    }

    private companion object {
        const val NATIVE_DEVICE_ID = "dev-native-live-validation"
        const val ENTRY_ID = "entry-live-validation"
        const val ATTACHMENT_ID = "att-live-validation"
    }
}
