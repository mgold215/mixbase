package app.mixbase.core

/**
 * Central configuration. Nothing here is a secret: AI generation (artwork,
 * visualizers) runs SERVER-SIDE via the web app's authenticated routes — the
 * paid Replicate/Anthropic/Runway keys live only on the server, where the
 * monthly allowance is enforced. The app authenticates those calls with the
 * user's Supabase access token (see [app.mixbase.core.api.MixbaseApi]).
 *
 * Mirrors ios/mixBase/Utilities/Config.swift.
 */
object Config {
    /** Supabase project URL (public, not a secret). */
    const val SUPABASE_URL: String = "https://mdefkqaawrusoaojstpq.supabase.co"

    /** Supabase anon key — a public key that is safe to embed in client apps. */
    const val SUPABASE_ANON_KEY: String =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU"

    /**
     * The web app — hosts the authenticated API routes for AI generation
     * (/api/generate-artwork, the /api/visualizer routes), the community feed, and the
     * public share pages.
     */
    const val API_BASE_URL: String = "https://mixbase.app"
}
