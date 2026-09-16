package app.mixbase.android.ui.projects

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.appContainer
import app.mixbase.android.playback.QueueItem
import app.mixbase.android.ui.components.ArtworkImage
import app.mixbase.android.ui.components.EmptyState
import app.mixbase.android.ui.components.ErrorText
import app.mixbase.android.ui.components.LoadErrorCard
import app.mixbase.android.ui.components.LoadingBox
import app.mixbase.android.ui.components.MbTextField
import app.mixbase.android.ui.components.MbTopBar
import app.mixbase.android.ui.components.MutedText
import app.mixbase.android.ui.components.PrimaryButton
import app.mixbase.android.ui.components.RoundIconButton
import app.mixbase.android.ui.components.StatusBadge
import app.mixbase.android.ui.theme.MbColors
import app.mixbase.android.ui.util.describeFile
import app.mixbase.android.ui.util.probeDurationSeconds
import app.mixbase.android.ui.util.uploadBody
import app.mixbase.core.StorageKeys
import app.mixbase.core.displayMessage
import app.mixbase.core.model.Collection
import app.mixbase.core.model.CollectionItem
import app.mixbase.core.model.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Tracks grid + Collections list, with the New Project flow. Mirrors ios/…/ProjectsView.swift. */
@Composable
fun ProjectsScreen(onOpenProject: (String) -> Unit, onOpenPlayer: () -> Unit) {
    val container = LocalContext.current.appContainer
    val library by container.library.state.collectAsState()
    val playerState by container.player.state.collectAsState()
    val scope = rememberCoroutineScope()

    var segment by remember { mutableIntStateOf(0) }
    var showNewProject by remember { mutableStateOf(false) }
    var collections by remember { mutableStateOf<List<Collection>>(emptyList()) }
    var collectionItems by remember { mutableStateOf<List<CollectionItem>>(emptyList()) }
    var collectionsError by remember { mutableStateOf<String?>(null) }

    suspend fun loadCollections() {
        try {
            collections = container.supabase.fetchCollections()
            collectionItems = container.supabase.fetchAllCollectionItems()
            collectionsError = null
        } catch (e: Exception) {
            collectionsError = e.displayMessage
        }
    }

    LaunchedEffect(Unit) {
        launch { container.library.refreshIfStale() }
        loadCollections()
    }

    val latest = remember(library.versionsByProject) { library.latestVersions }

    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar("Projects") {
            IconButton(onClick = { scope.launch { container.library.refresh(); loadCollections() } }) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = MbColors.TextMuted)
            }
            IconButton(onClick = { showNewProject = true }) {
                Icon(Icons.Default.Add, contentDescription = "New project", tint = MbColors.Teal)
            }
        }

        TabRow(
            selectedTabIndex = segment,
            containerColor = MbColors.Background,
            contentColor = MbColors.Teal,
            indicator = { positions ->
                TabRowDefaults.SecondaryIndicator(Modifier.tabIndicatorOffset(positions[segment]), color = MbColors.Teal)
            },
            divider = {},
        ) {
            Tab(selected = segment == 0, onClick = { segment = 0 }, text = { Text("Tracks", color = if (segment == 0) MbColors.Teal else MbColors.TextMuted) })
            Tab(selected = segment == 1, onClick = { segment = 1 }, text = { Text("Collections", color = if (segment == 1) MbColors.Teal else MbColors.TextMuted) })
        }

        when {
            library.isLoading && !library.hasLoaded -> LoadingBox()
            segment == 0 -> {
                if (library.error != null && library.projects.isEmpty()) {
                    LoadErrorCard("Couldn't load your projects", onRetry = { scope.launch { container.library.refresh() } }, modifier = Modifier.padding(16.dp))
                } else if (library.projects.isEmpty()) {
                    EmptyState("No projects yet", "Tap + to create your first track")
                } else {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(library.projects, key = { it.id }) { project ->
                            val version = latest[project.id]
                            val isCurrent = playerState.current?.projectId == project.id && playerState.current?.isOwn == true
                            Column(Modifier.clickable { onOpenProject(project.id) }) {
                                Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
                                    ArtworkImage(project.artworkUrl, modifier = Modifier.fillMaxSize(), shape = RoundedCornerShape(12.dp), placeholderIconSize = 40.dp)
                                    if (version != null) {
                                        StatusBadge(version.status, Modifier.align(Alignment.TopStart).padding(8.dp))
                                        Box(Modifier.align(Alignment.BottomEnd).padding(8.dp)) {
                                            RoundIconButton(onClick = {
                                                if (isCurrent) container.player.togglePlayPause()
                                                else container.player.play(QueueItem.fromVersion(project, version, container.player.artistName), container.library.queueItems(container.player.artistName))
                                            }) {
                                                Icon(
                                                    if (isCurrent && playerState.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                                                    contentDescription = "Play", tint = MbColors.Background,
                                                )
                                            }
                                        }
                                    }
                                }
                                Spacer(Modifier.size(8.dp))
                                Text(project.title, color = MbColors.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                MutedText(
                                    listOfNotNull(version?.displayName, project.genre, project.bpm?.let { "$it BPM" }).joinToString(" · ").ifEmpty { "No mixes yet" },
                                    size = 11,
                                )
                            }
                        }
                    }
                }
            }
            else -> CollectionsList(collections, collectionItems, library.projects, collectionsError, onRetry = { scope.launch { loadCollections() } })
        }
    }

    if (showNewProject) {
        NewProjectDialog(
            onDismiss = { showNewProject = false },
            onCreated = { projectId ->
                showNewProject = false
                scope.launch { container.library.reloadProject(projectId) }
                onOpenProject(projectId)
            },
        )
    }
}

