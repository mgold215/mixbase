package app.mixbase.android.ui.pipeline

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.appContainer
import app.mixbase.android.ui.components.ArtworkImage
import app.mixbase.android.ui.components.CardRow
import app.mixbase.android.ui.components.EmptyState
import app.mixbase.android.ui.components.ErrorText
import app.mixbase.android.ui.components.LoadErrorCard
import app.mixbase.android.ui.components.LoadingBox
import app.mixbase.android.ui.components.MbTextField
import app.mixbase.android.ui.components.MbTopBar
import app.mixbase.android.ui.components.MutedText
import app.mixbase.android.ui.components.PrimaryButton
import app.mixbase.android.ui.components.TealLabel
import app.mixbase.android.ui.theme.MbColors
import app.mixbase.core.displayMessage
import app.mixbase.core.model.Release
import app.mixbase.core.supabase.SupabaseClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** Process-wide cache so the detail screen can open a release the list already loaded. */
internal object ReleasesCache {
    val releases = MutableStateFlow<List<Release>>(emptyList())
    var loaded = false

    fun replace(release: Release) {
        releases.value = releases.value.map { if (it.id == release.id) release else it }
    }
}

internal suspend fun loadReleases(supabase: SupabaseClient) {
    ReleasesCache.releases.value = supabase.fetchReleases()
    ReleasesCache.loaded = true
}

private val dateFormat = DateTimeFormatter.ofPattern("MMM d, yyyy")

/** Release pipeline list with progress. Mirrors ios/…/PipelineView.swift. */
@Composable
fun PipelineScreen(onOpenRelease: (String) -> Unit) {
    val container = LocalContext.current.appContainer
    val releases by ReleasesCache.releases.collectAsState()
    val library by container.library.state.collectAsState()
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(!ReleasesCache.loaded) }
    var error by remember { mutableStateOf<String?>(null) }
    var showNew by remember { mutableStateOf(false) }

    suspend fun load() {
        loading = true
        try { loadReleases(container.supabase); error = null } catch (e: Exception) { error = e.displayMessage }
        loading = false
    }

    LaunchedEffect(Unit) {
        launch { container.library.refreshIfStale() }
        if (!ReleasesCache.loaded) load() else loading = false
    }

    val artworkByProject = remember(library.projects) { library.projects.associate { it.id to it.artworkUrl } }

    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar("Pipeline") {
            IconButton(onClick = { scope.launch { load() } }) { Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = MbColors.TextMuted) }
            IconButton(onClick = { showNew = true }) { Icon(Icons.Default.Add, contentDescription = "New release", tint = MbColors.Teal) }
        }
        when {
            loading && releases.isEmpty() -> LoadingBox()
            error != null && releases.isEmpty() -> LoadErrorCard("Couldn't load your pipeline", { scope.launch { load() } }, Modifier.padding(16.dp))
            releases.isEmpty() -> EmptyState("No releases in pipeline", "Tap + to add a release")
            else -> LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(releases, key = { it.id }) { release ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MbColors.Surface)
                            .clickable { onOpenRelease(release.id) }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ArtworkImage(release.projectId?.let { artworkByProject[it] }, Modifier.size(56.dp), RoundedCornerShape(8.dp))
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(release.title, color = MbColors.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            MutedText(release.releaseDate?.let { dateFormat.format(it) } ?: "No date set", size = 12)
                            LinearProgressIndicator(progress = { release.progress }, modifier = Modifier.fillMaxWidth(), color = MbColors.Teal, trackColor = MbColors.Divider)
                        }
                        Spacer(Modifier.width(12.dp))
                        Text("${(release.progress * 100).toInt()}%", color = MbColors.Teal, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }

    if (showNew) {
        NewReleaseDialog(onDismiss = { showNew = false }) { title, projectId, date ->
            showNew = false
            scope.launch {
                try {
                    val created = container.supabase.createRelease(title, projectId, date)
                    ReleasesCache.releases.value = listOf(created) + ReleasesCache.releases.value
                    onOpenRelease(created.id)
                } catch (e: Exception) { error = e.displayMessage }
            }
        }
    }
}

