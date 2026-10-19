import SwiftUI

// MARK: - MixSessionView
// Native twin of the web's /session page: every note on each song's CURRENT
// mix — your own mix notes and listener feedback — as one worklist you tick
// off as you work. Tap a timestamp to hear that moment. "Organize with AI"
// asks the session assistant to merge duplicate notes, put the work in the
// order an engineer would do it, and flag where listeners disagree.
//
// Everything comes from the server (GET /api/mix-session, PATCH
// /api/mix-session/notes/[id], POST /api/mix-session/plan — the same routes
// the web uses); this view only renders it. "Current mix", note order, mix
// names and the shareable text are never re-derived here.

struct MixSessionView: View {

    @EnvironmentObject var audioService: AudioService

    /// Lets Home keep its open-note count in step with what's ticked here.
    var onOpenCountChange: ((Int) -> Void)? = nil

    @State private var session: MixbaseAPI.MixSession?
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var showDone = false
    @State private var organizing: OrganizeTarget?
    @State private var plan: MixbaseAPI.SessionPlan?
    @State private var shareText: ShareText?

    private enum OrganizeTarget: Equatable {
        case all
        case song(UUID)
    }

    private struct ShareText: Identifiable {
        let id = UUID()
        let text: String
    }

    private struct NoteRef {
        let note: MixbaseAPI.SessionNote
        let song: MixbaseAPI.SessionSong
    }

    private let teal = Color(hex: "#2dd4bf")

    private var openCount: Int {
        session?.songs.reduce(0) { $0 + $1.openCount } ?? 0
    }

    private var doneCount: Int {
        session?.songs.reduce(0) { $0 + $1.doneCount } ?? 0
    }

    private var canTick: Bool {
        session?.doneSupported == true
    }

