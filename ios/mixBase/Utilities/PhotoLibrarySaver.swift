import Foundation
#if os(iOS)
import Photos
#endif

// MARK: - PhotoLibrarySaver
// Downloads a remote video (visualizer loop or finished render) and saves it
// locally — the app equivalent of the web share-sheet "Save Video".
//   iOS:   adds it to the Photos library with add-only access, so the
//          permission prompt asks for the narrowest thing possible.
//   macOS: writes it into ~/Downloads (the sandbox's downloads entitlement) —
//          Photos on the Mac isn't where anyone expects a render to land.
// URLSession.download streams to disk on both platforms, so even a
// full-length 1080p render never has to fit in memory.

enum PhotoSaveError: LocalizedError {
    case invalidURL
    case downloadFailed
    case permissionDenied
    case saveFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "That video link is invalid."
        case .downloadFailed:
            return "Could not download the video. Check your connection and try again."
        case .permissionDenied:
            return "Allow photo access for mixBase in Settings to save videos to your Photos library."
        case .saveFailed:
            #if os(iOS)
            return "Could not save the video to your Photos library."
            #else
            return "Could not save the video to your Downloads folder."
            #endif
        }
    }
}

enum PhotoLibrarySaver {

    /// Download the video at `urlString` and save it (Photos on iOS,
    /// ~/Downloads on macOS).
    static func saveVideo(from urlString: String) async throws {
        guard let url = URL(string: urlString) else { throw PhotoSaveError.invalidURL }

        #if os(iOS)
        // Ask for permission BEFORE downloading so a denial doesn't waste the
        // transfer. .addOnly means the prompt is "Add Photos Only" — the app
        // never asks to read the library here.
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw PhotoSaveError.permissionDenied
        }
        #endif

        let tempUrl: URL
        do {
            let (downloaded, response) = try await URLSession.shared.download(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                try? FileManager.default.removeItem(at: downloaded)
                throw PhotoSaveError.downloadFailed
            }
            tempUrl = downloaded
        } catch let error as PhotoSaveError {
            throw error
        } catch {
            throw PhotoSaveError.downloadFailed
        }

        let ext = url.pathExtension.isEmpty ? "mp4" : url.pathExtension

        #if os(iOS)
        // URLSession's temp file has a ".tmp" name; Photos identifies the
        // container by extension, so give it the real one before handing it over.
        let localUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext)
        do {
            try FileManager.default.moveItem(at: tempUrl, to: localUrl)
        } catch {
            try? FileManager.default.removeItem(at: tempUrl)
            throw PhotoSaveError.saveFailed
        }
        defer { try? FileManager.default.removeItem(at: localUrl) }

        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: localUrl)
            }
        } catch {
            throw PhotoSaveError.saveFailed
        }
        #else
        // macOS: move the download into ~/Downloads under a readable name,
        // uniqued so repeated saves never overwrite an earlier render.
        guard let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            try? FileManager.default.removeItem(at: tempUrl)
            throw PhotoSaveError.saveFailed
        }
        let baseName = url.deletingPathExtension().lastPathComponent
        let stem = baseName.isEmpty || baseName == "/" ? "mixbase-video" : baseName
        var destination = downloads.appendingPathComponent(stem).appendingPathExtension(ext)
        var counter = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = downloads.appendingPathComponent("\(stem)-\(counter)").appendingPathExtension(ext)
            counter += 1
        }
        do {
            try FileManager.default.moveItem(at: tempUrl, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: tempUrl)
            throw PhotoSaveError.saveFailed
        }
        #endif
    }
}
