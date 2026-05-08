import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import sharp from 'sharp'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseFont } from 'opentype.js'

export const runtime = 'nodejs'
export const maxDuration = 60

// Load real Futura Bold at startup — parsed by opentype.js for glyph-path rendering.
// Slice the underlying ArrayBuffer to the file's exact byte range — Node's Buffer
// pool can otherwise hand opentype.js trailing bytes that aren't part of the font.
const FONT_BUF = readFileSync(join(process.cwd(), 'src/fonts/FuturaBold.ttf'))
const FONT_AB  = FONT_BUF.buffer.slice(FONT_BUF.byteOffset, FONT_BUF.byteOffset + FONT_BUF.byteLength)
const FONT = parseFont(FONT_AB)

// ── Convert text → SVG path data via opentype.js ─────────────────────────────
function textToSvgPaths(
  text: string,
  cx: number,
  baselineY: number,
  fontSize: number,
  letterSpacing: number,
  fill: string,
  fillOpacity: number
): { markup: string; totalW: number } {
  const glyphs = FONT.stringToGlyphs(text)
  const scale  = fontSize / FONT.unitsPerEm

  let totalW = 0
  glyphs.forEach((g, i) => {
    totalW += (g.advanceWidth ?? 0) * scale
    if (i < glyphs.length - 1) totalW += letterSpacing
  })

  let x = cx - totalW / 2
  const parts: string[] = []
  for (const g of glyphs) {
    const pathObj = g.getPath(x, baselineY, fontSize)
    const svgEl   = pathObj.toSVG(1) as string
    const dMatch  = svgEl.match(/d="([^"]+)"/)
    if (dMatch) {
      parts.push(`<path d="${dMatch[1]}" fill="${fill}" fill-opacity="${fillOpacity}"/>`)
    }
    x += (g.advanceWidth ?? 0) * scale + letterSpacing
  }

  return { markup: parts.join('\n'), totalW }
}

// ── Vision: just text placement, no color grading, no backdrop ───────────────
// We deliberately do NOT touch the source pixels — no contrast/saturation/
// brightness/vignette pipeline AND no dark band behind the text. The user paid
// for the Replicate render and wants those pixels to ship. Legibility comes
// from per-glyph drop shadows on the text itself, which only darken pixels
// immediately around each letter.
type Placement = {
  textCenterY: number  // 0.10–0.90, vertical center of text block
  showRule: boolean    // horizontal divider between artist and title
}

