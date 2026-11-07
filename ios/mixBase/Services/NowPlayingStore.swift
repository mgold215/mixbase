import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
#if canImport(WidgetKit)
import WidgetKit
#endif

// MARK: - NowPlayingStore
// The bridge between the app and its Home Screen widgets. Widgets run in a
// separate process with no access to AudioService, so the app publishes small
// Codable snapshots (plus a downscaled artwork JPEG) into the shared App Group
// container, then asks WidgetKit to re-render. Everything here is Foundation/
// CoreGraphics only — this file is compiled into the iOS app, the widget
// extension AND the macOS app (shared source tree), so no UIKit.

/// What the Now Playing widget renders. Written by AudioService on every
/// meaningful playback-state change; also kept around while paused so the
/// widget can show "last played".
struct NowPlayingSnapshot: Codable {
    var trackName: String
    var versionName: String?
    var artistName: String?
    var artworkUrl: String?
    var projectId: UUID?
    /// The exact mix playing — lets the Recent Uploads widget mark the right
    /// row. Optional so snapshots written by older builds still decode.
    var versionId: UUID? = nil
    var isPlaying: Bool
    var updatedAt: Date

    /// Same content, ignoring the timestamp — used to skip pointless widget
    /// reloads (WidgetKit reload budgets are limited).
    func isEquivalent(to other: NowPlayingSnapshot?) -> Bool {
        guard let other else { return false }
        return trackName == other.trackName
            && versionName == other.versionName
            && artistName == other.artistName
            && artworkUrl == other.artworkUrl
            && projectId == other.projectId
            && versionId == other.versionId
            && isPlaying == other.isPlaying
    }
}

/// One row of the Recent Uploads widget: a song's newest mix.
struct RecentUpload: Codable, Equatable {
    var projectId: UUID
    var versionId: UUID
    var title: String
    var versionName: String
    var uploadedAt: Date
    var artworkUrl: String?
}

/// What the Recent Uploads widget renders — the three newest uploads, newest
/// first. Written by HomeView after each dashboard load.
struct RecentUploadsSnapshot: Codable {
    var uploads: [RecentUpload]
    var updatedAt: Date
}

enum NowPlayingStore {

    /// Shared container for the app + its widgets. The entitlement is carried
    /// by the iOS app and the widget extension; on macOS (no widgets) the
    /// suite silently degrades to a private domain, which is fine — nothing
    /// reads it there.
    static let appGroupId = "group.com.moodmixformat.mixbase"

    /// WidgetKit "kind" identifiers — must match the widget configurations.
    /// The Recent Uploads widget keeps the old Studio Stats kind on purpose:
    /// a widget already on someone's Home Screen turns into the new one in
    /// place instead of disappearing.
    static let nowPlayingWidgetKind = "MixbaseNowPlayingWidget"
    static let statsWidgetKind = "MixbaseStudioStatsWidget"
    static var recentUploadsWidgetKind: String { statsWidgetKind }

    /// How many uploads the widget lists.
    static let recentUploadsLimit = 3

    private static let nowPlayingKey = "widget.nowPlaying"
    private static let recentUploadsKey = "widget.recentUploads"
    private static let recentArtUrlKeyPrefix = "widget.recentArtUrl."
    private static let artworkUrlKey = "widget.artworkUrl"
    private static let artworkFilename = "widget-artwork.jpg"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroupId) }

    private static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    }

    // MARK: - Now Playing snapshot

    static func saveNowPlaying(_ snapshot: NowPlayingSnapshot?) {
        guard let defaults else { return }
        if let snapshot, let data = try? JSONEncoder().encode(snapshot) {
            defaults.set(data, forKey: nowPlayingKey)
        } else {
            defaults.removeObject(forKey: nowPlayingKey)
        }
    }

    static func loadNowPlaying() -> NowPlayingSnapshot? {
        guard let data = defaults?.data(forKey: nowPlayingKey) else { return nil }
        return try? JSONDecoder().decode(NowPlayingSnapshot.self, from: data)
    }

    // MARK: - Recent uploads snapshot

    /// Saves the list and reports whether it actually changed, so callers
    /// only burn a widget reload when something the widget shows moved.
    @discardableResult
    static func saveRecentUploads(_ uploads: [RecentUpload]) -> Bool {
        guard let defaults else { return false }
        if let current = loadRecentUploads(), current.uploads == uploads { return false }
        let snapshot = RecentUploadsSnapshot(uploads: uploads, updatedAt: Date())
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        defaults.set(data, forKey: recentUploadsKey)
        return true
    }

    static func loadRecentUploads() -> RecentUploadsSnapshot? {
        guard let data = defaults?.data(forKey: recentUploadsKey) else { return nil }
        return try? JSONDecoder().decode(RecentUploadsSnapshot.self, from: data)
    }

    /// Small cover thumbnails for the widget rows, one file per slot. The URL
    /// is remembered per slot so a row never shows another song's cover.
    static func hasRecentArtwork(slot: Int, urlString: String) -> Bool {
        defaults?.string(forKey: recentArtUrlKeyPrefix + "\(slot)") == urlString
    }

    static func saveRecentArtwork(data: Data, slot: Int, urlString: String) {
        guard let dir = containerURL,
              let jpeg = downsampledJPEG(from: data, maxDimension: 240) else { return }
        let fileURL = dir.appendingPathComponent("widget-recent-\(slot).jpg")
        guard (try? jpeg.write(to: fileURL, options: .atomic)) != nil else { return }
        defaults?.set(urlString, forKey: recentArtUrlKeyPrefix + "\(slot)")
    }

    static func loadRecentArtworkData(slot: Int, matching urlString: String) -> Data? {
        guard hasRecentArtwork(slot: slot, urlString: urlString),
              let dir = containerURL else { return nil }
        return try? Data(contentsOf: dir.appendingPathComponent("widget-recent-\(slot).jpg"))
    }

    // MARK: - Artwork cache

    /// Writes a widget-sized JPEG of the current track's artwork into the
    /// shared container. Source images can be multi-megabyte generations —
    /// the widget process has a tight memory cap, so downscaling happens HERE
    /// (via ImageIO, which never decodes the full-resolution bitmap).
    static func saveArtwork(data: Data, urlString: String) {
        guard let dir = containerURL,
              let jpeg = downsampledJPEG(from: data, maxDimension: 800) else { return }
        let fileURL = dir.appendingPathComponent(artworkFilename)
        guard (try? jpeg.write(to: fileURL, options: .atomic)) != nil else { return }
        defaults?.set(urlString, forKey: artworkUrlKey)
    }

    /// Returns the cached artwork only if it belongs to the given URL, so a
    /// previous track's art never renders against the current one.
    static func loadArtworkData(matching urlString: String) -> Data? {
        guard defaults?.string(forKey: artworkUrlKey) == urlString,
              let dir = containerURL else { return nil }
        return try? Data(contentsOf: dir.appendingPathComponent(artworkFilename))
    }

    private static func downsampledJPEG(from data: Data, maxDimension: Int) -> Data? {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary) else { return nil }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        let destOptions: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
        CGImageDestinationAddImage(destination, cgImage, destOptions as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    // MARK: - Widget reloads

    static func reloadNowPlayingWidgets() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: nowPlayingWidgetKind)
        #endif
    }

    static func reloadRecentUploadsWidgets() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: recentUploadsWidgetKind)
        #endif
    }
}
