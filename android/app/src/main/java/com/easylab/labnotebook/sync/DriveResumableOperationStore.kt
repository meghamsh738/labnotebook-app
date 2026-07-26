package com.easylab.labnotebook.sync

import android.content.Context
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.DriveFileRef
import com.easylab.labnotebook.data.repository.DriveProtocolException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal data class DriveResumableOperationIdentity(
    val accountId: AccountId,
    val operationId: String,
    val path: String,
    val fileId: String,
    val expectedVersion: Long,
    val sha256: String,
    val byteSize: Long,
    val mimeType: String,
) {
    init {
        require(operationId.isNotBlank() && operationId.length <= MAX_OPERATION_ID_LENGTH) {
            "Drive resumable operation id is invalid."
        }
        require(operationId.none(Char::isISOControl)) {
            "Drive resumable operation id contains control characters."
        }
        require(path.isNotBlank()) { "Drive resumable operation path must not be blank." }
        require(fileId.isNotBlank()) { "Drive resumable operation file id must not be blank." }
        require(expectedVersion > 0) { "Drive resumable operation version must be positive." }
        require(SHA256_REGEX.matches(sha256)) {
            "Drive resumable operation SHA-256 must be canonical lowercase hexadecimal."
        }
        require(byteSize >= 0) { "Drive resumable operation byte size must not be negative." }
        require(mimeType.isNotBlank()) { "Drive resumable operation MIME type must not be blank." }
    }

    private companion object {
        const val MAX_OPERATION_ID_LENGTH = 256
        val SHA256_REGEX = Regex("^[0-9a-f]{64}$")
    }
}

internal enum class DriveResumableOperationState {
    Prepared,
    Ambiguous,
    Completed,
}

internal data class DriveResumableOperationRecord(
    val identity: DriveResumableOperationIdentity,
    val state: DriveResumableOperationState,
    val completedVersion: Long? = null,
)

internal class DriveResumableOperationIdentityConflictException(message: String) : Exception(message)

internal interface DriveResumableOperationPersistence {
    suspend fun read(key: String): String?

    /**
     * Atomically stores [value] only when [key] is absent and returns the value
     * now bound to the key.
     */
    suspend fun bindIfAbsent(key: String, value: String): String

    /** Atomically replaces [expected] with [value]. */
    suspend fun compareAndSet(key: String, expected: String, value: String): Boolean
}

/**
 * Durable immutable identity registry for conditional blob updates.
 *
 * Records are keyed by an account hash plus operation-id hash. They contain no
 * OAuth token or resumable session URI.
 */
