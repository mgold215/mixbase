package app.mixbase.android.ui.projects

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.DownloadDone
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.appContainer
import app.mixbase.android.playback.QueueItem
import app.mixbase.android.ui.artwork.ArtworkGeneratorDialog
import app.mixbase.android.ui.components.ArtworkImage
import app.mixbase.android.ui.components.ErrorText
import app.mixbase.android.ui.components.LoadingBox
import app.mixbase.android.ui.components.MbTextField
import app.mixbase.android.ui.components.MbTopBar
import app.mixbase.android.ui.components.MutedText
import app.mixbase.android.ui.components.PrimaryButton
import app.mixbase.android.ui.components.RoundIconButton
import app.mixbase.android.ui.components.SectionHeader
import app.mixbase.android.ui.components.StatusBadge
import app.mixbase.android.ui.components.TealLabel
import app.mixbase.android.ui.theme.MbColors
import app.mixbase.android.ui.util.describeFile
import app.mixbase.android.ui.util.probeDurationSeconds
import app.mixbase.android.ui.util.readBytes
import app.mixbase.android.ui.util.shareText
import app.mixbase.android.ui.util.uploadBody
import app.mixbase.core.StorageKeys
import app.mixbase.core.displayMessage
import app.mixbase.core.model.MixStatus
import app.mixbase.core.model.Project
import app.mixbase.core.model.Version
import app.mixbase.core.model.formatBytes
import app.mixbase.core.model.formatClock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * One project: artwork (pick / AI-generate), metadata, and the mix history —
 * play, share, download consent, status. Mirrors ios/…/ProjectDetailView.swift.
 */
