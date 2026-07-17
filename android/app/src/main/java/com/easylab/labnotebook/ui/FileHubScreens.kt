package com.easylab.labnotebook.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.TransferEntity
import com.easylab.labnotebook.data.repository.FileHubRepository
import java.util.Locale

internal enum class FileHubSection(val label: String) {
    Library("Library"),
    Incoming("Incoming"),
    Activity("Activity"),
}

@Composable
internal fun FileHubScreen(
    accountId: AccountId,
    repository: FileHubRepository,
) {
    val library by repository.observeLibrary(accountId).collectAsStateWithLifecycle(initialValue = emptyList())
    val incoming by repository.observeIncoming(accountId).collectAsStateWithLifecycle(initialValue = emptyList())
    val activity by repository.observeActivity(accountId).collectAsStateWithLifecycle(initialValue = emptyList())
    var selectedIndex by rememberSaveable { mutableIntStateOf(FileHubSection.Library.ordinal) }
    val selectedSection = FileHubSection.entries[selectedIndex]

    Page {
        item {
            SectionTitle(
                title = "Files",
                subtitle = "Evidence stored with this notebook.",
            )
        }
        item {
            PrimaryTabRow(
                selectedTabIndex = selectedIndex,
                modifier = Modifier.fillMaxWidth().testTag("file-hub-sections"),
                containerColor = MaterialTheme.colorScheme.background,
                divider = { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) },
            ) {
                FileHubSection.entries.forEach { section ->
                    val count = when (section) {
                        FileHubSection.Library -> library.size
                        FileHubSection.Incoming -> incoming.size
                        FileHubSection.Activity -> activity.size
                    }
                    Tab(
                        selected = selectedSection == section,
                        onClick = { selectedIndex = section.ordinal },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("file-${section.name.lowercase()}-tab"),
                        text = {
                            Text(
                                if (section == FileHubSection.Incoming && count > 0) {
                                    "${section.label} ($count)"
                                } else {
                                    section.label
                                },
                            )
                        },
                    )
                }
            }
        }

        when (selectedSection) {
            FileHubSection.Library -> libraryRows(library)
            FileHubSection.Incoming -> incomingRows(incoming)
            FileHubSection.Activity -> activityRows(activity)
        }
    }
}

private fun LazyListScope.libraryRows(records: List<AttachmentEntity>) {
    if (records.isEmpty()) {
        emptyFileState(
            title = "No files yet",
            body = "Evidence attached to entries will appear here.",
            testTag = "file-library-empty",
        )
        return
    }

    items(records, key = { it.id }) { attachment ->
        FileRecordRow(
            title = attachment.filename,
            metadata = listOf(
                attachment.type.uppercase(Locale.US),
                attachment.displaySize,
                displayDate(attachment.updatedAt.take(10)),
            ).filter { it.isNotBlank() }.joinToString(" · "),
            status = attachment.productAvailability(),
            testTag = "file-library-${attachment.id}",
        )
    }
}

private fun LazyListScope.incomingRows(records: List<FileBoxItemEntity>) {
    if (records.isEmpty()) {
        emptyFileState(
            title = "No incoming files",
            body = "Files from another device will appear here.",
            testTag = "file-incoming-empty",
        )
        return
    }

    items(records, key = { it.id }) { item ->
        FileRecordRow(
            title = item.filename,
            metadata = listOf(item.sourceDeviceName, item.filesize, displayDate(item.updatedAt.take(10)))
                .filter { it.isNotBlank() }
                .joinToString(" · "),
            status = item.productStatus(),
            testTag = "file-incoming-${item.id}",
        )
    }
}

private fun LazyListScope.activityRows(records: List<TransferEntity>) {
    if (records.isEmpty()) {
        emptyFileState(
            title = "No recent file activity",
            body = "File activity for this notebook will appear here.",
            testTag = "file-activity-empty",
        )
        return
    }

    items(records, key = { it.id }) { transfer ->
        val route = transfer.toDeviceName?.takeIf { it.isNotBlank() }?.let {
            "${transfer.fromDeviceName} to $it"
        } ?: transfer.fromDeviceName
        FileRecordRow(
            title = transfer.filename,
            metadata = "$route · ${displayDate(transfer.updatedAt.take(10))}",
            status = transfer.productStatus(),
            testTag = "file-activity-${transfer.id}",
        )
    }
}

private fun LazyListScope.emptyFileState(title: String, body: String, testTag: String) {
    item {
        Column(
            modifier = Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 12.dp).testTag(testTag),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun FileRecordRow(
    title: String,
    metadata: String,
    status: String,
    testTag: String,
) {
    Column(
        modifier = Modifier.fillMaxWidth().testTag(testTag),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            if (metadata.isNotBlank()) {
                Text(metadata, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                status,
                style = MaterialTheme.typography.labelLarge,
                color = if (status == "Sync problem") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

private fun AttachmentEntity.productAvailability(): String = when (syncStatus.lowercase(Locale.US)) {
    "failed", "conflict" -> "Sync problem"
    "queued", "syncing", "uploading" -> "Waiting to sync"
    else -> when {
        pinnedOffline || !localUri.isNullOrBlank() || !cachedPath.isNullOrBlank() -> "Available offline"
        !driveFileId.isNullOrBlank() || syncStatus.equals("remote-available", ignoreCase = true) ||
            syncStatus.equals("synced", ignoreCase = true) -> "Drive only"
        else -> "On this device"
    }
}

private fun FileBoxItemEntity.productStatus(): String = when (status.lowercase(Locale.US)) {
    "failed", "conflict" -> "Sync problem"
    "queued", "syncing", "uploading" -> "Waiting to sync"
    else -> "Needs attention"
}

private fun TransferEntity.productStatus(): String = when (status.lowercase(Locale.US)) {
    "failed", "conflict" -> "Sync problem"
    "queued", "syncing", "uploading" -> "In progress"
    "available", "attached", "complete", "completed" -> "Complete"
    else -> "Needs attention"
}