async function pickPlacement(
  imageUrl: string,
  layoutSeed: number,
  guidance?: string
): Promise<Placement> {
  // Without guidance: randomise zone + rule per click so re-running gives a
  // different layout. With guidance: Vision gets freedom across the whole
  // image and is allowed to override the rule, so the user's instruction
  // wins over the random seed.
  const guided = !!guidance && guidance.trim().length > 0
  const seedZone: 'top' | 'bottom' = layoutSeed % 2 === 0 ? 'bottom' : 'top'
  const seedRule = (layoutSeed >> 1) % 2 === 0
  const fallback: Placement = {
    textCenterY: seedZone === 'top' ? 0.18 : 0.85,
    showRule: seedRule,
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback

  const guidanceBlock = guided
    ? `\n\nUser guidance (follow this when possible): ${guidance!.trim()}`
    : ''

  // When guided, Vision can pick anywhere on the cover (0.10–0.90) and decide
  // whether the horizontal rule belongs. Without guidance we constrain to the
  // seeded zone so the per-click variation actually shows up.
  const promptText = guided
    ? `Pick the best position for the artist + title overlay on this album cover. Small white text with a soft drop shadow.

textCenterY: 0.10–0.90 (vertical center of the text block).
showRule: true to draw a thin horizontal line between artist and title, false for a cleaner look.${guidanceBlock}

Reply with ONLY: {"textCenterY": <number>, "showRule": <boolean>}`
    : `Find the best vertical position for small white text in the ${seedZone} zone of this album cover (${seedZone === 'top' ? '0.10–0.30' : '0.72–0.90'} of height). Pick the area with the least busy detail.

Reply with ONLY: {"textCenterY": <number>}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: guided ? 120 : 60,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: promptText },
          ],
        }],
      }),
    })

    if (!res.ok) throw new Error(`Anthropic ${res.status}`)
    const data = await res.json()
    const raw = (data.content?.[0]?.text ?? '').trim()
      .replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
    const p = JSON.parse(raw)

    const minY = guided ? 0.10 : (seedZone === 'top' ? 0.10 : 0.72)
    const maxY = guided ? 0.90 : (seedZone === 'top' ? 0.30 : 0.90)
    return {
      textCenterY: Math.min(maxY, Math.max(minY, Number(p.textCenterY) || fallback.textCenterY)),
      showRule:    guided && typeof p.showRule === 'boolean' ? p.showRule : seedRule,
    }
  } catch (err) {
    console.error('[finalize-artwork] Vision error:', err)
    return fallback
  }
}

// ── Build finalized artwork: source pixels untouched, text composited on top ─
async function buildFinalized(
  imageBuffer: Buffer,
  title: string,
  artist: string,
  placement: Placement
): Promise<Buffer> {
  // Source pixels go through Sharp untouched — no color grade, no overlay band.
  // Legibility on busy backgrounds comes from per-glyph drop shadows applied
  // via SVG filters, which only darken pixels right next to each letter.
  const img = sharp(imageBuffer)
  const { width = 1024, height = 1024 } = await img.metadata()

  const cx = Math.round(width * 0.5)
  const cy = Math.round(placement.textCenterY * height)

  // Typography — small, album-overlay scale (~3.5% of width for the title).
  const artistSize = Math.round(width * 0.018)
  const artistLS   = Math.round(artistSize * 0.22)
  const titleSize  = Math.round(width * 0.038)
  const titleLS    = Math.round(titleSize  * 0.06)
  const ruleH      = placement.showRule ? Math.max(1, Math.round(width * 0.0015)) : 0
  const gapAbove   = placement.showRule ? Math.round(width * 0.014) : Math.round(width * 0.010)
  const gapBelow   = placement.showRule ? Math.round(width * 0.006) : 0
  const totalH     = artistSize + gapAbove + ruleH + gapBelow + titleSize

  const artistY = Math.round(cy - totalH / 2 + artistSize)
  const ruleY   = Math.round(artistY + gapAbove)
  const titleY  = Math.round(ruleY + ruleH + gapBelow + titleSize)

  const { markup: artistPaths, totalW: artistW } = textToSvgPaths(
    artist.toLowerCase(), cx, artistY, artistSize, artistLS, 'white', 0.90
  )
  const { markup: titlePaths } = textToSvgPaths(
    title.toUpperCase(), cx, titleY, titleSize, titleLS, 'white', 1.00
  )

  // Optional rule between artist and title
  const ruleW = Math.round(artistW)
  const ruleX = Math.round(cx - ruleW / 2)
  const ruleSvg = placement.showRule
    ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.75" filter="url(#textShadow)"/>`
    : ''

  // Drop-shadow filter — gives white text legibility on any background without
  // darkening any pixels not adjacent to a glyph. stdDeviation tuned to text
  // size; flood-opacity 0.65 reads cleanly without looking heavy.
  const shadowSigma = Math.max(2, Math.round(titleSize * 0.08))

  const textSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="${Math.round(shadowSigma * 0.5)}" stdDeviation="${shadowSigma}" flood-color="#000" flood-opacity="0.65"/>
        </filter>
      </defs>
      <g filter="url(#textShadow)">
        ${artistPaths}
        ${titlePaths}
      </g>
      ${ruleSvg}
    </svg>`
  )

  // Output JPEG at high quality with 4:4:4 chroma — preserves saturated edges
  // (neon, etc.) that 4:2:0 subsampling can mute.
  return img
    .composite([{ input: textSvg, blend: 'over' }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer()
}

// ── POST /api/finalize-artwork ──────────────────────────────────────────────
// Always renders against the immutable source (mb_projects.artwork_url) and
// writes the rendered output to mb_projects.finalized_artwork_url. The client
// only sends { project_id } — passing artwork_url from the browser would let
// stale finalized URLs feed back into the renderer.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { project_id, artist, guidance } = await request.json()
  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }
  // Trim + cap guidance length so a runaway textarea can't blow Vision tokens
  const guidanceText: string | undefined =
    typeof guidance === 'string' && guidance.trim().length > 0
      ? guidance.trim().slice(0, 400)
      : undefined

  const { data: project, error: projectError } = await supabaseAdmin
    .from('mb_projects')
    .select('artwork_url, title')
    .eq('id', project_id)
    .eq('user_id', userId)
    .single()

  if (projectError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  if (!project.artwork_url) {
    return NextResponse.json({ error: 'Generate or upload artwork before finalizing' }, { status: 400 })
  }
  if (!project.title) {
    return NextResponse.json({ error: 'Project title is required to finalize' }, { status: 400 })
  }

  const supabase = await createClient()

  const imageRes = await fetch(project.artwork_url)
  if (!imageRes.ok) return NextResponse.json({ error: 'Could not fetch artwork' }, { status: 400 })
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer())

  // Random seed per call → different layout each Finalize click when no
  // guidance is given. With guidance, Vision's choices win over the seed.
  const layoutSeed = Math.floor(Math.random() * 1024)
  const placement = await pickPlacement(project.artwork_url, layoutSeed, guidanceText)
  console.log('[finalize-artwork] guidance:', guidanceText ?? '(none)', 'placement:', JSON.stringify(placement))

  const finalBuffer = await buildFinalized(imageBuffer, project.title, artist || 'moodmixformat', placement)

  const filename = `${project_id}/finalized-${Date.now()}.jpg`
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('mf-artwork')
    .upload(filename, finalBuffer, { contentType: 'image/jpeg', upsert: false })

  if (uploadError) {
    console.error('[finalize-artwork] Upload error:', uploadError.message)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }

  const { data: urlData } = supabase.storage.from('mf-artwork').getPublicUrl(uploadData.path)
  const finalUrl = urlData.publicUrl

  await supabaseAdmin
    .from('mb_projects')
    .update({ finalized_artwork_url: finalUrl, updated_at: new Date().toISOString() })
    .eq('id', project_id)

  return NextResponse.json({ finalized_artwork_url: finalUrl, placement })
}