@Composable
fun ProjectDetailScreen(projectId: String, onBack: () -> Unit, onOpenPlayer: () -> Unit) {
    val context = LocalContext.current
    val container = context.appContainer
    val library by container.library.state.collectAsState()
    val playerState by container.player.state.collectAsState()
    val scope = rememberCoroutineScope()

    val project = library.project(projectId)
    val versions = library.versionsByProject[projectId].orEmpty().sortedByDescending { it.versionNumber }

    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var showEdit by remember { mutableStateOf(false) }
    var showGenerator by remember { mutableStateOf(false) }
    var showDelete by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var uploadProgress by remember { mutableStateOf<String?>(null) }
    var uploadFraction by remember { mutableStateOf(0f) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(projectId) {
        if (project == null || !library.versionsByProject.containsKey(projectId)) container.library.reloadProject(projectId)
    }

    fun uploadVersion(uri: Uri) {
        val p = project ?: return
        busy = true; error = null
        scope.launch {
            try {
                val picked = withContext(Dispatchers.IO) { context.describeFile(uri) }
                val duration = withContext(Dispatchers.IO) { context.probeDurationSeconds(uri) }
                val next = (versions.maxOfOrNull { it.versionNumber } ?: 0) + 1
                uploadProgress = "Uploading ${picked.name}…"
                uploadFraction = 0f
                val key = StorageKeys.versionAudio(p.id, next, picked.name, System.currentTimeMillis() / 1000)
                val url = container.supabase.uploadFile("mf-audio", key, context.uploadBody(picked) { f -> uploadFraction = f.toFloat() })
                uploadProgress = "Saving mix…"
                val created = container.api.createVersion(p.id, url, picked.name, duration, picked.sizeBytes.takeIf { it > 0 })
                container.library.reloadProject(p.id)
                notice = "${created.displayName} uploaded"
            } catch (e: Exception) {
                error = e.displayMessage
            }
            uploadProgress = null
            busy = false
        }
    }

    fun uploadArtwork(uri: Uri) {
        val p = project ?: return
        busy = true; error = null
        scope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) { context.readBytes(uri) }
                val key = StorageKeys.projectArtwork(p.id, System.currentTimeMillis() / 1000)
                val url = container.supabase.uploadBytes("mf-artwork", key, bytes, "image/jpeg")
                container.api.assignArtworkToProject(p.id, url)
                container.library.reloadProject(p.id)
            } catch (e: Exception) {
                error = e.displayMessage
            }
            busy = false
        }
    }

    val audioPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(::uploadVersion) }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> uri?.let(::uploadArtwork) }

    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar(project?.title ?: "Project", onBack = onBack) {
            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More", tint = MbColors.Text) }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(text = { Text("Edit details") }, leadingIcon = { Icon(Icons.Default.Edit, null) }, onClick = { menuOpen = false; showEdit = true })
                DropdownMenuItem(text = { Text("Change artwork") }, leadingIcon = { Icon(Icons.Default.Image, null) }, onClick = {
                    menuOpen = false
                    imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                })
                DropdownMenuItem(text = { Text("Generate artwork") }, leadingIcon = { Icon(Icons.Default.AutoAwesome, null) }, onClick = { menuOpen = false; showGenerator = true })
                DropdownMenuItem(text = { Text("Delete project", color = MbColors.Red) }, leadingIcon = { Icon(Icons.Default.Delete, null, tint = MbColors.Red) }, onClick = { menuOpen = false; showDelete = true })
            }
        }

        if (project == null) {
            if (library.error != null) ErrorText(library.error, Modifier.padding(16.dp)) else LoadingBox()
            return@Column
        }

        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            // Artwork
            Box(Modifier.fillMaxWidth().aspectRatio(1f).clickable { showGenerator = true }) {
                ArtworkImage(project.artworkUrl, modifier = Modifier.fillMaxSize(), shape = RoundedCornerShape(16.dp), placeholderIconSize = 56.dp)
                if (project.artworkUrl == null) {
                    Text(
                        "Tap to generate artwork",
                        color = MbColors.TextMuted, fontSize = 12.sp,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
                    )
                }
            }

            // Metadata
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOfNotNull(project.genre, project.bpm?.let { "$it BPM" }, project.keySignature).forEach { tag ->
                    Text(tag, color = MbColors.Text, fontSize = 12.sp, modifier = Modifier.clip(RoundedCornerShape(50)).background(MbColors.SurfaceHigh).padding(horizontal = 10.dp, vertical = 5.dp))
                }
                if (project.genre == null && project.bpm == null && project.keySignature == null) {
                    Text("Add genre, BPM and key", color = MbColors.TextMuted, fontSize = 12.sp, modifier = Modifier.clickable { showEdit = true })
                }
            }

            ErrorText(error)
            if (notice != null) Text(notice ?: "", color = MbColors.Teal, fontSize = 12.sp)

            // Upload
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MbColors.Surface).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (uploadProgress != null) {
                    MutedText(uploadProgress ?: "", size = 12)
                    LinearProgressIndicator(progress = { uploadFraction }, modifier = Modifier.fillMaxWidth(), color = MbColors.Teal, trackColor = MbColors.Divider)
                } else {
                    PrimaryButton("Upload new mix", onClick = { audioPicker.launch(arrayOf("audio/*")) }, modifier = Modifier.fillMaxWidth(), enabled = !busy)
                    MutedText("Named from your file — put \"master\" in the filename to upload a master.", size = 11)
                }
            }

            // Versions
            SectionHeader("Mixes & Masters")
            if (versions.isEmpty()) {
                MutedText("No mixes yet — upload your first bounce above.")
            }
            versions.forEach { version ->
                VersionRow(
                    version = version,
                    isCurrent = playerState.current?.versionId == version.id,
                    isPlaying = playerState.isPlaying,
                    onPlay = {
                        if (playerState.current?.versionId == version.id) container.player.togglePlayPause()
                        else container.player.play(QueueItem.fromVersion(project, version, container.player.artistName))
                    },
                    onShare = {
                        val token = version.shareToken ?: project.shareToken
                        if (token != null) context.shareText("https://mixbase.app/share/$token", "Share ${version.displayName}")
                        else error = "This mix has no share link yet — open it on the web once to mint one."
                    },
                    onToggleDownload = {
                        scope.launch {
                            try {
                                container.api.setAllowDownload(version.id, !version.allowDownload)
                                container.library.reloadProject(project.id)
                            } catch (e: Exception) { error = e.displayMessage }
                        }
                    },
                    onStatus = { status ->
                        scope.launch {
                            try {
                                container.supabase.updateVersionStatus(version.id, status)
                                container.library.reloadProject(project.id)
                            } catch (e: Exception) { error = e.displayMessage }
                        }
                    },
                    onDelete = {
                        scope.launch {
                            try {
                                container.supabase.deleteVersion(version.id)
                                container.library.reloadProject(project.id)
                            } catch (e: Exception) { error = e.displayMessage }
                        }
                    },
                )
            }
            Spacer(Modifier.size(24.dp))
        }
    }

    if (showEdit) {
        EditProjectDialog(project, onDismiss = { showEdit = false }) { fields ->
            showEdit = false
            scope.launch {
                try {
                    container.supabase.updateProject(project.id, fields)
                    container.library.reloadProject(project.id)
                } catch (e: Exception) { error = e.displayMessage }
            }
        }
    }

    if (showGenerator) {
        ArtworkGeneratorDialog(project = project, onDismiss = { showGenerator = false }) {
            showGenerator = false
            scope.launch { container.library.reloadProject(project.id) }
        }
    }

    if (showDelete) {
        AlertDialog(
            onDismissRequest = { showDelete = false },
            containerColor = MbColors.Surface,
            titleContentColor = MbColors.Text,
            textContentColor = MbColors.TextBody,
            title = { Text("Delete project?") },
            text = { Text("\"${project.title}\" and all of its mixes will be removed. This cannot be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    showDelete = false
                    scope.launch {
                        try {
                            container.supabase.deleteProject(project.id)
                            container.library.removeProject(project.id)
                            onBack()
                        } catch (e: Exception) { error = e.displayMessage }
                    }
                }) { Text("Delete", color = MbColors.Red) }
            },
            dismissButton = { TextButton(onClick = { showDelete = false }) { Text("Cancel", color = MbColors.TextMuted) } },
        )
    }
}

