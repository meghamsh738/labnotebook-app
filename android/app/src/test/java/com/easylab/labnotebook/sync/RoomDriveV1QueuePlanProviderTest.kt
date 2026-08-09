package com.easylab.labnotebook.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountEntity
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveRepository
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RoomDriveV1QueuePlanProviderTest {
    @Test
    fun localEntryChangeBuildsExactVersionedManifestLastPlan() = runTest {
        val fixture = entryFixture(localTitle = "Local edit", remoteTitle = "Base")
        try {
            val decision = fixture.provider.prepare(ACCOUNT, fixture.queue)
            assertTrue("decision=$decision", decision is DriveV1QueuePlanDecision.Ready)
            val plan = (decision as DriveV1QueuePlanDecision.Ready).plan
            assertEquals(listOf(ENTRY_PATH), plan.prerequisites.map { it.path })
            assertEquals(DriveV1Paths.manifest, plan.manifest.path)
            assertEquals(
                DriveV1DurablePrecondition("must-match", "entry-file", 7),
                plan.prerequisites.single().precondition,
            )
            assertEquals(
                DriveV1DurablePrecondition("must-match", "manifest-file", 11),
                plan.manifest.precondition,
            )
            assertEquals(ENTRY_PATH, plan.prerequisites.single().path)
            assertTrue((decision as DriveV1QueuePlanDecision.Ready).payloads.isNotEmpty())
            decision.payloads.forEach { payload ->
                assertNull(fixture.database.dao().driveWritePayload(ACCOUNT.value, payload.payloadKey))
            }
        } finally {
            fixture.close()
        }
    }

    @Test
    fun manifestCountsOnlyVerifiedRemoteProjectionPlusClaimedMutation() = runTest {
        val fixture = entryFixture(localTitle = "Local edit", remoteTitle = "Base")
        try {
            fixture.database.dao().upsertEntry(
                localEntry("A second pending local entry", version = 1, updatedAt = MUTATION_AT).copy(id = "entry-2"),
            )

            val decision = fixture.provider.prepare(ACCOUNT, fixture.queue)
            assertTrue(decision is DriveV1QueuePlanDecision.Ready)
            val ready = decision as DriveV1QueuePlanDecision.Ready
            val manifestWrite = ready.plan.manifest
            val payload = ready.payloads.single { it.payloadKey == manifestWrite.localJsonKey }
            val manifest = DriveV1Json.format.decodeFromString<DriveV1Manifest>(payload.payloadJson).requireV1()

            assertEquals(1, manifest.entryCount)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun divergentLocalAndRemoteEntryChangesPersistDeterministicConflict() = runTest {
        val fixture = entryFixture(localTitle = "Base", remoteTitle = "Remote edit")
        try {
            val decision = fixture.provider.prepare(ACCOUNT, fixture.queue)
            assertTrue("decision=$decision", decision is DriveV1QueuePlanDecision.Conflict)
            assertEquals("conf-entry-entry-1", fixture.database.dao().conflicts(ACCOUNT.value).single().id)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun cancelledFreshRemoteReadIsNeverConvertedIntoABlockedPlan() = runTest {
        val database = database()
        try {
            seedAccount(database.dao())
            val provider = RoomDriveV1QueuePlanProvider(
                database,
                DriveV1MetadataReader(
                    object : DriveRepository {
                        override val writeCapability = DriveWriteCapability.DisabledPendingContractParity
                        override suspend fun listManagedFiles(accountId: AccountId, prefix: String?) =
                            throw CancellationException("cancelled remote snapshot")
                        override suspend fun readJson(accountId: AccountId, path: String) = Result.success<String?>(null)
                        override suspend fun putJson(accountId: AccountId, path: String, json: String) =
                            Result.failure<DriveFileRef>(IllegalStateException("disabled"))
                        override suspend fun putBlob(
                            accountId: AccountId,
                            path: String,
                            bytes: ByteArray,
                            mimeType: String,
                            sha256: String,
                        ) = Result.failure<DriveFileRef>(IllegalStateException("disabled"))
                    },
                ),
                publicationTimestamp = { PUBLISH_AT },
            )

            var cancelled = false
            try {
                provider.prepare(ACCOUNT, claimedQueue("entry", "entry-1", baseVersion = 1))
            } catch (_: CancellationException) {
                cancelled = true
            }
            assertTrue(cancelled)
        } finally {
            database.close()
        }
    }

    @Test
    fun missingRemoteWithBaselineAndMalformedRemoteBlockBeforePlanningWrites() = runTest {
        val missing = entryFixture(localTitle = "Local edit", remoteTitle = null)
        try {
            val decision = missing.provider.prepare(ACCOUNT, missing.queue)
            assertTrue("decision=$decision", decision is DriveV1QueuePlanDecision.Blocked)
            assertTrue((decision as DriveV1QueuePlanDecision.Blocked).reason.contains("missing", ignoreCase = true))
        } finally {
            missing.close()
        }

        val malformed = entryFixture(localTitle = "Local edit", remoteTitle = "Base", malformedRemote = true)
        try {
            val decision = malformed.provider.prepare(ACCOUNT, malformed.queue)
            assertTrue("malformed decision=$decision", decision is DriveV1QueuePlanDecision.Blocked)
            val reason = (decision as DriveV1QueuePlanDecision.Blocked).reason
            assertTrue("reason=$reason", reason.contains("malformed", ignoreCase = true))
        } finally {
            malformed.close()
        }
    }

    @Test
    fun missingManifestAndEntityVersionsReturnBlockedDecisions() = runTest {
        val missingManifestVersion = entryFixture(
            localTitle = "Local edit",
            remoteTitle = "Base",
            manifestVersion = null,
        )
        try {
            val decision = missingManifestVersion.provider.prepare(ACCOUNT, missingManifestVersion.queue)
            assertTrue("decision=$decision", decision is DriveV1QueuePlanDecision.Blocked)
            assertTrue((decision as DriveV1QueuePlanDecision.Blocked).reason.contains("version", ignoreCase = true))
        } finally {
            missingManifestVersion.close()
        }

        val missingEntityVersion = entryFixture(
            localTitle = "Local edit",
            remoteTitle = "Base",
            entityVersion = null,
        )
        try {
            val decision = missingEntityVersion.provider.prepare(ACCOUNT, missingEntityVersion.queue)
            assertTrue("decision=$decision", decision is DriveV1QueuePlanDecision.Blocked)
            assertTrue((decision as DriveV1QueuePlanDecision.Blocked).reason.contains("version", ignoreCase = true))
        } finally {
            missingEntityVersion.close()
        }
    }

    @Test
    fun largeExistingAttachmentUsesBlobVersionAndDeterministicResumableIdentity() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao)
            val entry = localEntry(title = "Entry", version = 1, updatedAt = BASE_AT)
            dao.upsertEntry(entry)
            val oldHash = "a".repeat(64)
            val newHash = "b".repeat(64)
            val localAttachment = AttachmentEntity(
                accountId = ACCOUNT.value,
                id = "attachment-1",
                entryId = entry.id,
                type = "file",
                filename = "large.bin",
                displaySize = "5 MiB",
                byteSize = 5L * 1024L * 1024L,
                storagePath = "account-local-large-blob",
                mimeType = "application/octet-stream",
                sha256 = newHash,
                createdAt = BASE_AT,
                updatedAt = MUTATION_AT,
            )
            dao.upsertAttachment(localAttachment)
            val queue = claimedQueue("attachment", localAttachment.id, baseVersion = 1)
            dao.insertQueueItemIfAbsent(queue)

            val remoteEntry = entryEnvelope("Entry", version = 1, updatedAt = BASE_AT)
            val oldAttachment = attachmentEnvelope(oldHash, BASE_AT)
            val blobPath = oldAttachment.payload.storagePath
            val metadataPath = "$blobPath.json"
            dao.upsertDriveRawDocument(
                rawBaseline("attachment", localAttachment.id, metadataPath, "metadata-file", 5, oldAttachment),
            )
            val manifest = manifest(entryCount = 1, attachmentCount = 1)
            val remoteFiles = listOf(
                ref(DriveV1Paths.manifest, "manifest-file", 11),
                ref(ENTRY_PATH, "entry-file", 7),
                ref(
                    blobPath,
                    "blob-file",
                    13,
                    mapOf("entityType" to "attachmentBlob", "sha256" to oldHash),
                ),
                ref(metadataPath, "metadata-file", 5),
            )
            val remoteJson = mapOf(
                DriveV1Paths.manifest to DriveV1Json.format.encodeToString(manifest),
                ENTRY_PATH to DriveV1Json.format.encodeToString(remoteEntry),
                metadataPath to DriveV1Json.format.encodeToString(oldAttachment),
            )
            val remote = FakeDrive(files = remoteFiles, json = remoteJson)
            val provider = RoomDriveV1QueuePlanProvider(
                database,
                DriveV1MetadataReader(remote),
                publicationTimestamp = { PUBLISH_AT },
            )

            val decision = provider.prepare(ACCOUNT, queue)
            assertTrue(decision is DriveV1QueuePlanDecision.Ready)
            val writes = (decision as DriveV1QueuePlanDecision.Ready).plan.prerequisites
            val blob = writes.single { it.kind == "blob" }
            assertEquals(blobPath, blob.path)
            assertEquals(DriveV1DurablePrecondition("must-match", "blob-file", 13), blob.precondition)
            assertEquals(oldHash, blob.baselineContentSha256)
            assertNotNull(blob.resumableOperationId)
            assertEquals(
                DriveV1DurableOperationIds.blob(
                    queue,
                    blobPath,
                    DriveWritePrecondition.MustMatch("blob-file", 13),
                    newHash,
                ),
                blob.resumableOperationId,
            )
            assertEquals(listOf(blobPath, metadataPath), writes.map { it.path })

            val missingBlobVersionProvider = RoomDriveV1QueuePlanProvider(
                database,
                DriveV1MetadataReader(
                    FakeDrive(
                        remoteFiles.map { file -> if (file.path == blobPath) file.copy(version = null) else file },
                        remoteJson,
                    ),
                ),
                publicationTimestamp = { PUBLISH_AT },
            )
            val missingBlobVersion = missingBlobVersionProvider.prepare(ACCOUNT, queue)
            assertTrue("decision=$missingBlobVersion", missingBlobVersion is DriveV1QueuePlanDecision.Blocked)
            assertTrue(
                (missingBlobVersion as DriveV1QueuePlanDecision.Blocked).reason.contains("version", ignoreCase = true),
            )
        } finally {
            database.close()
        }
    }

    @Test
    fun descendantPublicationIsBlockedWhenVerifiedRemoteParentIsTombstoned() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao)
            val entry = localEntry("Local parent", version = 1, updatedAt = BASE_AT)
            dao.upsertEntry(entry)
            val attachment = AttachmentEntity(
                accountId = ACCOUNT.value,
                id = "attachment-1",
                entryId = entry.id,
                type = "file",
                filename = "blocked.bin",
                displaySize = "1 B",
                byteSize = 1,
                storagePath = "account-local-blob",
                mimeType = "application/octet-stream",
                sha256 = "a".repeat(64),
                createdAt = BASE_AT,
                updatedAt = MUTATION_AT,
            )
            dao.upsertAttachment(attachment)
            val queue = claimedQueue("attachment", attachment.id, baseVersion = null)
            dao.insertQueueItemIfAbsent(queue)
            val tombstone = DriveV1Tombstone(
                id = "entry-1-tombstone",
                entityKind = "entry",
                entityId = entry.id,
                deletedAt = REMOTE_AT,
                deletedByDeviceId = "remote-device",
            ).requireV1()
            val tombstonePath = DriveV1Paths.tombstone("entry", entry.id)
            val provider = RoomDriveV1QueuePlanProvider(
                database,
                DriveV1MetadataReader(
                    FakeDrive(
                        files = listOf(
                            ref(DriveV1Paths.manifest, "manifest-file", 11),
                            ref(tombstonePath, "tombstone-file", 3),
                        ),
                        json = mapOf(
                            DriveV1Paths.manifest to DriveV1Json.format.encodeToString(manifest(entryCount = 0)),
                            tombstonePath to DriveV1Json.format.encodeToString(tombstone),
                        ),
                    ),
                ),
                publicationTimestamp = { PUBLISH_AT },
            )

            val decision = provider.prepare(ACCOUNT, queue)
            assertTrue(decision is DriveV1QueuePlanDecision.Blocked)
            assertTrue((decision as DriveV1QueuePlanDecision.Blocked).reason.contains("tombstoned"))
        } finally {
            database.close()
        }
    }

    @Test
    fun deleteEditRaceCreatesDeterministicConflictAndNoWritePlan() = runTest {
        val fixture = entryFixture(localTitle = "Base", remoteTitle = "Remote edit", delete = true)
        try {
            val decision = fixture.provider.prepare(ACCOUNT, fixture.queue)
            assertTrue(decision is DriveV1QueuePlanDecision.Conflict)
            val conflict = fixture.database.dao().conflicts(ACCOUNT.value).single()
            assertEquals("conf-entry-entry-1", conflict.id)
            assertTrue(conflict.summary.contains("conflicts"))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun parentTombstoneProjectsEntryAttachmentFileBoxAndTransferOutOfManifest() = runTest {
        val database = database()
        try {
            val dao = database.dao()
            seedAccount(dao)
            val remoteEntry = entryEnvelope("Base", version = 1, updatedAt = BASE_AT)
            dao.upsertDriveRawDocument(rawBaseline("entry", "entry-1", ENTRY_PATH, "entry-file", 7, remoteEntry))
            dao.upsertTombstone(
                TombstoneEntity(
                    accountId = ACCOUNT.value,
                    id = "entry-1-tombstone",
                    entityKind = "entry",
                    entityId = "entry-1",
                    deletedAt = MUTATION_AT,
                    deletedByDeviceId = "device-a",
                ),
            )
            val queue = claimedQueue("entry", "entry-1", operation = "delete", baseVersion = 1)
            dao.insertQueueItemIfAbsent(queue)
            val attachment = attachmentEnvelope("a".repeat(64), BASE_AT)
            val fileBox = DriveV1Envelope(
                id = "file-box-1",
                kind = "fileBoxItem",
                updatedAt = BASE_AT,
                updatedByDeviceId = "device-a",
                payload = DriveV1FileBoxItem(
                    id = "file-box-1",
                    entryId = "entry-1",
                    attachmentId = "attachment-1",
                    filename = "large.bin",
                    filesize = "5 MiB",
                    sourceDeviceId = "device-a",
                    sourceDeviceName = "Device A",
                    status = "available",
                    createdAt = BASE_AT,
                    updatedAt = BASE_AT,
                ),
            ).requireV1("fileBoxItem")
            val transfer = DriveV1Envelope(
                id = "transfer-1",
                kind = "transfer",
                updatedAt = BASE_AT,
                updatedByDeviceId = "device-a",
                payload = DriveV1Transfer(
                    id = "transfer-1",
                    fileBoxItemId = "file-box-1",
                    entryId = "entry-1",
                    attachmentId = "attachment-1",
                    filename = "large.bin",
                    fromDeviceId = "device-a",
                    fromDeviceName = "Device A",
                    provider = "google-drive",
                    status = "available",
                    createdAt = BASE_AT,
                    updatedAt = BASE_AT,
                ),
            ).requireV1("transfer")
            val blobPath = attachment.payload.storagePath
            val metadataPath = "$blobPath.json"
            val files = listOf(
                ref(DriveV1Paths.manifest, "manifest-file", 11),
                ref(ENTRY_PATH, "entry-file", 7),
                ref(
                    blobPath,
                    "blob-file",
                    13,
                    mapOf(
                        "entityType" to "attachmentBlob",
                        "sha256" to requireNotNull(attachment.payload.sha256),
                    ),
                ),
                ref(metadataPath, "attachment-file", 5),
                ref(DriveV1Paths.fileBox("file-box-1"), "filebox-file", 3),
                ref(DriveV1Paths.transfer("transfer-1"), "transfer-file", 4),
            )
            val json = mapOf(
                DriveV1Paths.manifest to DriveV1Json.format.encodeToString(
                    manifest(entryCount = 1, attachmentCount = 1).copy(fileBoxCount = 1, transferCount = 1),
                ),
                ENTRY_PATH to DriveV1Json.format.encodeToString(remoteEntry),
                metadataPath to DriveV1Json.format.encodeToString(attachment),
                DriveV1Paths.fileBox("file-box-1") to DriveV1Json.format.encodeToString(fileBox),
                DriveV1Paths.transfer("transfer-1") to DriveV1Json.format.encodeToString(transfer),
            )
            val provider = RoomDriveV1QueuePlanProvider(
                database,
                DriveV1MetadataReader(FakeDrive(files, json)),
                publicationTimestamp = { PUBLISH_AT },
            )

            val decision = provider.prepare(ACCOUNT, queue)
            assertTrue("decision=$decision", decision is DriveV1QueuePlanDecision.Ready)
            val ready = decision as DriveV1QueuePlanDecision.Ready
            val manifestWrite = ready.plan.manifest
            val manifestPayload = ready.payloads.single { it.payloadKey == manifestWrite.localJsonKey }
            val projected = DriveV1Json.format.decodeFromString<DriveV1Manifest>(manifestPayload.payloadJson).requireV1()
            assertEquals(listOf(0, 0, 0, 0), listOf(
                projected.entryCount,
                projected.attachmentCount,
                projected.fileBoxCount,
                projected.transferCount,
            ))
        } finally {
            database.close()
        }
    }

    private suspend fun entryFixture(
        localTitle: String,
        remoteTitle: String?,
        malformedRemote: Boolean = false,
        delete: Boolean = false,
        manifestVersion: Long? = 11,
        entityVersion: Long? = 7,
    ): EntryFixture {
        val database = database()
        val dao = database.dao()
        seedAccount(dao)
        val baseEnvelope = entryEnvelope("Base", version = 1, updatedAt = BASE_AT)
        val local = localEntry(localTitle, version = 2, updatedAt = MUTATION_AT)
        if (!delete) dao.upsertEntry(local)
        val queue = claimedQueue("entry", local.id, if (delete) "delete" else "upsert", baseVersion = 1)
        dao.insertQueueItemIfAbsent(queue)
        dao.upsertDriveRawDocument(rawBaseline("entry", local.id, ENTRY_PATH, "entry-file", 7, baseEnvelope))
        if (delete) {
            dao.upsertTombstone(
                TombstoneEntity(
                    accountId = ACCOUNT.value,
                    id = "entry-1-tombstone",
                    entityKind = "entry",
                    entityId = local.id,
                    deletedAt = MUTATION_AT,
                    deletedByDeviceId = "device-a",
                ),
            )
        }
        val remoteFiles = mutableListOf(ref(DriveV1Paths.manifest, "manifest-file", manifestVersion))
        val remoteJson = mutableMapOf(
            DriveV1Paths.manifest to DriveV1Json.format.encodeToString(
                manifest(entryCount = if (remoteTitle == null) 0 else 1),
            ),
        )
        if (remoteTitle != null) {
            remoteFiles += ref(ENTRY_PATH, "entry-file", entityVersion)
            remoteJson[ENTRY_PATH] = if (malformedRemote) {
                "{not-json"
            } else {
                DriveV1Json.format.encodeToString(
                    entryEnvelope(
                        remoteTitle,
                        version = 1,
                        updatedAt = if (remoteTitle == "Base") BASE_AT else REMOTE_AT,
                    ),
                )
            }
        }
        val provider = RoomDriveV1QueuePlanProvider(
            database,
            DriveV1MetadataReader(FakeDrive(remoteFiles, remoteJson)),
            publicationTimestamp = { PUBLISH_AT },
        )
        return EntryFixture(database, queue, provider)
    }

    private fun database(): LabNotebookDatabase {
        val context = ApplicationProvider.getApplicationContext<Context>()
        return Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    private suspend fun seedAccount(dao: com.easylab.labnotebook.data.local.LabNotebookDao) {
        dao.upsertAccount(AccountEntity(ACCOUNT.value, "planner@example.invalid", connectedAt = BASE_AT))
    }

    private fun localEntry(title: String, version: Int, updatedAt: String) = JournalEntryEntity(
        accountId = ACCOUNT.value,
        id = "entry-1",
        title = title,
        dateBucket = "2026-08-01",
        createdAt = "2026-08-01T09:00:00.000Z",
        updatedAt = updatedAt,
        authorId = "author",
        version = version,
        updatedByDeviceId = "device-a",
    )

    private fun entryEnvelope(title: String, version: Int, updatedAt: String): DriveV1Envelope<DriveV1Entry> =
        DriveV1Envelope(
            id = "entry-1",
            kind = "entry",
            updatedAt = updatedAt,
            updatedByDeviceId = "device-a",
            payload = DriveV1Entry(
                id = "entry-1",
                createdDatetime = "2026-08-01T09:00:00.000Z",
                lastEditedDatetime = updatedAt,
                authorId = "author",
                title = title,
                dateBucket = "2026-08-01",
                version = version,
                updatedByDeviceId = "device-a",
                syncStatus = "synced",
            ),
        ).requireV1("entry")

    private fun attachmentEnvelope(hash: String, updatedAt: String): DriveV1Envelope<DriveV1Attachment> {
        val path = DriveV1Paths.attachmentBlob("2026-08-01", "attachment-1", "large.bin")
        return DriveV1Envelope(
            id = "attachment-1",
            kind = "attachment",
            updatedAt = updatedAt,
            updatedByDeviceId = "device-a",
            payload = DriveV1Attachment(
                id = "attachment-1",
                entryId = "entry-1",
                type = "file",
                filename = "large.bin",
                filesize = "5 MiB",
                bytes = 5L * 1024L * 1024L,
                storagePath = path,
                mimeType = "application/octet-stream",
                sha256 = hash,
                createdAt = BASE_AT,
                updatedAt = updatedAt,
            ),
        ).requireV1("attachment")
    }

    private fun manifest(entryCount: Int, attachmentCount: Int = 0) = DriveV1Manifest(
        createdAt = "2026-08-01T08:00:00.000Z",
        updatedAt = REMOTE_AT,
        entryCount = entryCount,
        attachmentCount = attachmentCount,
    ).requireV1()

    private fun claimedQueue(
        kind: String,
        id: String,
        operation: String = "upsert",
        baseVersion: Int?,
    ) = SyncQueueEntity(
        accountId = ACCOUNT.value,
        id = "$kind-$operation",
        entityKind = kind,
        entityId = id,
        operation = operation,
        status = "syncing",
        queuedAt = MUTATION_AT,
        updatedAt = MUTATION_AT,
        updatedByDeviceId = "device-a",
        baseVersion = baseVersion,
        claimToken = "claimed-token",
        claimedAt = MUTATION_AT,
        leaseExpiresAt = "2026-08-01T13:00:00.000Z",
        attemptCount = 1,
    )

    private inline fun <reified T> rawBaseline(
        kind: String,
        id: String,
        path: String,
        fileId: String,
        version: Long,
        value: T,
    ) = DriveRawDocumentEntity(
        accountId = ACCOUNT.value,
        entityKind = kind,
        entityId = id,
        path = path,
        driveFileId = fileId,
        driveVersion = version,
        driveModifiedAt = BASE_AT,
        rawJson = DriveV1Json.format.encodeToString(value),
    )

    private class FakeDrive(
        private val files: List<DriveFileRef>,
        private val json: Map<String, String>,
    ) : DriveRepository {
        override val writeCapability = DriveWriteCapability.DisabledPendingContractParity
        override suspend fun listManagedFiles(accountId: AccountId, prefix: String?) = Result.success(
            files.filter { prefix == null || it.path.startsWith(prefix) },
        )
        override suspend fun readJson(accountId: AccountId, path: String) = Result.success(json[path])
        override suspend fun putJson(accountId: AccountId, path: String, json: String) = disabled<DriveFileRef>()
        override suspend fun putBlob(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
        ) = disabled<DriveFileRef>()

        private fun <T> disabled(): Result<T> = Result.failure(IllegalStateException("Writes are disabled."))
    }

    private data class EntryFixture(
        val database: LabNotebookDatabase,
        val queue: SyncQueueEntity,
        val provider: RoomDriveV1QueuePlanProvider,
    ) {
        fun close() = database.close()
    }

    private companion object {
        val ACCOUNT = AccountId("planner-account")
        const val BASE_AT = "2026-08-01T10:00:00.000Z"
        const val MUTATION_AT = "2026-08-01T11:00:00.000Z"
        const val REMOTE_AT = "2026-08-01T10:30:00.000Z"
        const val PUBLISH_AT = "2026-08-01T12:00:00.000Z"
        val ENTRY_PATH = DriveV1Paths.entry("2026-08-01")

        fun ref(
            path: String,
            id: String,
            version: Long?,
            appProperties: Map<String, String> = emptyMap(),
        ) = DriveFileRef(
            id = id,
            path = path,
            name = path.substringAfterLast('/'),
            updatedAt = REMOTE_AT,
            version = version,
            appProperties = appProperties,
        )
    }
}
