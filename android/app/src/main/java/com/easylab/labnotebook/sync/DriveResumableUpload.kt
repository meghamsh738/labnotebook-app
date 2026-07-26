package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.repository.DriveHttpException
import com.easylab.labnotebook.data.repository.DriveProtocolException
import java.io.IOException
import java.net.URI
import kotlin.math.min

/**
 * Process-local resumable upload engine for an already-created Drive session.
 *
 * The caller owns target-file CAS and final content verification. A process restart
 * deliberately starts a new session under the same file/version precondition; an
 * incomplete old session cannot publish a partial file and expires server-side.
 */
internal class DriveResumableUploader(
    private val transport: DriveWriteTransport,
    private val chunkBytes: Int = DEFAULT_CHUNK_BYTES,
    private val maxRecoveryQueries: Int = DEFAULT_MAX_RECOVERY_QUERIES,
) {
    init {
        require(chunkBytes > 0 && chunkBytes % CHUNK_GRANULARITY_BYTES == 0) {
            "Drive resumable chunk size must be a positive multiple of 256 KiB."
        }
        require(maxRecoveryQueries in 1..MAX_RECOVERY_QUERY_LIMIT) {
            "Drive resumable recovery query limit is invalid."
        }
    }

    suspend fun upload(
        token: String,
        sessionUrl: String,
        content: ByteArray,
        mimeType: String,
    ): DriveHttpResponse {
        require(token.isNotBlank()) { "Drive resumable upload token must not be blank." }
        require(content.isNotEmpty()) { "Drive resumable upload content must not be empty." }
        require(mimeType.isNotBlank()) { "Drive resumable upload MIME type must not be blank." }
        val safeSessionUrl = requireGoogleSessionUrl(sessionUrl)
        var offset = 0
        var noProgressResponses = 0

        while (offset < content.size) {
            val endExclusive = min(content.size, offset + chunkBytes)
            val response = try {
                execute(
                    token = token,
                    method = "PUT",
                    url = safeSessionUrl,
                    headers = mapOf(
                        "Content-Type" to mimeType,
                        "Content-Range" to "bytes $offset-${endExclusive - 1}/${content.size}",
                    ),
                    body = content.copyOfRange(offset, endExclusive),
                )
            } catch (_: IOException) {
                queryStatus(token, safeSessionUrl, content.size)
            }

            when {
                response.statusCode in setOf(200, 201) -> {
                    if (endExclusive != content.size) {
                        throw DriveProtocolException(
                            "Drive resumable upload completed before the final chunk.",
                        )
                    }
                    return response
                }
                response.statusCode == RESUME_INCOMPLETE_STATUS -> {
                    val nextOffset = nextOffset(response, content.size)
                    if (nextOffset < offset) {
                        throw DriveProtocolException("Drive resumable upload offset moved backwards.")
                    }
                    if (nextOffset == offset) {
                        noProgressResponses += 1
                        if (noProgressResponses > MAX_NO_PROGRESS_RESPONSES) {
                            throw DriveProtocolException("Drive resumable upload made no progress.")
                        }
                    } else {
                        noProgressResponses = 0
                    }
                    offset = nextOffset
                }
                response.statusCode in 500..599 -> {
                    val recovered = queryStatus(token, safeSessionUrl, content.size)
                    if (recovered.statusCode in setOf(200, 201)) return recovered
                    val nextOffset = nextOffset(recovered, content.size)
                    if (nextOffset < offset) {
                        throw DriveProtocolException("Drive resumable recovery offset moved backwards.")
                    }
                    if (nextOffset == offset) {
                        noProgressResponses += 1
                        if (noProgressResponses > MAX_NO_PROGRESS_RESPONSES) {
                            throw DriveProtocolException("Drive resumable upload made no progress.")
                        }
                    } else {
                        noProgressResponses = 0
                    }
                    offset = nextOffset
                }
                else -> throw httpFailure(response, "Drive resumable chunk upload")
            }
        }
        throw DriveProtocolException("Drive resumable upload ended without a completion response.")
    }

    private suspend fun queryStatus(
        token: String,
        sessionUrl: String,
        totalBytes: Int,
    ): DriveHttpResponse {
        var lastFailure: Throwable? = null
        repeat(maxRecoveryQueries) {
            val response = try {
                execute(
                    token = token,
                    method = "PUT",
                    url = sessionUrl,
                    headers = mapOf("Content-Range" to "bytes */$totalBytes"),
                    body = byteArrayOf(),
                )
            } catch (error: IOException) {
                lastFailure = error
                return@repeat
            }
            when {
                response.statusCode in setOf(200, 201, RESUME_INCOMPLETE_STATUS) -> return response
                response.statusCode in 500..599 -> {
                    lastFailure = httpFailure(response, "Drive resumable status query")
                }
                response.statusCode == 404 -> throw DriveProtocolException(
                    "Drive resumable upload session expired before completion.",
                )
                else -> throw httpFailure(response, "Drive resumable status query")
            }
        }
        throw DriveProtocolException(
            "Drive resumable upload status could not be recovered.",
            lastFailure,
        )
    }

    private suspend fun execute(
        token: String,
        method: String,
        url: String,
        headers: Map<String, String>,
        body: ByteArray,
    ): DriveHttpResponse = transport.execute(
        DriveHttpRequest(
            method = method,
            url = url,
            headers = headers + mapOf(
                "Authorization" to "Bearer $token",
                "Accept" to "application/json",
            ),
            body = body,
        ),
    )

    private fun nextOffset(response: DriveHttpResponse, totalBytes: Int): Int {
        val range = response.header("Range") ?: return 0
        val match = RANGE_REGEX.matchEntire(range.trim())
            ?: throw DriveProtocolException("Drive resumable upload returned an invalid Range header.")
        val lastByte = match.groupValues[1].toLongOrNull()
            ?: throw DriveProtocolException("Drive resumable upload returned an invalid Range offset.")
        if (lastByte < 0 || lastByte >= totalBytes.toLong() - 1) {
            throw DriveProtocolException("Drive resumable upload returned an out-of-bounds Range.")
        }
        return (lastByte + 1).toInt()
    }

    private fun requireGoogleSessionUrl(rawUrl: String): String {
        val uri = try {
            URI(rawUrl)
        } catch (error: Exception) {
            throw DriveProtocolException("Drive resumable upload returned an invalid session URL.", error)
        }
        val host = uri.host?.lowercase()
        if (
            uri.scheme?.lowercase() != "https" ||
            host == null ||
            (host != GOOGLE_API_HOST && !host.endsWith(".$GOOGLE_API_HOST")) ||
            (uri.port != -1 && uri.port != 443) ||
            uri.userInfo != null ||
            uri.fragment != null ||
            !uri.path.orEmpty().startsWith("/upload/")
        ) {
            throw DriveProtocolException("Drive resumable upload returned an untrusted session URL.")
        }
        return uri.toASCIIString()
    }

    private fun httpFailure(response: DriveHttpResponse, label: String): DriveHttpException {
        val retainedBody = response.body
            .copyOf(min(response.body.size, MAX_RETAINED_ERROR_BODY_BYTES))
            .toString(Charsets.UTF_8)
            .takeIf(String::isNotBlank)
        return DriveHttpException(
            statusCode = response.statusCode,
            message = "$label failed with HTTP ${response.statusCode}.",
            responseBody = retainedBody,
        )
    }

    private fun DriveHttpResponse.header(name: String): String? =
        headers.entries.firstOrNull { (key, _) -> key.equals(name, ignoreCase = true) }?.value

    private companion object {
        const val CHUNK_GRANULARITY_BYTES = 256 * 1024
        const val DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
        const val DEFAULT_MAX_RECOVERY_QUERIES = 3
        const val MAX_RECOVERY_QUERY_LIMIT = 8
        const val MAX_NO_PROGRESS_RESPONSES = 2
        const val MAX_RETAINED_ERROR_BODY_BYTES = 16 * 1024
        const val RESUME_INCOMPLETE_STATUS = 308
        const val GOOGLE_API_HOST = "googleapis.com"
        val RANGE_REGEX = Regex("^bytes=0-(\\d+)$")
    }
}
