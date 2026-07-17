package com.easylab.labnotebook

import com.easylab.labnotebook.data.repository.AuthRepository

/**
 * Process-only bridge between the activity-owned authorization flow and WorkManager.
 * The repository contains short-lived access tokens in memory; nothing here is persisted.
 */
object NativeProcessAuth {
    @Volatile
    private var repository: AuthRepository? = null

    fun register(authRepository: AuthRepository) {
        repository = authRepository
    }

    fun current(): AuthRepository? = repository

    internal fun clearForTest() {
        repository = null
    }
}
