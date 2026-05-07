import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import sharp from 'sharp'
import { Resvg } from '@resvg/resvg-js'
import { readFileSync } from 'fs'
import { join } from 'path'

export const maxDuration = 60

// Load real Futura Bold at startup (extracted from macOS system TTC, licensed per-device)
// Stored as Buffer for resvg-js fontBuffers API — works cross-platform including Railway Linux
const FUTURA_BOLD_BUF = readFileSync(join(process.cwd(), 'src/fonts/FuturaBold.ttf'))

// ── Claude Vision: analyze image for text placement AND filter params ────────
interface VisionParams {
  textCenterY: number     // 0–1 relative to image height
  overlayOpacity: number  // 0–0.55
  contrast: number        // 0.90–1.25
  saturation: number      // 0.75–1.35
  brightness: number      // 0.85–1.10
  sharpen: boolean
  vignette: number        // 0–0.6
}

async function analyzeImage(imageUrl: string): Promise<VisionParams> {
  const defaults: VisionParams = {
    textCenterY: 0.18,
    overlayOpacity: 0.25,
    contrast: 1.08,
    saturation: 1.12,
    brightness: 0.97,
    sharpen: true,
    vignette: 0.30,
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

1. TEXT PLACEMENT — find the largest area of low-detail, low-contrast space (sky, fog, dark background, negative space) where white text would be most readable without obscuring the main subject:
   - textCenterY: 0.10–0.30 for a top zone, 0.72–0.90 for a bottom zone
   - overlayOpacity: 0.0 (image already dark/clear) → 0.50 (busy or bright background)

2. IMAGE GRADING — suggest a subtle professional color grade to make the image feel polished and finished. Be tasteful and restrained:
   - contrast: 1.00–1.22 (boost for flat/hazy images, leave near 1.0 if already punchy)
   - saturation: 0.88–1.30 (desaturate moody looks, boost vivid images slightly)
   - brightness: 0.90–1.08 (darken overexposed, lift underexposed)
   - sharpen: true if the image looks soft or rendered; false if already crisp
   - vignette: 0.0–0.55 (dark corner vignette strength; higher for busy/bright compositions)

Reply with ONLY a JSON object, no markdown, no explanation:
{"textCenterY":0.18,"overlayOpacity":0.25,"contrast":1.10,"saturation":1.15,"brightness":0.97,"sharpen":true,"vignette":0.32}`,
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
      overlayOpacity: Math.min(0.55, Math.max(0.00, Number(p.overlayOpacity) || defaults.overlayOpacity)),
      contrast:       Math.min(1.25, Math.max(0.90, Number(p.contrast)       || defaults.contrast)),
      saturation:     Math.min(1.35, Math.max(0.75, Number(p.saturation)     || defaults.saturation)),
      brightness:     Math.min(1.10, Math.max(0.85, Number(p.brightness)     || defaults.brightness)),
      sharpen:        p.sharpen !== false,
      vignette:       Math.min(0.60, Math.max(0.00, Number(p.vignette)       || defaults.vignette)),
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
          <radialGradient id="vg" cx="50%" cy="50%" r="75%" gradientUnits="userSpaceOnUse"
            gradientTransform="translate(${width / 2},${height / 2}) scale(${width / 2},${height / 2}) translate(-1,-1)">
            <stop offset="0%"   stop-color="#000" stop-opacity="0"/>
            <stop offset="65%"  stop-color="#000" stop-opacity="0"/>
            <stop offset="100%" stop-color="#000" stop-opacity="${vop}"/>
          </radialGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#vg)"/>
      </svg>`
    )
    const filtered = await pipeline.toBuffer()
    return sharp(filtered)
      .composite([{ input: vignetteSvg, blend: 'over' }])
      .toBuffer()
  }

  return pipeline.toBuffer()
}

