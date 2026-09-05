import WidgetKit
import SwiftUI
import UIKit

// MARK: - Now Playing widget
// Shows the track currently (or last) playing in mixBASE: artwork, title, mix
// name and play state. Home Screen small/medium plus Lock Screen accessories.
// The play/pause button is a real control — PlayPauseWidgetIntent executes in
// the app's process (AudioPlaybackIntent), so audio toggles without opening
// the app. Tapping anywhere else deep-links to the Player tab.

struct NowPlayingEntry: TimelineEntry {
    let date: Date
    let snapshot: NowPlayingSnapshot?
    let artworkImage: UIImage?
}

struct NowPlayingProvider: TimelineProvider {

    func placeholder(in context: Context) -> NowPlayingEntry {
        NowPlayingEntry(date: Date(), snapshot: .sample, artworkImage: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (NowPlayingEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NowPlayingEntry>) -> Void) {
        // One entry, no schedule: the app reloads this timeline whenever
        // playback state changes, so there's nothing to predict here.
        completion(Timeline(entries: [currentEntry()], policy: .never))
    }

    private func currentEntry() -> NowPlayingEntry {
        let snapshot = NowPlayingStore.loadNowPlaying()
        var image: UIImage?
        if let urlString = snapshot?.artworkUrl,
           let data = NowPlayingStore.loadArtworkData(matching: urlString) {
            image = UIImage(data: data)
        }
        return NowPlayingEntry(date: Date(), snapshot: snapshot, artworkImage: image)
    }
}

extension NowPlayingSnapshot {
    static let sample = NowPlayingSnapshot(
        trackName: "Track Title",
        versionName: "MIX 1",
        artistName: nil,
        artworkUrl: nil,
        projectId: nil,
        isPlaying: true,
        updatedAt: Date()
    )
}

struct NowPlayingWidget: Widget {

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: NowPlayingStore.nowPlayingWidgetKind, provider: NowPlayingProvider()) { entry in
            NowPlayingWidgetView(entry: entry)
        }
        .configurationDisplayName("Now Playing")
        .description("The mix you're listening to in mixBASE, with play/pause.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
        .contentMarginsDisabled()
    }
}

// MARK: - Views

struct NowPlayingWidgetView: View {

    @Environment(\.widgetFamily) private var family

    let entry: NowPlayingEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                circularView
            case .accessoryRectangular:
                rectangularView
            case .systemMedium:
                mediumView
            default:
                smallView
            }
        }
        .widgetURL(URL(string: "mixbase://player"))
    }

    private var isPlaying: Bool { entry.snapshot?.isPlaying == true }

    // MARK: Home Screen — small (full-bleed artwork)

    private var smallView: some View {
        ZStack(alignment: .bottom) {
            if let snapshot = entry.snapshot {
                VStack(alignment: .leading, spacing: 2) {
                    Spacer()
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(isPlaying ? "NOW PLAYING" : "PAUSED")
                                .font(.system(size: 9, weight: .bold))
                                .tracking(0.8)
                                .foregroundColor(MBTheme.teal)
                            Text(snapshot.trackName)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(MBTheme.text)
                                .lineLimit(2)
                            if let version = snapshot.versionName {
                                Text(version)
                                    .font(.system(size: 10))
                                    .foregroundColor(MBTheme.text.opacity(0.7))
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 6)
                        playPauseButton(diameter: 30)
                    }
                }
                .padding(12)
            } else {
                emptyState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(for: .widget) { artworkBackground }
    }

    // MARK: Home Screen — medium (artwork card + details)

    private var mediumView: some View {
        Group {
            if let snapshot = entry.snapshot {
                HStack(spacing: 14) {
                    artworkThumb(side: 92, cornerRadius: 12)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(isPlaying ? "NOW PLAYING" : "PAUSED")
                            .font(.system(size: 10, weight: .bold))
                            .tracking(1)
                            .foregroundColor(MBTheme.teal)
                        Text(snapshot.trackName)
                            .font(.system(size: 17, weight: .bold))
                            .foregroundColor(MBTheme.text)
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            if let version = snapshot.versionName {
                                Text(version)
                            }
                            if let artist = snapshot.artistName {
                                Text("·")
                                Text(artist)
                            }
                        }
                        .font(.system(size: 11))
                        .foregroundColor(MBTheme.text.opacity(0.6))
                        .lineLimit(1)
                    }

                    Spacer(minLength: 8)

                    playPauseButton(diameter: 44)
                }
                .padding(16)
            } else {
                emptyState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(for: .widget) { MBTheme.background }
    }

    // MARK: Lock Screen accessories

    private var circularView: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(systemName: entry.snapshot == nil ? "music.note" : (isPlaying ? "waveform" : "play.fill"))
                .font(.system(size: 20, weight: .semibold))
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private var rectangularView: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let snapshot = entry.snapshot {
                Text(isPlaying ? "NOW PLAYING" : "PAUSED")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.8)
                Text(snapshot.trackName)
                    .font(.headline)
                    .lineLimit(1)
                if let version = snapshot.versionName {
                    Text(version)
                        .font(.caption2)
                        .opacity(0.7)
                        .lineLimit(1)
                }
            } else {
                Text("mixBASE")
                    .font(.headline)
                Text("Nothing playing")
                    .font(.caption2)
                    .opacity(0.7)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }

    // MARK: Pieces

    private func playPauseButton(diameter: CGFloat) -> some View {
        Button(intent: PlayPauseWidgetIntent()) {
            ZStack {
                Circle().fill(MBTheme.teal)
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: diameter * 0.4, weight: .bold))
                    .foregroundColor(.black)
            }
            .frame(width: diameter, height: diameter)
        }
        .buttonStyle(.plain)
    }

    private var artworkBackground: some View {
        ZStack {
            MBTheme.background
            if let image = entry.artworkImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                LinearGradient(
                    colors: [.black.opacity(0.05), .black.opacity(0.8)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
        }
    }

    private func artworkThumb(side: CGFloat, cornerRadius: CGFloat) -> some View {
        Group {
            if let image = entry.artworkImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    LinearGradient(
                        colors: [Color(red: 26 / 255, green: 26 / 255, blue: 26 / 255), MBTheme.card],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    Image(systemName: "music.note")
                        .font(.title2)
                        .foregroundColor(.gray.opacity(0.4))
                }
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            MBWordmark(size: 15)
            Text("Nothing playing")
                .font(.system(size: 11))
                .foregroundColor(MBTheme.text.opacity(0.5))
            Image(systemName: "play.circle")
                .font(.title3)
                .foregroundColor(MBTheme.teal)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(12)
    }
}
