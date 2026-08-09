package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import com.easylab.labnotebook.data.repository.DriveHttpException
import com.easylab.labnotebook.data.repository.DriveProtocolException
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleDriveWriteRepositoryTest {
    @Test
    fun createsWorkspaceFoldersAndJsonWithExactAccountToken() = runTest {
        val fixture = Fixture()
        val json = """
            {"schemaVersion":1,"entityType":"entry","payload":{"id":"entry-a","future":{"kept":true}}}
        """.trimIndent()

        val result = fixture.repository.putJson(
            ACCOUNT_A,
            "entries/2026-07-16/entry-a.json",
            json,
        ).getOrThrow()

        assertEquals(DriveWriteCapability.Enabled, fixture.repository.writeCapability)
        assertEquals("entries/2026-07-16/entry-a.json", result.path)
        assertEquals(1L, result.version)
        assertEquals("entry-a", result.appProperties["entityId"])
        assertEquals("entry", result.appProperties["entityType"])
        assertTrue(fixture.store.get(ACCOUNT_A).orEmpty().isNotBlank())
        assertEquals(
            listOf("Easylab Lab Notebook", "entries", "2026-07-16"),
            fixture.transport.createdFolders,
        )
        val upload = fixture.transport.requests.single { request ->
            request.method == "POST" && request.url.contains("/upload/drive/v3/files?")
        }
        assertEquals("Bearer exact-token-a", upload.headers["Authorization"])
        assertTrue(upload.body!!.toString(StandardCharsets.UTF_8).contains(json))
        assertTrue(fixture.transport.requests.all { it.headers["Authorization"] == "Bearer exact-token-a" })
    }

    @Test
    fun updatesTheSingleExistingManagedFileWithPatch() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(
            fileCopies = 1,
            existingAppProperties = mapOf(
                "entityType" to "entry",
                "futureProperty" to "keep-me",
            ),
        )

        val result = fixture.repository.putJson(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
        ).getOrThrow()

        assertEquals("entry-file-1", result.id)
        assertEquals(2L, result.version)
        assertEquals("keep-me", result.appProperties["futureProperty"])
        assertEquals("entry-a", result.appProperties["entityId"])
        val writes = fixture.transport.requests.filter { it.method in setOf("POST", "PATCH") }
        assertEquals(1, writes.size)
        assertEquals("PATCH", writes.single().method)
        assertTrue(writes.single().url.contains("/upload/drive/v3/files/entry-file-1?"))
    }

    @Test
    fun duplicateManagedPathFailsBeforeUpload() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 2)

        val error = fixture.repository.putJson(ACCOUNT_A, ENTRY_PATH, ENTRY_JSON).exceptionOrNull()

        assertTrue(error is DriveProtocolException)
        assertTrue(error?.message.orEmpty().contains("duplicate managed path"))
        assertFalse(fixture.transport.requests.any { it.url.contains("/upload/") })
    }

    @Test
    fun invalidJsonPathsAndBlobHashesFailWithoutNetworkUse() = runTest {
        val fixture = Fixture()

        assertTrue(
            fixture.repository.putJson(ACCOUNT_A, "../entries/a.json", "{}").exceptionOrNull()
                is DriveProtocolException,
        )
        val invalidJsonError = fixture.repository
            .putJson(ACCOUNT_A, "entries/a.json", "not-json")
            .exceptionOrNull()
        assertTrue(invalidJsonError.toString(), invalidJsonError is DriveProtocolException)
        assertTrue(
            fixture.repository.putBlob(
                ACCOUNT_A,
                "filebox/raw.bin",
                byteArrayOf(1),
                "application/octet-stream",
                "0".repeat(64),
            ).exceptionOrNull() is DriveProtocolException,
        )
        assertTrue(
            fixture.repository.putBlob(
                ACCOUNT_A,
                "attachments/2026-07-16/raw.bin",
                byteArrayOf(1),
                "application/octet-stream",
                "0".repeat(64),
            ).exceptionOrNull() is DriveProtocolException,
        )
        assertTrue(fixture.transport.requests.isEmpty())
    }

    @Test
    fun blobUploadCreatesAttachmentFoldersAndCarriesVerifiedSha() = runTest {
        val fixture = Fixture()
        val bytes = "instrument export".toByteArray()
        val sha256 = sha256(bytes)

        val result = fixture.repository.putBlob(
            ACCOUNT_A,
            "attachments/2026-07-16/att-a.csv",
            bytes,
            "text/csv; charset=utf-8",
            sha256.uppercase(),
        ).getOrThrow()

        assertEquals("text/csv", result.mimeType)
        assertEquals("attachmentBlob", result.appProperties["entityType"])
        assertEquals(sha256, result.appProperties["sha256"])
        assertEquals(bytes.toList(), fixture.transport.lastUploadedContent?.toList())
    }

    @Test
    fun concurrentWritesShareOneManagedFolderTree() = runTest {
        val fixture = Fixture()
        val writes = listOf("entry-a", "entry-b").map { id ->
            async {
                fixture.repository.putJson(
                    ACCOUNT_A,
                    "entries/2026-07-16/$id.json",
                    "{\"schemaVersion\":1,\"entityType\":\"entry\",\"payload\":{\"id\":\"$id\"}}",
                ).getOrThrow()
            }
        }.awaitAll()

        assertEquals(2, writes.size)
        assertEquals(1, fixture.transport.createdFolders.count { it == "Easylab Lab Notebook" })
        assertEquals(1, fixture.transport.createdFolders.count { it == "entries" })
        assertEquals(1, fixture.transport.createdFolders.count { it == "2026-07-16" })
    }

    @Test
    fun httpFailuresRetainTypedDriveSemantics() = runTest {
        val fixture = Fixture()
        fixture.store.set(ACCOUNT_A, "root-a")
        fixture.transport.forcedStatus = 401

        val error = fixture.repository.putJson(ACCOUNT_A, "entries/a.json", "{}").exceptionOrNull()

        assertTrue(error is DriveHttpException)
        assertEquals(401, (error as DriveHttpException).statusCode)
        assertFalse(error.retryable)
    }

    @Test
    fun conditionalPatchUsesFreshEtagAndVerifiesMetadataAndMedia() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(
            fileCopies = 1,
            existingAppProperties = mapOf("futureProperty" to "keep-me"),
        )

        val result = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).getOrThrow()

        assertEquals("entry-file-1", result.id)
        assertEquals(2L, result.version)
        val patch = fixture.transport.requests.single { it.method == "PATCH" }
        assertEquals("\"etag-entry-file-1-v1\"", patch.headers["If-Match"])
        assertTrue(
            fixture.transport.requests.any {
                it.method == "GET" && queryParameter(it.url, "alt") == "media"
            },
        )
    }

    @Test
    fun conditionalJsonRefreshesWebCompatibleSemanticContentHash() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(
            fileCopies = 1,
            existingAppProperties = mapOf("contentHash" to "stale", "futureProperty" to "keep-me"),
        )
        val rawJson = resource("drive-v1/entries/2026-05-23.json")
        val envelope = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Entry>>(rawJson)
            .value
            .requireV1("entry")

        val result = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            rawJson,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).getOrThrow()

        assertEquals(DriveV1Hashing.entryContentHash(envelope.payload), result.appProperties["contentHash"])
        assertEquals("entry-contract", result.appProperties["entityId"])
        assertEquals("keep-me", result.appProperties["futureProperty"])
    }

    @Test
    fun staleMetadataFailsBeforeConditionalPatch() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.changeVersionOnNextMetadataGet = true

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveWritePreconditionConflictException)
        assertFalse(fixture.transport.requests.any { it.method == "PATCH" })
    }

    @Test
    fun missingEtagFailsClosedBeforeConditionalPatch() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.omitMetadataEtag = true

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveProtocolException)
        assertTrue(error?.message.orEmpty().contains("ETag"))
        assertFalse(fixture.transport.requests.any { it.method == "PATCH" })
    }

    @Test
    fun movedFileFailsBeforeConditionalPatch() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.moveFileOnNextMetadataGet = true

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveWritePreconditionConflictException)
        assertFalse(fixture.transport.requests.any { it.method == "PATCH" })
    }

    @Test
    fun conditionalPatchMapsHttp412ToTypedConflict() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.changeVersionBeforePatch = true

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveWritePreconditionConflictException)
        assertEquals(412, (error as DriveWritePreconditionConflictException).statusCode)
    }

    @Test
    fun conditionalPatchMapsHttp409ToTypedConflict() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.rejectPatchStatus = 409

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveWritePreconditionConflictException)
        assertEquals(409, (error as DriveWritePreconditionConflictException).statusCode)
    }

    @Test
    fun conditionalCreateWritesOnlyAMissingPathAndCarriesDeterministicIdentity() = runTest {
        val fixture = Fixture()
        fixture.addEmptyEntryTree()

        val result = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustNotExist,
        ).getOrThrow()

        assertEquals(ENTRY_PATH, result.path)
        assertEquals(1L, result.version)
        assertTrue(result.appProperties.getValue("easylabCreateFingerprint").matches(Regex("[0-9a-f]{64}")))
        assertEquals(1, fixture.transport.requests.count { it.method == "POST" && it.url.contains("/upload/") })
        assertFalse(fixture.transport.requests.any { it.method == "PATCH" })
    }

    @Test
    fun conditionalCreateHonorsFreshExactSavedRootWithPrecreatedNestedFolder() = runTest {
        val fixture = Fixture()
        fixture.addUninitializedEntryTree()

        val result = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustNotExist,
        ).getOrThrow()

        assertEquals(ENTRY_PATH, result.path)
        assertEquals("root-a", fixture.store.get(ACCOUNT_A))
        assertEquals(1, fixture.transport.requests.count { it.method == "POST" && it.url.contains("/upload/") })
        assertFalse(fixture.transport.createdFolders.isNotEmpty())
    }

    @Test
    fun conditionalCreateRejectsMovedSavedRootWithoutSwitchingWorkspaces() = runTest {
        val fixture = Fixture()
        fixture.addMovedSavedRootAndSeparateValidRoot()

        val errors = List(2) {
            fixture.repository.putJsonConditional(
                ACCOUNT_A,
                ENTRY_PATH,
                ENTRY_JSON,
                DriveWritePrecondition.MustNotExist,
            ).exceptionOrNull()
        }

        assertTrue(errors.all { it is DriveWritePreconditionConflictException })
        assertEquals("root-a", fixture.store.get(ACCOUNT_A))
        assertFalse(fixture.transport.requests.any { it.method in setOf("POST", "PATCH") })
    }

    @Test
    fun lostCreateResponseReconcilesAndRetryDoesNotCreateADuplicate() = runTest {
        val fixture = Fixture()
        fixture.addEmptyEntryTree()
        fixture.transport.losePostResponseAfterCommit = true

        val first = fixture.repository.putJsonConditional(
            ACCOUNT_A, ENTRY_PATH, ENTRY_JSON, DriveWritePrecondition.MustNotExist,
        ).getOrThrow()
        val retry = fixture.repository.putJsonConditional(
            ACCOUNT_A, ENTRY_PATH, ENTRY_JSON, DriveWritePrecondition.MustNotExist,
        ).getOrThrow()

        assertEquals(first, retry)
        assertEquals(1, fixture.transport.requests.count { it.method == "POST" && it.url.contains("/upload/") })
    }

    @Test
    fun createOnlyRetryFailsClosedWhenPathContentDoesNotMatch() = runTest {
        val fixture = Fixture()
        fixture.addEmptyEntryTree()
        fixture.repository.putJsonConditional(
            ACCOUNT_A, ENTRY_PATH, ENTRY_JSON, DriveWritePrecondition.MustNotExist,
        ).getOrThrow()
        val writesBeforeMismatch = fixture.transport.requests.count { it.method in setOf("POST", "PATCH") }

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON.replace("entry-a", "entry-b"),
            DriveWritePrecondition.MustNotExist,
        ).exceptionOrNull()

        assertTrue(error is DriveWritePreconditionConflictException)
        assertEquals(writesBeforeMismatch, fixture.transport.requests.count { it.method in setOf("POST", "PATCH") })
    }

    @Test
    fun createOnlyFailsClosedOnDuplicatePathWithoutAnotherUpload() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 2)

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A, ENTRY_PATH, ENTRY_JSON, DriveWritePrecondition.MustNotExist,
        ).exceptionOrNull()

        assertTrue(error is DriveWritePreconditionConflictException)
        assertFalse(fixture.transport.requests.any { it.method in setOf("POST", "PATCH") })
    }

    @Test
    fun cancellationAfterCreateIsReconciledButStillPropagatesAndRetryIsSafe() = runTest {
        val fixture = Fixture()
        fixture.addEmptyEntryTree()
        fixture.transport.cancelPostAfterCommit = true
        var cancellation: CancellationException? = null

        try {
            fixture.repository.putJsonConditional(
                ACCOUNT_A, ENTRY_PATH, ENTRY_JSON, DriveWritePrecondition.MustNotExist,
            )
        } catch (error: CancellationException) {
            cancellation = error
        }

        assertTrue(
            cancellation?.suppressed?.singleOrNull() is
                DriveWriteReconciledAfterCancellationException,
        )
        val retry = fixture.repository.putJsonConditional(
            ACCOUNT_A, ENTRY_PATH, ENTRY_JSON, DriveWritePrecondition.MustNotExist,
        ).getOrThrow()
        assertEquals(ENTRY_PATH, retry.path)
        assertEquals(1, fixture.transport.requests.count { it.method == "POST" && it.url.contains("/upload/") })
    }

    @Test
    fun conditionalUpdateNeverCreatesAMissingWorkspaceOrFolders() = runTest {
        val missingWorkspace = Fixture()

        val workspaceError = missingWorkspace.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(workspaceError is DriveWritePreconditionConflictException)
        assertTrue(missingWorkspace.transport.requests.isNotEmpty())
        assertTrue(missingWorkspace.transport.requests.all { it.method == "GET" })

        val missingFolders = Fixture()
        missingFolders.addExistingRoot()

        val folderError = missingFolders.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(folderError is DriveWritePreconditionConflictException)
        assertTrue(missingFolders.transport.requests.isNotEmpty())
        assertTrue(missingFolders.transport.requests.all { it.method == "GET" })
    }

    @Test
    fun conditionalWriteFailsWhenMediaReadBackIsCorrupt() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.corruptMediaReadBack = true

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveWriteAmbiguousCommitException)
        assertTrue(error?.cause is DriveProtocolException)
        assertTrue(error?.cause?.message.orEmpty().contains("content verification"))
    }

    @Test
    fun lostPatchResponseReconcilesAndOldPreconditionRetryIsIdempotent() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.losePatchResponseAfterCommit = true
        val precondition = DriveWritePrecondition.MustMatch("entry-file-1", 1)

        val first = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            precondition,
        ).getOrThrow()
        val retry = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            precondition,
        ).getOrThrow()

        assertEquals(2L, first.version)
        assertEquals(first, retry)
        assertEquals(1, fixture.transport.requests.count { it.method == "PATCH" })
    }

    @Test
    fun cancellationAfterCommitIsReconciledButAlwaysPropagatesAndRetryIsSafe() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.cancelPatchAfterCommit = true
        val precondition = DriveWritePrecondition.MustMatch("entry-file-1", 1)
        var cancellation: CancellationException? = null

        try {
            fixture.repository.putJsonConditional(
                ACCOUNT_A,
                ENTRY_PATH,
                ENTRY_JSON,
                precondition,
            )
        } catch (error: CancellationException) {
            cancellation = error
        }

        val diagnostic = cancellation?.suppressed
            ?.singleOrNull() as? DriveWriteReconciledAfterCancellationException
        assertEquals(ENTRY_PATH, diagnostic?.file?.path)
        assertEquals(2L, diagnostic?.file?.version)

        val retry = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            precondition,
        ).getOrThrow()

        assertEquals(2L, retry.version)
        assertEquals(1, fixture.transport.requests.count { it.method == "PATCH" })
    }

    @Test
    fun conditionalPatchMapsHttp404ToTypedConflict() = runTest {
        val fixture = Fixture()
        fixture.addExistingTree(fileCopies = 1)
        fixture.transport.rejectPatchStatus = 404

        val error = fixture.repository.putJsonConditional(
            ACCOUNT_A,
            ENTRY_PATH,
            ENTRY_JSON,
            DriveWritePrecondition.MustMatch("entry-file-1", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveWritePreconditionConflictException)
        assertEquals(404, (error as DriveWritePreconditionConflictException).statusCode)
    }

    @Test
    fun conditionalBlobAboveMultipartLimitRequiresStableOperationIdentityWithoutNetwork() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1)

        val error = fixture.repository.putBlobConditional(
            ACCOUNT_A,
            "attachments/2026-07-16/large.bin",
            bytes,
            "application/octet-stream",
            sha256(bytes),
            DriveWritePrecondition.MustMatch("large-file", 1),
        ).exceptionOrNull()

        assertTrue(error is DriveProtocolException)
        assertTrue(error?.message.orEmpty().contains("persisted operation id"))
        assertTrue(fixture.transport.requests.isEmpty())
    }

    @Test
    fun resumableBlobInterruptionRetryAndStaleIdentityAreSafe() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 251).toByte() }
        fixture.addExistingBlobTree()
        fixture.transport.loseFirstResumableChunkResponseAfterAccept = true
        val precondition = DriveWritePrecondition.MustMatch("large-file", 1)

        val first = fixture.repository.putBlobConditionalResumable(
            ACCOUNT_A,
            LARGE_BLOB_PATH,
            bytes,
            "application/octet-stream",
            sha256(bytes),
            precondition,
            "operation-large-1",
        ).getOrThrow()
        val retry = fixture.repository.putBlobConditionalResumable(
            ACCOUNT_A,
            LARGE_BLOB_PATH,
            bytes,
            "application/octet-stream",
            sha256(bytes),
            precondition,
            "operation-large-1",
        ).getOrThrow()
        val requestsBeforeConflict = fixture.transport.requests.size
        val changed = bytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val staleIdentity = fixture.repository.putBlobConditionalResumable(
            ACCOUNT_A,
            LARGE_BLOB_PATH,
            changed,
            "application/octet-stream",
            sha256(changed),
            precondition,
            "operation-large-1",
        ).exceptionOrNull()

        assertEquals(2L, first.version)
        assertEquals(first, retry)
        assertTrue(staleIdentity is DriveResumableOperationIdentityConflictException)
        assertEquals(requestsBeforeConflict, fixture.transport.requests.size)
        assertEquals(
            1,
            fixture.transport.requests.count {
                it.method == "PATCH" && queryParameter(it.url, "uploadType") == "resumable"
            },
        )
        assertTrue(fixture.transport.requests.any { it.headers["Content-Range"]?.startsWith("bytes */") == true })
        assertEquals(
            DriveResumableOperationState.Completed,
            fixture.operationStore.record(ACCOUNT_A, "operation-large-1")?.state,
        )
    }

    @Test
    fun resumableCreateUsesOneGeneratedIdAndReconcilesExactRetry() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 227).toByte() }
        fixture.addEmptyAttachmentTree()

        val first = fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A,
            LARGE_BLOB_PATH,
            bytes,
            "application/octet-stream",
            sha256(bytes),
            DriveWritePrecondition.MustNotExist,
            "create-large-1",
        ).getOrThrow()
        val retry = fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A,
            LARGE_BLOB_PATH,
            bytes,
            "application/octet-stream",
            sha256(bytes),
            DriveWritePrecondition.MustNotExist,
            "create-large-1",
        ).getOrThrow()

        assertEquals(first, retry)
        assertTrue(first.id.startsWith("pre-generated-"))
        assertEquals(1, fixture.transport.requests.count { it.url.contains("files/generateIds") })
        assertEquals(
            1,
            fixture.transport.requests.count {
                it.method == "POST" && queryParameter(it.url, "uploadType") == "resumable"
            },
        )
        assertTrue(fixture.transport.lastUploadedContent?.contentEquals(bytes) == true)
        assertTrue(
            fixture.operationStore.record(ACCOUNT_A, "create-large-1")?.identity?.target
                is DriveResumableOperationTarget.New,
        )
    }

    @Test
    fun resumableCreateRejectsChangedIdentityAndGeneratedIdCollisionWithoutUpload() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 223).toByte() }
        fixture.addEmptyAttachmentTree()

        fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-large-immutable",
        ).getOrThrow()
        val resumableCreatesBeforeStaleIdentity = fixture.transport.requests.count {
            it.method == "POST" && queryParameter(it.url, "uploadType") == "resumable"
        }
        val changed = bytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val stale = fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, changed, "application/octet-stream", sha256(changed),
            DriveWritePrecondition.MustNotExist, "create-large-immutable",
        ).exceptionOrNull()

        assertTrue(stale is DriveResumableOperationIdentityConflictException)
        assertEquals(
            resumableCreatesBeforeStaleIdentity,
            fixture.transport.requests.count {
                it.method == "POST" && queryParameter(it.url, "uploadType") == "resumable"
            },
        )

        val collision = Fixture().also {
            it.addEmptyAttachmentTree()
            it.transport.preGeneratedIdCollision = true
        }
        val collisionError = collision.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-large-collision",
        ).exceptionOrNull()

        assertTrue(collisionError is DriveWritePreconditionConflictException)
        assertEquals(
            0,
            collision.transport.requests.count {
                it.method == "POST" && queryParameter(it.url, "uploadType") == "resumable"
            },
        )
    }

    @Test
    fun resumableCreateAmbiguityRestartsOnlyWithItsPersistedGeneratedId() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 211).toByte() }
        fixture.addEmptyAttachmentTree()
        fixture.transport.failFirstResumableChunkBeforeAccept = true
        fixture.transport.failResumableStatusQueries = true

        val interrupted = fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-large-retry",
        ).exceptionOrNull()
        fixture.transport.failResumableStatusQueries = false
        val retry = fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-large-retry",
        ).getOrThrow()

        assertTrue(interrupted is DriveWriteAmbiguousCommitException)
        assertTrue(retry.id.startsWith("pre-generated-"))
        assertEquals(1, fixture.transport.requests.count { it.url.contains("files/generateIds") })
        assertEquals(
            2,
            fixture.transport.requests.count {
                it.method == "POST" && queryParameter(it.url, "uploadType") == "resumable"
            },
        )
    }

    @Test
    fun resumableCreateCancellationAfterCommitPropagatesAndRecordsCompletion() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 199).toByte() }
        fixture.addEmptyAttachmentTree()
        fixture.transport.cancelFinalResumableResponseAfterCommit = true

        val cancellation = runCatching {
            fixture.repository.putBlobConditionalResumableCreate(
                ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
                DriveWritePrecondition.MustNotExist, "create-large-cancel",
            )
        }.exceptionOrNull()

        assertTrue(cancellation is CancellationException)
        assertTrue(
            fixture.operationStore.record(ACCOUNT_A, "create-large-cancel")?.state ==
                DriveResumableOperationState.Completed,
        )
    }

    @Test
    fun abandonedPathReservationIsAdoptedByIndependentStoreWithoutNewId() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 197).toByte() }
        fixture.addEmptyAttachmentTree()
        fixture.transport.failFirstResumableChunkBeforeAccept = true
        fixture.transport.failResumableStatusQueries = true

        val first = fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-reservation-owner",
        ).exceptionOrNull()
        fixture.transport.failResumableStatusQueries = false
        val independentStore = DriveResumableOperationStore(FakeResumableOperationPersistence())
        val recovered = fixture.newRepository(independentStore).putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-reservation-recovery",
        ).getOrThrow()

        assertTrue(first is DriveWriteAmbiguousCommitException)
        assertTrue(recovered.id.startsWith("pre-generated-"))
        assertEquals(1, fixture.transport.requests.count { it.url.contains("files/generateIds") })
        assertTrue(
            independentStore.record(ACCOUNT_A, "create-reservation-recovery")?.identity?.fileId == recovered.id,
        )
    }

    @Test
    fun abandonedReservationDoesNotBlockDifferentPathInSameFolder() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 193).toByte() }
        fixture.addEmptyAttachmentTree()
        fixture.transport.failFirstResumableChunkBeforeAccept = true
        fixture.transport.failResumableStatusQueries = true

        fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-path-one",
        ).exceptionOrNull()
        fixture.transport.failResumableStatusQueries = false
        val otherPath = "attachments/2026-07-16/other-large.bin"
        val created = fixture.newRepository().putBlobConditionalResumableCreate(
            ACCOUNT_A, otherPath, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-path-two",
        ).getOrThrow()

        assertEquals(otherPath, created.path)
        assertEquals(2, fixture.transport.requests.count { it.url.contains("files/generateIds") })
    }

    @Test
    fun independentStoreCannotAdoptReservationForDifferentContent() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 191).toByte() }
        fixture.addEmptyAttachmentTree()
        fixture.transport.failFirstResumableChunkBeforeAccept = true
        fixture.transport.failResumableStatusQueries = true

        fixture.repository.putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-original-content",
        ).exceptionOrNull()
        val changed = bytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val independentStore = DriveResumableOperationStore(FakeResumableOperationPersistence())
        val conflict = fixture.newRepository(independentStore).putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, changed, "application/octet-stream", sha256(changed),
            DriveWritePrecondition.MustNotExist, "create-different-content",
        ).exceptionOrNull()

        assertTrue(conflict is DriveWritePreconditionConflictException)
        assertEquals(1, fixture.transport.requests.count { it.url.contains("files/generateIds") })
    }

    @Test
    fun independentStoreAdoptsCommittedFileWhenOwnerCouldNotReleaseReservation() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 181).toByte() }
        fixture.addEmptyAttachmentTree()
        fixture.transport.cancelFinalResumableResponseAfterCommit = true
        fixture.transport.failReservationRelease = true

        val ownerCancellation = runCatching {
            fixture.repository.putBlobConditionalResumableCreate(
                ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
                DriveWritePrecondition.MustNotExist, "create-owner-committed",
            )
        }.exceptionOrNull()
        fixture.transport.failReservationRelease = false
        val independentStore = DriveResumableOperationStore(FakeResumableOperationPersistence())
        val recovered = fixture.newRepository(independentStore).putBlobConditionalResumableCreate(
            ACCOUNT_A, LARGE_BLOB_PATH, bytes, "application/octet-stream", sha256(bytes),
            DriveWritePrecondition.MustNotExist, "create-adopt-committed",
        ).getOrThrow()

        assertTrue(ownerCancellation is CancellationException)
        assertEquals(LARGE_BLOB_PATH, recovered.path)
        assertEquals(
            DriveResumableOperationState.Completed,
            independentStore.record(ACCOUNT_A, "create-adopt-committed")?.state,
        )
        assertEquals(1, fixture.transport.requests.count { it.url.contains("files/generateIds") })
    }

    @Test
    fun resumableBlobCancellationAfterCommitPropagatesAndPersistsCompletion() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 241).toByte() }
        fixture.addExistingBlobTree()
        fixture.transport.cancelFinalResumableResponseAfterCommit = true
        var cancellation: CancellationException? = null

        try {
            fixture.repository.putBlobConditionalResumable(
                ACCOUNT_A,
                LARGE_BLOB_PATH,
                bytes,
                "application/octet-stream",
                sha256(bytes),
                DriveWritePrecondition.MustMatch("large-file", 1),
                "operation-cancelled",
            )
        } catch (error: CancellationException) {
            cancellation = error
        }

        assertEquals("simulated resumable cancellation after commit", cancellation?.message)
        assertTrue(
            cancellation?.suppressed?.any {
                it is DriveWriteReconciledAfterCancellationException && it.file.version == 2L
            } == true,
        )
        assertEquals(
            DriveResumableOperationState.Completed,
            fixture.operationStore.record(ACCOUNT_A, "operation-cancelled")?.state,
        )
    }

    @Test
    fun unreconciledResumableOutcomePersistsAmbiguousState() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 239).toByte() }
        fixture.addExistingBlobTree()
        fixture.transport.failFirstResumableChunkBeforeAccept = true
        fixture.transport.failResumableStatusQueries = true

        val error = fixture.repository.putBlobConditionalResumable(
            ACCOUNT_A,
            LARGE_BLOB_PATH,
            bytes,
            "application/octet-stream",
            sha256(bytes),
            DriveWritePrecondition.MustMatch("large-file", 1),
            "operation-ambiguous",
        ).exceptionOrNull()

        assertTrue(error is DriveWriteAmbiguousCommitException)
        assertEquals(
            DriveResumableOperationState.Ambiguous,
            fixture.operationStore.record(ACCOUNT_A, "operation-ambiguous")?.state,
        )
    }

    @Test
    fun resumableUploadUsesFrozenCallerBytesForIdentityAndContent() = runTest {
        val fixture = Fixture()
        val bytes = ByteArray(5 * 1024 * 1024 + 1) { (it % 233).toByte() }
        val frozen = bytes.copyOf()
        fixture.addExistingBlobTree()
        fixture.transport.onResumableInitiated = { bytes.fill(0x5a) }

        fixture.repository.putBlobConditionalResumable(
            ACCOUNT_A,
            LARGE_BLOB_PATH,
            bytes,
            "application/octet-stream",
            sha256(frozen),
            DriveWritePrecondition.MustMatch("large-file", 1),
            "operation-frozen",
        ).getOrThrow()

        assertTrue(fixture.transport.lastUploadedContent?.contentEquals(frozen) == true)
        assertEquals(
            sha256(frozen),
            fixture.operationStore.record(ACCOUNT_A, "operation-frozen")?.identity?.sha256,
        )
    }

    private class Fixture {
        val auth = FakeAuthRepository(mapOf(ACCOUNT_A to "exact-token-a"))
        val store = InMemoryDriveRootFolderIdStore()
        val operationPersistence = FakeResumableOperationPersistence()
        val operationStore = DriveResumableOperationStore(operationPersistence)
        val transport = FakeDriveWriteTransport()
        val repository = newRepository()

        fun newRepository(
            resumableStore: DriveResumableOperationStore = operationStore,
        ) = GoogleDriveWriteRepository(
            authRepository = auth,
            resumableOperations = resumableStore,
            rootFolderIds = store,
            transport = transport,
            resumableChunkBytes = 256 * 1024,
            boundaryFactory = { "easylab-test-boundary" },
        )

        fun addExistingTree(
            fileCopies: Int,
            existingAppProperties: Map<String, String> = emptyMap(),
        ) {
            addExistingRoot()
            transport.add(FakeNode.folder("entries", "entries", parentId = "root-a"))
            transport.add(FakeNode.folder("day", "2026-07-16", parentId = "entries"))
            repeat(fileCopies) { index ->
                transport.add(
                    FakeNode.file(
                        id = "entry-file-${index + 1}",
                        name = "entry-a.json",
                        parentId = "day",
                        mimeType = "application/json",
                        body = ENTRY_JSON.toByteArray(),
                        appProperties = existingAppProperties,
                    ),
                )
            }
        }

        fun addEmptyEntryTree() {
            addExistingRoot()
            transport.add(FakeNode.folder("entries", "entries", parentId = "root-a"))
            transport.add(FakeNode.folder("day", "2026-07-16", parentId = "entries"))
        }

        fun addUninitializedEntryTree() {
            store.set(ACCOUNT_A, "root-a")
            transport.add(FakeNode.folder("root-a", "Easylab Lab Notebook", parentId = "root"))
            transport.add(FakeNode.folder("entries", "entries", parentId = "root-a"))
            transport.add(FakeNode.folder("day", "2026-07-16", parentId = "entries"))
        }

        fun addMovedSavedRootAndSeparateValidRoot() {
            store.set(ACCOUNT_A, "root-a")
            transport.add(FakeNode.folder("root-a", "Easylab Lab Notebook", parentId = "other-parent"))
            transport.add(FakeNode.folder("root-b", "Easylab Lab Notebook", parentId = "root"))
            transport.add(FakeNode.folder("entries-b", "entries", parentId = "root-b"))
            transport.add(FakeNode.folder("day-b", "2026-07-16", parentId = "entries-b"))
            transport.add(
                FakeNode.file(
                    id = "manifest-b",
                    name = "manifest.json",
                    parentId = "root-b",
                    mimeType = "application/json",
                    body = MANIFEST_JSON.toByteArray(),
                ),
            )
        }

        fun addEmptyAttachmentTree() {
            addExistingRoot()
            transport.add(FakeNode.folder("attachments", "attachments", parentId = "root-a"))
            transport.add(FakeNode.folder("attachment-day", "2026-07-16", parentId = "attachments"))
        }

        fun addExistingRoot() {
            store.set(ACCOUNT_A, "root-a")
            transport.add(FakeNode.folder("root-a", "Easylab Lab Notebook", parentId = "root"))
            transport.add(
                FakeNode.file(
                    id = "manifest",
                    name = "manifest.json",
                    parentId = "root-a",
                    mimeType = "application/json",
                    body = MANIFEST_JSON.toByteArray(),
                ),
            )
        }

        fun addExistingBlobTree() {
            addExistingRoot()
            transport.add(FakeNode.folder("attachments", "attachments", parentId = "root-a"))
            transport.add(FakeNode.folder("attachment-day", "2026-07-16", parentId = "attachments"))
            transport.add(
                FakeNode.file(
                    id = "large-file",
                    name = "large.bin",
                    parentId = "attachment-day",
                    mimeType = "application/octet-stream",
                    body = byteArrayOf(1),
                ),
            )
        }
    }

    private class FakeAuthRepository(private val tokens: Map<AccountId, String>) : AuthRepository {
        override val session: StateFlow<AuthSession?> = MutableStateFlow(null)
        override val driveAccess: StateFlow<DriveAccessState> = MutableStateFlow(DriveAccessState.SignedOut)
        override suspend fun restore() = Unit
        override suspend fun connect(): Result<AuthSession> = Result.failure(UnsupportedOperationException())
        override suspend fun disconnect() = Unit
        override suspend fun invalidateAccessToken(accountId: AccountId) = Unit
        override fun accessToken(accountId: AccountId): String? = tokens[accountId]
    }

    private class FakeResumableOperationPersistence : DriveResumableOperationPersistence {
        private val values = mutableMapOf<String, String>()

        override suspend fun read(key: String): String? = synchronized(values) { values[key] }

        override suspend fun bindIfAbsent(key: String, value: String): String = synchronized(values) {
            values.getOrPut(key) { value }
        }

        override suspend fun compareAndSet(
            key: String,
            expected: String,
            value: String,
        ): Boolean = synchronized(values) {
            if (values[key] != expected) {
                false
            } else {
                values[key] = value
                true
            }
        }
    }

    private data class FakeNode(
        val id: String,
        val name: String,
        var parentId: String,
        val mimeType: String,
        var body: ByteArray = byteArrayOf(),
        var version: Long = 1,
        var appProperties: Map<String, String> = emptyMap(),
        val trashed: Boolean = false,
        var etag: String = "\"etag-$id-v$version\"",
    ) {
        companion object {
            fun folder(id: String, name: String, parentId: String) = FakeNode(
                id = id,
                name = name,
                parentId = parentId,
                mimeType = FOLDER_MIME_TYPE,
            )

            fun file(
                id: String,
                name: String,
                parentId: String,
                mimeType: String,
                body: ByteArray,
                appProperties: Map<String, String> = emptyMap(),
            ) = FakeNode(id, name, parentId, mimeType, body, appProperties = appProperties)
        }
    }

    private class FakeDriveWriteTransport : DriveWriteTransport {
        val requests = mutableListOf<DriveHttpRequest>()
        val createdFolders = mutableListOf<String>()
        var lastUploadedContent: ByteArray? = null
        var forcedStatus: Int? = null
        var changeVersionOnNextMetadataGet = false
        var moveFileOnNextMetadataGet = false
        var omitMetadataEtag = false
        var rejectPatchStatus: Int? = null
        var changeVersionBeforePatch = false
        var corruptMediaReadBack = false
        var losePatchResponseAfterCommit = false
        var losePostResponseAfterCommit = false
        var cancelPostAfterCommit = false
        var cancelPatchAfterCommit = false
        var loseFirstResumableChunkResponseAfterAccept = false
        var cancelFinalResumableResponseAfterCommit = false
        var failFirstResumableChunkBeforeAccept = false
        var failResumableStatusQueries = false
        var onResumableInitiated: (() -> Unit)? = null
        var preGeneratedIdCollision = false
        var failReservationRelease = false
        private val nodes = linkedMapOf<String, FakeNode>()
        private var nextId = 1
        private var resumableSession: FakeResumableSession? = null

        fun add(node: FakeNode) {
            nodes[node.id] = node
        }

        override suspend fun execute(request: DriveHttpRequest): DriveHttpResponse {
            requests += request
            yield()
            forcedStatus?.let { return DriveHttpResponse(statusCode = it) }
            val uri = URI(request.url)
            return when {
                request.method == "GET" && uri.path.endsWith("/files/generateIds") -> generateIds()
                request.method == "GET" && uri.path.contains("/files/") -> getById(request, uri)
                request.method == "GET" -> list(request)
                request.method == "POST" && !uri.path.contains("/upload/") -> createFolder(request)
                request.method == "POST" &&
                    queryParameter(request.url, "uploadType") == "resumable" -> initiateResumable(request, uri)
                request.method == "PATCH" && !uri.path.contains("/upload/") -> patchMetadata(request, uri)
                request.method == "PATCH" &&
                    queryParameter(request.url, "uploadType") == "resumable" -> initiateResumable(request, uri)
                request.method == "PUT" && uri.path.contains("/upload/drive/v3/files/") -> resumeUpload(request)
                request.method in setOf("POST", "PATCH") && uri.path.contains("/upload/") ->
                    multipartUpload(request, uri)
                else -> error("Unexpected request: ${request.method} ${request.url}")
            }
        }

        private fun patchMetadata(request: DriveHttpRequest, uri: URI): DriveHttpResponse {
            val id = uri.path.substringAfterLast("/files/")
            val node = nodes[id] ?: return DriveHttpResponse(404)
            if (request.headers["If-Match"] != node.etag) return DriveHttpResponse(412)
            val metadata = Json.parseToJsonElement(
                checkNotNull(request.body).toString(StandardCharsets.UTF_8),
            ).jsonObject
            if (
                failReservationRelease &&
                    (metadata["appProperties"] as? JsonObject)?.values?.any {
                        it is kotlinx.serialization.json.JsonNull
                    } == true
            ) {
                return DriveHttpResponse(503)
            }
            (metadata["appProperties"] as? JsonObject)?.forEach { (key, value) ->
                if (value is kotlinx.serialization.json.JsonNull) {
                    node.appProperties = node.appProperties - key
                } else {
                    node.appProperties = node.appProperties + (key to value.jsonPrimitive.content)
                }
            }
            node.version += 1
            node.etag = "\"etag-${node.id}-v${node.version}\""
            return DriveHttpResponse(200, body = nodeJson(node).toByteArray())
        }

        private fun generateIds(): DriveHttpResponse {
            val id = "pre-generated-${nextId++}"
            if (preGeneratedIdCollision) {
                nodes[id] = FakeNode.file(
                    id = id,
                    name = "collision.bin",
                    parentId = "root-a",
                    mimeType = "application/octet-stream",
                    body = byteArrayOf(1),
                )
            }
            return DriveHttpResponse(
                200,
                body = buildJsonObject {
                    put("ids", buildJsonArray { add(JsonPrimitive(id)) })
                }.toString().toByteArray(),
            )
        }

        private fun getById(request: DriveHttpRequest, uri: URI): DriveHttpResponse {
            val id = uri.path.substringAfterLast("/files/")
            val node = nodes[id] ?: return DriveHttpResponse(404)
            return if (queryParameter(request.url, "alt") == "media") {
                val media = if (corruptMediaReadBack && node.id.startsWith("entry-file-")) {
                    "corrupt".toByteArray()
                } else {
                    node.body
                }
                val range = request.headers["Range"]
                if (range != null) {
                    val match = Regex("^bytes=(\\d+)-(\\d+)$").matchEntire(range)
                        ?: error("Invalid test range: $range")
                    val start = match.groupValues[1].toInt()
                    val end = match.groupValues[2].toInt()
                    return DriveHttpResponse(
                        206,
                        headers = mapOf("Content-Range" to "bytes $start-$end/${media.size}"),
                        body = media.copyOfRange(start, end + 1),
                    )
                }
                DriveHttpResponse(
                    200,
                    body = media,
                )
            } else {
                if (changeVersionOnNextMetadataGet && node.mimeType != FOLDER_MIME_TYPE) {
                    changeVersionOnNextMetadataGet = false
                    node.version += 1
                    node.etag = "\"etag-${node.id}-v${node.version}\""
                }
                if (moveFileOnNextMetadataGet && node.mimeType != FOLDER_MIME_TYPE) {
                    moveFileOnNextMetadataGet = false
                    node.parentId = "other-parent"
                }
                DriveHttpResponse(
                    200,
                    headers = if (omitMetadataEtag) emptyMap() else mapOf("eTaG" to node.etag),
                    body = nodeJson(node).toByteArray(),
                )
            }
        }

        private fun list(request: DriveHttpRequest): DriveHttpResponse {
            val query = queryParameter(request.url, "q").orEmpty()
            val parentId = parentFrom(query)
            val expectedName = nameFrom(query)
            val matches = nodes.values.filter { node ->
                node.parentId == parentId && !node.trashed && (expectedName == null || node.name == expectedName)
            }
            val body = buildJsonObject {
                put("files", buildJsonArray {
                    matches.forEach { add(Json.parseToJsonElement(nodeJson(it))) }
                })
            }.toString().toByteArray()
            return DriveHttpResponse(200, body = body)
        }

        private fun createFolder(request: DriveHttpRequest): DriveHttpResponse {
            val metadata = Json.parseToJsonElement(request.body!!.toString(StandardCharsets.UTF_8)).jsonObject
            val name = metadata.getValue("name").jsonPrimitive.content
            val parentId = metadata["parents"]?.jsonArray?.single()?.jsonPrimitive?.content ?: "root"
            val node = FakeNode.folder("generated-${nextId++}", name, parentId)
            nodes[node.id] = node
            createdFolders += name
            return DriveHttpResponse(200, body = nodeJson(node).toByteArray())
        }

        private fun multipartUpload(request: DriveHttpRequest, uri: URI): DriveHttpResponse {
            val boundary = request.headers.getValue("Content-Type").substringAfter("boundary=")
            val (metadata, content) = parseMultipart(request.body!!, boundary)
            lastUploadedContent = content
            val existingId = if (request.method == "PATCH") uri.path.substringAfterLast("/files/") else null
            val node = if (existingId == null) {
                FakeNode.file(
                    id = "generated-${nextId++}",
                    name = metadata.getValue("name").jsonPrimitive.content,
                    parentId = metadata.getValue("parents").jsonArray.single().jsonPrimitive.content,
                    mimeType = metadata.getValue("mimeType").jsonPrimitive.content,
                    body = content,
                ).also { created -> nodes[created.id] = created }
            } else {
                nodes.getValue(existingId).also { existing ->
                    rejectPatchStatus?.let { return DriveHttpResponse(it) }
                    if (changeVersionBeforePatch) {
                        changeVersionBeforePatch = false
                        existing.version += 1
                        existing.etag = "\"etag-${existing.id}-v${existing.version}\""
                    }
                    if (request.headers["If-Match"] != null && request.headers["If-Match"] != existing.etag) {
                        return DriveHttpResponse(412)
                    }
                    existing.body = content
                    existing.version += 1
                    existing.etag = "\"etag-${existing.id}-v${existing.version}\""
                }
            }
            node.appProperties = (metadata["appProperties"] as? JsonObject)
                ?.mapValues { (_, value) -> value.jsonPrimitive.content }
                .orEmpty()
            if (request.method == "POST" && losePostResponseAfterCommit) {
                losePostResponseAfterCommit = false
                throw IOException("simulated lost create response")
            }
            if (request.method == "POST" && cancelPostAfterCommit) {
                cancelPostAfterCommit = false
                throw CancellationException("simulated cancellation after create commit")
            }
            if (request.method == "PATCH" && losePatchResponseAfterCommit) {
                losePatchResponseAfterCommit = false
                throw IOException("simulated lost patch response")
            }
            if (request.method == "PATCH" && cancelPatchAfterCommit) {
                cancelPatchAfterCommit = false
                throw CancellationException("simulated cancellation after patch commit")
            }
            return DriveHttpResponse(200, body = nodeJson(node).toByteArray())
        }

        private fun initiateResumable(
            request: DriveHttpRequest,
            uri: URI,
        ): DriveHttpResponse {
            val metadata = Json.parseToJsonElement(
                request.body!!.toString(StandardCharsets.UTF_8),
            ).jsonObject
            val create = request.method == "POST"
            val id = if (create) {
                metadata["id"]?.jsonPrimitive?.content ?: error("Missing generated create id")
            } else {
                uri.path.substringAfterLast("/files/")
            }
            if (!create) {
                val node = nodes.getValue(id)
                rejectPatchStatus?.let { return DriveHttpResponse(it) }
                if (request.headers["If-Match"] != node.etag) return DriveHttpResponse(412)
            } else if (nodes.containsKey(id)) {
                return DriveHttpResponse(409)
            }
            val totalBytes = request.headers.getValue("X-Upload-Content-Length").toInt()
            resumableSession = FakeResumableSession(
                fileId = id,
                metadata = metadata,
                totalBytes = totalBytes,
                bytes = ByteArray(totalBytes),
                create = create,
            )
            onResumableInitiated?.invoke()
            return DriveHttpResponse(
                200,
                headers = mapOf(
                    "Location" to
                        "https://www.googleapis.com/upload/drive/v3/files/$id?upload_id=test-session",
                ),
            )
        }

        private fun resumeUpload(request: DriveHttpRequest): DriveHttpResponse {
            val session = checkNotNull(resumableSession)
            val contentRange = request.headers.getValue("Content-Range")
            if (contentRange.startsWith("bytes */")) {
                if (failResumableStatusQueries) return DriveHttpResponse(503)
                val node = nodes[session.fileId]
                if (session.committed) {
                    return DriveHttpResponse(200, body = nodeJson(checkNotNull(node)).toByteArray())
                }
                return DriveHttpResponse(
                    308,
                    headers = if (session.receivedBytes == 0) {
                        emptyMap()
                    } else {
                        mapOf("Range" to "bytes=0-${session.receivedBytes - 1}")
                    },
                )
            }
            if (failFirstResumableChunkBeforeAccept) {
                failFirstResumableChunkBeforeAccept = false
                throw IOException("simulated resumable interruption before accept")
            }
            val match = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$").matchEntire(contentRange)
                ?: error("Invalid resumable test range: $contentRange")
            val start = match.groupValues[1].toInt()
            val end = match.groupValues[2].toInt()
            val total = match.groupValues[3].toInt()
            check(start == session.receivedBytes && total == session.totalBytes)
            val body = checkNotNull(request.body)
            check(body.size == end - start + 1)
            body.copyInto(session.bytes, destinationOffset = start)
            session.receivedBytes = end + 1
            if (loseFirstResumableChunkResponseAfterAccept) {
                loseFirstResumableChunkResponseAfterAccept = false
                throw IOException("simulated lost resumable chunk response")
            }
            if (session.receivedBytes < session.totalBytes) {
                return DriveHttpResponse(
                    308,
                    headers = mapOf("Range" to "bytes=0-${session.receivedBytes - 1}"),
                )
            }
            val node = nodes[session.fileId] ?: if (session.create) {
                FakeNode.file(
                    id = session.fileId,
                    name = session.metadata.getValue("name").jsonPrimitive.content,
                    parentId = session.metadata.getValue("parents").jsonArray.single().jsonPrimitive.content,
                    mimeType = session.metadata.getValue("mimeType").jsonPrimitive.content,
                    body = byteArrayOf(),
                ).also { created -> nodes[created.id] = created }
            } else {
                error("Missing resumable update target")
            }
            node.body = session.bytes.copyOf()
            node.version += 1
            node.etag = "\"etag-${node.id}-v${node.version}\""
            node.appProperties = (session.metadata["appProperties"] as? JsonObject)
                ?.mapValues { (_, value) -> value.jsonPrimitive.content }
                .orEmpty()
            session.committed = true
            lastUploadedContent = node.body.copyOf()
            if (cancelFinalResumableResponseAfterCommit) {
                cancelFinalResumableResponseAfterCommit = false
                throw CancellationException("simulated resumable cancellation after commit")
            }
            return DriveHttpResponse(200, body = nodeJson(node).toByteArray())
        }

        private data class FakeResumableSession(
            val fileId: String,
            val metadata: JsonObject,
            val totalBytes: Int,
            val bytes: ByteArray,
            val create: Boolean,
            var receivedBytes: Int = 0,
            var committed: Boolean = false,
        )

        private fun parseMultipart(bytes: ByteArray, boundary: String): Pair<JsonObject, ByteArray> {
            val marker = "--$boundary"
            val raw = bytes.toString(StandardCharsets.UTF_8)
            val firstHeadersEnd = raw.indexOf("\r\n\r\n")
            val metadataEnd = raw.indexOf("\r\n$marker", firstHeadersEnd + 4)
            val secondHeadersEnd = raw.indexOf("\r\n\r\n", metadataEnd + marker.length)
            val contentEnd = raw.indexOf("\r\n$marker--", secondHeadersEnd + 4)
            check(firstHeadersEnd >= 0 && metadataEnd >= 0 && secondHeadersEnd >= 0 && contentEnd >= 0)
            val metadata = Json.parseToJsonElement(raw.substring(firstHeadersEnd + 4, metadataEnd)).jsonObject
            val content = raw.substring(secondHeadersEnd + 4, contentEnd).toByteArray(StandardCharsets.UTF_8)
            return metadata to content
        }

        private fun nodeJson(node: FakeNode): String = buildJsonObject {
            put("id", node.id)
            put("name", node.name)
            put("mimeType", node.mimeType)
            put("modifiedTime", "2026-07-16T12:00:00Z")
            put("size", node.body.size.toString())
            put("version", node.version.toString())
            put("trashed", node.trashed)
            put("parents", buildJsonArray { add(JsonPrimitive(node.parentId)) })
            if (node.appProperties.isNotEmpty()) {
                put("appProperties", buildJsonObject {
                    node.appProperties.forEach { (key, value) -> put(key, value) }
                })
            }
        }.toString()

        private fun parentFrom(query: String): String {
            val escaped = Regex("^'((?:\\\\.|[^'])*)' in parents").find(query)?.groupValues?.get(1)
                ?: error("Missing parent query: $query")
            return unescapeDriveQuery(escaped)
        }

        private fun nameFrom(query: String): String? {
            val escaped = Regex("name = '((?:\\\\.|[^'])*)'").find(query)?.groupValues?.get(1) ?: return null
            return unescapeDriveQuery(escaped)
        }

        private fun unescapeDriveQuery(value: String): String {
            val output = StringBuilder()
            var index = 0
            while (index < value.length) {
                if (value[index] == '\\' && index + 1 < value.length) index += 1
                output.append(value[index])
                index += 1
            }
            return output.toString()
        }
    }

    private companion object {
        val ACCOUNT_A = AccountId("account-a")
        const val ENTRY_PATH = "entries/2026-07-16/entry-a.json"
        const val LARGE_BLOB_PATH = "attachments/2026-07-16/large.bin"
        const val ENTRY_JSON = "{\"schemaVersion\":1,\"entityType\":\"entry\",\"payload\":{\"id\":\"entry-a\"}}"
        const val MANIFEST_JSON =
            "{\"version\":1,\"provider\":\"google-drive\",\"rootFolderName\":\"Easylab Lab Notebook\"}"
        const val FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"

        fun queryParameter(url: String, name: String): String? {
            val query = URI(url).rawQuery ?: return null
            return query.split('&').firstNotNullOfOrNull { parameter ->
                val parts = parameter.split('=', limit = 2)
                if (URLDecoder.decode(parts[0], StandardCharsets.UTF_8.name()) == name) {
                    URLDecoder.decode(parts.getOrElse(1) { "" }, StandardCharsets.UTF_8.name())
                } else {
                    null
                }
            }
        }

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private fun resource(path: String): String =
        checkNotNull(javaClass.classLoader?.getResource(path)) { "Missing test resource: $path" }.readText()
}
