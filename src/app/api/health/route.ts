import { supabaseAdmin, serviceRoleKeyValid } from '@/lib/supabase'
import { ensureSecurityHeals, ensureAppleNativeClientId } from '@/lib/schema-heal'

// GET /api/health
// Returns 200 with service status. Checks Supabase connectivity so Railway's
// health check and external monitors can detect database outages, not just
// "process is running."
export async function GET() {
  // Re-assert the usage-RPC grant + mb_usage write lockdowns. This lives here
  // because Railway hits /api/health on every deploy, making it the only path
  // guaranteed to run — the generation path that previously owned these heals
  // is gated behind a paid user action, and as a result the lockdown had still
  // not been applied to production weeks after shipping (confirmed live via
  // pg_proc.proacl). Fire-and-forget and attempt-capped: it never blocks,
  // delays, or changes the health response, and a persistently failing heal
  // cannot turn this public endpoint into a Management-API amplifier.
  void ensureSecurityHeals()
  // Same guaranteed-execution reasoning: the Apple audience allow-list broke
  // native Sign in with Apple (App Review rejection) and no user-triggered
  // path exercises it. Memoized after success, failure-budget-capped like the
  // SQL heals, never blocks the response.
  void ensureAppleNativeClientId()

  let db: 'ok' | 'error' = 'ok'
  // Whether the admin client demonstrably has service-role POWER at runtime —
  // a degraded client (anon) still "succeeds" on RLS-filtered reads, it just
  // sees zero rows. A head-count on profiles separates the two: service sees
  // every row, anon sees none. Reported for diagnosis; deliberately NOT part
  // of `ok` so a fresh/empty database can't fail deploy health checks.
  let adminPower = false

  try {
    // Lightweight query — just check the connection, don't scan rows
    const { count, error } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
    if (error) db = 'error'
    adminPower = !error && (count ?? 0) > 0
    if (!error && !adminPower) {
      console.error('[health] admin client sees ZERO profiles — service key is likely degraded to anon')
    }
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
  return Response.json(
    { ok, db, service_key: serviceRoleKeyValid, admin_power: adminPower, ts: Date.now() },
    { status: ok ? 200 : 503 }
  )
}
