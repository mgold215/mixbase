import WidgetKit
import SwiftUI

// MARK: - mixBASE widget bundle
// Home Screen + Lock Screen widgets. Widgets render from snapshots the app
// writes into the shared App Group (see NowPlayingStore.swift, compiled into
// both targets) — no networking or Supabase access happens in this process.

@main
struct MixbaseWidgetBundle: WidgetBundle {
    var body: some Widget {
        NowPlayingWidget()
        StudioStatsWidget()
    }
}

// MARK: - Brand palette (mirrors the app's Color(hex:) values)
enum MBTheme {
    static let teal = Color(red: 45 / 255, green: 212 / 255, blue: 191 / 255)
    static let background = Color(red: 8 / 255, green: 8 / 255, blue: 8 / 255)
    static let card = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let text = Color(red: 240 / 255, green: 240 / 255, blue: 240 / 255)
}

// MARK: - Shared bits

/// The "mixBASE" wordmark, sized for widget headers.
struct MBWordmark: View {
    var size: CGFloat = 14

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text("mix")
                .font(.system(size: size, weight: .bold))
                .foregroundColor(MBTheme.text)
            Text("BASE")
                .font(.system(size: size, weight: .bold))
                .foregroundColor(MBTheme.teal)
        }
    }
}
