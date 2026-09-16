package app.mixbase.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.lifecycleScope
import app.mixbase.android.ui.AppRoot
import app.mixbase.android.ui.theme.MixbaseTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    /** Deep-link target (mixbase://player etc.) consumed by AppRoot. */
    private val deepLink = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        deepLink.value = intent?.data?.host?.lowercase()
        setContent {
            MixbaseTheme {
                AppRoot(deepLink = deepLink)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        deepLink.value = intent.data?.host?.lowercase()
    }

    override fun onStart() {
        super.onStart()
        appContainer.player.connect()
    }

    /**
     * Returning to the foreground after a while: top up the access token if it
     * expired so the next request doesn't 401 and bounce the user to login.
     */
    override fun onResume() {
        super.onResume()
        lifecycleScope.launch { appContainer.session.ensureFreshToken() }
    }
}
