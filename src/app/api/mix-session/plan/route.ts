import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { chatLimiter, rateLimitHeaders, checkUserLimit } from '@/lib/rate-limit'
import { loadMixSession } from '@/lib/mix-session-server'
import {
  buildPlanInput,
  resolvePlan,
  PLAN_MAX_NOTES,
  PLAN_OUTPUT_SCHEMA,
  PLAN_SYSTEM_PROMPT,
} from '@/lib/mix-session'

export const runtime = 'nodejs'
// A big session at medium effort can run past a minute.
export const maxDuration = 300

const MODEL = 'claude-opus-5-5'

// POST /api/mix-session/plan — the session assistant. Claude turns the open
// notes on your current mixes into an ordered plan for one sitting: notes that
// ask for the same fix merged into one step, steps in the order an engineer
// works (low end and balance before polish), disagreements between listeners
// called out instead of silently resolved. Every step cites the notes it
// covers, so ticking a step ticks those notes.
//
// Body: { project_ids?: string[] }  — omit to plan every song with open notes
// Returns: { plan: { overview, songs: [...] }, note_count, model }
//
// User-facing copy calls this "Organize with AI" / "Session order", and no
// error below says "plan": the app replaces any server message containing
// purchase-shaped words ("plan" among them) with generic copy.
//
// Not stored: a plan is a view of the notes at that moment; tick notes off and
// ask again for a fresh one. Shares the hourly AI budget with the feedback
// summary (chatLimiter). Not part of the monthly artwork/video allowance.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('[mix-session/plan] ANTHROPIC_API_KEY is not set')
    return NextResponse.json({ error: 'The session assistant is temporarily unavailable.' }, { status: 503 })
  }

  const body: unknown = await request.json().catch(() => ({}))
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  let only: Set<string> | null = null
  if (body.project_ids !== undefined) {
    if (!Array.isArray(body.project_ids) || body.project_ids.length === 0) {
      return NextResponse.json({ error: 'project_ids must be a non-empty list' }, { status: 400 })
    }
    const ids = body.project_ids.map(canonicalUuid)
    if (ids.some(id => !id)) return NextResponse.json({ error: 'project_ids must be project ids' }, { status: 400 })
    only = new Set(ids as string[])
  }

  const limit = await checkUserLimit(chatLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Hourly AI request limit reached. Try again later.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    )
  }

  let loaded
  try {
    loaded = await loadMixSession(userId)
  } catch (err) {
    console.error('[mix-session/plan] load failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your notes. Try again.' }, { status: 500 })
  }

  const songs = loaded.session.songs.filter(s => s.open_count > 0 && (!only || only.has(s.project_id)))
  const meta = new Map(loaded.projects.map(p => [p.id, p]))
  const input = buildPlanInput(songs, meta)
  if (input.noteCount === 0) {
    return NextResponse.json({ error: 'No open notes to organize.' }, { status: 400 })
  }
  if (input.noteCount > PLAN_MAX_NOTES) {
    return NextResponse.json(
      { error: `That's ${input.noteCount} open notes — too many at once. Pick fewer songs.` },
      { status: 400 },
    )
  }

  const client = new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: PLAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: PLAN_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: 'user', content: `Open notes for this session:\n\n${input.text}` }],
    })

    if (response.stop_reason === 'refusal') {
      return NextResponse.json({ error: 'The assistant couldn’t organize these notes. Try fewer songs.' }, { status: 502 })
    }
    if (response.stop_reason === 'max_tokens') {
      return NextResponse.json({ error: 'That came out too long. Try fewer songs at a time.' }, { status: 502 })
    }
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(b => b.text)
      .join('')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      console.error('[mix-session/plan] unparseable model output')
      return NextResponse.json({ error: 'The assistant’s answer was unreadable. Try again.' }, { status: 502 })
    }

    return NextResponse.json({
      plan: resolvePlan(raw, input.refs),
      note_count: input.noteCount,
      model: response.model,
    })
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: 'The AI service is busy. Try again shortly.' }, { status: 429 })
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[mix-session/plan] API error:', err.status, err.message)
      return NextResponse.json({ error: 'The session assistant hit an error. Try again.' }, { status: 502 })
    }
    console.error('[mix-session/plan] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'The session assistant hit an error. Try again.' }, { status: 500 })
  }
}
