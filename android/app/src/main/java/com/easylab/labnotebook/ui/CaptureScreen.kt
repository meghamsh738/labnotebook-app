package com.easylab.labnotebook.ui

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddAPhoto
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.easylab.labnotebook.IncomingShareRequest
import com.easylab.labnotebook.data.capture.AndroidCaptureReader
import com.easylab.labnotebook.data.capture.CaptureFile
import com.easylab.labnotebook.data.capture.CaptureRepository
import com.easylab.labnotebook.data.capture.CaptureResult
import com.easylab.labnotebook.data.local.AccountId
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

@Composable
internal fun CaptureScreen(
    accountId: AccountId,
    activeDeviceId: String?,
    repository: CaptureRepository?,
    pendingShare: IncomingShareRequest?,
    onShareConsumed: (String) -> Unit,
    onQuickNote: () -> Unit,
    onViewToday: () -> Unit,
) {
    val context = LocalContext.current
    val captureReader = remember(context) { AndroidCaptureReader(context) }
    val coroutineScope = rememberCoroutineScope()
    var busy by remember(accountId) { mutableStateOf(false) }
    var message by remember(accountId) { mutableStateOf<String?>(null) }
    var messageIsError by remember(accountId) { mutableStateOf(false) }
    var capturedCount by remember(accountId) { mutableIntStateOf(0) }
    var pendingCameraFile by remember(accountId) { mutableStateOf<File?>(null) }

    fun stage(
        provider: suspend () -> List<CaptureFile>,
        afterSuccess: (CaptureResult) -> Unit = {},
    ) {
        if (busy || repository == null || activeDeviceId.isNullOrBlank()) return
        busy = true
        message = null
        messageIsError = false
        coroutineScope.launch {
            runCatching {
                val files = provider()
                repository.attachToToday(
                    accountId = accountId,
                    activeDeviceId = activeDeviceId,
                    dateBucket = todayDateBucket(),
                    capturedAt = nativeEditTimestamp(),
                    files = files,
                )
            }.onSuccess { result ->
                capturedCount = result.attachments.size
                message = if (result.attachments.size == 1) {
                    "Added to today's entry"
                } else {
                    "Added ${result.attachments.size} files to today's entry"
                }
                afterSuccess(result)
            }.onFailure { error ->
                messageIsError = true
                message = error.captureMessage()
            }
            busy = false
        }
    }

    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val cameraFile = pendingCameraFile
        pendingCameraFile = null
        if (saved && cameraFile != null) {
            stage(provider = {
                try {
                    captureReader.read(
                        listOf(
                            FileProvider.getUriForFile(
                                context,
                                "${context.packageName}.fileprovider",
                                cameraFile,
                            ),
                        ),
                    )
                } finally {
                    cameraFile.delete()
                }
            })
        } else {
            cameraFile?.delete()
        }
    }
    val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) stage(provider = { captureReader.read(uris) })
    }
    val captureEnabled = repository != null && !activeDeviceId.isNullOrBlank() && !busy

    Page {
        item {
            SectionTitle(
                title = "Capture",
                subtitle = "Record an observation or add evidence to today's entry.",
            )
        }
        pendingShare?.let { share ->
            item {
                Column(
                    modifier = Modifier.fillMaxWidth().testTag("capture-shared-files"),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Shared with Easylab", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        if (share.uris.size == 1) "1 file is ready to add to today's entry."
                        else "${share.uris.size} files are ready to add to today's entry.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            enabled = captureEnabled,
                            onClick = {
                                stage(
                                    provider = { captureReader.read(share.uris) },
                                    afterSuccess = { onShareConsumed(share.id) },
                                )
                            },
                        ) { Text("Add to today") }
                        TextButton(onClick = { onShareConsumed(share.id) }) { Text("Dismiss") }
                    }
                }
            }
            item { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) }
        }
        item {
            CaptureActionRow(
                icon = Icons.Outlined.Description,
                title = "Quick note",
                body = "Open today's entry and start writing.",
                enabled = !busy,
                testTag = "capture-quick-note",
                onClick = onQuickNote,
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            CaptureActionRow(
                icon = Icons.Outlined.AddAPhoto,
                title = "Take photo",
                body = "Use the camera and keep a full-resolution copy with today's entry.",
                enabled = captureEnabled,
                testTag = "capture-take-photo",
                onClick = {
                    runCatching {
                        val file = context.newCapturePhoto()
                        pendingCameraFile = file
                        cameraLauncher.launch(
                            FileProvider.getUriForFile(
                                context,
                                "${context.packageName}.fileprovider",
                                file,
                            ),
                        )
                    }.onFailure { error ->
                        pendingCameraFile?.delete()
                        pendingCameraFile = null
                        messageIsError = true
                        message = error.captureMessage()
                    }
                },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            CaptureActionRow(
                icon = Icons.Outlined.AttachFile,
                title = "Choose files",
                body = "Add images, PDFs, spreadsheets, or instrument exports from this device.",
                enabled = captureEnabled,
                testTag = "capture-choose-files",
                onClick = { fileLauncher.launch(arrayOf("*/*")) },
            )
        }
        if (busy) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("capture-progress"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text("Adding to today's entry…")
                }
            }
        }
        message?.let { currentMessage ->
            item {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp).testTag("capture-result"),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        currentMessage,
                        fontWeight = FontWeight.SemiBold,
                        color = if (messageIsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    )
                    if (!messageIsError && capturedCount > 0) {
                        TextButton(onClick = onViewToday) { Text("View today's entry") }
                    }
                }
            }
        }
        if (repository == null || activeDeviceId.isNullOrBlank()) {
            item {
                Text(
                    "Capture is unavailable until this device finishes opening the notebook.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun CaptureActionRow(
    icon: ImageVector,
    title: String,
    body: String,
    enabled: Boolean,
    testTag: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().testTag(testTag),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("›", style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}

private fun Context.newCapturePhoto(): File {
    val directory = File(cacheDir, "camera-capture")
    check(directory.mkdirs() || directory.isDirectory) { "Camera storage is unavailable." }
    val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
    return File.createTempFile("Easylab_$stamp-", ".jpg", directory)
}

private fun Throwable.captureMessage(): String = when (this) {
    is IllegalArgumentException, is IllegalStateException -> message ?: "The files could not be added."
    else -> "The files could not be added. Try again."
}
