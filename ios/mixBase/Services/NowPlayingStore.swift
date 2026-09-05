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
            && isPlaying == other.isPlaying
    }
}

/// What the Studio Stats widget renders — the Home tab's three counters.
struct StudioStatsSnapshot: Codable {
    var projects: Int
    var mixing: Int
    var pipeline: Int
    var updatedAt: Date
}

enum NowPlayingStore {

    /// Shared container for the app + its widgets. The entitlement is carried
    /// by the iOS app and the widget extension; on macOS (no widgets) the
    /// suite silently degrades to a private domain, which is fine — nothing
    /// reads it there.
    static let appGroupId = "group.com.moodmixformat.mixbase"

    /// WidgetKit "kind" identifiers — must match the widget configurations.
    static let nowPlayingWidgetKind = "MixbaseNowPlayingWidget"
    static let statsWidgetKind = "MixbaseStudioStatsWidget"

    private static let nowPlayingKey = "widget.nowPlaying"
    private static let statsKey = "widget.studioStats"
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

    // MARK: - Studio stats snapshot

    /// Saves the stats and reports whether they actually changed, so callers
    /// only burn a widget reload when the numbers moved.
    @discardableResult
    static func saveStats(_ snapshot: StudioStatsSnapshot) -> Bool {
        guard let defaults else { return false }
        if let current = loadStats(),
           current.projects == snapshot.projects,
           current.mixing == snapshot.mixing,
           current.pipeline == snapshot.pipeline {
            return false
        }
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        defaults.set(data, forKey: statsKey)
        return true
    }

    static func loadStats() -> StudioStatsSnapshot? {
        guard let data = defaults?.data(forKey: statsKey) else { return nil }
        return try? JSONDecoder().decode(StudioStatsSnapshot.self, from: data)
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

    static func reloadStatsWidgets() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: statsWidgetKind)
        #endif
    }
}
