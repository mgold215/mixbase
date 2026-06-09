import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { railwayRestart, railwayRedeploy, rerunCI, type ActionResult } from '@/lib/infra/actions'

export const dynamic = 'force-dynamic'

// POST /api/infra/actions — phase-3 SAFE, reversible control actions. Admin only.
// Body: { provider, action, environment?, branch?, confirm: true }
//   railway: action 'restart' | 'redeploy', environment 'production' | 'staging'
//   github:  action 'rerun-ci', branch (default 'tst')
// Requires confirm:true so a stray request can never mutate infra. Destructive
// operations are intentionally not supported here.
export async function POST(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: {
    provider?: string
    action?: string
    environment?: string
    branch?: string
    confirm?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.confirm !== true) {
    return NextResponse.json({ ok: false, message: 'Confirmation required (confirm:true).' }, { status: 400 })
  }

  const env = body.environment === 'production' || body.environment === 'staging' ? body.environment : null

  let result: ActionResult
  if (body.provider === 'railway' && body.action === 'restart' && env) {
    result = await railwayRestart(env)
  } else if (body.provider === 'railway' && body.action === 'redeploy' && env) {
    result = await railwayRedeploy(env)
  } else if (body.provider === 'github' && body.action === 'rerun-ci') {
    result = await rerunCI(body.branch === 'main' ? 'main' : 'tst')
  } else {
    return NextResponse.json({ ok: false, message: 'Unsupported or malformed action.' }, { status: 400 })
  }

  // 200 even on ok:false so the client renders the message rather than a generic error.
  return NextResponse.json(result)
}
