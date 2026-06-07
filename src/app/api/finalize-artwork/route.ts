import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
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
  guidance?: string
): Promise<Placement> {
  // Default: clean bottom placement, always show the rule.
  // Only call Vision when the user has typed explicit guidance — avoids
  // unreliable random positioning on unguided clicks.
  const fallback: Placement = { textCenterY: 0.84, showRule: true }

  const guided = !!guidance && guidance.trim().length > 0
  if (!guided) return fallback

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback

  const promptText = `Pick the best vertical position for the artist + title text overlay on this album cover. Follow the user's instruction: "${guidance!.trim()}"

textCenterY: 0.10–0.90 (vertical center of the two-line text block).
showRule: true to draw a thin line between artist and title, false to omit it.

Reply with ONLY valid JSON: {"textCenterY": <number>, "showRule": <boolean>}`

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
        max_tokens: 80,
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
    return {
      textCenterY: Math.min(0.90, Math.max(0.10, Number(p.textCenterY) || fallback.textCenterY)),
      showRule:    typeof p.showRule === 'boolean' ? p.showRule : true,
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
  const artistSize = Math.round(width * 0.020)
  const artistLS   = Math.round(artistSize * 0.10)
  const titleSize  = Math.round(width * 0.038)
  const titleLS    = Math.round(titleSize  * 0.06)
  const ruleH      = placement.showRule ? Math.max(2, Math.round(width * 0.004)) : 0
  const gapAbove   = placement.showRule ? Math.round(width * 0.016) : Math.round(width * 0.010)
  const gapBelow   = placement.showRule ? Math.round(width * 0.012) : 0
  const totalH     = artistSize + gapAbove + ruleH + gapBelow + titleSize

  const artistY = Math.round(cy - totalH / 2 + artistSize)
  const ruleY   = Math.round(artistY + gapAbove)
  const titleY  = Math.round(ruleY + ruleH + gapBelow + titleSize)

  const { markup: artistPaths, totalW: artistW } = textToSvgPaths(
    artist.toLowerCase(), cx, artistY, artistSize, artistLS, 'white', 0.90
  )
  const { markup: titlePaths, totalW: titleW } = textToSvgPaths(
    title.toUpperCase(), cx, titleY, titleSize, titleLS, 'white', 1.00
  )

  // Horizontal rule — spans the wider of artist/title, no blur filter so it stays sharp
  const ruleW = Math.round(Math.max(artistW, titleW))
  const ruleX = Math.round(cx - ruleW / 2)
  const ruleSvg = placement.showRule
    ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.9"/>`
    : ''

  // Drop-shadow filters — give white text legibility on any background without
  // darkening any pixels not adjacent to a glyph. One filter PER LINE, scaled to
  // that line's size, with an explicit full-canvas userSpaceOnUse region. A
  // single filter over the whole text group made librsvg rasterize the filter
  // buffer from the group's large bounding box, which was too low-resolution for
  // the small artist glyphs and visibly mangled some of them (e.g. the 'm').
  const artistSigma = Math.max(1, Math.round(artistSize * 0.10))
  const titleSigma  = Math.max(2, Math.round(titleSize * 0.08))
  const filterRegion = `filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" color-interpolation-filters="sRGB"`

  const textSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="artistShadow" ${filterRegion}>
          <feDropShadow dx="0" dy="${Math.round(artistSigma * 0.5)}" stdDeviation="${artistSigma}" flood-color="#000" flood-opacity="0.65"/>
        </filter>
        <filter id="titleShadow" ${filterRegion}>
          <feDropShadow dx="0" dy="${Math.round(titleSigma * 0.5)}" stdDeviation="${titleSigma}" flood-color="#000" flood-opacity="0.65"/>
        </filter>
      </defs>
      <g filter="url(#artistShadow)">${artistPaths}</g>
      <g filter="url(#titleShadow)">${titlePaths}</g>
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
  if (!isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
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

  const placement = await pickPlacement(project.artwork_url, guidanceText)
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
    .eq('user_id', userId) // defense-in-depth: scope the write to the owner

  return NextResponse.json({ finalized_artwork_url: finalUrl, placement })
}
