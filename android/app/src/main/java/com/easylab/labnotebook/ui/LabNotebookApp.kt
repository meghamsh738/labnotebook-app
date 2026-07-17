package com.easylab.labnotebook.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.AddCircle
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.easylab.labnotebook.data.repository.AuthRepository
import com.easylab.labnotebook.data.repository.AuthSession
import com.easylab.labnotebook.data.repository.AttachmentRepository
import com.easylab.labnotebook.data.repository.DriveAccessState
import com.easylab.labnotebook.data.repository.EntryMutationRepository
import com.easylab.labnotebook.data.repository.InMemoryAttachmentRepository
import com.easylab.labnotebook.data.repository.FileHubRepository
import com.easylab.labnotebook.data.repository.InMemoryFileHubRepository
import com.easylab.labnotebook.data.repository.InMemoryJournalRepository
import com.easylab.labnotebook.data.repository.InMemoryProtocolRepository
import com.easylab.labnotebook.data.repository.ProtocolRepository
import com.easylab.labnotebook.data.repository.JournalRepository
import com.easylab.labnotebook.data.repository.PlaceholderAuthRepository
import com.easylab.labnotebook.IncomingShareRequest
import com.easylab.labnotebook.data.migration.LegacyWorkspaceImportRepository
import com.easylab.labnotebook.data.capture.CaptureRepository
import com.easylab.labnotebook.sync.PlaceholderSyncCoordinator
import com.easylab.labnotebook.sync.SyncCoordinator

private val Ink = Color(0xFF17231C)
private val Forest = Color(0xFF315F49)
private val Paper = Color(0xFFF7F7F1)
private val Sage = Color(0xFFDDE9DF)

private enum class Destination(val label: String, val icon: ImageVector, val primary: Boolean = false) {
    Today("Today", Icons.Outlined.Home, true),
    Entries("Entries", Icons.Outlined.CalendarMonth, true),
    Capture("Capture", Icons.Outlined.AddCircle, true),
    Files("Files", Icons.Outlined.Folder, true),
    Sync("Sync", Icons.Outlined.Sync, true),
    Settings("Settings", Icons.Outlined.MoreVert),
    Protocols("Protocols", Icons.Outlined.CalendarMonth),
    Auth("Account", Icons.Outlined.AccountCircle),
    Entry("Entry", Icons.Outlined.CalendarMonth),
}

