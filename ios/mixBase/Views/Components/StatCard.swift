import SwiftUI

// MARK: - StatCard
// A reusable dashboard card showing a big number with a label below it.
// Used on the Home screen to display stats like "Total Projects", "Mixing", etc.

struct StatCard: View {

    // The number to display prominently
    let value: Int

    // The label below the number (e.g. "Projects", "Mixing")
    let label: String

    // The color of the number text
    let color: Color

    var body: some View {
        VStack(spacing: 6) {
            // Big number in the specified color
            Text("\(value)")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundColor(color)

            // Label below in muted gray
            Text(label)
                .font(.caption)
                .foregroundColor(Color(hex: "#f0f0f0").opacity(0.5))
        }
        // Card styling: dark background with rounded corners
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
    }
}
