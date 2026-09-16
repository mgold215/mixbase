package app.mixbase.android.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Loop
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
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
import app.mixbase.android.ui.Routes
import app.mixbase.android.ui.components.ArtworkImage
import app.mixbase.android.ui.components.BrandWordmark
import app.mixbase.android.ui.components.LoadErrorCard
import app.mixbase.android.ui.components.LoadingBox
import app.mixbase.android.ui.components.MutedText
import app.mixbase.android.ui.components.SectionHeader
import app.mixbase.android.ui.components.StatCard
import app.mixbase.android.ui.theme.MbColors
import app.mixbase.core.displayMessage
import app.mixbase.core.model.Activity
import app.mixbase.core.model.Release
import app.mixbase.core.model.formatRelative
import kotlinx.coroutines.launch

/**
 * Music-forward home: stats, a "Your Tracks" quick-play carousel, and Recent
 * Activity below. Mirrors ios/…/HomeView.swift.
 */
@Composable
fun HomeScreen(
    onOpenFeed: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenTab: (String) -> Unit,
    onOpenProject: (String) -> Unit,
) {
    val container = LocalContext.current.appContainer
    val library by container.library.state.collectAsState()
    val playerState by container.player.state.collectAsState()
    val scope = rememberCoroutineScope()

    var releases by remember { mutableStateOf<List<Release>>(emptyList()) }
    var activities by remember { mutableStateOf<List<Activity>>(emptyList()) }
    var sideLoading by remember { mutableStateOf(true) }
    var sideError by remember { mutableStateOf<String?>(null) }

    suspend fun loadSide() {
        sideLoading = true
        try {
            releases = container.supabase.fetchReleases()
            activities = container.supabase.fetchActivities(20)
            sideError = null
        } catch (e: Exception) {
            sideError = e.displayMessage
        }
        sideLoading = false
    }

    LaunchedEffect(Unit) {
        launch { container.library.refreshIfStale() }
        loadSide()
    }

    val projectMap = remember(library.projects) { library.projects.associateBy { it.id } }
    val latest = remember(library.versionsByProject) { library.latestVersions }
    val recentTracks = remember(library.projects, latest) { library.projects.filter { latest.containsKey(it.id) }.take(8) }
    val mixingCount = library.projects.count { it.genre != null }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(MbColors.Background),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandWordmark(size = 28)
                Spacer(Modifier.weight(1f))
                Row(
                    modifier = Modifier.clip(RoundedCornerShape(50)).clickable(onClick = onOpenFeed).padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Podcasts, contentDescription = null, tint = MbColors.Teal, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(5.dp))
                    Text("mixBASE Feed", color = MbColors.Teal, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
                IconButton(onClick = { scope.launch { container.library.refresh(); loadSide() } }) {
                    Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = MbColors.TextMuted)
                }
                IconButton(onClick = onOpenSettings) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings", tint = MbColors.Text)
                }
            }
        }

        if (library.error != null && library.projects.isEmpty() && !library.isLoading) {
            item {
                LoadErrorCard("Couldn't load your dashboard", onRetry = { scope.launch { container.library.refresh(); loadSide() } }, modifier = Modifier.padding(horizontal = 16.dp))
                Spacer(Modifier.size(16.dp))
            }
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                StatCard(library.projects.size, "Projects", MbColors.Text, Modifier.weight(1f)) { onOpenTab(Routes.PROJECTS) }
                StatCard(mixingCount, "Mixing", MbColors.Amber, Modifier.weight(1f)) { onOpenTab(Routes.PROJECTS) }
                StatCard(releases.size, "Pipeline", MbColors.Teal, Modifier.weight(1f)) { onOpenTab(Routes.PIPELINE) }
            }
            Spacer(Modifier.size(24.dp))
        }

        if (recentTracks.isNotEmpty()) {
            item {
                SectionHeader("Your Tracks", modifier = Modifier.padding(horizontal = 16.dp)) {
                    Text("See all", color = MbColors.Teal, fontSize = 13.sp, modifier = Modifier.clickable { onOpenTab(Routes.PLAYER) })
                }
                Spacer(Modifier.size(12.dp))
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(recentTracks, key = { it.id }) { project ->
                        val version = latest[project.id] ?: return@items
                        val isCurrent = playerState.current?.projectId == project.id
                        Column(
                            modifier = Modifier.width(132.dp).clickable {
                                container.player.play(
                                    app.mixbase.android.playback.QueueItem.fromVersion(project, version, container.player.artistName),
                                    container.library.queueItems(container.player.artistName),
                                )
                                onOpenTab(Routes.PLAYER)
                            },
                        ) {
                            Box {
                                ArtworkImage(project.artworkUrl, modifier = Modifier.size(132.dp), shape = RoundedCornerShape(12.dp), placeholderIconSize = 36.dp)
                                if (isCurrent) {
                                    Box(
                                        Modifier.align(Alignment.BottomEnd).padding(8.dp).size(10.dp).clip(RoundedCornerShape(50)).background(MbColors.Teal),
                                    )
                                }
                            }
                            Spacer(Modifier.size(8.dp))
                            Text(project.title, color = MbColors.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            MutedText(version.displayName, size = 11)
                        }
                    }
                }
                Spacer(Modifier.size(24.dp))
            }
        }

        item {
            SectionHeader("Recent Activity", modifier = Modifier.padding(horizontal = 16.dp))
            Spacer(Modifier.size(8.dp))
        }
        when {
            sideLoading && activities.isEmpty() -> item { LoadingBox() }
            sideError != null && activities.isEmpty() -> item { MutedText(sideError ?: "", modifier = Modifier.padding(16.dp)) }
            activities.isEmpty() -> item { MutedText("No recent activity", modifier = Modifier.padding(horizontal = 16.dp, vertical = 20.dp)) }
            else -> items(activities, key = { it.id }) { activity ->
                val project = activity.projectId?.let { projectMap[it] }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(enabled = project != null) { project?.let { onOpenProject(it.id) } }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(activityIcon(activity.type), contentDescription = null, tint = MbColors.Teal, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            activity.description ?: activityTitle(activity.type),
                            color = MbColors.Text, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                        MutedText(listOfNotNull(project?.title, formatRelative(activity.createdAt)).joinToString(" · "), size = 11)
                    }
                }
            }
        }
    }
}

private fun activityIcon(type: String) = when (type) {
    "version_created" -> Icons.Default.AddCircle
    "release_updated", "release_created" -> Icons.Default.Loop
    "feedback_added", "feed_comment" -> Icons.Default.ChatBubbleOutline
    "project_created" -> Icons.Default.CreateNewFolder
    else -> Icons.Default.Notifications
}

private fun activityTitle(type: String) = when (type) {
    "version_created" -> "New mix uploaded"
    "release_updated" -> "Release updated"
    "release_created" -> "Release created"
    "feedback_added" -> "New feedback"
    "project_created" -> "Project created"
    else -> type.replace('_', ' ').replaceFirstChar { it.uppercase() }
}
