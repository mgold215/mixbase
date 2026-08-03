import SwiftUI
import AVFoundation
import UIKit

// MARK: - VisualizerVideoView
// The project's pinned visualizer (Spotify-Canvas-style loop) rendered as a
// muted, seamlessly looping video. Purely decorative: it runs while the song
// plays and freezes on pause — the same behavior as the web player and the
// public share page. It must never fight the audio engine, so the player here
// is muted, local-only (no AirPlay video takeover), and doesn't block display
// sleep the way real video playback does.
struct VisualizerVideoView: UIViewRepresentable {

    let url: URL
    let isPlaying: Bool

    func makeUIView(context: Context) -> VisualizerPlayerUIView {
        VisualizerPlayerUIView(url: url)
    }

    func updateUIView(_ view: VisualizerPlayerUIView, context: Context) {
        view.load(url: url)
        view.setPlaying(isPlaying)
    }
}

// MARK: - VisualizerPlayerUIView
// UIView whose backing layer is an AVPlayerLayer driving an AVQueuePlayer +
// AVPlayerLooper — the supported way to loop a short clip without a gap or
// flash at the seam. Distinct from LoopingPlayerUIView (VisualizerView.swift),
// whose loop is always-on for library previews: this one pauses/resumes in
// step with the song and survives backgrounding.
final class VisualizerPlayerUIView: UIView {

    private let player = AVQueuePlayer()
    private var looper: AVPlayerLooper?
    private var currentUrl: URL?

    // The state the UI last asked for. iOS pauses AVPlayerLayer-backed video
    // when the app leaves the foreground and does NOT resume it for us — the
    // audio keeps going, so on return the canvas would sit frozen without this.
    private var wantsPlaying = false

    override static var layerClass: AnyClass { AVPlayerLayer.self }
    private var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    init(url: URL) {
        super.init(frame: .zero)
        player.isMuted = true
        // Video "external playback" would hand the AirPlay route to this layer
        // (Apple-TV-style) and wrestle it away from the audio session — the same
        // reason AudioService turns it off on the audio player.
        player.allowsExternalPlayback = false
        player.preventsDisplaySleepDuringVideoPlayback = false
        playerLayer.player = player
        playerLayer.videoGravity = .resizeAspectFill
        load(url: url)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// Swap in a new clip. No-op when the URL is unchanged, so SwiftUI update
    /// passes (play/pause, unrelated state) never restart the loop.
    func load(url: URL) {
        guard url != currentUrl else { return }
        currentUrl = url
        looper?.disableLooping()
        player.removeAllItems()
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        if wantsPlaying { player.play() }
    }

    func setPlaying(_ playing: Bool) {
        wantsPlaying = playing
        if playing {
            player.play()
        } else {
            player.pause()
        }
    }

    @objc private func appDidBecomeActive() {
        if wantsPlaying { player.play() }
    }
}
