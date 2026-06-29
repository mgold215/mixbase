import sharp from 'sharp'
import { join } from 'path'

// Real Futura Bold, passed straight to libvips' Pango text rasteriser via
// `fontfile` (no system fontconfig install needed). The .ttf is bundled into the
// finalize route's deploy by `outputFileTracingIncludes` in next.config.ts.
const FONT_PATH = join(process.cwd(), 'src/fonts/FuturaBold.ttf')
const FONT_DESC = 'Futura Bold'

export type Align = 'left' | 'center' | 'right'
export type Vertical = 'top' | 'middle' | 'bottom'
export type Size = 'small' | 'medium' | 'large'
export type Filter = 'none' | 'warm' | 'golden' | 'sepia' | 'cool' | 'icy' | 'vivid' | 'mono'
export const FILTERS: Filter[] = ['none', 'warm', 'golden', 'sepia', 'cool', 'icy', 'vivid', 'mono']

// Whole-image color grade. recomb scales the RGB channels (diagonal matrix) for
// warm/cool casts that keep the photo's own colors; modulate boosts saturation;
// grayscale for B&W; sepia uses the classic recomb matrix.
//
// recomb needs a 3-channel image, so the cast filters flatten alpha first onto
// black (matching the JPEG encoder's flatten background) so transparent artwork
// renders identically regardless of filter.
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
export const POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const
export type Position = (typeof POSITIONS)[number]

// Supersample factor for the text rasters — render glyphs at R× the final size
// and downscale, so edges stay crisp at the small album-overlay sizes.
const R = 3

function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Rasterise one line of white text via Pango. We render through libvips' text
// operator rather than hand-building glyph SVG paths: opentype→SVG→librsvg fill
// intermittently mangled glyphs with tight, repeated stems ('m' read as 'n')
// depending on the glyph's sub-pixel position — a cairo fill bug we cannot
// control. Pango rasterises reliably at every size and position.
// Returns the layer plus its rendered pixel size (at R× scale).
async function renderLine(text: string, pxSize: number, letterSpacingPx: number): Promise<{ buf: Buffer; w: number; h: number }> {
  // letter_spacing is in Pango units (1024 per point); at dpi 72 one point is
  // one pixel, so px × 1024 gives the right tracking. Scale everything by R.
  const ls = Math.max(0, Math.round(letterSpacingPx * R * 1024))
  const markup = `<span letter_spacing="${ls}">${escapeMarkup(text)}</span>`
  const buf = await sharp({
    text: {
      text: markup,
      fontfile: FONT_PATH,
      font: `${FONT_DESC} ${Math.max(1, Math.round(pxSize * R))}`,
      dpi: 72,
      rgba: true,
    },
  }).png().toBuffer()
  const m = await sharp(buf).metadata()
  return { buf, w: m.width ?? 1, h: m.height ?? 1 }
}

// ── Build finalized artwork: source pixels untouched, text composited on top ─
export async function buildFinalized(
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

  // Render both lines, then auto-shrink any line that would exceed the usable
  // width so nothing ever runs off the edge — regardless of title length.
  let artistLine = await renderLine(artistText, artistSize, artistSize * 0.12)
  let titleLine  = await renderLine(titleText,  titleSize,  titleSize  * 0.04)

  let artistW = artistLine.w / R
  if (artistW > maxW) {
    artistSize = Math.max(6, Math.floor(artistSize * maxW / artistW))
    artistLine = await renderLine(artistText, artistSize, artistSize * 0.12)
    artistW = artistLine.w / R
  }
  let titleW = titleLine.w / R
  if (titleW > maxW) {
    titleSize = Math.max(8, Math.floor(titleSize * maxW / titleW))
    titleLine = await renderLine(titleText, titleSize, titleSize * 0.04)
    titleW = titleLine.w / R
  }
  const ruleH    = showRule ? Math.max(2, Math.round(width * 0.0035)) : 0
  const gapAbove = showRule ? Math.round(width * 0.012) : Math.round(width * 0.006)
  const gapBelow = showRule ? Math.round(width * 0.010) : Math.round(width * 0.004)

  // ── Assemble the text block at R× then downscale ────────────────────────
  // Work entirely in integer R-pixel coordinates and size the canvas to the
  // actual layer extents, so accumulated rounding can never push a layer past
  // the canvas edge (which sharp rejects). Both lines are centered in the
  // block; the rule spans its width. blockW/totalH are derived back from the
  // R-canvas so on-image positioning stays consistent.
  const artistWR = artistLine.w, artistHR = artistLine.h
  const titleWR  = titleLine.w,  titleHR  = titleLine.h
  const blockWR  = Math.max(artistWR, titleWR)
  const ruleHR   = ruleH > 0 ? Math.max(1, Math.round(ruleH * R)) : 0
  const artistTopR = 0
  const ruleTopR   = artistHR + Math.round(gapAbove * R)
  const titleTopR  = ruleTopR + ruleHR + Math.round(gapBelow * R)
  const artistLeftR = Math.round((blockWR - artistWR) / 2)
  const titleLeftR  = Math.round((blockWR - titleWR) / 2)

  const Rw = blockWR
  const Rh = titleTopR + titleHR
  const blockLayers: sharp.OverlayOptions[] = [
    { input: artistLine.buf, top: artistTopR, left: artistLeftR },
  ]
  if (ruleHR > 0) {
    const ruleRect = await sharp({ create: { width: Rw, height: ruleHR, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer()
    blockLayers.push({ input: ruleRect, top: ruleTopR, left: 0 })
  }
  blockLayers.push({ input: titleLine.buf, top: titleTopR, left: titleLeftR })

  const blockR = await sharp({ create: { width: Rw, height: Rh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(blockLayers)
    .png().toBuffer()
  const blockW = Math.max(1, Math.round(Rw / R))
  const totalH = Math.max(1, Math.round(Rh / R))
  const blockNative = await sharp(blockR).resize(blockW, totalH, { kernel: 'lanczos3' }).png().toBuffer()

  // Vertical anchor → top of the text block; horizontal anchor → its left edge.
  const blockTop =
    vertical === 'top'    ? pad :
    vertical === 'bottom' ? height - pad - totalH :
                            Math.round((height - totalH) / 2)
  const blockLeft =
    align === 'left'  ? pad :
    align === 'right' ? width - pad - blockW :
                        Math.round((width - blockW) / 2)

  // Soft dark halo behind the white text so it stays legible on light/busy
  // backgrounds (sky, concrete). Pad the block first so the blurred glow isn't
  // clipped at the block's edge.
  const shadowBlur = Math.max(1.5, width * 0.0022)
  const M = Math.ceil(shadowBlur * 3) + 2
  const padded = await sharp(blockNative)
    .extend({ top: M, bottom: M, left: M, right: M, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()
  const pw = blockW + 2 * M
  const ph = totalH + 2 * M
  const blurredAlpha = await sharp(padded)
    .ensureAlpha().extractChannel(3).blur(shadowBlur).linear(0.9, 0).toColourspace('b-w')
    .png().toBuffer()
  const halo = await sharp({ create: { width: pw, height: ph, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(blurredAlpha)
    .png().toBuffer()

  // Color grade the whole photo (text composited on top afterwards stays clean).
  img = applyFilter(img, filter)

  const compTop = Math.max(0, blockTop - M)
  const compLeft = Math.max(0, blockLeft - M)

  // Output JPEG at high quality with 4:4:4 chroma — preserves saturated edges.
  return img
    .composite([
      { input: halo, top: compTop, left: compLeft, blend: 'over' },
      { input: padded, top: compTop, left: compLeft, blend: 'over' },
    ])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer()
}
