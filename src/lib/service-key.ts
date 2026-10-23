// Auth headers for a raw fetch() to Supabase with the server's service key —
// for the calls supabase-js can't make for us (the TUS upload proxy).
//
// SUPABASE_SERVICE_ROLE_KEY holds one of two kinds of key, which authenticate
// differently:
//  - legacy `service_role` key: a JWT. Storage reads it from
//    `Authorization: Bearer`; `apikey` goes alongside, as supabase-js sends it.
//  - secret key (`sb_secret_...`): NOT a JWT. Supabase only accepts it in
//    `apikey` — the gateway checks it there and forwards a short-lived
//    service-role JWT itself. Their docs: "You can't send a publishable or
//    secret key in the Authorization: Bearer header."
// The TUS routes used to send ONLY `Authorization: Bearer <key>`, which works
// for the legacy key alone — so moving to a secret key (the 2026-10-21 Railway
// env-var breach made that move mandatory) would have broken every large audio
// upload. .trim() for the same reason src/lib/supabase.ts trims: a stray newline
// pasted into a Railway variable breaks the prefix test.
export function serviceKeyHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  if (key.startsWith('sb_secret_')) return { apikey: key }
  return { apikey: key, Authorization: `Bearer ${key}` }
}
