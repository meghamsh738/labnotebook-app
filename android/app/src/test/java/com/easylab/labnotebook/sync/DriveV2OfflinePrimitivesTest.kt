package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveV2OfflinePrimitivesTest {
    private val json = Json { ignoreUnknownKeys = false }
    private val accountId = AccountId("account-v2-test")

    @Test
    fun canonicalJsonMatchesSharedRfc8785VectorAndRejectsNoncanonicalBytes() {
        val fixture = fixture("canonicalization.json")
        val input = fixture.objectValue("input")
        val expected = fixture.text("expectedCanonicalJson")

        assertEquals(expected, DriveV2CanonicalJson.encode(input))
        assertEquals(fixture.text("expectedSha256"), DriveV2CanonicalJson.sha256(input))
        assertEquals(input, DriveV2CanonicalJson.decodeCanonicalObject(expected.toByteArray(StandardCharsets.UTF_8)))

        assertCode("noncanonical-json-bytes") {
            DriveV2CanonicalJson.decodeCanonicalObject(" $expected".toByteArray(StandardCharsets.UTF_8))
        }
        assertCode("noncanonical-json-bytes") {
            DriveV2CanonicalJson.decodeCanonicalObject(
                byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()) + expected.toByteArray(StandardCharsets.UTF_8),
            )
        }
        assertCode("invalid-utf8") {
            DriveV2CanonicalJson.decodeCanonicalObject(byteArrayOf(0xc3.toByte(), 0x28))
        }
        assertCode("invalid-unicode-scalar") {
            DriveV2CanonicalJson.decodeCanonicalObject("{\"value\":\"\\ud800\"}".toByteArray(StandardCharsets.UTF_8))
        }
        assertEquals(
            "{\"value\":1e+23}",
            DriveV2CanonicalJson.encode(buildJsonObject { put("value", 1e23) }),
        )
    }

    @Test
    fun sharedConcurrentEditFixtureProducesSameFrontierAndConflictId() {
        val fixture = fixture("concurrent-edits.json")
        val state = validateFixture(fixture)
        val target = fixture.objects("objects").first().body
        val key = "${target.text("entityKind")}:${target.text("entityId")}"
        val expected = fixture.objectValue("expected")

        assertEquals(expected.stringList("tips"), state.tips)
        assertEquals(expected.stringList("maximalObjectIds"), state.frontiers.getValue(key))
        val decision = DriveV2GraphValidator.classify(state.frontiers.getValue(key), state.objectMap)
        assertEquals(expected.text("decision"), decision.decision)
        assertEquals(expected.text("conflictId"), decision.conflictId)
        assertFalse(decision.visible)
    }

    @Test
    fun sharedDeleteEditRaceSuppressesDescendantsUntilExplicitResolution() {
        val fixture = fixture("delete-edit-race.json")
        val race = fixture.objectValue("raceSnapshot")
        val raceState = validateFixture(fixture, race.stringList("commitIds").toSet())
        val raceProjection = DriveV2GraphValidator.project(raceState)
        val expectedRace = race.objectValue("expected")
        val target = fixture.objectValue("target")
        val key = "${target.text("entityKind")}:${target.text("entityId")}"

        assertEquals(expectedRace.stringList("frontier"), raceState.frontiers.getValue(key))
        assertEquals(expectedRace.stringList("visibleTargets"), raceProjection.visibleTargets)
        assertEquals(expectedRace.stringList("suppressedTargets"), raceProjection.suppressedTargets)
        assertFalse(expectedRace.booleanValue("resurrectionAllowed"))

        val resolved = fixture.objectValue("resolvedSnapshot")
        val resolvedState = validateFixture(fixture, resolved.stringList("commitIds").toSet())
        val resolvedProjection = DriveV2GraphValidator.project(resolvedState)
        val expectedResolved = resolved.objectValue("expected")
        assertEquals(expectedResolved.stringList("frontier"), resolvedState.frontiers.getValue(key))
        assertEquals(expectedResolved.stringList("visibleTargets"), resolvedProjection.visibleTargets)
        assertEquals(expectedResolved.stringList("suppressedTargets"), resolvedProjection.suppressedTargets)
    }

    @Test
    fun sharedCrossClientRoundTripPreservesCanonicalIdentityAndPreventsResurrection() {
        val fixture = fixture("cross-client-round-trip.json")
        assertFalse(fixture.booleanValue("liveDriveUsed"))
        assertFalse(fixture.booleanValue("productionWritesEnabled"))

        val blob = fixture.arrayValue("blobs").single().jsonObject
        val blobBytes = Base64.getDecoder().decode(blob.text("bytesBase64"))
        assertEquals(blob.longValue("byteCount"), blobBytes.size.toLong())
        assertEquals(blob.text("expectedId"), DriveV2Contract.blobId(blobBytes))
        assertEquals(blob.text("expectedContentSha256"), DriveV2CanonicalJson.sha256(blobBytes))
        assertEquals(blob.text("path"), DriveV2Contract.blobPath(blob.text("expectedId")))

        val objectFixtures = fixture.arrayValue("objects").map { it.jsonObject }
        val objectsById = objectFixtures.associateBy { it.text("expectedId") }
        objectFixtures.forEach { record ->
            val body = record.objectValue("body")
            assertEquals(record.text("expectedId"), DriveV2Contract.objectId(body))
            assertEquals(record.text("expectedContentSha256"), DriveV2CanonicalJson.sha256(body))
            assertEquals(record.text("expectedPath"), DriveV2Contract.objectPath(record.text("expectedId")))
        }

        val commitFixtures = fixture.arrayValue("commits").map { it.jsonObject }
        commitFixtures.forEach { record ->
            val body = record.objectValue("body")
            assertEquals(record.text("expectedId"), DriveV2Contract.commitId(body))
            assertEquals(record.text("expectedContentSha256"), DriveV2CanonicalJson.sha256(body))
            assertEquals(record.text("expectedPath"), DriveV2Contract.commitPath(record.text("expectedId")))
        }

        fixture.arrayValue("stages").forEach { element ->
            val stage = element.jsonObject
            val state = validateFixture(fixture, stage.stringList("commitIds").toSet())
            val projection = DriveV2GraphValidator.project(state)
            val expected = stage.objectValue("expected")
            val expectedFrontiers = expected.objectValue("frontiers").mapValues { (_, ids) ->
                ids.jsonArray.map { it.jsonPrimitive.content }
            }
            assertEquals(expected.stringList("tips"), state.tips)
            assertEquals(expectedFrontiers, state.frontiers)
            assertEquals(expected.stringList("visibleTargets"), projection.visibleTargets)
            assertEquals(expected.stringList("suppressedTargets"), projection.suppressedTargets)
        }

        fixture.arrayValue("transactions").forEach { element ->
            val transaction = element.jsonObject
            val commit = commitFixtures.single {
                it.objectValue("body").text("operationId") == transaction.text("operationId")
            }
            val body = commit.objectValue("body")
            val expectedOrder = buildList {
                body.stringList("blobIds").forEach { add(DriveV2Contract.blobPath(it)) }
                body.stringList("objectIds").forEach { add(objectsById.getValue(it).text("expectedPath")) }
                add(commit.text("expectedPath"))
            }
            assertEquals(transaction.text("client"), commit.text("origin"))
            assertEquals(expectedOrder, transaction.stringList("writeOrder"))
            assertTrue(transaction.booleanValue("commitLast"))
            assertEquals(commit.text("expectedPath"), transaction.stringList("writeOrder").last())
        }

        val recovery = fixture.objectValue("recovery")
        val finalStage = fixture.arrayValue("stages").single {
            it.jsonObject.text("name") == "android-return"
        }.jsonObject
        val finalState = validateFixture(fixture, finalStage.stringList("commitIds").toSet())
        assertEquals(
            recovery.booleanValue("orphanVisible"),
            recovery.text("uncommittedObjectId") in finalState.visibleObjectIds,
        )
        assertFalse(recovery.booleanValue("resurrectionAllowed"))
        assertEquals(0L, recovery.longValue("physicalDeletionCount"))
        val entryPayloads = objectFixtures.mapNotNull { record ->
            val body = record.objectValue("body")
            if (body.text("entityKind") == "entry") body["payload"] as? JsonObject else null
        }
        assertTrue(entryPayloads.all { recovery.text("unknownRemoteField") in it })
        assertTrue(recovery.booleanValue("unknownRemoteFieldPreserved"))
        recovery.stringList("localOnlyFieldsAbsent").forEach { field ->
            assertTrue(entryPayloads.all { field !in it })
        }
    }

    @Test
    fun relationshipValidationBlocksMissingAndInconsistentParents() {
        val workspaceId = "ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        val missingAttachment = objectRecord(
            objectBody(workspaceId, "attachment", "attachment-missing", payload = buildJsonObject {
                put("id", "attachment-missing")
                put("entryId", "entry-missing")
            }),
        )
        val missingCommit = commitRecord(
            commitBody(workspaceId, "op-missing", listOf(missingAttachment.expectedId)),
        )
        assertCode("missing-parent-target") {
            DriveV2GraphValidator.validateWorkspace(workspaceId, listOf(missingAttachment), emptyList(), listOf(missingCommit))
        }

        val entryA = objectRecord(objectBody(workspaceId, "entry", "entry-a", buildJsonObject { put("id", "entry-a") }))
        val entryB = objectRecord(objectBody(workspaceId, "entry", "entry-b", buildJsonObject { put("id", "entry-b") }))
        val attachment = objectRecord(
            objectBody(workspaceId, "attachment", "attachment-a", buildJsonObject {
                put("id", "attachment-a")
                put("entryId", "entry-a")
            }),
        )
        val fileBox = objectRecord(
            objectBody(workspaceId, "fileBoxItem", "file-box-bad", buildJsonObject {
                put("id", "file-box-bad")
                put("entryId", "entry-b")
                put("attachmentId", "attachment-a")
            }),
        )
        val objects = listOf(entryA, entryB, attachment, fileBox)
        val commit = commitRecord(commitBody(workspaceId, "op-inconsistent", objects.map { it.expectedId }.sorted()))
        assertCode("inconsistent-parent-linkage") {
            DriveV2GraphValidator.validateWorkspace(workspaceId, objects, emptyList(), listOf(commit))
        }
    }

    @Test
    fun artifactSchemaRejectsStringifiedNumbersAndNonStringIdentifiers() {
        val workspaceId = "ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        val validBody = objectBody(workspaceId, "entry", "entry-typed", buildJsonObject { put("id", "entry-typed") })

        val stringVersion = JsonObject(validBody + ("schemaVersion" to JsonPrimitive("2")))
        assertCode("artifact-schema-mismatch") {
            DriveV2GraphValidator.validateObject(objectRecord(stringVersion), workspaceId)
        }
        val numericId = JsonObject(validBody + ("entityId" to JsonPrimitive(7)))
        assertCode("artifact-schema-mismatch") {
            DriveV2GraphValidator.validateObject(objectRecord(numericId), workspaceId)
        }
        val numericBase = JsonObject(validBody + ("baseObjectIds" to JsonArray(listOf(JsonPrimitive(1)))))
        assertCode("artifact-schema-mismatch") {
            DriveV2GraphValidator.validateObject(objectRecord(numericBase), workspaceId)
        }
        val floatingPayload = JsonObject(
            validBody + ("payload" to buildJsonObject {
                put("id", "entry-typed")
                put("measurement", 0.5)
            }),
        )
        assertCode("unsupported-artifact-number") {
            DriveV2GraphValidator.validateObject(objectRecord(floatingPayload), workspaceId)
        }
        val validCommit = commitBody(workspaceId, "op-typed", listOf(objectRecord(validBody).expectedId))
        val numericOperation = JsonObject(validCommit + ("operationId" to JsonPrimitive(99)))
        assertCode("artifact-schema-mismatch") {
            DriveV2GraphValidator.validateCommit(commitRecord(numericOperation), workspaceId)
        }
    }

    @Test
    fun canonicalUtcUsesTheSameProlepticGregorianDomainAsWeb() {
        val workspaceId = "ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        val canonicalBoundaries = listOf(
            "0000-01-01T00:00:00.000Z",
            "1582-10-10T00:00:00.000Z",
            "2000-02-29T23:59:59.999Z",
            "9999-12-31T23:59:59.999Z",
        )
        canonicalBoundaries.forEachIndexed { index, createdAt ->
            val body = JsonObject(
                commitBody(workspaceId, "op-canonical-utc-$index", emptyList()) +
                    ("createdAt" to JsonPrimitive(createdAt)),
            )
            DriveV2GraphValidator.validateCommit(commitRecord(body), workspaceId)
        }

        listOf(
            "1900-02-29T00:00:00.000Z",
            "2026-04-31T00:00:00.000Z",
            "2026-01-01T24:00:00.000Z",
            "2026-01-01T23:59:60.000Z",
        ).forEachIndexed { index, createdAt ->
            val body = JsonObject(
                commitBody(workspaceId, "op-invalid-utc-$index", emptyList()) +
                    ("createdAt" to JsonPrimitive(createdAt)),
            )
            assertCode("noncanonical-utc") {
                DriveV2GraphValidator.validateCommit(commitRecord(body), workspaceId)
            }
        }
    }

    @Test
    fun preflightVerifiesRawRemoteBytesAndEveryMarkedRootBeforePlanning() {
        val valid = buildPreflight()
        val readiness = DriveV2Preflight.validateBeforePlan(valid)
        assertTrue("entry:entry-interrupted" in readiness.projection.visibleTargets)
        assertTrue("attachment:attachment-interrupted" in readiness.projection.visibleTargets)

        val impostor = valid.roots.single().copy(
            driveFileId = "marked-json-impostor",
            name = "renamed",
            mimeType = "application/json",
            appProperties = valid.roots.single().appProperties +
                ("easylabWorkspaceId" to "ws-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        )
        assertCode("duplicate-marked-root") {
            DriveV2Preflight.validateBeforePlan(valid.copy(roots = valid.roots + impostor))
        }
        assertCode("account-switch") {
            DriveV2Preflight.validateBeforePlan(valid.copy(currentAccountId = AccountId("other-account")))
        }
        val referencedObject = valid.artifacts.first { it.kind == "object" }
        assertCode("missing-object-reference") {
            DriveV2Preflight.validateBeforePlan(
                valid.copy(artifacts = valid.artifacts.filterNot { it === referencedObject }),
            )
        }

        val remoteObject = valid.artifacts.first { it.kind == "object" }
        val bomBytes = byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()) + remoteObject.bytes
        val bomObject = remoteObject.withBytes(bomBytes)
        assertCode("noncanonical-json-bytes") {
            DriveV2Preflight.validateBeforePlan(
                valid.copy(artifacts = valid.artifacts.map { if (it === remoteObject) bomObject else it }),
            )
        }
    }

    @Test
    fun exactRemoteDuplicatesConvergeButDivergentCopiesBlock() {
        val valid = buildPreflight()
        val original = valid.artifacts.first { it.kind == "object" }
        val exact = original.withDriveFileId("exact-copy-drive-id")
        DriveV2Preflight.validateBeforePlan(valid.copy(artifacts = valid.artifacts + exact))

        val divergent = original.withDriveFileId("divergent-copy-drive-id").withBytes(
            original.bytes + ' '.code.toByte(),
        )
        assertCode("divergent-duplicate") {
            DriveV2Preflight.validateBeforePlan(valid.copy(artifacts = valid.artifacts + divergent))
        }
    }

    @Test
    fun createOnlyExecutorFreezesBytesAndPublishesCommitLast() = runTest {
        val transaction = createTransaction()
        val expectedBlob = transaction.blobs.single().bytes.copyOf()
        transaction.blobs.single().bytes.fill(0)
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (transaction.blobs.single().appProperties as MutableMap<String, String>)["changed"] = "bad"
        }
        val calls = mutableListOf<String>()
        val client = DriveV2CreateOnlyClient { _, artifact ->
            calls += artifact.path
            Result.success(artifact.receipt())
        }

        val result = DriveV2CreateTransactionExecutor(client).execute(transaction).getOrThrow()

        assertEquals(
            transaction.blobs.map { it.path } + transaction.objects.map { it.path } + transaction.commit.path,
            calls,
        )
        assertEquals(transaction.blobs.size + transaction.objects.size, result.prerequisiteReceipts.size)
        assertEquals(transaction.commit.path, result.commitReceipt.path)
        assertArrayEquals(expectedBlob, transaction.blobs.single().bytes)
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (result.commitReceipt.appProperties as MutableMap<String, String>)["changed"] = "bad"
        }
    }

    @Test
    fun prerequisiteFailureSuppressesCommitAndMismatchedReceiptFailsClosed() = runTest {
        val transaction = createTransaction()
        val calls = mutableListOf<String>()
        val failure = DriveV2CreateOnlyClient { _, artifact ->
            calls += artifact.path
            if (artifact.kind == "object") Result.failure(IllegalStateException("interrupted"))
            else Result.success(artifact.receipt())
        }
        val result = DriveV2CreateTransactionExecutor(failure).execute(transaction)
        assertTrue(result.exceptionOrNull() is DriveV2CreateTransactionException)
        assertFalse(transaction.commit.path in calls)

        val mismatch = DriveV2CreateOnlyClient { _, artifact ->
            Result.success(artifact.receipt().copy(mimeType = "application/x-wrong"))
        }
        val mismatchResult = DriveV2CreateTransactionExecutor(mismatch).execute(transaction)
        val mismatchError = mismatchResult.exceptionOrNull() as DriveV2CreateTransactionException
        assertEquals(transaction.blobs.single().path, mismatchError.failedPath)
        assertEquals("create-reconciliation-mismatch", (mismatchError.cause as DriveV2ContractException).code)
    }

    @Test
    fun transactionRejectsWorkspaceAndManagedFolderMixingBeforeClientCall() {
        val valid = createTransaction()
        assertFalse(DriveV2PlanReadiness::class.java.declaredMethods.any { it.name == "copy" })
        assertThrows(IllegalArgumentException::class.java) {
            DriveV2PlanReadiness(
                state = valid.readiness.state,
                projection = valid.readiness.projection,
                journal = buildPreflight().journal,
                validationSeal = Any(),
            )
        }
        val blob = valid.blobs.single()
        val wrongWorkspace = "ws-v2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        val mixedWorkspaceBlob = DriveV2CreateArtifact(
            kind = blob.kind,
            generatedDriveFileId = blob.generatedDriveFileId,
            parentFolderDriveFileId = blob.parentFolderDriveFileId,
            canonicalId = blob.canonicalId,
            path = blob.path,
            mimeType = blob.mimeType,
            bytes = blob.bytes,
            appProperties = DriveV2Contract.appProperties(
                wrongWorkspace,
                blob.kind,
                blob.canonicalId,
                blob.contentSha256,
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            DriveV2CreateTransaction(valid.readiness, listOf(mixedWorkspaceBlob), valid.objects, valid.commit)
        }

        val wrongFolderBlob = DriveV2CreateArtifact(
            kind = blob.kind,
            generatedDriveFileId = blob.generatedDriveFileId,
            parentFolderDriveFileId = "arbitrary-folder",
            canonicalId = blob.canonicalId,
            path = blob.path,
            mimeType = blob.mimeType,
            bytes = blob.bytes,
            appProperties = blob.appProperties,
        )
        assertThrows(IllegalArgumentException::class.java) {
            DriveV2CreateTransaction(valid.readiness, listOf(wrongFolderBlob), valid.objects, valid.commit)
        }
    }

    @Test
    fun cancellationPropagatesAndExactRetryKeepsGeneratedDriveIds() = runTest {
        val transaction = createTransaction()
        val cancelledCalls = mutableListOf<String>()
        val cancelled = DriveV2CreateOnlyClient { _, artifact ->
            cancelledCalls += artifact.generatedDriveFileId
            throw CancellationException("stop")
        }
        try {
            DriveV2CreateTransactionExecutor(cancelled).execute(transaction)
            throw AssertionError("Cancellation must propagate.")
        } catch (_: CancellationException) {
            // Recovery uses the same immutable transaction identity.
        }
        assertEquals(listOf(transaction.blobs.single().generatedDriveFileId), cancelledCalls)

        val retryCalls = mutableListOf<List<String>>()
        repeat(2) {
            val current = mutableListOf<String>()
            val client = DriveV2CreateOnlyClient { account, artifact ->
                assertEquals(accountId, account)
                current += artifact.generatedDriveFileId
                Result.success(artifact.receipt())
            }
            DriveV2CreateTransactionExecutor(client).execute(transaction).getOrThrow()
            retryCalls += current
        }
        assertEquals(retryCalls.first(), retryCalls.last())
    }

    @Test
    fun largeBlobRequiresStableResumableOperationIdentity() {
        val bytes = ByteArray(DriveV2CreateArtifact.RESUMABLE_THRESHOLD_BYTES)
        val id = DriveV2Contract.blobId(bytes)
        assertThrows(IllegalArgumentException::class.java) {
            DriveV2CreateArtifact(
                kind = "blob",
                generatedDriveFileId = "generated-large",
                parentFolderDriveFileId = "blobs-folder",
                canonicalId = id,
                path = DriveV2Contract.blobPath(id),
                mimeType = "application/octet-stream",
                bytes = bytes,
                appProperties = DriveV2Contract.appProperties(
                    "ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "blob",
                    id,
                    DriveV2CanonicalJson.sha256(bytes),
                ),
            )
        }
        val accepted = DriveV2CreateArtifact(
            kind = "blob",
            generatedDriveFileId = "generated-large",
            parentFolderDriveFileId = "blobs-folder",
            canonicalId = id,
            path = DriveV2Contract.blobPath(id),
            mimeType = "application/octet-stream",
            bytes = bytes,
            appProperties = DriveV2Contract.appProperties(
                "ws-v2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "blob",
                id,
                DriveV2CanonicalJson.sha256(bytes),
            ),
            resumableOperationId = "resume-large-v2",
        )
        assertEquals("resume-large-v2", accepted.resumableOperationId)

        val otherBytes = bytes.copyOf().also { it[0] = 1 }
        val workspaceId = "ws-v2-22222222222222222222222222222222"
        fun largeArtifact(value: ByteArray, driveId: String): DriveV2CreateArtifact {
            val blobId = DriveV2Contract.blobId(value)
            return DriveV2CreateArtifact(
                kind = "blob",
                generatedDriveFileId = driveId,
                parentFolderDriveFileId = "fixture-v2-blobs-folder-id",
                canonicalId = blobId,
                path = DriveV2Contract.blobPath(blobId),
                mimeType = "application/octet-stream",
                bytes = value,
                appProperties = DriveV2Contract.appProperties(
                    workspaceId,
                    "blob",
                    blobId,
                    DriveV2CanonicalJson.sha256(value),
                ),
                resumableOperationId = "duplicated-resume-id",
            )
        }
        val first = largeArtifact(bytes, "generated-large-a")
        val second = largeArtifact(otherBytes, "generated-large-b")
        val operationId = "op-duplicate-resume"
        val body = commitBody(
            workspaceId,
            operationId,
            objectIds = emptyList(),
            blobIds = listOf(first.canonicalId, second.canonicalId).sorted(),
        )
        val commitId = DriveV2Contract.commitId(body)
        val commitBytes = DriveV2CanonicalJson.encode(body).toByteArray(StandardCharsets.UTF_8)
        val commit = DriveV2CreateArtifact(
            kind = "commit",
            generatedDriveFileId = "generated-duplicate-resume-commit",
            parentFolderDriveFileId = "fixture-v2-commits-folder-id",
            canonicalId = commitId,
            path = DriveV2Contract.commitPath(commitId),
            mimeType = DriveV2Contract.JSON_MIME_TYPE,
            bytes = commitBytes,
            appProperties = DriveV2Contract.appProperties(
                workspaceId,
                "commit",
                commitId,
                DriveV2CanonicalJson.sha256(commitBytes),
            ),
        )
        val readiness = DriveV2Preflight.validateBeforePlan(
            buildPreflight(
                plannedDescriptors = listOf(first, second, commit).map(DriveV2CreateArtifact::descriptor),
                operationIdOverride = operationId,
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            DriveV2CreateTransaction(readiness, listOf(first, second), emptyList(), commit)
        }
    }

    private fun validateFixture(fixture: JsonObject, commitIds: Set<String>? = null): DriveV2WorkspaceState =
        DriveV2GraphValidator.validateWorkspace(
            workspaceId = fixture.text("workspaceId"),
            objects = fixture.objects("objects"),
            blobs = fixture["blobs"]?.jsonArray?.map { element ->
                val record = element.jsonObject
                DriveV2BlobRecord(
                    expectedId = record.text("expectedId"),
                    bytes = Base64.getDecoder().decode(record.text("bytesBase64")),
                    mimeType = record.text("mimeType"),
                )
            }.orEmpty(),
            commits = fixture.commits("commits").filter { commitIds == null || it.expectedId in commitIds },
        )

    private fun buildPreflight(
        plannedDescriptors: List<DriveV2ArtifactDescriptor>? = null,
        operationIdOverride: String? = null,
    ): DriveV2PreflightSnapshot {
        val preflight = fixture("preflight.json")
        val interrupted = fixture("interrupted-transaction.json")
        val workspaceId = preflight.text("workspaceId")
        val roots = listOf(preflight.objectValue("root").workspaceItem())
        val folders = preflight.arrayValue("managedFolders").map { it.jsonObject.workspaceItem() }
        val folderIds = folders.associate { it.name to it.driveFileId }
        val artifacts = buildList {
            interrupted.arrayValue("blobs").forEach { add(it.jsonObject.remoteArtifact("blob")) }
            interrupted.arrayValue("objects").forEach { add(it.jsonObject.remoteArtifact("object")) }
            interrupted.arrayValue("commits").forEach { add(it.jsonObject.remoteArtifact("commit")) }
        }
        val descriptors = plannedDescriptors?.sortedBy { it.canonicalId }
            ?: artifacts.map(DriveV2RemoteArtifact::descriptor).sortedBy { it.canonicalId }
        val operationId = operationIdOverride ?: preflight.text("operationId")
        val rootId = preflight.text("savedRootDriveFileId")
        val journal = DriveV2OperationJournal(
            accountId,
            rootId,
            workspaceId,
            operationId,
            folderIds,
            descriptors,
        )
        return DriveV2PreflightSnapshot(
            currentAccountId = accountId,
            currentSavedRootDriveFileId = rootId,
            currentWorkspaceId = workspaceId,
            currentOperationId = operationId,
            currentManagedFolderIds = folderIds,
            currentArtifactDescriptors = descriptors,
            journal = journal,
            roots = roots,
            folders = folders,
            artifacts = artifacts,
        )
    }

    private fun createTransaction(): DriveV2CreateTransaction {
        val fixture = fixture("interrupted-transaction.json")
        val workspaceId = fixture.text("workspaceId")
        val remoteArtifacts = buildList {
            fixture.arrayValue("blobs").forEach { add(it.jsonObject.remoteArtifact("blob")) }
            fixture.arrayValue("objects").forEach { add(it.jsonObject.remoteArtifact("object")) }
            add(fixture.arrayValue("commits").first().jsonObject.remoteArtifact("commit"))
        }
        fun DriveV2RemoteArtifact.createArtifact() = DriveV2CreateArtifact(
            kind = kind,
            generatedDriveFileId = driveFileId,
            parentFolderDriveFileId = parentFolderDriveFileId,
            canonicalId = expectedId,
            path = path,
            mimeType = mimeType,
            bytes = bytes,
            appProperties = DriveV2Contract.appProperties(workspaceId, kind, expectedId, expectedContentSha256),
        )
        val blobs = remoteArtifacts.filter { it.kind == "blob" }.map { it.createArtifact() }
        val objects = remoteArtifacts.filter { it.kind == "object" }.map { it.createArtifact() }.sortedBy { it.path }
        val commit = remoteArtifacts.single { it.kind == "commit" }.createArtifact()
        val operationId = "op-v2-interrupted-genesis"
        val readiness = DriveV2Preflight.validateBeforePlan(
            buildPreflight(
                plannedDescriptors = (blobs + objects + commit).map(DriveV2CreateArtifact::descriptor),
                operationIdOverride = operationId,
            ),
        )
        return DriveV2CreateTransaction(
            readiness = readiness,
            blobs = blobs,
            objects = objects,
            commit = commit,
        )
    }

    private fun DriveV2CreateArtifact.receipt() = DriveV2CreateReceipt(
        driveFileId = generatedDriveFileId,
        parentFolderDriveFileId = parentFolderDriveFileId,
        path = path,
        canonicalId = canonicalId,
        contentSha256 = contentSha256,
        mimeType = mimeType,
        appProperties = appProperties,
        byteCount = bytes.size.toLong(),
        trashed = false,
        stableSecondRead = true,
    )

    private fun objectBody(
        workspaceId: String,
        kind: String,
        id: String,
        payload: JsonObject,
    ) = buildJsonObject {
        put("protocol", DriveV2Contract.PROTOCOL)
        put("schemaVersion", 2)
        put("workspaceId", workspaceId)
        put("entityKind", kind)
        put("entityId", id)
        put("operation", "upsert")
        put("baseObjectIds", JsonArray(emptyList()))
        put("blobIds", JsonArray(emptyList()))
        put("payload", payload)
        put("tombstone", JsonNull)
        put("resolutionOf", JsonArray(emptyList()))
    }

    private fun commitBody(
        workspaceId: String,
        operationId: String,
        objectIds: List<String>,
        blobIds: List<String> = emptyList(),
    ) = buildJsonObject {
        put("protocol", DriveV2Contract.PROTOCOL)
        put("schemaVersion", 2)
        put("workspaceId", workspaceId)
        put("operationId", operationId)
        put("createdAt", "2026-08-09T13:00:00.000Z")
        put("parentCommitIds", JsonArray(emptyList()))
        put("objectIds", buildJsonArray { objectIds.sorted().forEach { add(JsonPrimitive(it)) } })
        put("blobIds", buildJsonArray { blobIds.sorted().forEach { add(JsonPrimitive(it)) } })
    }

    private fun objectRecord(body: JsonObject) = DriveV2ObjectRecord(DriveV2Contract.objectId(body), body)
    private fun commitRecord(body: JsonObject) = DriveV2CommitRecord(DriveV2Contract.commitId(body), body)

    private fun JsonObject.remoteArtifact(kind: String): DriveV2RemoteArtifact {
        val bytes = when (kind) {
            "blob" -> Base64.getDecoder().decode(text("bytesBase64"))
            else -> Base64.getDecoder().decode(text("downloadedBytesBase64"))
        }
        return DriveV2RemoteArtifact(
            kind = kind,
            driveFileId = text("driveFileId"),
            parentFolderDriveFileId = text("parentFolderDriveFileId"),
            path = text("path"),
            mimeType = text("mimeType"),
            byteCount = longValue("byteCount"),
            expectedId = text("expectedId"),
            expectedContentSha256 = text("expectedContentSha256"),
            appProperties = objectValue("appProperties").mapValues { it.value.jsonPrimitive.content },
            bytes = bytes,
        )
    }

    private fun DriveV2RemoteArtifact.withDriveFileId(value: String) = DriveV2RemoteArtifact(
        kind,
        value,
        parentFolderDriveFileId,
        path,
        mimeType,
        byteCount,
        expectedId,
        expectedContentSha256,
        appProperties,
        bytes,
    )

    private fun DriveV2RemoteArtifact.withBytes(value: ByteArray): DriveV2RemoteArtifact {
        val digest = DriveV2CanonicalJson.sha256(value)
        val workspaceId = appProperties.getValue("easylabWorkspaceId")
        return DriveV2RemoteArtifact(
            kind,
            driveFileId,
            parentFolderDriveFileId,
            path,
            mimeType,
            value.size.toLong(),
            expectedId,
            digest,
            DriveV2Contract.appProperties(workspaceId, kind, expectedId, digest),
            value,
        )
    }

    private fun JsonObject.workspaceItem() = DriveV2WorkspaceItem(
        driveFileId = text("driveFileId"),
        name = text("name"),
        parentIds = stringList("parentIds"),
        mimeType = text("mimeType"),
        trashed = booleanValue("trashed"),
        appProperties = objectValue("appProperties").mapValues { it.value.jsonPrimitive.content },
    )

    private fun JsonObject.objects(name: String): List<DriveV2ObjectRecord> = arrayValue(name).map {
        val record = it.jsonObject
        DriveV2ObjectRecord(record.text("expectedId"), record.objectValue("body"))
    }

    private fun JsonObject.commits(name: String): List<DriveV2CommitRecord> = arrayValue(name).map {
        val record = it.jsonObject
        DriveV2CommitRecord(record.text("expectedId"), record.objectValue("body"))
    }

    private fun fixture(name: String): JsonObject =
        json.parseToJsonElement(repositoryFile("contracts/drive-v2-append-only/$name").readText()).jsonObject

    private fun repositoryFile(path: String): File = sequenceOf(
        File(path),
        File("../$path"),
        File("../../$path"),
    ).firstOrNull(File::isFile) ?: error("Could not locate shared fixture: $path")

    private fun assertCode(expected: String, action: () -> Unit) {
        val error = assertThrows(DriveV2ContractException::class.java, action)
        assertEquals(expected, error.code)
    }

    private fun JsonObject.text(name: String): String =
        getValue(name).jsonPrimitive.contentOrNull ?: error("$name must be text")

    private fun JsonObject.objectValue(name: String): JsonObject = getValue(name).jsonObject
    private fun JsonObject.arrayValue(name: String): JsonArray = getValue(name).jsonArray
    private fun JsonObject.stringList(name: String): List<String> = arrayValue(name).map { it.jsonPrimitive.content }
    private fun JsonObject.longValue(name: String): Long = getValue(name).jsonPrimitive.long
    private fun JsonObject.booleanValue(name: String): Boolean = getValue(name).jsonPrimitive.content.toBooleanStrict()
}
