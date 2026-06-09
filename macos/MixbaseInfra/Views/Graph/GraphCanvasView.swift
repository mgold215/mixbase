import SwiftUI

struct GraphCanvasView: View {
    let topology: InfraTopology
    @Binding var selectedNodeId: String?

    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var drag: CGSize = .zero

    private var layout: GraphLayout {
        LayeredLayoutEngine.layout(nodes: topology.nodes, layerOrder: topology.layerOrder)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                edgeLayer
                ForEach(topology.nodes) { node in
                    NodeView(node: node, selected: node.id == selectedNodeId)
                        .frame(width: LayeredLayoutEngine.nodeWidth, height: LayeredLayoutEngine.nodeHeight)
                        .position(layout.positions[node.id] ?? .zero)
                        .onTapGesture { selectedNodeId = node.id }
                }
            }
            .frame(width: layout.size.width, height: layout.size.height)
            .scaleEffect(scale * pinch)
            .offset(x: offset.width + drag.width, y: offset.height + drag.height)
            .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
            .background(Palette.background)
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .updating($drag) { value, state, _ in state = value.translation }
                    .onEnded { value in
                        offset.width += value.translation.width
                        offset.height += value.translation.height
                    }
            )
            .gesture(
                MagnifyGesture()
                    .updating($pinch) { value, state, _ in state = value.magnification }
                    .onEnded { value in scale = min(max(scale * value.magnification, 0.4), 2.5) }
            )
            .onTapGesture(count: 2) {
                withAnimation(.easeOut(duration: 0.2)) { scale = 1; offset = .zero }
            }
            .overlay(alignment: .bottomTrailing) { zoomHint }
        }
    }

    private var edgeLayer: some View {
        Canvas { ctx, _ in
            for edge in topology.edges {
                guard let p1 = layout.positions[edge.from],
                      let p2 = layout.positions[edge.to] else { continue }
                let start = pointOnEdge(from: p1, to: p2, halfWidth: LayeredLayoutEngine.nodeWidth / 2)
                let end = pointOnEdge(from: p2, to: p1, halfWidth: LayeredLayoutEngine.nodeWidth / 2)

                var path = Path()
                path.move(to: start)
                path.addLine(to: end)
                ctx.stroke(path, with: .color(.white.opacity(0.14)), lineWidth: 1.4)
                drawArrow(&ctx, from: start, to: end)

                if let label = edge.label {
                    let mid = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
                    ctx.draw(
                        Text(label).font(.system(size: 8)).foregroundColor(.white.opacity(0.35)),
                        at: mid
                    )
                }
            }
        }
        .frame(width: layout.size.width, height: layout.size.height)
    }

    private var zoomHint: some View {
        Text("scroll-drag to pan · pinch to zoom · double-click to reset")
            .font(.system(size: 9))
            .foregroundStyle(.secondary)
            .padding(6)
            .background(.black.opacity(0.4), in: Capsule())
            .padding(10)
    }

    // Pull a line endpoint back to roughly the node's border so arrows aren't hidden.
    private func pointOnEdge(from a: CGPoint, to b: CGPoint, halfWidth: CGFloat) -> CGPoint {
        let dx = b.x - a.x, dy = b.y - a.y
        let len = max(sqrt(dx * dx + dy * dy), 0.001)
        let pull = min(halfWidth + 8, len / 2)
        return CGPoint(x: a.x + dx / len * pull, y: a.y + dy / len * pull)
    }

    private func drawArrow(_ ctx: inout GraphicsContext, from a: CGPoint, to b: CGPoint) {
        let dx = b.x - a.x, dy = b.y - a.y
        let len = max(sqrt(dx * dx + dy * dy), 0.001)
        let ux = dx / len, uy = dy / len
        let size: CGFloat = 6
        let tip = b
        let left = CGPoint(x: b.x - ux * size - uy * size * 0.6, y: b.y - uy * size + ux * size * 0.6)
        let right = CGPoint(x: b.x - ux * size + uy * size * 0.6, y: b.y - uy * size - ux * size * 0.6)
        var head = Path()
        head.move(to: tip)
        head.addLine(to: left)
        head.addLine(to: right)
        head.closeSubpath()
        ctx.fill(head, with: .color(.white.opacity(0.22)))
    }
}
