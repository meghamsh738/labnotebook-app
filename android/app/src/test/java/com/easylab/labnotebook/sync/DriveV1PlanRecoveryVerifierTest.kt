package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveRepository
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveV1PlanRecoveryVerifierTest {
    @Test
    fun repairScopeAcceptsOnlyCapturedFilesAndPlanExplainedCreates() = runTest {
        val fixture = fixture()
        assertTrue(fixture.verifier.validatePlanScope(ACCOUNT, fixture.plan).isSuccess)

        fixture.remote.put(TOMBSTONE_PATH, "tombstone-file", 1, fixture.tombstoneJson)
        assertTrue(fixture.verifier.validatePlanScope(ACCOUNT, fixture.plan).isSuccess)

        fixture.remote.put("entries/unplanned.json", "extra-file", 1, fixture.entryJson)
        val unexplained = fixture.verifier.validatePlanScope(ACCOUNT, fixture.plan)
        assertTrue(unexplained.isFailure)
        assertTrue(unexplained.exceptionOrNull()?.message.orEmpty().contains("unexplained", ignoreCase = true))
    }

    @Test
    fun repairScopeRejectsDuplicatesMissingFilesAndUnplannedVersionChanges() = runTest {
        val duplicate = fixture()
        duplicate.remote.files += duplicate.remote.files.single { it.path == ENTRY_PATH }.copy(id = "duplicate-entry")
        assertTrue(duplicate.verifier.validatePlanScope(ACCOUNT, duplicate.plan).isFailure)

        val missing = fixture()
        missing.remote.files.removeAll { it.path == ENTRY_PATH }
        assertTrue(missing.verifier.validatePlanScope(ACCOUNT, missing.plan).isFailure)

        val altered = fixture()
        altered.remote.replaceRef(ENTRY_PATH) { it.copy(version = requireNotNull(it.version) + 1) }
        assertTrue(altered.verifier.validatePlanScope(ACCOUNT, altered.plan).isFailure)
    }

    @Test
    fun exactWritesReconcileWhileMalformedOrDivergentContentFailsClosed() = runTest {
        val fixture = fixture()
        val tombstoneWrite = fixture.plan.prerequisites.single()
        assertTrue(fixture.verifier.check(ACCOUNT, tombstoneWrite, null) is DriveV1RecoveryCheck.ReadyToWrite)

        fixture.remote.put(TOMBSTONE_PATH, "tombstone-file", 1, fixture.tombstoneJson)
        val exact = fixture.verifier.check(ACCOUNT, tombstoneWrite, null)
        assertTrue(exact is DriveV1RecoveryCheck.Exact)

        fixture.remote.json[TOMBSTONE_PATH] = "{not-json"
        val malformed = fixture.verifier.check(ACCOUNT, tombstoneWrite, null)
        assertTrue(malformed is DriveV1RecoveryCheck.Blocked)

        val manifestWrite = fixture.plan.manifest
        assertTrue(fixture.verifier.check(ACCOUNT, manifestWrite, null) is DriveV1RecoveryCheck.ReadyToWrite)
        fixture.remote.put(DriveV1Paths.manifest, "manifest-file", 5, fixture.newManifestJson)
        assertTrue(fixture.verifier.check(ACCOUNT, manifestWrite, null) is DriveV1RecoveryCheck.Exact)

        val receipt = DriveV1VerifiedWriteReceipt(
            path = DriveV1Paths.manifest,
            fileId = "manifest-file",
            version = 5,
            contentSha256 = digest(fixture.newManifestJson.toByteArray(StandardCharsets.UTF_8)),
            remoteUpdatedAt = UPDATED_AT,
        )
        assertTrue(fixture.verifier.check(ACCOUNT, manifestWrite, receipt) is DriveV1RecoveryCheck.Exact)
        fixture.remote.replaceRef(DriveV1Paths.manifest) { it.copy(version = 6) }
        assertTrue(fixture.verifier.check(ACCOUNT, manifestWrite, receipt) is DriveV1RecoveryCheck.Blocked)
    }

    @Test
    fun repairIdentityCannotCrossAccounts() = runTest {
        val fixture = fixture()
        val result = fixture.verifier.validatePlanScope(AccountId("different-account"), fixture.plan)
        assertTrue(result.isFailure)
    }

    @Test
    fun existingBlobMustMatchVerifiedAttachmentBaselineBeforeOverwrite() = runTest {
        val fixture = fixture()
        val blobPath = DriveV1Paths.attachmentBlob("2026-08-01", "attachment-1", "result.bin")
        val oldBytes = "verified-old-blob".toByteArray(StandardCharsets.UTF_8)
        val newBytes = "intended-new-blob".toByteArray(StandardCharsets.UTF_8)
        val oldHash = digest(oldBytes)
        val newHash = digest(newBytes)
        fixture.remote.putBlob(blobPath, "blob-file", 9, oldBytes, oldHash)
        val write = DriveV1DurableWrite.blob(
            path = blobPath,
            localBlobKey = "account-scoped-blob-key",
            mimeType = "application/octet-stream",
            byteCount = oldBytes.size.toLong(),
            sha256 = newHash,
            precondition = DriveWritePrecondition.MustMatch("blob-file", 9),
            baselineContentSha256 = oldHash,
        )
        val plan = DriveV1DurableTransactionPlan.create(
            prerequisites = listOf(write),
            manifest = fixture.plan.manifest,
            baselineFiles = fixture.remote.files,
            baselineContentSha256ByPath = mapOf(blobPath to oldHash),
        )

        assertTrue(fixture.verifier.validatePlanScope(ACCOUNT, plan).isSuccess)
        assertTrue(fixture.verifier.check(ACCOUNT, write, null) is DriveV1RecoveryCheck.ReadyToWrite)
        assertTrue(plan.baselineFiles.single { it.path == blobPath }.contentSha256 == oldHash)

        fixture.remote.hashes[blobPath] = digest("corrupt-remote-bytes".toByteArray(StandardCharsets.UTF_8))
        assertTrue(fixture.verifier.check(ACCOUNT, write, null) is DriveV1RecoveryCheck.Blocked)
    }

    private fun fixture(): Fixture {
        val oldManifest = DriveV1Manifest(
            createdAt = CREATED_AT,
            updatedAt = BASE_AT,
            entryCount = 1,
        ).requireV1()
        val newManifest = oldManifest.copy(updatedAt = UPDATED_AT).requireV1()
        val entry = DriveV1Envelope(
            id = "entry-1",
            kind = "entry",
            updatedAt = BASE_AT,
            updatedByDeviceId = "device-a",
            payload = DriveV1Entry(
                id = "entry-1",
                createdDatetime = CREATED_AT,
                lastEditedDatetime = BASE_AT,
                authorId = "author",
                title = "Verified entry",
                dateBucket = "2026-08-01",
                version = 1,
                updatedByDeviceId = "device-a",
            ),
        ).requireV1("entry")
        val tombstone = DriveV1Tombstone(
            id = "deleted-entry-tombstone",
            entityKind = "entry",
            entityId = "deleted-entry",
            deletedAt = UPDATED_AT,
            deletedByDeviceId = "device-a",
        ).requireV1()
        val oldManifestJson = DriveV1Json.format.encodeToString(oldManifest)
        val newManifestJson = DriveV1Json.format.encodeToString(newManifest)
        val entryJson = DriveV1Json.format.encodeToString(entry)
        val tombstoneJson = DriveV1Json.format.encodeToString(tombstone)
        val remote = FakeRemoteRepository()
        remote.put(DriveV1Paths.manifest, "manifest-file", 4, oldManifestJson)
        remote.put(ENTRY_PATH, "entry-file", 7, entryJson)
        val plan = DriveV1DurableTransactionPlan.create(
            prerequisites = listOf(
                DriveV1DurableWrite.json(
                    path = TOMBSTONE_PATH,
                    json = tombstoneJson,
                    localJsonKey = "payload-tombstone",
                    precondition = DriveWritePrecondition.MustNotExist,
                    baselineEntityKind = "tombstone",
                    baselineEntityId = tombstone.id,
                ),
            ),
            manifest = DriveV1DurableWrite.json(
                path = DriveV1Paths.manifest,
                json = newManifestJson,
                localJsonKey = "payload-manifest",
                precondition = DriveWritePrecondition.MustMatch("manifest-file", 4),
                baselineEntityKind = "manifest",
                baselineEntityId = "manifest",
            ),
            baselineFiles = remote.files,
        )
        val verifier = DriveV1PlanRecoveryVerifier(
            remote,
            DriveV1RemoteContentHasher { accountId, file ->
                if (accountId != ACCOUNT) Result.failure(IllegalArgumentException("wrong account"))
                else remote.hashes[file.path]?.let { Result.success(it) }
                    ?: Result.failure(IllegalArgumentException("missing content"))
            },
        )
        return Fixture(remote, verifier, plan, entryJson, tombstoneJson, newManifestJson)
    }

    private data class Fixture(
        val remote: FakeRemoteRepository,
        val verifier: DriveV1PlanRecoveryVerifier,
        val plan: DriveV1DurableTransactionPlan,
        val entryJson: String,
        val tombstoneJson: String,
        val newManifestJson: String,
    )

    private class FakeRemoteRepository : DriveRepository {
        override val writeCapability = DriveWriteCapability.DisabledPendingContractParity
        val files = mutableListOf<DriveFileRef>()
        val json = linkedMapOf<String, String>()
        val hashes = linkedMapOf<String, String>()

        fun put(path: String, id: String, version: Long, content: String) {
            files.removeAll { it.path == path }
            files += ref(
                path,
                id,
                version,
                content.toByteArray(StandardCharsets.UTF_8).size.toLong(),
                expectedProperties(path, content),
            )
            json[path] = content
            hashes[path] = digest(content.toByteArray(StandardCharsets.UTF_8))
        }

        fun putBlob(path: String, id: String, version: Long, content: ByteArray, sha256: String) {
            files.removeAll { it.path == path }
            files += DriveFileRef(
                id = id,
                path = path,
                name = path.substringAfterLast('/'),
                mimeType = "application/octet-stream",
                size = content.size.toLong(),
                updatedAt = UPDATED_AT,
                appProperties = mapOf("entityType" to "attachmentBlob", "sha256" to sha256),
                version = version,
            )
            hashes[path] = digest(content)
        }

        fun replaceRef(path: String, change: (DriveFileRef) -> DriveFileRef) {
            val index = files.indexOfFirst { it.path == path }
            files[index] = change(files[index])
        }

        override suspend fun listManagedFiles(accountId: AccountId, prefix: String?): Result<List<DriveFileRef>> =
            if (accountId == ACCOUNT) {
                Result.success(files.filter { prefix == null || it.path.startsWith(prefix) }.toList())
            } else {
                Result.success(emptyList())
            }

        override suspend fun readJson(accountId: AccountId, path: String): Result<String?> =
            if (accountId == ACCOUNT) Result.success(json[path]) else Result.success(null)

        override suspend fun putJson(accountId: AccountId, path: String, json: String) = disabled()
        override suspend fun putBlob(
            accountId: AccountId,
            path: String,
            bytes: ByteArray,
            mimeType: String,
            sha256: String,
        ) = disabled()

        private fun disabled(): Result<DriveFileRef> = Result.failure(IllegalStateException("writes disabled"))

        private fun expectedProperties(path: String, content: String): Map<String, String> = when {
            path == DriveV1Paths.manifest -> mapOf("entityType" to "manifest")
            path.startsWith("entries/") -> {
                val value = DriveV1Json.format.decodeFromString<DriveV1Envelope<DriveV1Entry>>(content)
                    .requireV1("entry")
                mapOf(
                    "entityType" to "entry",
                    "entityId" to value.id,
                    "contentHash" to DriveV1Hashing.entryContentHash(value.payload),
                )
            }
            path.startsWith("tombstones/") -> {
                val value = DriveV1Json.format.decodeFromString<DriveV1Tombstone>(content).requireV1()
                mapOf("entityType" to "tombstone", "entityId" to value.entityId)
            }
            else -> mapOf("entityType" to "unknown")
        }
    }

    private companion object {
        val ACCOUNT = AccountId("repair-account")
        const val CREATED_AT = "2026-08-01T09:00:00.000Z"
        const val BASE_AT = "2026-08-01T10:00:00.000Z"
        const val UPDATED_AT = "2026-08-01T11:00:00.000Z"
        val ENTRY_PATH = DriveV1Paths.entry("2026-08-01")
        val TOMBSTONE_PATH = DriveV1Paths.tombstone("entry", "deleted-entry")

        fun ref(
            path: String,
            id: String,
            version: Long,
            size: Long,
            appProperties: Map<String, String>,
        ) = DriveFileRef(
            id = id,
            path = path,
            name = path.substringAfterLast('/'),
            mimeType = "application/json",
            size = size,
            updatedAt = UPDATED_AT,
            appProperties = appProperties,
            version = version,
        )

        fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}
