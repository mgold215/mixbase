import SwiftUI

struct ScalingSignalBar: View {
    let signal: SupabaseStatus.ScalingSignal

    private var color: Color {
        switch signal.severity {
        case "critical": return Color(hex: "f87171")
        case "warn":     return Color(hex: "fbbf24")
        default:         return Palette.accent
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(signal.label).font(.system(size: 11, weight: .semibold))
                Spacer()
                Text("\(formatBytes(signal.usedBytes)) / \(formatBytes(signal.limitBytes))  ·  \(String(format: "%.1f", signal.pct))%")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.08))
                    RoundedRectangle(cornerRadius: 3)
                        .fill(color)
                        .frame(width: g.size.width * CGFloat(min(signal.pct / 100.0, 1.0)))
                }
            }
            .frame(height: 6)
        }
    }
}
