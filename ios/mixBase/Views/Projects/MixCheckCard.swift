import SwiftUI
import UniformTypeIdentifiers

// MARK: - MixCheckCard
// Mix Check for the latest mix — the app's side of the web project page's
// "Mix check" panel. Master Check (the card above it) answers "how loud";
// this asks the SERVER to analyse the whole mix and shows what it found: what
// changed since the previous version, how the balance sits against the
// artist's own catalog and against commercial references in the genre, and
// faults that need no comparison (a drop that lands smaller than its
// breakdown, a low end that cancels in mono, clipping).
//
// Nothing is measured or judged here. The app starts a check, polls it and
// draws the report — the same routes and the same report the web uses, so a
// check run on either shows on both. Every finding is also written into the
// mix notes by the server, timestamped, under the "Mix Check" byline;
// `onNotesChanged` tells the song screen to reload them.
//
// Owner-only for now: the song screen shows the card only when
// AuthService.ownerTools is true (the server 404s the routes for anyone else).
struct MixCheckCard: View {

    let version: Version
    let projectId: UUID
    /// The check wrote (or replaced) its notes on this mix.
    let onNotesChanged: () -> Void
    /// Play this mix from a moment (seconds).
    let onJump: (Int) -> Void

    // nil until the first answer from the server.
    @State private var status: MixbaseAPI.MixCheckStatus?
    @State private var expanded = false
    @State private var watcher: Task<Void, Never>?

    private static let teal = Color(hex: "#2dd4bf")
    private static let ink = Color(hex: "#f0f0f0")

    private var isRunning: Bool {
        if case .running? = status { return true }
        return false
    }

    private var report: MixbaseAPI.MixCheckReport? {
        if case .done(let report, _)? = status { return report }
        return nil
    }