@Composable
fun LabNotebookApp(
    authRepository: AuthRepository = PlaceholderAuthRepository(),
    journalRepository: JournalRepository = InMemoryJournalRepository(),
    entryMutationRepository: EntryMutationRepository? = null,
    deviceId: String? = null,
    attachmentRepository: AttachmentRepository = InMemoryAttachmentRepository(),
    fileHubRepository: FileHubRepository = InMemoryFileHubRepository(),
    protocolRepository: ProtocolRepository = InMemoryProtocolRepository(),
    captureRepository: CaptureRepository? = null,
    pendingShare: IncomingShareRequest? = null,
    onShareConsumed: (String) -> Unit = {},
    legacyImportRepository: LegacyWorkspaceImportRepository? = null,
    syncCoordinator: SyncCoordinator = PlaceholderSyncCoordinator,
    onConnect: () -> Unit = {},
    onDisconnect: () -> Unit = {},
) {
    val session by authRepository.session.collectAsStateWithLifecycle()
    val driveAccess by authRepository.driveAccess.collectAsStateWithLifecycle()

    if (session == null) {
        MaterialTheme(colorScheme = easylabColorScheme()) {
            when (driveAccess) {
                DriveAccessState.Restoring -> RestoringAccountScreen()
                else -> GoogleAccountGate(
                    driveAccess = driveAccess,
                    onConnect = onConnect,
                )
            }
        }
        return
    }

    var destination by remember { mutableStateOf(Destination.Today) }
    var returnDestination by remember { mutableStateOf(Destination.Entries) }
    var selectedEntryId by remember { mutableStateOf<String?>(null) }
    var quickNoteRequest by remember { mutableIntStateOf(0) }
    val signedInSession = checkNotNull(session)
    val entries by journalRepository.observeEntries(signedInSession.accountId)
        .collectAsStateWithLifecycle(initialValue = emptyList())

    LaunchedEffect(signedInSession.accountId) {
        destination = Destination.Today
        selectedEntryId = null
    }
    LaunchedEffect(pendingShare?.id) {
        if (pendingShare != null) destination = Destination.Capture
    }

    fun openEntry(entryId: String, from: Destination) {
        selectedEntryId = entryId
        returnDestination = from
        destination = Destination.Entry
    }

    MaterialTheme(colorScheme = easylabColorScheme()) {
        NavigationSuiteScaffold(
            navigationSuiteItems = {
                Destination.entries.filter { it.primary }.forEach { item ->
                    item(
                        selected = destination == item ||
                            (destination == Destination.Entry && returnDestination == item),
                        onClick = { destination = item },
                        icon = {
                            Icon(
                                item.icon,
                                contentDescription = item.label,
                            )
                        },
                        label = { Text(item.label) },
                    )
                }
            },
        ) {
            Scaffold(
                topBar = {
                    AppTopBar(
                        destination = destination,
                        session = signedInSession,
                        onAccount = { destination = Destination.Auth },
                        onSettings = { destination = Destination.Settings },
                        onProtocols = { destination = Destination.Protocols },
                    )
                },
                containerColor = Paper,
            ) { padding ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    when (destination) {
                        Destination.Today -> TodayScreen(
                            accountId = signedInSession.accountId,
                            journalRepository = journalRepository,
                            attachmentRepository = attachmentRepository,
                            entryMutationRepository = entryMutationRepository,
                            deviceId = deviceId,
                            startWritingRequest = quickNoteRequest,
                            onWritingStarted = { quickNoteRequest = 0 },
                            onBrowseEntries = { destination = Destination.Entries },
                            onCheckForUpdates = { syncCoordinator.requestSync(signedInSession.accountId) },
                        )
                        Destination.Entries -> EntriesScreen(
                            accountId = signedInSession.accountId,
                            journalRepository = journalRepository,
                            onOpenEntry = { openEntry(it, Destination.Entries) },
                        )
                        Destination.Capture -> CaptureScreen(
                            accountId = signedInSession.accountId,
                            activeDeviceId = deviceId,
                            repository = captureRepository,
                            pendingShare = pendingShare,
                            onShareConsumed = onShareConsumed,
                            onQuickNote = {
                                quickNoteRequest += 1
                                destination = Destination.Today
                            },
                            onViewToday = { destination = Destination.Today },
                        )
                        Destination.Files -> FileHubScreen(
                            accountId = signedInSession.accountId,
                            repository = fileHubRepository,
                        )
                        Destination.Sync -> SyncScreen(
                            session = signedInSession,
                            driveAccess = driveAccess,
                            syncCoordinator = syncCoordinator,
                            onReconnect = onConnect,
                        )
                        Destination.Protocols -> ProtocolsScreen(
                            accountId = signedInSession.accountId,
                            repository = protocolRepository,
                        )
                        Destination.Auth -> AuthScreen(
                            session = signedInSession,
                            driveAccess = driveAccess,
                            onReconnect = onConnect,
                            onDisconnect = onDisconnect,
                        )
                        Destination.Settings -> SettingsScreen(
                            accountId = signedInSession.accountId,
                            deviceId = deviceId,
                            legacyImportRepository = legacyImportRepository,
                            onNavigate = { destination = it },
                        )
                        Destination.Entry -> EntryDetailScreen(
                            accountId = signedInSession.accountId,
                            entry = entries.firstOrNull { it.id == selectedEntryId },
                            attachmentRepository = attachmentRepository,
                            entryMutationRepository = entryMutationRepository,
                            deviceId = deviceId,
                            onBack = {
                                selectedEntryId = null
                                destination = returnDestination
                            },
                        )
                    }
                }
            }
        }
    }
}

