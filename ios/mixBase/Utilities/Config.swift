import Foundation

// MARK: - Config
// Central place for all API keys and configuration values.
// Sensitive keys (Replicate, Anthropic) should be set here for local builds,
// but for App Store distribution consider fetching them from a remote config
// endpoint so they are not embedded in the binary.

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
