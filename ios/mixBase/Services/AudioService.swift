import Foundation
import AVFoundation
import MediaPlayer
import Combine

// MARK: - AudioService
// Handles all audio playback in the app. This is the "music player" engine.
// It's an ObservableObject so SwiftUI views automatically update when playback state changes.
// Uses AVPlayer (Apple's built-in audio/video player) under the hood.

class AudioService: ObservableObject {

    // The single shared instance used across the whole app
    static let shared = AudioService()

    // MARK: - Published Properties
    // "@Published" means SwiftUI views that use these values will
    // automatically refresh whenever they change.

    /// The audio player instance (nil when nothing is loaded)
    private var player: AVPlayer?

    /// Which version is currently loaded in the player
    @Published var currentVersion: Version?

    /// The name of the currently playing track (project title)
    @Published var currentTrackName: String?

    /// The artwork URL for the currently playing track
    @Published var currentArtworkUrl: String?

    /// Whether audio is actively playing right now
    @Published var isPlaying: Bool = false

    /// Current playback position in seconds (e.g. 45.2 means 45 seconds in)
    @Published var currentTime: Double = 0

    /// Total length of the loaded audio in seconds
    @Published var duration: Double = 0

    // Stores the time-observer reference so we can clean it up later
    private var timeObserver: Any?

    // Stores Combine subscriptions so they don't get deallocated
    private var cancellables = Set<AnyCancellable>()

    // Private init — only the shared instance should exist
    private init() {
        // Set up the audio session so sound plays through the speaker
        // and continues when the app is in the background
        configureAudioSession()

        // Set up lock screen controls (play/pause/skip buttons)
        setupRemoteCommands()
    }

    // MARK: - Audio Session Configuration

