import Foundation

// MARK: - Config
// Central place for all API keys and configuration values.
// For now these are empty strings — you'll fill them in before running the app.
// In a production app, these would come from a secure keychain or build settings.

struct Config {

    // The base URL of your Supabase project (this is not a secret)
    static let supabaseURL: String = "https://mdefkqaawrusoaojstpq.supabase.co"

    // The Supabase "anon" (public) key — safe to embed in client apps
    // but still needed for API calls. Set this to your actual anon key.
    static let supabaseAnonKey: String = "" // Set your Supabase anon key

    // Replicate API key — used for AI artwork generation with FLUX
    // Get one at https://replicate.com/account/api-tokens
    static let replicateAPIKey: String = "" // Set your Replicate API key

    // Anthropic API key — used for Claude to generate artwork prompts
    // Get one at https://console.anthropic.com/settings/keys
    static let anthropicAPIKey: String = "" // Set your Anthropic API key

    // A simple password gate for v1 of the app (before real auth is added)
    static let appPassword: String = "" // Password gate for v1 auth
}
