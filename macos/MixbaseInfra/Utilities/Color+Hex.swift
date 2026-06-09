import SwiftUI

extension Color {
    /// Create a Color from a "RRGGBB" hex string (leading # optional).
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var value: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&value)
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1.0)
    }
}

// Shared palette for the diagram.
enum Palette {
    static let background = Color(hex: "0a0a0a")
    static let panel = Color(hex: "0d0d0d")
    static let card = Color(hex: "151515")
    static let bar = Color(hex: "111111")
    static let accent = Color(hex: "2dd4bf")
}
