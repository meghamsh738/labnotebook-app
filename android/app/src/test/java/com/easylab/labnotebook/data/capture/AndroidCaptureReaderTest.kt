package com.easylab.labnotebook.data.capture

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayInputStream
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AndroidCaptureReaderTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun readsAccountStagingBytesFromContentUris() = runTest {
        val uri = Uri.parse("content://instrument/result")
        shadowOf(context.contentResolver).registerInputStream(uri, ByteArrayInputStream(byteArrayOf(1, 2, 3)))

        val result = AndroidCaptureReader(context).read(listOf(uri)).single()

        assertEquals("evidence", result.filename)
        assertEquals("application/octet-stream", result.mimeType)
        assertEquals(listOf<Byte>(1, 2, 3), result.bytes.toList())
    }

    @Test
    fun rejectsAggregateBytesWhileReadingBeforeReturningAnyFiles() = runTest {
        val first = Uri.parse("content://instrument/first")
        val second = Uri.parse("content://instrument/second")
        shadowOf(context.contentResolver).registerInputStream(first, ByteArrayInputStream(byteArrayOf(1, 2, 3)))
        shadowOf(context.contentResolver).registerInputStream(second, ByteArrayInputStream(byteArrayOf(4, 5, 6)))

        val result = runCatching {
            AndroidCaptureReader(context, CaptureLimits(maxFileBytes = 4, maxBatchBytes = 5, maxFiles = 2))
                .read(listOf(first, second))
        }

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("too large in total"))
    }

    @Test
    fun rejectsTooManyUrisAndUnsafeSchemesBeforeOpeningContent() = runTest {
        val reader = AndroidCaptureReader(context, CaptureLimits(maxFileBytes = 4, maxBatchBytes = 8, maxFiles = 1))
        val tooMany = runCatching {
            reader.read(listOf(Uri.parse("content://one"), Uri.parse("content://two")))
        }
        val unsafe = runCatching { reader.read(listOf(Uri.parse("file:///private/result.csv"))) }

        assertTrue(tooMany.exceptionOrNull()?.message.orEmpty().contains("no more than 1"))
        assertTrue(unsafe.exceptionOrNull()?.message.orEmpty().contains("securely shared"))
    }
}
