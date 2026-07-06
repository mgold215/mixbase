import Foundation

// MARK: - Config
// Central place for all API keys and configuration values.
//
// ⚠️ App Store distribution: the Replicate and Anthropic keys below MUST stay
// empty in any build you archive. They are paid, extractable-from-the-IPA
// secrets — shipping them in the binary is a security and cost liability.
// Instead, run AI generation server-side: call the web app's authenticated
// routes (POST /api/generate-artwork, POST /api/visualizer/runway) with the
// user's Supabase access token in an `Authorization: Bearer <token>` header.
// The middleware accepts Bearer tokens, and the keys + per-tier limits live on
// the server where they belong. Only fill these in for throwaway local builds.

struct Config {

    // Supabase project URL (public, not a secret)
    static let supabaseURL: String = "https://mdefkqaawrusoaojstpq.supabase.co"

    // Supabase anon key — public key safe to embed in client apps
    static let supabaseAnonKey: String = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU"

    // Replicate API key — used for AI artwork generation with FLUX
    // Get one at https://replicate.com/account/api-tokens
    static let replicateAPIKey: String = "" // Set your Replicate API key

    // Anthropic API key — used for Claude to generate artwork prompts
    // Get one at https://console.anthropic.com/settings/keys
    static let anthropicAPIKey: String = "" // Set your Anthropic API key
}