private val dateFormat = DateTimeFormatter.ofPattern("MMM d, yyyy")

@Composable
private fun VersionRow(
    version: Version,
    isCurrent: Boolean,
    isPlaying: Boolean,
    onPlay: () -> Unit,
    onShare: () -> Unit,
    onToggleDownload: () -> Unit,
    onStatus: (String) -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (isCurrent) MbColors.Teal.copy(alpha = 0.08f) else MbColors.Surface).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RoundIconButton(onClick = onPlay, size = 40.dp, background = if (isCurrent) MbColors.Teal else MbColors.SurfaceHigh) {
            Icon(
                if (isCurrent && isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                contentDescription = "Play", tint = if (isCurrent) MbColors.Background else MbColors.Text,
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(version.displayName, color = MbColors.Text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                StatusBadge(version.status)
            }
            MutedText(
                listOfNotNull(
                    dateFormat.format(version.createdAt.atZone(ZoneId.systemDefault())),
                    version.durationSeconds?.let { formatClock(it.toLong()) },
                    version.fileSizeBytes?.let { formatBytes(it) },
                ).joinToString(" · "),
                size = 11,
            )
        }
        IconButton(onClick = onToggleDownload) {
            Icon(
                if (version.allowDownload) Icons.Default.DownloadDone else Icons.Default.Download,
                contentDescription = if (version.allowDownload) "Share-link download allowed" else "Share-link download off",
                tint = if (version.allowDownload) MbColors.Teal else MbColors.TextMuted,
            )
        }
        IconButton(onClick = onShare) { Icon(Icons.Default.Share, contentDescription = "Share", tint = MbColors.Text) }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More", tint = MbColors.TextMuted) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                MixStatus.ALL.forEach { status ->
                    DropdownMenuItem(
                        text = { Text(if (status == version.status) "$status ✓" else status) },
                        onClick = { menu = false; if (status != version.status) onStatus(status) },
                    )
                }
                DropdownMenuItem(text = { Text("Delete mix", color = MbColors.Red) }, onClick = { menu = false; onDelete() })
            }
        }
    }
}

@Composable
private fun EditProjectDialog(project: Project, onDismiss: () -> Unit, onSave: (Map<String, Any?>) -> Unit) {
    var title by remember { mutableStateOf(project.title) }
    var genre by remember { mutableStateOf(project.genre ?: "") }
    var bpm by remember { mutableStateOf(project.bpm?.toString() ?: "") }
    var key by remember { mutableStateOf(project.keySignature ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = MbColors.Surface,
        titleContentColor = MbColors.Text,
        title = { Text("Edit details", fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                TealLabel("Title")
                MbTextField(title, { title = it }, placeholder = "Title")
                TealLabel("Genre")
                MbTextField(genre, { genre = it }, placeholder = "e.g. House, Hip-Hop, Ambient")
                TealLabel("BPM")
                MbTextField(bpm, { bpm = it }, placeholder = "e.g. 128", keyboardType = KeyboardType.Number)
                TealLabel("Key")
                MbTextField(key, { key = it }, placeholder = "e.g. Am, F#")
            }
        },
        confirmButton = {
            PrimaryButton("Save", enabled = title.isNotBlank(), onClick = {
                onSave(
                    mapOf(
                        "title" to title.trim(),
                        "genre" to genre.trim().ifEmpty { null },
                        "bpm" to bpm.trim().toIntOrNull(),
                        "key_signature" to key.trim().ifEmpty { null },
                    ),
                )
            })
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = MbColors.TextMuted) } },
    )
}
