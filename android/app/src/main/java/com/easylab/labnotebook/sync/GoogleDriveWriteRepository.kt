package com.easylab.labnotebook.sync

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
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** HTTP transport used only by the unwired native writer and its contract tests. */
internal interface DriveWriteTransport : DriveReadOnlyTransport

internal class HttpUrlConnectionDriveWriteTransport(
    private val connectTimeoutMillis: Int = 15_000,
    private val readTimeoutMillis: Int = 60_000,
    private val maxResponseBytes: Int = 8 * 1024 * 1024,
) : DriveWriteTransport {
    override suspend fun execute(request: DriveHttpRequest): DriveHttpResponse = withContext(Dispatchers.IO) {
        require(request.method in setOf("GET", "POST", "PATCH")) {
            "Drive write transport accepts GET, POST, and PATCH requests only."
        }
        val connection = URI(request.url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.connectTimeout = connectTimeoutMillis
            connection.readTimeout = readTimeoutMillis
            connection.instanceFollowRedirects = false
            request.headers.forEach(connection::setRequestProperty)
            request.body?.let { body ->
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { output -> output.write(body) }
            }

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
 * Tested native Drive writer. Production dependency injection deliberately continues to use
 * [GoogleDriveReadOnlyRepository] until lossless serialization and conflict gates are complete.
 */
internal class GoogleDriveWriteRepository(
    private val authRepository: AuthRepository,
    private val rootFolderIds: DriveRootFolderIdStore = InMemoryDriveRootFolderIdStore(),
    private val transport: DriveWriteTransport = HttpUrlConnectionDriveWriteTransport(),
    private val folderName: String = GoogleDriveReadOnlyRepository.DEFAULT_ROOT_FOLDER_NAME,
    private val maxJsonBytes: Int = GoogleDriveReadOnlyRepository.DEFAULT_MAX_JSON_BYTES,
    private val maxBlobBytes: Int = DEFAULT_MAX_BLOB_BYTES,
    private val boundaryFactory: () -> String = { "easylab-${UUID.randomUUID()}" },
) : DriveRepository {
    private val writeMutex = Mutex()
    private val reader = GoogleDriveReadOnlyRepository(
        authRepository = authRepository,
        rootFolderIds = rootFolderIds,
        transport = transport,
        folderName = folderName,
        maxJsonBytes = maxJsonBytes,
    )

    init {
        require(folderName.isNotBlank()) { "Drive root folder name must not be blank." }
        require(maxJsonBytes > 0) { "Maximum JSON size must be positive." }
        require(maxBlobBytes > 0) { "Maximum blob size must be positive." }
    }

    override val writeCapability = DriveWriteCapability.Enabled

    override suspend fun listManagedFiles(
        accountId: AccountId,
        prefix: String?,
    ): Result<List<DriveFileRef>> = reader.listManagedFiles(accountId, prefix)

    override suspend fun readJson(accountId: AccountId, path: String): Result<String?> =
        reader.readJson(accountId, path)

    override suspend fun putJson(
        accountId: AccountId,
        path: String,
        json: String,
    ): Result<DriveFileRef> = driveResult {
        writeMutex.withLock {
            val segments = requireManagedPath(path, requireJson = true)
            val bytes = json.toByteArray(StandardCharsets.UTF_8)
            if (bytes.size > maxJsonBytes) {
                throw DriveProtocolException("Drive JSON exceeds the safe size limit: $path")
            }
            val value = try {
                JSON.parseToJsonElement(json)
            } catch (error: Exception) {
                throw DriveProtocolException("Drive JSON is invalid: $path", error)
            }
            if (value !is JsonObject) {
                throw DriveProtocolException("Drive managed JSON must contain an object: $path")
            }
            val token = accessToken(accountId)
            val rootId = resolveOrCreateRoot(accountId, token)
            val parentId = ensureFolders(token, rootId, segments.dropLast(1))
            upsertMedia(
                token = token,
                parentId = parentId,
                path = path,
                name = segments.last(),
                mimeType = JSON_MIME_TYPE,
                content = bytes,
                appProperties = jsonAppProperties(path, value),
                requireExistingMimeType = ::isJsonMimeType,
            )
        }
    }

    override suspend fun putBlob(
        accountId: AccountId,
        path: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String,
    ): Result<DriveFileRef> = driveResult {
        writeMutex.withLock {
            val segments = requireManagedBlobPath(path)
            if (bytes.size > maxBlobBytes) {
                throw DriveProtocolException("Drive blob exceeds the safe size limit: $path")
            }
            val normalizedMimeType = mimeType.substringBefore(';').trim().lowercase()
            if (normalizedMimeType.isBlank() || '/' !in normalizedMimeType) {
                throw DriveProtocolException("Drive blob MIME type is invalid: $path")
            }
            if (!SHA256_REGEX.matches(sha256)) {
                throw DriveProtocolException("Drive blob SHA-256 is invalid: $path")
            }
            val actualSha256 = sha256(bytes)
            if (!actualSha256.equals(sha256, ignoreCase = true)) {
                throw DriveProtocolException("Drive blob SHA-256 does not match its bytes: $path")
            }
            val token = accessToken(accountId)
            val rootId = resolveOrCreateRoot(accountId, token)
            val parentId = ensureFolders(token, rootId, segments.dropLast(1))
            upsertMedia(
                token = token,
                parentId = parentId,
                path = path,
                name = segments.last(),
                mimeType = normalizedMimeType,
                content = bytes,
                appProperties = mapOf(
                    "entityType" to "attachmentBlob",
                    "sha256" to actualSha256,
                ),
            )
        }
    }

    private suspend fun resolveOrCreateRoot(accountId: AccountId, token: String): String {
        rootFolderIds.get(accountId)?.let { savedId ->
            val cached = try {
                getMetadata(token, savedId)
            } catch (error: DriveHttpException) {
                if (error.statusCode == 404) null else throw error
            }
            if (
                cached != null && cached.mimeType == FOLDER_MIME_TYPE && !cached.trashed &&
                cached.name == folderName
            ) {
                return cached.id
            }
            if (cached == null || cached.mimeType != FOLDER_MIME_TYPE || cached.trashed) {
                rootFolderIds.set(accountId, null)
            }
        }

        reader.resolveExistingRootFolderId(accountId)?.let { return it }
        val created = createFolder(token, folderName)
        rootFolderIds.set(accountId, created.id)
        return created.id
    }

    private suspend fun ensureFolders(
        token: String,
        rootId: String,
        pathSegments: List<String>,
    ): String {
        var parentId = rootId
        for (segment in pathSegments) {
            val matches = findChildren(token, parentId, segment)
            if (matches.size > 1) {
                throw DriveProtocolException("Drive workspace contains duplicate managed folder: $segment")
            }
            parentId = when (val existing = matches.singleOrNull()) {
                null -> createFolder(token, segment, parentId).id
                else -> {
                    if (existing.mimeType != FOLDER_MIME_TYPE) {
                        throw DriveProtocolException("Drive managed folder path is occupied by a file: $segment")
                    }
                    existing.id
                }
            }
        }
        return parentId
    }

    private suspend fun createFolder(token: String, name: String, parentId: String? = null): DriveItem {
        val metadata = buildJsonObject {
            put("name", name)
            put("mimeType", FOLDER_MIME_TYPE)
            parentId?.let { parent ->
                put("parents", buildJsonArray { add(JsonPrimitive(parent)) })
            }
        }.toString().toByteArray(StandardCharsets.UTF_8)
        return request(
            token = token,
            method = "POST",
            url = apiUrl("files", mapOf("fields" to FILE_FIELDS)),
            headers = mapOf("Content-Type" to "application/json; charset=UTF-8"),
            body = metadata,
        ).toDriveItem("Drive folder creation")
    }

    private suspend fun upsertMedia(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        appProperties: Map<String, String>,
        requireExistingMimeType: ((String?) -> Boolean)? = null,
    ): DriveFileRef {
        val matches = findChildren(token, parentId, name)
        if (matches.size > 1) {
            throw DriveProtocolException("Drive workspace contains duplicate managed path: $path")
        }
        val existing = matches.singleOrNull()
        if (existing?.mimeType == FOLDER_MIME_TYPE) {
            throw DriveProtocolException("Drive managed file path resolves to a folder: $path")
        }
        if (existing != null && requireExistingMimeType != null && !requireExistingMimeType(existing.mimeType)) {
            throw DriveProtocolException("Drive managed JSON path is occupied by a non-JSON file: $path")
        }

        val mergedAppProperties = existing?.appProperties.orEmpty() + appProperties
        val metadata = buildJsonObject {
            put("name", name)
            put("mimeType", mimeType)
            if (existing == null) put("parents", buildJsonArray { add(JsonPrimitive(parentId)) })
            if (mergedAppProperties.isNotEmpty()) {
                put("appProperties", buildJsonObject {
                    mergedAppProperties.forEach { (key, value) -> put(key, value) }
                })
            }
        }.toString()
        val boundary = boundaryFactory().also { value ->
            require(value.isNotBlank() && '\r' !in value && '\n' !in value) {
                "Multipart boundary must be a non-empty single line."
            }
        }
        val body = multipartBody(boundary, metadata, mimeType, content)
        val method = if (existing == null) "POST" else "PATCH"
        val endpoint = if (existing == null) {
            uploadUrl("files", mapOf("uploadType" to "multipart", "fields" to FILE_FIELDS))
        } else {
            uploadUrl(
                "files/${encodePathSegment(existing.id)}",
                mapOf("uploadType" to "multipart", "fields" to FILE_FIELDS),
            )
        }
        val item = request(
            token = token,
            method = method,
            url = endpoint,
            headers = mapOf("Content-Type" to "multipart/related; boundary=$boundary"),
            body = body,
        ).toDriveItem("Drive file upload")
        if (item.name != name || item.mimeType == FOLDER_MIME_TYPE) {
            throw DriveProtocolException("Drive upload returned unexpected file metadata for: $path")
        }
        return item.toFileRef(path)
    }

    private fun multipartBody(
        boundary: String,
        metadata: String,
        mimeType: String,
        content: ByteArray,
    ): ByteArray {
        val output = ByteArrayOutputStream()
        output.write("--$boundary\r\n".toByteArray(StandardCharsets.UTF_8))
        output.write("Content-Type: application/json; charset=UTF-8\r\n\r\n".toByteArray(StandardCharsets.UTF_8))
        output.write(metadata.toByteArray(StandardCharsets.UTF_8))
        output.write("\r\n--$boundary\r\n".toByteArray(StandardCharsets.UTF_8))
        output.write("Content-Type: $mimeType\r\n\r\n".toByteArray(StandardCharsets.UTF_8))
        output.write(content)
        output.write("\r\n--$boundary--\r\n".toByteArray(StandardCharsets.UTF_8))
        return output.toByteArray()
    }

    private suspend fun findChildren(token: String, parentId: String, name: String): List<DriveItem> =
        listFiles(
            token,
            "'${escapeDriveQuery(parentId)}' in parents and " +
                "name = '${escapeDriveQuery(name)}' and trashed = false",
        )

    private suspend fun listFiles(token: String, query: String): List<DriveItem> {
        val output = mutableListOf<DriveItem>()
        var pageToken: String? = null
        val seenPageTokens = mutableSetOf<String>()
        do {
            val parameters = linkedMapOf(
                "q" to query,
                "fields" to "nextPageToken,files($FILE_FIELDS)",
                "pageSize" to "1000",
            )
            pageToken?.let { parameters["pageToken"] = it }
            val response = request(token, "GET", apiUrl("files", parameters))
            val objectValue = response.toJsonObject("Drive file listing")
            val files = objectValue["files"] as? JsonArray ?: JsonArray(emptyList())
            files.forEach { output += it.toDriveItem() }
            pageToken = objectValue["nextPageToken"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
            if (pageToken != null && !seenPageTokens.add(pageToken)) {
                throw DriveProtocolException("Google Drive pagination returned a repeated page token.")
            }
        } while (pageToken != null)
        return output
    }

    private suspend fun getMetadata(token: String, fileId: String): DriveItem = request(
        token,
        "GET",
        apiUrl("files/${encodePathSegment(fileId)}", mapOf("fields" to FILE_FIELDS)),
    ).toDriveItem("Drive file metadata")

    private suspend fun request(
        token: String,
        method: String,
        url: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
    ): DriveHttpResponse {
        val response = transport.execute(
            DriveHttpRequest(
                method = method,
                url = url,
                headers = mapOf(
                    "Authorization" to "Bearer $token",
                    "Accept" to "application/json",
                ) + headers,
                body = body,
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

    private fun DriveHttpResponse.toDriveItem(label: String): DriveItem =
        toJsonObject(label).toDriveItem()

    private fun DriveHttpResponse.toJsonObject(label: String): JsonObject = try {
        JSON.parseToJsonElement(body.toString(StandardCharsets.UTF_8)).jsonObject
    } catch (error: IllegalArgumentException) {
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

    private fun DriveItem.toFileRef(path: String): DriveFileRef = DriveFileRef(
        id = id,
        path = path,
        name = name,
        mimeType = mimeType,
        size = size,
        updatedAt = modifiedTime ?: UNKNOWN_MODIFIED_TIME,
        appProperties = appProperties,
        version = version,
    )

    private fun jsonAppProperties(path: String, value: JsonElement): Map<String, String> {
        val entityType = when {
            path == MANIFEST_PATH -> "manifest"
            path.startsWith("devices/") -> "device"
            path.startsWith("entries/") -> "entry"
            path.startsWith("attachments/") -> "attachment"
            path.startsWith("filebox/") -> "fileBoxItem"
            path.startsWith("transfers/") -> "transfer"
            path.startsWith("conflicts/") -> "conflict"
            path.startsWith("tombstones/") -> "tombstone"
            else -> throw DriveProtocolException("Drive JSON path is outside the managed workspace: $path")
        }
        val root = value as? JsonObject ?: return mapOf("entityType" to entityType)
        val payload = root["payload"] as? JsonObject
        val entityId = when (entityType) {
            "manifest" -> null
            "device" -> root["id"]?.jsonPrimitive?.contentOrNull
            "conflict", "tombstone" -> root["entityId"]?.jsonPrimitive?.contentOrNull
            else -> payload?.get("id")?.jsonPrimitive?.contentOrNull
        }
        return buildMap {
            put("entityType", entityType)
            entityId?.takeIf(String::isNotBlank)?.let { put("entityId", it) }
        }
    }

    private fun requireManagedPath(path: String, requireJson: Boolean): List<String> {
        if (path.length > MAX_MANAGED_PATH_LENGTH || path.startsWith('/') || path.endsWith('/')) {
            throw DriveProtocolException("Drive path is invalid: $path")
        }
        val segments = path.split('/')
        if (
            segments.any { segment ->
                segment.isBlank() || segment in setOf(".", "..") || '\\' in segment ||
                    segment.length > MAX_PATH_SEGMENT_LENGTH || segment.any(Char::isISOControl)
            }
        ) {
            throw DriveProtocolException("Drive path contains an invalid segment: $path")
        }
        val managed = path == MANIFEST_PATH || MANAGED_PREFIXES.any(path::startsWith)
        if (!managed || (requireJson && !path.endsWith(".json", ignoreCase = true))) {
            throw DriveProtocolException("Drive path is outside the managed workspace: $path")
        }
        return segments
    }

    private fun requireManagedBlobPath(path: String): List<String> {
        val segments = requireManagedPath(path, requireJson = false)
        if (!path.startsWith("attachments/") || path.endsWith(".json", ignoreCase = true)) {
            throw DriveProtocolException("Drive blob path must be attachment content: $path")
        }
        return segments
    }

    private fun isJsonMimeType(mimeType: String?): Boolean {
        val normalized = mimeType?.substringBefore(';')?.trim()?.lowercase() ?: return false
        return normalized == JSON_MIME_TYPE || normalized == "text/json" || normalized.endsWith("+json")
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

    private fun apiUrl(path: String, parameters: Map<String, String>): String =
        url(DRIVE_API_BASE, path, parameters)

    private fun uploadUrl(path: String, parameters: Map<String, String>): String =
        url(DRIVE_UPLOAD_BASE, path, parameters)

    private fun url(base: String, path: String, parameters: Map<String, String>): String {
        val query = parameters.entries.joinToString("&") { (key, value) ->
            "${urlEncode(key)}=${urlEncode(value)}"
        }
        return "$base/$path?$query"
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

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
        val appProperties: Map<String, String>,
    )

    private companion object {
        const val DEFAULT_MAX_BLOB_BYTES = 256 * 1024 * 1024
        const val MAX_MANAGED_PATH_LENGTH = 1024
        const val MAX_PATH_SEGMENT_LENGTH = 255
        const val MAX_RETAINED_ERROR_BODY_BYTES = 16 * 1024
        const val DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
        const val DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
        const val FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
        const val JSON_MIME_TYPE = "application/json"
        const val MANIFEST_PATH = "manifest.json"
        const val UNKNOWN_MODIFIED_TIME = "1970-01-01T00:00:00Z"
        const val FILE_FIELDS = "id,name,mimeType,modifiedTime,size,version,trashed,appProperties"
        val SHA256_REGEX = Regex("^[0-9a-fA-F]{64}$")
        val JSON = Json { ignoreUnknownKeys = true }
        val MANAGED_PREFIXES = listOf(
            "devices/",
            "entries/",
            "attachments/",
            "filebox/",
            "transfers/",
            "conflicts/",
            "tombstones/",
        )

        fun escapeDriveQuery(value: String): String =
            value.replace("\\", "\\\\").replace("'", "\\'")

        fun urlEncode(value: String): String =
            URLEncoder.encode(value, StandardCharsets.UTF_8.name())

        fun encodePathSegment(value: String): String = urlEncode(value).replace("+", "%20")
    }
}
