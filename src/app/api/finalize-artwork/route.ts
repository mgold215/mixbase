import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import sharp from 'sharp'

export const maxDuration = 60

// ── Claude Vision: analyze image and pick best text placement zone ──────────
async function analyzePlacement(imageUrl: string): Promise<{
  textCenterY: number   // 0–1 relative to image height
  overlayOpacity: number
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { textCenterY: 0.18, overlayOpacity: 0.3 }

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
        max_tokens: 128,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            {
              type: 'text',
              text: 'Analyze this album artwork. Find the largest area of low-detail, low-contrast space (sky, fog, dark background) where white text would be most readable without obscuring the main subject. Reply with ONLY a JSON object, no markdown: {"textCenterY":0.18,"overlayOpacity":0.25} where textCenterY is 0.10-0.30 for top zones or 0.72-0.90 for bottom zones, and overlayOpacity is 0.0 (dark/clear bg) to 0.5 (busy/bright bg).',
            },
          ],
        }],
      }),
    })

    if (!res.ok) throw new Error(`Anthropic ${res.status}`)
    const data = await res.json()
    const text = (data.content?.[0]?.text ?? '').trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
    const parsed = JSON.parse(text)
    return {
      textCenterY: Math.min(0.90, Math.max(0.10, Number(parsed.textCenterY) || 0.18)),
      overlayOpacity: Math.min(0.55, Math.max(0, Number(parsed.overlayOpacity) || 0.25)),
    }
  } catch (err) {
    console.error('[finalize-artwork] Vision error:', err)
    return { textCenterY: 0.18, overlayOpacity: 0.3 }
  }
}

// ── Composite artist + title text onto image ────────────────────────────────
async function buildFinalized(
  imageBuffer: Buffer,
  title: string,
  artist: string,
  placement: { textCenterY: number; overlayOpacity: number }
): Promise<Buffer> {
  const img = sharp(imageBuffer)
  const { width = 1024, height = 1024 } = await img.metadata()

  const cx = Math.round(width * 0.5)
  const cy = Math.round(placement.textCenterY * height)

  // Typography — proportions tuned to match the reference image
  const artistSize = Math.round(width * 0.031)
  const titleSize  = Math.round(width * 0.064)
  const lineGap    = Math.round(width * 0.014)
  const totalH     = artistSize + lineGap + titleSize

  const artistY = Math.round(cy - totalH / 2 + artistSize)
  const titleY  = Math.round(artistY + lineGap + titleSize)

  // Feathered dark gradient overlay for readability when needed
  const overlayH = Math.round(totalH * 4)
  const overlayY = Math.max(0, Math.round(cy - overlayH / 2))
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

  // Text — Futura/Century Gothic stack, artist small above, title large below
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

  // 2. Claude Vision picks text placement
  const placement = await analyzePlacement(artwork_url)

  // 3. Render finalized artwork
  const finalBuffer = await buildFinalized(imageBuffer, title, artist || 'moodmixformat', placement)

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

  return NextResponse.json({ artwork_url: finalUrl })
}
