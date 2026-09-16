package app.mixbase.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mixbase.android.appContainer
import app.mixbase.android.ui.components.CardRow
import app.mixbase.android.ui.components.ErrorText
import app.mixbase.android.ui.components.MbTextField
import app.mixbase.android.ui.components.MbTopBar
import app.mixbase.android.ui.components.MutedText
import app.mixbase.android.ui.components.PrimaryButton
import app.mixbase.android.ui.components.TealLabel
import app.mixbase.android.ui.theme.MbColors
import app.mixbase.core.displayMessage
import kotlinx.coroutines.launch

/** Account, artist name, native legal docs, sign out, account deletion. Mirrors ios/…/SettingsView.swift. */
@Composable
fun SettingsScreen(onBack: () -> Unit, onOpenLegal: (String) -> Unit) {
    val container = LocalContext.current.appContainer
    val auth by container.session.state.collectAsState()
    val scope = rememberCoroutineScope()

    var artistName by remember { mutableStateOf("") }
    var savedArtistName by remember { mutableStateOf("") }
    var savingArtist by remember { mutableStateOf(false) }
    var artistError by remember { mutableStateOf<String?>(null) }

    var showDelete by remember { mutableStateOf(false) }
    var deleteText by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf(false) }
    var deleteError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(auth.userId) {
        val uid = auth.userId ?: return@LaunchedEffect
        val name = container.supabase.fetchArtistName(uid)
        savedArtistName = name
        if (artistName.isEmpty()) artistName = name
    }

    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar("Settings", onBack = onBack)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            TealLabel("Account")
            CardRow {
                Text("Email", color = MbColors.Text)
                Spacer(Modifier.weight(1f))
                MutedText(auth.email ?: "—")
            }

            Spacer(Modifier.size(8.dp))
            TealLabel("Artist")
            MbTextField(artistName, { artistName = it; artistError = null }, placeholder = "Your artist name")
            ErrorText(artistError)
            Row {
                PrimaryButton(
                    if (artistName.trim() == savedArtistName && savedArtistName.isNotEmpty()) "Saved" else "Save",
                    enabled = artistName.trim() != savedArtistName,
                    loading = savingArtist,
                    onClick = {
                        val uid = auth.userId
                        val trimmed = artistName.trim()
                        if (uid != null) {
                            savingArtist = true
                            scope.launch {
                                try {
                                    container.supabase.updateArtistName(uid, trimmed)
                                    savedArtistName = trimmed
                                    artistName = trimmed
                                    container.player.artistName = trimmed
                                } catch (e: Exception) { artistError = e.displayMessage }
                                savingArtist = false
                            }
                        }
                    },
                )
            }
            MutedText("Shown as the artist on the lock screen, car displays, and your share pages.", size = 12)

            Spacer(Modifier.size(8.dp))
            TealLabel("Legal")
            LegalContent.docs.forEach { (key, doc) ->
                CardRow(onClick = { onOpenLegal(key) }) {
                    Text(doc.title, color = MbColors.Text)
                    Spacer(Modifier.weight(1f))
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MbColors.TextMuted)
                }
            }

            Spacer(Modifier.size(8.dp))
            TealLabel("About")
            CardRow {
                Text("App", color = MbColors.Text)
                Spacer(Modifier.weight(1f))
                Text("mixBase for Android", color = MbColors.Teal, fontWeight = FontWeight.SemiBold)
            }
            CardRow {
                Text("Version", color = MbColors.Text)
                Spacer(Modifier.weight(1f))
                MutedText("1.0.0")
            }
            MutedText("mixBase is free. There are no plans, subscriptions or purchases.", size = 12)

            Spacer(Modifier.size(8.dp))
            TextButton(onClick = { container.signOut() }) { Text("Sign Out", color = MbColors.Teal) }

            Spacer(Modifier.size(16.dp))
            Text("Danger Zone", color = MbColors.Red, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            if (!showDelete) {
                TextButton(onClick = { showDelete = true }) { Text("Delete Account", color = MbColors.Red) }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MutedText("This will permanently delete your account and all your data. This cannot be undone.", size = 12)
                    Text("Type DELETE to confirm:", color = MbColors.Text, fontSize = 12.sp)
                    MbTextField(deleteText, { deleteText = it }, placeholder = "DELETE", enabled = !deleting)
                    ErrorText(deleteError)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            enabled = deleteText == "DELETE" && !deleting,
                            onClick = {
                                deleting = true; deleteError = null
                                scope.launch {
                                    try {
                                        container.api.deleteAccount()
                                        container.signOut()
                                    } catch (e: Exception) {
                                        deleteError = e.displayMessage
                                        deleting = false
                                    }
                                }
                            },
                        ) { Text(if (deleting) "Deleting…" else "Permanently Delete", color = if (deleteText == "DELETE") MbColors.Red else MbColors.TextMuted) }
                        TextButton(onClick = { showDelete = false; deleteText = ""; deleteError = null }) { Text("Cancel", color = MbColors.TextMuted) }
                    }
                }
            }
            MutedText("Deleting your account removes all projects, mixes, collections, and releases.", size = 12)
            Spacer(Modifier.size(24.dp))
        }
    }
}

/** Renders one legal document natively — no links leave the app. */
@Composable
fun LegalScreen(doc: String, onBack: () -> Unit) {
    val document = LegalContent.docs[doc] ?: LegalContent.docs.getValue("support")
    Column(Modifier.fillMaxSize().background(MbColors.Background)) {
        MbTopBar(document.title, onBack = onBack)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            document.updated?.let { MutedText("Last updated: $it", size = 12) }
            document.sections.forEach { section ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(section.heading, color = MbColors.Teal, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    Text(section.body, color = MbColors.TextBody, fontSize = 13.sp, modifier = Modifier.fillMaxWidth())
                }
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}
