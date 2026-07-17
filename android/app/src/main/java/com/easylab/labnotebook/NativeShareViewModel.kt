package com.easylab.labnotebook

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.lifecycle.ViewModel
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class IncomingShareRequest(
    val id: String,
    val uris: List<Uri>,
    val mimeType: String?,
)

class NativeShareViewModel : ViewModel() {
    private val mutablePendingShare = MutableStateFlow<IncomingShareRequest?>(null)
    private val waitingShares = ArrayDeque<IncomingShareRequest>()
    private var lastInitialFingerprint: String? = null

    val pendingShare: StateFlow<IncomingShareRequest?> = mutablePendingShare.asStateFlow()

    @Synchronized
    fun acceptIntent(intent: Intent?, allowRepeat: Boolean): Boolean {
        val request = intent?.toShareRequest() ?: return false
        val fingerprint = request.fingerprint()
        if (!allowRepeat && fingerprint == lastInitialFingerprint) return false
        lastInitialFingerprint = fingerprint
        if (mutablePendingShare.value == null) mutablePendingShare.value = request
        else waitingShares.addLast(request)
        return true
    }

    @Synchronized
    fun consume(requestId: String) {
        if (mutablePendingShare.value?.id == requestId) {
            mutablePendingShare.value = waitingShares.removeFirstOrNull()
        }
    }
}

private fun Intent.toShareRequest(): IncomingShareRequest? {
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
    val uris = buildList {
        clipData?.let { clips ->
            repeat(clips.itemCount) { index -> clips.getItemAt(index).uri?.let(::add) }
        }
        when (action) {
            Intent.ACTION_SEND -> streamUri()?.let(::add)
            Intent.ACTION_SEND_MULTIPLE -> addAll(streamUris())
        }
    }.filter { it.scheme == "content" }.distinctBy(Uri::toString)
    if (uris.isEmpty()) return null
    return IncomingShareRequest(
        id = UUID.randomUUID().toString(),
        uris = uris,
        mimeType = type,
    )
}

@Suppress("DEPRECATION")
private fun Intent.streamUri(): Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
} else {
    getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
}

@Suppress("DEPRECATION")
private fun Intent.streamUris(): List<Uri> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
} else {
    getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
}

private fun IncomingShareRequest.fingerprint(): String = buildString {
    append(mimeType.orEmpty())
    uris.forEach { uri -> append('\u0000').append(uri) }
}
