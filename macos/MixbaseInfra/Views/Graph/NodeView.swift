import SwiftUI

struct NodeView: View {
    let node: InfraNode
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: ProviderStyle.icon(node.provider))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(NodeStatusStyle.color(for: node.status))
                Text(node.label)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                Circle()
                    .fill(NodeStatusStyle.color(for: node.status))
                    .frame(width: 8, height: 8)
            }
            Text(node.metric?.isEmpty == false ? node.metric! : node.provider)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Palette.card))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(selected ? Palette.accent : Color.white.opacity(0.08), lineWidth: selected ? 2 : 1)
        )
        .shadow(color: .black.opacity(0.35), radius: 3, y: 2)
        .contentShape(Rectangle())
    }
}