    private var options: MixbaseAPI.MixCheckOptions? {
        if case .done(_, let options)? = status { return options }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            switch status {
            case .some(.notChecked):
                Text("Analyses the whole mix and writes what it finds into the notes, each at its place in the song.")
                    .font(.caption)
                    .foregroundColor(.gray)
            case .some(.running):
                Text("Listening to the whole mix. This takes about half a minute.")
                    .font(.caption)
                    .foregroundColor(.gray)
            case .some(.failed(let message)):
                Text(message)
                    .font(.caption)
                    .foregroundColor(.red)
            case .some(.done(let report, _)):
                summaryRow(report)
                if expanded {
                    MixCheckReportView(
                        report: report,
                        options: options,
                        projectId: projectId,
                        onJump: onJump
                    )
                }
            case .none:
                // Not loaded yet.
                EmptyView()
            }
        }
        .padding(12)
        .background(Color(hex: "#111111"))
        .cornerRadius(10)
        .task {
            await load()
        }
        .onDisappear {
            watcher?.cancel()
            watcher = nil
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "stethoscope")
                .font(.caption)
                .foregroundColor(Self.teal)
            Text("MIX CHECK")
                .font(.caption2)
                .fontWeight(.semibold)
                .tracking(1)
                .foregroundColor(.gray)
            Text(version.displayName)
                .font(.caption2)
                .foregroundColor(.gray)
                .lineLimit(1)
            Spacer()
            if isRunning {
                HStack(spacing: 6) {
                    ProgressView()
                        .tint(Self.teal)
                        .scaleEffect(0.7)
                    Text("Checking…")
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            } else if status != nil {
                Button(report == nil ? "Check this mix" : "Check again") {
                    start()
                }
                .font(.caption)
                .fontWeight(report == nil ? .semibold : .regular)
                .foregroundColor(Self.teal)
            }
        }
    }

    // "7 notes added · 2 high · 4 medium · vs MASTER 4, 71 of your songs, …"
    // The whole row opens and closes the report.
    private func summaryRow(_ report: MixbaseAPI.MixCheckReport) -> some View {
        let findings = report.findings ?? []
        let high = findings.filter { $0.severity == "high" }.count
        let medium = findings.filter { $0.severity == "medium" }.count
        let lead = findings.isEmpty
            ? "Nothing measurable stands out."
            : "\(findings.count) note\(findings.count == 1 ? "" : "s") added"

        return Button(action: {
            withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
        }) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    (
                        Text(lead).foregroundColor(Self.ink)
                        + Text(high > 0 ? "  ·  \(high) high" : "").foregroundColor(MixCheckStyle.color(for: "high"))
                        + Text(medium > 0 ? "  ·  \(medium) medium" : "").foregroundColor(MixCheckStyle.color(for: "medium"))
                    )
                    .font(.caption)
                    .fontWeight(.medium)

                    Text(MixCheckStyle.comparedLine(report))
                        .font(.caption2)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .padding(.top, 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Talking to the server

    private func load() async {
        do {
            let current = try await MixbaseAPI.shared.mixCheck(versionId: version.id)
            status = current
            // One started on the web (or before leaving this screen) is picked up.
            if case .running = current { watch() }
        } catch {
            // Not being able to ask is not "never checked": offer the button anyway.
            if status == nil { status = .some(.notChecked) }
        }
    }

    private func start() {
        guard !isRunning else { return }
        status = .running
        watcher?.cancel()
        watcher = Task {
            do {
                try await MixbaseAPI.shared.startMixCheck(versionId: version.id)
            } catch {
                if !Task.isCancelled { status = .failed(error.localizedDescription) }
                return
            }
            await poll()
        }
    }

    private func watch() {
        watcher?.cancel()
        watcher = Task { await poll() }
    }

    // Poll until the check is no longer running. A dropped request (the phone
    // locked, a tunnel) is not a failed check: only several in a row give up.
    private func poll() async {
        var misses = 0
        for _ in 0..<140 {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if Task.isCancelled { return }
            do {
                let current = try await MixbaseAPI.shared.mixCheck(versionId: version.id)
                if Task.isCancelled { return }
                misses = 0
                if case .running = current { continue }
                status = current
                if case .done = current {
                    withAnimation(.easeOut(duration: 0.15)) { expanded = true }
                    onNotesChanged()
                }
                return
            } catch {
                if Task.isCancelled { return }
                misses += 1
                if misses >= 6 {
                    status = .failed("Lost the connection while checking. The check may still finish: come back to this song in a minute.")
                    return
                }
            }
        }
        status = .failed("The check is taking too long. Try again in a minute.")
    }
}

// MARK: - Shared look

enum MixCheckStyle {

    static func color(for severity: String) -> Color {
        switch severity {
        case "high": return Color(hex: "#f87171")
        case "medium": return Color(hex: "#fbbf24")
        default: return Color.gray
        }
    }

    /// How far a band sits from a comparison: 5 dB is a lot, 3 dB is worth a look.
    static func color(forDelta delta: Double?) -> Color {
        guard let delta else { return Color.gray.opacity(0.6) }
        if abs(delta) >= 5 { return color(for: "high") }
        if abs(delta) >= 3 { return color(for: "medium") }
        return Color(hex: "#d0d0d0")
    }

    static func clock(_ seconds: Int) -> String {
        "\(seconds / 60):" + String(format: "%02d", seconds % 60)
    }

    /// "+3.2" / "−5.8" / "0.0", with a real minus sign like the web.
    static func signed(_ value: Double) -> String {
        let magnitude = String(format: "%.1f", abs(value))
        if magnitude == "0.0" { return magnitude }
        return (value > 0 ? "+" : "−") + magnitude
    }

    static func comparedLine(_ report: MixbaseAPI.MixCheckReport) -> String {
        var parts: [String] = []
        if let compared = report.compared {
            if let previous = compared.previous { parts.append("vs \(previous)") }
            if let catalog = compared.catalog, catalog > 0 { parts.append("\(catalog) of your songs") }
            if let industry = compared.industry { parts.append("\(industry.count) \(industry.label) references") }
        }
        return parts.isEmpty ? "no comparisons yet" : parts.joined(separator: ", ")
    }
}

// MARK: - The report

private struct MixCheckReportView: View {

    let report: MixbaseAPI.MixCheckReport
    let options: MixbaseAPI.MixCheckOptions?
    let projectId: UUID
    let onJump: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let findings = report.findings ?? []
            if !findings.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(findings) { finding in
                        findingRow(finding)
                    }
                }
            }

            if let bands = report.bands, !bands.isEmpty {
                MixCheckBandTable(bands: bands, compared: report.compared)
            }

            if let curves = report.curves {
                MixCheckSpectrum(curves: curves, hz: options?.thirdOctaveHz ?? [])
            }

            if let detail = report.detail, detail.timeline.sub.count >= 10 {
                MixCheckSubTimeline(detail: detail, findings: findings)
            }

            MixCheckReferences(
                compared: report.compared,
                families: options?.families ?? [],
                projectId: projectId
            )

            Text("Measured from the stereo file, so it finds what can be measured and not what is a matter of taste. Tick a note off in the Mix Session and a later check will leave it alone.")
                .font(.caption2)
                .foregroundColor(.gray)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func findingRow(_ finding: MixbaseAPI.MixCheckFinding) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Circle()
                    .fill(MixCheckStyle.color(for: finding.severity))
                    .frame(width: 6, height: 6)
                    .padding(.top, 5)
                    .accessibilityLabel("\(finding.severity) severity")
                Text(finding.title)
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if let at = finding.atSeconds {
                    Button(action: { onJump(at) }) {
                        Text(MixCheckStyle.clock(at))
                            .font(.caption2.monospacedDigit())
                            .foregroundColor(Color(hex: "#2dd4bf"))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(hex: "#2dd4bf").opacity(0.12))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Play from \(MixCheckStyle.clock(at))")
                }
            }
            Text(finding.note)
                .font(.caption)
                .foregroundColor(.gray)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 14)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: "#161616"))
        .cornerRadius(8)
    }
}