@Composable
private fun NewReleaseDialog(onDismiss: () -> Unit, onCreate: (String, String?, LocalDate?) -> Unit) {
    val container = LocalContext.current.appContainer
    val library by container.library.state.collectAsState()
    var title by remember { mutableStateOf("") }
    var date by remember { mutableStateOf("") }
    var projectId by remember { mutableStateOf<String?>(null) }
    var pickerOpen by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = MbColors.Surface,
        titleContentColor = MbColors.Text,
        title = { Text("New Release", fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                MbTextField(title, { title = it }, placeholder = "Release title *")
                MbTextField(date, { date = it }, placeholder = "Release date (YYYY-MM-DD)")
                CardRow(onClick = { pickerOpen = true }) {
                    Icon(Icons.Default.Link, contentDescription = null, tint = MbColors.Teal)
                    Spacer(Modifier.width(10.dp))
                    Text(library.projects.firstOrNull { it.id == projectId }?.title ?: "Link a project (optional)", color = if (projectId != null) MbColors.Text else MbColors.TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                DropdownMenu(expanded = pickerOpen, onDismissRequest = { pickerOpen = false }) {
                    DropdownMenuItem(text = { Text("No project") }, onClick = { projectId = null; pickerOpen = false })
                    library.projects.forEach { p -> DropdownMenuItem(text = { Text(p.title) }, onClick = { projectId = p.id; pickerOpen = false }) }
                }
                ErrorText(error)
            }
        },
        confirmButton = {
            PrimaryButton("Create", enabled = title.isNotBlank(), onClick = {
                val raw = date.trim()
                val parsed: LocalDate? = if (raw.isEmpty()) null else try { LocalDate.parse(raw) } catch (e: DateTimeParseException) { null }
                if (raw.isNotEmpty() && parsed == null) {
                    error = "Use the format YYYY-MM-DD"
                } else {
                    onCreate(title.trim(), projectId, parsed)
                }
            })
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = MbColors.TextMuted) } },
    )
}

