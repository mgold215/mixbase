import WidgetKit
import SwiftUI
import UIKit

// MARK: - Recent Uploads widget
// Your three newest uploads (each song's newest mix), each with a play/pause
// button, plus "Mix Note" to jot a note on a mix. Replaced the Studio Stats
// counters (2026-11-07) but keeps that widget's kind, so a widget already on
// the Home Screen turns into this one in place.
//
// Rows come from the snapshot HomeView writes after each dashboard load, the
// covers from thumbnails it caches in the App Group — the widget itself never
// talks to Supabase. Play buttons run PlayRecentUploadIntent in the APP's
// process (AudioPlaybackIntent), so music starts without opening mixBASE.
// A widget can't take typed text, so "Mix Note" deep-links into the app's
// notes sheet for that mix (mixbase://mix-note, routed by ContentView).

struct RecentUploadsEntry: TimelineEntry {
    let date: Date
    /// nil = the app hasn't written a snapshot yet (never opened / signed out).
    let uploads: [RecentUpload]?
    let covers: [UUID: UIImage]
    /// The mix playing right now, if any — that row shows a pause button.
    let playingVersionId: UUID?
}

struct RecentUploadsProvider: TimelineProvider {

    func placeholder(in context: Context) -> RecentUploadsEntry {
        let now = Date()
        let sample = [
            RecentUpload(projectId: UUID(), versionId: UUID(), title: "Track Title", versionName: "MIX 3", uploadedAt: now.addingTimeInterval(-3_600), artworkUrl: nil),
            RecentUpload(projectId: UUID(), versionId: UUID(), title: "Another Song", versionName: "MASTER 1", uploadedAt: now.addingTimeInterval(-86_400), artworkUrl: nil),
            RecentUpload(projectId: UUID(), versionId: UUID(), title: "Demo Idea", versionName: "MIX 1", uploadedAt: now.addingTimeInterval(-3 * 86_400), artworkUrl: nil),
        ]
        return RecentUploadsEntry(date: now, uploads: sample, covers: [:], playingVersionId: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (RecentUploadsEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RecentUploadsEntry>) -> Void) {
        // The app reloads this whenever uploads or playback change; the hourly
        // refresh only keeps the "2h ago" labels honest.
        completion(Timeline(entries: [currentEntry()], policy: .after(Date().addingTimeInterval(3_600))))
    }

    private func currentEntry() -> RecentUploadsEntry {
        let uploads = NowPlayingStore.loadRecentUploads()?.uploads
        var covers: [UUID: UIImage] = [:]
        for (slot, upload) in (uploads ?? []).enumerated() {
            if let url = upload.artworkUrl,
               let data = NowPlayingStore.loadRecentArtworkData(slot: slot, matching: url),
               let image = UIImage(data: data) {
                covers[upload.versionId] = image
            }
        }
        let nowPlaying = NowPlayingStore.loadNowPlaying()
        return RecentUploadsEntry(
            date: Date(),
            uploads: uploads,
            covers: covers,
            playingVersionId: nowPlaying?.isPlaying == true ? nowPlaying?.versionId : nil
        )
    }
}

struct RecentUploadsWidget: Widget {

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: NowPlayingStore.recentUploadsWidgetKind, provider: RecentUploadsProvider()) { entry in
            RecentUploadsWidgetView(entry: entry)
        }
        .configurationDisplayName("Recent Uploads")
        .description("Play your newest uploads and add a mix note.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Views

struct RecentUploadsWidgetView: View {

    @Environment(\.widgetFamily) private var family

    let entry: RecentUploadsEntry

    var body: some View {
        Group {
            switch family {
            case .systemLarge:
                largeView
            case .systemMedium:
                mediumView
            default:
                smallView
            }
        }
        .containerBackground(for: .widget) { MBTheme.background }
        .widgetURL(widgetTapURL)
    }

    /// Small widgets can't hold Links (only Buttons), so tapping the small
    /// size anywhere but its play button opens a note on its upload. The
    /// larger sizes have real note buttons and open the Player on a tap.
    private var widgetTapURL: URL? {
        if family == .systemSmall, let upload = uploads.first {
            return mixNoteURL(for: upload)
        }
        return URL(string: "mixbase://player")
    }

    private var uploads: [RecentUpload] { entry.uploads ?? [] }

    // MARK: Small — the newest upload

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                MBWordmark(size: 13)
                Spacer()
                // A label, not a Link — the whole small widget is the tap.
                if !uploads.isEmpty { mixNoteLabel(compact: true) }
            }
            Spacer(minLength: 6)
            if let upload = uploads.first {
                cover(for: upload, side: 44, cornerRadius: 8)
                Spacer(minLength: 6)
                HStack(alignment: .bottom, spacing: 6) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(upload.title)
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(MBTheme.text)
                            .lineLimit(1)
                        Text(subtitle(for: upload))
                            .font(.system(size: 10))
                            .foregroundColor(MBTheme.text.opacity(0.55))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    playButton(for: upload, diameter: 30)
                }
            } else {
                emptyHint
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    // MARK: Medium — three compact rows

    private var mediumView: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                MBWordmark(size: 14)
                Spacer()
                mixNotePill(compact: false)
            }
            if uploads.isEmpty {
                emptyHint
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 4) {
                    ForEach(uploads, id: \.versionId) { upload in
                        row(upload, coverSide: 30, playDiameter: 28, showsNoteButton: false)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    // MARK: Large — roomier rows, each with its own note button

    private var largeView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                MBWordmark(size: 16)
                Spacer()
                mixNotePill(compact: false)
            }

            Text("RECENT UPLOADS")
                .font(.system(size: 10, weight: .bold))
                .tracking(1)
                .foregroundColor(MBTheme.text.opacity(0.4))

            if uploads.isEmpty {
                emptyHint
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
            } else {
                VStack(spacing: 10) {
                    ForEach(uploads, id: \.versionId) { upload in
                        row(upload, coverSide: 54, playDiameter: 38, showsNoteButton: true)
                            .padding(8)
                            .background(MBTheme.card)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    // MARK: Pieces

    private func row(_ upload: RecentUpload, coverSide: CGFloat, playDiameter: CGFloat, showsNoteButton: Bool) -> some View {
        let large = coverSide > 40
        return HStack(spacing: large ? 12 : 10) {
            cover(for: upload, side: coverSide, cornerRadius: large ? 8 : 6)
            VStack(alignment: .leading, spacing: large ? 3 : 1) {
                Text(upload.title)
                    .font(.system(size: large ? 15 : 13, weight: .semibold))
                    .foregroundColor(isPlaying(upload) ? MBTheme.teal : MBTheme.text)
                    .lineLimit(1)
                Text(subtitle(for: upload))
                    .font(.system(size: large ? 11 : 10))
                    .foregroundColor(MBTheme.text.opacity(0.55))
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if showsNoteButton {
                noteButton(for: upload, diameter: playDiameter)
            }
            playButton(for: upload, diameter: playDiameter)
        }
    }

    private func isPlaying(_ upload: RecentUpload) -> Bool {
        entry.playingVersionId == upload.versionId
    }

    private func playButton(for upload: RecentUpload, diameter: CGFloat) -> some View {
        Button(intent: PlayRecentUploadIntent(projectId: upload.projectId, versionId: upload.versionId)) {
            ZStack {
                Circle().fill(MBTheme.teal)
                Image(systemName: isPlaying(upload) ? "pause.fill" : "play.fill")
                    .font(.system(size: diameter * 0.38, weight: .bold))
                    .foregroundColor(.black)
                    // play.fill looks off-centre in a circle; nudge it right.
                    .offset(x: isPlaying(upload) ? 0 : diameter * 0.04)
            }
            .frame(width: diameter, height: diameter)
        }
        .buttonStyle(.plain)
    }

    /// Opens the app's notes sheet for this exact mix.
    private func noteButton(for upload: RecentUpload, diameter: CGFloat) -> some View {
        Group {
            if let url = mixNoteURL(for: upload) {
                Link(destination: url) {
                    ZStack {
                        Circle().stroke(MBTheme.teal.opacity(0.6), lineWidth: 1.5)
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: diameter * 0.38, weight: .semibold))
                            .foregroundColor(MBTheme.teal)
                    }
                    .frame(width: diameter, height: diameter)
                }
            }
        }
    }

    /// "+ Mix Note" — a note on the mix that's playing (or, with nothing
    /// playing, the newest upload). ContentView decides which.
    private func mixNotePill(compact: Bool) -> some View {
        Group {
            if let url = URL(string: "mixbase://mix-note") {
                Link(destination: url) { mixNoteLabel(compact: compact) }
            }
        }
    }

    private func mixNoteLabel(compact: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: compact ? "square.and.pencil" : "plus")
                .font(.system(size: compact ? 11 : 10, weight: .bold))
            if !compact {
                Text("Mix Note")
                    .font(.system(size: 11, weight: .semibold))
            }
        }
        .foregroundColor(.black)
        .padding(.horizontal, compact ? 7 : 10)
        .padding(.vertical, 5)
        .background(MBTheme.teal)
        .clipShape(Capsule())
    }

    private func mixNoteURL(for upload: RecentUpload) -> URL? {
        var parts = URLComponents()
        parts.scheme = "mixbase"
        parts.host = "mix-note"
        parts.queryItems = [
            URLQueryItem(name: "project", value: upload.projectId.uuidString),
            URLQueryItem(name: "version", value: upload.versionId.uuidString),
        ]
        return parts.url
    }

    private func cover(for upload: RecentUpload, side: CGFloat, cornerRadius: CGFloat) -> some View {
        Group {
            if let image = entry.covers[upload.versionId] {
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
                        .font(.system(size: side * 0.4))
                        .foregroundColor(.gray.opacity(0.4))
                }
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }

    /// "MIX 3 · 2 hr. ago"
    private func subtitle(for upload: RecentUpload) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        let ago = upload.uploadedAt > entry.date.addingTimeInterval(-60)
            ? "just now"
            : formatter.localizedString(for: upload.uploadedAt, relativeTo: entry.date)
        return "\(upload.versionName) · \(ago)"
    }

    private var emptyHint: some View {
        Text(entry.uploads == nil ? "Open mixBASE to load your uploads" : "No uploads yet")
            .font(.system(size: 11))
            .foregroundColor(MBTheme.text.opacity(0.5))
    }
}