// MARK: - Band table
// Each band's level against the previous version, the catalog and the genre,
// in dB at matched loudness. Only the comparisons that exist get a column.

private struct MixCheckBandTable: View {

    let bands: [MixbaseAPI.MixCheckBand]
    let compared: MixbaseAPI.MixCheckReport.Compared?

    private enum Column: String, Identifiable {
        case previous, catalog, genre
        var id: String { rawValue }
    }

    private var columns: [Column] {
        var result: [Column] = []
        if compared?.previous != nil { result.append(.previous) }
        if (compared?.catalog ?? 0) > 0 { result.append(.catalog) }
        if compared?.industry != nil { result.append(.genre) }
        return result
    }

    private func heading(_ column: Column) -> String {
        switch column {
        case .previous: return compared?.previous ?? "Previous"
        case .catalog: return "Catalog"
        case .genre: return "Genre"
        }
    }

    private func value(_ band: MixbaseAPI.MixCheckBand, _ column: Column) -> Double? {
        switch column {
        case .previous: return band.vsPrevious
        case .catalog: return band.vsCatalog
        case .genre: return band.vsIndustry
        }
    }

    var body: some View {
        let shown = columns
        if !shown.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("BAND, DB VS")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(shown) { column in
                        Text(heading(column).uppercased())
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(width: 62, alignment: .trailing)
                    }
                }
                .font(.system(size: 9))
                .tracking(0.5)
                .foregroundColor(.gray)
                .padding(.bottom, 4)

                ForEach(bands) { band in
                    Rectangle()
                        .fill(Color.white.opacity(0.06))
                        .frame(height: 1)
                    HStack(spacing: 8) {
                        (
                            Text(band.label).foregroundColor(Color(hex: "#d0d0d0"))
                            + Text("  \(band.range)").foregroundColor(.gray)
                        )
                        .font(.caption2)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, alignment: .leading)

                        ForEach(shown) { column in
                            let delta = value(band, column)
                            Text(delta.map { MixCheckStyle.signed($0) } ?? "·")
                                .font(.caption2.monospacedDigit())
                                .foregroundColor(MixCheckStyle.color(forDelta: delta))
                                .frame(width: 62, alignment: .trailing)
                        }
                    }
                    .padding(.vertical, 5)
                }
            }
        }
    }
}

// MARK: - Spectrum
// The mix's balance where it is fullest, against its comparisons, at matched
// loudness. Third-octave points; the frequency axis is the server's own list.

private struct MixCheckSpectrum: View {

    let curves: MixbaseAPI.MixCheckReport.Curves
    let hz: [Double]

    private struct Series: Identifiable {
        let name: String
        let data: [Double]
        let color: Color
        let width: CGFloat
        let dashed: Bool
        var id: String { name }
    }

    private var series: [Series] {
        var result: [Series] = []
        if let industry = curves.industry {
            result.append(Series(name: "Genre", data: industry, color: Color.gray, width: 1.2, dashed: true))
        }
        if let catalog = curves.catalog {
            result.append(Series(name: "Catalog", data: catalog, color: Color(hex: "#d0d0d0"), width: 1.2, dashed: false))
        }
        if let previous = curves.previous {
            result.append(Series(name: "Previous", data: previous, color: Color(hex: "#60a5fa"), width: 1.4, dashed: false))
        }
        result.append(Series(name: "This mix", data: curves.mix, color: Color(hex: "#2dd4bf"), width: 2, dashed: false))
        return result
    }

