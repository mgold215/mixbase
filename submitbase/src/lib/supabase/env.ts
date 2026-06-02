// Public Supabase connection values.
//
// These are SAFE to ship in source: the anon/publishable key is a public key,
// and all access is gated by Row Level Security (see schema.sql). Setting the
// matching NEXT_PUBLIC_* env vars overrides these; the fallbacks just make the
// app work out-of-the-box (and keep the production build from failing when
// env vars aren't present at build time).
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://mdefkqaawrusoaojstpq.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "sb_publishable_z4qhiUQPNegRhalC-p-YKg_-Ubu_qpD";
