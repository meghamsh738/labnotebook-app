package com.easylab.labnotebook.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.clickable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.migration.LegacyImportPolicy
import com.easylab.labnotebook.data.migration.LegacyImportResult
import com.easylab.labnotebook.data.migration.LegacyWorkspaceImportRepository
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val MAX_LEGACY_IMPORT_CHARS = 128 * 1024 * 1024

private data class PendingLegacyImport(
    val filename: String,
    val rawJson: String,
)

private sealed interface LegacyImportUiState {
    data object Idle : LegacyImportUiState
    data object Reading : LegacyImportUiState
    data class Ready(val pending: PendingLegacyImport) : LegacyImportUiState
    data class Importing(val pending: PendingLegacyImport) : LegacyImportUiState
    data class MergeConfirmation(val pending: PendingLegacyImport) : LegacyImportUiState
    data class Success(val result: LegacyImportResult) : LegacyImportUiState
    data class Error(val message: String) : LegacyImportUiState
}

@Composable
internal fun LegacyImportSettings(
    accountId: AccountId,
    activeDeviceId: String?,
    repository: LegacyWorkspaceImportRepository?,
) {
    if (repository == null || activeDeviceId.isNullOrBlank()) return

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var state by remember(accountId) { mutableStateOf<LegacyImportUiState>(LegacyImportUiState.Idle) }
    var advancedExpanded by remember(accountId) { mutableStateOf(false) }

    fun runImport(pending: PendingLegacyImport, policy: LegacyImportPolicy) {
        state = LegacyImportUiState.Importing(pending)
        scope.launch {
            val result = runCatching {
                repository.import(accountId, activeDeviceId, pending.rawJson, policy)
            }
            state = result.fold(
                onSuccess = { LegacyImportUiState.Success(it) },
                onFailure = { error ->
                    if (
                        policy == LegacyImportPolicy.RequireEmptyWorkspace &&
                        error.message.orEmpty().contains("already contains notebook data")
                    ) {
                        LegacyImportUiState.MergeConfirmation(pending)
                    } else {
                        LegacyImportUiState.Error(error.productMessage())
                    }
                },
            )
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        state = LegacyImportUiState.Reading
        scope.launch {
            state = runCatching { context.readLegacyBackup(uri) }.fold(
                onSuccess = { LegacyImportUiState.Ready(it) },
                onFailure = { LegacyImportUiState.Error(it.productMessage()) },
            )
        }
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        HorizontalDivider()
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable { advancedExpanded = !advancedExpanded },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Advanced", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    "Recovery tools",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(if (advancedExpanded) "−" else "+", style = MaterialTheme.typography.titleLarge)
        }
        if (!advancedExpanded) return@Column
        Text("Previous Easylab backup", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(
            "Move notes and cached files from the earlier app. The backup file is never changed.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton(
            onClick = {
                picker.launch(
                    arrayOf(
                        "application/json",
                        "text/json",
                        "text/plain",
                        "application/octet-stream",
                    ),
                )
            },
            enabled = state !is LegacyImportUiState.Reading && state !is LegacyImportUiState.Importing,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Choose backup")
        }
        when (val current = state) {
            LegacyImportUiState.Reading -> ProgressRow("Checking backup…")
            is LegacyImportUiState.Success -> {
                Text(current.result.productSummary(), fontWeight = FontWeight.SemiBold)
                Text(
                    "Recovered changes are stored on this device for this Google account.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { state = LegacyImportUiState.Idle }) { Text("Done") }
            }
            is LegacyImportUiState.Error -> {
                Text(current.message, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { state = LegacyImportUiState.Idle }) { Text("Dismiss") }
            }
            else -> Unit
        }
    }

    when (val current = state) {
        is LegacyImportUiState.Ready -> AlertDialog(
            onDismissRequest = { state = LegacyImportUiState.Idle },
            title = { Text("Import previous notebook?") },
            text = {
                Text(
                    "${current.pending.filename}\n\nThis adds its notebook data to the Google account currently open in Easylab.",
                )
            },
            confirmButton = {
                TextButton(onClick = { runImport(current.pending, LegacyImportPolicy.RequireEmptyWorkspace) }) {
                    Text("Import")
                }
            },
            dismissButton = { TextButton(onClick = { state = LegacyImportUiState.Idle }) { Text("Cancel") } },
        )
        is LegacyImportUiState.MergeConfirmation -> AlertDialog(
            onDismissRequest = { state = LegacyImportUiState.Idle },
            title = { Text("Notebook already contains data") },
            text = {
                Text(
                    "Easylab can recover only records marked unsynced in this backup. Existing entries with the same ID will not be replaced.",
                )
            },
            confirmButton = {
                TextButton(onClick = { runImport(current.pending, LegacyImportPolicy.MergeVerifiedUnsyncedOnly) }) {
                    Text("Recover unsynced changes")
                }
            },
            dismissButton = { TextButton(onClick = { state = LegacyImportUiState.Idle }) { Text("Cancel") } },
        )
        is LegacyImportUiState.Importing -> AlertDialog(
            onDismissRequest = {},
            title = { Text("Importing notebook") },
            text = { ProgressRow("Verifying and copying ${current.pending.filename}…") },
            confirmButton = {},
        )
        else -> Unit
    }
}

@Composable
private fun ProgressRow(label: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.padding(vertical = 4.dp),
    ) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(label)
    }
}

private suspend fun Context.readLegacyBackup(uri: Uri): PendingLegacyImport = withContext(Dispatchers.IO) {
    val resolver = contentResolver
    val filename = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }?.takeIf { it.isNotBlank() } ?: "Easylab backup"
    resolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
        require(descriptor.length < 0 || descriptor.length <= MAX_LEGACY_IMPORT_CHARS) {
            "This backup is larger than 128 MB. Restore the notebook from Google Drive instead."
        }
    }
    val rawJson = resolver.openInputStream(uri)?.bufferedReader(Charsets.UTF_8)?.use { reader ->
        val output = StringBuilder()
        val buffer = CharArray(8192)
        while (true) {
            val count = reader.read(buffer)
            if (count < 0) break
            require(output.length + count <= MAX_LEGACY_IMPORT_CHARS) {
                "This backup is larger than 128 MB. Restore the notebook from Google Drive instead."
            }
            output.append(buffer, 0, count)
        }
        output.toString()
    } ?: throw IOException("The selected backup could not be opened.")
    PendingLegacyImport(filename, rawJson)
}

private fun Throwable.productMessage(): String = when {
    message.orEmpty().contains("not an Easylab Lab Notebook backup") ->
        "This is not an Easylab backup. No data was changed."
    message.orEmpty().contains("larger than 128 MB") -> message.orEmpty()
    this is SecurityException -> "Easylab could not access the selected backup. Choose it again."
    else -> message?.takeIf { it.isNotBlank() } ?: "The backup could not be imported. No data was changed."
}

private fun LegacyImportResult.productSummary(): String {
    val entryLabel = if (entries == 1) "entry" else "entries"
    val fileLabel = if (attachments == 1) "file" else "files"
    return "Imported $entries $entryLabel and $attachments $fileLabel."
}
