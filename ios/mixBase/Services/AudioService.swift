import Foundation
import AVFoundation
import MediaPlayer
import Combine

// MARK: - AudioService
// Handles all audio playback in the app. This is the "music player" engine.
// It's an ObservableObject so SwiftUI views automatically update when playback state changes.
// Uses AVPlayer (Apple's built-in audio/video player) under the hood.
//
// Playback *policy* (the queue, loop, shuffle, auto-advance) lives here — NOT in the
// player screen — so it keeps working on every tab and after track-end, exactly like the
// web PlayerContext. Previously next/prev/auto-advance lived in PlayerView, so playback
// stopped after one track unless that screen was open.

/// Repeat behaviour for the queue.
enum LoopMode {
    case off   // stop at the end of the queue
    case all   // wrap around to the start
    case one   // repeat the current track
}

/// A single entry in the playback queue — everything needed to start a track.
struct QueueItem: Identifiable {
    let projectId: UUID
    let version: Version
    let trackName: String
    let artworkUrl: String?

    var id: UUID { projectId }
}

class AudioService: ObservableObject {

    // The single shared instance used across the whole app
    static let shared = AudioService()

    // MARK: - Published Properties

    /// The audio player instance (nil when nothing is loaded)
    private var player: AVPlayer?

    /// Which version is currently loaded in the player
    @Published var currentVersion: Version?

    /// The name of the currently playing track (project title)
    @Published var currentTrackName: String?

    /// The artwork URL for the currently playing track
    @Published var currentArtworkUrl: String?

    /// The user's artist name — fetched once from profiles table
    var artistName: String = "mixBase"

    /// Whether the user intends playback right now (drives the play/pause icon).
    @Published var isPlaying: Bool = false

    /// True while the player is loading/stalling with intent to play — show a spinner
    /// instead of a fake "playing" state. Mirrors the web `buffering` flag.
    @Published var buffering: Bool = false

    /// Current playback position in seconds (e.g. 45.2 means 45 seconds in)
    @Published var currentTime: Double = 0

    /// Total length of the loaded audio in seconds
    @Published var duration: Double = 0

    // MARK: - Playback policy (shared across every screen)

    /// Ordered queue used by next/prev and auto-advance. The player screen pushes its
    /// filtered/sorted list here; falls back to a lazily-loaded "all tracks" list.
    @Published private(set) var queue: [QueueItem] = []

    /// Repeat mode. Owned here so it survives navigating away from the player screen.
    @Published var loopMode: LoopMode = .off

    /// Shuffle toggle. Owned here for the same reason.
    @Published var isShuffled: Bool = false

    /// Tracks user *intent* to play, independent of the live AVPlayer status (which can
    /// momentarily report paused/waiting during loads). Keeps isPlaying truthful without
    /// flickering during track changes.
    private var playIntent = false

    /// Guards against kicking off more than one lazy queue load at a time.
    private var loadingQueue = false

    // Stores the time-observer reference so we can clean it up later
    private var timeObserver: Any?

    // Long-lived subscriptions (audio session interruptions)
    private var cancellables = Set<AnyCancellable>()
    // Per-track subscriptions — cleared and rebuilt on every play() so they don't leak.
    private var playerCancellables = Set<AnyCancellable>()

    // Private init — only the shared instance should exist
    private init() {
        configureAudioSession()
        setupRemoteCommands()
    }

    // MARK: - Audio Session Configuration

