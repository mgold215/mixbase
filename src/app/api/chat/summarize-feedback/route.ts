import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { chatLimiter } from '@/lib/rate-limit'

// POST /api/chat/summarize-feedback — condense listener feedback for a version
// into actionable mix notes using Claude.
//
// Body: { version_id: string }
// Returns: { summary: string, feedback_count: number, model: string }
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI summarization is not configured. Set ANTHROPIC_API_KEY.' },
      { status: 503 },
    )
  }

  const limit = chatLimiter.check(userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Hourly AI request limit reached. Try again later.' },
      { status: 429 },
    )
  }

  const { version_id } = await request.json().catch(() => ({}))
  if (!version_id || typeof version_id !== 'string') {
    return NextResponse.json({ error: 'version_id is required' }, { status: 400 })
  }

  // Verify the user owns the project that contains this version, and load
  // the surrounding context in one round-trip.
  const { data: version, error: vErr } = await supabaseAdmin
    .from('mb_versions')
    .select('id, version_number, label, project_id, mb_projects!inner(title, genre, bpm, user_id)')
    .eq('id', version_id)
    .single<{
      id: string
      version_number: number
      label: string | null
      project_id: string
      mb_projects: { title: string; genre: string | null; bpm: number | null; user_id: string }
    }>()

  if (vErr || !version) {
    return NextResponse.json({ error: 'Version not found' }, { status: 404 })
  }
  if (version.mb_projects.user_id !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: feedback, error: fErr } = await supabaseAdmin
    .from('mb_feedback')
    .select('reviewer_name, rating, comment, created_at')
    .eq('version_id', version_id)
    .order('created_at', { ascending: true })

  if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 })
  if (!feedback || feedback.length === 0) {
    return NextResponse.json({ error: 'No feedback yet on this version' }, { status: 400 })
  }

  const project = version.mb_projects
  const versionLabel = version.label || `Mix ${version.version_number}`

  const feedbackBlock = feedback
    .map((f, i) => {
      const stars = f.rating ? ` (${f.rating}/5 stars)` : ''
      return `${i + 1}. ${f.reviewer_name}${stars}: ${f.comment ?? ''}`
    })
    .join('\n')

  const userMessage = [
    `Project: ${project.title}`,
    project.genre ? `Genre: ${project.genre}` : null,
    project.bpm ? `BPM: ${project.bpm}` : null,
    `Version under review: ${versionLabel}`,
    '',
    `Listener feedback (${feedback.length} ${feedback.length === 1 ? 'comment' : 'comments'}):`,
    feedbackBlock,
  ]
    .filter(Boolean)
    .join('\n')

  const systemPrompt = `You are an A&R assistant helping music producers digest listener feedback on works-in-progress. You receive a project's metadata and a list of listener comments on a single mix version. Your job is to condense the feedback into actionable mix notes.

Always respond in this exact Markdown structure, and nothing else:

## Summary
One or two sentences on the overall reception.

## Themes
- 3 to 5 bullet points capturing recurring themes across multiple listeners. Each bullet should be a concrete observation a producer can act on (e.g. "Vocals sit too low in the chorus" rather than "people didn't love the vocals"). If only one listener mentioned something, only include it if it's specific and actionable.

## Praised
- Bullet points of what's working. Pull direct phrasing where it's vivid.

## Suggested next steps
- 2 to 4 bullet points of concrete production actions, ordered by impact. Each should be specific (e.g. "Pull the kick down 1-2 dB in the second drop" or "Try a brighter master") rather than generic.

If the feedback is too sparse, contradictory, or vague to support a section, write "_Not enough signal._" under that heading instead of inventing content. Never fabricate listener quotes.`

  const client = new Anthropic({ apiKey })

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    })

    const summary = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()

    if (!summary) {
      return NextResponse.json({ error: 'Empty response from model' }, { status: 502 })
    }

    return NextResponse.json({
      summary,
      feedback_count: feedback.length,
      model: response.model,
    })
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: 'Anthropic rate limit hit. Try again shortly.' }, { status: 429 })
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `AI error: ${err.message}` }, { status: 502 })
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
