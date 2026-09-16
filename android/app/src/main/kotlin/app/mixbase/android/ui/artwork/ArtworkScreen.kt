package app.mixbase.android.ui.artwork

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import app.mixbase.core.api.ArtworkPrompt
import app.mixbase.core.api.MixbaseApi
import app.mixbase.core.displayMessage
import app.mixbase.core.model.Project
import kotlinx.coroutines.launch

/**
 * The media library: every project cover, tap to open the project. AI
 * generation itself lives in [ArtworkGeneratorDialog] (server-side, monthly
 * allowance enforced by the server — no purchases anywhere).
 */
@Composable
fun ArtworkScreen(onOpenProject: (String) -> Unit) {
    val container = LocalContext.current.appContainer
    val library by container.library.state.collectAsState()
    val scope = rememberCoroutineScope()
    var generatorFor by remember { mutableStateOf<Project?>(null) }

    LaunchedEffect(Unit) { container.library.refreshIfStale() }

    val withArt = library.projects.filter { it.artworkUrl != null }
    val withoutArt = library.projects.filter { it.artworkUrl == null }

    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar("Artwork") {
            IconButton(onClick = { scope.launch { container.library.refresh() } }) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = MbColors.TextMuted)
            }
        }
        when {
            library.isLoading && !library.hasLoaded -> LoadingBox()
            library.error != null && library.projects.isEmpty() -> LoadErrorCard("Couldn't load your artwork", { scope.launch { container.library.refresh() } }, Modifier.padding(16.dp))
            library.projects.isEmpty() -> EmptyState("No artwork yet", "Create a project, then generate or upload its cover")
            else -> LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                contentPadding = PaddingValues(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (withoutArt.isNotEmpty()) {
                    item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) {
                        Column {
                            TealLabel("Needs artwork")
                            Spacer(Modifier.size(8.dp))
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(withoutArt, key = { it.id }) { project ->
                                    Text(
                                        project.title, color = MbColors.Text, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.clip(RoundedCornerShape(50)).background(MbColors.SurfaceHigh)
                                            .clickable { generatorFor = project }.padding(horizontal = 14.dp, vertical = 8.dp),
                                    )
                                }
                            }
                            Spacer(Modifier.size(8.dp))
                        }
                    }
                }
                items(withArt, key = { it.id }) { project ->
                    Column(Modifier.clickable { onOpenProject(project.id) }) {
                        Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
                            ArtworkImage(project.artworkUrl, Modifier.fillMaxSize(), RoundedCornerShape(12.dp))
                        }
                        Spacer(Modifier.size(6.dp))
                        Text(project.title, color = MbColors.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        MutedText("Tap to open · long-press on the project to regenerate", size = 10)
                    }
                }
            }
        }
    }

    generatorFor?.let { project ->
        ArtworkGeneratorDialog(project, onDismiss = { generatorFor = null }) {
            generatorFor = null
            scope.launch { container.library.reloadProject(project.id) }
        }
    }
}

/**
 * Describe → pick a model → optionally vary the look → Generate. The server
 * creates the image AND applies it to the project. Limit errors come back
 * as neutral, purchase-free copy (see MixbaseApi).
 */
@Composable
fun ArtworkGeneratorDialog(project: Project, onDismiss: () -> Unit, onGenerated: (String) -> Unit) {
    val container = LocalContext.current.appContainer
    val scope = rememberCoroutineScope()
    var prompt by remember { mutableStateOf("") }
    var modelId by remember { mutableStateOf(MixbaseApi.IMAGE_MODELS.first().id) }
    var vary by remember { mutableStateOf(false) }
    var generating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var resultUrl by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!generating) onDismiss() },
        containerColor = MbColors.Surface,
        titleContentColor = MbColors.Text,
        title = { Text("Generate artwork", fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                MutedText("for “${project.title}”", size = 12)
                if (resultUrl != null) {
                    ArtworkImage(resultUrl, Modifier.fillMaxWidth().aspectRatio(1f), RoundedCornerShape(12.dp))
                    Text("Applied as the project artwork.", color = MbColors.Teal, fontSize = 12.sp)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TealLabel("Describe your artwork")
                        Spacer(Modifier.weight(1f))
                        Text(
                            "Auto", color = MbColors.Background, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(MbColors.Teal)
                                .clickable(enabled = !generating) { prompt = ArtworkPrompt.build(project.title, project.genre, project.bpm) }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                    MbTextField(prompt, { prompt = it }, placeholder = "e.g. Neon city skyline at night, vinyl textures…", singleLine = false, minLines = 3, enabled = !generating)
                    TealLabel("Model")
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(MixbaseApi.IMAGE_MODELS, key = { it.id }) { model ->
                            val selected = model.id == modelId
                            Text(
                                model.label, fontSize = 12.sp, fontWeight = FontWeight.Medium,
                                color = if (selected) MbColors.Background else MbColors.Text,
                                modifier = Modifier.clip(RoundedCornerShape(50)).background(if (selected) MbColors.Teal else MbColors.SurfaceHigh)
                                    .clickable(enabled = !generating) { modelId = model.id }.padding(horizontal = 14.dp, vertical = 8.dp),
                            )
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Vary the look", color = MbColors.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                            MutedText("Adds a randomized lens, light and mood treatment", size = 11)
                        }
                        Spacer(Modifier.width(8.dp))
                        Switch(checked = vary, onCheckedChange = { vary = it }, enabled = !generating, colors = SwitchDefaults.colors(checkedTrackColor = MbColors.Teal, checkedThumbColor = MbColors.Background))
                    }
                    if (generating) MutedText("Generating — this can take up to two minutes…", size = 12)
                    ErrorText(error)
                }
            }
        },
        confirmButton = {
            if (resultUrl != null) {
                PrimaryButton("Done", onClick = { onGenerated(resultUrl!!) })
            } else {
                PrimaryButton("Generate", enabled = prompt.isNotBlank(), loading = generating, onClick = {
                    generating = true; error = null
                    scope.launch {
                        try {
                            resultUrl = container.api.generateArtwork(project.id, prompt.trim(), modelId, vary)
                        } catch (e: Exception) {
                            error = e.displayMessage
                        }
                        generating = false
                    }
                })
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !generating) { Text(if (resultUrl != null) "Close" else "Cancel", color = MbColors.TextMuted) } },
    )
}
