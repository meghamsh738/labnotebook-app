package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import com.easylab.labnotebook.data.repository.DriveHttpException
import com.easylab.labnotebook.data.repository.DriveProtocolException
import com.easylab.labnotebook.data.repository.DriveSignInRequiredException
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleDriveReadOnlyRepositoryTest {
    @Test
    fun writesFailClosedWithoutAnyHttpCall() = runTest {
        val fixture = Fixture()

        assertEquals(DriveWriteCapability.DisabledPendingContractParity, fixture.repository.writeCapability)
        assertTrue(fixture.repository.putJson(ACCOUNT_A, "entries/a.json", "{}").isFailure)
        assertTrue(
            fixture.repository.putBlob(
                ACCOUNT_A,
                "attachments/a.bin",
                byteArrayOf(1),
                "application/octet-stream",
                "sha",
            ).isFailure,
        )
        assertTrue(fixture.transport.requests.isEmpty())
    }

    @Test
    fun savedRenamedManifestRootIsValidatedAndReused() = runTest {
        val fixture = Fixture()
        fixture.store.set(ACCOUNT_A, "renamed-root")
        fixture.transport.add(FakeNode.folder("renamed-root", "Renamed notebook"))
        fixture.transport.add(FakeNode.manifest("manifest", "renamed-root"))

        val files = fixture.repository.listManagedFiles(ACCOUNT_A).getOrThrow()

        assertEquals(listOf("manifest.json"), files.map { it.path })
        assertTrue(fixture.transport.decodedQueries().any { it.contains("'root' in parents") })
        assertTrue(fixture.transport.authorizationHeaders().all { it == "Bearer exact-drive-file-token-a" })
    }

    @Test
    fun validCachedManifestRootDoesNotBypassSecondValidManifestRootDiscovery() = runTest {
        val fixture = Fixture()
        fixture.store.set(ACCOUNT_A, "cached-root")
        fixture.transport.add(FakeNode.folder("cached-root", "Renamed notebook"))
        fixture.transport.add(FakeNode.manifest("cached-manifest", "cached-root"))
        fixture.transport.add(FakeNode.folder("discovered-root", DEFAULT_NAME))
        fixture.transport.add(FakeNode.manifest("discovered-manifest", "discovered-root"))

        val error = fixture.repository.listManagedFiles(ACCOUNT_A).exceptionOrNull()

        assertTrue(error is DriveProtocolException)
        assertTrue(error?.message.orEmpty().contains("Multiple Easylab Drive workspaces"))
        assertTrue(fixture.transport.decodedQueries().any { it.contains("'root' in parents") })
    }

    @Test
    fun invalidSavedRootRecoversByEscapedNameAndManifestWinsOverEmptyAndUnmanaged() = runTest {
        val folderName = "Lab 'A\\B"
        val fixture = Fixture(folderName = folderName)
        fixture.store.set(ACCOUNT_A, "missing-root")
        fixture.transport.add(FakeNode.folder("empty-root", folderName))
        fixture.transport.add(FakeNode.folder("unmanaged-root", folderName))
        fixture.transport.add(FakeNode.json("personal", "personal.json", "unmanaged-root", "{}"))
        fixture.transport.add(FakeNode.folder("managed-root", folderName))
        fixture.transport.add(FakeNode.manifest("manifest", "managed-root"))

        fixture.repository.listManagedFiles(ACCOUNT_A).getOrThrow()

        assertEquals("managed-root", fixture.store.get(ACCOUNT_A))
        assertTrue(
            fixture.transport.decodedQueries().any {
                it.contains("name = 'Lab \\'A\\\\B'") && it.contains("trashed = false")
            },
        )
    }

    @Test
    fun rootSearchRejectsManifestAndEmptyAmbiguityAndIgnoresUnmanagedCandidates() = runTest {
        suspend fun failureFor(nodes: List<FakeNode>): Throwable {
            val fixture = Fixture()
            nodes.forEach(fixture.transport::add)
            return fixture.repository.listManagedFiles(ACCOUNT_A).exceptionOrNull()!!
        }

        val manifestAmbiguity = failureFor(
            listOf(
                FakeNode.folder("root-a", DEFAULT_NAME),
                FakeNode.manifest("manifest-a", "root-a"),
                FakeNode.folder("root-b", DEFAULT_NAME),
                FakeNode.manifest("manifest-b", "root-b"),
                FakeNode.folder("unmanaged", DEFAULT_NAME),
                FakeNode.json("notes", "notes.json", "unmanaged", "{}"),
            ),
        )
        assertTrue(manifestAmbiguity is DriveProtocolException)
        assertTrue(manifestAmbiguity.message.orEmpty().contains("Multiple Easylab Drive workspaces"))

        val emptyAmbiguity = failureFor(
            listOf(
                FakeNode.folder("empty-a", DEFAULT_NAME),
                FakeNode.folder("empty-b", DEFAULT_NAME),
                FakeNode.folder("unmanaged", DEFAULT_NAME),
                FakeNode.json("notes", "notes.json", "unmanaged", "{}"),
            ),
        )
        assertTrue(emptyAmbiguity is DriveProtocolException)
        assertTrue(emptyAmbiguity.message.orEmpty().contains("Multiple empty Easylab Drive folders"))
    }

    @Test
    fun paginationAndRecursiveListingBuildPathsAndPreserveDuplicates() = runTest {
        val fixture = Fixture(pageSize = 1)
        fixture.transport.add(FakeNode.folder("workspace", DEFAULT_NAME))
        fixture.transport.add(FakeNode.manifest("manifest", "workspace"))
        fixture.transport.add(FakeNode.folder("entries", "entries", "workspace"))
        fixture.transport.add(FakeNode.folder("day", "2026-07-16", "entries"))
        fixture.transport.add(FakeNode.json("entry-a", "record.json", "day", "{\"id\":1}"))
        fixture.transport.add(FakeNode.json("entry-b", "record.json", "day", "{\"id\":2}"))
        fixture.transport.add(FakeNode.folder("other", "other", "workspace"))
        fixture.transport.add(FakeNode.json("ignored", "ignored.json", "other", "{}"))

        val paths = fixture.repository.listManagedFiles(ACCOUNT_A).getOrThrow().map { it.path }

        assertEquals(
            listOf(
                "entries/2026-07-16/record.json",
                "entries/2026-07-16/record.json",
                "manifest.json",
            ),
            paths,
        )
        assertTrue(fixture.transport.requests.any { queryParameter(it.url, "pageToken") == "1" })
    }

    @Test
    fun recursiveListingPreservesAttachmentEntityTypeProperties() = runTest {
        val fixture = Fixture()
        fixture.transport.add(FakeNode.folder("workspace", DEFAULT_NAME))
        fixture.transport.add(FakeNode.manifest("manifest", "workspace"))
        fixture.transport.add(FakeNode.folder("attachments", "attachments", "workspace"))
        fixture.transport.add(FakeNode.folder("day", "2026-07-16", "attachments"))
        fixture.transport.add(
            FakeNode.json(
                id = "metadata",
                name = "attachment.csv.json",
                parentId = "day",
                body = "{}",
                appProperties = mapOf("entityType" to "attachment"),
            ),
        )
        fixture.transport.add(
            FakeNode(
                id = "blob",
                name = "attachment.csv",
                parentId = "day",
                mimeType = "application/octet-stream",
                body = "bytes",
                appProperties = mapOf("entityType" to "attachmentBlob"),
            ),
        )

        val files = fixture.repository.listManagedFiles(ACCOUNT_A).getOrThrow().associateBy { it.name }

        assertEquals("attachment", files.getValue("attachment.csv.json").appProperties["entityType"])
        assertEquals("attachmentBlob", files.getValue("attachment.csv").appProperties["entityType"])
        assertTrue(
            fixture.transport.requests
                .mapNotNull { queryParameter(it.url, "fields") }
                .all { "appProperties" in it },
        )
    }

    @Test
    fun readJsonReturnsValidatedJsonAndUsesExactInMemoryToken() = runTest {
        val fixture = Fixture()
        fixture.transport.add(FakeNode.folder("workspace", DEFAULT_NAME))
        fixture.transport.add(FakeNode.manifest("manifest", "workspace"))
        fixture.transport.add(FakeNode.folder("devices", "devices", "workspace"))
        fixture.transport.add(FakeNode.json("device", "device.json", "devices", "{\"id\":\"device-a\"}"))

        val raw = fixture.repository.readJson(ACCOUNT_A, "devices/device.json").getOrThrow()

        assertEquals("{\"id\":\"device-a\"}", raw)
        assertTrue(fixture.transport.requests.all { it.method == "GET" })
        assertTrue(fixture.transport.authorizationHeaders().all { it == "Bearer exact-drive-file-token-a" })
    }

    @Test
    fun readJsonRejectsNonJsonFoldersAndOversizedResponses() = runTest {
        val fixture = Fixture(maxJsonBytes = 100)
        fixture.transport.add(FakeNode.folder("workspace", DEFAULT_NAME))
        fixture.transport.add(FakeNode.manifest("manifest", "workspace"))
        fixture.transport.add(FakeNode.folder("entries", "entries", "workspace"))
        fixture.transport.add(FakeNode.folder("json-folder", "folder.json", "entries"))
        fixture.transport.add(FakeNode("text", "text.json", "entries", "text/plain", body = "{}"))
        fixture.transport.add(FakeNode.json("large", "large.json", "entries", "{\"value\":\"${"x".repeat(120)}\"}"))

        assertTrue(
            fixture.repository.readJson(ACCOUNT_A, "entries/folder.json").exceptionOrNull() is DriveProtocolException,
        )
        assertTrue(
            fixture.repository.readJson(ACCOUNT_A, "entries/text.json").exceptionOrNull() is DriveProtocolException,
        )
        assertTrue(
            fixture.repository.readJson(ACCOUNT_A, "entries/large.json").exceptionOrNull() is DriveProtocolException,
        )
    }

    @Test
    fun missingTokenFailsAsSignInRequiredBeforeHttp() = runTest {
        val fixture = Fixture(tokens = emptyMap())

        val error = fixture.repository.listManagedFiles(ACCOUNT_A).exceptionOrNull()

        assertTrue(error is DriveSignInRequiredException)
        assertTrue(fixture.transport.requests.isEmpty())
    }

    @Test
    fun unauthorizedAndTransientHttpFailuresKeepTypedSemantics() = runTest {
        for (status in listOf(401, 408, 429, 503)) {
            val fixture = Fixture()
            fixture.transport.forcedStatus = status

            val error = fixture.repository.listManagedFiles(ACCOUNT_A).exceptionOrNull()

            assertTrue("status $status", error is DriveHttpException)
            error as DriveHttpException
            assertEquals(status, error.statusCode)
            assertEquals(status == 408 || status == 429 || status == 503, error.retryable)
        }
    }

    @Test
    fun forbiddenRetryabilityUsesDocumentedReasonAndRetainsBoundedBody() = runTest {
        val transientBody = googleErrorBody("userRateLimitExceeded")
        val transientFixture = Fixture()
        transientFixture.transport.forcedResponse = DriveHttpResponse(
            statusCode = 403,
            body = transientBody.toByteArray(),
        )

        val transientError = transientFixture.repository.listManagedFiles(ACCOUNT_A).exceptionOrNull()
            as DriveHttpException

        assertEquals("userRateLimitExceeded", transientError.reason)
        assertEquals(transientBody, transientError.responseBody)
        assertTrue(transientError.retryable)
        assertFalse(transientError.message.orEmpty().contains(transientBody))

        val permanentFixture = Fixture()
        permanentFixture.transport.forcedResponse = DriveHttpResponse(
            statusCode = 403,
            body = googleErrorBody("insufficientFilePermissions").toByteArray(),
        )

        val permanentError = permanentFixture.repository.listManagedFiles(ACCOUNT_A).exceptionOrNull()
            as DriveHttpException

        assertEquals("insufficientFilePermissions", permanentError.reason)
        assertFalse(permanentError.retryable)

        val oversizedFixture = Fixture()
        oversizedFixture.transport.forcedResponse = DriveHttpResponse(
            statusCode = 403,
            body = (googleErrorBody("rateLimitExceeded") + "x".repeat(20 * 1024)).toByteArray(),
        )

        val oversizedError = oversizedFixture.repository.listManagedFiles(ACCOUNT_A).exceptionOrNull()
            as DriveHttpException

        assertTrue(oversizedError.responseBody.orEmpty().toByteArray().size <= 16 * 1024)
    }

    @Test
    fun persistedRootIdsAreIsolatedByAccount() = runTest {
        val fixture = Fixture(
            tokens = mapOf(
                ACCOUNT_A to "exact-drive-file-token-a",
                ACCOUNT_B to "exact-drive-file-token-b",
            ),
        )
        fixture.store.set(ACCOUNT_A, "root-a")
        fixture.store.set(ACCOUNT_B, "root-b")
        fixture.transport.add(FakeNode.folder("root-a", "Renamed A"))
        fixture.transport.add(FakeNode.manifest("manifest-a", "root-a"))
        fixture.transport.add(FakeNode.folder("root-b", "Renamed B"))
        fixture.transport.add(FakeNode.manifest("manifest-b", "root-b"))

        assertEquals("manifest-a", fixture.repository.listManagedFiles(ACCOUNT_A).getOrThrow().single().id)
        assertEquals("manifest-b", fixture.repository.listManagedFiles(ACCOUNT_B).getOrThrow().single().id)
        assertEquals("root-a", fixture.store.get(ACCOUNT_A))
        assertEquals("root-b", fixture.store.get(ACCOUNT_B))
        assertTrue(fixture.transport.authorizationHeaders().contains("Bearer exact-drive-file-token-a"))
        assertTrue(fixture.transport.authorizationHeaders().contains("Bearer exact-drive-file-token-b"))
    }

    private class Fixture(
        tokens: Map<AccountId, String> = mapOf(ACCOUNT_A to "exact-drive-file-token-a"),
        folderName: String = DEFAULT_NAME,
        pageSize: Int = Int.MAX_VALUE,
        maxJsonBytes: Int = 5 * 1024 * 1024,
    ) {
        val auth = FakeAuthRepository(tokens)
        val store = FakeRootFolderIdStore()
        val transport = FakeDriveTransport(pageSize)
        val repository = GoogleDriveReadOnlyRepository(
            authRepository = auth,
            rootFolderIds = store,
            transport = transport,
            folderName = folderName,
            maxJsonBytes = maxJsonBytes,
        )
    }

    private class FakeAuthRepository(private val tokens: Map<AccountId, String>) : AuthRepository {
        private val mutableSession = MutableStateFlow<AuthSession?>(null)
        private val mutableDriveAccess = MutableStateFlow<DriveAccessState>(DriveAccessState.SignedOut)
        override val session: StateFlow<AuthSession?> = mutableSession
        override val driveAccess: StateFlow<DriveAccessState> = mutableDriveAccess
        override suspend fun restore() = Unit
        override suspend fun connect(): Result<AuthSession> = Result.failure(UnsupportedOperationException())
        override suspend fun disconnect() = Unit
        override suspend fun invalidateAccessToken(accountId: AccountId) = Unit
        override fun accessToken(accountId: AccountId): String? = tokens[accountId]
    }

    private class FakeRootFolderIdStore : DriveRootFolderIdStore {
        private val values = mutableMapOf<AccountId, String>()
        override fun get(accountId: AccountId): String? = values[accountId]
        override fun set(accountId: AccountId, folderId: String?) {
            if (folderId == null) values.remove(accountId) else values[accountId] = folderId
        }
    }

    private data class FakeNode(
        val id: String,
        val name: String,
        val parentId: String? = null,
        val mimeType: String = FOLDER_MIME,
        val trashed: Boolean = false,
        val body: String? = null,
        val declaredSize: Long? = body?.toByteArray()?.size?.toLong(),
        val appProperties: Map<String, String> = emptyMap(),
    ) {
        companion object {
            fun folder(id: String, name: String, parentId: String? = null) =
                FakeNode(id, name, parentId)

            fun json(
                id: String,
                name: String,
                parentId: String,
                body: String,
                appProperties: Map<String, String> = emptyMap(),
            ) = FakeNode(
                id = id,
                name = name,
                parentId = parentId,
                mimeType = "application/json",
                body = body,
                appProperties = appProperties,
            )

            fun manifest(id: String, parentId: String) = json(
                id,
                "manifest.json",
                parentId,
                VALID_MANIFEST,
            )
        }
    }

    private class FakeDriveTransport(private val pageSize: Int) : DriveReadOnlyTransport {
        val requests = mutableListOf<DriveHttpRequest>()
        private val nodes = linkedMapOf<String, FakeNode>()
        var forcedStatus: Int? = null
        var forcedResponse: DriveHttpResponse? = null

        fun add(node: FakeNode) {
            nodes[node.id] = node
        }

        override suspend fun execute(request: DriveHttpRequest): DriveHttpResponse {
            requests += request
            forcedResponse?.let { return it }
            forcedStatus?.let { return DriveHttpResponse(it) }
            check(request.method == "GET")
            val uri = URI(request.url)
            val id = uri.path.substringAfterLast("files/").takeIf { uri.path.contains("files/") }
            val alt = queryParameter(request.url, "alt")
            if (id != null && alt == "media") {
                val node = nodes[id] ?: return DriveHttpResponse(404)
                return DriveHttpResponse(200, body = node.body.orEmpty().toByteArray())
            }
            if (id != null) {
                val node = nodes[id] ?: return DriveHttpResponse(404)
                return DriveHttpResponse(200, body = nodeJson(node).toByteArray())
            }

            val query = queryParameter(request.url, "q").orEmpty()
            val parentId = parentFrom(query)
            var matches = nodes.values.filter { node ->
                val parentMatches = if (parentId == "root") node.parentId == null else node.parentId == parentId
                parentMatches && (!query.contains("trashed = false") || !node.trashed)
            }
            nameFrom(query)?.let { name -> matches = matches.filter { it.name == name } }
            if (query.contains("mimeType = '$FOLDER_MIME'")) matches = matches.filter { it.mimeType == FOLDER_MIME }
            if (query.contains("mimeType != '$FOLDER_MIME'")) matches = matches.filter { it.mimeType != FOLDER_MIME }

            val offset = queryParameter(request.url, "pageToken")?.toIntOrNull() ?: 0
            val end = minOf(matches.size, offset + pageSize)
            val page = if (offset >= matches.size) emptyList() else matches.subList(offset, end)
            val body = buildJsonObject {
                put("files", buildJsonArray { page.forEach { add(Json.parseToJsonElement(nodeJson(it))) } })
                if (end < matches.size) put("nextPageToken", end.toString())
            }.toString()
            return DriveHttpResponse(200, body = body.toByteArray())
        }

        fun decodedQueries(): List<String> = requests.mapNotNull { queryParameter(it.url, "q") }
        fun authorizationHeaders(): List<String> = requests.mapNotNull { it.headers["Authorization"] }

        private fun nodeJson(node: FakeNode): String = buildJsonObject {
            put("id", node.id)
            put("name", node.name)
            put("mimeType", node.mimeType)
            put("modifiedTime", "2026-07-16T12:00:00Z")
            node.declaredSize?.let { put("size", it.toString()) }
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

    companion object {
        private val ACCOUNT_A = AccountId("account-a")
        private val ACCOUNT_B = AccountId("account-b")
        private const val DEFAULT_NAME = "Easylab Lab Notebook"
        private const val FOLDER_MIME = "application/vnd.google-apps.folder"
        private const val VALID_MANIFEST =
            "{\"version\":1,\"provider\":\"google-drive\",\"rootFolderName\":\"Easylab Lab Notebook\"}"

        private fun googleErrorBody(reason: String): String = buildJsonObject {
            put("error", buildJsonObject {
                put("code", 403)
                put("message", "Drive request rejected")
                put("errors", buildJsonArray {
                    add(buildJsonObject {
                        put("domain", "usageLimits")
                        put("reason", reason)
                        put("message", "Drive request rejected")
                    })
                })
            })
        }.toString()

        private fun queryParameter(url: String, name: String): String? = URI(url).rawQuery
            ?.split('&')
            ?.mapNotNull { part ->
                val pieces = part.split('=', limit = 2)
                if (pieces.size != 2) null else decode(pieces[0]) to decode(pieces[1])
            }
            ?.firstOrNull { it.first == name }
            ?.second

        private fun decode(value: String): String =
            URLDecoder.decode(value, StandardCharsets.UTF_8.name())
    }
}
