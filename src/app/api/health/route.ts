import { supabaseAdmin } from '@/lib/supabase'

// GET /api/health
// Returns 200 with service status. Checks Supabase connectivity so Railway's
// health check and external monitors can detect database outages, not just
// "process is running."
export async function GET() {
  let db: 'ok' | 'error' = 'ok'

  try {
    // Lightweight query — just check the connection, don't scan rows
    const { error } = await supabaseAdmin.from('profiles').select('id').limit(1)
    if (error) db = 'error'
  } catch {
    db = 'error'
  }

  // Whether the service-role key is present in THIS process. Without it the
  // admin client silently falls back to the anon key: reads come back empty
  // (RLS-filtered) and every server-side write dies with an RLS violation —
  // seen in prod as profile saves / project creates failing with
  // "new row violates row-level security policy". Report it so a broken
  // replica is visible from the outside instead of half-working quietly.
  const serviceKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

  const status = db === 'ok' && serviceKey ? 200 : 503
  return Response.json({ ok: db === 'ok', db, service_key: serviceKey, ts: Date.now() }, { status })
}
