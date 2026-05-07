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

// ── Vision: just text placement, no color grading ────────────────────────────
// We deliberately do NOT touch the source pixels (no contrast/saturation/
// brightness/vignette pipeline). The user paid for the Replicate render — the
// finalize step exists only to lay text on top, not to "improve" the image.
type Placement = {
  textCenterY: number      // 0.10–0.90, vertical center of text block
  overlayOpacity: number   // 0.00–0.30, soft band behind text for legibility
  showRule: boolean        // horizontal divider between artist and title
}

async function pickPlacement(imageUrl: string, layoutSeed: number): Promise<Placement> {
  // Randomise between top and bottom zones each click so re-running Finalize
  // gives the user genuinely different layouts to choose from instead of the
  // same deterministic render every time.
  const zone: 'top' | 'bottom' = layoutSeed % 2 === 0 ? 'bottom' : 'top'
  const showRule = (layoutSeed >> 1) % 2 === 0
  const fallback: Placement = {
    textCenterY: zone === 'top' ? 0.18 : 0.85,
    overlayOpacity: 0.00,
    showRule,
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback

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
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            {
              type: 'text',
              text: `Find where small white text would be most readable on this album cover, in the ${zone} zone of the image (${zone === 'top' ? '0.10–0.30' : '0.72–0.90'} of height). Pick the area with the least busy detail behind it.

Return ONLY this JSON:
{"textCenterY": <number>, "overlayOpacity": <0.0–0.30>}

textCenterY = vertical center of the text block.
overlayOpacity = 0.0 if the area is already low-detail and clear; up to 0.30 if a faint backdrop helps the text read. Default to 0.0 unless the text would clearly be illegible without help.`,
            },
          ],
        }],
      }),
    })

    if (!res.ok) throw new Error(`Anthropic ${res.status}`)
    const data = await res.json()
    const raw = (data.content?.[0]?.text ?? '').trim()
      .replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
    const p = JSON.parse(raw)
    const minY = zone === 'top' ? 0.10 : 0.72
    const maxY = zone === 'top' ? 0.30 : 0.90
    return {
      textCenterY:    Math.min(maxY, Math.max(minY, Number(p.textCenterY) || fallback.textCenterY)),
      overlayOpacity: Math.min(0.30, Math.max(0.00, Number(p.overlayOpacity) || 0)),
      showRule,
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
  // Source pixels go through Sharp untouched — no color grade. Whatever
  // colors Replicate produced are the colors that ship.
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
    ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.75"/>`
    : ''

  // Tight feathered backdrop only when Vision asked for it — kept narrow
  // (2.2× text block height) so it never darkens a meaningful portion of the
  // cover even when present.
  const overlayH  = Math.round(totalH * 2.2)
  const overlayY  = Math.max(0, Math.round(cy - overlayH / 2))
  const overlayHc = Math.min(overlayH, height - overlayY)
  const op = placement.overlayOpacity.toFixed(2)

  const overlayLayer = placement.overlayOpacity > 0.02
    ? Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stop-color="#000" stop-opacity="0"/>
              <stop offset="30%"  stop-color="#000" stop-opacity="${op}"/>
              <stop offset="70%"  stop-color="#000" stop-opacity="${op}"/>
              <stop offset="100%" stop-color="#000" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <rect x="0" y="${overlayY}" width="${width}" height="${overlayHc}" fill="url(#g)"/>
        </svg>`
      )
    : null

  const textSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${artistPaths}
      ${ruleSvg}
      ${titlePaths}
    </svg>`
  )

  const layers: sharp.OverlayOptions[] = []
  if (overlayLayer) layers.push({ input: overlayLayer, blend: 'over' })
  layers.push({ input: textSvg, blend: 'over' })

  return img.composite(layers).jpeg({ quality: 94 }).toBuffer()
}

// ── POST /api/finalize-artwork ──────────────────────────────────────────────
// Always renders against the immutable source (mb_projects.artwork_url) and
// writes the rendered output to mb_projects.finalized_artwork_url. The client
// only sends { project_id } — passing artwork_url from the browser would let
// stale finalized URLs feed back into the renderer.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { project_id, artist } = await request.json()
  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

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

  // Random seed per call → different layout each Finalize click.
  const layoutSeed = Math.floor(Math.random() * 1024)
  const placement = await pickPlacement(project.artwork_url, layoutSeed)
  console.log('[finalize-artwork] placement:', JSON.stringify(placement))

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
