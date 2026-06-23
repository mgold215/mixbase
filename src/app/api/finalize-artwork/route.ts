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

type Align = 'left' | 'center' | 'right'
type Vertical = 'top' | 'middle' | 'bottom'
type Size = 'small' | 'medium' | 'large'
type Filter = 'none' | 'warm' | 'golden' | 'sepia' | 'cool' | 'icy' | 'vivid' | 'mono'
const FILTERS: Filter[] = ['none', 'warm', 'golden', 'sepia', 'cool', 'icy', 'vivid', 'mono']

// Whole-image color grade. recomb scales the RGB channels (diagonal matrix) for
// warm/cool casts that keep the photo's own colors; modulate boosts saturation;
// grayscale for B&W; sepia uses the classic recomb matrix.
//
// recomb needs a 3-channel image, so the cast filters flatten alpha first.
// flatten() composites transparent pixels onto FLATTEN_BG — we must NOT use
// removeAlpha(), which only drops the channel and would expose whatever RGB was
// hidden under transparent pixels in an uploaded PNG/WebP/GIF. Black matches the
// background Sharp's JPEG encoder flattens to on the none/vivid/mono paths, so
// transparent artwork renders identically regardless of filter.
const FLATTEN_BG = { r: 0, g: 0, b: 0 }
function applyFilter(img: sharp.Sharp, filter: Filter): sharp.Sharp {
  switch (filter) {
    case 'warm':   return img.flatten({ background: FLATTEN_BG }).recomb([[1.12, 0, 0], [0, 1.04, 0], [0, 0, 0.88]])
    case 'golden': return img.flatten({ background: FLATTEN_BG }).recomb([[1.20, 0, 0], [0, 1.05, 0], [0, 0, 0.80]]).modulate({ saturation: 1.1 })
    case 'sepia':  return img.flatten({ background: FLATTEN_BG }).recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]])
    case 'cool':   return img.flatten({ background: FLATTEN_BG }).recomb([[0.88, 0, 0], [0, 1.00, 0], [0, 0, 1.15]])
    case 'icy':    return img.flatten({ background: FLATTEN_BG }).recomb([[0.82, 0, 0], [0, 0.98, 0], [0, 0, 1.22]]).modulate({ saturation: 1.05 })
    case 'vivid':  return img.modulate({ saturation: 1.45 })
    case 'mono':   return img.grayscale()
    default:       return img
  }
}

// `${vertical}-${horizontal}` — a 3×3 anchor grid the user picks from.
const POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const
type Position = (typeof POSITIONS)[number]

// ── Convert text → SVG path data via opentype.js ─────────────────────────────
// Glyphs are rendered as crisp vector paths. Legibility on busy backgrounds
// comes from a thin black outline drawn UNDER the white fill (stroke layer
// first, fill layer on top) — NOT from a raster blur filter, which librsvg
// rasterizes at the small artist-line size and visibly mangles glyphs.
function textToSvgPaths(
  text: string,
  anchorX: number,
  baselineY: number,
  fontSize: number,
  letterSpacing: number,
  align: Align,
  fill: string,
  fillOpacity: number,
  strokeWidth: number,
  strokeOpacity: number
): { markup: string; totalW: number } {
  const glyphs = FONT.stringToGlyphs(text)
  const scale  = fontSize / FONT.unitsPerEm

  let totalW = 0
  glyphs.forEach((g, i) => {
    totalW += (g.advanceWidth ?? 0) * scale
    if (i < glyphs.length - 1) totalW += letterSpacing
  })

  let x =
    align === 'left'  ? anchorX :
    align === 'right' ? anchorX - totalW :
                        anchorX - totalW / 2

  const strokeParts: string[] = []
  const fillParts: string[] = []
  for (const g of glyphs) {
    const svgEl = g.getPath(x, baselineY, fontSize).toSVG(1) as string
    const d = svgEl.match(/d="([^"]+)"/)?.[1]
    if (d) {
      if (strokeWidth > 0) {
        strokeParts.push(`<path d="${d}" fill="none" stroke="#000" stroke-width="${strokeWidth}" stroke-opacity="${strokeOpacity}" stroke-linejoin="round"/>`)
      }
      fillParts.push(`<path d="${d}" fill="${fill}" fill-opacity="${fillOpacity}"/>`)
    }
    x += (g.advanceWidth ?? 0) * scale + letterSpacing
  }

  // Stroke layer underneath, fill layer on top — guarantees a clean outline
  // without relying on paint-order support in librsvg.
  return { markup: `${strokeParts.join('\n')}\n${fillParts.join('\n')}`, totalW }
}

// Measure the rendered width of a line at a given size — used to auto-shrink
// text so it can never overflow the canvas (the "cut off" bug).
function measureWidth(text: string, fontSize: number, letterSpacing: number): number {
  const glyphs = FONT.stringToGlyphs(text)
  const scale = fontSize / FONT.unitsPerEm
  let w = 0
  glyphs.forEach((g, i) => {
    w += (g.advanceWidth ?? 0) * scale
    if (i < glyphs.length - 1) w += letterSpacing
  })
  return w
}

