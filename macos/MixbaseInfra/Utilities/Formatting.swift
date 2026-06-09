import Foundation

/// Human-readable byte size. Returns "—" for nil.
func formatBytes(_ bytes: Int?) -> String {
    guard let b = bytes else { return "—" }
    let d = Double(b)
    if d < 1024 { return "\(b) B" }
    if d < 1024 * 1024 { return String(format: "%.1f KB", d / 1024) }
    if d < 1024 * 1024 * 1024 { return String(format: "%.1f MB", d / (1024 * 1024)) }
    return String(format: "%.2f GB", d / (1024 * 1024 * 1024))
}

/// Parse an ISO-8601 timestamp string into a short relative/absolute label.
func shortTimestamp(_ iso: String?) -> String {
    guard let iso = iso else { return "—" }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date = date else { return iso }
    let out = DateFormatter()
    out.dateStyle = .short
    out.timeStyle = .short
    return out.string(from: date)
}
