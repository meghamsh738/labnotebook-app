package com.easylab.labnotebook.auth

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap

data class CredentialIdentity(val email: String)

data class AuthorizedDriveAccess(
    val accessToken: String,
    val grantedScopes: Set<String>,
    val accountEmail: String? = null,
    val expiresInSeconds: Long? = null,
)

data class GoogleUserProfile(
    val subject: String,
    val email: String,
    val emailVerified: Boolean,
    val displayName: String? = null,
    val pictureUrl: String? = null,
)

interface CredentialIdentityGateway {
    suspend fun selectGoogleAccount(): CredentialIdentity
    suspend fun clearCredentialState()
}

interface DriveAuthorizationGateway {
    suspend fun authorize(email: String): AuthorizedDriveAccess
    suspend fun revoke(email: String)
    suspend fun clearToken(accessToken: String)
}

interface GoogleUserInfoGateway {
    suspend fun fetch(accessToken: String): GoogleUserProfile
}

interface AuthAccountStore {
    suspend fun active(): AuthSession?
    suspend fun save(session: AuthSession)
    suspend fun clearActive()
}

private data class MemoryToken(
    val value: String,
    val expiresAtEpochMillis: Long?,
)

class NativeAuthRepository(
    private val identityGateway: CredentialIdentityGateway,
    private val authorizationGateway: DriveAuthorizationGateway,
    private val userInfoGateway: GoogleUserInfoGateway,
    private val accountStore: AuthAccountStore,
    private val nowEpochMillis: () -> Long = System::currentTimeMillis,
) : AuthRepository {
    private val mutex = Mutex()
    private val mutableSession = MutableStateFlow<AuthSession?>(null)
    private val mutableDriveAccess = MutableStateFlow<DriveAccessState>(DriveAccessState.Restoring)
    private val memoryTokens = ConcurrentHashMap<AccountId, MemoryToken>()

    override val session: StateFlow<AuthSession?> = mutableSession
    override val driveAccess: StateFlow<DriveAccessState> = mutableDriveAccess

    override suspend fun restore() = mutex.withLock {
        if (mutableDriveAccess.value != DriveAccessState.Restoring) return@withLock
        val restored = accountStore.active()
        mutableSession.value = restored
        mutableDriveAccess.value = if (restored == null) {
            DriveAccessState.SignedOut
        } else {
            DriveAccessState.SignInRequired
        }
    }

    override suspend fun connect(): Result<AuthSession> = mutex.withLock {
        mutableDriveAccess.value = DriveAccessState.Authorizing
        var credential: CredentialIdentity? = null
        var authorization: AuthorizedDriveAccess? = null
        var verifiedProfileEmail: String? = null
        try {
            credential = identityGateway.selectGoogleAccount()
            authorization = authorizationGateway.authorize(credential.email)
            require(REQUIRED_SCOPES.all(authorization.grantedScopes::contains)) {
                "Google Drive did not grant every permission Easylab needs."
            }
            val profile = userInfoGateway.fetch(authorization.accessToken)
            verifiedProfileEmail = profile.email

            require(profile.subject.isNotBlank()) { "Google account did not provide a stable account identifier." }
            require(profile.email.isNotBlank() && profile.emailVerified) {
                "Google account did not provide a verified email address."
            }
            if (!sameEmail(credential.email, profile.email)) throw AuthAccountMismatchException(
                "The selected Google account does not match the account authorized for Drive."
            )
            authorization.accountEmail?.let { authorizedEmail ->
                if (!sameEmail(authorizedEmail, profile.email)) throw AuthAccountMismatchException(
                    "The Drive authorization belongs to a different Google account."
                )
            }

            val accountId = AccountId(profile.subject)
            val authSession = AuthSession(
                accountId = accountId,
                email = profile.email,
                displayName = profile.displayName,
                pictureUrl = profile.pictureUrl,
            )
            val lifetimeSeconds = normalizeTokenLifetimeSeconds(authorization.expiresInSeconds)
            require(lifetimeSeconds > TOKEN_EXPIRY_SKEW_SECONDS) {
                "Google Drive authorization expired before Easylab could use it."
            }
            val expiresAt = nowEpochMillis() + lifetimeSeconds * 1_000L

            accountStore.save(authSession)
            memoryTokens.clear()
            memoryTokens[accountId] = MemoryToken(authorization.accessToken, expiresAt)
            mutableSession.value = authSession
            mutableDriveAccess.value = DriveAccessState.Granted(
                accountId = accountId,
                grantedScopes = authorization.grantedScopes,
                expiresAtEpochMillis = expiresAt,
            )
            Result.success(authSession)
        } catch (error: CancellationException) {
            withContext(NonCancellable) {
                authorization?.let { access -> runCatching { authorizationGateway.clearToken(access.accessToken) } }
            }
            mutableDriveAccess.value = if (mutableSession.value == null) {
                DriveAccessState.SignedOut
            } else {
                DriveAccessState.SignInRequired
            }
            throw error
        } catch (error: Throwable) {
            withContext(NonCancellable) {
                authorization?.let { access ->
                    runCatching { authorizationGateway.clearToken(access.accessToken) }
                    if (error is AuthAccountMismatchException) {
                        val email = access.accountEmail ?: verifiedProfileEmail
                        email?.let { runCatching { authorizationGateway.revoke(it) } }
                    }
                }
            }
            mutableDriveAccess.value = DriveAccessState.Error(error.authMessage())
            Result.failure(error)
        }
    }

    override suspend fun disconnect() {
        mutex.withLock {
            val activeSession = mutableSession.value
            val activeToken = activeSession?.let { memoryTokens[it.accountId]?.value }

            accountStore.clearActive()
            memoryTokens.clear()
            mutableSession.value = null
            mutableDriveAccess.value = DriveAccessState.SignedOut

            activeToken?.let { token -> runCatching { authorizationGateway.clearToken(token) } }
            activeSession?.let { current -> runCatching { authorizationGateway.revoke(current.email) } }
            runCatching { identityGateway.clearCredentialState() }
        }
    }

    override suspend fun invalidateAccessToken(accountId: AccountId) = mutex.withLock {
        val token = memoryTokens.remove(accountId)?.value
        token?.let { runCatching { authorizationGateway.clearToken(it) } }
        if (mutableSession.value?.accountId == accountId) {
            mutableDriveAccess.value = DriveAccessState.SignInRequired
        }
    }

    override fun accessToken(accountId: AccountId): String? {
        val token = memoryTokens[accountId] ?: return null
        val expiresAt = token.expiresAtEpochMillis
        if (expiresAt != null && expiresAt <= nowEpochMillis() + TOKEN_EXPIRY_SKEW_MILLIS) {
            memoryTokens.remove(accountId)
            if (mutableSession.value?.accountId == accountId) {
                mutableDriveAccess.value = DriveAccessState.SignInRequired
            }
            return null
        }
        return token.value
    }

    private fun sameEmail(left: String, right: String) = left.trim().equals(right.trim(), ignoreCase = true)

    private fun Throwable.authMessage(): String = when (this) {
        is AuthCancelledException -> "Google sign-in was cancelled."
        is IllegalArgumentException -> message ?: "The Google account could not be verified."
        else -> "Easylab could not connect to Google Drive. Try again."
    }

    private companion object {
        const val TOKEN_EXPIRY_SKEW_MILLIS = 30_000L
        const val TOKEN_EXPIRY_SKEW_SECONDS = TOKEN_EXPIRY_SKEW_MILLIS / 1_000L
        const val FALLBACK_TOKEN_LIFETIME_SECONDS = 45L * 60L
        const val MAX_TOKEN_LIFETIME_SECONDS = 50L * 60L
        val REQUIRED_SCOPES = setOf(
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/drive.file",
        )
    }

    private fun normalizeTokenLifetimeSeconds(value: Long?): Long = when {
        value == null -> FALLBACK_TOKEN_LIFETIME_SECONDS
        value <= 0L -> 0L
        else -> value.coerceAtMost(MAX_TOKEN_LIFETIME_SECONDS)
    }
}

class AuthCancelledException(message: String) : Exception(message)
class AuthAccountMismatchException(message: String) : IllegalArgumentException(message)
