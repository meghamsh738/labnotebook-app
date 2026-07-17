package com.easylab.labnotebook

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NativeShareViewModelTest {
    @Test
    fun acceptsSingleAndMultipleContentSharesButRejectsTextOnlyAndFileUris() {
        val viewModel = NativeShareViewModel()
        val single = Intent(Intent.ACTION_SEND)
            .setType("image/png")
            .putExtra(Intent.EXTRA_STREAM, Uri.parse("content://lab-camera/image-1"))

        assertTrue(viewModel.acceptIntent(single, allowRepeat = false))
        assertEquals(listOf("content://lab-camera/image-1"), viewModel.pendingShare.value?.uris?.map(Uri::toString))
        val singleRequestId = checkNotNull(viewModel.pendingShare.value).id

        val multiple = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*").apply {
            clipData = ClipData.newRawUri("first", Uri.parse("content://lab-camera/image-2")).apply {
                addItem(ClipData.Item(Uri.parse("content://lab-camera/image-3")))
            }
            putParcelableArrayListExtra(
                Intent.EXTRA_STREAM,
                arrayListOf(Uri.parse("content://lab-camera/image-2"), Uri.parse("file:///private/result.png")),
            )
        }
        assertTrue(viewModel.acceptIntent(multiple, allowRepeat = true))
        assertEquals(singleRequestId, viewModel.pendingShare.value?.id)
        viewModel.consume(singleRequestId)
        assertEquals(
            listOf("content://lab-camera/image-2", "content://lab-camera/image-3"),
            viewModel.pendingShare.value?.uris?.map(Uri::toString),
        )

        assertFalse(viewModel.acceptIntent(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "observation"), true))
        assertFalse(
            viewModel.acceptIntent(
                Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///private/result.csv")),
                true,
            ),
        )
    }

    @Test
    fun recreationDeduplicatesInitialIntentWhileNewDeliveriesQueueWithoutReplacingIt() {
        val viewModel = NativeShareViewModel()
        val intent = Intent(Intent.ACTION_SEND)
            .setType("application/pdf")
            .putExtra(Intent.EXTRA_STREAM, Uri.parse("content://instrument/result"))

        assertTrue(viewModel.acceptIntent(intent, allowRepeat = false))
        val firstId = viewModel.pendingShare.value?.id
        assertFalse(viewModel.acceptIntent(intent, allowRepeat = false))
        assertEquals(firstId, viewModel.pendingShare.value?.id)

        assertTrue(viewModel.acceptIntent(intent, allowRepeat = true))
        assertEquals(firstId, viewModel.pendingShare.value?.id)
        viewModel.consume(checkNotNull(firstId))
        assertNotEquals(firstId, viewModel.pendingShare.value?.id)
    }

    @Test
    fun onlyTheCurrentRequestCanBeConsumed() {
        val viewModel = NativeShareViewModel()
        viewModel.acceptIntent(
            Intent(Intent.ACTION_SEND)
                .setType("text/csv")
                .putExtra(Intent.EXTRA_STREAM, Uri.parse("content://instrument/result")),
            allowRepeat = false,
        )
        val requestId = checkNotNull(viewModel.pendingShare.value).id

        viewModel.consume("stale-request")
        assertEquals(requestId, viewModel.pendingShare.value?.id)
        viewModel.consume(requestId)
        assertNull(viewModel.pendingShare.value)
    }
}