    var body: some View {
        let lines = series
        let all = lines.flatMap { $0.data }.filter { $0 > -80 }
        if let highest = all.max(), let lowest = all.min() {
            let top = (highest / 5).rounded(.up) * 5
            let bottom = max(top - 40, (lowest / 5).rounded(.down) * 5)

            VStack(alignment: .leading, spacing: 6) {
                Text("BALANCE WHERE THE MIX IS FULLEST")
                    .font(.system(size: 9))
                    .tracking(0.5)
                    .foregroundColor(.gray)

                HStack(spacing: 10) {
                    ForEach(lines) { line in
                        HStack(spacing: 4) {
                            Rectangle()
                                .fill(line.color)
                                .frame(width: 12, height: 2)
                                .opacity(line.dashed ? 0.6 : 1)
                            Text(line.name)
                                .font(.system(size: 10))
                                .foregroundColor(.gray)
                        }
                    }
                }

                Canvas { context, size in
                    let left: CGFloat = 26
                    let right: CGFloat = 6
                    let topInset: CGFloat = 8
                    let bottomInset: CGFloat = 16
                    let plotWidth = size.width - left - right
                    let plotHeight = size.height - topInset - bottomInset
                    let span = max(top - bottom, 1)

                    func y(_ value: Double) -> CGFloat {
                        let clamped = min(top, max(bottom, value))
                        return topInset + plotHeight * CGFloat((top - clamped) / span)
                    }
                    // Third-octave points are evenly spaced on a log axis, so
                    // without the server's list the index is the position.
                    func x(index: Int, count: Int) -> CGFloat {
                        if hz.count == count, let low = hz.first, let high = hz.last, low > 0, high > low {
                            return left + plotWidth * CGFloat(log(hz[index] / low) / log(high / low))
                        }
                        return left + plotWidth * CGFloat(index) / CGFloat(max(count - 1, 1))
                    }

                    var level = top
                    while level >= bottom {
                        var grid = Path()
                        grid.move(to: CGPoint(x: left, y: y(level)))
                        grid.addLine(to: CGPoint(x: size.width - right, y: y(level)))
                        context.stroke(grid, with: .color(Color.white.opacity(0.08)), lineWidth: 1)
                        context.draw(
                            Text(String(Int(level))).font(.system(size: 8)).foregroundColor(.gray),
                            at: CGPoint(x: left - 4, y: y(level)),
                            anchor: .trailing
                        )
                        level -= 10
                    }

                    if let low = hz.first, let high = hz.last, low > 0, high > low {
                        let ticks: [Double] = [30, 60, 120, 250, 500, 1000, 2000, 4000, 8000]
                        for tick in ticks where tick >= low && tick <= high {
                            let position = left + plotWidth * CGFloat(log(tick / low) / log(high / low))
                            let label = tick >= 1000 ? "\(Int(tick / 1000))k" : "\(Int(tick))"
                            context.draw(
                                Text(label).font(.system(size: 8)).foregroundColor(.gray),
                                at: CGPoint(x: position, y: size.height - 5),
                                anchor: .center
                            )
                        }
                    }

                    for line in lines {
                        var path = Path()
                        for (index, value) in line.data.enumerated() {
                            let point = CGPoint(x: x(index: index, count: line.data.count), y: y(value))
                            if index == 0 {
                                path.move(to: point)
                            } else {
                                path.addLine(to: point)
                            }
                        }
                        context.stroke(
                            path,
                            with: .color(line.color),
                            style: StrokeStyle(lineWidth: line.width, lineJoin: .round, dash: line.dashed ? [3, 3] : [])
                        )
                    }
                }
                .frame(height: 150)
                .accessibilityLabel("Spectrum of this mix against its comparisons")
            }
        }
    }
}

// MARK: - Sub level through the song
// One line of sub level over time, shaded where the kick plays, with a dot at
// each note. A sub that goes missing for a section shows at a glance.

private struct MixCheckSubTimeline: View {

    let detail: MixbaseAPI.MixCheckReport.Detail
    let findings: [MixbaseAPI.MixCheckFinding]

