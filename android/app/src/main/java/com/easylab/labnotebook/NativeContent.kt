package com.easylab.labnotebook

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.easylab.labnotebook.data.capture.FileCaptureBlobStore
import com.easylab.labnotebook.data.capture.RoomCaptureRepository
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.local.InstallDeviceIdentity
import com.easylab.labnotebook.data.migration.FileLegacyBlobStore
import com.easylab.labnotebook.data.migration.RoomLegacyWorkspaceImportRepository
import com.easylab.labnotebook.data.repository.RoomAttachmentRepository
import com.easylab.labnotebook.data.repository.RoomFileHubRepository
import com.easylab.labnotebook.data.repository.RoomJournalRepository
import com.easylab.labnotebook.data.repository.RoomEntryMutationRepository
import com.easylab.labnotebook.ui.LabNotebookApp

object NativeContent {
    @JvmStatic
    fun install(
        activity: ComponentActivity,
        authViewModel: NativeAuthViewModel,
        shareViewModel: NativeShareViewModel,
    ) {
        val database = LabNotebookDatabase.get(activity.applicationContext)
        val dao = database.dao()
        val deviceId = InstallDeviceIdentity(activity.applicationContext).id
        val legacyImportRepository = RoomLegacyWorkspaceImportRepository(
            database = database,
            blobStore = FileLegacyBlobStore(activity.applicationContext),
        )
        val captureRepository = RoomCaptureRepository(
            database = database,
            blobStore = FileCaptureBlobStore(activity.applicationContext),
        )
        activity.setContent {
            val pendingShare = shareViewModel.pendingShare.collectAsStateWithLifecycle().value
            LabNotebookApp(
                authRepository = authViewModel.authRepository,
                journalRepository = RoomJournalRepository(dao),
                entryMutationRepository = RoomEntryMutationRepository(dao),
                deviceId = deviceId,
                attachmentRepository = RoomAttachmentRepository(dao),
                fileHubRepository = RoomFileHubRepository(dao),
                captureRepository = captureRepository,
                pendingShare = pendingShare,
                onShareConsumed = shareViewModel::consume,
                legacyImportRepository = legacyImportRepository,
                syncCoordinator = authViewModel.syncCoordinator,
                onConnect = authViewModel::connect,
                onDisconnect = authViewModel::disconnect,
            )
        }
    }
}
