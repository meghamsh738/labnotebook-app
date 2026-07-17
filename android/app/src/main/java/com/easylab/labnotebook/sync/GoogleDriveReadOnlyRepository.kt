package com.easylab.labnotebook.sync

import android.content.Context
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveHttpException
import com.easylab.labnotebook.data.repository.DriveProtocolException
import com.easylab.labnotebook.data.repository.DriveRepository
import com.easylab.labnotebook.data.repository.DriveSignInRequiredException
import com.easylab.labnotebook.data.repository.DriveWriteCapability
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Stores only an account-scoped Drive folder id. OAuth tokens must never be stored here. */
interface DriveRootFolderIdStore {
    fun get(accountId: AccountId): String?
    fun set(accountId: AccountId, folderId: String?)
}

class SharedPreferencesDriveRootFolderIdStore(context: Context) : DriveRootFolderIdStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        "easylab-drive-read-only",
        Context.MODE_PRIVATE,
    )

    override fun get(accountId: AccountId): String? =
        preferences.getString(key(accountId), null)?.takeIf(String::isNotBlank)

    override fun set(accountId: AccountId, folderId: String?) {
        preferences.edit().apply {
            if (folderId.isNullOrBlank()) remove(key(accountId)) else putString(key(accountId), folderId)
        }.apply()
    }

    private fun key(accountId: AccountId): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(accountId.value.toByteArray(StandardCharsets.UTF_8))
        return "root-folder:${digest.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }}"
    }
}

internal class InMemoryDriveRootFolderIdStore : DriveRootFolderIdStore {
    private val values = mutableMapOf<String, String>()

    override fun get(accountId: AccountId): String? = values[accountId.value]

    override fun set(accountId: AccountId, folderId: String?) {
        if (folderId.isNullOrBlank()) values.remove(accountId.value) else values[accountId.value] = folderId
    }
}

internal data class DriveHttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: ByteArray? = null,
)

internal data class DriveHttpResponse(
    val statusCode: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray = byteArrayOf(),
)

internal fun interface DriveReadOnlyTransport {
    suspend fun execute(request: DriveHttpRequest): DriveHttpResponse
}