/** Checklist + DSP flags + notes; every toggle saves immediately. Mirrors ios/…/ReleaseDetailView.swift. */
@Composable
fun ReleaseDetailScreen(releaseId: String, onBack: () -> Unit, onOpenProject: (String) -> Unit) {
    val container = LocalContext.current.appContainer
    val releases by ReleasesCache.releases.collectAsState()
    val scope = rememberCoroutineScope()
    val release = releases.firstOrNull { it.id == releaseId }
    var error by remember { mutableStateOf<String?>(null) }
    var showDelete by remember { mutableStateOf(false) }
    var notes by remember(release?.id) { mutableStateOf(release?.notes ?: "") }
    var titleText by remember(release?.id) { mutableStateOf(release?.title ?: "") }
    var dateText by remember(release?.id) { mutableStateOf(release?.releaseDate?.toString() ?: "") }
    var detailsError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(releaseId) {
        if (release == null) {
            try { loadReleases(container.supabase) } catch (e: Exception) { error = e.displayMessage }
        }
    }

    fun save(updated: Release, fields: Map<String, Any?>) {
        ReleasesCache.replace(updated)
        scope.launch {
            try { container.supabase.updateRelease(updated.id, fields) } catch (e: Exception) { error = e.displayMessage }
        }
    }

    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar(release?.title ?: "Release", onBack = onBack) {
            IconButton(onClick = { showDelete = true }) { Icon(Icons.Default.Delete, contentDescription = "Delete", tint = MbColors.Red) }
        }
        if (release == null) {
            if (error != null) ErrorText(error, Modifier.padding(16.dp)) else LoadingBox()
            return@Column
        }

        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            ErrorText(error)
            TealLabel("Title")
            MbTextField(titleText, { titleText = it; detailsError = null }, placeholder = "Release title")

            TealLabel("Release date")
            MbTextField(dateText, { dateText = it; detailsError = null }, placeholder = "YYYY-MM-DD")
            ErrorText(detailsError)
            val detailsChanged = titleText.trim() != release.title || dateText.trim() != (release.releaseDate?.toString() ?: "")
            PrimaryButton("Save details", enabled = detailsChanged && titleText.isNotBlank(), onClick = {
                val raw = dateText.trim()
                val parsed: LocalDate? = if (raw.isEmpty()) null else runCatching { LocalDate.parse(raw) }.getOrNull()
                if (raw.isNotEmpty() && parsed == null) {
                    detailsError = "Use the format YYYY-MM-DD"
                } else {
                    save(release.copy(title = titleText.trim(), releaseDate = parsed), mapOf("title" to titleText.trim(), "release_date" to parsed))
                }
            })

            release.projectId?.let { pid ->
                CardRow(onClick = { onOpenProject(pid) }) {
                    Icon(Icons.Default.Link, contentDescription = null, tint = MbColors.Teal)
                    Spacer(Modifier.width(10.dp))
                    Text("View linked project", color = MbColors.Text)
                }
            }

            TealLabel("Checklist")
            ChecklistToggle("Mixing Done", release.mixingDone) { save(release.copy(mixingDone = it), mapOf("mixing_done" to it)) }
            ChecklistToggle("Mastering Done", release.masteringDone) { save(release.copy(masteringDone = it), mapOf("mastering_done" to it)) }
            ChecklistToggle("Artwork Ready", release.artworkReady) { save(release.copy(artworkReady = it), mapOf("artwork_ready" to it)) }
            ChecklistToggle("DSP Submitted", release.dspSubmitted) { save(release.copy(dspSubmitted = it), mapOf("dsp_submitted" to it)) }
            ChecklistToggle("Social Posts Done", release.socialPostsDone) { save(release.copy(socialPostsDone = it), mapOf("social_posts_done" to it)) }
            ChecklistToggle("Press Release Done", release.pressReleaseDone) { save(release.copy(pressReleaseDone = it), mapOf("press_release_done" to it)) }

            TealLabel("DSP Platforms")
            ChecklistToggle("Spotify", release.dspSpotify) { save(release.copy(dspSpotify = it), mapOf("dsp_spotify" to it)) }
            ChecklistToggle("Apple Music", release.dspAppleMusic) { save(release.copy(dspAppleMusic = it), mapOf("dsp_apple_music" to it)) }
            ChecklistToggle("Tidal", release.dspTidal) { save(release.copy(dspTidal = it), mapOf("dsp_tidal" to it)) }
            ChecklistToggle("Bandcamp", release.dspBandcamp) { save(release.copy(dspBandcamp = it), mapOf("dsp_bandcamp" to it)) }
            ChecklistToggle("SoundCloud", release.dspSoundcloud) { save(release.copy(dspSoundcloud = it), mapOf("dsp_soundcloud" to it)) }
            ChecklistToggle("YouTube", release.dspYoutube) { save(release.copy(dspYoutube = it), mapOf("dsp_youtube" to it)) }
            ChecklistToggle("Amazon", release.dspAmazon) { save(release.copy(dspAmazon = it), mapOf("dsp_amazon" to it)) }

            TealLabel("Notes")
            MbTextField(notes, { notes = it }, placeholder = "Anything to remember for this release", singleLine = false, minLines = 4)
            PrimaryButton("Save notes", enabled = notes != (release.notes ?: ""), onClick = {
                val value = notes.ifBlank { null }
                save(release.copy(notes = value), mapOf("notes" to value))
            })
            Spacer(Modifier.size(24.dp))
        }
    }

    if (showDelete && release != null) {
        AlertDialog(
            onDismissRequest = { showDelete = false },
            containerColor = MbColors.Surface,
            titleContentColor = MbColors.Text,
            textContentColor = MbColors.TextBody,
            title = { Text("Delete release?") },
            text = { Text("\"${release.title}\" will be removed from your pipeline.") },
            confirmButton = {
                TextButton(onClick = {
                    showDelete = false
                    scope.launch {
                        try {
                            container.supabase.deleteRelease(release.id)
                            ReleasesCache.releases.value = ReleasesCache.releases.value.filterNot { it.id == release.id }
                            onBack()
                        } catch (e: Exception) { error = e.displayMessage }
                    }
                }) { Text("Delete", color = MbColors.Red) }
            },
            dismissButton = { TextButton(onClick = { showDelete = false }) { Text("Cancel", color = MbColors.TextMuted) } },
        )
    }
}

@Composable
private fun ChecklistToggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    CardRow {
        Text(label, color = MbColors.Text, modifier = Modifier.weight(1f))
        Switch(
            checked = checked, onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = MbColors.Teal, checkedThumbColor = MbColors.Background),
        )
    }
}
