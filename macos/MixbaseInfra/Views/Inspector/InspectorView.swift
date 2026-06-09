import SwiftUI

struct InspectorView: View {
    @EnvironmentObject var vm: TopologyViewModel

    var body: some View {
        ScrollView {
            if let node = vm.selectedNode {
                VStack(alignment: .leading, spacing: 16) {
                    header(node)
                    Divider().overlay(Color.white.opacity(0.08))
                    switch node.provider {
                    case "railway":  railwaySection(node)
                    case "supabase": supabaseSection(node)
                    case "github":   githubSection()
                    case "stripe":   stripeSection()
                    case "sentry":   sentrySection()
                    default:         staticSection(node)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                placeholder
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.panel)
    }

    // MARK: - Header

    private func header(_ node: InfraNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: ProviderStyle.icon(node.provider))
                    .foregroundStyle(NodeStatusStyle.color(for: node.status))
                Text(node.label).font(.system(size: 16, weight: .bold))
            }
            HStack(spacing: 6) {
                Circle().fill(NodeStatusStyle.color(for: node.status)).frame(width: 8, height: 8)
                Text(NodeStatusStyle.label(for: node.status))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(NodeStatusStyle.color(for: node.status))
                if let metric = node.metric, !metric.isEmpty {
                    Text("· \(metric)").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            if let detail = node.detail {
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Railway

    @ViewBuilder
    private func railwaySection(_ node: InfraNode) -> some View {
        if let env = vm.railwayEnvironment(for: node) {
            section("Liveness (/api/health)") {
                infoRow("Reachable", env.health.ok ? "yes" : "no")
                infoRow("Database", env.health.db)
                if let code = env.health.httpStatus { infoRow("HTTP", "\(code)") }
                if let ms = env.health.latencyMs { infoRow("Latency", "\(ms) ms") }
                if let err = env.health.error { infoRow("Error", err) }
                infoRow("URL", env.url)
            }
            if let dep = env.deployment {
                section("Latest deployment") {
                    infoRow("Status", dep.status ?? "—")
                    if let when = dep.createdAt { infoRow("Created", shortTimestamp(when)) }
                    if let url = dep.url { infoRow("URL", url) }
                }
            } else if vm.railway?.configured == false {
                note("RAILWAY_API_TOKEN isn't set — showing app liveness only. Add it in Railway env vars for deploy status & metrics.")
            } else {
                note("No deployment record returned for this environment.")
            }
        } else {
            note("No live Railway data for this node.")
        }
        if let err = vm.railway?.error {
            note("Railway API: \(err)")
        }
    }

    // MARK: - Supabase

    @ViewBuilder
    private func supabaseSection(_ node: InfraNode) -> some View {
        if let supa = vm.supabase {
            if node.id == "supabase-storage" {
                section("Storage buckets") {
                    ForEach(supa.storage.buckets) { bucket in
                        infoRow(
                            bucket.name,
                            "\(formatBytes(bucket.usedBytes)) used" + (bucket.objectCount != nil ? " · \(bucket.objectCount!) objects" : "")
                        )
                    }
                    infoRow("Total used", formatBytes(supa.storage.totalUsedBytes))
                }
                signals(supa.scalingSignals.filter { $0.id == "storage_total" })
            } else {
                section("Database") {
                    infoRow("Size", formatBytes(supa.db.sizeBytes))
                    infoRow("Migrations", supa.db.migrations != nil ? "\(supa.db.migrations!.count) applied" : "—")
                    infoRow("Project ref", supa.projectRef ?? "—")
                }
                signals(supa.scalingSignals.filter { $0.id == "db_size" })
                section("Row counts") {
                    ForEach(supa.tables.sorted { ($0.rowCount ?? -1) > ($1.rowCount ?? -1) }) { t in
                        infoRow(t.table, t.rowCount != nil ? "\(t.rowCount!)" : (t.error != nil ? "n/a" : "—"))
                    }
                }
            }
            if !supa.managementConfigured {
                note("SUPABASE_MANAGEMENT_TOKEN isn't set — row counts & bucket list shown, but DB size / per-bucket bytes / migrations are unavailable.")
            }
        } else {
            note("No live Supabase data.")
        }
    }

    // MARK: - GitHub

    @ViewBuilder
    private func githubSection() -> some View {
        if let gh = vm.github {
            section("CI runs (\(gh.repo))") {
                if gh.runs.isEmpty {
                    infoRow("Status", gh.error ?? "no recent runs")
                } else {
                    ForEach(gh.runs) { run in
                        infoRow(run.branch, run.conclusion ?? run.status ?? "—")
                    }
                }
            }
            if !gh.authenticated {
                note("Unauthenticated GitHub access (public repo). Set GITHUB_TOKEN to raise the API rate limit.")
            }
        } else {
            note("No live GitHub data.")
        }
    }

    // MARK: - Stripe

    @ViewBuilder
    private func stripeSection() -> some View {
        if let st = vm.stripe {
            section("Billing") {
                infoRow("Est. MRR", String(format: "$%.2f/mo", Double(st.estimatedMrrCents) / 100.0))
                infoRow("Active subscriptions", st.activeSubscriptions != nil ? "\(st.activeSubscriptions!)" : "—")
            }
            section("Subscribers by tier") {
                ForEach(["free", "pro", "studio", "admin"], id: \.self) { tier in
                    infoRow(tier, "\(st.tierCounts[tier] ?? 0)")
                }
            }
            if !st.configured {
                note("STRIPE_SECRET_KEY isn't set — tier counts come from the profiles table; live subscription count is unavailable.")
            }
        } else {
            note("No live Stripe data.")
        }
    }

    // MARK: - Sentry

    @ViewBuilder
    private func sentrySection() -> some View {
        if let se = vm.sentry {
            if !se.configured {
                note("SENTRY_AUTH_TOKEN isn't set — error monitoring data is unavailable. Set it (project:read) to light up this node.")
            } else {
                section("Recent unresolved issues (\(se.org)/\(se.project))") {
                    if let issues = se.recentIssues, !issues.isEmpty {
                        ForEach(issues) { issue in
                            infoRow(issue.title, "×\(issue.count)")
                        }
                    } else {
                        infoRow("Open issues", se.error ?? "none 🎉")
                    }
                }
            }
        } else {
            note("No live Sentry data.")
        }
    }

    // MARK: - Static / external

    private func staticSection(_ node: InfraNode) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            note("This node is part of the architecture but isn't live-probed in phase 1. Railway & Supabase are the live integrations; GitHub, Stripe, Sentry and the AI providers come online in phase 2.")
            infoRow("Provider", node.provider)
            infoRow("Type", node.type)
            infoRow("Layer", node.layer)
        }
    }

    // MARK: - Building blocks

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) { content() }
        }
    }

    private func infoRow(_ key: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(key).font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func signals(_ list: [SupabaseStatus.ScalingSignal]) -> some View {
        if !list.isEmpty {
            section("Scaling signals") {
                ForEach(list) { ScalingSignalBar(signal: $0) }
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.04)))
    }

    private var placeholder: some View {
        VStack(spacing: 10) {
            Image(systemName: "cursorarrow.rays").font(.system(size: 28)).foregroundStyle(.secondary)
            Text("Select a node").font(.system(size: 14, weight: .semibold))
            Text("Click any box in the diagram to inspect live status, metrics, and scaling signals.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: .infinity, minHeight: 400)
    }
}