private fun easylabColorScheme() = androidx.compose.material3.lightColorScheme(
    primary = Forest,
    onPrimary = Color.White,
    primaryContainer = Sage,
    onPrimaryContainer = Ink,
    background = Paper,
    surface = Paper,
    surfaceVariant = Color(0xFFE9ECE5),
    onSurface = Ink,
    outline = Color(0xFFBBC5BC),
)

@Composable
private fun RestoringAccountScreen() {
    Surface(color = Paper, modifier = Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                CircularProgressIndicator(strokeWidth = 2.dp)
                Text("Opening Easylab", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun GoogleAccountGate(driveAccess: DriveAccessState, onConnect: () -> Unit) {
    Surface(color = Paper, modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Easylab", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
                    Text(
                        "Connect Google Drive to check supported notebook metadata.",
                        style = MaterialTheme.typography.titleMedium,
                        color = Color(0xFF58645C),
                    )
                }
                HorizontalDivider(color = Color(0xFFD6DED9))
                AssuranceRow("This app currently reads supported metadata")
                AssuranceRow("Changes are not uploaded from this app")
                AssuranceRow("Each Google account is handled separately")
                Button(
                    onClick = onConnect,
                    enabled = driveAccess !is DriveAccessState.Authorizing,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    if (driveAccess is DriveAccessState.Authorizing) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                        Spacer(Modifier.width(10.dp))
                        Text("Connecting…")
                    } else {
                        Text("Continue with Google")
                    }
                }
                if (driveAccess is DriveAccessState.Error) {
                    Text(driveAccess.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@Composable
private fun AssuranceRow(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Surface(shape = CircleShape, color = Sage) {
            Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                Text("✓", color = Forest, fontWeight = FontWeight.Bold)
            }
        }
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

private fun DriveAccessState.isGrantedFor(accountId: com.easylab.labnotebook.data.local.AccountId): Boolean =
    this is DriveAccessState.Granted && this.accountId == accountId

private fun DriveAccessState.productLabel(accountId: com.easylab.labnotebook.data.local.AccountId): String = when (this) {
    DriveAccessState.Restoring -> "Checking this device…"
    DriveAccessState.SignedOut -> "Not connected"
    DriveAccessState.SignInRequired -> "Drive sign-in required"
    DriveAccessState.Authorizing -> "Connecting to Drive…"
    is DriveAccessState.Granted -> if (this.accountId == accountId) "Google Drive ready" else "Drive sign-in required"
    is DriveAccessState.Error -> message
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppTopBar(
    destination: Destination,
    session: AuthSession,
    onAccount: () -> Unit,
    onSettings: () -> Unit,
    onProtocols: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    TopAppBar(
        title = {
            Column {
                Text(destination.label, fontWeight = FontWeight.SemiBold)
                Text(
                    session.displayName ?: session.email,
                    style = MaterialTheme.typography.labelMedium,
                    color = Forest,
                )
            }
        },
        actions = {
            IconButton(onClick = onAccount) {
                Icon(Icons.Outlined.AccountCircle, contentDescription = "Account")
            }
            Box {
                IconButton(onClick = { menuExpanded = true }) {
                    Icon(Icons.Outlined.MoreVert, contentDescription = "More")
                }
                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("Protocols") },
                        onClick = {
                            menuExpanded = false
                            onProtocols()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Settings") },
                        onClick = {
                            menuExpanded = false
                            onSettings()
                        },
                    )
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
    )
}

@Composable
internal fun Page(content: LazyListScope.() -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        content = content,
    )
}

@Composable
internal fun SectionTitle(title: String, subtitle: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Color(0xFF58645C)) }
    }
}

@Composable
private fun SyncScreen(
    session: AuthSession,
    driveAccess: DriveAccessState,
    syncCoordinator: SyncCoordinator,
    onReconnect: () -> Unit,
) {
    val status by syncCoordinator.observeStatus(session.accountId).collectAsStateWithLifecycle(initialValue = com.easylab.labnotebook.sync.SyncStatus())
    Page {
        item { SectionTitle("Sync", "Check Google Drive for supported notebook metadata.") }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(status.message, fontWeight = FontWeight.SemiBold)
                Text(
                    "This app does not upload notebook changes.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF667068),
                )
            }
        }
        item {
            CompactRows(
                "This device",
                listOf(
                    "Last metadata check" to (status.lastSyncedAt ?: status.lastAttemptAt ?: "Not yet"),
                    "Drive access" to "Read only",
                ),
            )
        }
        if (status.signInRequired || !driveAccess.isGrantedFor(session.accountId)) {
            item { Button(onClick = onReconnect) { Text("Reconnect Google Drive") } }
        } else {
            item { Button(onClick = { syncCoordinator.requestSync(session.accountId) }) { Text("Check for updates") } }
        }
    }
}

@Composable
private fun AuthScreen(
    session: AuthSession,
    driveAccess: DriveAccessState,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
) = Page {
    item { SectionTitle("Account", "Google account used for Drive access on this device.") }
    item {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(session.displayName ?: "Google account", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(session.email, color = Color(0xFF58645C))
            Text(driveAccess.productLabel(session.accountId), style = MaterialTheme.typography.bodySmall, color = Forest)
        }
    }
    if (!driveAccess.isGrantedFor(session.accountId) && driveAccess !is DriveAccessState.Authorizing) {
        item { Button(onClick = onReconnect) { Text("Reconnect Google Drive") } }
    }
    if (driveAccess is DriveAccessState.Authorizing) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Text("Connecting to Google Drive…")
            }
        }
    }
    item { OutlinedButton(onClick = onDisconnect) { Text("Sign out on this device") } }
    item {
        Text(
            "Signing out disconnects this Google account on this device. Access tokens are not stored by the app.",
            style = MaterialTheme.typography.bodySmall,
            color = Color(0xFF667068),
        )
    }
}