    /// Tell iOS this app plays audio (not just UI sounds).
    /// This lets audio keep playing when the phone is locked or the app is backgrounded.
    func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            // ".playback" category = this app plays music
            try session.setCategory(.playback, mode: .default)
            // Activate the session so the system knows we're ready
            try session.setActive(true)
        } catch {
            print("AudioService: Failed to configure audio session: \(error)")
        }

        // Listen for interruptions (e.g. phone calls) so we can pause gracefully
        NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)
            .sink { [weak self] notification in
                self?.handleInterruption(notification)
            }
            .store(in: &cancellables)
    }

    // MARK: - Playback Controls

    /// Load and play a specific version's audio file
    /// - Parameters:
    ///   - version: The version to play
    ///   - trackName: The project title (shown on lock screen and mini player)
    ///   - artworkUrl: The project's artwork URL (shown on player and mini player)
    func play(version: Version, trackName: String? = nil, artworkUrl: String? = nil) {
        // If a URL can't be created from the audio_url string, bail out
        guard let url = URL(string: version.audioUrl) else {
            print("AudioService: Invalid audio URL: \(version.audioUrl)")
            return
        }

        // Remove any existing time observer before creating a new player
        removeTimeObserver()

        // Create a new player item and player
        let playerItem = AVPlayerItem(url: url)
        player = AVPlayer(playerItem: playerItem)

        // Save which version is playing and its context
        currentVersion = version
        if let trackName = trackName { currentTrackName = trackName }
        if let artworkUrl = artworkUrl { currentArtworkUrl = artworkUrl }

        // Start playback
        player?.play()
        isPlaying = true

        // Push metadata to Control Center / Bluetooth AVRCP immediately
        updateNowPlayingInfo()

        // Set up a periodic observer that fires ~2 times per second
        // to update the currentTime property (which drives the seek bar UI)
        addTimeObserver()

        // Watch for when the track reaches the end
        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: playerItem)
            .sink { [weak self] _ in
                // When the track ends, reset state
                self?.isPlaying = false
                self?.currentTime = 0
            }
            .store(in: &cancellables)

        // Observe the player item's duration once it's loaded — update Now Playing when we have it
        playerItem.publisher(for: \.duration)
            .compactMap { duration -> Double? in
                // Convert CMTime to seconds; ignore if not a valid number
                let seconds = CMTimeGetSeconds(duration)
                return seconds.isNaN ? nil : seconds
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] seconds in
                self?.duration = seconds
                self?.updateNowPlayingInfo()
            }
            .store(in: &cancellables)
    }

    /// Pause playback
    func pause() {
        player?.pause()
        isPlaying = false
        updateNowPlayingInfo()
    }

    /// Resume playback from where it was paused
    func resume() {
        player?.play()
        isPlaying = true
        updateNowPlayingInfo()
    }

    /// Toggle between playing and paused
    func togglePlayPause() {
        if isPlaying {
            pause()
        } else {
            resume()
        }
    }

    /// Jump to a specific time in the track (in seconds)
    func seek(to time: Double) {
        let cmTime = CMTime(seconds: time, preferredTimescale: 600)
        player?.seek(to: cmTime) { [weak self] _ in
            // Update currentTime immediately after the seek completes
            self?.currentTime = time
        }
    }

    /// Skip to the next version in a list of versions
    func playNextVersion(in versions: [Version]) {
        guard let current = currentVersion else { return }

        // Find where the current version is in the list
        guard let currentIndex = versions.firstIndex(where: { $0.id == current.id }) else { return }

        // If there's a next one, play it
        let nextIndex = currentIndex + 1
        if nextIndex < versions.count {
            play(version: versions[nextIndex])
        }
    }

    /// Skip to the previous version in a list of versions
    func playPreviousVersion(in versions: [Version]) {
        guard let current = currentVersion else { return }

        // Find where the current version is in the list
        guard let currentIndex = versions.firstIndex(where: { $0.id == current.id }) else { return }

        // If there's a previous one, play it
        let previousIndex = currentIndex - 1
        if previousIndex >= 0 {
            play(version: versions[previousIndex])
        }
    }

    // MARK: - Lock Screen / Control Center / Bluetooth AVRCP

    /// Refresh MPNowPlayingInfoCenter with current track metadata.
    /// Called on play, pause, resume, and when duration loads.
    private func updateNowPlayingInfo() {
        var info = [String: Any]()

        info[MPMediaItemPropertyTitle] = currentTrackName ?? "mixBase"
        info[MPMediaItemPropertyArtist] = "mixBase"
        info[MPMediaItemPropertyAlbumTitle] = "mixBase"

        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        // Fetch artwork asynchronously and slot it in when ready
        if let urlString = currentArtworkUrl, let url = URL(string: urlString) {
            fetchArtwork(from: url)
        }
    }

    /// Download the artwork image and add it to the active Now Playing info
    private func fetchArtwork(from url: URL) {
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard self != nil else { return }
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                nowPlayingInfo[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
            }
        }.resume()
    }

    /// Register handlers for the lock screen play/pause/skip buttons
    func setupRemoteCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()

        // Play button
        commandCenter.playCommand.isEnabled = true
        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.resume()
            return .success
        }

        // Pause button
        commandCenter.pauseCommand.isEnabled = true
        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }

        // Toggle play/pause (headphone button tap)
        commandCenter.togglePlayPauseCommand.isEnabled = true
        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.togglePlayPause()
            return .success
        }

        // Scrubbing / seeking via the lock screen progress bar
        commandCenter.changePlaybackPositionCommand.isEnabled = true
        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            if let event = event as? MPChangePlaybackPositionCommandEvent {
                self?.seek(to: event.positionTime)
            }
            return .success
        }
    }

    // MARK: - Time Observer

    /// Add a periodic observer that updates currentTime roughly every 0.5 seconds
    private func addTimeObserver() {
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player?.addPeriodicTimeObserver(
            forInterval: interval,
            queue: .main
        ) { [weak self] time in
            let seconds = CMTimeGetSeconds(time)
            if !seconds.isNaN {
                self?.currentTime = seconds
                // Keep Now Playing position current so Tesla / Control Center scrubber is accurate
                var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = seconds
                nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
            }
        }
    }

    /// Remove the time observer (called before creating a new player)
    private func removeTimeObserver() {
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }
    }

    // MARK: - Interruption Handling

    /// Called when something interrupts audio (e.g. a phone call comes in)
    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else { return }

        switch type {
        case .began:
            // Something interrupted us — pause playback
            pause()

        case .ended:
            // Interruption is over — check if we should resume
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    resume()
                }
            }

        @unknown default:
            break
        }
    }

    // MARK: - Cleanup

    deinit {
        removeTimeObserver()
    }
}
