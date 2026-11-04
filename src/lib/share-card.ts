// The link card — the 1200×630 image a chat app shows under a share link.
//
// Drawn once per song by GET /api/share/<token>/card: the cover large on the
// left, the title and artist on the right over a blurred wash of the same
// cover, a play badge. Before this, previewers got the raw square cover and
// the words "Listen to X by Y on mixBASE" — the weakest part of the whole
// share, and the first thing anyone sees.
//
// Text goes through libvips' Pango rasteriser with the bundled Futura files
// (fontfile — no system fontconfig needed), exactly like finalize-render.ts,
// because that is the path proven to work on Railway. The route is traced in
// next.config.ts (outputFileTracingIncludes) so the .ttf files ship with it.
import sharp, { type OverlayOptions } from 'sharp'
import { join } from 'node:path'

export const CARD_W = 1200
export const CARD_H = 630

const BOLD = join(process.cwd(), 'src/fonts/FuturaBold.ttf')
const BOOK = join(process.cwd(), 'src/fonts/FuturaBook.ttf')
const BRAND_ACCENT = { r: 45, g: 212, b: 191 } // --accent (#2dd4bf)

// Layout
const COVER = 430
const COVER_X = 90
const COVER_Y = (CARD_H - COVER) / 2
const TEXT_X = COVER_X + COVER + 70
const TEXT_W = CARD_W - TEXT_X - 70

export type CardInput = {
  title: string
  artist: string
  /** Secondary line under the artist: the mix label ("Mix 3 · Final"). */
  label?: string | null
  /** Cover bytes (any image sharp reads). Null draws the no-art card. */
  cover: Buffer | null
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function hex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}
// Lift a muddy dominant colour toward something that reads as an accent on
// black: mix toward white when dark, pull saturation up a little.
function brighten(c: { r: number; g: number; b: number }) {
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  if (lum >= 120) return c
  const t = (120 - lum) / 120 * 0.6
  return { r: c.r + (255 - c.r) * t, g: c.g + (255 - c.g) * t, b: c.b + (255 - c.b) * t }
}

async function text(markup: string, font: string, fontfile: string, px: number, width?: number): Promise<{ png: Buffer; w: number; h: number }> {
  const png = await sharp({
    text: {
      text: markup,
      fontfile,
      font: `${font} ${Math.round(px)}`,
      dpi: 72,
      rgba: true,
      ...(width ? { width, wrap: 'word' as const } : {}),
    },
  }).png().toBuffer()
  const m = await sharp(png).metadata()
  return { png, w: m.width ?? 1, h: m.height ?? 1 }
}

// Title: Futura Bold, shrunk until it fits in two lines of the text column.
async function titleBlock(title: string): Promise<{ png: Buffer; w: number; h: number }> {
  const t = title.length > 70 ? `${title.slice(0, 69).trimEnd()}…` : title
  for (const px of [78, 68, 60, 52, 46, 40]) {
    const r = await text(`<span foreground="#ffffff">${esc(t)}</span>`, 'Futura Bold', BOLD, px, TEXT_W)
    if (r.h <= px * 2.4) return r
  }
  return text(`<span foreground="#ffffff">${esc(t)}</span>`, 'Futura Bold', BOLD, 40, TEXT_W)
}

function roundedMask(size: number, radius: number): Buffer {
  return Buffer.from(`<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`)
}

