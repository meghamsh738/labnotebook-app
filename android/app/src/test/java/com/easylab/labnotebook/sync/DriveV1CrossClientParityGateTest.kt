package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.SyncQueueEntity
import java.io.File
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveV1CrossClientParityGateTest {
    private val json = DriveV1Json.format

    @Test
    fun sharedPolicyKeepsRemoteWritesBlockedAndRequiresVersionedCas() {
        val policy = fixture("policy.json")
        val remoteVersion = policy.objectValue("remoteVersion")
        val deletions = policy.objectValue("deletions")
        val runtimeParity = policy.objectValue("runtimeParity")

        assertEquals(1L, policy.longValue("gateVersion"))
        assertEquals(1L, policy.longValue("driveContractVersion"))
        assertEquals("disabled-until-runtime-parity", policy.text("writeGate"))
        assertEquals("blocked", runtimeParity.text("status"))
        assertFalse(runtimeParity.booleanValue("nativeDriveWritesAllowed"))
        assertEquals(
            setOf("live-versioned-cas-validation"),
            runtimeParity.arrayValue("blockingIssueIds").mapTo(hashSetOf()) {
                it.jsonPrimitive.content
            },
        )
        assertEquals(
            setOf(
                "android-unique-entry-path",
                "android-data-thumbnail",
                "tombstone-target-normalization",
                "web-filebox-transfer-cascade",
                "malformed-json-quarantine",
                "web-payload-projection",
                "native-idempotent-create-only",
                "web-versioned-cas",
            ),
            runtimeParity.arrayValue("resolvedIssueIds").mapTo(hashSetOf()) {
                it.jsonPrimitive.content
            },
        )
        assertEquals(
            listOf("fileId", "version"),
            remoteVersion.arrayValue("existingRequires").map { it.jsonPrimitive.content },
        )
        assertEquals(1L, remoteVersion.longValue("minimumVersion"))
        assertTrue(remoteVersion.booleanValue("freshEtagBeforeMutation"))
        assertEquals("implemented-offline-unwired", remoteVersion.text("webVersionedCas"))
        assertFalse(remoteVersion.booleanValue("liveVersionedCasValidationPerformed"))
        assertEquals("blocked-without-tombstone", remoteVersion.text("missingWithBase"))
        assertEquals("idempotent-create-only-offline", remoteVersion.text("conditionalCreate"))
        assertEquals("parent-transitively-suppresses-descendants", deletions.text("cascade"))
        assertEquals("accepted-not-required", deletions.text("explicitChildTombstones"))
        assertFalse(deletions.booleanValue("physicalDriveDeletion"))
        assertTrue(deletions.booleanValue("nonResurrection"))
    }

    @Test
    fun conditionalCreateFixtureSeparatesMultipartAndRecoverableResumableModes() {
        val fixture = fixture("conditional-create.json")
        val modes = fixture.objectValue("uploadModes")
        val multipart = modes.objectValue("boundedMultipart")
        val resumable = modes.objectValue("resumable")

        assertEquals(5L * 1024 * 1024, multipart.longValue("maximumExclusiveBytes"))
        assertEquals("multipart-post", multipart.text("method"))
        assertFalse(multipart.booleanValue("generatedFileIdRequired"))
        assertEquals(5L * 1024 * 1024, resumable.longValue("minimumInclusiveBytes"))
        assertEquals("resumable-post", resumable.text("method"))
        assertTrue(resumable.booleanValue("generatedFileIdRequired"))
        assertTrue(resumable.booleanValue("persistBeforeContentTransfer"))
        assertEquals("parent-folder-etag-cas", resumable.text("pathReservation"))
        assertEquals("canonical-path-hash", resumable.text("reservationScope"))
        assertEquals(
            "adopt-exact-generated-id-and-fingerprint",
            resumable.text("independentRecovery"),
        )
    }

    @Test
    fun malformedRemoteJsonHasOneDeterministicQuarantineIdentity() {
        val case = fixture("malformed-json.json")
        val expected = case.objectValue("expected")
        val error = runCatching {
            json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(case.text("remoteDocumentText"))
        }.exceptionOrNull()

        assertTrue(error != null)
        assertEquals(
            "conf-invalid-${case.text("entityKind")}-${case.text("remotePath")}",
            expected.text("conflictId"),
        )
        assertEquals("quarantine-conflict", expected.text("decision"))
        assertEquals("pending", expected.text("resolution"))
        assertFalse(expected.booleanValue("remoteWriteAllowed"))
        assertEquals("resolved", expected.text("runtimeParity"))
        assertEquals("malformed-json-quarantine", expected.text("resolvedIssueId"))
    }

    @Test
    fun missingRemoteWithBaselineBlocksAndRetainsExactMustMatchIdentity() {
        val case = fixture("missing-record.json")
        val baseline = case.objectValue("baseline")
        val expected = case.objectValue("expected")
        val base = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(
            driveV1Fixture("entries/2026-05-23.json").readText(),
        ).requireV1("entry").payload

        val decision = DriveV1ThreeWayPlanner.planEntry(
            DriveV1ThreeWayState.Present(base),
            DriveV1ThreeWayState.Present(base),
            DriveV1ThreeWayState.Missing,
        )
        val expectedPrecondition = expected.objectValue("precondition")
        val precondition = DriveWritePrecondition.MustMatch(
            fileId = baseline.text("fileId"),
            version = baseline.longValue("version"),
        )

        assertEquals(DriveV1ThreeWayDecision.Blocked(expected.text("reason")), decision)
        assertEquals("must-match", expectedPrecondition.text("kind"))
        assertEquals(expectedPrecondition.text("fileId"), precondition.fileId)
        assertEquals(expectedPrecondition.longValue("version"), precondition.version)
        assertFalse(expected.booleanValue("remoteWriteAllowed"))
    }

    @Test
    fun deleteEditRaceCreatesTheLockedPendingConflictShape() {
        val case = fixture("delete-edit-race.json")
        val base = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(
            driveV1Fixture("attachments/2026-05-23/att-contract-result.csv.json").readText(),
        ).requireV1("attachment").payload
        val local = base.copy(filename = case.objectValue("localValue").text("filename"))
        val tombstone = json.decodeFromString<DriveV1Tombstone>(
            case.objectValue("remoteTombstone").toString(),
        ).requireV1()
        val decision = DriveV1ThreeWayPlanner.planAttachment(
            DriveV1ThreeWayState.Present(base),
            DriveV1ThreeWayState.Present(local),
            DriveV1ThreeWayState.Tombstone(tombstone),
        )
        val conflict = json.decodeFromString<DriveV1Conflict>(
            case.objectValue("expectedConflict").toString(),
        ).requireV1()

        assertEquals(case.text("baseHash"), DriveV1Hashing.attachmentMetadataHash(base))
        assertEquals(case.text("localHash"), DriveV1Hashing.attachmentMetadataHash(local))
        assertEquals(
            DriveV1ThreeWayDecision.Conflict("Remote deletion conflicts with a changed local attachment."),
            decision,
        )
        assertEquals("conf-${case.text("entityKind")}-${case.text("entityId")}", conflict.id)
        assertEquals("pending", conflict.resolution)
        assertEquals(DriveV1Paths.conflict(conflict.id), "conflicts/conf-attachment-att-contract.json")
        assertEquals(case.objectValue("remoteTombstone"), conflict.remoteCopy?.jsonObject?.get("tombstone"))
        assertFalse(case.objectValue("expected").booleanValue("remoteWriteAllowed"))
    }

    @Test
    fun equalTombstoneTargetsUseTimeThenBlockEqualInstantDivergence() {
        val case = fixture("equal-targets.json")
        val candidates = case.arrayValue("candidates").map {
            json.decodeFromString<DriveV1Tombstone>(it.toString()).requireV1()
        }
        val newest = candidates.maxWith { left, right ->
            compareIsoTimestamps(left.deletedAt, right.deletedAt)
        }
        val expected = case.objectValue("expected")
        val expectedCanonical = json.decodeFromString<DriveV1Tombstone>(
            expected.objectValue("canonical").toString(),
        ).requireV1()
        val divergent = case.arrayValue("equalInstantDivergence").map {
            json.decodeFromString<DriveV1Tombstone>(it.toString()).requireV1()
        }

        assertEquals(expectedCanonical.deletedAt, newest.deletedAt)
        assertEquals(expectedCanonical.deletedByDeviceId, newest.deletedByDeviceId)
        assertNotEquals(expectedCanonical.id, newest.id)
        assertEquals(
            DriveV1Paths.tombstone(expectedCanonical.entityKind, expectedCanonical.entityId),
            expected.text("drivePath"),
        )
        assertEquals(divergent[0].deletedAt, divergent[1].deletedAt)
        assertNotEquals(divergent[0].deletedByDeviceId, divergent[1].deletedByDeviceId)
        assertEquals("blocked", expected.text("equalInstantDecision"))
        assertEquals("resolved", expected.text("runtimeParity"))
        assertEquals("tombstone-target-normalization", expected.text("resolvedIssueId"))
        assertEquals(expectedCanonical.id, expected.text("observedNativeCreatedId"))
    }

    @Test
    fun parentTombstoneTransitivelySuppressesAllDescendants() {
        val case = fixture("non-resurrection.json")
        val graph = case.objectValue("liveGraph")
        val tombstones = case.arrayValue("tombstones").map {
            json.decodeFromString<DriveV1Tombstone>(it.toString()).requireV1()
        }
        val deletedEntries = tombstones
            .filter { it.entityKind == "entry" }
            .mapTo(mutableSetOf()) { it.entityId }
        val deletedAttachments = tombstones
            .filter { it.entityKind == "attachment" }
            .mapTo(mutableSetOf()) { it.entityId }
        val deletedFileBoxItems = tombstones
            .filter { it.entityKind == "fileBoxItem" }
            .mapTo(mutableSetOf()) { it.entityId }
        val deletedTransfers = tombstones
            .filter { it.entityKind == "transfer" }
            .mapTo(mutableSetOf()) { it.entityId }

        graph.arrayValue("attachments").map { it.jsonObject }.forEach { attachment ->
            if (attachment.text("entryId") in deletedEntries) deletedAttachments += attachment.text("id")
        }
        graph.arrayValue("fileBoxItems").map { it.jsonObject }.forEach { item ->
            if (
                item.optionalText("entryId") in deletedEntries ||
                item.optionalText("attachmentId") in deletedAttachments
            ) {
                deletedFileBoxItems += item.text("id")
            }
        }
        graph.arrayValue("transfers").map { it.jsonObject }.forEach { transfer ->
            if (
                transfer.optionalText("entryId") in deletedEntries ||
                transfer.optionalText("attachmentId") in deletedAttachments ||
                transfer.optionalText("fileBoxItemId") in deletedFileBoxItems
            ) {
                deletedTransfers += transfer.text("id")
            }
        }
        val effectiveTargets = buildList {
            deletedAttachments.forEach { add("attachment:$it") }
            deletedEntries.forEach { add("entry:$it") }
            deletedFileBoxItems.forEach { add("fileBoxItem:$it") }
            deletedTransfers.forEach { add("transfer:$it") }
        }.sorted()
        val expected = case.objectValue("expected")

        assertEquals(
            expected.arrayValue("effectiveDeletedTargets").map { it.jsonPrimitive.content },
            effectiveTargets,
        )
        assertEquals(emptyList<String>(), expected.arrayValue("remainingLiveTargets").map { it.jsonPrimitive.content })
        assertFalse(expected.booleanValue("explicitChildTombstonesRequired"))
        assertTrue(expected.booleanValue("legacyChildTombstonesAccepted"))
        assertTrue(expected.booleanValue("staleRemoteRecordsIgnored"))
        assertTrue(tombstones.any { it.id.startsWith("delete-") })
        assertEquals("resolved", expected.text("runtimeParity"))
        assertEquals("web-filebox-transfer-cascade", expected.text("resolvedIssueId"))
    }

    @Test
    fun stagedAndroidWebElectronAndroidRoundTripLocksCrossClientOutputs() {
        val case = fixture("offline-round-trip.json")
        val origin = case.objectValue("androidOrigin")
        val webEdit = case.objectValue("webEdit")
        val electronDelete = case.objectValue("electronDelete")
        val androidReturn = case.objectValue("androidReturn")
        val entryEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(
            driveV1Fixture(origin.text("entryFixture")).readText(),
        ).requireV1("entry")
        val attachmentEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(
            driveV1Fixture(origin.text("attachmentFixture")).readText(),
        ).requireV1("attachment")
        val fileBoxEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(
            driveV1Fixture("filebox/filebox-contract.json").readText(),
        ).requireV1("fileBoxItem")
        val transferEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(
            driveV1Fixture("transfers/transfer-contract.json").readText(),
        ).requireV1("transfer")
        val device = json.decodeFromString<DriveV1Device>(
            driveV1Fixture("devices/dev-contract.json").readText(),
        ).requireV1()
        val originManifest = json.decodeFromString<DriveV1Manifest>(
            driveV1Fixture("manifest.json").readText(),
        ).requireV1()

        assertFalse(case.booleanValue("liveDriveUsed"))
        assertFalse(case.booleanValue("productionWritesEnabled"))
        assertEquals(
            origin.text("entryPath"),
            DriveV1Paths.entry(entryEnvelope.payload, mapOf(entryEnvelope.id to entryEnvelope.payload)),
        )
        assertEquals(
            origin.text("attachmentBlobPath"),
            DriveV1Paths.attachmentBlob(attachmentEnvelope.payload, entryEnvelope.payload),
        )
        assertEquals(
            origin.text("attachmentMetadataPath"),
            DriveV1Paths.attachmentMetadata(attachmentEnvelope.payload, entryEnvelope.payload),
        )
        assertEquals(origin.text("entryContentHash"), DriveV1Hashing.entryContentHash(entryEnvelope.payload))
        assertEquals(
            origin.text("attachmentMetadataHash"),
            DriveV1Hashing.attachmentMetadataHash(attachmentEnvelope.payload),
        )
        val originCounts = origin.objectValue("manifestCounts")
        assertEquals(originCounts.longValue("entryCount"), originManifest.entryCount.toLong())
        assertEquals(originCounts.longValue("attachmentCount"), originManifest.attachmentCount.toLong())
        assertEquals(originCounts.longValue("fileBoxCount"), originManifest.fileBoxCount.toLong())
        assertEquals(originCounts.longValue("transferCount"), originManifest.transferCount.toLong())

        val webEditedEntry = entryEnvelope.payload.copy(
            title = webEdit.text("title"),
            lastEditedDatetime = webEdit.text("updatedAt"),
            updatedByDeviceId = webEdit.text("updatedByDeviceId"),
        ).requireV1()
        assertEquals(webEdit.text("entryContentHash"), DriveV1Hashing.entryContentHash(webEditedEntry))
        assertEquals(origin.text("entryPath"), webEdit.text("path"))
        assertTrue(webEdit.booleanValue("verifiedExistingPathPreserved"))
        assertEquals("must-match", webEdit.objectValue("precondition").text("kind"))
        assertEquals(webEdit.text("fileId"), webEdit.objectValue("precondition").text("fileId"))
        assertEquals(webEdit.longValue("version"), webEdit.objectValue("precondition").longValue("version"))

        val tombstone = json.decodeFromString<DriveV1Tombstone>(electronDelete.toString()).requireV1()
        assertEquals("del-${tombstone.entityKind}-${tombstone.entityId}", tombstone.id)
        assertEquals(
            electronDelete.text("path"),
            DriveV1Paths.tombstone(tombstone.entityKind, tombstone.entityId),
        )
        assertFalse(electronDelete.booleanValue("physicalDriveDeletion"))
        val expectedConflict = case.objectValue("canonicalConflict")
        assertEquals(expectedConflict.text("path"), DriveV1Paths.conflict(expectedConflict.text("id")))

        val deletedEntries = mutableSetOf(tombstone.entityId)
        val deletedAttachments = mutableSetOf<String>()
        val deletedFileBoxItems = mutableSetOf<String>()
        val deletedTransfers = mutableSetOf<String>()
        if (attachmentEnvelope.payload.entryId in deletedEntries) {
            deletedAttachments += attachmentEnvelope.id
        }
        if (
            fileBoxEnvelope.payload.entryId in deletedEntries ||
            fileBoxEnvelope.payload.attachmentId in deletedAttachments
        ) {
            deletedFileBoxItems += fileBoxEnvelope.id
        }
        if (
            transferEnvelope.payload.entryId in deletedEntries ||
            transferEnvelope.payload.attachmentId in deletedAttachments ||
            transferEnvelope.payload.fileBoxItemId in deletedFileBoxItems
        ) {
            deletedTransfers += transferEnvelope.id
        }
        val effectiveTargets = buildList {
            deletedAttachments.forEach { add("attachment:$it") }
            deletedEntries.forEach { add("entry:$it") }
            deletedFileBoxItems.forEach { add("fileBoxItem:$it") }
            deletedTransfers.forEach { add("transfer:$it") }
        }.sorted()
        assertEquals(
            androidReturn.arrayValue("effectiveDeletedTargets").map { it.jsonPrimitive.content },
            effectiveTargets,
        )
        assertEquals(emptyList<String>(), androidReturn.arrayValue("visibleEntryIds").map { it.jsonPrimitive.content })
        assertEquals(emptyList<String>(), androidReturn.arrayValue("visibleAttachmentIds").map { it.jsonPrimitive.content })
        assertEquals(emptyList<String>(), androidReturn.arrayValue("visibleFileBoxIds").map { it.jsonPrimitive.content })
        assertEquals(emptyList<String>(), androidReturn.arrayValue("visibleTransferIds").map { it.jsonPrimitive.content })
        assertFalse(androidReturn.booleanValue("staleLiveRecordsResurrect"))

        val finalCounts = androidReturn.objectValue("finalManifestCounts")
        val manifestDocument = DriveV1LocalSerializer.serializeManifestProjection(
            accountId = AccountId("account-parity-round-trip"),
            updatedAt = "2026-05-23T11:05:00.000Z",
            projection = DriveV1ManifestProjection(
                devices = listOf(device),
                entryCount = 0,
                attachmentCount = 0,
                fileBoxCount = 0,
                transferCount = 0,
            ),
            createdAt = "2026-05-23T08:00:00.000Z",
        )
        val manifest = json.decodeFromString<DriveV1Manifest>(manifestDocument.json).requireV1()
        assertEquals(finalCounts.longValue("entryCount"), manifest.entryCount.toLong())
        assertEquals(finalCounts.longValue("attachmentCount"), manifest.attachmentCount.toLong())
        assertEquals(finalCounts.longValue("fileBoxCount"), manifest.fileBoxCount.toLong())
        assertEquals(finalCounts.longValue("transferCount"), manifest.transferCount.toLong())

        val projection = case.objectValue("payloadProjection")
        val unknown = projection.objectValue("unknownField")
        val rawEntryObject = json.parseToJsonElement(
            driveV1Fixture(origin.text("entryFixture")).readText(),
        ).jsonObject
        val rawPayload = rawEntryObject.getValue("payload").jsonObject
        val rawWithUnknown = JsonObject(
            rawEntryObject + ("payload" to JsonObject(rawPayload + (unknown.text("key") to unknown.getValue("value")))),
        )
        val lossless = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Entry>>(rawWithUnknown.toString())
        lossless.value = lossless.value.copy(payload = webEditedEntry)
        val preservedPayload = json.parseToJsonElement(lossless.encodePreservingUnknownFields())
            .jsonObject.getValue("payload").jsonObject
        assertEquals(unknown.getValue("value"), preservedPayload[unknown.text("key")])
        assertTrue(unknown.booleanValue("preserved"))
        assertFalse(projection.booleanValue("localOnlyFieldsPublished"))

        val scenarios = case.objectValue("transactionScenarios")
        assertEquals("exact-reconciliation-no-duplicate", scenarios.objectValue("smallCreateOnlyRetry").text("expected"))
        assertEquals("same-operation-id-no-duplicate", scenarios.objectValue("largeResumableCreate").text("expected"))
        assertEquals("same-operation-id-conditional-update", scenarios.objectValue("largeResumableUpdate").text("expected"))
        assertEquals("repair-only-known-plan-paths-manifest-last", scenarios.objectValue("partialPrerequisitesWithOldManifest").text("expected"))
        assertEquals("blocked-before-mutation", scenarios.objectValue("duplicatePathsOrFolders").text("expected"))
        assertEquals("operation-and-cache-inaccessible-cross-account", scenarios.objectValue("accountIsolation").text("expected"))
    }

    @Test
    fun canonicalPathsAndPayloadsExposeRuntimeBlockersWithoutAuthorizingWrites() {
        val case = fixture("canonicalization.json")
        val unique = case.objectValue("uniqueEntry")
        val collision = case.objectValue("sameDayCollision")
        val rename = case.objectValue("existingAttachmentRename")
        val accountId = AccountId("account-parity")
        val updatedAt = "2026-05-24T10:00:00.000Z"
        val entry = JournalEntryEntity(
            accountId = accountId.value,
            id = unique.text("entityId"),
            title = "Parity",
            dateBucket = unique.text("dateBucket"),
            createdAt = updatedAt,
            updatedAt = updatedAt,
            authorId = "researcher",
            updatedByDeviceId = "dev-parity",
            syncStatus = "queued",
            syncPath = case.objectValue("entryPayload").objectValue("input").text("syncPath"),
        )
        val entryQueue = queue(accountId, "entry", entry.id, updatedAt)
        val uniqueDocument = DriveV1LocalSerializer.serializeEntry(
            accountId,
            entry,
            entryQueue,
            unique.text("expectedPath"),
            newEntryPathSelection = DriveV1NewEntryPathSelection.fromCompleteSameDayInventory(
                entityId = entry.id,
                dateBucket = entry.dateBucket,
                sameDayEntityIds = listOf(entry.id),
            ),
        )
        val uniqueEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(
            uniqueDocument.json,
        )
        assertEquals(unique.text("expectedPath"), DriveV1Paths.entry(unique.text("dateBucket")))
        assertEquals(unique.text("expectedPath"), uniqueDocument.path)
        assertEquals("resolved", unique.text("runtimeParity"))
        assertEquals("android-unique-entry-path", unique.text("resolvedIssueId"))
        assertNull(uniqueEnvelope.payload.syncPath)
        assertEquals(
            collision.text("expectedPath"),
            DriveV1Paths.entry(collision.text("dateBucket"), collision.text("entityId")),
        )
        assertEquals(rename.text("verifiedPath"), rename.text("expectedPath"))
        assertFalse(rename.booleanValue("runtimeWriteAllowedUntilPathParity"))

        val attachmentCase = case.objectValue("attachmentPayload")
        val attachment = AttachmentEntity(
            accountId = accountId.value,
            id = attachmentCase.objectValue("input").text("id"),
            entryId = entry.id,
            type = "image",
            filename = attachmentCase.objectValue("input").text("filename"),
            displaySize = "1 KB",
            storagePath = "/private/native/canonical.png",
            syncStatus = "queued",
            createdAt = updatedAt,
            updatedAt = updatedAt,
            thumbnail = attachmentCase.objectValue("input").text("thumbnail"),
            cachedPath = attachmentCase.objectValue("input").text("cachedPath"),
            cacheKey = attachmentCase.objectValue("input").text("cacheKey"),
        )
        val attachmentDocument = DriveV1LocalSerializer.serializeAttachment(
            accountId,
            attachment,
            entry,
            queue(accountId, "attachment", attachment.id, updatedAt),
        )
        val attachmentEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(
            attachmentDocument.json,
        )
        assertNull(attachmentEnvelope.payload.cachedPath)
        assertNull(attachmentEnvelope.payload.cacheKey)
        assertNull(attachmentEnvelope.payload.thumbnail)
        assertEquals("resolved", attachmentCase.text("runtimeParity"))
        assertEquals("android-data-thumbnail", attachmentCase.text("resolvedIssueId"))

        val fileBoxCase = case.objectValue("fileBoxPayload")
        val fileBoxItem = FileBoxItemEntity(
            accountId = accountId.value,
            id = fileBoxCase.objectValue("input").text("id"),
            entryId = entry.id,
            filename = "canonical.csv",
            filesize = "1 KB",
            sourceDeviceId = "dev-parity",
            sourceDeviceName = "Pixel",
            status = "available",
            createdAt = updatedAt,
            updatedAt = updatedAt,
            localObjectUrl = fileBoxCase.objectValue("input").text("localObjectUrl"),
        )
        val fileBoxDocument = DriveV1LocalSerializer.serializeFileBoxItem(
            accountId,
            fileBoxItem,
            queue(accountId, "fileBoxItem", fileBoxItem.id, updatedAt),
        )
        val fileBoxEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(
            fileBoxDocument.json,
        )
        assertNull(fileBoxEnvelope.payload.localObjectUrl)
        assertEquals("resolved", fileBoxCase.text("webRuntimeParity"))
        assertEquals("web-payload-projection", fileBoxCase.text("resolvedIssueId"))
    }

    private fun queue(
        accountId: AccountId,
        entityKind: String,
        entityId: String,
        updatedAt: String,
    ) = SyncQueueEntity(
        accountId = accountId.value,
        id = "queue-$entityKind-$entityId",
        entityKind = entityKind,
        entityId = entityId,
        operation = "upsert",
        status = "queued",
        queuedAt = updatedAt,
        updatedAt = updatedAt,
        updatedByDeviceId = "dev-parity",
    )

    private fun fixture(name: String): JsonObject =
        json.parseToJsonElement(parityFixture(name).readText()).jsonObject

    private fun parityFixture(name: String): File = repositoryFile("contracts/drive-v1-parity/$name")

    private fun driveV1Fixture(name: String): File = repositoryFile("contracts/drive-v1/$name")

    private fun repositoryFile(path: String): File = sequenceOf(
        File(path),
        File("../$path"),
        File("../../$path"),
    ).firstOrNull(File::isFile) ?: error("Could not locate shared fixture: $path")

    private fun JsonObject.text(name: String): String =
        getValue(name).jsonPrimitive.contentOrNull ?: error("$name must be text.")

    private fun JsonObject.optionalText(name: String): String? =
        get(name)?.jsonPrimitive?.contentOrNull

    private fun JsonObject.longValue(name: String): Long = getValue(name).jsonPrimitive.long

    private fun JsonObject.booleanValue(name: String): Boolean =
        getValue(name).jsonPrimitive.content.toBooleanStrict()

    private fun JsonObject.objectValue(name: String): JsonObject = getValue(name).jsonObject

    private fun JsonObject.arrayValue(name: String): JsonArray = getValue(name).jsonArray
}
