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
// Returns the combined SVG path markup and total text width
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

  // Measure total width for centering
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
    // toSVG returns a full <path .../> element — extract d attribute and rebuild with fill
    const dMatch  = svgEl.match(/d="([^"]+)"/)
    if (dMatch) {
      parts.push(
        `<path d="${dMatch[1]}" fill="${fill}" fill-opacity="${fillOpacity}"/>`
      )
    }
    x += (g.advanceWidth ?? 0) * scale + letterSpacing
  }

  return { markup: parts.join('\n'), totalW }
}

// ── Claude Vision: analyze image for text placement AND filter params ────────
interface VisionParams {
  textCenterY: number
  overlayOpacity: number
  contrast: number
  saturation: number
  brightness: number
  sharpen: boolean
  vignette: number
}

async function analyzeImage(imageUrl: string): Promise<VisionParams> {
  // Defaults are deliberately on the "brighten + saturate, never darken" side.
  // Overlay + vignette default to 0 — when the text is small (~3.5% of width),
  // it reads fine over most album covers without any backdrop. Vision opts in
  // to a small overlay only when the area immediately behind the text is busy.
  const defaults: VisionParams = {
    textCenterY: 0.85,
    overlayOpacity: 0.00,
    contrast: 1.06,
    saturation: 1.32,
    brightness: 1.05,
    sharpen: true,
    vignette: 0.00,
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return defaults

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
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            {
              type: 'text',
              text: `Analyze this album artwork image and return a JSON object with two groups of parameters.

1. TEXT PLACEMENT — find the largest area of low-detail, low-contrast space where white text would be most readable without obscuring the main subject:
   - textCenterY: 0.10–0.30 for top zone, 0.72–0.90 for bottom zone
   - overlayOpacity: 0.0 (already dark/clear) → 0.50 (busy/bright background)

2. IMAGE GRADING — push the colors so the cover looks more vibrant than the
   source. NEVER darken or mute. brightness must stay ≥ 1.00 — the user paid
   for a render and wants the colors enhanced, not dimmed.
   - contrast: 1.02–1.12 (gentle — heavy contrast crushes shadows on dark covers)
   - saturation: 1.15–1.45 (lean high)
   - brightness: 1.00–1.10 (NEVER below 1.00)
   - sharpen: true if soft/rendered; false if already crisp
   - vignette: 0.0 unless the cover absolutely demands edge framing (max 0.15)

Reply with ONLY a JSON object, no markdown:
{"textCenterY":0.85,"overlayOpacity":0.00,"contrast":1.06,"saturation":1.32,"brightness":1.05,"sharpen":true,"vignette":0.00}`,
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
    return {
      textCenterY:    Math.min(0.90, Math.max(0.10, Number(p.textCenterY)    || defaults.textCenterY)),
      overlayOpacity: Math.min(0.30, Math.max(0.00, Number(p.overlayOpacity) || defaults.overlayOpacity)),
      contrast:       Math.min(1.18, Math.max(1.00, Number(p.contrast)       || defaults.contrast)),
      saturation:     Math.min(1.55, Math.max(1.05, Number(p.saturation)     || defaults.saturation)),
      // Brightness is hard-floored at 1.00 — Finalize is allowed to brighten,
      // never to darken. If Vision returns < 1.00 we ignore it.
      brightness:     Math.min(1.15, Math.max(1.00, Number(p.brightness)     || defaults.brightness)),
      sharpen:        p.sharpen !== false,
      vignette:       Math.min(0.20, Math.max(0.00, Number(p.vignette)       || defaults.vignette)),
    }
  } catch (err) {
    console.error('[finalize-artwork] Vision error:', err)
    return defaults
  }
}

// ── Apply professional image filtering with Sharp ────────────────────────────
async function filterImage(
  imageBuffer: Buffer,
  params: Pick<VisionParams, 'contrast' | 'saturation' | 'brightness' | 'sharpen' | 'vignette'>
): Promise<Buffer> {
  const { width = 1024, height = 1024 } = await sharp(imageBuffer).metadata()

  let pipeline = sharp(imageBuffer)
    .modulate({ brightness: params.brightness, saturation: params.saturation })
    .linear(params.contrast, -(128 * (params.contrast - 1)))

  if (params.sharpen) {
    pipeline = pipeline.sharpen({ sigma: 0.8 })
  }

  if (params.vignette > 0.01) {
    const vop = params.vignette.toFixed(3)
    const vignetteSvg = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="vg" cx="50%" cy="50%" r="75%"
            gradientTransform="translate(${width / 2},${height / 2}) scale(${width / 2},${height / 2}) translate(-1,-1)"
            gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stop-color="#000" stop-opacity="0"/>
            <stop offset="65%"  stop-color="#000" stop-opacity="0"/>
            <stop offset="100%" stop-color="#000" stop-opacity="${vop}"/>
          </radialGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#vg)"/>
      </svg>`
    )
    const filtered = await pipeline.toBuffer()
    return sharp(filtered).composite([{ input: vignetteSvg, blend: 'over' }]).toBuffer()
  }

  return pipeline.toBuffer()
}

// ── Build finalized artwork: filter → overlay → text paths ──────────────────
async function buildFinalized(
  imageBuffer: Buffer,
  title: string,
  artist: string,
  params: VisionParams
): Promise<Buffer> {
  // Step 1: grade the image
  const gradedBuffer = await filterImage(imageBuffer, params)

  const img = sharp(gradedBuffer)
  const { width = 1024, height = 1024 } = await img.metadata()

  const cx = Math.round(width * 0.5)
  const cy = Math.round(params.textCenterY * height)

  // Typography — sized as a fraction of cover width so it scales for any output.
  // Album-cover overlays usually run 3–4% of width for the title; keep below that.
  const artistSize = Math.round(width * 0.018)
  const artistLS   = Math.round(artistSize * 0.22)
  const titleSize  = Math.round(width * 0.038)
  const titleLS    = Math.round(titleSize  * 0.06)
  const ruleH      = Math.max(1, Math.round(width * 0.0015))
  const gapAbove   = Math.round(width * 0.014)
  const gapBelow   = Math.round(width * 0.006)
  const totalH     = artistSize + gapAbove + ruleH + gapBelow + titleSize

  const artistY = Math.round(cy - totalH / 2 + artistSize)
  const ruleY   = Math.round(artistY + gapAbove)
  const titleY  = Math.round(ruleY + ruleH + gapBelow + titleSize)

  // Build glyph paths
  const { markup: artistPaths, totalW: artistW } = textToSvgPaths(
    artist.toLowerCase(), cx, artistY, artistSize, artistLS, 'white', 0.90
  )
  const { markup: titlePaths } = textToSvgPaths(
    title.toUpperCase(), cx, titleY, titleSize, titleLS, 'white', 1.00
  )

  const ruleW = Math.round(artistW)
  const ruleX = Math.round(cx - ruleW / 2)

  // Feathered overlay behind text — kept tight to the text block so it never
  // darkens a meaningful portion of the cover. With small text (~3.5% width)
  // a 2.2× band gives just enough soft falloff for legibility.
  const overlayH  = Math.round(totalH * 2.2)
  const overlayY  = Math.max(0, Math.round(cy - overlayH / 2))
  const overlayHc = Math.min(overlayH, height - overlayY)
  const op = params.overlayOpacity.toFixed(2)

  const overlayLayer = params.overlayOpacity > 0.02
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

  // Text layer: pure vector paths — no font engine needed, works everywhere
  const textSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${artistPaths}
      <rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.75"/>
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
// only needs to send { project_id } — passing artwork_url from the browser
// would let stale finalized URLs feed back into the renderer.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { project_id, artist } = await request.json()
  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  // 1. Load source from project record — server is source of truth
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

  // 2. Download source artwork
  const imageRes = await fetch(project.artwork_url)
  if (!imageRes.ok) return NextResponse.json({ error: 'Could not fetch artwork' }, { status: 400 })
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer())

  // 3. Claude Vision: placement + color grade params
  console.log('[finalize-artwork] Analyzing image...')
  const params = await analyzeImage(project.artwork_url)
  console.log('[finalize-artwork] params:', JSON.stringify(params))

  // 4. Filter + render text
  const finalBuffer = await buildFinalized(imageBuffer, project.title, artist || 'moodmixformat', params)

  // 5. Upload rendered output
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

  // 6. Persist finalized URL — leaves artwork_url (the source) untouched
  await supabaseAdmin
    .from('mb_projects')
    .update({ finalized_artwork_url: finalUrl, updated_at: new Date().toISOString() })
    .eq('id', project_id)

  return NextResponse.json({ finalized_artwork_url: finalUrl, params })
}
