import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import sharp from 'sharp'

export const maxDuration = 60

// ── Claude Vision: analyze image for text placement AND filter params ────────
interface VisionParams {
  textCenterY: number      // 0–1 relative to image height
  overlayOpacity: number   // 0–0.55
  contrast: number         // 1.0–1.25
  saturation: number       // 0.85–1.35
  brightness: number       // 0.88–1.10
  sharpen: boolean
  vignette: number         // 0–0.6
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

2. IMAGE GRADING — suggest a subtle professional color grade to make the image feel polished and finished, like it went through a high-end editing pass. Be tasteful and restrained:
   - contrast: 1.00–1.22 (boost contrast for flat/hazy images, leave near 1.0 if already punchy)
   - saturation: 0.88–1.30 (desaturate moody/muted looks, boost vivid/colorful images slightly)
   - brightness: 0.90–1.08 (darken overexposed images, lift underexposed ones)
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
    // Brightness + saturation via modulate
    .modulate({
      brightness: params.brightness,
      saturation: params.saturation,
    })
    // Contrast via linear: output = input * a + b, where b = -(128*(a-1)) normalises midpoint
    .linear(params.contrast, -(128 * (params.contrast - 1)))

  // Sharpening pass
  if (params.sharpen) {
    pipeline = pipeline.sharpen({ sigma: 0.8 })
  }

  // Vignette: radial gradient from corners, composited as a multiply/over layer
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

// ── Composite artist + title text onto image ─────────────────────────────────
async function buildFinalized(
  imageBuffer: Buffer,
  title: string,
  artist: string,
  params: VisionParams
): Promise<Buffer> {
  // Step 1: apply image grading
  const gradedBuffer = await filterImage(imageBuffer, params)

  // Step 2: composite text overlay onto graded image
  const img = sharp(gradedBuffer)
  const { width = 1024, height = 1024 } = await img.metadata()

  const cx = Math.round(width * 0.5)
  const cy = Math.round(params.textCenterY * height)

  // Typography — proportions tuned to match reference image
  const artistSize = Math.round(width * 0.031)
  const titleSize  = Math.round(width * 0.064)
  const lineGap    = Math.round(width * 0.014)
  const totalH     = artistSize + lineGap + titleSize

  const artistY = Math.round(cy - totalH / 2 + artistSize)
  const titleY  = Math.round(artistY + lineGap + titleSize)

  // Feathered dark gradient band for readability
  const overlayH  = Math.round(totalH * 4)
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

  // Text layers — Futura font stack
  const artistLetterSpacing = Math.round(artistSize * 0.20)
  const titleLetterSpacing  = Math.round(titleSize  * 0.05)

  const textSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="sh">
          <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#000" flood-opacity="0.8"/>
        </filter>
      </defs>
      <text
        x="${cx}" y="${artistY}"
        font-family="'Futura','Century Gothic','Trebuchet MS','Gill Sans',sans-serif"
        font-size="${artistSize}"
        font-weight="500"
        fill="white"
        fill-opacity="0.90"
        text-anchor="middle"
        letter-spacing="${artistLetterSpacing}"
        filter="url(#sh)"
      >${artist.toLowerCase()}</text>
      <text
        x="${cx}" y="${titleY}"
        font-family="'Futura','Century Gothic','Trebuchet MS','Gill Sans',sans-serif"
        font-size="${titleSize}"
        font-weight="bold"
        fill="white"
        text-anchor="middle"
        letter-spacing="${titleLetterSpacing}"
        filter="url(#sh)"
      >${title.toUpperCase()}</text>
    </svg>`
  )

  const layers: sharp.OverlayOptions[] = []
  if (overlayLayer) layers.push({ input: overlayLayer, blend: 'over' })
  layers.push({ input: textSvg, blend: 'over' })

  return img.composite(layers).jpeg({ quality: 94 }).toBuffer()
}

// ── POST /api/finalize-artwork ───────────────────────────────────────────────
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

  // 3. Apply filtering + render text overlay
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