export async function renderShareCard(input: CardInput): Promise<Buffer> {
  let accent = BRAND_ACCENT
  let backdrop: Buffer
  let coverTile: Buffer | null = null

  if (input.cover) {
    const src = sharp(input.cover, { limitInputPixels: 40_000_000 }).rotate()
    const [stats, tile, wash] = await Promise.all([
      src.clone().resize(48, 48, { fit: 'cover' }).stats(),
      src.clone().resize(COVER, COVER, { fit: 'cover' }).png().toBuffer(),
      src.clone().resize(CARD_W, CARD_H, { fit: 'cover' }).blur(42).modulate({ brightness: 0.42, saturation: 1.5 }).png().toBuffer(),
    ])
    accent = brighten(stats.dominant)
    backdrop = wash
    coverTile = await sharp(tile).composite([{ input: roundedMask(COVER, 30), blend: 'dest-in' }]).png().toBuffer()
  } else {
    const a = hex(accent)
    backdrop = Buffer.from(
      `<svg width="${CARD_W}" height="${CARD_H}"><defs><radialGradient id="g" cx="25%" cy="50%" r="70%"><stop offset="0" stop-color="${a}" stop-opacity="0.35"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="#0a0806"/><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
    )
  }
  const accentHex = hex(accent)

  // Vignette over the wash so the type always sits on something dark.
  const vignette = Buffer.from(
    `<svg width="${CARD_W}" height="${CARD_H}"><defs><linearGradient id="h" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.25"/><stop offset="0.55" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#h)"/></svg>`,
  )
  // Drop shadow under the cover.
  const shadow = Buffer.from(
    `<svg width="${COVER + 160}" height="${COVER + 160}"><defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="28"/></filter></defs><rect x="80" y="100" width="${COVER}" height="${COVER}" rx="30" fill="#000" fill-opacity="0.75" filter="url(#b)"/></svg>`,
  )

  const layers: OverlayOptions[] = [
    { input: vignette, left: 0, top: 0 },
    { input: shadow, left: COVER_X - 80, top: Math.round(COVER_Y) - 80 },
  ]
  if (coverTile) {
    layers.push({ input: coverTile, left: COVER_X, top: Math.round(COVER_Y) })
  } else {
    const empty = Buffer.from(
      `<svg width="${COVER}" height="${COVER}"><rect width="100%" height="100%" rx="30" fill="#141210"/><g fill="none" stroke="${accentHex}" stroke-opacity="0.8" stroke-width="10" stroke-linecap="round"><rect x="95" y="150" width="240" height="130" rx="18"/><circle cx="160" cy="215" r="26"/><circle cx="270" cy="215" r="26"/></g></svg>`,
    )
    layers.push({ input: empty, left: COVER_X, top: Math.round(COVER_Y) })
  }

  // ── Type column ────────────────────────────────────────────────────────────
  const wordmark = await text(`<span foreground="#ffffff">mix</span><span foreground="${accentHex}">BASE</span>`, 'Futura Bold', BOLD, 30)
  const title = await titleBlock(input.title || 'Untitled')
  const artist = await text(`<span foreground="${accentHex}">${esc(input.artist)}</span>`, 'Futura Medium', BOOK, 38, TEXT_W)
  const label = input.label ? await text(`<span foreground="#ffffff" alpha="55%">${esc(input.label)}</span>`, 'Futura Medium', BOOK, 26, TEXT_W) : null
  const cta = await text(`<span foreground="#ffffff" alpha="80%">Listen on mixBASE</span>`, 'Futura Medium', BOOK, 28)

  // Vertically centre the title/artist/label stack in the card.
  const gap = 18
  const stackH = title.h + gap + artist.h + (label ? gap * 0.6 + label.h : 0)
  let y = Math.round((CARD_H - stackH) / 2) + 10
  layers.push({ input: wordmark.png, left: TEXT_X, top: 72 })
  layers.push({ input: title.png, left: TEXT_X, top: y }); y += title.h + gap
  layers.push({ input: artist.png, left: TEXT_X, top: y }); y += artist.h
  if (label) { y += Math.round(gap * 0.6); layers.push({ input: label.png, left: TEXT_X, top: y }) }

  // Play badge + call to action along the bottom of the column.
  const badge = 56
  const badgeY = CARD_H - 72 - badge
  const play = Buffer.from(
    `<svg width="${badge}" height="${badge}"><circle cx="${badge / 2}" cy="${badge / 2}" r="${badge / 2}" fill="${accentHex}"/><polygon points="${badge * 0.4},${badge * 0.3} ${badge * 0.4},${badge * 0.7} ${badge * 0.74},${badge * 0.5}" fill="#000"/></svg>`,
  )
  layers.push({ input: play, left: TEXT_X, top: badgeY })
  layers.push({ input: cta.png, left: TEXT_X + badge + 18, top: badgeY + Math.round((badge - cta.h) / 2) })

  return sharp(backdrop).composite(layers).png({ compressionLevel: 8 }).toBuffer()
}