// ── Composite artist + title in real Futura Bold onto filtered image ─────────
async function buildFinalized(
  imageBuffer: Buffer,
  title: string,
  artist: string,
  params: VisionParams
): Promise<Buffer> {
  // Step 1: apply professional image grading
  const gradedBuffer = await filterImage(imageBuffer, params)

  // Step 2: composite text overlay onto graded image
  const img = sharp(gradedBuffer)
  const { width = 1024, height = 1024 } = await img.metadata()

  const cx = Math.round(width * 0.5)
  const cy = Math.round(params.textCenterY * height)

  // Typography sizing — tuned to match reference image
  const artistSize          = Math.round(width * 0.030)
  const artistLetterSpacing = Math.round(artistSize * 0.22)
  const titleSize           = Math.round(width * 0.064)
  const titleLetterSpacing  = Math.round(titleSize  * 0.06)
  const ruleH               = Math.max(1, Math.round(width * 0.0015))
  // Rule width matches artist name text width (chars × avg glyph width + tracking)
  const ruleW               = Math.round(artist.length * (artistSize * 0.62 + artistLetterSpacing))
  const gapAbove            = Math.round(width * 0.014)  // artist → rule
  const gapBelow            = Math.round(width * 0.006)  // rule → title (tight)
  const totalH              = artistSize + gapAbove + ruleH + gapBelow + titleSize

  // Vertical positions
  const artistY = Math.round(cy - totalH / 2 + artistSize)
  const ruleY   = Math.round(artistY + gapAbove)
  const titleY  = Math.round(ruleY + ruleH + gapBelow + titleSize)

  // Feathered dark gradient band behind text
  const overlayH  = Math.round(totalH * 4.5)
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

  // Text SVG rendered via resvg-js (Rust engine) which loads fonts directly from Buffer
  // This works cross-platform including Railway Linux, unlike Sharp's librsvg @font-face
  const ruleX = Math.round(cx - ruleW / 2)

  const textSvgStr =
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <!-- Artist name: Futura Bold, small, wide tracking -->
      <text
        x="${cx}" y="${artistY}"
        font-family="Futura"
        font-size="${artistSize}"
        font-weight="bold"
        fill="white"
        fill-opacity="0.90"
        text-anchor="middle"
        letter-spacing="${artistLetterSpacing}"
      >${artist.toLowerCase()}</text>

      <!-- Horizontal rule between artist and title -->
      <rect
        x="${ruleX}" y="${ruleY}"
        width="${ruleW}" height="${ruleH}"
        fill="white"
        fill-opacity="0.75"
      />

      <!-- Track title: Futura Bold, large, ALL CAPS -->
      <text
        x="${cx}" y="${titleY}"
        font-family="Futura"
        font-size="${titleSize}"
        font-weight="bold"
        fill="white"
        text-anchor="middle"
        letter-spacing="${titleLetterSpacing}"
      >${title.toUpperCase()}</text>
    </svg>`

  // Render SVG → PNG with resvg, passing the font buffer directly
  const resvg = new Resvg(textSvgStr, {
    font: { fontBuffers: [FUTURA_BOLD_BUF] },
  })
  const textPng = Buffer.from(resvg.render().asPng())

  const layers: sharp.OverlayOptions[] = []
  if (overlayLayer) layers.push({ input: overlayLayer, blend: 'over' })
  layers.push({ input: textPng, blend: 'over' })

  return img.composite(layers).jpeg({ quality: 94 }).toBuffer()
}

// ── POST /api/finalize-artwork ──────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { project_id, artwork_url, title, artist } = await request.json()
  if (!artwork_url || !title) {
    return NextResponse.json({ error: 'artwork_url and title are required' }, { status: 400 })
  }

  const supabase = await createClient()

  // 1. Download source artwork
  const imageRes = await fetch(artwork_url)
  if (!imageRes.ok) return NextResponse.json({ error: 'Could not fetch artwork' }, { status: 400 })
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer())

  // 2. Single Claude Vision call: placement + color grade params
  console.log('[finalize-artwork] Analyzing image with Claude Vision...')
  const params = await analyzeImage(artwork_url)
  console.log('[finalize-artwork] Vision params:', JSON.stringify(params))

  // 3. Apply professional filtering + render Futura Bold text overlay
  const finalBuffer = await buildFinalized(imageBuffer, title, artist || 'moodmixformat', params)

  // 4. Upload to Supabase
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

  // 5. Update project record
  if (project_id) {
    await supabaseAdmin
      .from('mb_projects')
      .update({ artwork_url: finalUrl, updated_at: new Date().toISOString() })
      .eq('id', project_id)
  }

  return NextResponse.json({ artwork_url: finalUrl, params })
}