internal class HttpUrlConnectionDriveReadOnlyTransport(
    private val connectTimeoutMillis: Int = 15_000,
    private val readTimeoutMillis: Int = 30_000,
    private val maxResponseBytes: Int = 8 * 1024 * 1024,
) : DriveReadOnlyTransport {
    override suspend fun execute(request: DriveHttpRequest): DriveHttpResponse = withContext(Dispatchers.IO) {
        require(request.method == "GET") { "Read-only Drive transport accepts GET requests only." }
        val connection = URI(request.url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = connectTimeoutMillis
            connection.readTimeout = readTimeoutMillis
            connection.instanceFollowRedirects = false
            request.headers.forEach(connection::setRequestProperty)

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > maxResponseBytes) {
                        throw DriveProtocolException("Google Drive response exceeded the safe size limit.")
                    }
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            } ?: byteArrayOf()
            DriveHttpResponse(
                statusCode = status,
                headers = connection.headerFields
                    .filterKeys { it != null }
                    .mapValues { (_, values) -> values.orEmpty().joinToString(",") },
                body = body,
            )
        } catch (error: DriveProtocolException) {
            throw error
        } catch (error: IOException) {
            throw error
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * Native Drive v3 transport that can discover and read an existing Easylab workspace.
 * Every remote operation is GET-only; all DriveRepository write methods fail before transport use.
 */
class GoogleDriveReadOnlyRepository internal constructor(
    private val authRepository: AuthRepository,
    private val rootFolderIds: DriveRootFolderIdStore = InMemoryDriveRootFolderIdStore(),
    private val transport: DriveReadOnlyTransport = HttpUrlConnectionDriveReadOnlyTransport(),
    private val folderName: String = DEFAULT_ROOT_FOLDER_NAME,
    private val maxJsonBytes: Int = DEFAULT_MAX_JSON_BYTES,
) : DriveRepository {
    constructor(context: Context, authRepository: AuthRepository) : this(
        authRepository = authRepository,
        rootFolderIds = SharedPreferencesDriveRootFolderIdStore(context),
    )

    init {
        require(folderName.isNotBlank()) { "Drive root folder name must not be blank." }
        require(maxJsonBytes > 0) { "Maximum JSON response size must be positive." }
    }

    override val writeCapability = DriveWriteCapability.DisabledPendingContractParity

    override suspend fun listManagedFiles(
        accountId: AccountId,
        prefix: String?,
    ): Result<List<DriveFileRef>> = driveResult {
        val token = accessToken(accountId)
        val rootId = resolveRootFolder(accountId, token)
        val files = mutableListOf<DriveFileRef>()
        val visitedFolders = mutableSetOf<String>()
        listDescendants(token, rootId, "", visitedFolders, files)
        files.asSequence()
            .filter { isManagedPath(it.path) }
            .filter { prefix == null || it.path.startsWith(prefix) }
            .sortedBy(DriveFileRef::path)
            .toList()
    }

    override suspend fun readJson(accountId: AccountId, path: String): Result<String?> = driveResult {
        if (!isManagedJsonPath(path) || path.split('/').any { it.isBlank() || it == "." || it == ".." }) {
            throw DriveProtocolException("Drive JSON path is outside the managed read-only workspace: $path")
        }
        val token = accessToken(accountId)
        val rootId = resolveRootFolder(accountId, token)
        val matches = findItemsAtPath(token, rootId, path)
        if (matches.size > 1) {
            throw DriveProtocolException("Drive workspace contains duplicate managed path: $path")
        }
        val item = matches.singleOrNull() ?: return@driveResult null
        if (item.mimeType == FOLDER_MIME_TYPE) {
            throw DriveProtocolException("Drive JSON path resolves to a folder: $path")
        }
        if (!isJsonMimeType(item.mimeType)) {
            throw DriveProtocolException("Drive file is not JSON: $path")
        }
        if (item.size != null && item.size > maxJsonBytes) {
            throw DriveProtocolException("Drive JSON file exceeds the safe size limit: $path")
        }

        val response = request(token, mediaUrl(item.id))
        response.header("Content-Length")?.toLongOrNull()?.let { length ->
            if (length > maxJsonBytes) {
                throw DriveProtocolException("Drive JSON response exceeds the safe size limit: $path")
            }
        }
        if (response.body.size > maxJsonBytes) {
            throw DriveProtocolException("Drive JSON response exceeds the safe size limit: $path")
        }
        val raw = response.body.toString(StandardCharsets.UTF_8)
        try {
            JSON.parseToJsonElement(raw)
        } catch (error: Exception) {
            throw DriveProtocolException("Drive file contains invalid JSON: $path", error)
        }
        raw
    }

    override suspend fun putJson(
        accountId: AccountId,
        path: String,
        json: String,
    ): Result<DriveFileRef> = writeDisabled()

    override suspend fun putBlob(
        accountId: AccountId,
        path: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String,
    ): Result<DriveFileRef> = writeDisabled()

    private fun <T> writeDisabled(): Result<T> = Result.failure(
        DriveProtocolException("Native Google Drive transport is read-only; writes are disabled."),
    )

    internal suspend fun resolveExistingRootFolderId(accountId: AccountId): String? =
        findExistingRootFolder(accountId, accessToken(accountId))

    private suspend fun resolveRootFolder(accountId: AccountId, token: String): String =
        findExistingRootFolder(accountId, token) ?: throw DriveProtocolException(
            "No readable Easylab Drive workspace was found. " +
                "Create or connect it from a write-capable Easylab client first.",
        )

    private suspend fun findExistingRootFolder(accountId: AccountId, token: String): String? {
        val candidatesById = linkedMapOf<String, DriveItem>()
        rootFolderIds.get(accountId)?.let { savedId ->
            val savedRoot = try {
                getMetadata(token, savedId).takeIf { metadata ->
                    metadata.id == savedId && metadata.mimeType == FOLDER_MIME_TYPE && !metadata.trashed
                }
            } catch (error: DriveHttpException) {
                if (error.statusCode == 404) null else throw error
            }
            if (savedRoot == null) {
                rootFolderIds.set(accountId, null)
            } else {
                candidatesById[savedRoot.id] = savedRoot
            }
        }

        val query = "'root' in parents and name = '${escapeDriveQuery(folderName)}' and " +
            "mimeType = '$FOLDER_MIME_TYPE' and trashed = false"
        listFiles(token, query).forEach { candidate -> candidatesById[candidate.id] = candidate }
        val manifestRoots = mutableListOf<DriveItem>()
        val emptyRoots = mutableListOf<DriveItem>()
        for (candidate in candidatesById.values) {
            when {
                hasValidManifest(token, candidate.id) -> manifestRoots += candidate
                candidate.name == folderName && isUninitializedManagedRoot(token, candidate.id) ->
                    emptyRoots += candidate
            }
        }

        val root = when {
            manifestRoots.size > 1 -> throw DriveProtocolException(
                "Multiple Easylab Drive workspaces were found. Choose the intended notebook before syncing.",
            )
            manifestRoots.size == 1 -> manifestRoots.single()
            emptyRoots.size > 1 -> throw DriveProtocolException(
                "Multiple empty Easylab Drive folders were found. Remove the duplicates before syncing.",
            )
            emptyRoots.size == 1 -> emptyRoots.single()
            else -> null
        }
        rootFolderIds.set(accountId, root?.id)
        return root?.id
    }

    private suspend fun hasValidManifest(token: String, folderId: String): Boolean {
        val query = "'${escapeDriveQuery(folderId)}' in parents and name = 'manifest.json' and " +
            "mimeType != '$FOLDER_MIME_TYPE' and trashed = false"
        for (manifest in listFiles(token, query)) {
            if (!isJsonMimeType(manifest.mimeType)) continue
            if (manifest.size != null && manifest.size > maxJsonBytes) continue
            val valid = try {
                val response = request(token, mediaUrl(manifest.id))
                if (response.body.size > maxJsonBytes) continue
                val value = JSON.parseToJsonElement(response.body.toString(StandardCharsets.UTF_8)).jsonObject
                value["version"]?.jsonPrimitive?.intOrNull == 1 &&
                    value["provider"]?.jsonPrimitive?.contentOrNull == "google-drive" &&
                    !value["rootFolderName"]?.jsonPrimitive?.contentOrNull.isNullOrBlank()
            } catch (error: DriveHttpException) {
                if (error.statusCode == 404) false else throw error
            } catch (_: IllegalArgumentException) {
                false
            }
            if (valid) return true
        }
        return false
    }

    private suspend fun isUninitializedManagedRoot(token: String, folderId: String): Boolean {
        val children = listChildren(token, folderId)
        if (children.isEmpty()) return true
        if (children.any { it.mimeType != FOLDER_MIME_TYPE || it.name !in MANAGED_ROOT_FOLDERS }) return false
        for (child in children) {
            if (listChildren(token, child.id).isNotEmpty()) return false
        }
        return true
    }

    private suspend fun listDescendants(
        token: String,
        folderId: String,
        parentPath: String,
        visitedFolders: MutableSet<String>,
        output: MutableList<DriveFileRef>,
    ) {
        if (!visitedFolders.add(folderId)) return
        for (child in listChildren(token, folderId)) {
            val path = if (parentPath.isEmpty()) child.name else "$parentPath/${child.name}"
            if (child.mimeType == FOLDER_MIME_TYPE) {
                listDescendants(token, child.id, path, visitedFolders, output)
            } else {
                output += DriveFileRef(
                    id = child.id,
                    path = path,
                    name = child.name,
                    mimeType = child.mimeType,
                    size = child.size,
                    updatedAt = child.modifiedTime ?: UNKNOWN_MODIFIED_TIME,
                    appProperties = child.appProperties,
                    version = child.version,
                )
            }
        }
    }

    private suspend fun listChildren(token: String, folderId: String): List<DriveItem> = listFiles(
        token,
        "'${escapeDriveQuery(folderId)}' in parents and trashed = false",
    )

    private suspend fun findItemsAtPath(token: String, rootId: String, path: String): List<DriveItem> {
        var parentIds = listOf(rootId)
        val segments = path.split('/')
        for ((index, segment) in segments.withIndex()) {
            val matches = parentIds.flatMap { parentId ->
                listFiles(
                    token,
                    "'${escapeDriveQuery(parentId)}' in parents and " +
                        "name = '${escapeDriveQuery(segment)}' and trashed = false",
                )
            }
            if (index == segments.lastIndex) return matches
            parentIds = matches.filter { it.mimeType == FOLDER_MIME_TYPE }.map(DriveItem::id)
            if (parentIds.isEmpty()) return emptyList()
        }
        return emptyList()
    }

    private suspend fun listFiles(token: String, query: String): List<DriveItem> {
        val output = mutableListOf<DriveItem>()
        var pageToken: String? = null
        val seenPageTokens = mutableSetOf<String>()
        do {
            val parameters = linkedMapOf(
                "q" to query,
                "fields" to "nextPageToken,files(id,name,mimeType,modifiedTime,size,version,trashed,appProperties)",
                "pageSize" to "1000",
            )
            pageToken?.let { parameters["pageToken"] = it }
            val response = request(token, apiUrl("files", parameters))
            val objectValue = parseObject(response.body, "Drive file listing")
            val files = objectValue["files"] as? JsonArray ?: JsonArray(emptyList())
            files.forEach { output += it.toDriveItem() }
            pageToken = objectValue["nextPageToken"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
            if (pageToken != null && !seenPageTokens.add(pageToken)) {
                throw DriveProtocolException("Google Drive pagination returned a repeated page token.")
            }
        } while (pageToken != null)
        return output
    }

    private suspend fun getMetadata(token: String, fileId: String): DriveItem {
        val response = request(
            token,
            apiUrl(
                "files/${encodePathSegment(fileId)}",
                mapOf("fields" to "id,name,mimeType,modifiedTime,size,version,trashed,appProperties"),
            ),
        )
        return parseObject(response.body, "Drive file metadata").toDriveItem()
    }

    private suspend fun request(token: String, url: String): DriveHttpResponse {
        val response = transport.execute(
            DriveHttpRequest(
                method = "GET",
                url = url,
                headers = mapOf("Authorization" to "Bearer $token", "Accept" to "application/json"),
            ),
        )
        if (response.statusCode !in 200..299) {
            val responseBody = response.body
                .copyOf(minOf(response.body.size, MAX_RETAINED_ERROR_BODY_BYTES))
                .toString(StandardCharsets.UTF_8)
            throw DriveHttpException(
                statusCode = response.statusCode,
                message = "Google Drive request failed with HTTP ${response.statusCode}.",
                reason = driveErrorReason(responseBody),
                responseBody = responseBody.takeIf(String::isNotBlank),
            )
        }
        return response
    }

    private fun driveErrorReason(responseBody: String): String? = try {
        val error = JSON.parseToJsonElement(responseBody).jsonObject["error"]?.jsonObject ?: return null
        val reasons = error["errors"] as? JsonArray ?: return null
        reasons.firstNotNullOfOrNull { item ->
            item.jsonObject["reason"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
        }
    } catch (_: Exception) {
        null
    }

    private fun accessToken(accountId: AccountId): String =
        authRepository.accessToken(accountId)?.takeIf(String::isNotBlank)
            ?: throw DriveSignInRequiredException()

    private fun mediaUrl(fileId: String): String =
        apiUrl("files/${encodePathSegment(fileId)}", mapOf("alt" to "media"))

    private fun apiUrl(path: String, parameters: Map<String, String>): String {
        val query = parameters.entries.joinToString("&") { (key, value) ->
            "${urlEncode(key)}=${urlEncode(value)}"
        }
        return "$DRIVE_API_BASE/$path?$query"
    }

    private fun parseObject(bytes: ByteArray, label: String): JsonObject = try {
        JSON.parseToJsonElement(bytes.toString(StandardCharsets.UTF_8)).jsonObject
    } catch (error: Exception) {
        throw DriveProtocolException("$label returned invalid JSON.", error)
    }

    private fun JsonElement.toDriveItem(): DriveItem {
        val value = try {
            jsonObject
        } catch (error: IllegalArgumentException) {
            throw DriveProtocolException("Drive returned malformed file metadata.", error)
        }
        val id = value["id"]?.jsonPrimitive?.contentOrNull
        val name = value["name"]?.jsonPrimitive?.contentOrNull
        if (id.isNullOrBlank() || name.isNullOrBlank()) {
            throw DriveProtocolException("Drive file metadata omitted an id or name.")
        }
        return DriveItem(
            id = id,
            name = name,
            mimeType = value["mimeType"]?.jsonPrimitive?.contentOrNull,
            modifiedTime = value["modifiedTime"]?.jsonPrimitive?.contentOrNull,
            size = value["size"]?.jsonPrimitive?.longOrNull,
            version = value["version"]?.jsonPrimitive?.longOrNull,
            trashed = value["trashed"]?.jsonPrimitive?.booleanOrNull == true,
            appProperties = (value["appProperties"] as? JsonObject)
                ?.mapValues { (_, property) -> property.jsonPrimitive.content }
                .orEmpty(),
        )
    }

    private fun JsonObject.toDriveItem(): DriveItem = (this as JsonElement).toDriveItem()

    private fun DriveHttpResponse.header(name: String): String? =
        headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    private fun isManagedPath(path: String): Boolean =
        path == MANIFEST_PATH || MANAGED_PREFIXES.any(path::startsWith)

    private fun isManagedJsonPath(path: String): Boolean =
        isManagedPath(path) && path.endsWith(".json", ignoreCase = true)

    private fun isJsonMimeType(mimeType: String?): Boolean {
        val normalized = mimeType?.substringBefore(';')?.trim()?.lowercase() ?: return false
        return normalized == "application/json" || normalized == "text/json" || normalized.endsWith("+json")
    }

    private suspend fun <T> driveResult(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }

    private data class DriveItem(
        val id: String,
        val name: String,
        val mimeType: String?,
        val modifiedTime: String?,
        val size: Long?,
        val version: Long?,
        val trashed: Boolean,
        val appProperties: Map<String, String> = emptyMap(),
    )

    companion object {
        const val DEFAULT_ROOT_FOLDER_NAME = "Easylab Lab Notebook"
        const val DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024
        private const val DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
        private const val MAX_RETAINED_ERROR_BODY_BYTES = 16 * 1024
        private const val FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
        private const val MANIFEST_PATH = "manifest.json"
        private const val UNKNOWN_MODIFIED_TIME = "1970-01-01T00:00:00Z"
        private val JSON = Json { ignoreUnknownKeys = true }
        private val MANAGED_PREFIXES = listOf(
            "devices/",
            "entries/",
            "attachments/",
            "filebox/",
            "transfers/",
            "conflicts/",
            "tombstones/",
        )
        private val MANAGED_ROOT_FOLDERS = MANAGED_PREFIXES.map { it.removeSuffix("/") }.toSet()

        internal fun escapeDriveQuery(value: String): String =
            value.replace("\\", "\\\\").replace("'", "\\'")

        private fun urlEncode(value: String): String =
            URLEncoder.encode(value, StandardCharsets.UTF_8.name())

        private fun encodePathSegment(value: String): String = urlEncode(value).replace("+", "%20")
    }
}
