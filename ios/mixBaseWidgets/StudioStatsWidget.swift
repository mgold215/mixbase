import WidgetKit
import SwiftUI

// MARK: - Studio Stats widget
// The Home tab's three counters (Projects / Mixing / Pipeline) on the Home
// Screen. Numbers come from the snapshot HomeView writes after each dashboard
// load — the widget itself never talks to Supabase.

struct StudioStatsEntry: TimelineEntry {
    let date: Date
    let stats: StudioStatsSnapshot?
}

struct StudioStatsProvider: TimelineProvider {

    func placeholder(in context: Context) -> StudioStatsEntry {
        StudioStatsEntry(date: Date(), stats: StudioStatsSnapshot(projects: 54, mixing: 24, pipeline: 6, updatedAt: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (StudioStatsEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StudioStatsEntry>) -> Void) {
        // Refreshed by the app after each dashboard load; nothing to schedule.
        completion(Timeline(entries: [currentEntry()], policy: .never))
    }

    private func currentEntry() -> StudioStatsEntry {
        StudioStatsEntry(date: Date(), stats: NowPlayingStore.loadStats())
    }
}

struct StudioStatsWidget: Widget {

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: NowPlayingStore.statsWidgetKind, provider: StudioStatsProvider()) { entry in
            StudioStatsWidgetView(entry: entry)
        }
        .configurationDisplayName("Studio Stats")
        .description("Your project, mixing and pipeline counts, with quick actions.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Views

struct StudioStatsWidgetView: View {

    @Environment(\.widgetFamily) private var family

    let entry: StudioStatsEntry

    private static let yellow = Color(red: 1.0, green: 0.8, blue: 0.0)

    var body: some View {
        Group {
            switch family {
            case .systemLarge:
                largeView
            case .systemMedium:
                mediumView
            default:
                smallView
            }
        }
        .containerBackground(for: .widget) { MBTheme.background }
    }

    // MARK: Small — stacked rows

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 0) {
            MBWordmark(size: 14)
            Spacer()
            if let stats = entry.stats {
                VStack(alignment: .leading, spacing: 7) {
                    statRow(value: stats.projects, label: "Projects", color: MBTheme.text)
                    statRow(value: stats.mixing, label: "Mixing", color: Self.yellow)
                    statRow(value: stats.pipeline, label: "Pipeline", color: MBTheme.teal)
                }
            } else {
                openAppHint
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "mixbase://home"))
    }

    private func statRow(value: Int, label: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("\(value)")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(color)
            Text(label)
                .font(.system(size: 11))
                .foregroundColor(MBTheme.text.opacity(0.55))
        }
    }

    // MARK: Medium — three cards, each deep-linking to its tab

    private var mediumView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                MBWordmark(size: 14)
                Spacer()
                newProjectPill
            }
            if let stats = entry.stats {
                HStack(spacing: 10) {
                    statCard(value: stats.projects, label: "Projects", color: MBTheme.text, link: "mixbase://projects")
                    statCard(value: stats.mixing, label: "Mixing", color: Self.yellow, link: "mixbase://projects")
                    statCard(value: stats.pipeline, label: "Pipeline", color: MBTheme.teal, link: "mixbase://pipeline")
                }
            } else {
                openAppHint
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "mixbase://home"))
    }

    private func statCard(value: Int, label: String, color: Color, link: String) -> some View {
        let card = VStack(spacing: 3) {
            Text("\(value)")
                .font(.system(size: 24, weight: .bold))
                .foregroundColor(color)
            Text(label)
                .font(.system(size: 11))
                .foregroundColor(MBTheme.text.opacity(0.55))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(MBTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 12))

        return Group {
            if let url = URL(string: link) {
                Link(destination: url) { card }
            } else {
                card
            }
        }
    }

    // MARK: Large — stats plus a quick-actions row

    private var largeView: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                MBWordmark(size: 16)
                Spacer()
                newProjectPill
            }

            if let stats = entry.stats {
                HStack(spacing: 10) {
                    statCard(value: stats.projects, label: "Projects", color: MBTheme.text, link: "mixbase://projects")
                    statCard(value: stats.mixing, label: "Mixing", color: Self.yellow, link: "mixbase://projects")
                    statCard(value: stats.pipeline, label: "Pipeline", color: MBTheme.teal, link: "mixbase://pipeline")
                }
            } else {
                openAppHint
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
            }

            Spacer(minLength: 0)

            VStack(alignment: .leading, spacing: 8) {
                Text("QUICK ACTIONS")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1)
                    .foregroundColor(MBTheme.text.opacity(0.4))
                HStack(spacing: 10) {
                    actionCard(icon: "play.circle.fill", label: "Player", link: "mixbase://player")
                    actionCard(icon: "photo.on.rectangle", label: "Artwork", link: "mixbase://artwork")
                    actionCard(icon: "checklist", label: "Pipeline", link: "mixbase://pipeline")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "mixbase://home"))
    }

    /// Jumps straight into the New Project sheet (mixbase://new-project —
    /// ContentView routes it, ProjectsView opens the sheet).
    private var newProjectPill: some View {
        Group {
            if let url = URL(string: "mixbase://new-project") {
                Link(destination: url) {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                            .font(.system(size: 10, weight: .bold))
                        Text("New Project")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundColor(.black)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(MBTheme.teal)
                    .clipShape(Capsule())
                }
            }
        }
    }

    private func actionCard(icon: String, label: String, link: String) -> some View {
        let card = VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundColor(MBTheme.teal)
            Text(label)
                .font(.system(size: 11))
                .foregroundColor(MBTheme.text.opacity(0.7))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(MBTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 12))

        return Group {
            if let url = URL(string: link) {
                Link(destination: url) { card }
            } else {
                card
            }
        }
    }

    private var openAppHint: some View {
        Text("Open mixBASE to load your stats")
            .font(.system(size: 11))
            .foregroundColor(MBTheme.text.opacity(0.5))
    }
}
