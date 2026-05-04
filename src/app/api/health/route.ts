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

  const status = db === 'ok' ? 200 : 503
  return Response.json({ ok: db === 'ok', db, ts: Date.now() }, { status })
}
