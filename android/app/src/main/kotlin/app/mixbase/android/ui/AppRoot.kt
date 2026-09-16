package app.mixbase.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.mixbase.android.appContainer
import app.mixbase.android.ui.artwork.ArtworkScreen
import app.mixbase.android.ui.auth.LoginScreen
import app.mixbase.android.ui.auth.SignUpScreen
import app.mixbase.android.ui.components.MiniPlayerBar
import app.mixbase.android.ui.feed.FeedScreen
import app.mixbase.android.ui.home.HomeScreen
import app.mixbase.android.ui.pipeline.PipelineScreen
import app.mixbase.android.ui.pipeline.ReleaseDetailScreen
import app.mixbase.android.ui.player.PlayerScreen
import app.mixbase.android.ui.projects.ProjectDetailScreen
import app.mixbase.android.ui.projects.ProjectsScreen
import app.mixbase.android.ui.settings.LegalScreen
import app.mixbase.android.ui.settings.SettingsScreen
import app.mixbase.android.ui.theme.MbColors

/** Route names. Tab roots first; everything else is pushed on top. */
object Routes {
    const val HOME = "home"
    const val PROJECTS = "projects"
    const val PLAYER = "player"
    const val ARTWORK = "artwork"
    const val PIPELINE = "pipeline"
    const val FEED = "feed"
    const val SETTINGS = "settings"
    const val PROJECT = "project/{id}"
    const val RELEASE = "release/{id}"
    const val LEGAL = "legal/{doc}"

    fun project(id: String) = "project/$id"
    fun release(id: String) = "release/$id"
    fun legal(doc: String) = "legal/$doc"
}

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab(Routes.HOME, "Home", Icons.Default.Home),
    Tab(Routes.PROJECTS, "Projects", Icons.Default.GridView),
    Tab(Routes.PLAYER, "Player", Icons.Default.PlayCircle),
    Tab(Routes.ARTWORK, "Artwork", Icons.Default.Image),
    Tab(Routes.PIPELINE, "Pipeline", Icons.Default.Checklist),
)

/** Root: LoginScreen until authenticated, then the five-tab shell. */
@Composable
fun AppRoot(deepLink: State<String?>) {
    val container = LocalContext.current.appContainer
    val auth by container.session.state.collectAsState()

    Box(Modifier.fillMaxSize().background(MbColors.Background)) {
        if (auth.isAuthenticated) {
            MainShell(deepLink)
        } else {
            var showSignUp by remember { mutableStateOf(false) }
            if (showSignUp) SignUpScreen(onBackToLogin = { showSignUp = false }) else LoginScreen(onSignUp = { showSignUp = true })
        }
    }
}

@Composable
private fun MainShell(deepLink: State<String?>) {
    val container = LocalContext.current.appContainer
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route
    val playerState by container.player.state.collectAsState()

    // Widget/notification deep links (mixbase://player etc.) land on the right tab.
    val link = deepLink.value
    LaunchedEffect(link) {
        when (link) {
            "home" -> navController.navigateTab(Routes.HOME)
            "projects", "new-project" -> navController.navigateTab(Routes.PROJECTS)
            "player" -> navController.navigateTab(Routes.PLAYER)
            "artwork" -> navController.navigateTab(Routes.ARTWORK)
            "pipeline" -> navController.navigateTab(Routes.PIPELINE)
        }
    }

    Scaffold(
        containerColor = MbColors.Background,
        bottomBar = {
            Column {
                // Mini player floats above the tab bar on every tab except the full Player.
                if (playerState.current != null && currentRoute != Routes.PLAYER) {
                    MiniPlayerBar(
                        state = playerState,
                        onTap = { navController.navigateTab(Routes.PLAYER) },
                        onTogglePlay = { container.player.togglePlayPause() },
                        onNext = { container.player.next() },
                        modifier = Modifier.padding(horizontal = 8.dp).padding(bottom = 4.dp),
                    )
                }
                NavigationBar(containerColor = MbColors.Background, tonalElevation = 0.dp) {
                    tabs.forEach { tab ->
                        NavigationBarItem(
                            selected = currentRoute == tab.route,
                            onClick = { navController.navigateTab(tab.route) },
                            icon = { Icon(tab.icon, contentDescription = tab.label) },
                            label = { Text(tab.label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MbColors.Teal,
                                selectedTextColor = MbColors.Teal,
                                indicatorColor = MbColors.Teal.copy(alpha = 0.12f),
                                unselectedIconColor = MbColors.TextMuted,
                                unselectedTextColor = MbColors.TextMuted,
                            ),
                        )
                    }
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Routes.HOME,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            composable(Routes.HOME) {
                HomeScreen(
                    onOpenFeed = { navController.navigate(Routes.FEED) },
                    onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                    onOpenTab = { navController.navigateTab(it) },
                    onOpenProject = { navController.navigate(Routes.project(it)) },
                )
            }
            composable(Routes.PROJECTS) {
                ProjectsScreen(onOpenProject = { navController.navigate(Routes.project(it)) }, onOpenPlayer = { navController.navigateTab(Routes.PLAYER) })
            }
            composable(Routes.PLAYER) { PlayerScreen() }
            composable(Routes.ARTWORK) { ArtworkScreen(onOpenProject = { navController.navigate(Routes.project(it)) }) }
            composable(Routes.PIPELINE) {
                PipelineScreen(onOpenRelease = { navController.navigate(Routes.release(it)) })
            }
            composable(Routes.FEED) { FeedScreen(onBack = { navController.popBackStack() }) }
            composable(Routes.SETTINGS) {
                SettingsScreen(onBack = { navController.popBackStack() }, onOpenLegal = { navController.navigate(Routes.legal(it)) })
            }
            composable(Routes.LEGAL, arguments = listOf(navArgument("doc") { type = NavType.StringType })) { entry ->
                LegalScreen(doc = entry.arguments?.getString("doc") ?: "support", onBack = { navController.popBackStack() })
            }
            composable(Routes.PROJECT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                ProjectDetailScreen(projectId = id, onBack = { navController.popBackStack() }, onOpenPlayer = { navController.navigateTab(Routes.PLAYER) })
            }
            composable(Routes.RELEASE, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                ReleaseDetailScreen(releaseId = id, onBack = { navController.popBackStack() }, onOpenProject = { navController.navigate(Routes.project(it)) })
            }
        }
    }
}

/** Tab navigation: one back-stack per tab, restored when you return. */
private fun NavHostController.navigateTab(route: String) {
    navigate(route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}
