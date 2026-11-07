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

// MARK: - PlayRecentUploadIntent
// The play/pause button on each row of the Recent Uploads widget. Same trick
// as PlayPauseWidgetIntent: an AudioPlaybackIntent compiled into both targets
// runs in the APP's process, so the mix starts without opening mixBASE. The
// row's ids travel as strings (AppIntent parameters); the app-installed hook
// fetches the mix and plays it — or toggles it when it's already the one up.

struct PlayRecentUploadIntent: AudioPlaybackIntent {

    static let title: LocalizedStringResource = "Play Recent Upload"
    static let description = IntentDescription("Plays one of your recent uploads in mixBase.")
    static let isDiscoverable = false

    @Parameter(title: "Project ID")
    var projectId: String

    @Parameter(title: "Mix ID")
    var versionId: String

    init() {}

    init(projectId: UUID, versionId: UUID) {
        self.projectId = projectId.uuidString
        self.versionId = versionId.uuidString
    }

    /// Installed by the app at launch; nil in the widget process.
    static var performer: (@MainActor (_ projectId: UUID, _ versionId: UUID) async -> Void)?

    @MainActor
    func perform() async throws -> some IntentResult {
        if let project = UUID(uuidString: projectId), let version = UUID(uuidString: versionId) {
            await Self.performer?(project, version)
        }
        return .result()
    }
}
