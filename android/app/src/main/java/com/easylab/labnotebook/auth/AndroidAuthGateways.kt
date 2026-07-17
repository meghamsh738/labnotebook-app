package com.easylab.labnotebook.auth

import android.accounts.Account
import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.identity.RevokeAccessRequest
import com.google.android.gms.common.api.Scope
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class NativeAuthActivityHost {
    @Volatile private var activity: ComponentActivity? = null
    @Volatile private var launchRequest: ((IntentSenderRequest) -> Unit)? = null
    private var pending: CancellableContinuation<Intent>? = null

    fun attach(activity: ComponentActivity, launchRequest: (IntentSenderRequest) -> Unit) {
        this.activity = activity
        this.launchRequest = launchRequest
    }

    fun detach(activity: ComponentActivity) {
        if (this.activity === activity) {
            this.activity = null
            this.launchRequest = null
        }
    }

    fun currentActivity(): ComponentActivity = checkNotNull(activity) {
        "Google sign-in requires an active Easylab screen."
    }

    suspend fun resolve(pendingIntent: PendingIntent): Intent = suspendCancellableCoroutine { continuation ->
        check(pending == null) { "A Google authorization request is already open." }
        val activeLauncher = checkNotNull(launchRequest) { "Google authorization launcher is not attached." }
        pending = continuation
        continuation.invokeOnCancellation {
            if (pending === continuation) pending = null
        }
        activeLauncher(IntentSenderRequest.Builder(pendingIntent).build())
    }

    fun onResult(resultCode: Int, data: Intent?) {
        val continuation = pending ?: return
        pending = null
        if (!continuation.isActive) return
        if (resultCode == Activity.RESULT_OK && data != null) {
            continuation.resume(data)
        } else {
            continuation.resumeWithException(AuthCancelledException("Google Drive authorization was cancelled."))
        }
    }

    fun close() {
        val continuation = pending
        pending = null
        if (continuation?.isActive == true) {
            continuation.cancel(AuthCancelledException("Google authorization activity closed."))
        }
        activity = null
        launchRequest = null
    }
}

class AndroidCredentialIdentityGateway(
    context: Context,
    private val activityHost: NativeAuthActivityHost,
    serverClientId: String,
) : CredentialIdentityGateway {
    private val credentialManager = CredentialManager.create(context.applicationContext)
    private val signInOption = GetSignInWithGoogleOption.Builder(serverClientId).build()

    override suspend fun selectGoogleAccount(): CredentialIdentity {
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(signInOption)
            .build()
        val credential = try {
            credentialManager.getCredential(activityHost.currentActivity(), request).credential
        } catch (error: GetCredentialCancellationException) {
            throw AuthCancelledException("Google sign-in was cancelled.")
        } catch (error: NoCredentialException) {
            throw IllegalArgumentException("No Google account is available on this device.", error)
        }
        require(
            credential is CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL,
        ) { "Google sign-in returned an unsupported credential." }
        val googleCredential = GoogleIdTokenCredential.createFrom(credential.data)
        return CredentialIdentity(email = googleCredential.id.trim())
    }

    override suspend fun clearCredentialState() {
        credentialManager.clearCredentialState(ClearCredentialStateRequest())
    }
}

class AndroidDriveAuthorizationGateway(
    context: Context,
    private val resolutionHost: NativeAuthActivityHost,
) : DriveAuthorizationGateway {
    private val client = Identity.getAuthorizationClient(context.applicationContext)
    private val scopes = REQUESTED_SCOPES.map(::Scope)

    override suspend fun authorize(email: String): AuthorizedDriveAccess {
        val request = buildDriveAuthorizationRequest(email, scopes)
        var result = client.authorize(request).await()
        if (result.hasResolution()) {
            val pendingIntent = result.pendingIntent
                ?: error("Google Drive authorization needs consent, but no consent request was provided.")
            val data = resolutionHost.resolve(pendingIntent)
            result = client.getAuthorizationResultFromIntent(data)
        }
        return result.toDriveAccess()
    }

    override suspend fun revoke(email: String) {
        val request = RevokeAccessRequest.builder()
            .setAccount(Account(email, GOOGLE_ACCOUNT_TYPE))
            .setScopes(scopes)
            .build()
        client.revokeAccess(request).await()
    }

    override suspend fun clearToken(accessToken: String) {
        val request = ClearTokenRequest.builder().setToken(accessToken).build()
        client.clearToken(request).await()
    }

    private fun AuthorizationResult.toDriveAccess(): AuthorizedDriveAccess {
        val token = accessToken?.takeIf(String::isNotBlank)
            ?: error("Google Drive authorization completed without an access token.")
        val expiresIn = tokenResponseParams?.get("expires_in").asLongOrNull()
        return AuthorizedDriveAccess(
            accessToken = token,
            grantedScopes = grantedScopes.toSet(),
            accountEmail = toGoogleSignInAccount()?.email,
            expiresInSeconds = expiresIn,
        )
    }

    private fun Any?.asLongOrNull(): Long? = when (this) {
        is Number -> toLong()
        is String -> toLongOrNull()
        else -> null
    }

    private companion object {
        val REQUESTED_SCOPES = listOf(
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/drive.file",
        )
    }
}

internal fun buildDriveAuthorizationRequest(email: String, scopes: List<Scope>): AuthorizationRequest {
    require(email.isNotBlank()) { "Google account email must not be blank." }
    require(scopes.isNotEmpty()) { "Google Drive authorization requires at least one scope." }
    return AuthorizationRequest.builder()
        .setAccount(Account(email.trim(), GOOGLE_ACCOUNT_TYPE))
        .setRequestedScopes(scopes)
        .build()
}

private const val GOOGLE_ACCOUNT_TYPE = "com.google"
