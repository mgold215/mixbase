package app.mixbase.android.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.appContainer
import app.mixbase.android.ui.components.BrandWordmark
import app.mixbase.android.ui.components.ErrorText
import app.mixbase.android.ui.components.MbTextField
import app.mixbase.android.ui.components.PrimaryButton
import app.mixbase.android.ui.theme.MbColors
import kotlinx.coroutines.launch

/** Shared dark backdrop with the teal radial glow behind the card. */
@Composable
private fun AuthBackdrop(content: @Composable ColumnScope.() -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0D0B08))
            .background(
                Brush.radialGradient(
                    colors = listOf(MbColors.Teal.copy(alpha = 0.10f), Color.Transparent),
                    radius = 900f,
                ),
            )
            .imePadding(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            BrandWordmark(size = 32)
            Text("ROUGH-TO-RELEASE", fontSize = 10.sp, letterSpacing = 3.sp, color = MbColors.Mint, fontWeight = FontWeight.Medium)
            Text("Track the evolution of your mixes", fontSize = 13.sp, color = Color(0xFF6B6050), modifier = Modifier.padding(top = 2.dp))
            Spacer(Modifier.height(32.dp))
            Column(
                modifier = Modifier
                    .widthIn(max = 420.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(MbColors.Surface)
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                content()
            }
        }
    }
}

@Composable
fun LoginScreen(onSignUp: () -> Unit) {
    val session = LocalContext.current.appContainer.session
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    fun submit() {
        if (email.isBlank() || password.isBlank()) { error = "Enter your email and password"; return }
        loading = true; error = null
        scope.launch {
            error = session.signIn(email, password)
            loading = false
        }
    }

    AuthBackdrop {
        Text("Sign in", color = MbColors.Text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        MbTextField(email, { email = it }, placeholder = "Email", keyboardType = KeyboardType.Email, enabled = !loading)
        MbTextField(password, { password = it }, placeholder = "Password", password = true, keyboardType = KeyboardType.Password, enabled = !loading)
        ErrorText(error)
        PrimaryButton("Sign In", onClick = ::submit, modifier = Modifier.fillMaxWidth(), loading = loading)
        TextButton(onClick = onSignUp, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("New here? Create an account", color = MbColors.Teal)
        }
    }
}

@Composable
fun SignUpScreen(onBackToLogin: () -> Unit) {
    val session = LocalContext.current.appContainer.session
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    fun submit() {
        val trimmed = email.trim()
        when {
            !trimmed.contains("@") || !trimmed.contains(".") -> error = "Enter a valid email address"
            password.length < 8 -> error = "Password must be at least 8 characters"
            password != confirm -> error = "Passwords don't match"
            else -> {
                loading = true; error = null
                scope.launch {
                    error = session.signUp(trimmed, password)
                    loading = false
                }
            }
        }
    }

    AuthBackdrop {
        Text("Create your account", color = MbColors.Text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text("mixBase is free. No plans, no purchases.", color = MbColors.TextMuted, fontSize = 12.sp)
        MbTextField(email, { email = it }, placeholder = "Email", keyboardType = KeyboardType.Email, enabled = !loading)
        MbTextField(password, { password = it }, placeholder = "Min. 8 characters", password = true, keyboardType = KeyboardType.Password, enabled = !loading)
        MbTextField(confirm, { confirm = it }, placeholder = "Confirm password", password = true, keyboardType = KeyboardType.Password, enabled = !loading)
        ErrorText(error)
        PrimaryButton("Create Account", onClick = ::submit, modifier = Modifier.fillMaxWidth(), loading = loading)
        TextButton(onClick = onBackToLogin, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("Already have an account? Sign in", color = MbColors.Teal)
        }
    }
}