@Composable
private fun SettingsScreen(
    accountId: com.easylab.labnotebook.data.local.AccountId,
    deviceId: String?,
    legacyImportRepository: LegacyWorkspaceImportRepository?,
    onNavigate: (Destination) -> Unit,
) = Page {
    item { SectionTitle("Settings", "Account and sync settings.") }
    items(listOf(
        Triple("Account", "Manage the Google account connected on this device.", Destination.Auth),
        Triple("Sync", "Review Google Drive metadata checks.", Destination.Sync),
    )) { (title, body, target) ->
        Surface(
            modifier = Modifier.fillMaxWidth().clickable { onNavigate(target) },
            color = Color.Transparent,
        ) {
            Row(Modifier.padding(vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, fontWeight = FontWeight.SemiBold)
                    Text(body, style = MaterialTheme.typography.bodySmall, color = Color(0xFF667068))
                }
                Text("›", style = MaterialTheme.typography.headlineSmall, color = Forest)
            }
        }
    }
    item { HorizontalDivider() }
    item {
        CompactRows(
            "Current capabilities",
            listOf(
                "Google Drive metadata" to "Read only",
                "Notebook changes" to "Not available",
            ),
        )
    }
    item {
        LegacyImportSettings(
            accountId = accountId,
            activeDeviceId = deviceId,
            repository = legacyImportRepository,
        )
    }
}

@Composable
private fun CompactRows(title: String, rows: List<Pair<String, String>>) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 6.dp))
        rows.forEachIndexed { index, (label, value) ->
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(label, modifier = Modifier.weight(1f))
                Text(value, style = MaterialTheme.typography.bodySmall, color = Color(0xFF667068))
            }
            if (index != rows.lastIndex) HorizontalDivider(color = Color(0xFFE0E5DF))
        }
    }
}
