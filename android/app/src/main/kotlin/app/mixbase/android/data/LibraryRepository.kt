package app.mixbase.android.data

import app.mixbase.android.playback.QueueItem
import app.mixbase.core.displayMessage
import app.mixbase.core.model.Project
import app.mixbase.core.model.Version
import app.mixbase.core.supabase.SupabaseClient
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The user's projects and every version, loaded once and shared by Home,
 * Projects, Player and Artwork — the iOS app refetches per screen; here one
 * pull feeds all of them and pull-to-refresh / edits update it in place.
 */
class LibraryRepository(private val supabase: SupabaseClient) {

    data class State(
        val projects: List<Project> = emptyList(),
        val versionsByProject: Map<String, List<Version>> = emptyMap(),
        val isLoading: Boolean = false,
        val error: String? = null,
        val loadedAtMs: Long = 0,
    ) {
        val hasLoaded: Boolean get() = loadedAtMs > 0

        /** Highest version number per project. */
        val latestVersions: Map<String, Version>
            get() = versionsByProject.mapNotNull { (pid, versions) ->
                versions.maxByOrNull { it.versionNumber }?.let { pid to it }
            }.toMap()

        fun project(id: String): Project? = projects.firstOrNull { it.id == id }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val refreshMutex = Mutex()

    /** Reload projects + versions (two PostgREST calls, in parallel). Errors land in state.error. */
    suspend fun refresh() {
        if (refreshMutex.isLocked) return
        refreshMutex.withLock {
            _state.update { it.copy(isLoading = true, error = null) }
            try {
                val (projects, versions) = coroutineScope {
                    val p = async { supabase.fetchProjects() }
                    val v = async { supabase.fetchAllVersions() }
                    p.await() to v.await()
                }
                val grouped = versions.groupBy { it.projectId }.mapValues { (_, list) -> list.sortedBy { it.versionNumber } }
                _state.value = State(projects, grouped, isLoading = false, error = null, loadedAtMs = System.currentTimeMillis())
            } catch (e: Exception) {
                _state.update { it.copy(isLoading = false, error = e.displayMessage) }
            }
        }
    }

    /** Refresh unless we loaded within the last [maxAgeMs]. */
    suspend fun refreshIfStale(maxAgeMs: Long = 60_000) {
        val s = _state.value
        if (s.isLoading) return
        if (!s.hasLoaded || System.currentTimeMillis() - s.loadedAtMs > maxAgeMs) refresh()
    }

    /** Reload one project's versions after an upload, without refetching everything. */
    suspend fun reloadProject(projectId: String) {
        try {
            val project = supabase.fetchProject(projectId)
            val versions = supabase.fetchVersions(projectId)
            _state.update { s ->
                val projects = if (s.projects.any { it.id == projectId }) {
                    s.projects.map { if (it.id == projectId) project else it }
                } else {
                    listOf(project) + s.projects
                }
                s.copy(projects = projects, versionsByProject = s.versionsByProject + (projectId to versions))
            }
        } catch (e: Exception) {
            _state.update { it.copy(error = e.displayMessage) }
        }
    }

    fun applyProject(project: Project) {
        _state.update { s -> s.copy(projects = s.projects.map { if (it.id == project.id) project else it }) }
    }

    fun removeProject(projectId: String) {
        _state.update { s -> s.copy(projects = s.projects.filterNot { it.id == projectId }, versionsByProject = s.versionsByProject - projectId) }
    }

    fun clear() {
        _state.value = State()
    }

    /** One playable entry per project (its newest mix), in library order. */
    fun queueItems(artist: String): List<QueueItem> {
        val s = _state.value
        val latest = s.latestVersions
        return s.projects.mapNotNull { project ->
            val version = latest[project.id] ?: return@mapNotNull null
            QueueItem.fromVersion(project, version, artist)
        }
    }
}
