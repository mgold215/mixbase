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

type Placement = {
  textCenterY: number  // 0.10–0.90, vertical center of text block
  showRule: boolean    // horizontal divider between artist and title
}

type Filters = {
  brightness: number  // 0.5–1.5, 1.0 = no change
  contrast: number    // 0.5–1.5, 1.0 = no change
  saturation: number  // 0.0–2.0, 1.0 = no change
  vignette: boolean
}

// ── Vision: pick vertical text position based on image content ────────────────
// showRule is now an explicit user control, so Vision only determines textCenterY.
// When position is explicitly set to 'top' or 'bottom', Vision is skipped entirely.
async function pickTextCenterY(
  imageUrl: string,
  layoutSeed: number,
  guidance?: string,
  positionHint?: 'top' | 'bottom'
): Promise<number> {
  if (positionHint === 'top') return 0.18
  if (positionHint === 'bottom') return 0.85

  const guided = !!guidance && guidance.trim().length > 0
  const seedZone: 'top' | 'bottom' = layoutSeed % 2 === 0 ? 'bottom' : 'top'
  const fallback = seedZone === 'top' ? 0.18 : 0.85

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback

  // Use Sonnet for guided mode — it follows complex instructions far more reliably
  // than Haiku. For unguided (just zone picking), Haiku is sufficient.
  const model = guided ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'

  const promptText = guided
    ? `You are placing small white text (artist name + title) on an album cover.

IMPORTANT — the user has given this specific instruction: "${guidance!.trim()}"

Follow the user instruction precisely. Return the vertical center for the text block as a fraction of image height.

textCenterY: 0.10 = very top edge, 0.50 = center, 0.90 = very bottom edge.

Reply with ONLY valid JSON: {"textCenterY": <number between 0.10 and 0.90>}`
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
        model,
        max_tokens: 60,
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
    return Math.min(maxY, Math.max(minY, Number(p.textCenterY) || fallback))
  } catch (err) {
    console.error('[finalize-artwork] Vision error:', err)
    return fallback
  }
}

// ── Build finalized artwork: source pixels + optional filter adjustments + text ─
async function buildFinalized(
  imageBuffer: Buffer,
  title: string,
  artist: string,
  placement: Placement,
  filters: Filters
): Promise<Buffer> {
  const { width = 1024, height = 1024 } = await sharp(imageBuffer).metadata()

  // Apply photo adjustments via Sharp before compositing text.
  // Each step is a separate pipeline call so they chain cleanly.
  let pipeline = sharp(imageBuffer)

  const { brightness, saturation, contrast, vignette } = filters

  if (brightness !== 1.0 || saturation !== 1.0) {
    pipeline = pipeline.modulate({ brightness, saturation })
  }

  if (contrast !== 1.0) {
    // Linear contrast: output = contrast * input + 128 * (1 - contrast)
    // Preserves midpoint at 128 so the image doesn't shift overall brightness.
    pipeline = pipeline.linear(contrast, Math.round(128 * (1 - contrast)))
  }

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

  const ruleW = Math.round(artistW)
  const ruleX = Math.round(cx - ruleW / 2)
  const ruleSvg = placement.showRule
    ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.75" filter="url(#textShadow)"/>`
    : ''

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

  // Build composite layers: vignette (if enabled) then text overlay
  const composites: sharp.OverlayOptions[] = []

  if (vignette) {
    const vignetteSvg = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="vig" cx="50%" cy="50%" r="71%">
            <stop offset="0%" stop-color="black" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="0.55"/>
          </radialGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#vig)"/>
      </svg>`
    )
    composites.push({ input: vignetteSvg, blend: 'over' })
  }

  composites.push({ input: textSvg, blend: 'over' })

  return pipeline
    .composite(composites)
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer()
}

// ── POST /api/finalize-artwork ──────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const {
    project_id, artist, guidance,
    position,
    showRule: showRuleParam,
    filters: filtersParam,
  } = await request.json()

  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  const guidanceText: string | undefined =
    typeof guidance === 'string' && guidance.trim().length > 0
      ? guidance.trim().slice(0, 400)
      : undefined

  // showRule defaults to true — always show the line between artist and title
  // unless the user explicitly turns it off.
  const showRule: boolean = typeof showRuleParam === 'boolean' ? showRuleParam : true

  const filters: Filters = {
    brightness: Math.min(1.5, Math.max(0.5, Number(filtersParam?.brightness ?? 1.0))),
    contrast:   Math.min(1.5, Math.max(0.5, Number(filtersParam?.contrast   ?? 1.0))),
    saturation: Math.min(2.0, Math.max(0.0, Number(filtersParam?.saturation ?? 1.0))),
    vignette:   Boolean(filtersParam?.vignette ?? false),
  }

  const positionHint: 'top' | 'bottom' | undefined =
    position === 'top' || position === 'bottom' ? position : undefined

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

  const layoutSeed = Math.floor(Math.random() * 1024)
  const textCenterY = await pickTextCenterY(project.artwork_url, layoutSeed, guidanceText, positionHint)
  const placement: Placement = { textCenterY, showRule }

  console.log('[finalize-artwork] guidance:', guidanceText ?? '(none)', 'placement:', JSON.stringify(placement), 'filters:', JSON.stringify(filters))

  const finalBuffer = await buildFinalized(imageBuffer, project.title, artist || 'moodmixformat', placement, filters)

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