    // Every song stays on screen — ticking a song's last note shouldn't make
    // its card vanish mid-session; it collapses to "All done" instead.
    private var visibleSongs: [MixbaseAPI.SessionSong] {
        session?.songs ?? []
    }

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            content
        }
        .navigationTitle("Mix Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: { Task { await openShareSheet() } }) {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(openCount == 0)
                .accessibilityLabel(Text("Share the open notes"))
            }
        }
        .sheet(item: $shareText) { item in
            SessionListSheet(text: item.text)
        }
        .task {
            if session == nil { await load() }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let loaded = session {
            if loaded.songs.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header

                        if !loaded.doneSupported {
                            Text("Ticking notes off isn't available yet — it switches on automatically within a few minutes.")
                                .font(.caption)
                                .foregroundColor(.gray)
                                .padding(.horizontal)
                        }

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundColor(.red)
                                .padding(.horizontal)
                        }

                        if openCount == 0 {
                            Text("Every note is done. Nice.")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }

                        if let plan {
                            planCard(plan)
                        }

                        ForEach(visibleSongs) { song in
                            songCard(song)
                        }

                        Spacer(minLength: 80)
                    }
                    .padding(.top, 12)
                }
                .refreshable {
                    await load()
                }
            }
        } else if let loadError {
            VStack(spacing: 12) {
                Text(loadError)
                    .font(.subheadline)
                    .foregroundColor(.gray)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await load() } }
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(teal)
            }
            .padding()
        } else {
            ProgressView()
                .tint(teal)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "checklist")
                .font(.system(size: 36))
                .foregroundColor(.gray.opacity(0.3))
            Text("No notes on your current mixes yet.")
                .font(.subheadline)
                .foregroundColor(Color(hex: "#f0f0f0"))
            Text("Add notes while you listen in the Player, or share a mix to collect feedback.")
                .font(.caption)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
        }
        .padding(32)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("\(openCount) open")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(Color(hex: "#f0f0f0"))
                Text("· \(doneCount) done")
                    .font(.subheadline)
                    .foregroundColor(.gray)
                Spacer()
                if doneCount > 0 {
                    Button(action: { withAnimation(.easeOut(duration: 0.15)) { showDone.toggle() } }) {
                        Text(showDone ? "Hide done" : "Show done")
                            .font(.caption.weight(.medium))
                            .foregroundColor(teal)
                    }
                    .buttonStyle(.plain)
                }
            }

            Button(action: { organize(nil) }) {
                HStack(spacing: 8) {
                    if organizing == .all {
                        ProgressView()
                            .tint(Color(hex: "#080808"))
                        Text("Organizing…")
                    } else {
                        Image(systemName: "sparkles")
                        Text("Organize with AI")
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundColor(Color(hex: "#080808"))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(openCount == 0 || organizing != nil ? Color.gray.opacity(0.4) : teal)
                .cornerRadius(10)
            }
            .buttonStyle(.plain)
            .disabled(openCount == 0 || organizing != nil)

            Text("Puts your open notes in the order you'd tackle them at the desk, merges duplicates and flags where listeners disagree.")
                .font(.caption2)
                .foregroundColor(.gray)
        }
        .padding(.horizontal)
    }

    // MARK: - Song card

    private func songCard(_ song: MixbaseAPI.SessionSong) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                artwork(song.artworkUrl)
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                VStack(alignment: .leading, spacing: 2) {
                    Text(song.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .lineLimit(1)
                    Text("\(song.versionLabel) · \(Self.openSummary(song))")
                        .font(.caption2)
                        .foregroundColor(.gray)
                }

                Spacer()

                if song.openCount > 0 {
                    Button(action: { organize(song.projectId) }) {
                        HStack(spacing: 4) {
                            if organizing == .song(song.projectId) {
                                ProgressView()
                                    .scaleEffect(0.7)
                                    .tint(teal)
                            } else {
                                Image(systemName: "sparkles")
                            }
                            Text("Organize")
                        }
                        .font(.caption.weight(.medium))
                        .foregroundColor(teal)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(teal.opacity(0.12))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(organizing != nil)
                }
            }
            .padding(12)

            ForEach(song.notes.filter { showDone || !$0.done }) { note in
                Rectangle()
                    .fill(Color(hex: "#1f1f1f"))
                    .frame(height: 1)
                noteRow(note, song: song)
            }

            if song.openCount == 0 && !showDone {
                Text("All done — upload the next mix when it's ready.")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .padding(12)
            }
        }
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
        .padding(.horizontal)
    }

    private func noteRow(_ note: MixbaseAPI.SessionNote, song: MixbaseAPI.SessionSong, compact: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if canTick {
                Button(action: { toggle([note.id], done: !note.done) }) {
                    ZStack {
                        Circle()
                            .stroke(note.done ? teal : Color.gray, lineWidth: 1.5)
                        if note.done {
                            Circle()
                                .fill(teal)
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(Color(hex: "#080808"))
                        }
                    }
                    .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(note.done ? "Mark as not done" : "Mark as done"))
            }

            if let at = note.atSeconds {
                Button(action: { play(song, at: at) }) {
                    Text(Self.clock(at))
                        .font(.caption.monospacedDigit())
                        .foregroundColor(teal)
                        .frame(minWidth: 36)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(teal.opacity(0.12))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Play from \(Self.clock(at))"))
            } else {
                // Same width as a time chip, so whole-mix notes line up.
                Text("—")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .frame(minWidth: 36)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .accessibilityLabel(Text("Whole-mix note"))
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(note.comment)
                    .font(.subheadline)
                    .foregroundColor(note.done ? .gray : Color(hex: "#f0f0f0"))
                    .strikethrough(note.done, color: .gray)
                    .fixedSize(horizontal: false, vertical: true)
                if !note.own {
                    Text(Self.reviewerLine(note))
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, compact ? 0 : 12)
        .padding(.vertical, compact ? 4 : 10)
    }

    @ViewBuilder
    private func artwork(_ urlString: String?) -> some View {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { image in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } placeholder: {
                Color(hex: "#1a1a1a")
            }
        } else {
            Color(hex: "#1a1a1a")
                .overlay(
                    Image(systemName: "music.note")
                        .font(.caption)
                        .foregroundColor(.gray)
                )
        }
    }

    // MARK: - Session order (AI)

    private func planCard(_ plan: MixbaseAPI.SessionPlan) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "sparkles")
                    .foregroundColor(teal)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Session order")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(Color(hex: "#f0f0f0"))
                    if !plan.overview.isEmpty {
                        Text(plan.overview)
                            .font(.caption)
                            .foregroundColor(.gray)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer()
                Button(action: { withAnimation { self.plan = nil } }) {
                    Image(systemName: "xmark")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Close session order"))
            }

            ForEach(plan.songs) { planSong in
                VStack(alignment: .leading, spacing: 8) {
                    Text(planSong.title)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(Color(hex: "#f0f0f0"))
                    if !planSong.focus.isEmpty {
                        Text(planSong.focus)
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }

                    ForEach(Array(planSong.steps.enumerated()), id: \.offset) { index, step in
                        planStepRow(step, number: index + 1)
                    }

                    ForEach(planSong.conflicts, id: \.self) { conflict in
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.caption2)
                                .foregroundColor(.yellow)
                            Text(conflict)
                                .font(.caption)
                                .foregroundColor(.gray)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(Color(hex: "#111111"))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(teal.opacity(0.4), lineWidth: 1)
        )
        .padding(.horizontal)
    }

    private func planStepRow(_ step: MixbaseAPI.PlanStep, number: Int) -> some View {
        let entries = step.noteIds.compactMap { lookup($0) }
        let allDone = !entries.isEmpty && entries.allSatisfy { $0.note.done }

        return HStack(alignment: .top, spacing: 8) {
            Text("\(number)")
                .font(.caption.monospacedDigit())
                .foregroundColor(.gray)
                .frame(width: 16, alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(step.priorityLabel.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundColor(Self.priorityColor(step.priority))
                    Text("· \(step.areaLabel)")
                        .font(.caption2)
                        .foregroundColor(.gray)
                    if let at = step.atSeconds, let song = entries.first?.song {
                        Button(action: { play(song, at: at) }) {
                            Text(Self.clock(at))
                                .font(.caption2.monospacedDigit())
                                .foregroundColor(teal)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(teal.opacity(0.12))
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }

                Text(step.action)
                    .font(.subheadline)
                    .foregroundColor(allDone ? .gray : Color(hex: "#f0f0f0"))
                    .strikethrough(allDone, color: .gray)
                    .fixedSize(horizontal: false, vertical: true)

                ForEach(entries, id: \.note.id) { entry in
                    noteRow(entry.note, song: entry.song, compact: true)
                }
            }

            Spacer(minLength: 0)

            if canTick && !entries.isEmpty {
                Button(action: { toggle(entries.map { $0.note.id }, done: !allDone) }) {
                    Text(allDone ? "Undo" : "Done")
                        .font(.caption.weight(.medium))
                        .foregroundColor(allDone ? .gray : teal)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .background(Color(hex: "#161616"))
        .cornerRadius(8)
        .opacity(allDone ? 0.6 : 1)
    }

    // MARK: - Actions

    private func load() async {
        do {
            let fresh = try await MixbaseAPI.shared.mixSession()
            session = fresh
            loadError = nil
            errorMessage = nil
            onOpenCountChange?(fresh.songs.reduce(0) { $0 + $1.openCount })
        } catch {
            if session == nil {
                loadError = error.localizedDescription
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func lookup(_ id: UUID) -> NoteRef? {
        guard let session else { return nil }
        for song in session.songs {
            if let note = song.notes.first(where: { $0.id == id }) {
                return NoteRef(note: note, song: song)
            }
        }
        return nil
    }

    private func applyDone(_ values: [UUID: Bool]) {
        guard var updated = session else { return }
        for s in updated.songs.indices {
            for n in updated.songs[s].notes.indices {
                if let value = values[updated.songs[s].notes[n].id] {
                    updated.songs[s].notes[n].done = value
                }
            }
        }
        session = updated
    }

    /// Optimistic tick; the server is the record, so anything it refuses rolls back.
    private func toggle(_ ids: [UUID], done: Bool) {
        var before: [UUID: Bool] = [:]
        for id in ids {
            if let ref = lookup(id) { before[id] = ref.note.done }
        }
        applyDone(Dictionary(uniqueKeysWithValues: ids.map { ($0, done) }))
        errorMessage = nil

        Task {
            let failures: [(UUID, String)] = await withTaskGroup(of: (UUID, String?).self) { group in
                for id in ids {
                    group.addTask {
                        do {
                            try await MixbaseAPI.shared.setNoteDone(noteId: id, done: done)
                            return (id, nil)
                        } catch {
                            return (id, error.localizedDescription)
                        }
                    }
                }
                var failed: [(UUID, String)] = []
                for await (id, message) in group {
                    if let message { failed.append((id, message)) }
                }
                return failed
            }

            if let first = failures.first {
                var revert: [UUID: Bool] = [:]
                for (id, _) in failures { revert[id] = before[id] ?? !done }
                applyDone(revert)
                errorMessage = first.1
            }
            onOpenCountChange?(openCount)
        }
    }

    private func organize(_ projectId: UUID?) {
        organizing = projectId.map { OrganizeTarget.song($0) } ?? OrganizeTarget.all
        errorMessage = nil

        Task {
            do {
                let result = try await MixbaseAPI.shared.organizeSession(projectIds: projectId.map { [$0] })
                withAnimation { plan = result }
            } catch {
                errorMessage = error.localizedDescription
            }
            organizing = nil
        }
    }

    /// Same pattern as the project screen's feedback chips: start this mix if
    /// it isn't the one playing, then jump to the note's moment.
    private func play(_ song: MixbaseAPI.SessionSong, at seconds: Int) {
        if audioService.currentVersion?.id != song.version.id {
            audioService.play(
                version: song.version,
                trackName: song.title,
                artworkUrl: song.artworkUrl,
                visualizerUrl: song.visualizerUrl
            )
        } else if !audioService.isPlaying {
            audioService.resume()
        }
        audioService.seek(to: Double(seconds))
    }

    /// Always the server's current text, so it matches what's ticked right now.
    private func openShareSheet() async {
        do {
            let fresh = try await MixbaseAPI.shared.mixSession()
            shareText = ShareText(text: fresh.text)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Formatting

    private static func clock(_ seconds: Int) -> String {
        "\(seconds / 60):" + String(format: "%02d", seconds % 60)
    }

    private static func openSummary(_ song: MixbaseAPI.SessionSong) -> String {
        song.openCount > 0 ? "\(song.openCount) open" : "all done"
    }

    private static func reviewerLine(_ note: MixbaseAPI.SessionNote) -> String {
        guard let rating = note.rating, rating > 0 else { return note.reviewer }
        return "\(note.reviewer) · " + String(repeating: "★", count: min(rating, 5))
    }

    private static func priorityColor(_ priority: String) -> Color {
        switch priority {
        case "high": return Color(hex: "#f87171")
        case "medium": return .yellow
        default: return .gray
        }
    }
}

// MARK: - SessionListSheet
// The open notes as plain text (the server's own rendering) — copy it or send
// it anywhere: into the DAW's notes, to an engineer, to yourself.

private struct SessionListSheet: View {
    let text: String

    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808")
                    .ignoresSafeArea()

                ScrollView {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
            }
            .navigationTitle("Open notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: text) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: {
                        UIPasteboard.general.string = text
                        copied = true
                    }) {
                        Text(copied ? "Copied" : "Copy")
                    }
                }
            }
        }
    }
}
