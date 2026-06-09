import CoreGraphics

// Curated layered layout: one column per layer (client → edge → app → data →
// external), nodes stacked and vertically centered within their column. The
// topology is small and known, so a deterministic layout reads far better than
// a force-directed one.

struct GraphLayout {
    let positions: [String: CGPoint] // node id → center point
    let size: CGSize
}

enum LayeredLayoutEngine {
    static let nodeWidth: CGFloat = 196
    static let nodeHeight: CGFloat = 76
    static let colSpacing: CGFloat = 252
    static let rowSpacing: CGFloat = 108
    static let margin: CGFloat = 64

    static func layout(nodes: [InfraNode], layerOrder: [String]) -> GraphLayout {
        var byLayer: [String: [InfraNode]] = [:]
        for node in nodes { byLayer[node.layer, default: []].append(node) }

        let columns = layerOrder.filter { (byLayer[$0]?.isEmpty == false) }
        let maxRows = columns.map { byLayer[$0]?.count ?? 0 }.max() ?? 1
        let totalHeight = margin * 2 + CGFloat(max(maxRows - 1, 0)) * rowSpacing + nodeHeight

        var positions: [String: CGPoint] = [:]
        for (ci, layer) in columns.enumerated() {
            let colNodes = byLayer[layer] ?? []
            let colHeight = CGFloat(max(colNodes.count - 1, 0)) * rowSpacing
            let startY = (totalHeight - colHeight) / 2
            let x = margin + nodeWidth / 2 + CGFloat(ci) * colSpacing
            for (ri, node) in colNodes.enumerated() {
                positions[node.id] = CGPoint(x: x, y: startY + CGFloat(ri) * rowSpacing)
            }
        }

        let totalWidth = margin * 2 + nodeWidth + CGFloat(max(columns.count - 1, 0)) * colSpacing
        return GraphLayout(positions: positions, size: CGSize(width: totalWidth, height: totalHeight))
    }
}
