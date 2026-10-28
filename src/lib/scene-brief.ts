// Scene brief — the artist types a few words ("rooftop in tokyo, rain,
// neon"), and this turns them into what the image and video models need:
//
//   setting  what the cassette stands on and what is around/behind it, the
//            light, the time, the weather — the part of the photograph the
//            cover prompt (cassette-scenes.ts scenePrompt) leaves open
//   motion   how the moving scene moves: the camera, the ambient motion in
//            the scene, the reels turning — motion only, the still already
//            defines the look (Runway follows motion-only prompts best)
//   label    a short name for the scene, shown back to the artist
//
// Written by Claude when ANTHROPIC_API_KEY is set; otherwise (or if the call
// fails or declines) a plain template from the artist's own words, so the
// one-click flow never stops on this step.

import Anthropic from '@anthropic-ai/sdk'
import { MAX_CUSTOM_SETTING } from './cassette-scenes.ts'

export type SceneBrief = { setting: string; motion: string; label: string; source: 'claude' | 'template' }

const MODEL = 'claude-opus-5-5'

export const DEFAULT_MOTION =
  'The cassette tape reels turn slowly and steadily as if the tape is playing. Very slow cinematic push-in at eye level, gentle parallax between the cassette and the background, subtle natural ambient motion in the scene. Camera stays steady, no cuts, the cassette does not move.'

const SYSTEM = `You are the director of photography for a musician's album covers. Every cover is the same real object: a clear plastic audio cassette tape standing upright on a surface, shot straight on at its own height with a 50mm lens. A separate system composites the real cassette into the scene you describe and then films the scene as a short loop.

From the artist's few words, write:
- setting: one sentence describing what the cassette stands on (a ledge, counter, rail, sill, table — a real surface at the cassette's height) and what is behind and around it, plus the light, time of day, weather and colour. Concrete, photographic, physically plausible. Nothing in front of the cassette. No people facing the camera, no readable words or logos anywhere, no other cassettes. Max 260 characters.
- motion: two or three short sentences for the video model, describing MOTION ONLY: the camera move (slow push-in, slow drift or slow orbit at eye level — never fast, never a cut), the ambient motion that belongs in this scene (rain streaks, drifting fog, neon flicker, traffic light trails, waves, falling snow, swaying trees), and that the cassette's tape reels turn slowly as if playing while the cassette itself stays still. Max 320 characters.
- label: the scene in two to five words, title case, no quotes.

Keep the artist's intent. Make it look like a real photograph by a professional.`

const SCHEMA = {
  type: 'object',
  properties: {
    setting: { type: 'string' },
    motion: { type: 'string' },
    label: { type: 'string' },
  },
  required: ['setting', 'motion', 'label'],
  additionalProperties: false,
} as const

/** The brief built from the artist's words alone. */
export function templateBrief(description: string): SceneBrief {
  const d = description.trim().replace(/\s+/g, ' ').slice(0, MAX_CUSTOM_SETTING)
  const label = d.length > 40 ? `${d.slice(0, 38).replace(/\s+\S*$/, '')}…` : d
  return { setting: d, motion: DEFAULT_MOTION, label: label || 'Your scene', source: 'template' }
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : ''
}

/** Turn the artist's description into a scene brief (see the top of this file). Never throws. */
export async function writeSceneBrief(description: string): Promise<SceneBrief> {
  const fallback = templateBrief(description)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback
  try {
    const client = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: `The artist's description: ${description.trim().slice(0, 400)}` }],
    })
    if (response.stop_reason !== 'end_turn') return fallback
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    const raw = JSON.parse(text) as Record<string, unknown>
    const setting = clean(raw.setting, MAX_CUSTOM_SETTING)
    const motion = clean(raw.motion, 600)
    const label = clean(raw.label, 48)
    if (!setting) return fallback
    return { setting, motion: motion || DEFAULT_MOTION, label: label || fallback.label, source: 'claude' }
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error('[scene-brief] API error:', err.status, err.message)
    else console.error('[scene-brief] failed:', err instanceof Error ? err.message : err)
    return fallback
  }
}
