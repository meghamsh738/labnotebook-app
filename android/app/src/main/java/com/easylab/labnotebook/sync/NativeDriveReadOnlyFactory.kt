package com.easylab.labnotebook.sync

import android.content.Context
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.DriveRepository

internal object NativeDriveReadOnlyFactory {
    @Volatile
    var testCreator: ((Context, AuthRepository) -> DriveRepository)? = null

    fun create(context: Context, authRepository: AuthRepository): DriveRepository =
        testCreator?.invoke(context, authRepository)
            ?: GoogleDriveReadOnlyRepository(context, authRepository)
}
