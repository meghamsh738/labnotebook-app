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
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
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

internal sealed interface DriveWritePrecondition {
    data object MustNotExist : DriveWritePrecondition

    data class MustMatch(
        val fileId: String,
        val version: Long,
    ) : DriveWritePrecondition {
        init {
            require(fileId.isNotBlank()) { "Drive precondition file id must not be blank." }
            require(version > 0) { "Drive precondition version must be positive." }
        }
    }
}

internal class DriveWritePreconditionConflictException(
    message: String,
    val statusCode: Int? = null,
) : Exception(message)

internal class DriveWriteAmbiguousCommitException(
    message: String,
    cause: Throwable,
) : Exception(message, cause)

internal class DriveWriteReconciledAfterCancellationException(
    val file: DriveFileRef,
) : Exception("Drive conditional update committed and was reconciled before cancellation propagated: ${file.path}")

internal class HttpUrlConnectionDriveWriteTransport(
    private val connectTimeoutMillis: Int = 15_000,
    private val readTimeoutMillis: Int = 60_000,
    private val maxResponseBytes: Int = 8 * 1024 * 1024,
) : DriveWriteTransport {
    override suspend fun execute(request: DriveHttpRequest): DriveHttpResponse = withContext(Dispatchers.IO) {
        require(request.method in setOf("GET", "POST", "PATCH", "PUT")) {
            "Drive write transport accepts GET, POST, PATCH, and PUT requests only."
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
 * Conditional publication must be preflighted and ordered by [DriveV1WriteTransactionExecutor].
 */
internal class GoogleDriveWriteRepository(
    private val authRepository: AuthRepository,
    private val resumableOperations: DriveResumableOperationStore,
    private val rootFolderIds: DriveRootFolderIdStore = InMemoryDriveRootFolderIdStore(),
    private val transport: DriveWriteTransport = HttpUrlConnectionDriveWriteTransport(),
    private val folderName: String = GoogleDriveReadOnlyRepository.DEFAULT_ROOT_FOLDER_NAME,
    private val maxJsonBytes: Int = GoogleDriveReadOnlyRepository.DEFAULT_MAX_JSON_BYTES,
    private val maxBlobBytes: Int = DEFAULT_MAX_BLOB_BYTES,
    private val resumableChunkBytes: Int = DEFAULT_RESUMABLE_CHUNK_BYTES,
    private val boundaryFactory: () -> String = { "easylab-${UUID.randomUUID()}" },
) : DriveRepository, DriveConditionalWriteClient, DriveV1RemoteContentHasher {
    private val writeMutex = Mutex()
    private val reader = GoogleDriveReadOnlyRepository(
        authRepository = authRepository,
        rootFolderIds = rootFolderIds,
        transport = transport,
        folderName = folderName,
        maxJsonBytes = maxJsonBytes,
    )
    private val resumableUploader = DriveResumableUploader(
        transport = transport,
        chunkBytes = resumableChunkBytes,
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

    override suspend fun sha256(accountId: AccountId, file: DriveFileRef): Result<String> = driveResult {
        val size = file.size ?: throw DriveProtocolException(
            "Drive repair cannot hash media without a verified byte count: ${file.path}",
        )
        sha256RemoteMedia(accessToken(accountId), file.id, size)
    }

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
            if (normalizedMimeType.startsWith("application/vnd.google-apps.")) {
                throw DriveProtocolException("Drive blob MIME type cannot request Google Workspace conversion: $path")
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

    override suspend fun putJsonConditional(
        accountId: AccountId,
        path: String,
        json: String,
        precondition: DriveWritePrecondition,
    ): Result<DriveFileRef> = driveResult {
        writeMutex.withLock {
            requireConditionalPrecondition(path, precondition)
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
            val rootId = requireExistingRoot(accountId, token, path)
            val parentId = requireExistingFolders(token, rootId, segments.dropLast(1), path)
            conditionalUpsertMedia(
                token = token,
                parentId = parentId,
                path = path,
                name = segments.last(),
                mimeType = JSON_MIME_TYPE,
                content = bytes,
                appProperties = jsonAppProperties(path, value),
                precondition = precondition,
                requireExistingMimeType = ::isJsonMimeType,
            )
        }
    }

    override suspend fun putBlobConditional(
        accountId: AccountId,
        path: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String,
        precondition: DriveWritePrecondition,
    ): Result<DriveFileRef> = putBlobConditionalInternal(
        accountId = accountId,
        path = path,
        bytes = bytes,
        mimeType = mimeType,
        sha256 = sha256,
        precondition = precondition,
        operationId = null,
    )

    /**
     * Guarded resumable update capability for the unwired transaction path.
     * Production sync remains read-only; this does not change its injection.
     */
    override suspend fun putBlobConditionalResumable(
        accountId: AccountId,
        path: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String,
        precondition: DriveWritePrecondition,
        operationId: String,
    ): Result<DriveFileRef> = putBlobConditionalInternal(
        accountId = accountId,
        path = path,
        bytes = bytes,
        mimeType = mimeType,
        sha256 = sha256,
        precondition = precondition,
        operationId = operationId,
        allowResumableCreate = false,
    )

    override suspend fun putBlobConditionalResumableCreate(
        accountId: AccountId,
        path: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String,
        precondition: DriveWritePrecondition,
        operationId: String,
    ): Result<DriveFileRef> = putBlobConditionalInternal(
        accountId = accountId,
        path = path,
        bytes = bytes,
        mimeType = mimeType,
        sha256 = sha256,
        precondition = precondition,
        operationId = operationId,
        allowResumableCreate = true,
    )

    private suspend fun putBlobConditionalInternal(
        accountId: AccountId,
        path: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String,
        precondition: DriveWritePrecondition,
        operationId: String?,
        allowResumableCreate: Boolean = false,
    ): Result<DriveFileRef> = driveResult {
        val frozenBytes = bytes.copyOf()
        writeMutex.withLock {
            requireConditionalPrecondition(path, precondition)
            val segments = requireManagedBlobPath(path)
            if (frozenBytes.size > maxBlobBytes) {
                throw DriveProtocolException("Drive blob exceeds the safe size limit: $path")
            }
            val normalizedMimeType = mimeType.substringBefore(';').trim().lowercase()
            if (normalizedMimeType.isBlank() || '/' !in normalizedMimeType) {
                throw DriveProtocolException("Drive blob MIME type is invalid: $path")
            }
            if (normalizedMimeType.startsWith("application/vnd.google-apps.")) {
                throw DriveProtocolException("Drive blob MIME type cannot request Google Workspace conversion: $path")
            }
            if (!SHA256_REGEX.matches(sha256)) {
                throw DriveProtocolException("Drive blob SHA-256 is invalid: $path")
            }
            val actualSha256 = sha256(frozenBytes)
            if (!actualSha256.equals(sha256, ignoreCase = true)) {
                throw DriveProtocolException("Drive blob SHA-256 does not match its bytes: $path")
            }
            val useResumable = frozenBytes.size >= CONDITIONAL_RESUMABLE_MIN_BLOB_BYTES
            if (
                useResumable &&
                    precondition is DriveWritePrecondition.MustNotExist &&
                    !allowResumableCreate
            ) {
                throw DriveProtocolException(
                    "Drive create-only resumable blob requires its generated-id protocol: $path",
                )
            }
            if (allowResumableCreate && precondition !is DriveWritePrecondition.MustNotExist) {
                throw DriveProtocolException("Drive resumable creation requires MustNotExist: $path")
            }
            val expected = precondition as? DriveWritePrecondition.MustMatch
            val blobAppProperties = mapOf(
                "entityType" to "attachmentBlob",
                "sha256" to actualSha256,
            )
            if (useResumable && precondition is DriveWritePrecondition.MustNotExist) {
                val stableOperationId = operationId
                    ?.takeIf { it.isNotBlank() && it.length <= MAX_RESUMABLE_OPERATION_ID_LENGTH }
                    ?.takeUnless { it.any(Char::isISOControl) }
                    ?: throw DriveProtocolException(
                        "Drive resumable creation requires a valid persisted operation id: $path",
                    )
                resumableOperations.record(accountId, stableOperationId)?.identity?.let { persisted ->
                    if (
                        persisted.target !is DriveResumableOperationTarget.New ||
                        persisted.path != path ||
                        persisted.sha256 != actualSha256 ||
                        persisted.byteSize != frozenBytes.size.toLong() ||
                        persisted.mimeType != normalizedMimeType ||
                        persisted.creationFingerprint != creationFingerprint(
                            path, normalizedMimeType, frozenBytes, blobAppProperties,
                        )
                    ) {
                        throw DriveResumableOperationIdentityConflictException(
                            "Drive resumable creation id is already bound to different immutable content.",
                        )
                    }
                }
            }
            val operationIdentity = if (useResumable && expected != null) {
                val stableOperationId = operationId
                    ?.takeIf(String::isNotBlank)
                    ?: throw DriveProtocolException(
                        "Drive resumable blob update requires a persisted operation id: $path",
                    )
                DriveResumableOperationIdentity(
                    accountId = accountId,
                    operationId = stableOperationId,
                    path = path,
                    fileId = checkNotNull(expected).fileId,
                    expectedVersion = expected.version,
                    sha256 = actualSha256,
                    byteSize = frozenBytes.size.toLong(),
                    mimeType = normalizedMimeType,
                ).also { resumableOperations.begin(it) }
            } else {
                null
            }
            val token = accessToken(accountId)
            val rootId = requireExistingRoot(accountId, token, path)
            val parentId = requireExistingFolders(token, rootId, segments.dropLast(1), path)
            if (useResumable && precondition is DriveWritePrecondition.MustNotExist) {
                return@withLock conditionalCreateResumableMedia(
                    token = token,
                    accountId = accountId,
                    parentId = parentId,
                    path = path,
                    name = segments.last(),
                    mimeType = normalizedMimeType,
                    content = frozenBytes,
                    appProperties = blobAppProperties,
                    operationId = checkNotNull(operationId),
                )
            }
            conditionalUpsertMedia(
                token = token,
                parentId = parentId,
                path = path,
                name = segments.last(),
                mimeType = normalizedMimeType,
                content = frozenBytes,
                appProperties = blobAppProperties,
                precondition = precondition,
                useResumable = useResumable,
                operationIdentity = operationIdentity,
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

    private suspend fun requireExistingRoot(
        accountId: AccountId,
        token: String,
        path: String,
    ): String {
        rootFolderIds.get(accountId)?.let { savedId ->
            val savedRoot = try {
                getMetadata(token, savedId)
            } catch (error: DriveHttpException) {
                if (error.statusCode == 404) null else throw error
            }
            val savedRootIsAtDriveRoot = savedRoot != null &&
                findChildren(token, "root", folderName).any { candidate -> candidate.id == savedId }
            if (
                savedRoot != null && savedRoot.id == savedId &&
                savedRoot.mimeType == FOLDER_MIME_TYPE && !savedRoot.trashed &&
                savedRoot.name == folderName && savedRootIsAtDriveRoot
            ) {
                return savedId
            }
            throw DriveWritePreconditionConflictException(
                "Saved Drive workspace changed before conditional update: $path",
            )
        }
        return reader.resolveExistingRootFolderId(accountId)
            ?: throw DriveWritePreconditionConflictException(
                "Drive workspace no longer exists for conditional update: $path",
            )
    }

    private suspend fun requireExistingFolders(
        token: String,
        rootId: String,
        pathSegments: List<String>,
        path: String,
    ): String {
        var parentId = rootId
        for (segment in pathSegments) {
            val matches = findChildren(token, parentId, segment)
            if (matches.size != 1) {
                throw DriveWritePreconditionConflictException(
                    "Drive managed folder path changed before conditional update: $path",
                )
            }
            val folder = matches.single()
            if (folder.mimeType != FOLDER_MIME_TYPE) {
                throw DriveWritePreconditionConflictException(
                    "Drive managed folder path is no longer a folder: $path",
                )
            }
            parentId = folder.id
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

    private suspend fun conditionalUpsertMedia(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        appProperties: Map<String, String>,
        precondition: DriveWritePrecondition,
        requireExistingMimeType: ((String?) -> Boolean)? = null,
        useResumable: Boolean = false,
        operationIdentity: DriveResumableOperationIdentity? = null,
    ): DriveFileRef {
        if (precondition is DriveWritePrecondition.MustNotExist) {
            if (useResumable || operationIdentity != null) {
                throw DriveProtocolException(
                    "Drive conditional creation only supports bounded multipart content: $path",
                )
            }
            return conditionalCreateMedia(
                token = token,
                parentId = parentId,
                path = path,
                name = name,
                mimeType = mimeType,
                content = content,
                appProperties = appProperties,
                requireExistingMimeType = requireExistingMimeType,
            )
        }
        val expected = precondition as? DriveWritePrecondition.MustMatch
            ?: throw DriveProtocolException("Drive conditional write has an unsupported precondition: $path")
        val matches = findChildren(token, parentId, name)
        if (matches.size > 1) {
            throw DriveWritePreconditionConflictException(
                "Drive workspace contains duplicate managed path: $path",
            )
        }
        val existing = matches.singleOrNull()
            ?: throw DriveWritePreconditionConflictException(
                "Drive managed path no longer exists: $path",
            )
        if (existing.mimeType == FOLDER_MIME_TYPE) {
            throw DriveProtocolException("Drive managed file path resolves to a folder: $path")
        }
        if (requireExistingMimeType != null && !requireExistingMimeType(existing.mimeType)) {
            throw DriveProtocolException("Drive managed JSON path is occupied by a non-JSON file: $path")
        }
        if (existing.id != expected.fileId) {
            throw DriveWritePreconditionConflictException(
                "Drive managed path no longer matches the expected file id: $path",
            )
        }

        val (current, response) = try {
            getMetadataResponse(token, expected.fileId)
        } catch (error: DriveHttpException) {
            if (error.statusCode == 404) {
                throw DriveWritePreconditionConflictException(
                    "Drive managed path disappeared before its conditional update: $path",
                    statusCode = 404,
                )
            }
            throw error
        }
        if (!isExpectedManagedFile(current, expected.fileId, parentId, name, mimeType, requireExistingMimeType)) {
            throw DriveWritePreconditionConflictException(
                "Drive file changed before its conditional update: $path",
            )
        }

        val replacedPropertyKeys = buildSet {
            addAll(appProperties.keys)
            if (isJsonMimeType(mimeType)) add("contentHash")
        }
        val mergedAppProperties = (current.appProperties - replacedPropertyKeys) + appProperties
        if (current.version != expected.version) {
            val reconciled = reconcileAppliedWrite(
                token = token,
                parentId = parentId,
                path = path,
                name = name,
                mimeType = mimeType,
                content = content,
                expectedId = expected.fileId,
                requiredAppProperties = appProperties,
                minimumExclusiveVersion = expected.version,
            ) ?: throw DriveWritePreconditionConflictException(
                "Drive managed path no longer matches the expected file version: $path",
            )
            return completeResumableOperation(operationIdentity, reconciled)
        }
        val ifMatch = response.header("ETag")
            ?.trim()
            ?.takeIf(String::isNotBlank)
            ?: throw DriveProtocolException(
                "Drive metadata omitted the ETag required for a conditional update: $path",
            )
        val metadata = buildJsonObject {
            put("name", name)
            put("mimeType", mimeType)
            if (mergedAppProperties.isNotEmpty()) {
                put("appProperties", buildJsonObject {
                    mergedAppProperties.forEach { (key, value) -> put(key, value) }
                })
            }
        }.toString()
        if (useResumable && operationIdentity == null) {
            throw DriveProtocolException("Drive resumable update omitted its persisted operation identity: $path")
        }
        if (!useResumable && operationIdentity != null) {
            throw DriveProtocolException("Drive multipart update unexpectedly included a resumable identity: $path")
        }
        var contentTransferStarted = false
        var mutationResponseAcknowledged = false
        return try {
            val mutation = if (useResumable) {
                val initiation = request(
                    token = token,
                    method = "PATCH",
                    url = uploadUrl(
                        "files/${encodePathSegment(expected.fileId)}",
                        mapOf("uploadType" to "resumable", "fields" to FILE_FIELDS),
                    ),
                    headers = mapOf(
                        "Content-Type" to "application/json; charset=UTF-8",
                        "If-Match" to ifMatch,
                        "X-Upload-Content-Type" to mimeType,
                        "X-Upload-Content-Length" to content.size.toString(),
                    ),
                    body = metadata.toByteArray(StandardCharsets.UTF_8),
                    mapPreconditionConflict = true,
                )
                val sessionUrl = initiation.header("Location")
                    ?.trim()
                    ?.takeIf(String::isNotBlank)
                    ?: throw DriveProtocolException(
                        "Drive resumable initiation omitted its session URL: $path",
                    )
                contentTransferStarted = true
                val completion = resumableUploader.upload(
                    token = token,
                    sessionUrl = sessionUrl,
                    content = content,
                    mimeType = mimeType,
                )
                if (completion.body.isEmpty()) {
                    getMetadata(token, expected.fileId)
                } else {
                    completion.toDriveItem("Drive resumable file upload")
                }.also { mutationResponseAcknowledged = true }
            } else {
                val boundary = boundaryFactory().also { value ->
                    require(value.isNotBlank() && '\r' !in value && '\n' !in value) {
                        "Multipart boundary must be a non-empty single line."
                    }
                }
                val body = multipartBody(boundary, metadata, mimeType, content)
                contentTransferStarted = true
                request(
                    token = token,
                    method = "PATCH",
                    url = uploadUrl(
                        "files/${encodePathSegment(expected.fileId)}",
                        mapOf("uploadType" to "multipart", "fields" to FILE_FIELDS),
                    ),
                    headers = mapOf(
                        "Content-Type" to "multipart/related; boundary=$boundary",
                        "If-Match" to ifMatch,
                    ),
                    body = body,
                    mapPreconditionConflict = true,
                ).toDriveItem("Drive conditional file upload")
                    .also { mutationResponseAcknowledged = true }
            }
            val verified = verifyCommittedWrite(
                token = token,
                parentId = parentId,
                path = path,
                name = name,
                mimeType = mimeType,
                content = content,
                expected = expected,
                expectedAppProperties = mergedAppProperties,
                mutation = mutation,
            )
            completeResumableOperation(operationIdentity, verified)
        } catch (error: DriveWritePreconditionConflictException) {
            if (!mutationResponseAcknowledged) throw error
            val reconciled = reconcileAfterMutation(
                token,
                parentId,
                path,
                name,
                mimeType,
                content,
                expected.fileId,
                appProperties,
                expected.version,
            )
            if (reconciled != null) {
                completeResumableOperation(operationIdentity, reconciled)
            } else {
                markResumableAmbiguous(operationIdentity)
                throw DriveWriteAmbiguousCommitException(
                    "Drive conditional update committed before a concurrent verification conflict: $path",
                    error,
                )
            }
        } catch (error: CancellationException) {
            if (contentTransferStarted) {
                val reconciled = reconcileAfterMutation(
                    token,
                    parentId,
                    path,
                    name,
                    mimeType,
                    content,
                    expected.fileId,
                    appProperties,
                    expected.version,
                )
                if (reconciled != null) {
                    runCatching {
                        completeResumableOperation(operationIdentity, reconciled)
                    }.onFailure(error::addSuppressed)
                    error.addSuppressed(DriveWriteReconciledAfterCancellationException(reconciled))
                } else {
                    runCatching {
                        markResumableAmbiguous(operationIdentity)
                    }.onFailure(error::addSuppressed)
                }
            }
            throw error
        } catch (error: Throwable) {
            if (!contentTransferStarted) throw error
            val reconciled = reconcileAfterMutation(
                token,
                parentId,
                path,
                name,
                mimeType,
                content,
                expected.fileId,
                appProperties,
                expected.version,
            )
            if (reconciled != null) {
                completeResumableOperation(operationIdentity, reconciled)
            } else {
                runCatching {
                    markResumableAmbiguous(operationIdentity)
                }.onFailure(error::addSuppressed)
                throw DriveWriteAmbiguousCommitException(
                    "Drive conditional update may have committed but could not be reconciled: $path",
                    error,
                )
            }
        }
    }

    /**
     * Creates a missing managed file without ever updating an occupant of the path.
     *
     * Google Drive does not provide path uniqueness, so the deterministic creation
     * fingerprint is stored with the file. A lost-response retry is accepted only
     * when exactly one file at the path has that fingerprint and its complete
     * metadata and downloaded bytes match the original intention. Concurrent
     * duplicates or any different occupant fail closed.
     */
    private suspend fun conditionalCreateMedia(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        appProperties: Map<String, String>,
        requireExistingMimeType: ((String?) -> Boolean)?,
    ): DriveFileRef {
        val creationFingerprint = creationFingerprint(path, mimeType, content, appProperties)
        val intendedAppProperties = appProperties + (CREATE_FINGERPRINT_PROPERTY to creationFingerprint)
        val matches = findChildren(token, parentId, name)
        if (matches.size > 1) {
            throw DriveWritePreconditionConflictException(
                "Drive workspace contains duplicate managed path: $path",
            )
        }
        matches.singleOrNull()?.let { existing ->
            return reconcileCreatedWrite(
                token = token,
                parentId = parentId,
                path = path,
                name = name,
                mimeType = mimeType,
                content = content,
                expectedAppProperties = intendedAppProperties,
                expectedId = existing.id,
                requireExistingMimeType = requireExistingMimeType,
            ) ?: throw DriveWritePreconditionConflictException(
                "Drive create-only path is already occupied by different content: $path",
            )
        }

        val metadata = buildJsonObject {
            put("name", name)
            put("mimeType", mimeType)
            put("parents", buildJsonArray { add(JsonPrimitive(parentId)) })
            put("appProperties", buildJsonObject {
                intendedAppProperties.forEach { (key, value) -> put(key, value) }
            })
        }.toString()
        val boundary = boundaryFactory().also { value ->
            require(value.isNotBlank() && '\r' !in value && '\n' !in value) {
                "Multipart boundary must be a non-empty single line."
            }
        }
        val body = multipartBody(boundary, metadata, mimeType, content)
        var uploadStarted = false
        var createdId: String? = null
        return try {
            uploadStarted = true
            val mutation = request(
                token = token,
                method = "POST",
                url = uploadUrl("files", mapOf("uploadType" to "multipart", "fields" to FILE_FIELDS)),
                headers = mapOf("Content-Type" to "multipart/related; boundary=$boundary"),
                body = body,
            ).toDriveItem("Drive create-only file upload")
            createdId = mutation.id
            verifyCreatedWrite(
                token = token,
                parentId = parentId,
                path = path,
                name = name,
                mimeType = mimeType,
                content = content,
                expectedAppProperties = intendedAppProperties,
                mutation = mutation,
                requireExistingMimeType = requireExistingMimeType,
            )
        } catch (error: CancellationException) {
            if (uploadStarted) {
                val reconciled = reconcileCreatedAfterMutation(
                    token, parentId, path, name, mimeType, content,
                    intendedAppProperties, createdId, requireExistingMimeType,
                )
                if (reconciled != null) {
                    error.addSuppressed(DriveWriteReconciledAfterCancellationException(reconciled))
                }
            }
            throw error
        } catch (error: Throwable) {
            if (!uploadStarted) throw error
            reconcileCreatedAfterMutation(
                token, parentId, path, name, mimeType, content,
                intendedAppProperties, createdId, requireExistingMimeType,
            ) ?: throw DriveWriteAmbiguousCommitException(
                "Drive create-only write may have committed but could not be reconciled: $path",
                error,
            )
        }
    }

    /**
     * Creates a large blob exactly once under a pre-generated Drive id.
     *
     * The operation store is the authority for retries: it binds the generated
     * id and all immutable intent before the first upload session is started.
     * A retry therefore either reconciles that exact file or fails closed; it
     * never allocates a second id or replaces an occupant at the canonical path.
     */
    private suspend fun conditionalCreateResumableMedia(
        token: String,
        accountId: AccountId,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        appProperties: Map<String, String>,
        operationId: String,
    ): DriveFileRef {
        if (
            operationId.isBlank() ||
                operationId.length > MAX_RESUMABLE_OPERATION_ID_LENGTH ||
                operationId.any(Char::isISOControl)
        ) {
            throw DriveProtocolException("Drive resumable creation requires a valid persisted operation id: $path")
        }
        val creationFingerprint = creationFingerprint(path, mimeType, content, appProperties)
        val intendedAppProperties = appProperties + (CREATE_FINGERPRINT_PROPERTY to creationFingerprint)
        val existingRecord = resumableOperations.record(accountId, operationId)
        existingRecord?.identity?.let { persisted ->
            if (
                persisted.target !is DriveResumableOperationTarget.New ||
                persisted.path != path ||
                persisted.sha256 != sha256(content) ||
                persisted.byteSize != content.size.toLong() ||
                persisted.mimeType != mimeType ||
                persisted.creationFingerprint != creationFingerprint
            ) {
                throw DriveResumableOperationIdentityConflictException(
                    "Drive resumable creation id is already bound to different immutable content.",
                )
            }
        }
        val recoverableReservation = if (existingRecord == null) {
            readCreateReservation(token, parentId, path)
        } else {
            null
        }
        val identity = existingRecord?.identity ?: run {
            recoverableReservation?.let { reserved ->
                if (reserved.creationFingerprint != creationFingerprint) {
                    throw DriveWritePreconditionConflictException(
                        "Drive path has an active reservation for different content: $path",
                    )
                }
                return@run DriveResumableOperationIdentity(
                    accountId = accountId,
                    operationId = operationId,
                    path = path,
                    fileId = reserved.fileId,
                    sha256 = sha256(content),
                    byteSize = content.size.toLong(),
                    mimeType = mimeType,
                    creationFingerprint = creationFingerprint,
                )
            }
            val matches = findChildren(token, parentId, name)
            if (matches.size > 1) {
                throw DriveWritePreconditionConflictException(
                    "Drive workspace contains duplicate managed path: $path",
                )
            }
            if (matches.isNotEmpty()) {
                throw DriveWritePreconditionConflictException(
                    "Drive create-only path is already occupied: $path",
                )
            }
            val generatedId = generateFileId(token)
            DriveResumableOperationIdentity(
                accountId = accountId,
                operationId = operationId,
                path = path,
                fileId = generatedId,
                sha256 = sha256(content),
                byteSize = content.size.toLong(),
                mimeType = mimeType,
                creationFingerprint = creationFingerprint,
            )
        }
        if (existingRecord == null && recoverableReservation != null) {
            resumableOperations.begin(identity)
        }

        val currentMatches = findChildren(token, parentId, name)
        if (currentMatches.size > 1) {
            throw DriveWritePreconditionConflictException(
                "Drive workspace contains duplicate managed path: $path",
            )
        }
        currentMatches.singleOrNull()?.let { occupant ->
            val reconciled = reconcileCreatedWrite(
                token = token,
                parentId = parentId,
                path = path,
                name = name,
                mimeType = mimeType,
                content = content,
                expectedAppProperties = intendedAppProperties,
                expectedId = identity.fileId,
                requireExistingMimeType = null,
            ) ?: throw DriveWritePreconditionConflictException(
                "Drive create-only path is already occupied by different content: $path",
            )
            releaseCreateReservation(token, parentId, identity)
            return completeResumableOperation(identity, reconciled)
        }

        acquireCreateReservation(token, parentId, identity)
        resumableOperations.begin(identity)
        val reservedPathMatches = findChildren(token, parentId, name)
        if (reservedPathMatches.isNotEmpty()) {
            releaseCreateReservation(token, parentId, identity)
            throw DriveWritePreconditionConflictException(
                "Drive create-only path became occupied before upload: $path",
            )
        }

        val generatedTarget = try {
            getMetadata(token, identity.fileId)
        } catch (error: DriveHttpException) {
            if (error.statusCode == 404) null else throw error
        }
        if (generatedTarget != null) {
            throw DriveWritePreconditionConflictException(
                "Drive generated file id is unexpectedly occupied: $path",
            )
        }

        val metadata = buildJsonObject {
            put("id", identity.fileId)
            put("name", name)
            put("mimeType", mimeType)
            put("parents", buildJsonArray { add(JsonPrimitive(parentId)) })
            put("appProperties", buildJsonObject {
                intendedAppProperties.forEach { (key, value) -> put(key, value) }
            })
        }.toString()
        var transferStarted = false
        try {
            val initiation = request(
                token = token,
                method = "POST",
                url = uploadUrl("files", mapOf("uploadType" to "resumable", "fields" to FILE_FIELDS)),
                headers = mapOf(
                    "Content-Type" to "application/json; charset=UTF-8",
                    "X-Upload-Content-Type" to mimeType,
                    "X-Upload-Content-Length" to content.size.toString(),
                ),
                body = metadata.toByteArray(StandardCharsets.UTF_8),
                mapPreconditionConflict = true,
            )
            val sessionUrl = initiation.header("Location")
                ?.trim()
                ?.takeIf(String::isNotBlank)
                ?: throw DriveProtocolException("Drive resumable creation omitted its session URL: $path")
            transferStarted = true
            val completion = resumableUploader.upload(token, sessionUrl, content, mimeType)
            val mutation = if (completion.body.isEmpty()) {
                getMetadata(token, identity.fileId)
            } else {
                completion.toDriveItem("Drive resumable create upload")
            }
            val verified = verifyCreatedWrite(
                token = token,
                parentId = parentId,
                path = path,
                name = name,
                mimeType = mimeType,
                content = content,
                expectedAppProperties = intendedAppProperties,
                mutation = mutation,
                requireExistingMimeType = null,
            )
            releaseCreateReservation(token, parentId, identity)
            return completeResumableOperation(identity, verified)
        } catch (error: CancellationException) {
            if (transferStarted) reconcileResumableCreateAfterMutation(
                token, parentId, path, name, mimeType, content, intendedAppProperties, identity,
            )?.let { reconciled ->
                runCatching { releaseCreateReservation(token, parentId, identity) }
                    .onFailure(error::addSuppressed)
                runCatching { completeResumableOperation(identity, reconciled) }.onFailure(error::addSuppressed)
                error.addSuppressed(DriveWriteReconciledAfterCancellationException(reconciled))
            } ?: runCatching { markResumableAmbiguous(identity) }.onFailure(error::addSuppressed)
            throw error
        } catch (error: Throwable) {
            val reconciled = reconcileResumableCreateAfterMutation(
                token, parentId, path, name, mimeType, content, intendedAppProperties, identity,
            )
            if (reconciled != null) {
                releaseCreateReservation(token, parentId, identity)
                return completeResumableOperation(identity, reconciled)
            }
            if (transferStarted) {
                runCatching { markResumableAmbiguous(identity) }.onFailure(error::addSuppressed)
            }
            if (error is DriveWritePreconditionConflictException) throw error
            throw DriveWriteAmbiguousCommitException(
                "Drive resumable creation may have committed but could not be reconciled: $path",
                error,
            )
        }
    }

    private suspend fun acquireCreateReservation(
        token: String,
        parentId: String,
        identity: DriveResumableOperationIdentity,
    ) {
        val target = identity.target as? DriveResumableOperationTarget.New
            ?: throw DriveProtocolException("Drive create reservation requires a new-file target.")
        val (folder, response) = getMetadataResponse(token, parentId)
        if (folder.mimeType != FOLDER_MIME_TYPE || folder.trashed) {
            throw DriveProtocolException("Drive create reservation parent is not an active folder.")
        }
        val reservationKey = createReservationKey(identity.path)
        val reservationValue = createReservationValue(target)
        val existingReservation = folder.appProperties[reservationKey]
        if (existingReservation != null) {
            if (existingReservation == reservationValue) return
            throw DriveWritePreconditionConflictException(
                "Drive path already has another active create reservation: ${identity.path}",
            )
        }
        val etag = response.header("ETag")?.trim()?.takeIf(String::isNotBlank)
            ?: throw DriveProtocolException("Drive folder metadata omitted its reservation ETag.")
        val reservedProperties = folder.appProperties + (reservationKey to reservationValue)
        request(
            token = token,
            method = "PATCH",
            url = apiUrl("files/${encodePathSegment(parentId)}", mapOf("fields" to FILE_FIELDS)),
            headers = mapOf(
                "Content-Type" to "application/json; charset=UTF-8",
                "If-Match" to etag,
            ),
            body = buildJsonObject {
                put("appProperties", buildJsonObject {
                    reservedProperties.forEach { (key, value) -> put(key, value) }
                })
            }.toString().toByteArray(StandardCharsets.UTF_8),
            mapPreconditionConflict = true,
        )
        val verified = getMetadata(token, parentId)
        if (
            verified.appProperties[reservationKey] != reservationValue
        ) {
            throw DriveWritePreconditionConflictException(
                "Drive create reservation was not preserved: ${identity.path}",
            )
        }
    }

    private suspend fun releaseCreateReservation(
        token: String,
        parentId: String,
        identity: DriveResumableOperationIdentity,
    ) {
        val target = identity.target as? DriveResumableOperationTarget.New ?: return
        val (folder, response) = getMetadataResponse(token, parentId)
        val reservationKey = createReservationKey(identity.path)
        val reservationValue = createReservationValue(target)
        val existingReservation = folder.appProperties[reservationKey] ?: return
        if (existingReservation != reservationValue) {
            throw DriveWritePreconditionConflictException(
                "Drive create reservation changed before release: ${identity.path}",
            )
        }
        val etag = response.header("ETag")?.trim()?.takeIf(String::isNotBlank)
            ?: throw DriveProtocolException("Drive folder metadata omitted its release ETag.")
        request(
            token = token,
            method = "PATCH",
            url = apiUrl("files/${encodePathSegment(parentId)}", mapOf("fields" to FILE_FIELDS)),
            headers = mapOf(
                "Content-Type" to "application/json; charset=UTF-8",
                "If-Match" to etag,
            ),
            body = buildJsonObject {
                put("appProperties", buildJsonObject {
                    folder.appProperties
                        .filterKeys { it != reservationKey }
                        .forEach { (key, value) -> put(key, value) }
                    put(reservationKey, JsonNull)
                })
            }.toString().toByteArray(StandardCharsets.UTF_8),
            mapPreconditionConflict = true,
        )
        val verified = getMetadata(token, parentId)
        if (verified.appProperties.containsKey(reservationKey)) {
            throw DriveProtocolException("Drive create reservation remained after release: ${identity.path}")
        }
    }

    private suspend fun readCreateReservation(
        token: String,
        parentId: String,
        path: String,
    ): DriveResumableOperationTarget.New? {
        val folder = getMetadata(token, parentId)
        val raw = folder.appProperties[createReservationKey(path)] ?: return null
        val separator = raw.length - SHA256_HEX_LENGTH - 1
        if (separator <= 0 || raw.getOrNull(separator) != ':') {
            throw DriveProtocolException("Drive create reservation is malformed: $path")
        }
        return DriveResumableOperationTarget.New(
            fileId = raw.substring(0, separator),
            creationFingerprint = raw.substring(separator + 1),
        )
    }

    private fun createReservationKey(path: String): String =
        "$CREATE_RESERVATION_PROPERTY_PREFIX${sha256(path.toByteArray(StandardCharsets.UTF_8)).take(32)}"

    private fun createReservationValue(target: DriveResumableOperationTarget.New): String =
        "${target.fileId}:${target.creationFingerprint}"

    private suspend fun reconcileResumableCreateAfterMutation(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        expectedAppProperties: Map<String, String>,
        identity: DriveResumableOperationIdentity,
    ): DriveFileRef? = withContext(NonCancellable) {
        runCatching {
            reconcileCreatedWrite(
                token, parentId, path, name, mimeType, content, expectedAppProperties,
                identity.fileId, requireExistingMimeType = null,
            )
        }.getOrNull()
    }

    private suspend fun generateFileId(token: String): String {
        val response = request(
            token = token,
            method = "GET",
            url = apiUrl("files/generateIds", mapOf("count" to "1", "space" to "drive")),
        )
        val ids = try {
            JSON.parseToJsonElement(response.body.toString(StandardCharsets.UTF_8))
                .jsonObject["ids"] as? JsonArray
        } catch (error: Exception) {
            throw DriveProtocolException("Drive generated-id response is invalid.", error)
        }
        return ids?.singleOrNull()?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
            ?: throw DriveProtocolException("Drive generated-id response omitted exactly one id.")
    }

    private suspend fun verifyCreatedWrite(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        expectedAppProperties: Map<String, String>,
        mutation: DriveItem,
        requireExistingMimeType: ((String?) -> Boolean)?,
    ): DriveFileRef = reconcileCreatedWrite(
        token, parentId, path, name, mimeType, content,
        expectedAppProperties, mutation.id, requireExistingMimeType,
    ) ?: throw DriveProtocolException("Drive create-only upload failed post-write verification: $path")

    private suspend fun reconcileCreatedAfterMutation(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        expectedAppProperties: Map<String, String>,
        expectedId: String?,
        requireExistingMimeType: ((String?) -> Boolean)?,
    ): DriveFileRef? = withContext(NonCancellable) {
        runCatching {
            val matches = findChildren(token, parentId, name)
            if (matches.size != 1) return@runCatching null
            val only = matches.single()
            if (expectedId != null && only.id != expectedId) return@runCatching null
            reconcileCreatedWrite(
                token, parentId, path, name, mimeType, content,
                expectedAppProperties, only.id, requireExistingMimeType,
            )
        }.getOrNull()
    }

    private suspend fun reconcileCreatedWrite(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        expectedAppProperties: Map<String, String>,
        expectedId: String,
        requireExistingMimeType: ((String?) -> Boolean)?,
    ): DriveFileRef? {
        val matches = findChildren(token, parentId, name)
        if (matches.size != 1 || matches.single().id != expectedId) return null
        val metadata = getMetadata(token, expectedId)
        if (!isExpectedManagedFile(
                metadata, expectedId, parentId, name, mimeType, requireExistingMimeType,
            ) || metadata.appProperties != expectedAppProperties || metadata.size != content.size.toLong()
        ) return null
        if (sha256RemoteMedia(token, expectedId, content.size.toLong()) != sha256(content)) return null
        val finalMetadata = getMetadata(token, expectedId)
        if (finalMetadata != metadata) return null
        return finalMetadata.toFileRef(path)
    }

    private fun creationFingerprint(
        path: String,
        mimeType: String,
        content: ByteArray,
        appProperties: Map<String, String>,
    ): String {
        val properties = appProperties.toSortedMap().entries.joinToString("\n") { (key, value) -> "$key=$value" }
        return sha256("$path\n$mimeType\n${sha256(content)}\n$properties".toByteArray(StandardCharsets.UTF_8))
    }

    private suspend fun reconcileAfterMutation(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        expectedId: String,
        requiredAppProperties: Map<String, String>,
        minimumExclusiveVersion: Long,
    ): DriveFileRef? = withContext(NonCancellable) {
        runCatching {
            reconcileAppliedWrite(
                token,
                parentId,
                path,
                name,
                mimeType,
                content,
                expectedId,
                requiredAppProperties,
                minimumExclusiveVersion,
            )
        }.getOrNull()
    }

    private suspend fun completeResumableOperation(
        identity: DriveResumableOperationIdentity?,
        file: DriveFileRef,
    ): DriveFileRef = withContext(NonCancellable) {
        identity?.let { resumableOperations.markCompleted(it, file) }
        file
    }

    private suspend fun markResumableAmbiguous(identity: DriveResumableOperationIdentity?) {
        if (identity != null) {
            withContext(NonCancellable) {
                resumableOperations.markAmbiguous(identity)
            }
        }
    }

    private suspend fun verifyCommittedWrite(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        expected: DriveWritePrecondition.MustMatch,
        expectedAppProperties: Map<String, String>,
        mutation: DriveItem,
    ): DriveFileRef {
        if (
            mutation.id != expected.fileId ||
            mutation.name != name ||
            mutation.mimeType != mimeType
        ) {
            throw DriveProtocolException("Drive conditional upload returned unexpected metadata for: $path")
        }
        val refreshed = findChildren(token, parentId, name)
        if (refreshed.size != 1 || refreshed.single().id != expected.fileId) {
            throw DriveWritePreconditionConflictException(
                "Drive managed path changed concurrently during its conditional write: $path",
            )
        }
        val verified = getMetadata(token, expected.fileId)
        if (
            !isExpectedManagedFile(verified, expected.fileId, parentId, name, mimeType, null) ||
            verified.appProperties != expectedAppProperties
        ) {
            throw DriveProtocolException("Drive conditional upload failed metadata verification: $path")
        }
        val verifiedVersion = verified.version
            ?: throw DriveProtocolException("Drive conditional upload omitted its verified version: $path")
        if (verifiedVersion <= expected.version || mutation.version != verifiedVersion) {
            throw DriveProtocolException("Drive conditional upload did not advance its version: $path")
        }
        val remoteSha256 = try {
            sha256RemoteMedia(token, expected.fileId, content.size.toLong())
        } catch (error: Throwable) {
            throw DriveProtocolException(
                "Drive conditional upload failed content verification: $path",
                error,
            )
        }
        if (verified.size != content.size.toLong() || remoteSha256 != sha256(content)) {
            throw DriveProtocolException("Drive conditional upload failed content verification: $path")
        }
        val finalMetadata = getMetadata(token, expected.fileId)
        if (finalMetadata != verified) {
            throw DriveWritePreconditionConflictException(
                "Drive file changed during conditional post-write verification: $path",
            )
        }
        return finalMetadata.toFileRef(path)
    }

    private suspend fun reconcileAppliedWrite(
        token: String,
        parentId: String,
        path: String,
        name: String,
        mimeType: String,
        content: ByteArray,
        expectedId: String,
        requiredAppProperties: Map<String, String>,
        minimumExclusiveVersion: Long,
    ): DriveFileRef? {
        val matches = findChildren(token, parentId, name)
        if (matches.size != 1 || matches.single().id != expectedId) return null
        val metadata = getMetadata(token, expectedId)
        if (!isExpectedManagedFile(metadata, expectedId, parentId, name, mimeType, null)) return null
        if (metadata.version == null || metadata.version <= minimumExclusiveVersion) return null
        if (metadata.size != content.size.toLong()) return null
        if (requiredAppProperties.any { (key, value) -> metadata.appProperties[key] != value }) return null
        if (sha256RemoteMedia(token, expectedId, content.size.toLong()) != sha256(content)) return null
        val finalMetadata = getMetadata(token, expectedId)
        if (finalMetadata != metadata) return null
        return finalMetadata.toFileRef(path)
    }

    private fun isExpectedManagedFile(
        item: DriveItem,
        expectedId: String,
        parentId: String,
        name: String,
        mimeType: String,
        requireExistingMimeType: ((String?) -> Boolean)?,
    ): Boolean =
        item.id == expectedId &&
            item.name == name &&
            !item.trashed &&
            item.mimeType == mimeType &&
            item.parentIds == setOf(parentId) &&
            (requireExistingMimeType == null || requireExistingMimeType(item.mimeType))

    private suspend fun sha256RemoteMedia(
        token: String,
        fileId: String,
        expectedSize: Long,
    ): String {
        require(expectedSize >= 0) { "Drive media size must not be negative." }
        val digest = MessageDigest.getInstance("SHA-256")
        val mediaUrl = apiUrl(
            "files/${encodePathSegment(fileId)}",
            mapOf("alt" to "media"),
        )
        if (expectedSize == 0L) {
            val response = request(token = token, method = "GET", url = mediaUrl)
            if (response.body.isNotEmpty()) {
                throw DriveProtocolException("Drive empty media readback returned unexpected bytes.")
            }
            return digest.digest().toHex()
        }

        var offset = 0L
        while (offset < expectedSize) {
            val endInclusive = minOf(
                expectedSize - 1,
                offset + REMOTE_HASH_CHUNK_BYTES - 1,
            )
            val response = request(
                token = token,
                method = "GET",
                url = mediaUrl,
                headers = mapOf("Range" to "bytes=$offset-$endInclusive"),
            )
            val expectedChunkSize = (endInclusive - offset + 1).toInt()
            when (response.statusCode) {
                206 -> {
                    val contentRange = response.header("Content-Range")
                        ?.trim()
                        ?.let(CONTENT_RANGE_REGEX::matchEntire)
                        ?: throw DriveProtocolException(
                            "Drive ranged media readback omitted a valid Content-Range.",
                        )
                    val returnedStart = contentRange.groupValues[1].toLongOrNull()
                    val returnedEnd = contentRange.groupValues[2].toLongOrNull()
                    val returnedTotal = contentRange.groupValues[3].toLongOrNull()
                    if (
                        returnedStart != offset ||
                        returnedEnd != endInclusive ||
                        returnedTotal != expectedSize ||
                        response.body.size != expectedChunkSize
                    ) {
                        throw DriveProtocolException(
                            "Drive ranged media readback returned an unexpected byte range.",
                        )
                    }
                }
                200 -> {
                    if (
                        offset != 0L ||
                        expectedSize > REMOTE_HASH_CHUNK_BYTES ||
                        response.body.size.toLong() != expectedSize
                    ) {
                        throw DriveProtocolException(
                            "Drive media readback ignored a required byte range.",
                        )
                    }
                }
                else -> throw DriveProtocolException(
                    "Drive ranged media readback returned HTTP ${response.statusCode}.",
                )
            }
            digest.update(response.body)
            offset += response.body.size
        }
        return digest.digest().toHex()
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

    private suspend fun getMetadata(token: String, fileId: String): DriveItem =
        getMetadataResponse(token, fileId).first

    private suspend fun getMetadataResponse(
        token: String,
        fileId: String,
    ): Pair<DriveItem, DriveHttpResponse> {
        val response = request(
            token,
            "GET",
            apiUrl("files/${encodePathSegment(fileId)}", mapOf("fields" to FILE_FIELDS)),
        )
        return response.toDriveItem("Drive file metadata") to response
    }

    private suspend fun request(
        token: String,
        method: String,
        url: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        mapPreconditionConflict: Boolean = false,
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
            if (mapPreconditionConflict && response.statusCode in setOf(404, 409, 412)) {
                throw DriveWritePreconditionConflictException(
                    message = "Google Drive rejected the conditional write with HTTP ${response.statusCode}.",
                    statusCode = response.statusCode,
                )
            }
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

    private fun DriveHttpResponse.header(name: String): String? =
        headers.entries.firstOrNull { (key, _) -> key.equals(name, ignoreCase = true) }?.value

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
            parentIds = (value["parents"] as? JsonArray)
                ?.map { parent -> parent.jsonPrimitive.content }
                ?.toSet()
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
        val contentHash = payload?.let { payloadValue ->
            runCatching {
                when (entityType) {
                    "entry" -> DriveV1Hashing.entryContentHash(
                        JSON.decodeFromString(DriveV1Entry.serializer(), payloadValue.toString()),
                    )
                    "attachment" -> DriveV1Hashing.attachmentMetadataHash(
                        JSON.decodeFromString(DriveV1Attachment.serializer(), payloadValue.toString()),
                    )
                    "fileBoxItem" -> DriveV1Hashing.fileBoxMetadataHash(
                        JSON.decodeFromString(DriveV1FileBoxItem.serializer(), payloadValue.toString()),
                    )
                    "transfer" -> DriveV1Hashing.transferMetadataHash(
                        JSON.decodeFromString(DriveV1Transfer.serializer(), payloadValue.toString()),
                    )
                    else -> null
                }
            }.getOrNull()
        }
        return buildMap {
            put("entityType", entityType)
            entityId?.takeIf(String::isNotBlank)?.let { put("entityId", it) }
            contentHash?.let { put("contentHash", it) }
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

    private fun requireConditionalPrecondition(
        path: String,
        precondition: DriveWritePrecondition,
    ) {
        if (
            precondition !is DriveWritePrecondition.MustMatch &&
            precondition !is DriveWritePrecondition.MustNotExist
        ) {
            throw DriveProtocolException(
                "Drive conditional write has an unsupported precondition: $path",
            )
        }
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
        .toHex()

    private fun ByteArray.toHex(): String =
        joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

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
        val parentIds: Set<String>,
    )

    private companion object {
        const val DEFAULT_MAX_BLOB_BYTES = 256 * 1024 * 1024
        const val CONDITIONAL_RESUMABLE_MIN_BLOB_BYTES = 5 * 1024 * 1024
        const val CREATE_FINGERPRINT_PROPERTY = "easylabCreateFingerprint"
        const val CREATE_RESERVATION_PROPERTY_PREFIX = "easylabCreateReservation_"
        const val SHA256_HEX_LENGTH = 64
        const val DEFAULT_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024
        const val MAX_RESUMABLE_OPERATION_ID_LENGTH = 256
        const val REMOTE_HASH_CHUNK_BYTES = 4L * 1024 * 1024
        const val MAX_MANAGED_PATH_LENGTH = 1024
        const val MAX_PATH_SEGMENT_LENGTH = 255
        const val MAX_RETAINED_ERROR_BODY_BYTES = 16 * 1024
        const val DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
        const val DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
        const val FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
        const val JSON_MIME_TYPE = "application/json"
        const val MANIFEST_PATH = "manifest.json"
        const val UNKNOWN_MODIFIED_TIME = "1970-01-01T00:00:00Z"
        const val FILE_FIELDS = "id,name,mimeType,modifiedTime,size,version,trashed,appProperties,parents"
        val SHA256_REGEX = Regex("^[0-9a-fA-F]{64}$")
        val CONTENT_RANGE_REGEX = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$")
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
