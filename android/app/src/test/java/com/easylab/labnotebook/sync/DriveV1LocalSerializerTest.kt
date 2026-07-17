package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.DriveRawDocumentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.SyncQueueEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveV1LocalSerializerTest {
    private val accountId = AccountId("account-a")
    private val json = DriveV1Json.format

    @Test
    fun entryPreservesUnknownFieldsAndExistingRemotePath() {
        val raw = """{
            "id":"entry-1",
            "kind":"entry",
            "version":1,
            "updatedAt":"2026-07-15T10:00:00Z",
            "updatedByDeviceId":"device-a",
            "futureEnvelope":{"revision":4},
            "payload":{
                "id":"entry-1",
                "createdDatetime":"2026-07-15T09:00:00Z",
                "lastEditedDatetime":"2026-07-15T10:00:00Z",
                "authorId":"researcher",
                "title":"Original",
                "dateBucket":"2026-07-15",
                "content":[{"id":"block-1","type":"paragraph","text":"Observation","futureBlock":"keep"}],
                "tags":[],
                "searchTerms":[],
                "linkedFiles":[],
                "pinnedRegions":[],
                "version":1,
                "updatedByDeviceId":"device-a",
                "syncStatus":"queued",
                "futurePayload":"keep"
            }
        }""".trimIndent()
        val baseline = raw("entry", "entry-1", "entries/2026-07-15-legacy-name.json", raw)
        val entry = entry(
            title = "Edited",
            version = 2,
            updatedAt = "2026-07-15T11:00:00Z",
            contentJson =
                """[{"id":"block-1","type":"paragraph","text":"Observation","futureBlock":"keep"}]""",
        )

        val serialized = DriveV1LocalSerializer.serializeEntry(
            accountId = accountId,
            entity = entry,
            queue = queue("entry", entry.id, entry.updatedAt, baseVersion = 1),
            targetPath = baseline.path,
            rawBaseline = baseline,
        )

        assertEquals(baseline.path, serialized.path)
        val root = json.parseToJsonElement(serialized.json).jsonObject
        assertEquals("4", root["futureEnvelope"]!!.jsonObject["revision"]!!.jsonPrimitive.content)
        assertEquals("keep", root["payload"]!!.jsonObject["futurePayload"]!!.jsonPrimitive.content)
        assertEquals(
            "keep",
            root["payload"]!!.jsonObject["content"]
                .let { it as kotlinx.serialization.json.JsonArray }[0]
                .jsonObject["futureBlock"]!!.jsonPrimitive.content,
        )
        assertEquals("Edited", root["payload"]!!.jsonObject["title"]!!.jsonPrimitive.content)
        assertEquals("2026-07-15T11:00:00Z", root["updatedAt"]!!.jsonPrimitive.content)
        assertEquals("synced", root["payload"]!!.jsonObject["syncStatus"]!!.jsonPrimitive.content)
    }

    @Test
    fun newEntryUsesOnlyThePreflightSelectedPath() {
        val entry = entry().copy(syncPath = "/private/native/cache/entry-1.json")
        val queue = queue("entry", entry.id, entry.updatedAt)
        val selectedPath = "entries/2026-07-15-entry-1.json"

        val serialized = DriveV1LocalSerializer.serializeEntry(accountId, entry, queue, selectedPath)
        val envelope = json.decodeFromString<DriveV1Envelope<DriveV1Entry>>(serialized.json)

        assertEquals(selectedPath, serialized.path)
        assertNull(envelope.payload.syncPath)
        assertEquals("synced", envelope.payload.syncStatus)
    }

    @Test
    fun newEntryCannotInferAnUnsafeSameDayPathFromAnIncompleteSnapshot() {
        val first = entry(id = "entry/one")
        val safePath = DriveV1Paths.entry(first.dateBucket, first.id)

        val serialized = DriveV1LocalSerializer.serializeEntry(
            accountId,
            first,
            queue("entry", first.id, first.updatedAt),
            safePath,
        )

        assertEquals("entries/2026-07-15-entry%2Fone.json", serialized.path)
        assertTrue(
            runCatching {
                DriveV1LocalSerializer.serializeEntry(
                    accountId,
                    first,
                    queue("entry", first.id, first.updatedAt),
                    "entries/2026-07-15.json",
                )
            }.isFailure,
        )
    }

    @Test
    fun attachmentUsesParentDateAndNeverPublishesLocalCacheHints() {
        val entry = entry()
        val attachment = AttachmentEntity(
            accountId = accountId.value,
            id = "att/1",
            entryId = entry.id,
            type = "image",
            filename = "microglia image.tif",
            displaySize = "18.4 MB",
            byteSize = 1024,
            storagePath = "capture/att-1",
            mimeType = "image/tiff",
            sha256 = "abc123",
            localUri = "content://local/att-1",
            pinnedOffline = true,
            syncStatus = "queued",
            createdAt = "2026-07-15T09:30:00Z",
            updatedAt = "2026-07-15T10:30:00Z",
            thumbnail = "blob:local-preview",
            cachedPath = "/private/cache/att-1",
            cacheKey = "file:/private/cache/key",
        )

        val serialized = DriveV1LocalSerializer.serializeAttachment(
            accountId,
            attachment,
            entry,
            queue("attachment", attachment.id, attachment.updatedAt),
        )
        val envelope = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(serialized.json)

        assertEquals(
            "attachments/2026-07-15/att%2F1-microglia%20image.tif",
            serialized.attachmentBlobPath,
        )
        assertEquals("${serialized.attachmentBlobPath}.json", serialized.path)
        assertNull(envelope.payload.cachedPath)
        assertNull(envelope.payload.thumbnail)
        assertNull(envelope.payload.cacheKey)
        assertEquals(serialized.attachmentBlobPath, envelope.payload.storagePath)
        assertEquals("synced", envelope.payload.syncStatus)
        assertEquals("image/tiff", envelope.payload.mimeType)
        assertEquals("device-a", envelope.updatedByDeviceId)
    }

    @Test
    fun existingAttachmentKeepsMetadataAndBlobAtTheSameVerifiedPathAfterRename() {
        val entry = entry()
        val originalAttachment = attachment(filename = "before.csv", updatedAt = "2026-07-15T10:00:00Z")
        val originalBlobPath = "attachments/2026-07-14/att-1-before.csv"
        val originalEnvelope = DriveV1Envelope(
            id = originalAttachment.id,
            kind = "attachment",
            updatedAt = originalAttachment.updatedAt,
            updatedByDeviceId = "device-a",
            payload = DriveV1Attachment(
                id = originalAttachment.id,
                entryId = originalAttachment.entryId,
                type = originalAttachment.type,
                filename = originalAttachment.filename,
                filesize = originalAttachment.displaySize,
                storagePath = originalBlobPath,
                syncStatus = "synced",
                createdAt = originalAttachment.createdAt,
                updatedAt = originalAttachment.updatedAt,
            ),
        )
        val baseline = raw(
            "attachment",
            originalAttachment.id,
            "$originalBlobPath.json",
            json.encodeToString(DriveV1Envelope.serializer(DriveV1Attachment.serializer()), originalEnvelope),
        )
        val renamed = originalAttachment.copy(
            filename = "after.csv",
            storagePath = "/private/native/cache/after.csv",
            updatedAt = "2026-07-15T11:00:00Z",
            syncStatus = "queued",
        )

        val serialized = DriveV1LocalSerializer.serializeAttachment(
            accountId,
            renamed,
            entry,
            queue("attachment", renamed.id, renamed.updatedAt),
            baseline,
        )
        val envelope = json.decodeFromString<DriveV1Envelope<DriveV1Attachment>>(serialized.json)

        assertEquals(originalBlobPath, serialized.attachmentBlobPath)
        assertEquals("$originalBlobPath.json", serialized.path)
        assertEquals(originalBlobPath, envelope.payload.storagePath)
        assertEquals("after.csv", envelope.payload.filename)
    }

    @Test
    fun fileBoxAndTransferSerializeAsValidatedEnvelopes() {
        val item = FileBoxItemEntity(
            accountId = accountId.value,
            id = "inbox-1",
            entryId = "entry-1",
            filename = "results.csv",
            filesize = "1 KB",
            sourceDeviceId = "device-a",
            sourceDeviceName = "Pixel",
            status = "available",
            createdAt = "2026-07-15T09:00:00Z",
            updatedAt = "2026-07-15T10:00:00Z",
            localObjectUrl = "blob:never-publish",
        )
        val transfer = TransferEntity(
            accountId = accountId.value,
            id = "transfer-1",
            fileBoxItemId = item.id,
            entryId = item.entryId,
            filename = item.filename,
            fromDeviceId = "device-a",
            fromDeviceName = "Pixel",
            provider = "google-drive",
            status = "queued",
            bytesTotal = 1024,
            bytesTransferred = 0,
            createdAt = "2026-07-15T09:00:00Z",
            updatedAt = "2026-07-15T10:00:00Z",
        )

        val itemDocument = DriveV1LocalSerializer.serializeFileBoxItem(
            accountId,
            item,
            queue("fileBoxItem", item.id, item.updatedAt),
        )
        val transferDocument = DriveV1LocalSerializer.serializeTransfer(
            accountId,
            transfer,
            queue("transfer", transfer.id, transfer.updatedAt),
        )
        val itemEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1FileBoxItem>>(itemDocument.json)
        val transferEnvelope = json.decodeFromString<DriveV1Envelope<DriveV1Transfer>>(transferDocument.json)

        assertEquals("filebox/inbox-1.json", itemDocument.path)
        assertNull(itemEnvelope.payload.localObjectUrl)
        assertEquals("transfers/transfer-1.json", transferDocument.path)
        assertEquals(1024L, transferEnvelope.payload.bytesTotal)
    }

    @Test
    fun directDocumentsAndManifestUseExactV1Shapes() {
        val device = device()
        val conflict = ConflictEntity(
            accountId = accountId.value,
            id = "conflict-1",
            entityKind = "entry",
            entityId = "entry-1",
            localUpdatedAt = "2026-07-15T10:00:00Z",
            remoteUpdatedAt = "2026-07-15T10:01:00Z",
            detectedAt = "2026-07-15T10:02:00Z",
            resolution = "pending",
            summary = "Both devices edited the entry.",
            localCopyJson = "{\"title\":\"Local\"}",
            remoteCopyJson = "{\"title\":\"Remote\"}",
        )
        val tombstone = TombstoneEntity(
            accountId = accountId.value,
            id = "delete-entry-1",
            entityKind = "entry",
            entityId = "entry-1",
            deletedAt = "2026-07-15T11:00:00Z",
            deletedByDeviceId = "device-a",
        )
        val manifestRaw = """{
            "version":1,
            "provider":"google-drive",
            "rootFolderName":"Existing Notebook",
            "createdAt":"2026-07-01T09:00:00Z",
            "updatedAt":"2026-07-15T09:00:00Z",
            "devices":[{
                "id":"device-old",
                "name":"Desktop",
                "platform":"desktop",
                "createdAt":"2026-07-01T09:00:00Z",
                "lastSeenAt":"2026-07-14T09:00:00Z"
            }],
            "entryCount":0,
            "attachmentCount":0,
            "fileBoxCount":0,
            "transferCount":0,
            "futureManifest":{"keep":true}
        }""".trimIndent()

        val deviceDocument = DriveV1LocalSerializer.serializeDevice(accountId, device)
        val conflictDocument = DriveV1LocalSerializer.serializeConflict(accountId, conflict)
        val tombstoneDocument = DriveV1LocalSerializer.serializeTombstone(accountId, tombstone)
        val manifestDocument = DriveV1LocalSerializer.serializeManifest(
            accountId = accountId,
            updatedAt = "2026-07-15T12:00:00Z",
            inventory = inventory(
                devices = listOf(device),
                entries = listOf(entry(), entry(id = "entry-2"), entry(id = "entry-3")),
                attachments = listOf(attachment(), attachment(id = "att-2")),
                fileBoxItems = listOf(fileBoxItem()),
                transfers = listOf(transfer()),
            ),
            rawBaseline = raw("manifest", "manifest", DriveV1Paths.manifest, manifestRaw),
        )

        assertEquals("devices/device-a.json", deviceDocument.path)
        assertEquals("device-a", json.decodeFromString<DriveV1Device>(deviceDocument.json).id)
        assertEquals("conflicts/conflict-1.json", conflictDocument.path)
        assertEquals(
            "Local",
            json.decodeFromString<DriveV1Conflict>(conflictDocument.json).localCopy!!
                .jsonObject["title"]!!.jsonPrimitive.content,
        )
        assertEquals("tombstones/entry--entry-1.json", tombstoneDocument.path)
        assertEquals("entry-1", json.decodeFromString<DriveV1Tombstone>(tombstoneDocument.json).entityId)
        val manifestRoot = json.parseToJsonElement(manifestDocument.json).jsonObject
        assertEquals("Existing Notebook", manifestRoot["rootFolderName"]!!.jsonPrimitive.content)
        assertEquals("2026-07-01T09:00:00Z", manifestRoot["createdAt"]!!.jsonPrimitive.content)
        assertTrue(manifestRoot.containsKey("futureManifest"))
        assertEquals("3", manifestRoot["entryCount"]!!.jsonPrimitive.content)
        val manifest = json.decodeFromString<DriveV1Manifest>(manifestDocument.json)
        assertEquals(setOf("device-old", "device-a"), manifest.devices.mapTo(hashSetOf()) { it.id })
        assertEquals(2, manifest.attachmentCount)
        assertEquals(1, manifest.fileBoxCount)
        assertEquals(1, manifest.transferCount)
    }

    @Test
    fun malformedRoomJsonAndMismatchedScopesFailBeforeWriting() {
        val entry = entry(contentJson = "{not-an-array}")
        assertTrue(
            runCatching {
                DriveV1LocalSerializer.serializeEntry(
                    accountId,
                    entry,
                    queue("entry", entry.id, entry.updatedAt),
                    "entries/2026-07-15-entry-1.json",
                )
            }.isFailure,
        )

        val validEntry = entry()
        assertTrue(
            runCatching {
                DriveV1LocalSerializer.serializeEntry(
                    accountId,
                    validEntry.copy(accountId = "account-b"),
                    queue("entry", validEntry.id, validEntry.updatedAt),
                    "entries/2026-07-15-entry-1.json",
                )
            }.isFailure,
        )
        assertTrue(
            runCatching {
                DriveV1LocalSerializer.serializeEntry(
                    accountId,
                    validEntry,
                    queue("attachment", validEntry.id, validEntry.updatedAt),
                    "entries/2026-07-15-entry-1.json",
                )
            }.isFailure,
        )
        assertTrue(
            runCatching {
                DriveV1LocalSerializer.serializeEntry(
                    accountId,
                    validEntry,
                    queue("entry", validEntry.id, validEntry.updatedAt),
                    "devices/wrong.json",
                    raw("entry", validEntry.id, "devices/wrong.json", "{}"),
                )
            }.isFailure,
        )
    }

    @Test
    fun newManifestRequiresCreatedAtAndAccountScopedDevices() {
        assertTrue(
            runCatching {
                DriveV1LocalSerializer.serializeManifest(
                    accountId,
                    updatedAt = "2026-07-15T12:00:00Z",
                    inventory = inventory(devices = listOf(device())),
                )
            }.isFailure,
        )
        assertTrue(
            runCatching {
                DriveV1LocalSerializer.serializeManifest(
                    accountId,
                    updatedAt = "2026-07-15T12:00:00Z",
                    inventory = inventory(devices = listOf(device().copy(accountId = "account-b"))),
                    createdAt = "2026-07-15T09:00:00Z",
                )
            }.isFailure,
        )
    }

    @Test
    fun staleFutureOrMismatchedEntryBaselinesAreRejected() {
        val edited = entry(version = 2, updatedAt = "2026-07-15T11:00:00Z")
        val validPayload = DriveV1Entry(
            id = edited.id,
            createdDatetime = edited.createdAt,
            lastEditedDatetime = "2026-07-15T10:00:00Z",
            authorId = edited.authorId,
            title = "Remote",
            dateBucket = edited.dateBucket,
            version = 1,
            syncStatus = "synced",
        )
        fun baseline(payload: DriveV1Entry = validPayload, envelopeVersion: Int = 1) = raw(
            "entry",
            edited.id,
            "entries/2026-07-15.json",
            json.encodeToString(
                DriveV1Envelope.serializer(DriveV1Entry.serializer()),
                DriveV1Envelope(
                    id = edited.id,
                    kind = "entry",
                    version = envelopeVersion,
                    updatedAt = "2026-07-15T10:00:00Z",
                    updatedByDeviceId = "device-a",
                    payload = payload,
                ),
            ),
        )

        assertTrue(runCatching {
            DriveV1LocalSerializer.serializeEntry(
                accountId,
                edited,
                queue("entry", edited.id, edited.updatedAt, baseVersion = 0),
                "entries/2026-07-15.json",
                baseline(),
            )
        }.isFailure)
        assertTrue(runCatching {
            DriveV1LocalSerializer.serializeEntry(
                accountId,
                edited,
                queue("entry", edited.id, edited.updatedAt, baseVersion = 1),
                "entries/2026-07-15.json",
                baseline(payload = validPayload.copy(id = "other-entry")),
            )
        }.isFailure)
        assertTrue(runCatching {
            DriveV1LocalSerializer.serializeEntry(
                accountId,
                edited,
                queue("entry", edited.id, edited.updatedAt, baseVersion = 1),
                "entries/2026-07-15.json",
                baseline(envelopeVersion = 2),
            )
        }.isFailure)
        assertTrue(runCatching {
            DriveV1LocalSerializer.serializeEntry(
                accountId,
                edited,
                queue("entry", edited.id, edited.updatedAt, baseVersion = 1),
                "entries/renamed.json",
                baseline(),
            )
        }.isFailure)
        assertTrue(runCatching {
            val futurePayload = validPayload.copy(lastEditedDatetime = "2026-07-15T12:00:00Z")
            DriveV1LocalSerializer.serializeEntry(
                accountId,
                edited,
                queue("entry", edited.id, edited.updatedAt, baseVersion = 1),
                "entries/2026-07-15.json",
                baseline(payload = futurePayload).copy(
                    rawJson = json.encodeToString(
                        DriveV1Envelope.serializer(DriveV1Entry.serializer()),
                        DriveV1Envelope(
                            id = edited.id,
                            kind = "entry",
                            updatedAt = "2026-07-15T12:00:00Z",
                            updatedByDeviceId = "device-a",
                            payload = futurePayload,
                        ),
                    ),
                ),
            )
        }.isFailure)
        assertTrue(runCatching {
            val equalPayload = validPayload.copy(lastEditedDatetime = edited.updatedAt)
            DriveV1LocalSerializer.serializeEntry(
                accountId,
                edited,
                queue("entry", edited.id, edited.updatedAt, baseVersion = 1),
                "entries/2026-07-15.json",
                baseline(payload = equalPayload).copy(
                    rawJson = json.encodeToString(
                        DriveV1Envelope.serializer(DriveV1Entry.serializer()),
                        DriveV1Envelope(
                            id = edited.id,
                            kind = "entry",
                            updatedAt = edited.updatedAt,
                            updatedByDeviceId = "device-a",
                            payload = equalPayload,
                        ),
                    ),
                ),
            )
        }.isFailure)
    }

    private fun entry(
        id: String = "entry-1",
        title: String = "Original",
        version: Int = 1,
        updatedAt: String = "2026-07-15T10:00:00Z",
        contentJson: String = """[{"id":"block-1","type":"paragraph","text":"Observation"}]""",
    ) = JournalEntryEntity(
        accountId = accountId.value,
        id = id,
        title = title,
        dateBucket = "2026-07-15",
        createdAt = "2026-07-15T09:00:00Z",
        updatedAt = updatedAt,
        authorId = "researcher",
        contentJson = contentJson,
        version = version,
        updatedByDeviceId = "device-a",
        syncStatus = "queued",
        source = "manual",
    )

    private fun queue(
        entityKind: String,
        entityId: String,
        updatedAt: String,
        baseVersion: Int? = null,
    ) = SyncQueueEntity(
        accountId = accountId.value,
        id = "queue-$entityKind-$entityId",
        entityKind = entityKind,
        entityId = entityId,
        operation = "upsert",
        status = "queued",
        queuedAt = updatedAt,
        updatedAt = updatedAt,
        updatedByDeviceId = "device-a",
        baseVersion = baseVersion,
    )

    private fun attachment(
        id: String = "att-1",
        filename: String = "results.csv",
        updatedAt: String = "2026-07-15T10:00:00Z",
    ) = AttachmentEntity(
        accountId = accountId.value,
        id = id,
        entryId = "entry-1",
        type = "file",
        filename = filename,
        displaySize = "1 KB",
        storagePath = "attachments/$filename",
        syncStatus = "queued",
        createdAt = "2026-07-15T09:00:00Z",
        updatedAt = updatedAt,
    )

    private fun fileBoxItem() = FileBoxItemEntity(
        accountId = accountId.value,
        id = "inbox-1",
        entryId = "entry-1",
        filename = "results.csv",
        filesize = "1 KB",
        sourceDeviceId = "device-a",
        sourceDeviceName = "Pixel",
        status = "available",
        createdAt = "2026-07-15T09:00:00Z",
        updatedAt = "2026-07-15T10:00:00Z",
    )

    private fun transfer() = TransferEntity(
        accountId = accountId.value,
        id = "transfer-1",
        entryId = "entry-1",
        filename = "results.csv",
        fromDeviceId = "device-a",
        fromDeviceName = "Pixel",
        provider = "google-drive",
        status = "available",
        createdAt = "2026-07-15T09:00:00Z",
        updatedAt = "2026-07-15T10:00:00Z",
    )

    private fun inventory(
        devices: Collection<DeviceEntity> = emptyList(),
        entries: Collection<JournalEntryEntity> = emptyList(),
        attachments: Collection<AttachmentEntity> = emptyList(),
        fileBoxItems: Collection<FileBoxItemEntity> = emptyList(),
        transfers: Collection<TransferEntity> = emptyList(),
    ) = DriveV1ManifestInventory(devices, entries, attachments, fileBoxItems, transfers)

    private fun device() = DeviceEntity(
        accountId = accountId.value,
        id = "device-a",
        name = "Pixel",
        platform = "mobile",
        createdAt = "2026-07-01T09:00:00Z",
        lastSeenAt = "2026-07-15T12:00:00Z",
        appVersion = "1.0",
    )

    private fun raw(entityKind: String, entityId: String, path: String, rawJson: String) =
        DriveRawDocumentEntity(
            accountId = accountId.value,
            entityKind = entityKind,
            entityId = entityId,
            path = path,
            driveFileId = "drive-$entityKind-$entityId",
            driveModifiedAt = "2026-07-15T10:00:00Z",
            rawJson = rawJson,
        )
}
