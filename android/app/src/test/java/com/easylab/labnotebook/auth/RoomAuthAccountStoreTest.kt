package com.easylab.labnotebook.auth

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.easylab.labnotebook.data.local.AccountId
import com.easylab.labnotebook.data.local.LabNotebookDatabase
import com.easylab.labnotebook.data.repository.AuthSession
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RoomAuthAccountStoreTest {
    private lateinit var context: Context
    private lateinit var database: LabNotebookDatabase

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("easylab-native-auth", Context.MODE_PRIVATE).edit().clear().commit()
        database = Room.inMemoryDatabaseBuilder(context, LabNotebookDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        database.close()
        context.getSharedPreferences("easylab-native-auth", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun savesAndRestoresOnlyProfileMetadataForActiveAccount() = runTest {
        val store = RoomAuthAccountStore(context, database.dao()) { "2026-07-16T10:00:00.000Z" }
        val session = AuthSession(
            accountId = AccountId("google-subject"),
            email = "researcher@example.com",
            displayName = "Researcher",
            pictureUrl = "https://example.com/avatar.png",
        )

        store.save(session)

        assertEquals(session, store.active())
        val entity = database.dao().account("google-subject")
        assertNotNull(entity)
        assertEquals("researcher@example.com", entity?.email)
        assertEquals("2026-07-16T10:00:00.000Z", entity?.connectedAt)
    }

    @Test
    fun clearingActiveSelectionRetainsAccountProfileAndNotebookNamespace() = runTest {
        val store = RoomAuthAccountStore(context, database.dao()) { "2026-07-16T10:00:00.000Z" }
        val session = AuthSession(AccountId("google-subject"), "researcher@example.com")
        store.save(session)

        store.clearActive()

        assertNull(store.active())
        assertNotNull(database.dao().account("google-subject"))
    }

    @Test
    fun switchingAccountsRetainsBothProfilesButRestoresOnlyTheLatestSelection() = runTest {
        val store = RoomAuthAccountStore(context, database.dao()) { "2026-07-16T10:00:00.000Z" }
        val first = AuthSession(AccountId("subject-a"), "first@example.com")
        val second = AuthSession(AccountId("subject-b"), "second@example.com")

        store.save(first)
        store.save(second)

        assertEquals(second, store.active())
        assertNotNull(database.dao().account("subject-a"))
        assertNotNull(database.dao().account("subject-b"))
    }

    @Test
    fun staleActiveSubjectFailsClosed() = runTest {
        context.getSharedPreferences("easylab-native-auth", Context.MODE_PRIVATE)
            .edit()
            .putString("active-google-subject", "missing-subject")
            .commit()
        val store = RoomAuthAccountStore(context, database.dao()) { "2026-07-16T10:00:00.000Z" }

        assertNull(store.active())
    }
}
