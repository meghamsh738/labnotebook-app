package com.easylab.labnotebook.auth

import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.DriveAccessState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeAuthRepositoryTest {
    @Test
    fun restoreOpensExistingAccountOfflineWithoutInventingAToken() = runTest {
        val existing = session("subject-a", "researcher@example.com")
        val fixture = Fixture(storedSession = existing)

        fixture.repository.restore()

        assertEquals(existing, fixture.repository.session.value)
        assertEquals(DriveAccessState.SignInRequired, fixture.repository.driveAccess.value)
        assertNull(fixture.repository.accessToken(existing.accountId))
    }

    @Test
    fun connectUsesGoogleSubjectAsNamespaceAndKeepsTokenOnlyInMemory() = runTest {
        val fixture = Fixture()

        val result = fixture.repository.connect()

        assertTrue(result.isSuccess)
        assertEquals(AccountId("google-subject"), result.getOrThrow().accountId)
        assertEquals(result.getOrThrow(), fixture.store.saved)
        assertEquals("access-token", fixture.repository.accessToken(AccountId("google-subject")))
        assertTrue(fixture.repository.driveAccess.value is DriveAccessState.Granted)
        assertNull(fixture.store.persistedToken)
        assertEquals(listOf("Researcher@Example.com"), fixture.authorization.requestedEmails)
    }

    @Test
    fun connectFailsClosedWhenCredentialAndDriveAccountsDiffer() = runTest {
        val fixture = Fixture(
            credentialEmail = "first@example.com",
            profileEmail = "second@example.com",
        )

        val result = fixture.repository.connect()

        assertTrue(result.isFailure)
        assertNull(fixture.repository.session.value)
        assertNull(fixture.store.saved)
        assertNull(fixture.repository.accessToken(AccountId("google-subject")))
        assertTrue(fixture.repository.driveAccess.value is DriveAccessState.Error)
        assertEquals(listOf("access-token"), fixture.authorization.clearedTokens)
        assertEquals(listOf("researcher@example.com"), fixture.authorization.revokedEmails)
    }

    @Test
    fun mismatchWithoutAuthorizationAccountRevokesVerifiedTokenOwnerNotSelectedAccount() = runTest {
        val fixture = Fixture(
            credentialEmail = "selected@example.com",
            profileEmail = "token-owner@example.com",
            authorizationAccountEmail = null,
        )

        assertTrue(fixture.repository.connect().isFailure)

        assertEquals(listOf("token-owner@example.com"), fixture.authorization.revokedEmails)
        assertEquals(listOf("access-token"), fixture.authorization.clearedTokens)
    }

    @Test
    fun connectFailsClosedAndClearsTokenWhenDriveScopeIsMissing() = runTest {
        val fixture = Fixture(grantedScopes = setOf("openid", "email", "profile"))

        val result = fixture.repository.connect()

        assertTrue(result.isFailure)
        assertNull(fixture.repository.session.value)
        assertEquals(listOf("access-token"), fixture.authorization.clearedTokens)
        assertTrue(fixture.authorization.revokedEmails.isEmpty())
    }

    @Test
    fun disconnectClearsActiveSelectionAndTokenButRetainsAccountRecord() = runTest {
        val fixture = Fixture()
        val connected = fixture.repository.connect().getOrThrow()

        fixture.repository.disconnect()

        assertNull(fixture.repository.session.value)
        assertEquals(DriveAccessState.SignedOut, fixture.repository.driveAccess.value)
        assertNull(fixture.repository.accessToken(connected.accountId))
        assertTrue(fixture.store.activeCleared)
        assertEquals(connected, fixture.store.saved)
        assertEquals(listOf("researcher@example.com"), fixture.authorization.revokedEmails)
        assertEquals(listOf("access-token"), fixture.authorization.clearedTokens)
        assertTrue(fixture.identity.cleared)
    }

    @Test
    fun tokenExpiringInsideSafetyWindowFailsBeforeGrantingAccess() = runTest {
        val fixture = Fixture(expiresInSeconds = 20, now = 1_000_000L)
        val result = fixture.repository.connect()

        assertTrue(result.isFailure)
        assertNull(fixture.repository.session.value)
        assertNull(fixture.store.saved)
        assertTrue(fixture.repository.driveAccess.value is DriveAccessState.Error)
        assertEquals(listOf("access-token"), fixture.authorization.clearedTokens)
    }

    @Test
    fun missingExpiryUsesBoundedFallbackAndExactSkew() = runTest {
        val fixture = Fixture(expiresInSeconds = null, now = 1_000_000L)
        val connected = fixture.repository.connect().getOrThrow()

        fixture.clock = 1_000_000L + (45L * 60L - 31L) * 1_000L
        assertEquals("access-token", fixture.repository.accessToken(connected.accountId))

        fixture.clock += 1_000L
        assertNull(fixture.repository.accessToken(connected.accountId))
        assertEquals(DriveAccessState.SignInRequired, fixture.repository.driveAccess.value)
    }

    @Test
    fun excessiveExpiryIsCappedAndZeroOrNegativeExpiryFailsClosed() = runTest {
        val longLived = Fixture(expiresInSeconds = 24L * 60L * 60L, now = 1_000_000L)
        val connected = longLived.repository.connect().getOrThrow()
        longLived.clock = 1_000_000L + (50L * 60L - 30L) * 1_000L
        assertNull(longLived.repository.accessToken(connected.accountId))

        listOf(0L, -1L).forEach { lifetime ->
            val fixture = Fixture(expiresInSeconds = lifetime)
            assertTrue(fixture.repository.connect().isFailure)
            assertNull(fixture.repository.session.value)
            assertTrue(fixture.repository.driveAccess.value is DriveAccessState.Error)
        }
    }

    @Test
    fun cancellationAfterTokenIssuanceClearsTokenAndRethrows() = runTest {
        val started = CompletableDeferred<Unit>()
        val identity = FakeIdentity("researcher@example.com")
        val authorization = FakeAuthorization(
            expiresInSeconds = 3_600,
            grantedScopes = setOf("openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"),
        )
        val repository = NativeAuthRepository(
            identityGateway = identity,
            authorizationGateway = authorization,
            userInfoGateway = object : GoogleUserInfoGateway {
                override suspend fun fetch(accessToken: String): GoogleUserProfile {
                    started.complete(Unit)
                    awaitCancellation()
                }
            },
            accountStore = FakeStore(null),
        )
        val job = launch { repository.connect() }
        started.await()

        job.cancelAndJoin()

        assertEquals(listOf("access-token"), authorization.clearedTokens)
        assertNull(repository.session.value)
        assertEquals(DriveAccessState.SignedOut, repository.driveAccess.value)
    }

    @Test
    fun invalidatingTokenDoesNotDiscardOfflineSession() = runTest {
        val fixture = Fixture()
        val connected = fixture.repository.connect().getOrThrow()

        fixture.repository.invalidateAccessToken(connected.accountId)

        assertEquals(connected, fixture.repository.session.value)
        assertEquals(DriveAccessState.SignInRequired, fixture.repository.driveAccess.value)
        assertNull(fixture.repository.accessToken(connected.accountId))
    }

    private class Fixture(
        storedSession: AuthSession? = null,
        credentialEmail: String = "Researcher@Example.com",
        profileEmail: String = "researcher@example.com",
        grantedScopes: Set<String> = setOf("openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"),
        authorizationAccountEmail: String? = "researcher@example.com",
        expiresInSeconds: Long? = 3_600,
        now: Long = 1_000_000L,
    ) {
        var clock = now
        val identity = FakeIdentity(credentialEmail)
        val authorization = FakeAuthorization(expiresInSeconds, grantedScopes, authorizationAccountEmail)
        val store = FakeStore(storedSession)
        val repository = NativeAuthRepository(
            identityGateway = identity,
            authorizationGateway = authorization,
            userInfoGateway = FakeUserInfo(profileEmail),
            accountStore = store,
            nowEpochMillis = { clock },
        )
    }

    private class FakeIdentity(private val email: String) : CredentialIdentityGateway {
        var cleared = false
        override suspend fun selectGoogleAccount() = CredentialIdentity(email)
        override suspend fun clearCredentialState() { cleared = true }
    }

    private class FakeAuthorization(
        private val expiresInSeconds: Long?,
        private val grantedScopes: Set<String>,
        private val accountEmail: String? = "researcher@example.com",
    ) : DriveAuthorizationGateway {
        val revokedEmails = mutableListOf<String>()
        val clearedTokens = mutableListOf<String>()
        val requestedEmails = mutableListOf<String>()
        override suspend fun authorize(email: String): AuthorizedDriveAccess {
            requestedEmails += email
            return AuthorizedDriveAccess(
                accessToken = "access-token",
                grantedScopes = grantedScopes,
                accountEmail = accountEmail,
                expiresInSeconds = expiresInSeconds,
            )
        }
        override suspend fun revoke(email: String) { revokedEmails += email }
        override suspend fun clearToken(accessToken: String) { clearedTokens += accessToken }
    }

    private class FakeUserInfo(private val email: String) : GoogleUserInfoGateway {
        override suspend fun fetch(accessToken: String) = GoogleUserProfile(
            subject = "google-subject",
            email = email,
            emailVerified = true,
            displayName = "Researcher",
        )
    }

    private class FakeStore(initial: AuthSession?) : AuthAccountStore {
        var saved: AuthSession? = initial
        var activeCleared = false
        val persistedToken: String? = null
        override suspend fun active() = if (activeCleared) null else saved
        override suspend fun save(session: AuthSession) {
            saved = session
            activeCleared = false
        }
        override suspend fun clearActive() { activeCleared = true }
    }

    private fun session(subject: String, email: String) = AuthSession(AccountId(subject), email)
}
