import { supabaseAdmin, serviceRoleKeyValid } from '@/lib/supabase'

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

  // Whether THIS process holds a key that actually grants service-role power —
  // not merely whether the variable is set. A missing key OR a wrong key (the
  // anon key pasted into SUPABASE_SERVICE_ROLE_KEY) both degrade the admin
  // client to anon: reads come back empty (RLS-filtered) and every server-side
  // write dies with an RLS violation — seen in prod as profile saves, project
  // creates and feed comments failing. Report it so a broken process is
  // visible from the outside (and fails deploy health checks) instead of
  // half-working quietly.
  // `ok` must agree with the HTTP status — body-parsing monitors and the
  // status-based Railway healthcheck may not contradict each other.
  const ok = db === 'ok' && serviceRoleKeyValid
  return Response.json({ ok, db, service_key: serviceRoleKeyValid, ts: Date.now() }, { status: ok ? 200 : 503 })
}