    var body: some View {
        let sub = detail.timeline.sub
        let audible = sub.filter { $0 > -80 }
        if let highest = audible.max() {
            let top = (highest / 5).rounded(.up) * 5
            let bottom = top - 30
            let seconds = sub.count

            VStack(alignment: .leading, spacing: 6) {
                (
                    Text("SUB LEVEL THROUGH THE SONG").tracking(0.5)
                    + Text("  shaded where the kick plays · dots are notes")
                )
                .font(.system(size: 9))
                .foregroundColor(.gray)
                .fixedSize(horizontal: false, vertical: true)

                Canvas { context, size in
                    let left: CGFloat = 26
                    let right: CGFloat = 6
                    let topInset: CGFloat = 8
                    let bottomInset: CGFloat = 16
                    let plotWidth = size.width - left - right
                    let plotHeight = size.height - topInset - bottomInset

                    func x(_ second: Double) -> CGFloat {
                        left + plotWidth * CGFloat(second / Double(max(seconds, 1)))
                    }
                    func y(_ value: Double) -> CGFloat {
                        let clamped = min(top, max(bottom, value))
                        return topInset + plotHeight * CGFloat((top - clamped) / 30)
                    }

                    for section in detail.sections where section.kind == "rhythm" {
                        let rect = CGRect(
                            x: x(section.start),
                            y: topInset,
                            width: max(x(section.end) - x(section.start), 0),
                            height: plotHeight
                        )
                        context.fill(Path(rect), with: .color(Color.gray.opacity(0.14)))
                    }

                    var level = top
                    while level >= bottom {
                        var grid = Path()
                        grid.move(to: CGPoint(x: left, y: y(level)))
                        grid.addLine(to: CGPoint(x: size.width - right, y: y(level)))
                        context.stroke(grid, with: .color(Color.white.opacity(0.08)), lineWidth: 1)
                        context.draw(
                            Text(String(Int(level))).font(.system(size: 8)).foregroundColor(.gray),
                            at: CGPoint(x: left - 4, y: y(level)),
                            anchor: .trailing
                        )
                        level -= 10
                    }

                    let tickEvery = seconds > 360 ? 120 : 60
                    var tick = 0
                    while tick <= seconds {
                        context.draw(
                            Text(MixCheckStyle.clock(tick)).font(.system(size: 8)).foregroundColor(.gray),
                            at: CGPoint(x: x(Double(tick)), y: size.height - 5),
                            anchor: .center
                        )
                        tick += tickEvery
                    }

                    // 4-second steps: per-second values are too jumpy to read at this size.
                    let step = 4
                    var line = Path()
                    var start = 0
                    while start < seconds {
                        let end = min(seconds, start + step)
                        let chunk = sub[start..<end].filter { $0 > -119 }
                        var value = bottom
                        if !chunk.isEmpty {
                            let power = chunk.reduce(0.0) { $0 + pow(10, $1 / 10) } / Double(chunk.count)
                            value = 10 * log10(power)
                        }
                        let from = CGPoint(x: x(Double(start)), y: y(value))
                        let to = CGPoint(x: x(Double(end)), y: y(value))
                        if start == 0 {
                            line.move(to: from)
                        } else {
                            line.addLine(to: from)
                        }
                        line.addLine(to: to)
                        start += step
                    }
                    context.stroke(
                        line,
                        with: .color(Color(hex: "#2dd4bf")),
                        style: StrokeStyle(lineWidth: 1.6, lineJoin: .round)
                    )

                    for finding in findings {
                        guard let at = finding.atSeconds else { continue }
                        let dot = CGRect(x: x(Double(at)) - 3, y: topInset, width: 6, height: 6)
                        context.fill(Path(ellipseIn: dot), with: .color(MixCheckStyle.color(for: finding.severity)))
                    }
                }
                .frame(height: 100)
                .accessibilityLabel("Sub level over time")
            }
        }
    }
}

// MARK: - Genre references
// The commercial tracks this mix was compared with, and adding one from a
// full-quality file. The file goes straight to Storage, the server measures it
// and deletes it: only the measurement is kept, never the audio.

private struct MixCheckReferences: View {

    let compared: MixbaseAPI.MixCheckReport.Compared?
    let families: [MixbaseAPI.MixCheckOptions.Family]
    let projectId: UUID

    @State private var open = false
    @State private var artist = ""
    @State private var title = ""
    @State private var family = ""
    @State private var pickedFile: URL?
    @State private var showPicker = false
    @State private var busy = false
    @State private var message: String?

