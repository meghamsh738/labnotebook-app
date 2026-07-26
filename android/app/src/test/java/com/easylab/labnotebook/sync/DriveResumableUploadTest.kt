package com.easylab.labnotebook.sync

import com.easylab.labnotebook.data.repository.DriveProtocolException
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveResumableUploadTest {
    @Test
    fun sendsChunkedPutsAndAdvancesFromValidated308Range() = runTest {
        val chunkBytes = 256 * 1024
        val content = ByteArray(chunkBytes + 17) { (it % 251).toByte() }
        val transport = RecordingTransport { request, index ->
            when (index) {
                0 -> DriveHttpResponse(
                    308,
                    headers = mapOf("Range" to "bytes=0-${chunkBytes - 1}"),
                )
                1 -> DriveHttpResponse(200, body = """{"id":"file"}""".toByteArray())
                else -> error("Unexpected request")
            }
        }

        val response = DriveResumableUploader(transport, chunkBytes).upload(
            token = "secret-token",
            sessionUrl = TRUSTED_SESSION,
            content = content,
            mimeType = "application/octet-stream",
        )

        assertEquals(200, response.statusCode)
        assertEquals(
            "bytes 0-${chunkBytes - 1}/${content.size}",
            transport.requests[0].headers["Content-Range"],
        )
        assertEquals(
            "bytes $chunkBytes-${content.lastIndex}/${content.size}",
            transport.requests[1].headers["Content-Range"],
        )
        assertEquals("Bearer secret-token", transport.requests[1].headers["Authorization"])
    }

    @Test
    fun interruptionQueriesStatusAndResumesWithoutRepeatingAcceptedBytes() = runTest {
        val chunkBytes = 256 * 1024
        val content = ByteArray(chunkBytes + 9)
        val transport = RecordingTransport { _, index ->
            when (index) {
                0 -> throw IOException("lost first chunk response")
                1 -> DriveHttpResponse(
                    308,
                    headers = mapOf("Range" to "bytes=0-${chunkBytes - 1}"),
                )
                2 -> DriveHttpResponse(200)
                else -> error("Unexpected request")
            }
        }

        DriveResumableUploader(transport, chunkBytes).upload(
            "token",
            TRUSTED_SESSION,
            content,
            "application/octet-stream",
        )

        assertEquals("bytes */${content.size}", transport.requests[1].headers["Content-Range"])
        assertEquals(
            "bytes $chunkBytes-${content.lastIndex}/${content.size}",
            transport.requests[2].headers["Content-Range"],
        )
    }

    @Test
    fun ambiguousFinalCommitIsRecoveredByCompletedStatusQuery() = runTest {
        val content = ByteArray(31)
        val transport = RecordingTransport { _, index ->
            when (index) {
                0 -> throw IOException("lost final response")
                1 -> DriveHttpResponse(200)
                else -> error("Unexpected request")
            }
        }

        val result = DriveResumableUploader(transport, 256 * 1024).upload(
            "token",
            TRUSTED_SESSION,
            content,
            "application/octet-stream",
        )

        assertEquals(200, result.statusCode)
        assertEquals("bytes */31", transport.requests[1].headers["Content-Range"])
        assertTrue(transport.requests[1].body?.isEmpty() == true)
    }

    @Test
    fun malformedOrOutOfBoundsServerRangeIsRejected() = runTest {
        val transport = RecordingTransport { _, _ ->
            DriveHttpResponse(308, headers = mapOf("Range" to "bytes=0-999999"))
        }

        val error = runCatching {
            DriveResumableUploader(transport, 256 * 1024).upload(
                "token",
                TRUSTED_SESSION,
                ByteArray(10),
                "application/octet-stream",
            )
        }.exceptionOrNull()

        assertTrue(error is DriveProtocolException)
        assertTrue(error?.message.orEmpty().contains("out-of-bounds"))
    }

    @Test
    fun untrustedSessionUrlIsRejectedBeforeBearerTokenCanBeSent() = runTest {
        val transport = RecordingTransport { _, _ -> error("must not execute") }

        val error = runCatching {
            DriveResumableUploader(transport, 256 * 1024).upload(
                "secret-token",
                "https://googleapis.com.evil.example/upload/session",
                ByteArray(1),
                "application/octet-stream",
            )
        }.exceptionOrNull()

        assertTrue(error is DriveProtocolException)
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun cancellationPropagatesWithoutARecoveryRequest() = runTest {
        val transport = RecordingTransport { _, _ ->
            throw CancellationException("cancelled")
        }
        var cancellation: CancellationException? = null

        try {
            DriveResumableUploader(transport, 256 * 1024).upload(
                "token",
                TRUSTED_SESSION,
                ByteArray(1),
                "application/octet-stream",
            )
        } catch (error: CancellationException) {
            cancellation = error
        }

        assertEquals("cancelled", cancellation?.message)
        assertEquals(1, transport.requests.size)
    }

    @Test
    fun repeatedServerFailuresWithNoRecoveredProgressAreBounded() = runTest {
        val transport = RecordingTransport { request, _ ->
            if (request.headers["Content-Range"]?.startsWith("bytes */") == true) {
                DriveHttpResponse(308)
            } else {
                DriveHttpResponse(503)
            }
        }

        val error = runCatching {
            DriveResumableUploader(transport, 256 * 1024).upload(
                "token",
                TRUSTED_SESSION,
                ByteArray(1),
                "application/octet-stream",
            )
        }.exceptionOrNull()

        assertTrue(error is DriveProtocolException)
        assertTrue(error?.message.orEmpty().contains("no progress"))
        assertTrue(transport.requests.size <= 6)
    }

    private class RecordingTransport(
        private val handler: suspend (DriveHttpRequest, Int) -> DriveHttpResponse,
    ) : DriveWriteTransport {
        val requests = mutableListOf<DriveHttpRequest>()

        override suspend fun execute(request: DriveHttpRequest): DriveHttpResponse {
            val index = requests.size
            requests += request
            return handler(request, index)
        }
    }

    private companion object {
        const val TRUSTED_SESSION =
            "https://www.googleapis.com/upload/drive/v3/files/file-id?upload_id=session-1"
    }
}
