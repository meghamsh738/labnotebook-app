package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveProtocolException
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveV1WriteTransactionTest {
    @Test
    fun writesTombstonesThenBlobsBeforeEntityJsonAndPublishesManifestLast() = runTest {
        val writer = RecordingWriter()
        val bytes = "attachment bytes".toByteArray()
        val transaction = transaction(
            prerequisites = listOf(
                json(ENTRY_PATH),
                blob(BLOB_PATH, bytes),
                json(TOMBSTONE_PATH),
            ),
        )

        val result = DriveV1WriteTransactionExecutor(writer).execute(transaction).getOrThrow()

        assertEquals(
            listOf(TOMBSTONE_PATH, BLOB_PATH, ENTRY_PATH, DriveV1Paths.manifest),
            writer.paths,
        )
        assertEquals(
            listOf(TOMBSTONE_PATH, BLOB_PATH, ENTRY_PATH),
            result.prerequisiteFiles.map { it.path },
        )
        assertEquals(DriveV1Paths.manifest, result.manifestFile.path)
        assertTrue(writer.accountIds.all { it == ACCOUNT })
    }

    @Test
    fun prerequisiteFailureStopsTransactionAndNeverPublishesManifest() = runTest {
        val writer = RecordingWriter(failAtPath = ENTRY_PATH)
        val transaction = transaction(
            prerequisites = listOf(
                blob(BLOB_PATH, "blob".toByteArray()),
                json(ENTRY_PATH),
                json(TOMBSTONE_PATH),
            ),
        )

        val error = DriveV1WriteTransactionExecutor(writer).execute(transaction).exceptionOrNull()

        assertTrue(error is DriveV1WriteTransactionException)
        error as DriveV1WriteTransactionException
        assertEquals(ENTRY_PATH, error.failedPath)
        assertEquals(listOf(TOMBSTONE_PATH, BLOB_PATH), error.completedFiles.map { it.path })
        assertTrue(error.cause is IllegalStateException)
        assertEquals(listOf(TOMBSTONE_PATH, BLOB_PATH, ENTRY_PATH), writer.paths)
        assertFalse(DriveV1Paths.manifest in writer.paths)
    }

    @Test
    fun manifestFailureDoesNotReportACommittedTransaction() = runTest {
        val writer = RecordingWriter(failAtPath = DriveV1Paths.manifest)

        val result = DriveV1WriteTransactionExecutor(writer).execute(
            transaction(prerequisites = listOf(json(ENTRY_PATH))),
        )

        val error = result.exceptionOrNull()
        assertTrue(error is DriveV1WriteTransactionException)
        error as DriveV1WriteTransactionException
        assertEquals(DriveV1Paths.manifest, error.failedPath)
        assertEquals(listOf(ENTRY_PATH), error.completedFiles.map { it.path })
        assertEquals(listOf(ENTRY_PATH, DriveV1Paths.manifest), writer.paths)
    }

    @Test
    fun unexpectedPrerequisiteResultPathFailsBeforeManifest() = runTest {
        val writer = RecordingWriter(wrongResultAtPath = ENTRY_PATH)

        val result = DriveV1WriteTransactionExecutor(writer).execute(
            transaction(prerequisites = listOf(json(ENTRY_PATH))),
        )

        val error = result.exceptionOrNull()
        assertTrue(error is DriveV1WriteTransactionException)
        assertTrue(error?.cause is DriveProtocolException)
        assertEquals(listOf(ENTRY_PATH), writer.paths)
        assertFalse(DriveV1Paths.manifest in writer.paths)
    }

    @Test
    fun cancellationIsRethrownAndManifestIsNotAttempted() = runTest {
        val writer = RecordingWriter(cancelAtPath = ENTRY_PATH)
        var cancelled = false

        try {
            DriveV1WriteTransactionExecutor(writer).execute(
                transaction(prerequisites = listOf(json(ENTRY_PATH))),
            )
        } catch (_: CancellationException) {
            cancelled = true
        }

        assertTrue(cancelled)
        assertEquals(listOf(ENTRY_PATH), writer.paths)
        assertFalse(DriveV1Paths.manifest in writer.paths)
    }

    @Test
    fun rejectsDuplicatePathsAndManifestOutsideCommitBoundary() {
        assertTrue(
            runCatching {
                transaction(prerequisites = listOf(json(ENTRY_PATH), json(ENTRY_PATH)))
            }.exceptionOrNull() is IllegalArgumentException,
        )
        assertTrue(
            runCatching {
                transaction(prerequisites = listOf(json(DriveV1Paths.manifest)))
            }.exceptionOrNull() is IllegalArgumentException,
        )
        assertTrue(
            runCatching {
                DriveV1WriteTransaction(
                    accountId = ACCOUNT,
                    prerequisites = emptyList(),
                    manifest = json("entries/not-manifest.json"),
                )
            }.exceptionOrNull() is IllegalArgumentException,
        )
    }

    @Test
    fun acceptsAndForwardsCreateOnlyPreconditionsWithoutWeakeningThem() = runTest {
        val writer = RecordingWriter()
        val transaction = DriveV1WriteTransaction(
            accountId = ACCOUNT,
            prerequisites = listOf(json(ENTRY_PATH, DriveWritePrecondition.MustNotExist)),
            manifest = json(DriveV1Paths.manifest, DriveWritePrecondition.MustNotExist),
        )

        DriveV1WriteTransactionExecutor(writer).execute(transaction).getOrThrow()

        assertEquals(
            listOf(DriveWritePrecondition.MustNotExist, DriveWritePrecondition.MustNotExist),
            writer.preconditions,
        )
    }

    @Test
    fun preflightsTheEntireBatchBeforeTheFirstWriterCall() = runTest {
        val writer = RecordingWriter()
        val invalidLaterWrite = DriveV1TransactionWrite.Json(
            path = "entries/2026-07-23/invalid.json",
            json = "not-json",
            precondition = match("invalid"),
        )

        val error = runCatching {
            DriveV1WriteTransaction(
                accountId = ACCOUNT,
                prerequisites = listOf(json(TOMBSTONE_PATH), invalidLaterWrite),
                manifest = json(DriveV1Paths.manifest),
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertTrue(writer.paths.isEmpty())
    }

    @Test
    fun revalidatesAndSnapshotsMutableBlobBytesBeforeTheFirstWriterCall() = runTest {
        val writer = RecordingWriter()
        val bytes = "blob".toByteArray()
        val transaction = transaction(prerequisites = listOf(blob(BLOB_PATH, bytes)))
        bytes[0] = 'X'.code.toByte()

        val error = DriveV1WriteTransactionExecutor(writer).execute(transaction).exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertTrue(writer.paths.isEmpty())
    }

    @Test
    fun forwardsEveryExplicitPreconditionWithoutRefreshingOrWeakeningIt() = runTest {
        val writer = RecordingWriter()
        val expectedEntry = DriveWritePrecondition.MustMatch("entry-file", 7)
        val expectedManifest = DriveWritePrecondition.MustMatch("manifest-file", 11)
        val transaction = DriveV1WriteTransaction(
            accountId = ACCOUNT,
            prerequisites = listOf(json(ENTRY_PATH, expectedEntry)),
            manifest = json(DriveV1Paths.manifest, expectedManifest),
        )

        DriveV1WriteTransactionExecutor(writer).execute(transaction).getOrThrow()

        assertEquals(
            listOf(expectedEntry, expectedManifest),
            writer.preconditions,
        )
    }

    @Test
    fun dispatchesExistingFiveMiBBlobResumablyAndPublishesManifestAfterIt() = runTest {
        val writer = RecordingWriter()
        val largeBytes = ByteArray(MULTIPART_LIMIT_BYTES) { index -> (index % 251).toByte() }
        val operationId = "existing-attachment-upload-1"
        val transaction = transaction(
            prerequisites = listOf(
                json(TOMBSTONE_PATH),
                blob(BLOB_PATH, largeBytes, resumableOperationId = operationId),
                json(ENTRY_PATH),
            ),
        )

        DriveV1WriteTransactionExecutor(writer).execute(transaction).getOrThrow()

        assertEquals(
            listOf(TOMBSTONE_PATH, BLOB_PATH, ENTRY_PATH, DriveV1Paths.manifest),
            writer.paths,
        )
        assertEquals(listOf(BLOB_PATH), writer.resumablePaths)
        assertEquals(listOf(operationId), writer.resumableOperationIds)
        assertEquals(DriveV1Paths.manifest, writer.paths.last())
    }

    @Test
    fun rejectsResumableBlobWithoutPersistedOperationIdBeforeWriting() {
        val bytes = ByteArray(MULTIPART_LIMIT_BYTES)

        val error = runCatching {
            transaction(prerequisites = listOf(blob(BLOB_PATH, bytes)))
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun rejectsOperationIdForBoundedMultipartBlob() {
        val error = runCatching {
            transaction(
                prerequisites = listOf(
                    blob(BLOB_PATH, "small".toByteArray(), resumableOperationId = "must-not-be-used"),
                ),
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun usesTheFiveMiBBoundaryWithoutAnUnguardedFallback() = runTest {
        val bounded = transaction(
            prerequisites = listOf(blob(BLOB_PATH, ByteArray(MULTIPART_LIMIT_BYTES - 1))),
        )
        val atBoundary = transaction(
            prerequisites = listOf(
                blob(
                    BLOB_PATH,
                    ByteArray(MULTIPART_LIMIT_BYTES),
                    resumableOperationId = "boundary-at-five-mib",
                ),
            ),
        )
        val aboveBoundary = transaction(
            prerequisites = listOf(
                blob(
                    BLOB_PATH,
                    ByteArray(MULTIPART_LIMIT_BYTES + 1),
                    resumableOperationId = "boundary-above-five-mib",
                ),
            ),
        )

        val boundedWriter = RecordingWriter()
        val atBoundaryWriter = RecordingWriter()
        val aboveBoundaryWriter = RecordingWriter()

        DriveV1WriteTransactionExecutor(boundedWriter).execute(bounded).getOrThrow()
        DriveV1WriteTransactionExecutor(atBoundaryWriter).execute(atBoundary).getOrThrow()
        DriveV1WriteTransactionExecutor(aboveBoundaryWriter).execute(aboveBoundary).getOrThrow()

        assertTrue(boundedWriter.resumablePaths.isEmpty())
        assertEquals(listOf(BLOB_PATH), atBoundaryWriter.resumablePaths)
        assertEquals(listOf(BLOB_PATH), aboveBoundaryWriter.resumablePaths)
    }

    @Test
    fun dispatchesLargeCreateOnlyBlobToGeneratedIdProtocol() = runTest {
        val bytes = ByteArray(MULTIPART_LIMIT_BYTES)
        val writer = RecordingWriter()
        val transaction = DriveV1WriteTransaction(
            accountId = ACCOUNT,
            prerequisites = listOf(
                blob(
                    BLOB_PATH,
                    bytes,
                    precondition = DriveWritePrecondition.MustNotExist,
                    resumableOperationId = "new-attachment-upload-1",
                ),
            ),
            manifest = json(DriveV1Paths.manifest),
        )

        DriveV1WriteTransactionExecutor(writer).execute(transaction).getOrThrow()

        assertEquals(listOf(BLOB_PATH), writer.resumableCreatePaths)
        assertEquals(DriveV1Paths.manifest, writer.paths.last())
    }

    @Test
    fun resumableFailureSuppressesManifest() = runTest {
        val writer = RecordingWriter(failAtPath = BLOB_PATH)
        val bytes = ByteArray(MULTIPART_LIMIT_BYTES)
        val result = DriveV1WriteTransactionExecutor(writer).execute(
            transaction(
                prerequisites = listOf(
                    blob(BLOB_PATH, bytes, resumableOperationId = "existing-attachment-upload-2"),
                    json(ENTRY_PATH),
                ),
            ),
        )

        val error = result.exceptionOrNull()
        assertTrue(error is DriveV1WriteTransactionException)
        assertEquals(BLOB_PATH, (error as DriveV1WriteTransactionException).failedPath)
        assertEquals(listOf(BLOB_PATH), writer.paths)
        assertFalse(DriveV1Paths.manifest in writer.paths)
    }

    @Test
    fun resumableCancellationIsRethrownAndSuppressesManifest() = runTest {
        val writer = RecordingWriter(cancelAtPath = BLOB_PATH)
        var cancelled = false

        try {
            DriveV1WriteTransactionExecutor(writer).execute(
                transaction(
                    prerequisites = listOf(
                        blob(
                            BLOB_PATH,
                            ByteArray(MULTIPART_LIMIT_BYTES),
                            resumableOperationId = "existing-attachment-upload-4",
                        ),
                    ),
                ),
            )
        } catch (_: CancellationException) {
            cancelled = true
        }

        assertTrue(cancelled)
        assertEquals(listOf(BLOB_PATH), writer.paths)
        assertFalse(DriveV1Paths.manifest in writer.paths)
    }

    @Test
    fun resumableBlobSnapshotCannotBeAlteredByCallerBytes() = runTest {
        val bytes = ByteArray(MULTIPART_LIMIT_BYTES) { 1 }
        val writer = RecordingWriter(onFirstRecord = { bytes[0] = 2 })
        val transaction = transaction(
            prerequisites = listOf(
                blob(BLOB_PATH, bytes, resumableOperationId = "existing-attachment-upload-3"),
            ),
        )

        DriveV1WriteTransactionExecutor(writer).execute(transaction).getOrThrow()

        assertEquals(1, writer.resumableBytes.single().first().toInt())
    }

    private class RecordingWriter(
        private val failAtPath: String? = null,
        private val wrongResultAtPath: String? = null,
        private val cancelAtPath: String? = null,
        private val onFirstRecord: (() -> Unit)? = null,
    ) : DriveConditionalWriteClient {
        val paths = mutableListOf<String>()
        val accountIds = mutableListOf<AccountId>()
        val preconditions = mutableListOf<DriveWritePrecondition>()
        val resumablePaths = mutableListOf<String>()
        val resumableOperationIds = mutableListOf<String>()
        val resumableBytes = mutableListOf<ByteArray>()
        val resumableCreatePaths = mutableListOf<String>()

        override suspend fun putJsonConditional(
            accountId: AccountId,
            path: String,
            json: String,
            precondition: DriveWritePrecondition,
        ): Result<DriveFileRef> = record(accountId, path, precondition)

        override suspend fun putBlobConditional(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
            precondition: DriveWritePrecondition,
        ): Result<DriveFileRef> = record(accountId, path, precondition)

        override suspend fun putBlobConditionalResumable(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
            precondition: DriveWritePrecondition,
            operationId: String,
        ): Result<DriveFileRef> {
            val result = record(accountId, path, precondition)
            resumablePaths += path
            resumableOperationIds += operationId
            resumableBytes += bytes.copyOf()
            return result
        }

        override suspend fun putBlobConditionalResumableCreate(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
            precondition: DriveWritePrecondition,
            operationId: String,
        ): Result<DriveFileRef> = putBlobConditionalResumable(
            accountId, path, bytes, mimeType, sha256, precondition, operationId,
        ).also { resumableCreatePaths += path }

        private fun record(
            accountId: AccountId,
            path: String,
            precondition: DriveWritePrecondition,
        ): Result<DriveFileRef> {
            if (paths.isEmpty()) onFirstRecord?.invoke()
            paths += path
            accountIds += accountId
            preconditions += precondition
            if (path == cancelAtPath) return Result.failure(CancellationException("cancelled: $path"))
            if (path == failAtPath) return Result.failure(IllegalStateException("forced failure: $path"))
            val returnedPath = if (path == wrongResultAtPath) "$path.unexpected" else path
            return Result.success(
                DriveFileRef(
                    id = "file-${returnedPath.hashCode()}",
                    path = returnedPath,
                    name = returnedPath.substringAfterLast('/'),
                    updatedAt = "2026-07-23T12:00:00Z",
                    version = 1,
                ),
            )
        }
    }

    private fun transaction(
        prerequisites: List<DriveV1TransactionWrite>,
    ) = DriveV1WriteTransaction(
        accountId = ACCOUNT,
        prerequisites = prerequisites,
        manifest = json(DriveV1Paths.manifest),
    )

    private fun json(
        path: String,
        precondition: DriveWritePrecondition = match(path),
    ) = DriveV1TransactionWrite.Json(
        path = path,
        json = when {
            path == DriveV1Paths.manifest -> """
                {
                  "version": 1,
                  "provider": "google-drive",
                  "rootFolderName": "Easylab Lab Notebook",
                  "createdAt": "2026-07-23T12:00:00Z",
                  "updatedAt": "2026-07-23T12:00:00Z",
                  "devices": [],
                  "entryCount": 1,
                  "attachmentCount": 0,
                  "fileBoxCount": 0,
                  "transferCount": 0
                }
            """.trimIndent()
            path.startsWith("tombstones/") -> """
                {
                  "id": "delete-entry-entry-old",
                  "entityKind": "entry",
                  "entityId": "entry-old",
                  "deletedAt": "2026-07-23T12:00:00Z",
                  "deletedByDeviceId": "device-a"
                }
            """.trimIndent()
            else -> """
                {
                  "id": "entry-a",
                  "kind": "entry",
                  "version": 1,
                  "updatedAt": "2026-07-23T12:00:00Z",
                  "updatedByDeviceId": "device-a",
                  "payload": {
                    "id": "entry-a",
                    "createdDatetime": "2026-07-23T10:00:00Z",
                    "lastEditedDatetime": "2026-07-23T12:00:00Z",
                    "authorId": "account-a",
                    "title": "Entry",
                    "dateBucket": "2026-07-23",
                    "content": [],
                    "tags": [],
                    "searchTerms": [],
                    "linkedFiles": [],
                    "pinnedRegions": []
                  }
                }
            """.trimIndent()
        },
        precondition = precondition,
    )

    private fun blob(
        path: String,
        bytes: ByteArray,
        precondition: DriveWritePrecondition = match(path),
        resumableOperationId: String? = null,
    ) = DriveV1TransactionWrite.Blob(
        path = path,
        bytes = bytes,
        mimeType = "application/octet-stream",
        sha256 = sha256(bytes),
        precondition = precondition,
        resumableOperationId = resumableOperationId,
    )

    private fun match(path: String) = DriveWritePrecondition.MustMatch(
        fileId = "file-${path.hashCode()}",
        version = 1,
    )

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private companion object {
        val ACCOUNT = AccountId("account-a")
        const val ENTRY_PATH = "entries/2026-07-23-entry-a.json"
        const val BLOB_PATH = "attachments/2026-07-23/attachment-a.bin"
        const val TOMBSTONE_PATH = "tombstones/entry--entry-old.json"
        const val MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024
    }
}
