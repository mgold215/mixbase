package app.mixbase.android

import android.content.Context
import app.mixbase.android.auth.EncryptedTokenStore
import app.mixbase.android.data.LibraryRepository
import app.mixbase.android.playback.PlayerController
import app.mixbase.core.api.MixbaseApi
import app.mixbase.core.auth.AuthClient
import app.mixbase.core.auth.SessionManager
import app.mixbase.core.net.defaultHttpClient
import app.mixbase.core.supabase.SupabaseClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Hand-rolled dependency graph — one instance per process, created by
 * [MixbaseApplication]. Small enough that a DI framework would be more code
 * than it saves.
 */
class AppContainer(context: Context) {

    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val http = defaultHttpClient()

    val tokenStore = EncryptedTokenStore(context)
    val session = SessionManager(AuthClient(http), tokenStore, appScope)
    val supabase = SupabaseClient(http, session)
    val api = MixbaseApi(http, session)
    val library = LibraryRepository(supabase)
    val player = PlayerController(context.applicationContext, appScope)

    init {
        // The profile's artist_name feeds the notification / Bluetooth artist
        // slot; fetch it whenever a session is established.
        session.onSessionEstablished = { state ->
            state.userId?.let { uid ->
                appScope.launch {
                    val name = supabase.fetchArtistName(uid)
                    if (name.isNotEmpty()) player.artistName = name
                }
            }
        }
    }

    /** Sign out everywhere: tokens, cached library, playback. */
    fun signOut() {
        player.stopAndClear()
        player.artistName = ""
        library.clear()
        session.signOut()
    }
}

/** The container from any Context. */
val Context.appContainer: AppContainer
    get() = (applicationContext as MixbaseApplication).container
