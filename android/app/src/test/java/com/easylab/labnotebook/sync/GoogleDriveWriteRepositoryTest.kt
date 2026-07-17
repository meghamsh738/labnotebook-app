package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import com.easylab.labnotebook.data.repository.DriveHttpException
import com.easylab.labnotebook.data.repository.DriveProtocolException
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
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

    private class Fixture {
        val auth = FakeAuthRepository(mapOf(ACCOUNT_A to "exact-token-a"))
        val store = InMemoryDriveRootFolderIdStore()
        val transport = FakeDriveWriteTransport()
        val repository = GoogleDriveWriteRepository(
            authRepository = auth,
            rootFolderIds = store,
            transport = transport,
            boundaryFactory = { "easylab-test-boundary" },
        )

        fun addExistingTree(
            fileCopies: Int,
            existingAppProperties: Map<String, String> = emptyMap(),
        ) {
            store.set(ACCOUNT_A, "root-a")
            transport.add(FakeNode.folder("root-a", "Easylab Lab Notebook", parentId = "root"))
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

    private data class FakeNode(
        val id: String,
        val name: String,
        val parentId: String,
        val mimeType: String,
        var body: ByteArray = byteArrayOf(),
        var version: Long = 1,
        var appProperties: Map<String, String> = emptyMap(),
        val trashed: Boolean = false,
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
        private val nodes = linkedMapOf<String, FakeNode>()
        private var nextId = 1

        fun add(node: FakeNode) {
            nodes[node.id] = node
        }

        override suspend fun execute(request: DriveHttpRequest): DriveHttpResponse {
            requests += request
            yield()
            forcedStatus?.let { return DriveHttpResponse(statusCode = it) }
            val uri = URI(request.url)
            return when {
                request.method == "GET" && uri.path.contains("/files/") -> getById(request, uri)
                request.method == "GET" -> list(request)
                request.method == "POST" && !uri.path.contains("/upload/") -> createFolder(request)
                request.method in setOf("POST", "PATCH") && uri.path.contains("/upload/") -> upload(request, uri)
                else -> error("Unexpected request: ${request.method} ${request.url}")
            }
        }

        private fun getById(request: DriveHttpRequest, uri: URI): DriveHttpResponse {
            val id = uri.path.substringAfterLast("/files/")
            val node = nodes[id] ?: return DriveHttpResponse(404)
            return if (queryParameter(request.url, "alt") == "media") {
                DriveHttpResponse(200, body = node.body)
            } else {
                DriveHttpResponse(200, body = nodeJson(node).toByteArray())
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

        private fun upload(request: DriveHttpRequest, uri: URI): DriveHttpResponse {
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
                ).also { nodes[it.id] = it }
            } else {
                nodes.getValue(existingId).also { existing ->
                    existing.body = content
                    existing.version += 1
                }
            }
            node.appProperties = (metadata["appProperties"] as? JsonObject)
                ?.mapValues { (_, value) -> value.jsonPrimitive.content }
                .orEmpty()
            return DriveHttpResponse(200, body = nodeJson(node).toByteArray())
        }

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
        const val ENTRY_JSON = "{\"schemaVersion\":1,\"entityType\":\"entry\",\"payload\":{\"id\":\"entry-a\"}}"
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
}
