import SwiftUI

// Maps backend status / provider strings to colors, icons, and labels.

enum NodeStatusStyle {
    static func color(for status: String) -> Color {
        switch status {
        case "ok":             return Color(hex: "34d399") // emerald
        case "degraded":       return Color(hex: "fbbf24") // amber
        case "down":           return Color(hex: "f87171") // red
        case "not_configured": return Color(hex: "9ca3af") // gray
        case "static":         return Color(hex: "64748b") // slate
        default:               return Color(hex: "64748b")
        }
    }

    static func label(for status: String) -> String {
        switch status {
        case "ok": return "Healthy"
        case "degraded": return "Degraded"
        case "down": return "Down"
        case "not_configured": return "Not configured"
        case "static": return "Not probed"
        case "unknown": return "Unknown"
        default: return status.capitalized
        }
    }
}

enum ProviderStyle {
    static func icon(_ provider: String) -> String {
        switch provider {
        case "railway":   return "arrow.triangle.branch"
        case "supabase":  return "cylinder.split.1x2.fill"
        case "web":       return "globe"
        case "apple":     return "apple.logo"
        case "namecheap": return "network"
        case "anthropic": return "sparkles"
        case "replicate": return "photo.artframe"
        case "runway":    return "film.fill"
        case "stripe":    return "creditcard.fill"
        case "sentry":    return "exclamationmark.triangle.fill"
        case "github":    return "chevron.left.forwardslash.chevron.right"
        default:          return "square.dashed"
        }
    }
}