// ── Build finalized artwork: source pixels untouched, text composited on top ─
async function buildFinalized(
  imageBuffer: Buffer,
  title: string,
  artist: string,
  position: Position,
  size: Size,
  showRule: boolean,
  filter: Filter
): Promise<Buffer> {
  let img = sharp(imageBuffer)
  const { width = 1024, height = 1024 } = await img.metadata()

  const [vertical, horizontal] = position.split('-') as [Vertical, Align]
  const align = horizontal
  const pad = Math.round(width * 0.05)
  const maxW = width - pad * 2

  const artistText = artist.toLowerCase()
  const titleText = title.toUpperCase()

  // Typography — small album-overlay scale, multiplied by the chosen size.
  const sizeMul = size === 'small' ? 0.85 : size === 'large' ? 1.2 : 1.0
  let artistSize = Math.round(width * 0.023 * sizeMul)
  let titleSize  = Math.round(width * 0.038 * sizeMul)

  // Auto-fit: if a line would exceed the usable width, shrink it to fit so
  // nothing ever runs off the edge — regardless of title length or alignment.
  const titleW0 = measureWidth(titleText, titleSize, titleSize * 0.04)
  if (titleW0 > maxW) titleSize = Math.max(8, Math.floor(titleSize * maxW / titleW0))
  const artistW0 = measureWidth(artistText, artistSize, artistSize * 0.12)
  if (artistW0 > maxW) artistSize = Math.max(6, Math.floor(artistSize * maxW / artistW0))

  const artistLS = Math.round(artistSize * 0.12)
  const titleLS  = Math.round(titleSize  * 0.04)
  const ruleH    = showRule ? Math.max(2, Math.round(width * 0.0035)) : 0
  const gapAbove = showRule ? Math.round(width * 0.012) : Math.round(width * 0.006)
  const gapBelow = showRule ? Math.round(width * 0.010) : Math.round(width * 0.004)
  const totalH   = artistSize + gapAbove + ruleH + gapBelow + titleSize

  // Vertical anchor → top of the text block.
  const blockTop =
    vertical === 'top'    ? pad :
    vertical === 'bottom' ? height - pad - totalH :
                            Math.round((height - totalH) / 2)

  const artistY = blockTop + artistSize
  const ruleY   = artistY + gapAbove
  const titleY  = ruleY + ruleH + gapBelow + titleSize

  // The 3×3 grid positions the text BLOCK (in a corner/edge). Inside the block
  // both lines and the rule are always centered on the block's center, so a
  // short title stays centered under the line regardless of chosen position.
  const artistW = measureWidth(artistText, artistSize, artistLS)
  const titleW  = measureWidth(titleText, titleSize, titleLS)
  const blockW  = Math.max(artistW, titleW)
  const blockCenterX =
    align === 'left'  ? Math.round(pad + blockW / 2) :
    align === 'right' ? Math.round(width - pad - blockW / 2) :
                        Math.round(width / 2)

  // No outline on the small artist line — at this size the stroke closes up
  // the narrow counters of letters like 'm', collapsing them to read as 'rn'.
  // The big title keeps a light outline (wide counters, needs legibility).
  const titleStroke = Math.max(1, Math.round(titleSize * 0.05))

  const { markup: artistPaths } = textToSvgPaths(
    artistText, blockCenterX, artistY, artistSize, artistLS, 'center', 'white', 1.0, 0, 0
  )
  const { markup: titlePaths } = textToSvgPaths(
    titleText, blockCenterX, titleY, titleSize, titleLS, 'center', 'white', 1.0, titleStroke, 0.5
  )

  // Horizontal rule — spans the block width, centered on the block.
  const ruleW = Math.round(blockW)
  const ruleX = Math.round(blockCenterX - ruleW / 2)
  const ruleSvg = showRule
    ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.9"/>`
    : ''

  // Color grade the whole photo (text is composited on top afterwards, so it
  // stays clean white). Channel scaling via recomb gives warm/cool casts that
  // preserve the image's own colors; modulate/grayscale handle vivid and B&W.
  img = applyFilter(img, filter)

  const textSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${artistPaths}
      ${titlePaths}
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

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { project_id, artist } = body
  if (!isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }

  // Deterministic, user-chosen layout — no Vision guesswork.
  const position: Position = POSITIONS.includes(body.position) ? body.position : 'top-left'
  const size: Size = ['small', 'medium', 'large'].includes(body.size) ? body.size : 'medium'
  // Divider line on by default — omit only when the client explicitly says false.
  const showRule: boolean = body.showRule !== false
  const filter: Filter = FILTERS.includes(body.filter) ? body.filter : 'none'

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

  const finalBuffer = await buildFinalized(
    imageBuffer, project.title, artist || 'moodmixformat', position, size, showRule, filter
  )

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

  const { error: dbError } = await supabaseAdmin
    .from('mb_projects')
    .update({ finalized_artwork_url: finalUrl, updated_at: new Date().toISOString() })
    .eq('id', project_id)
    .eq('user_id', userId) // defense-in-depth: scope the write to the owner
  if (dbError) {
    // The render uploaded fine but the URL didn't persist — surface it rather
    // than returning a success the next page load won't reflect.
    console.error('[finalize-artwork] DB update error:', dbError.message)
    return NextResponse.json({ error: 'Saved image but failed to update project. Please retry.' }, { status: 500 })
  }

  return NextResponse.json({ finalized_artwork_url: finalUrl, position, size, showRule, filter })
}