    private var heading: String {
        guard let industry = compared?.industry else {
            return "Genre references: none for this genre yet"
        }
        let assumed = compared?.genreAssumed == true ? " (no genre on this song, so your usual one)" : ""
        return "Genre references: \(industry.count) \(industry.label) tracks\(assumed)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: {
                withAnimation(.easeOut(duration: 0.15)) { open.toggle() }
            }) {
                HStack(alignment: .top, spacing: 6) {
                    Text(heading)
                        .font(.caption2)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9))
                        .foregroundColor(.gray)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                let references = compared?.references ?? []
                if !references.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(references) { reference in
                            (
                                Text("\(reference.artist) · \(reference.title)").foregroundColor(Color(hex: "#d0d0d0"))
                                + Text(reference.source == "full" ? "  full file" : "  preview").foregroundColor(.gray)
                            )
                            .font(.caption2)
                            .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                Text("Previews are short and lossy: good for balance, not for loudness. Add a full-quality file of a track and it replaces its preview. Only the measurement is kept, never the audio.")
                    .font(.system(size: 10))
                    .foregroundColor(.gray)
                    .fixedSize(horizontal: false, vertical: true)

                if !families.isEmpty {
                    addForm
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .onAppear {
            if family.isEmpty {
                family = compared?.family ?? families.first?.key ?? ""
            }
        }
        .fileImporter(
            isPresented: $showPicker,
            allowedContentTypes: [.audio],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                keep(url)
            }
        }
    }

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                field("Artist", text: $artist)
                field("Track title", text: $title)
            }

            HStack(spacing: 10) {
                Picker("Genre", selection: $family) {
                    ForEach(families) { option in
                        Text(option.label.capitalized).tag(option.key)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(Color(hex: "#2dd4bf"))

                Button(action: { showPicker = true }) {
                    HStack(spacing: 4) {
                        Image(systemName: "doc")
                        Text(pickedFile?.lastPathComponent ?? "Choose file")
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .font(.caption2)
                    .foregroundColor(Color(hex: "#d0d0d0"))
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }

            HStack(spacing: 8) {
                Button(action: { Task { await add() } }) {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                        Text("Add reference")
                    }
                    .font(.caption2)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#2dd4bf"))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color(hex: "#2dd4bf").opacity(0.12))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .opacity(busy ? 0.4 : 1)

                if busy {
                    ProgressView()
                        .tint(Color(hex: "#2dd4bf"))
                        .scaleEffect(0.6)
                }
            }

            if let message {
                Text(message)
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(.caption)
            .foregroundColor(Color(hex: "#f0f0f0"))
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color(hex: "#161616"))
            .cornerRadius(6)
            .disabled(busy)
    }

    // Copy the picked file into the app's own space: the picker's grant can
    // lapse before the upload starts, and the upload streams from disk.
    private func keep(_ url: URL) {
        let ext = url.pathExtension.lowercased()
        guard MixbaseAPI.mixReferenceExtensions.contains(ext) else {
            message = "Use a WAV, AIFF, FLAC, MP3 or M4A file."
            return
        }
        // False just means the URL needed no grant; the copy below is the real test.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("mixref-\(UUID().uuidString)", isDirectory: true)
        let copy = folder.appendingPathComponent(url.lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: url, to: copy)
        } catch {
            message = "Could not read that file. Try picking it again."
            return
        }
        discardPicked()
        pickedFile = copy
        message = nil

        // "Artist - Title.wav" fills the two fields when they are still empty.
        let name = url.deletingPathExtension().lastPathComponent
        let parts = name.components(separatedBy: " - ")
        if parts.count >= 2, artist.isEmpty, title.isEmpty {
            artist = parts[0].trimmingCharacters(in: .whitespaces)
            title = parts.dropFirst().joined(separator: " - ").trimmingCharacters(in: .whitespaces)
        }
    }

    private func discardPicked() {
        if let pickedFile {
            try? FileManager.default.removeItem(at: pickedFile.deletingLastPathComponent())
        }
        pickedFile = nil
    }

    private func add() async {
        let cleanArtist = artist.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let file = pickedFile, !cleanArtist.isEmpty, !cleanTitle.isEmpty, !family.isEmpty else {
            message = "Pick a file and fill in the artist and title."
            return
        }
        let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
        let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        if size > 50 * 1024 * 1024 {
            message = "That file is over 50 MB. A shorter WAV or a 320 kbps MP3 of the track measures the same."
            return
        }

        busy = true
        message = "Uploading and measuring…"
        do {
            try await MixbaseAPI.shared.addMixReference(
                projectId: projectId,
                fileURL: file,
                family: family,
                artist: cleanArtist,
                title: cleanTitle
            )
            let label = families.first(where: { $0.key == family })?.label ?? family
            message = "Added to the \(label) references. The file was not kept. Check the mix again to use it."
            artist = ""
            title = ""
            discardPicked()
        } catch {
            message = error.localizedDescription
        }
        busy = false
    }
}
