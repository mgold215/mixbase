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

    // Supabase publishable key — public key safe to embed in client apps.
    // Replaced the legacy JWT `anon` key after the 2026-10-21 Railway breach:
    // the leaked legacy service_role key and JWT secret can only be revoked
    // together with that anon key, so no shipped build may depend on it.
    // Send it in `apikey` only — Supabase rejects sb_ keys as a Bearer token.
    static let supabasePublishableKey: String = "sb_publishable_z4qhiUQPNegRhalC-p-YKg_-Ubu_qpD"

    // The web app — hosts the authenticated API routes for AI generation
    // (/api/generate-artwork, /api/visualizer/*) and public share pages.
    static let apiBaseURL: String = "https://mixbase.app"
}
