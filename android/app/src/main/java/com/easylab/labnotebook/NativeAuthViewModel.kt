package com.easylab.labnotebook

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.easylab.labnotebook.auth.NativeAuthActivityHost
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.sync.SyncCoordinator
import com.easylab.labnotebook.sync.WorkManagerSyncCoordinator
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch

class NativeAuthViewModel internal constructor(
    application: Application,
    val activityHost: NativeAuthActivityHost,
    val authRepository: AuthRepository,
    val syncCoordinator: SyncCoordinator,
) : AndroidViewModel(application) {
    constructor(application: Application) : this(application, NativeAuthActivityHost())

    private constructor(application: Application, activityHost: NativeAuthActivityHost) : this(
        application = application,
        activityHost = activityHost,
        authRepository = NativeAuthFactory.create(application, activityHost),
        syncCoordinator = WorkManagerSyncCoordinator(application),
    )

    internal constructor(
        application: Application,
        authRepository: AuthRepository,
        syncCoordinator: SyncCoordinator,
    ) : this(application, NativeAuthActivityHost(), authRepository, syncCoordinator)

    private var connectJob: Job? = null
    private var disconnectJob: Job? = null

    init {
        NativeProcessAuth.register(authRepository)
        viewModelScope.launch { authRepository.restore() }
    }

    fun connect() {
        if (connectJob?.isActive == true) return
        connectJob = viewModelScope.launch {
            authRepository.connect().getOrNull()?.let { session ->
                syncCoordinator.requestSync(session.accountId, reason = REASON_INTERACTIVE_RECONNECT)
            }
        }
    }

    fun disconnect() {
        if (disconnectJob?.isActive == true) return
        disconnectJob = viewModelScope.launch {
            connectJob?.cancelAndJoin()
            authRepository.disconnect()
        }
    }

    override fun onCleared() {
        activityHost.close()
        super.onCleared()
    }

    private companion object {
        const val REASON_INTERACTIVE_RECONNECT = "interactive_reconnect"
    }
}
