import AppIntents

// MARK: - PlayPauseWidgetIntent
// The interactive play/pause button on the Now Playing widget. Because this
// conforms to AudioPlaybackIntent AND is compiled into both the app and the
// widget extension, the system executes it in the APP's process (launching it
// in the background if needed) — that's what lets a widget button control the
// AVPlayer without foregrounding the app.
//
// The widget target doesn't compile AudioService, so the intent body calls a
// hook that only the app installs (mixBaseApp.init). In the widget's copy the
// hook stays nil and perform() is a no-op — which is fine, it never runs there.

struct PlayPauseWidgetIntent: AudioPlaybackIntent {

    static let title: LocalizedStringResource = "Play or Pause"
    static let description = IntentDescription("Plays or pauses the current mix in mixBASE.")

    /// Installed by the app at launch; nil in the widget process.
    static var performer: (@MainActor () -> Void)?

    @MainActor
    func perform() async throws -> some IntentResult {
        Self.performer?()
        return .result()
    }
}
