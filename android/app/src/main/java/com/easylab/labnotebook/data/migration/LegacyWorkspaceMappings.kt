package com.easylab.labnotebook.data.migration

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.AttachmentEntity
import com.easylab.labnotebook.data.local.ConflictEntity
import com.easylab.labnotebook.data.local.DeviceEntity
import com.easylab.labnotebook.data.local.FileBoxItemEntity
import com.easylab.labnotebook.data.local.JournalEntryEntity
import com.easylab.labnotebook.data.local.TombstoneEntity
import com.easylab.labnotebook.data.local.TransferEntity
import com.easylab.labnotebook.sync.DriveV1Attachment
import com.easylab.labnotebook.sync.DriveV1Conflict
import com.easylab.labnotebook.sync.DriveV1Device
import com.easylab.labnotebook.sync.DriveV1Entry
import com.easylab.labnotebook.sync.DriveV1FileBoxItem
import com.easylab.labnotebook.sync.DriveV1Json
import com.easylab.labnotebook.sync.DriveV1Paths
import com.easylab.labnotebook.sync.DriveV1Tombstone
import com.easylab.labnotebook.sync.DriveV1Transfer
import kotlinx.serialization.encodeToString

internal fun DriveV1Entry.toLegacyEntity(
    accountId: AccountId,
    activeDeviceId: String,
): JournalEntryEntity = JournalEntryEntity(
    accountId = accountId.value,
    id = id,
    title = title,
    dateBucket = dateBucket,
    createdAt = createdDatetime,
    updatedAt = lastEditedDatetime,
    authorId = authorId,
    contentJson = DriveV1Json.format.encodeToString(content),
    tagsJson = DriveV1Json.format.encodeToString(tags),
    version = version ?: 1,
    updatedByDeviceId = updatedByDeviceId ?: activeDeviceId,
    syncStatus = normalizedLegacySyncStatus(syncStatus),
    experimentId = experimentId,
    projectId = projectId,
    isDaily = isDaily,
    projectTagsJson = DriveV1Json.format.encodeToString(projectTags.orEmpty()),
    experimentTagsJson = DriveV1Json.format.encodeToString(experimentTags.orEmpty()),
    searchTermsJson = DriveV1Json.format.encodeToString(searchTerms),
    linkedFilesJson = DriveV1Json.format.encodeToString(linkedFiles),
    pinnedRegionsJson = DriveV1Json.format.encodeToString(pinnedRegions),
    syncPath = syncPath?.takeUnless(::isLocalCacheHint),
    source = source,
    whatsappCapturesJson = DriveV1Json.format.encodeToString(whatsappCaptures.orEmpty()),
    telegramCapturesJson = DriveV1Json.format.encodeToString(telegramCaptures.orEmpty()),
)

internal fun DriveV1Attachment.toLegacyEntity(
    accountId: AccountId,
    entry: DriveV1Entry,
    exportedAt: String,
    storedBlob: StoredLegacyBlob?,
): AttachmentEntity {
    val hasVerifiedBlob = storedBlob != null
    val normalizedStatus = when {
        syncStatus in LOCAL_SYNC_STATUSES -> normalizedLegacySyncStatus(syncStatus)
        hasVerifiedBlob -> "synced"
        driveFileId != null -> "remote-available"
        else -> "local"
    }
    return AttachmentEntity(
        accountId = accountId.value,
        id = id,
        entryId = entryId,
        type = type,
        filename = filename,
        displaySize = filesize,
        byteSize = bytes,
        storagePath = storagePath.takeUnless(::isLocalCacheHint)
            ?: DriveV1Paths.attachmentBlob(this, entry),
        mimeType = mimeType ?: contentType,
        sha256 = sha256,
        localUri = null,
        driveFileId = driveFileId,
        pinnedOffline = hasVerifiedBlob || pinnedOffline == true,
        syncStatus = normalizedStatus,
        createdAt = createdAt ?: exportedAt,
        updatedAt = updatedAt ?: createdAt ?: exportedAt,
        thumbnail = thumbnail?.takeUnless(::isLocalCacheHint),
        linkedRegionId = linkedRegionId,
        tag = tag,
        sampleId = sampleId,
        cachedPath = storedBlob?.path,
        source = source,
        sourceMessageId = sourceMessageId,
        sourceMediaId = sourceMediaId,
        contentType = contentType,
        cacheKey = storedBlob?.id,
    )
}