    /// Tell iOS this app plays audio (not just UI sounds).
    func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
        } catch {
            print("AudioService: Failed to configure audio session: \(error)")
        }

        NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)
            .sink { [weak self] notification in
                self?.handleInterruption(notification)
            }
            .store(in: &cancellables)
    }

    // MARK: - Queue

    /// Replace the active queue (e.g. the player screen's filtered/sorted order).
    func setQueue(_ items: [QueueItem]) {
        queue = items
    }

    /// Convenience: play a queue item.
    func play(item: QueueItem) {
        play(version: item.version, trackName: item.trackName, artworkUrl: item.artworkUrl)
    }

    // MARK: - Playback Controls

    /// Load and play a specific version's audio file.
    func play(version: Version, trackName: String? = nil, artworkUrl: String? = nil) {
        guard let url = URL(string: version.audioUrl) else {
            print("AudioService: Invalid audio URL: \(version.audioUrl)")
            return
        }

        // Tear down the previous track's observers/subscriptions so they don't leak or
        // fire for the wrong item.
        removeTimeObserver()
        playerCancellables.removeAll()

        let playerItem = AVPlayerItem(url: url)
        let newPlayer = AVPlayer(playerItem: playerItem)
        // Let AVPlayer buffer/recover from stalls on its own instead of dying silently.
        newPlayer.automaticallyWaitsToMinimizeStalling = true
        player = newPlayer

        currentVersion = version
        if let trackName = trackName { currentTrackName = trackName }
        if let artworkUrl = artworkUrl { currentArtworkUrl = artworkUrl }

        // Reset progress for the new track.
        currentTime = 0
        duration = 0

        playIntent = true
        isPlaying = true
        buffering = true

        newPlayer.play()
        updateNowPlayingInfo()
        addTimeObserver()
        observePlayer(newPlayer, item: playerItem)

        // If playback started from a surface that never set a queue (Home, project detail),
        // load one in the background so skip + auto-advance work from any tab right away.
        if queue.isEmpty {
            Task { [weak self] in await self?.loadQueueIfNeeded() }
        }
    }

    /// Subscribe to the live player/item state so isPlaying + buffering reflect reality.
    private func observePlayer(_ player: AVPlayer, item: AVPlayerItem) {
        // timeControlStatus is the truthful "is sound coming out" signal.
        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard let self = self else { return }
                switch status {
                case .playing:
                    self.isPlaying = true
                    self.buffering = false
                case .waitingToPlayAtSpecifiedRate:
                    // Loading/stalling — buffering, not playing, but keep intent.
                    self.buffering = self.playIntent
                case .paused:
                    self.buffering = false
                    if !self.playIntent { self.isPlaying = false }
                @unknown default:
                    break
                }
                self.updateNowPlayingPlaybackRate()
            }
            .store(in: &playerCancellables)

        // Surface load/decode failures instead of pretending to play.
        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard let self = self else { return }
                if status == .failed {
                    print("AudioService: item failed — \(item.error?.localizedDescription ?? "unknown")")
                    self.playIntent = false
                    self.isPlaying = false
                    self.buffering = false
                }
            }
            .store(in: &playerCancellables)

        // Update duration once it's known.
        item.publisher(for: \.duration)
            .compactMap { duration -> Double? in
                let seconds = CMTimeGetSeconds(duration)
                return seconds.isNaN ? nil : seconds
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] seconds in
                self?.duration = seconds
                self?.updateNowPlayingInfo()
            }
            .store(in: &playerCancellables)

        // Auto-advance / loop when the track finishes — works on EVERY tab now.
        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.handleTrackEnd()
            }
            .store(in: &playerCancellables)
    }

    /// Pause playback
    func pause() {
        playIntent = false
        player?.pause()
        isPlaying = false
        buffering = false
        updateNowPlayingInfo()
    }

    /// Resume playback from where it was paused
    func resume() {
        guard player != nil else { return }
        playIntent = true
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
            self?.currentTime = time
        }
    }

    // MARK: - Transport (queue-aware, shared across screens)

    /// The queue in the order playback should follow.
    private func orderedQueue() -> [QueueItem] { queue }

    /// Skip to the next track in the queue (honours shuffle + loop).
    func next() {
        let list = orderedQueue()
        guard !list.isEmpty else { return }
        guard let curPid = currentVersion?.projectId,
              let idx = list.firstIndex(where: { $0.projectId == curPid }) else {
            play(item: list[0]); return
        }
        if isShuffled && list.count > 1 {
            var target = list[Int.random(in: 0..<list.count)]
            while target.projectId == curPid { target = list[Int.random(in: 0..<list.count)] }
            play(item: target)
        } else {
            play(item: list[(idx + 1) % list.count])
        }
    }

    /// Skip to the previous track. First 3s restarts the current track (standard transport).
    func prev() {
        if currentTime > 3, currentVersion != nil {
            seek(to: 0)
            return
        }
        let list = orderedQueue()
        guard !list.isEmpty else { return }
        let curPid = currentVersion?.projectId
        let idx = curPid.flatMap { pid in list.firstIndex(where: { $0.projectId == pid }) } ?? 0
        play(item: list[(idx - 1 + list.count) % list.count])
    }

    /// Called when a track finishes. Auto-advances / loops so playback is seamless even
    /// when the player screen isn't mounted.
    private func handleTrackEnd() {
        if loopMode == .one {
            seek(to: 0)
            resume()
            return
        }

        // If we don't have a queue yet (e.g. playback started from Home), load one first
        // so the track still auto-advances.
        if queue.isEmpty {
            Task { [weak self] in
                await self?.loadQueueIfNeeded()
                await MainActor.run { self?.advanceToNext() }
            }
        } else {
            advanceToNext()
        }
    }

    /// Move to the next queue item at end-of-track, honouring loop/shuffle, or stop if
    /// we're at the end of a non-looping queue.
    private func advanceToNext() {
        let list = orderedQueue()
        guard let curPid = currentVersion?.projectId,
              let idx = list.firstIndex(where: { $0.projectId == curPid }) else {
            stopPlayback(); return
        }
        let isLast = idx == list.count - 1
        if loopMode == .off && isLast && !isShuffled {
            stopPlayback(); return
        }
        next()
    }

    /// Stop and reset transport state at the end of a queue.
    private func stopPlayback() {
        playIntent = false
        isPlaying = false
        buffering = false
        currentTime = 0
        updateNowPlayingInfo()
    }

    /// Lazily populate the queue with every project's latest version, in case playback
    /// started from a surface that never set a queue. No-op if already populated.
    @MainActor
    func loadQueueIfNeeded() async {
        guard queue.isEmpty, !loadingQueue else { return }
        loadingQueue = true
        defer { loadingQueue = false }
        do {
            let projects = try await SupabaseService.shared.fetchProjects()
            var items: [QueueItem] = []
            for project in projects {
                let versions = try await SupabaseService.shared.fetchVersions(projectId: project.id)
                if let latest = versions.max(by: { $0.versionNumber < $1.versionNumber }) {
                    items.append(QueueItem(
                        projectId: project.id,
                        version: latest,
                        trackName: project.title,
                        artworkUrl: project.artworkUrl
                    ))
                }
            }
            if queue.isEmpty { queue = items }
        } catch {
            print("AudioService: Failed to load queue — \(error.localizedDescription)")
        }
    }

    // MARK: - Lock Screen / Control Center / Bluetooth AVRCP

    private func updateNowPlayingInfo() {
        var info = [String: Any]()

        info[MPMediaItemPropertyTitle] = currentTrackName ?? "mixBase"
        info[MPMediaItemPropertyArtist] = artistName.isEmpty ? "mixBase" : artistName

        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if let urlString = currentArtworkUrl, let url = URL(string: urlString) {
            fetchArtwork(from: url)
        }
    }

    /// Lightweight update of just the playback rate (used by the status observer).
    private func updateNowPlayingPlaybackRate() {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

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

        commandCenter.playCommand.isEnabled = true
        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.resume()
            return .success
        }

        commandCenter.pauseCommand.isEnabled = true
        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }

        commandCenter.togglePlayPauseCommand.isEnabled = true
        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.togglePlayPause()
            return .success
        }

        // Lock-screen / Bluetooth next & previous now drive the shared queue.
        commandCenter.nextTrackCommand.isEnabled = true
        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.next()
            return .success
        }

        commandCenter.previousTrackCommand.isEnabled = true
        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            self?.prev()
            return .success
        }

        commandCenter.changePlaybackPositionCommand.isEnabled = true
        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            if let event = event as? MPChangePlaybackPositionCommandEvent {
                self?.seek(to: event.positionTime)
            }
            return .success
        }
    }

    // MARK: - Time Observer

    private func addTimeObserver() {
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player?.addPeriodicTimeObserver(
            forInterval: interval,
            queue: .main
        ) { [weak self] time in
            guard let self = self else { return }
            let seconds = CMTimeGetSeconds(time)
            if !seconds.isNaN {
                self.currentTime = seconds
                // Safety net: if time is advancing, sound is coming out — clear any stale
                // buffering flag so the UI can't be stuck on a spinner while audio plays.
                if seconds > 0 { self.buffering = false }
                var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = seconds
                nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = self.isPlaying ? 1.0 : 0.0
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
            }
        }
    }

    private func removeTimeObserver() {
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }
    }

    // MARK: - Interruption Handling

    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else { return }

        switch type {
        case .began:
            pause()

        case .ended:
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
