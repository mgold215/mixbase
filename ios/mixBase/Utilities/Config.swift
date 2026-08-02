import Foundation

// MARK: - Config
// Central place for configuration values. Nothing here is a secret: AI
// generation (artwork, visualizers) runs SERVER-SIDE via the web app's
// authenticated routes — the paid Replicate/Anthropic/Runway keys live only on
// the server, where per-tier limits are enforced. The app authenticates those
// calls with the user's Supabase access token (see MixbaseAPI).

struct Config {

    // Supabase project URL (public, not a secret)
    static let supabaseURL: String = "https://mdefkqaawrusoaojstpq.supabase.co"

    // Supabase anon key — public key safe to embed in client apps
    static let supabaseAnonKey: String = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU"

    // The web app — hosts the authenticated API routes for AI generation
    // (/api/generate-artwork, /api/visualizer/*) and public share pages.
    static let apiBaseURL: String = "https://mixbase.app"
}