internal class DriveResumableOperationStore(
    private val persistence: DriveResumableOperationPersistence,
) {
    suspend fun begin(identity: DriveResumableOperationIdentity): DriveResumableOperationRecord {
        val prepared = DriveResumableOperationRecord(
            identity = identity,
            state = DriveResumableOperationState.Prepared,
        )
        val bound = decode(
            persistence.bindIfAbsent(
                storageKey(identity.accountId, identity.operationId),
                encode(prepared),
            ),
        )
        if (bound.identity != identity) {
            throw DriveResumableOperationIdentityConflictException(
                "Drive resumable operation id is already bound to different immutable content.",
            )
        }
        return bound
    }

    suspend fun markAmbiguous(identity: DriveResumableOperationIdentity) {
        update(identity) { current ->
            if (current.state == DriveResumableOperationState.Completed) {
                current
            } else {
                current.copy(
                    state = DriveResumableOperationState.Ambiguous,
                    completedVersion = null,
                )
            }
        }
    }

    suspend fun markCompleted(
        identity: DriveResumableOperationIdentity,
        file: DriveFileRef,
    ) {
        require(file.id == identity.fileId && file.path == identity.path) {
            "Drive resumable completion does not match its operation identity."
        }
        val version = file.version
            ?: throw DriveProtocolException("Drive resumable completion omitted its file version.")
        require(version > identity.expectedVersion) {
            "Drive resumable completion did not advance its expected file version."
        }
        update(identity) { current ->
            current.copy(
                state = DriveResumableOperationState.Completed,
                completedVersion = maxOf(current.completedVersion ?: version, version),
            )
        }
    }

    suspend fun record(
        accountId: AccountId,
        operationId: String,
    ): DriveResumableOperationRecord? =
        persistence.read(storageKey(accountId, operationId))?.let(::decode)

    private suspend fun update(
        identity: DriveResumableOperationIdentity,
        transform: (DriveResumableOperationRecord) -> DriveResumableOperationRecord,
    ) {
        val key = storageKey(identity.accountId, identity.operationId)
        repeat(MAX_UPDATE_ATTEMPTS) {
            val encodedCurrent = persistence.read(key)
                ?: throw DriveProtocolException("Drive resumable operation identity was not prepared.")
            val current = decode(encodedCurrent)
            if (current.identity != identity) {
                throw DriveResumableOperationIdentityConflictException(
                    "Drive resumable operation identity changed before its outcome was persisted.",
                )
            }
            val updated = transform(current)
            if (persistence.compareAndSet(key, encodedCurrent, encode(updated))) return
        }
        throw DriveProtocolException("Drive resumable operation outcome changed too many times concurrently.")
    }

    private fun encode(record: DriveResumableOperationRecord): String = buildJsonObject {
        put("version", FORMAT_VERSION)
        put("accountId", record.identity.accountId.value)
        put("operationId", record.identity.operationId)
        put("path", record.identity.path)
        put("fileId", record.identity.fileId)
        put("expectedVersion", record.identity.expectedVersion)
        put("sha256", record.identity.sha256.lowercase())
        put("byteSize", record.identity.byteSize)
        put("mimeType", record.identity.mimeType)
        put("state", record.state.name)
        record.completedVersion?.let { put("completedVersion", it) }
    }.toString()

    private fun decode(raw: String): DriveResumableOperationRecord {
        val value = try {
            JSON.parseToJsonElement(raw) as? JsonObject
        } catch (error: Exception) {
            throw DriveProtocolException("Persisted Drive resumable operation is invalid.", error)
        } ?: throw DriveProtocolException("Persisted Drive resumable operation must be an object.")
        fun text(name: String): String = value[name]?.jsonPrimitive?.contentOrNull
            ?.takeIf(String::isNotBlank)
            ?: throw DriveProtocolException("Persisted Drive resumable operation omitted $name.")
        if (value["version"]?.jsonPrimitive?.longOrNull != FORMAT_VERSION.toLong()) {
            throw DriveProtocolException("Persisted Drive resumable operation version is unsupported.")
        }
        val identity = DriveResumableOperationIdentity(
            accountId = AccountId(text("accountId")),
            operationId = text("operationId"),
            path = text("path"),
            fileId = text("fileId"),
            expectedVersion = value["expectedVersion"]?.jsonPrimitive?.longOrNull
                ?: throw DriveProtocolException("Persisted Drive resumable operation omitted expectedVersion."),
            sha256 = text("sha256"),
            byteSize = value["byteSize"]?.jsonPrimitive?.longOrNull
                ?: throw DriveProtocolException("Persisted Drive resumable operation omitted byteSize."),
            mimeType = text("mimeType"),
        )
        val state = runCatching { DriveResumableOperationState.valueOf(text("state")) }
            .getOrElse { throw DriveProtocolException("Persisted Drive resumable operation state is invalid.", it) }
        val completedVersion = value["completedVersion"]?.jsonPrimitive?.longOrNull
        if (
            state == DriveResumableOperationState.Completed &&
            (completedVersion == null || completedVersion <= identity.expectedVersion)
        ) {
            throw DriveProtocolException("Persisted Drive resumable completion version is invalid.")
        }
        if (state != DriveResumableOperationState.Completed && completedVersion != null) {
            throw DriveProtocolException("Persisted Drive resumable non-completion has a completion version.")
        }
        return DriveResumableOperationRecord(identity, state, completedVersion)
    }

    private fun storageKey(accountId: AccountId, operationId: String): String =
        "${sha256(accountId.value)}:${sha256(operationId)}"

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private companion object {
        const val FORMAT_VERSION = 1
        const val MAX_UPDATE_ATTEMPTS = 8
        val JSON = Json { ignoreUnknownKeys = false }
    }
}

internal class SharedPreferencesDriveResumableOperationPersistence(context: Context) :
    DriveResumableOperationPersistence {
    private val preferences = context.applicationContext.getSharedPreferences(
        "easylab-drive-resumable-operations",
        Context.MODE_PRIVATE,
    )

    override suspend fun read(key: String): String? = withContext(Dispatchers.IO) {
        synchronized(PREFERENCES_LOCK) {
            preferences.getString(key, null)
        }
    }

    override suspend fun bindIfAbsent(key: String, value: String): String =
        withContext(Dispatchers.IO) {
            synchronized(PREFERENCES_LOCK) {
                preferences.getString(key, null)?.let { return@withContext it }
                if (!preferences.edit().putString(key, value).commit()) {
                    throw DriveProtocolException("Could not persist Drive resumable operation identity.")
                }
                value
            }
        }

    override suspend fun compareAndSet(
        key: String,
        expected: String,
        value: String,
    ): Boolean = withContext(Dispatchers.IO) {
        synchronized(PREFERENCES_LOCK) {
            if (preferences.getString(key, null) != expected) {
                return@withContext false
            }
            if (!preferences.edit().putString(key, value).commit()) {
                throw DriveProtocolException("Could not persist Drive resumable operation outcome.")
            }
            true
        }
    }

    private companion object {
        /**
         * SharedPreferences is process-local. This lock makes bind/CAS atomic
         * across repository instances in Easylab's single Android process.
         */
        val PREFERENCES_LOCK = Any()
    }
}