internal fun DriveV1Device.toLegacyEntity(accountId: AccountId) = DeviceEntity(
    accountId = accountId.value,
    id = id,
    name = name,
    platform = platform,
    createdAt = createdAt,
    lastSeenAt = lastSeenAt,
    userAgent = userAgent,
    appVersion = appVersion,
)

internal fun DriveV1FileBoxItem.toLegacyEntity(accountId: AccountId) = FileBoxItemEntity(
    accountId = accountId.value,
    id = id,
    entryId = entryId,
    attachmentId = attachmentId,
    filename = filename,
    filesize = filesize,
    contentType = contentType,
    sourceDeviceId = sourceDeviceId,
    sourceDeviceName = sourceDeviceName,
    status = status,
    createdAt = createdAt,
    updatedAt = updatedAt,
    driveFileId = driveFileId,
    localObjectUrl = null,
    lastError = lastError,
)

internal fun DriveV1Transfer.toLegacyEntity(accountId: AccountId) = TransferEntity(
    accountId = accountId.value,
    id = id,
    fileBoxItemId = fileBoxItemId,
    entryId = entryId,
    attachmentId = attachmentId,
    filename = filename,
    fromDeviceId = fromDeviceId,
    fromDeviceName = fromDeviceName,
    toDeviceId = toDeviceId,
    toDeviceName = toDeviceName,
    provider = provider,
    status = status,
    bytesTotal = bytesTotal,
    bytesTransferred = bytesTransferred,
    createdAt = createdAt,
    updatedAt = updatedAt,
    completedAt = completedAt,
    driveFileId = driveFileId,
    lastError = lastError,
)

internal fun DriveV1Conflict.toLegacyEntity(accountId: AccountId) = ConflictEntity(
    accountId = accountId.value,
    id = id,
    entityKind = entityKind,
    entityId = entityId,
    localUpdatedAt = localUpdatedAt,
    remoteUpdatedAt = remoteUpdatedAt,
    detectedAt = detectedAt,
    resolution = resolution,
    summary = summary,
    localCopyJson = localCopy?.toString(),
    remoteCopyJson = remoteCopy?.toString(),
)

internal fun DriveV1Tombstone.toLegacyEntity(accountId: AccountId) = TombstoneEntity(
    accountId = accountId.value,
    id = id,
    entityKind = entityKind,
    entityId = entityId,
    deletedAt = deletedAt,
    deletedByDeviceId = deletedByDeviceId,
    reason = reason,
)

internal fun isVerifiedUnsynced(status: String?): Boolean = status in LOCAL_SYNC_STATUSES

internal fun normalizedLegacySyncStatus(status: String?): String = when (status) {
    null -> "local"
    "syncing" -> "queued"
    else -> status
}

private fun isLocalCacheHint(value: String): Boolean {
    val trimmed = value.trim()
    return trimmed.startsWith("blob:", ignoreCase = true) ||
        trimmed.startsWith("data:", ignoreCase = true) ||
        trimmed.startsWith("file:", ignoreCase = true) ||
        trimmed.startsWith("fs://", ignoreCase = true) ||
        trimmed.startsWith("content:", ignoreCase = true) ||
        trimmed.startsWith("/") ||
        trimmed.startsWith("~/") ||
        WINDOWS_PATH.matches(trimmed)
}

private val WINDOWS_PATH = Regex("^[A-Za-z]:[\\\\/].*")
private val LOCAL_SYNC_STATUSES = setOf("local", "queued", "syncing", "failed", "conflict")