@Composable
private fun CollectionsList(
    collections: List<Collection>,
    items: List<CollectionItem>,
    projects: List<Project>,
    error: String?,
    onRetry: () -> Unit,
) {
    val byCollection = remember(items) { items.groupBy { it.collectionId } }
    val projectMap = remember(projects) { projects.associateBy { it.id } }
    when {
        error != null && collections.isEmpty() -> LoadErrorCard("Couldn't load collections", onRetry, Modifier.padding(16.dp))
        collections.isEmpty() -> EmptyState("No collections yet", "Playlists, EPs and albums you build on the web appear here")
        else -> LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(collections, key = { it.id }) { collection ->
                val tracks = byCollection[collection.id].orEmpty()
                val cover = collection.coverUrl ?: collection.artworkUrl
                    ?: tracks.sortedBy { it.position }.firstNotNullOfOrNull { projectMap[it.projectId]?.artworkUrl }
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MbColors.Surface).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ArtworkImage(cover, modifier = Modifier.size(56.dp), shape = RoundedCornerShape(8.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(collection.title, color = MbColors.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        MutedText("${collection.type.replaceFirstChar { it.uppercase() }} · ${tracks.size} track${if (tracks.size == 1) "" else "s"}", size = 12)
                    }
                    Icon(Icons.Default.Folder, contentDescription = null, tint = MbColors.TextMuted)
                }
            }
        }
    }
}

/**
 * Create a project and upload its first mix in one step. The audio goes
 * straight from the device to Supabase Storage; the mb_versions row is then
 * created through /api/versions so the SERVER names it from the filename.
 */
@Composable
fun NewProjectDialog(onDismiss: () -> Unit, onCreated: (String) -> Unit) {
    val context = LocalContext.current
    val container = context.appContainer
    val scope = rememberCoroutineScope()

    var title by remember { mutableStateOf("") }
    var genre by remember { mutableStateOf("") }
    var bpm by remember { mutableStateOf("") }
    var fileUri by remember { mutableStateOf<Uri?>(null) }
    var fileName by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var progress by remember { mutableStateOf<String?>(null) }
    var fraction by remember { mutableStateOf(0f) }
    var submitting by remember { mutableStateOf(false) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            fileUri = uri
            fileName = context.describeFile(uri).name
        }
    }

    fun submit() {
        val t = title.trim()
        if (t.isEmpty()) { error = "Give the project a title"; return }
        submitting = true; error = null
        scope.launch {
            try {
                progress = "Creating project…"
                val project = container.supabase.createProject(t, genre.trim().ifEmpty { null }, bpm.trim().toIntOrNull())
                val uri = fileUri
                if (uri != null) {
                    val picked = withContext(Dispatchers.IO) { context.describeFile(uri) }
                    val duration = withContext(Dispatchers.IO) { context.probeDurationSeconds(uri) }
                    progress = "Uploading ${picked.name}…"
                    val key = StorageKeys.firstVersionAudio(project.id, picked.name)
                    val body = context.uploadBody(picked) { f -> fraction = f.toFloat() }
                    val audioUrl = container.supabase.uploadFile("mf-audio", key, body)
                    progress = "Saving mix…"
                    // No client label or status: the server names the row from the filename.
                    container.api.createVersion(project.id, audioUrl, picked.name, duration, picked.sizeBytes.takeIf { it > 0 })
                }
                onCreated(project.id)
            } catch (e: Exception) {
                error = e.displayMessage
                submitting = false
                progress = null
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        containerColor = MbColors.Surface,
        titleContentColor = MbColors.Text,
        textContentColor = MbColors.Text,
        title = { Text("New Project", fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                MbTextField(title, { title = it }, placeholder = "Project title *", enabled = !submitting)
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MbColors.SurfaceRaised)
                        .clickable(enabled = !submitting) { picker.launch(arrayOf("audio/*")) }
                        .padding(horizontal = 14.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(if (fileUri != null) Icons.Default.CheckCircle else Icons.Default.Add, contentDescription = null, tint = if (fileUri != null) MbColors.Teal else MbColors.TextMuted)
                    Spacer(Modifier.width(10.dp))
                    Text(fileName ?: "Choose audio file (optional)", color = if (fileName != null) MbColors.Text else MbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                MutedText("MP3, WAV, M4A, FLAC, AAC. Put \"master\" in the filename to upload a master.", size = 11)
                MbTextField(genre, { genre = it }, placeholder = "Genre (e.g. House)", enabled = !submitting)
                MbTextField(bpm, { bpm = it }, placeholder = "BPM (e.g. 128)", keyboardType = KeyboardType.Number, enabled = !submitting)
                ErrorText(error)
                if (progress != null) {
                    MutedText(progress ?: "", size = 12)
                    if (fraction in 0.01f..0.99f) LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth(), color = MbColors.Teal, trackColor = MbColors.Divider)
                }
            }
        },
        confirmButton = { PrimaryButton(if (fileUri != null) "Create & Upload" else "Create", onClick = ::submit, loading = submitting) },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !submitting) { Text("Cancel", color = MbColors.TextMuted) } },
    )
}
