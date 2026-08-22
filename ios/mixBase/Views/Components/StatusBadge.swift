import SwiftUI

// MARK: - StatusBadge
// A small pill-shaped badge that displays the status of a version or project.
// The color changes based on the status string:
//   "Mix"      -> blue
//   "Master"   -> violet
//   "Finished" -> green
//   "Released" -> teal
// The retired "WIP" / "Mix/Master" spellings (pre-migration-034 rows) fold
// onto the same colors.

struct StatusBadge: View {

    // The status text to display (e.g. "Mix", "Released")
    let status: String

    var body: some View {
        Text(status)
            .font(.caption2)
            .fontWeight(.semibold)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundColor(.white)
            .background(colorForStatus)
            .clipShape(Capsule()) // Makes it pill-shaped
    }

    // MARK: - Status Color Mapping
    // Returns the appropriate color for each status string.
    private var colorForStatus: Color {
        switch status.lowercased() {
        case "mix", "wip", "mixing":
            return .blue.opacity(0.8)
        case "master", "mix/master", "mastering":
            return Color(hex: "#a78bfa") // Violet
        case "finished":
            return Color(red: 0.2, green: 0.8, blue: 0.4) // Emerald green
        case "released":
            return Color(hex: "#2dd4bf") // Teal accent
        default:
            return .gray.opacity(0.6)
        }
    }
}
