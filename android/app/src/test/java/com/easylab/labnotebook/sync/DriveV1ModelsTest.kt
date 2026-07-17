package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import com.easylab.labnotebook.data.repository.NativeDriveRepositorySkeleton
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveV1ModelsTest {
    private val json = DriveV1Json.format

    private fun fixture(path: String): String =
        checkNotNull(javaClass.classLoader?.getResource("drive-v1/$path")) { "Missing fixture $path" }.readText()

    @Test
    fun everyGoldenFixtureValidatesAndRoundTrips() {
        val manifest = json.decodeFromString<DriveV1Manifest>(fixture("manifest.json")).requireV1()
        assertEquals(manifest, json.decodeFromString<DriveV1Manifest>(json.encodeToString(manifest)))
        val device = json.decodeFromString<DriveV1Device>(fixture("devices/dev-contract.json")).requireV1()
        assertEquals(device, json.decodeFromString<DriveV1Device>(json.encodeToString(device)))

        val entry = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(fixture("entries/2026-05-23.json")).requireV1("entry")
        assertEquals(entry, json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(json.encodeToString(entry)))
        val attachment = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(
            fixture("attachments/2026-05-23/att-contract-result.csv.json"),
        ).requireV1("attachment")
        assertEquals(attachment, json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(json.encodeToString(attachment)))
        val fileBox = json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(
            fixture("filebox/filebox-contract.json"),
        ).requireV1("fileBoxItem")
        assertEquals(fileBox, json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(json.encodeToString(fileBox)))
        val transfer = json.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(
            fixture("transfers/transfer-contract.json"),
        ).requireV1("transfer")
        assertEquals(transfer, json.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(json.encodeToString(transfer)))

        val conflict = json.decodeFromString<DriveV1Conflict>(
            fixture("conflicts/conf-entry-entry-contract.json"),
        ).requireV1()
        assertEquals(conflict, json.decodeFromString<DriveV1Conflict>(json.encodeToString(conflict)))
        val tombstone = json.decodeFromString<DriveV1Tombstone>(
            fixture("tombstones/attachment--att-deleted.json"),
        ).requireV1()
        assertEquals(tombstone, json.decodeFromString<DriveV1Tombstone>(json.encodeToString(tombstone)))
    }

    @Test
    fun losslessEnvelopePreservesUnknownEnvelopeAndPayloadFields() {
        val source = DriveV1Envelope(
            id = "entry-1",
            kind = "entry",
            version = 1,
            updatedAt = "2026-07-15T10:00:00Z",
            updatedByDeviceId = "pixel-1",
            payload = DriveV1Entry(
                id = "entry-1",
                createdDatetime = "2026-07-15T09:00:00Z",
                lastEditedDatetime = "2026-07-15T10:00:00Z",
                authorId = "subject-1",
                title = "Microglia treatment",
                dateBucket = "2026-07-15",
                content = emptyList(),
                tags = listOf("microglia", "dose-response"),
                searchTerms = emptyList(),
                linkedFiles = emptyList(),
                pinnedRegions = emptyList(),
            ),
        )

        val encoded = json.encodeToString(source)
            .replace("\"payload\":{", "\"payload\":{\"futurePayload\":{\"nested\":true},")
            .dropLast(1) + ",\"futureEnvelope\":[1,\"two\"]}"
        val document = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Entry>>(encoded)
        val decoded = document.value.requireV1("entry")

        assertEquals(source, decoded)
        assertEquals(encoded, document.encodePreservingUnknownFields())
        assertTrue(document.rawObject.containsKey("futureEnvelope"))
        assertTrue((document.rawObject["payload"] as kotlinx.serialization.json.JsonObject).containsKey("futurePayload"))

        document.value = decoded.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            payload = decoded.payload.copy(title = "Edited treatment"),
        )
        val edited = json.parseToJsonElement(document.encodePreservingUnknownFields()) as JsonObject
        assertEquals("2026-07-15T11:00:00Z", edited["updatedAt"]?.let { (it as kotlinx.serialization.json.JsonPrimitive).content })
        val editedPayload = edited["payload"] as JsonObject
        assertEquals("Edited treatment", editedPayload["title"]?.let { (it as kotlinx.serialization.json.JsonPrimitive).content })
        assertTrue(edited.containsKey("futureEnvelope"))
        assertTrue(editedPayload.containsKey("futurePayload"))
    }

    @Test
    fun losslessEnvelopeCanonicalizesKnownNullsButPreservesUnknownNulls() {
        val raw = fixture("entries/2026-05-23.json")
            .replace("\"payload\":{", "\"payload\":{\"experimentId\":null,\"futureNull\":null,")
        val document = DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Entry>>(raw)
        document.value = document.value.copy(
            payload = document.value.payload.copy(title = "Edited title"),
        )

        val encoded = json.parseToJsonElement(document.encodePreservingUnknownFields()) as JsonObject
        val payload = encoded.getValue("payload") as JsonObject
        assertFalse(payload.containsKey("experimentId"))
        assertEquals(JsonNull, payload["futureNull"])
        assertEquals("Edited title", (payload.getValue("title") as JsonPrimitive).content)
    }

    @Test
    fun losslessManifestPreservesUnknownNestedFieldsInCorrespondingDeviceArrayElements() {
        val raw = """{
            "version":1,
            "provider":"google-drive",
            "rootFolderName":"Easylab Lab Notebook",
            "createdAt":"2026-07-15T09:00:00Z",
            "updatedAt":"2026-07-15T10:00:00Z",
            "devices":[
                {
                    "id":"pixel-1",
                    "name":"Pixel",
                    "platform":"mobile",
                    "createdAt":"2026-07-15T09:00:00Z",
                    "lastSeenAt":"2026-07-15T10:00:00Z",
                    "futureCapabilities":{"camera":{"formats":["raw",{"name":"heif","future":true}]}}
                },
                {
                    "id":"web-1",
                    "name":"Browser",
                    "platform":"web",
                    "createdAt":"2026-07-15T09:00:00Z",
                    "lastSeenAt":"2026-07-15T10:00:00Z",
                    "futureCapabilities":{"backgroundSync":{"version":2}}
                }
            ],
            "entryCount":0,
            "attachmentCount":0,
            "fileBoxCount":0,
            "transferCount":0
        }""".trimIndent()
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)

        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(
                document.value.devices[1].copy(lastSeenAt = "2026-07-15T11:00:00Z"),
                document.value.devices[0].copy(name = "Pixel 7a"),
            ),
        )

        val edited = json.parseToJsonElement(document.encodePreservingUnknownFields()) as JsonObject
        val devices = edited["devices"] as JsonArray
        assertEquals("web-1", (devices[0] as JsonObject)["id"]?.let { (it as JsonPrimitive).content })
        assertEquals("pixel-1", (devices[1] as JsonObject)["id"]?.let { (it as JsonPrimitive).content })
        assertEquals(
            json.parseToJsonElement("""{"backgroundSync":{"version":2}}"""),
            (devices[0] as JsonObject)["futureCapabilities"],
        )
        assertEquals(
            json.parseToJsonElement("""{"camera":{"formats":["raw",{"name":"heif","future":true}]}}"""),
            (devices[1] as JsonObject)["futureCapabilities"],
        )
        assertEquals("Pixel 7a", (devices[1] as JsonObject)["name"]?.let { (it as JsonPrimitive).content })
    }

    @Test
    fun losslessManifestInsertionDoesNotInheritPositionalUnknownFields() {
        val raw = manifestWithDevices(
            """{"id":"pixel-1","name":"Pixel","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"pixel"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(
                document.value.devices.single().copy(id = "new-device", name = "New device"),
                document.value.devices.single(),
            ),
        )

        val devices = encodedDevices(document)
        assertFalse((devices[0] as JsonObject).containsKey("futureOwner"))
        assertEquals("pixel", (devices[1] as JsonObject)["futureOwner"]?.let { (it as JsonPrimitive).content })
    }

    @Test
    fun losslessManifestInsertedDuplicateIdFailsClosed() {
        val raw = manifestWithDevices(
            """{"id":"pixel-1","name":"Pixel","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"pixel"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        val original = document.value.devices.single()
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(original.copy(name = "Inserted duplicate"), original),
        )

        assertTrue(runCatching { encodedDevices(document) }.isFailure)
    }

    @Test
    fun losslessManifestDuplicateOriginalIdsFailClosed() {
        val raw = manifestWithDevices(
            """{"id":"duplicate","name":"Phone","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"phone"}""",
            """{"id":"duplicate","name":"Browser","platform":"web","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"browser"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = document.value.devices.reversed(),
        )

        assertTrue(runCatching { encodedDevices(document) }.isFailure)
        assertTrue(runCatching { document.value.requireV1() }.isFailure)
    }

    @Test
    fun losslessManifestDuplicateOriginalIdsFailClosedWithoutAnEdit() {
        val raw = manifestWithDevices(
            """{"id":"duplicate","name":"Phone","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z"}""",
            """{"id":"duplicate","name":"Browser","platform":"web","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)

        assertTrue(runCatching { document.encodePreservingUnknownFields() }.isFailure)
    }

    @Test
    fun losslessManifestAmbiguousReusedIdFailsClosed() {
        val raw = manifestWithDevices(
            """{"id":"device-a","name":"Phone","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"a"}""",
            """{"id":"device-b","name":"Browser","platform":"web","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"b"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(document.value.devices[0].copy(id = "device-b")),
        )

        assertTrue(runCatching { encodedDevices(document) }.isFailure)
    }

    @Test
    fun losslessManifestAmbiguousReusedIdWithKnownFieldEditFailsClosed() {
        val raw = manifestWithDevices(
            """{"id":"device-a","name":"Phone","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"a"}""",
            """{"id":"device-b","name":"Browser","platform":"web","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"b"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(
                document.value.devices[0].copy(
                    id = "device-b",
                    name = "Renamed copied phone",
                ),
            ),
        )

        assertTrue(runCatching { encodedDevices(document) }.isFailure)
    }

    @Test
    fun losslessManifestAmbiguousReusedIdTieFailsClosed() {
        val raw = manifestWithDevices(
            """{"id":"device-a","name":"Phone","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"a"}""",
            """{"id":"device-b","name":"Browser","platform":"web","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"b"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(
                document.value.devices[0].copy(
                    id = "device-b",
                    name = "Renamed device",
                    platform = "tablet",
                ),
            ),
        )

        assertTrue(runCatching { encodedDevices(document) }.isFailure)
    }

    @Test
    fun losslessManifestAmbiguousReusedIdWithEqualKnownProjectionFailsClosed() {
        val raw = manifestWithDevices(
            """{"id":"device-a","name":"Shared","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"a"}""",
            """{"id":"device-b","name":"Shared","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"b"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(document.value.devices[0].copy(id = "device-b")),
        )

        assertTrue(runCatching { encodedDevices(document) }.isFailure)
    }

    @Test
    fun losslessManifestMembershipChangeAndExistingEditPreserveUnknownFields() {
        val raw = manifestWithDevices(
            """{"id":"device-a","name":"Phone","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"a"}""",
            """{"id":"device-b","name":"Browser","platform":"web","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"b"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(document.value.devices[1].copy(name = "Renamed browser")),
        )

        val device = encodedDevices(document).single() as JsonObject
        assertEquals("device-b", (device["id"] as JsonPrimitive).content)
        assertEquals("Renamed browser", (device["name"] as JsonPrimitive).content)
        assertEquals("b", (device["futureOwner"] as JsonPrimitive).content)
    }

    @Test
    fun losslessManifestMixedReorderAndInsertionKeepsUnknownFieldsWithStableIds() {
        val raw = manifestWithDevices(
            """{"id":"pixel-1","name":"Pixel","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"pixel"}""",
            """{"id":"web-1","name":"Browser","platform":"web","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"web"}""",
            """{"id":"tablet-1","name":"Tablet","platform":"tablet","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"tablet"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        val original = document.value.devices.associateBy { it.id }
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(
                original.getValue("tablet-1"),
                original.getValue("pixel-1").copy(id = "new-device", name = "New device"),
                original.getValue("web-1"),
                original.getValue("pixel-1"),
            ),
        )

        val devices = encodedDevices(document).map { it as JsonObject }
        assertEquals(listOf("tablet", null, "web", "pixel"), devices.map {
            it["futureOwner"]?.let { owner -> (owner as JsonPrimitive).content }
        })
    }

    @Test
    fun losslessManifestChangedIdDoesNotInheritUnknownFields() {
        val raw = manifestWithDevices(
            """{"id":"pixel-1","name":"Pixel","platform":"mobile","createdAt":"2026-07-15T09:00:00Z","lastSeenAt":"2026-07-15T10:00:00Z","futureOwner":"pixel"}""",
        )
        val document = DriveV1Json.decodeLossless<DriveV1Manifest>(raw)
        document.value = document.value.copy(
            updatedAt = "2026-07-15T11:00:00Z",
            devices = listOf(document.value.devices.single().copy(id = "pixel-2")),
        )

        assertFalse((encodedDevices(document).single() as JsonObject).containsKey("futureOwner"))
    }

    private fun manifestWithDevices(vararg devices: String): String = """{
        "version":1,
        "provider":"google-drive",
        "rootFolderName":"Easylab Lab Notebook",
        "createdAt":"2026-07-15T09:00:00Z",
        "updatedAt":"2026-07-15T10:00:00Z",
        "devices":[${devices.joinToString(",")}],
        "entryCount":0,
        "attachmentCount":0,
        "fileBoxCount":0,
        "transferCount":0
    }""".trimIndent()

    private fun encodedDevices(document: DriveV1LosslessDocument<DriveV1Manifest>): JsonArray =
        (json.parseToJsonElement(document.encodePreservingUnknownFields()) as JsonObject)["devices"] as JsonArray

    @Test
    fun manifestRejectsWrongProvider() {
        val manifest = DriveV1Manifest(
            version = 1,
            provider = "other",
            rootFolderName = "Easylab Lab Notebook",
            createdAt = "2026-07-15T09:00:00Z",
            updatedAt = "2026-07-15T10:00:00Z",
            devices = emptyList(),
            entryCount = 0,
            attachmentCount = 0,
            fileBoxCount = 0,
            transferCount = 0,
        )
        assertTrue(runCatching { manifest.requireV1() }.isFailure)
    }

    @Test
    fun pathsMatchMetadataFirstDriveLayout() {
        val entryEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(fixture("entries/2026-05-23.json"))
        val attachmentEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(
            fixture("attachments/2026-05-23/att-contract-result.csv.json"),
        )
        assertEquals("entries/2026-05-23.json", DriveV1Paths.entry(entryEnvelope.payload))
        assertEquals(
            "entries/2026-05-23-entry-contract.json",
            DriveV1Paths.entry(
                entryEnvelope.payload,
                mapOf(
                    entryEnvelope.payload.id to entryEnvelope.payload,
                    "entry-2" to entryEnvelope.payload.copy(id = "entry-2"),
                ),
            ),
        )
        assertEquals(
            "attachments/2026-05-23/att-contract-result.csv",
            DriveV1Paths.attachmentBlob(attachmentEnvelope.payload, entryEnvelope.payload),
        )
        assertEquals(
            "attachments/2026-05-23/att-contract-result.csv.json",
            DriveV1Paths.attachmentMetadata(attachmentEnvelope.payload, entryEnvelope.payload),
        )
        assertEquals(
            "attachments/2026-07-15/att%2F1-gel%3Aimage.tif",
            DriveV1Paths.attachmentBlob("2026-07-15", "att/1", "gel:image.tif"),
        )
        assertEquals(
            "attachments/2026-07-15/att%2F1-gel%3Aimage.tif.json",
            DriveV1Paths.attachmentMetadata("2026-07-15", "att/1", "gel:image.tif"),
        )
        assertFalse(DriveV1Paths.safeSegment("bad/name", "file").contains('/'))
        assertEquals("devices/dev-contract.json", DriveV1Paths.device("dev-contract"))
        assertEquals("filebox/filebox-contract.json", DriveV1Paths.fileBox("filebox-contract"))
        assertEquals("transfers/transfer-contract.json", DriveV1Paths.transfer("transfer-contract"))
        assertEquals("conflicts/conf-entry-entry-contract.json", DriveV1Paths.conflict("conf-entry-entry-contract"))
        assertEquals(
            "tombstones/attachment--att-deleted.json",
            DriveV1Paths.tombstone("attachment", "att-deleted"),
        )
        assertFalse(DriveV1Paths.device("../escape").contains("../"))
        assertEquals("devices/...json", DriveV1Paths.device(".."))
        assertEquals(".", DriveV1Paths.safeSegment("."))
        assertEquals(
            "entries/2026-05-23.json",
            DriveV1Paths.entry(entryEnvelope.payload.copy(dateBucket = "")),
        )
    }

    @Test
    fun reservedIdCharactersUseTheSharedWebSafeDriveSegmentContract() {
        val safeId = "safe_ID-123.abc"
        val reservedId = "id/part?100%"
        val sanitizedId = "id%2Fpart%3F100%25"

        assertEquals(safeId, DriveV1Paths.safeSegment(safeId))
        assertEquals(sanitizedId, DriveV1Paths.safeSegment(reservedId))
        assertEquals("devices/$sanitizedId.json", DriveV1Paths.device(reservedId))
        assertEquals("entries/2026-07-15-$sanitizedId.json", DriveV1Paths.entry("2026-07-15", reservedId))
        assertEquals(
            "attachments/2026-07-15/$sanitizedId-file%2Fname.txt",
            DriveV1Paths.attachmentBlob("2026-07-15", reservedId, "file/name.txt"),
        )
        assertEquals("filebox/$sanitizedId.json", DriveV1Paths.fileBox(reservedId))
        assertEquals("transfers/$sanitizedId.json", DriveV1Paths.transfer(reservedId))
        assertEquals("conflicts/$sanitizedId.json", DriveV1Paths.conflict(reservedId))
        assertEquals("tombstones/entry--$sanitizedId.json", DriveV1Paths.tombstone("entry", reservedId))

        assertEquals(listOf("a%2Fb", "a%3Fb", "a-b"), listOf("a/b", "a?b", "a-b").map(DriveV1Paths::safeSegment))
        assertEquals(3, listOf("a/b", "a?b", "a-b").map(DriveV1Paths::safeSegment).toSet().size)
        assertEquals("space%C2%A0em%E2%80%83tab%09", DriveV1Paths.safeSegment("space\u00A0em\u2003tab\t"))
        assertEquals("caf%C3%A9%2F%E7%8C%AB", DriveV1Paths.safeSegment("caf\u00E9/\u732B"))
        assertEquals("untitled", DriveV1Paths.safeSegment(""))
        assertEquals("x".repeat(121), DriveV1Paths.safeSegment("x".repeat(121)))
        assertTrue(runCatching { DriveV1Paths.safeSegment("\uD800") }.isFailure)
    }

    @Test
    fun envelopeDeletedAtMustUseATombstone() {
        val envelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(fixture("entries/2026-05-23.json"))
        assertTrue(
            runCatching {
                envelope.copy(deletedAt = "2026-05-23T10:00:00.000Z").requireV1("entry")
            }.isFailure,
        )
    }

    @Test
    fun losslessEnvelopeRejectsExplicitNullDeletedAt() {
        val raw = fixture("entries/2026-05-23.json")
            .replace("\"kind\":\"entry\",", "\"kind\":\"entry\",\"deletedAt\":null,")

        assertTrue(
            runCatching {
                DriveV1Json.decodeLossless<DriveV1Envelope<DriveV1Entry>>(raw)
            }.isFailure,
        )
        assertTrue(
            runCatching {
                json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(raw).requireV1("entry")
            }.isFailure,
        )
    }

    @Test
    fun requiredFieldsAndCaptureValidationMatchWebContract() {
        val golden = fixture("entries/2026-05-23.json")
        val missingEnvelopeVersion = golden.replaceFirst(Regex(""""version":\s*1,"""), "")
        val missingTags = golden.replace(Regex(""""tags":\s*\["contract"],"""), "")
        assertTrue(runCatching {
            json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(missingEnvelopeVersion)
        }.isFailure)
        assertTrue(runCatching {
            json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(missingTags)
        }.isFailure)

        val envelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(golden)
        val validTelegramCapture = json.parseToJsonElement(
            """{"messageId":"shared-1","sentAt":"2026-05-23T09:00:00.000Z","receivedAt":"2026-05-23T09:00:01.000Z","blockIds":[],"attachmentIds":[]}""",
        )
        envelope.copy(
            payload = envelope.payload.copy(telegramCaptures = listOf(validTelegramCapture)),
        ).requireV1("entry")

        val telegramSpecificIdOnly = json.parseToJsonElement(
            """{"telegramMessageId":"telegram-1","sentAt":"2026-05-23T09:00:00.000Z","receivedAt":"2026-05-23T09:00:01.000Z","blockIds":[],"attachmentIds":[]}""",
        )
        assertTrue(runCatching {
            envelope.copy(
                payload = envelope.payload.copy(telegramCaptures = listOf(telegramSpecificIdOnly)),
            ).requireV1("entry")
        }.isFailure)
    }

    @Test
    fun entryContentIdentifiersMustBeNonBlankStrings() {
        val envelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(
            fixture("entries/2026-05-23.json"),
        )
        val invalidBlocks = listOf(
            """{"id":123,"type":"paragraph","text":"Observation"}""",
            """{"id":"${'\uFEFF'}","type":"paragraph","text":"Observation"}""",
            """{"id":"image","type":"image","attachmentId":true}""",
            """{"id":"checklist","type":"checklist","items":[{"id":false,"text":"Run","done":false}]}""",
            """{"id":"checklist","type":"checklist","items":[{"id":"item","text":"Run","done":"false"}]}""",
        ).map(json::parseToJsonElement)

        invalidBlocks.forEach { invalidBlock ->
            assertTrue(
                "Expected Drive v1 validation to reject $invalidBlock",
                runCatching {
                    envelope.copy(
                        payload = envelope.payload.copy(content = listOf(invalidBlock)),
                    ).requireV1("entry")
                }.isFailure,
            )
        }
    }

    @Test
    fun entryContentBlockAndItemIdsMustBeUnique() {
        val envelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(
            fixture("entries/2026-05-23.json"),
        )
        val duplicateBlocks = listOf(
            json.parseToJsonElement("""{"id":"duplicate","type":"paragraph","text":"First"}"""),
            json.parseToJsonElement("""{"id":"duplicate","type":"paragraph","text":"Second"}"""),
        )
        val duplicateItems = listOf(
            json.parseToJsonElement(
                """{
                    "id":"checklist",
                    "type":"checklist",
                    "items":[
                        {"id":"duplicate","text":"First","done":false},
                        {"id":"duplicate","text":"Second","done":true}
                    ]
                }""".trimIndent(),
            ),
        )

        assertTrue(
            runCatching {
                envelope.copy(payload = envelope.payload.copy(content = duplicateBlocks)).requireV1("entry")
            }.isFailure,
        )
        assertTrue(
            runCatching {
                envelope.copy(payload = envelope.payload.copy(content = duplicateItems)).requireV1("entry")
            }.isFailure,
        )
    }

    @Test
    fun validatorsRejectWrongKindsAndMismatchedIds() {
        val golden = fixture("entries/2026-05-23.json")
        val wrongKind = golden.replace("\"kind\":\"entry\"", "\"kind\":\"transfer\"")
        val wrongId = golden.replaceFirst("\"id\":\"entry-contract\"", "\"id\":\"other\"")
        assertTrue(runCatching {
            json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(wrongKind).requireV1("entry")
        }.isFailure)
        assertTrue(runCatching {
            json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(wrongId).requireV1("entry")
        }.isFailure)
    }

    @Test
    fun tombstoneAndConflictSemanticsFailClosed() {
        val invalidTombstone = DriveV1Tombstone(
            id = "del-loop", entityKind = "unknown", entityId = "del-old",
            deletedAt = "2026-05-23T09:50:00.000Z", deletedByDeviceId = "dev-contract",
        )
        val incompleteConflict = DriveV1Conflict(
            id = "conf-empty", entityKind = "entry", entityId = "entry-1",
            localUpdatedAt = "2026-05-23T09:30:00.000Z",
            remoteUpdatedAt = "2026-05-23T09:31:00.000Z",
            detectedAt = "2026-05-23T09:32:00.000Z",
            resolution = "automatic-merge", summary = "Unsupported resolution",
        )
        assertTrue(runCatching { invalidTombstone.requireV1() }.isFailure)
        assertTrue(runCatching { incompleteConflict.requireV1() }.isFailure)
    }

    @Test
    fun queueAndSyncStateRejectInvalidState() {
        val queue = DriveV1SyncQueueItem(
            id = "entry-1", entityKind = "entry", entityId = "1", operation = "upsert",
            status = "queued", queuedAt = "2026-05-23T09:30:00.000Z",
            updatedAt = "2026-05-23T09:30:00.000Z", updatedByDeviceId = "dev-contract",
        )
        assertEquals(queue, json.decodeFromString<DriveV1SyncQueueItem>(json.encodeToString(queue)).requireV1())
        assertTrue(runCatching { queue.copy(operation = "overwrite").requireV1() }.isFailure)
        assertTrue(runCatching {
            DriveV1SyncState("sync", "2026-05-23T09:30:00.000Z", queueCount = -1).requireV1()
        }.isFailure)
    }

    @Test
    fun sha256MatchesWebCryptoGoldenValuesAndStableJsonOrdering() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            DriveV1Hashing.sha256(byteArrayOf()),
        )
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            DriveV1Hashing.sha256("abc"),
        )
        val value = json.parseToJsonElement("""{"b":2,"a":[true,null,"x"]}""")
        assertEquals("""{"a":[true,null,"x"],"b":2}""", DriveV1Hashing.stableStringify(value))
        assertEquals(
            "ab9b02db7ec2d94733f11a399281a3d28694f36b21ca88311ec4fe27679cefd5",
            DriveV1Hashing.sha256(value),
        )
    }

    @Test
    fun numericHashingMatchesJavaScriptJsonStringifySemantics() {
        val cases = listOf(
            Triple("1.0", """{"n":1}""", "2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd"),
            Triple("1e3", """{"n":1000}""", "fe1c788f83a7b21b9bb68ea3d588468319662e1ba670dceb5a83fc7d05a183a8"),
            Triple("1e-7", """{"n":1e-7}""", "747d6d23b64d1b2d579adb832b44de31c91c875bbef7a8e397f5d183a746b54b"),
            Triple("1e21", """{"n":1e+21}""", "f1ee2b60ee95a3170fdc07a577e5f3514ced26867443d69da265acadead81007"),
            Triple("-0", """{"n":0}""", "f3013f933b9fb80ab6d995e7ad9da36f683837ba1d81e950c943d40111eac2f0"),
        )
        cases.forEach { (number, canonical, hash) ->
            val value = json.parseToJsonElement("""{"n":$number}""")
            assertEquals(number, canonical, DriveV1Hashing.stableStringify(value))
            assertEquals(number, hash, DriveV1Hashing.sha256(value))
        }
        assertTrue(runCatching {
            DriveV1Hashing.stableStringify(json.parseToJsonElement("""{"n":9007199254740993}"""))
        }.isFailure)
    }

    @Test
    fun semanticHashesMatchTypeScriptWriterFixtures() {
        val entry = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(
            fixture("entries/2026-05-23.json"),
        ).payload
        val attachment = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(
            fixture("attachments/2026-05-23/att-contract-result.csv.json"),
        ).payload
        val fileBox = json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(
            fixture("filebox/filebox-contract.json"),
        ).payload
        val transfer = json.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(
            fixture("transfers/transfer-contract.json"),
        ).payload

        assertEquals(
            "c2674d4e6ad545cdc38959c8a6f83db799b0aae9652b5f7beb79c0a1187bffd9",
            DriveV1Hashing.entryContentHash(entry),
        )
        assertEquals(
            "542946b85a5eb6cd2188eed3af31fe43578787f52919a1c06273cef2cd50bb05",
            DriveV1Hashing.attachmentMetadataHash(attachment),
        )
        assertEquals(
            "06ed1bb7d371fa597231ac37a7201857dbc8cb0d1b37d45b88e8ad786d9dc25b",
            DriveV1Hashing.fileBoxMetadataHash(fileBox),
        )
        assertEquals(
            "3da4ff961880e5cca8a13ca81d23d548d7f0dbba87b25c8a68b00d381d16655b",
            DriveV1Hashing.transferMetadataHash(transfer),
        )
        assertFalse(
            DriveV1Hashing.entryContentHash(entry.copy(authorId = "changed-author")) ==
                DriveV1Hashing.entryContentHash(entry),
        )
        assertFalse(
            DriveV1Hashing.attachmentMetadataHash(attachment.copy(storagePath = "attachments/changed.csv")) ==
                DriveV1Hashing.attachmentMetadataHash(attachment),
        )
    }

    @Test
    fun semanticHashesCanonicalizeExplicitNullOptionalsLikeTypeScript() {
        val entryFixture = fixture("entries/2026-05-23.json")
        val attachmentFixture = fixture("attachments/2026-05-23/att-contract-result.csv.json")
        val fileBoxFixture = fixture("filebox/filebox-contract.json")
        val transferFixture = fixture("transfers/transfer-contract.json")

        val entry = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(entryFixture).payload
        val entryWithNull = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(
            entryFixture.replace("\"payload\": {", "\"payload\": {\n    \"experimentId\": null,"),
        ).payload
        val attachment = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(attachmentFixture).payload
        val attachmentWithNull = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(
            attachmentFixture.replace("\"payload\": {", "\"payload\": {\n    \"linkedRegionId\": null,"),
        ).payload
        val fileBox = json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(fileBoxFixture).payload
        val fileBoxWithNull = json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(
            fileBoxFixture.replace("\"payload\": {", "\"payload\": {\n    \"localObjectUrl\": null,"),
        ).payload
        val transfer = json.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(transferFixture).payload
        val transferWithNull = json.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(
            transferFixture.replace("\"payload\": {", "\"payload\": {\n    \"lastError\": null,"),
        ).payload

        assertEquals(DriveV1Hashing.entryContentHash(entry), DriveV1Hashing.entryContentHash(entryWithNull))
        assertEquals(
            DriveV1Hashing.attachmentMetadataHash(attachment),
            DriveV1Hashing.attachmentMetadataHash(attachmentWithNull),
        )
        assertEquals(DriveV1Hashing.fileBoxMetadataHash(fileBox), DriveV1Hashing.fileBoxMetadataHash(fileBoxWithNull))
        assertEquals(DriveV1Hashing.transferMetadataHash(transfer), DriveV1Hashing.transferMetadataHash(transferWithNull))
    }

    @Test
    fun allNativeDriveOperationsFailClosed() = runTest {
        val repository = NativeDriveRepositorySkeleton()
        val accountId = AccountId("subject-1")
        assertEquals(DriveWriteCapability.DisabledPendingContractParity, repository.writeCapability)
        assertTrue(repository.listManagedFiles(accountId).isFailure)
        assertTrue(repository.readJson(accountId, "entries/today.json").isFailure)
        assertTrue(repository.putJson(accountId, "entries/today.json", "{}").isFailure)
        assertTrue(repository.putBlob(accountId, "attachments/blob", byteArrayOf(), "text/plain", "hash").isFailure)
    }
}
