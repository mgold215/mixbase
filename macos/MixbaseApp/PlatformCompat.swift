#if os(macOS)
import SwiftUI
import AppKit

// MARK: - PlatformCompat
// Compiled ONLY into the macOS mixBase target (see macos/project.yml). The app
// shares its whole Swift source tree with the native iOS app (ios/mixBase);
// genuinely divergent behavior lives behind #if os() guards in those files,
// while this file bridges the long tail of iOS-only *names* — SwiftUI
// modifiers, UIPasteboard, UIImage — so the shared views compile unchanged.
//
// Everything here is either a no-op (iOS modifiers that have no macOS
// equivalent, like keyboardType) or a thin adapter onto the AppKit/macOS
// counterpart (UIPasteboard → NSPasteboard, fullScreenCover → sheet).

// MARK: UIImage / NSImage

/// The shared sources decode and resize artwork via `UIImage`; on macOS the
/// same call sites resolve to NSImage, which mirrors the initializers used
/// (`init?(data:)`, `size`).
typealias UIImage = NSImage

extension NSImage {
    /// NSImage has no `jpegData(compressionQuality:)`; route through a bitmap
    /// rep like the UIKit call the shared code expects.
    func jpegData(compressionQuality: CGFloat) -> Data? {
        guard let tiff = tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .jpeg,
                                  properties: [.compressionFactor: compressionQuality])
    }
}

// MARK: UIPasteboard

/// Adapter matching the two call sites' shape (`UIPasteboard.general.string =`)
/// on top of NSPasteboard.
final class UIPasteboard {
    static let general = UIPasteboard()

    var string: String? {
        get { NSPasteboard.general.string(forType: .string) }
        set {
            NSPasteboard.general.clearContents()
            if let newValue {
                NSPasteboard.general.setString(newValue, forType: .string)
            }
        }
    }
}

// MARK: EditButton

/// iOS-only edit-mode toggle. macOS lists have no edit mode — rows still get
/// swipe/context delete via onDelete — so the button simply disappears.
struct EditButton: View {
    var body: some View { EmptyView() }
}

// MARK: - iOS-only view modifiers

/// Shadow of UIKit's `NavigationBarItem.TitleDisplayMode` so shared call sites
/// like `.navigationBarTitleDisplayMode(.inline)` compile; macOS titles have
/// no display-mode concept, so it does nothing.
enum PlatformTitleDisplayMode {
    case automatic, inline, large
}

/// Shadow of `UIKeyboardType` — hardware keyboards need no layout hints.
enum PlatformKeyboardType {
    case `default`, emailAddress, numberPad, decimalPad, URL,
         numbersAndPunctuation, asciiCapable
}

/// Shadow of `UITextAutocapitalizationType` (legacy `.autocapitalization`).
enum PlatformAutocapitalizationType {
    case none, words, sentences, allCharacters
}

/// Shadow of SwiftUI's iOS-only `TextInputAutocapitalization`.
enum PlatformTextInputAutocapitalization {
    case never, characters, words, sentences
}

extension View {
    func navigationBarTitleDisplayMode(_ mode: PlatformTitleDisplayMode) -> some View {
        self
    }

    func keyboardType(_ type: PlatformKeyboardType) -> some View {
        self
    }

    func autocapitalization(_ style: PlatformAutocapitalizationType) -> some View {
        self
    }

    func textInputAutocapitalization(_ autocapitalization: PlatformTextInputAutocapitalization) -> some View {
        self
    }

    /// macOS has no full-screen covers; a sheet is the native equivalent of
    /// "modal that takes over the flow".
    func fullScreenCover<Content: View>(
        isPresented: Binding<Bool>,
        onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        sheet(isPresented: isPresented, onDismiss: onDismiss, content: content)
    }
}

// MARK: - Toolbar placements

extension ToolbarItemPlacement {
    /// iOS nav-bar slots → the macOS toolbar's semantic equivalents.
    static var navigationBarTrailing: ToolbarItemPlacement { .primaryAction }
    static var navigationBarLeading: ToolbarItemPlacement { .navigation }
}

extension ToolbarPlacement {
    /// `toolbarColorScheme(.dark, for: .navigationBar)` call sites — on macOS
    /// the window toolbar is the closest surface.
    static var navigationBar: ToolbarPlacement { .automatic }
}

// MARK: - List styles

extension ListStyle where Self == InsetListStyle {
    /// `.insetGrouped` is iOS-only; inset is its macOS visual counterpart.
    static var insetGrouped: InsetListStyle { InsetListStyle() }
}

#endif
