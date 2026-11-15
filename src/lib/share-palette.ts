// The colours a share page is lit with, read off the song's own cover.
//
// Before this the two public players took ONE colour: the average of an 8×8
// copy of the cover, multiplied up. An average is the colour of mud — the
// owner's covers are earth, amber and cream, and every one of them averaged to
// a dull brown, so every page was a dim brown room. This module reads a small
// PALETTE instead: the cover's strongest hue families, each lifted into a
// colour bright enough to be a light, so the backdrop glows in the cover's own
// colours and no two songs look the same.
//
// Pure maths on a pixel buffer — no DOM — so scripts/share-palette-test.mjs can
// run it on real cover samples. The browser half (decoding an image into
// pixels) lives in src/lib/share-fx.ts.

export type RGB = [number, number, number]

export type SharePalette = {
  /** The one colour for controls: play button, waveform, chips. Always light
   *  enough for the black icons drawn on it. */
  accent: RGB
  /** Three lights for the backdrop, strongest first. */
  glow: [RGB, RGB, RGB]
  /** A near-white tinted with the cover — the foot of the title's letters. */
  ink: RGB
  /** The cover has next to no colour (a black-and-white photograph, a pencil
   *  drawing): the lights are tinted neutrals rather than an invented hue. */
  muted: boolean
  /** How bright the cover is overall, 0 (black) – 1 (white). The backdrop is
   *  the cover itself, blurred; white type has to stay readable on a pale one,
   *  so the page dims a bright cover more than a dark one. */
  tone: number
}

// What the page wears until a cover has been read, and when there is none:
// the violet the players have always started from, with two neighbours.
export const DEFAULT_PALETTE: SharePalette = {
  accent: [167, 139, 250],
  glow: [[139, 92, 246], [56, 189, 248], [236, 72, 153]],
  ink: [233, 226, 255],
  muted: false,
  tone: 0.12,
}

// What the page wears for the moment between opening and the cover's colours
// arriving: no colour at all, so the lights can come UP in the right colours
// instead of starting violet and jumping. (Compared by identity.)
export const PENDING_PALETTE: SharePalette = {
  accent: [236, 232, 226],
  glow: [[120, 116, 110], [96, 96, 104], [140, 134, 124]],
  ink: [255, 255, 255],
  muted: true,
  tone: 0.12,
}

// ── Colour maths ────────────────────────────────────────────────────────────
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === R) h = ((G - B) / d) % 6
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, Math.min(1, s), l]
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const H = (((h % 360) + 360) % 360) / 60
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((H % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    H < 1 ? [c, x, 0] : H < 2 ? [x, c, 0] : H < 3 ? [0, c, x] : H < 4 ? [0, x, c] : H < 5 ? [x, 0, c] : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** WCAG relative luminance, 0 (black) – 1 (white). */
export function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

// Black icons sit on the accent (the play button). A deep blue or a blood red
// is vivid and still too dark to read a black triangle on, so the accent is
// walked toward white until it carries one.
const ACCENT_MIN_LUMINANCE = 0.3
function liftForControls(c: RGB): RGB {
  let out = c
  for (let i = 0; i < 20 && luminance(out) < ACCENT_MIN_LUMINANCE; i++) out = mix(out, [255, 255, 255], 0.08)
  return out
}

// A colour found on the cover → the same colour as a LIGHT: same hue, more
// saturated, and brought into the band where it glows on a dark page (a deep
// maroon stays red but stops being black; a pale peach stays peach but stops
// being white).
function asLight([r, g, b]: RGB): RGB {
  const [h, s, l] = rgbToHsl(r, g, b)
  return hslToRgb(h, clamp(s * 1.3 + 0.12, 0.52, 0.92), clamp(l, 0.47, 0.62))
}

// ── Reading a cover ─────────────────────────────────────────────────────────
// Pixels vote for their hue (24 families of 15°), weighted by how coloured
// they are, so a wall of faint beige cannot outvote the red thing in front of
// it — but a family also has to cover a real share of the picture to be
// chosen, so three tiny stripes on a cassette label do not repaint the page.
const BINS = 24
const BIN_DEG = 360 / BINS
// A pixel "has a colour" from here up: chroma as a share of full scale, and
// saturation (so a dark olive counts and a dark grey does not).
const MIN_CHROMA = 0.04
const MIN_SATURATION = 0.16
// A second or third colour must be at least this far round the wheel from the
// ones already taken, carry this share of the leader's weight, and cover this
// share of the picture.
const MIN_SEPARATION_BINS = 3
const MIN_RELATIVE_WEIGHT = 0.1
const MIN_COVERAGE = 0.02
// Under this share of coloured pixels the cover is treated as having none.
const MUTED_COVERAGE = 0.05
// How far round the wheel a one-colour cover's two companion lights sit.
const NEIGHBOUR_DEG = 18

const binDistance = (a: number, b: number) => {
  const d = Math.abs(a - b)
  return Math.min(d, BINS - d)
}

/**
 * Palette of an image given as RGBA bytes (canvas ImageData order). Fully
 * transparent or empty input returns DEFAULT_PALETTE.
 */
export function paletteFromPixels(data: ArrayLike<number>): SharePalette {
  const weight = new Float64Array(BINS)
  const count = new Float64Array(BINS)
  const sumR = new Float64Array(BINS)
  const sumG = new Float64Array(BINS)
  const sumB = new Float64Array(BINS)
  let pixels = 0
  let avgR = 0, avgG = 0, avgB = 0

  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    pixels++
    avgR += r; avgG += g; avgB += b
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const chroma = (max - min) / 255
    if (chroma < MIN_CHROMA) continue
    const [h, s] = rgbToHsl(r, g, b)
    if (s < MIN_SATURATION) continue
    const bin = Math.min(BINS - 1, Math.floor(h / BIN_DEG))
    // chroma^1.5: a saturated pixel is worth several washed-out ones.
    const w = Math.pow(chroma, 1.5)
    weight[bin] += w
    count[bin] += 1
    sumR[bin] += r * w; sumG[bin] += g * w; sumB[bin] += b * w
  }
  if (pixels === 0) return DEFAULT_PALETTE

  const average: RGB = [Math.round(avgR / pixels), Math.round(avgG / pixels), Math.round(avgB / pixels)]
  let coloured = 0
  for (let i = 0; i < BINS; i++) coloured += count[i]

  const tone = luminance(average)
  if (coloured / pixels < MUTED_COVERAGE) return mutedPalette(average, tone)

  // A hue that straddles two families must not lose to one that sits in the
  // middle of its own: each family is judged with its neighbours.
  const at = (arr: Float64Array, i: number) => arr[((i % BINS) + BINS) % BINS]
  const family = (arr: Float64Array, i: number) => at(arr, i) + 0.5 * (at(arr, i - 1) + at(arr, i + 1))
  const colourOf = (i: number): RGB => {
    const w = family(weight, i)
    return [Math.round(family(sumR, i) / w), Math.round(family(sumG, i) / w), Math.round(family(sumB, i) / w)]
  }

  const picks: number[] = []
  let leader = 0
  for (let i = 1; i < BINS; i++) if (family(weight, i) > family(weight, leader)) leader = i
  picks.push(leader)
  const leaderWeight = family(weight, leader)

  while (picks.length < 3) {
    let best = -1
    for (let i = 0; i < BINS; i++) {
      if (picks.some(p => binDistance(p, i) < MIN_SEPARATION_BINS)) continue
      if (family(weight, i) < leaderWeight * MIN_RELATIVE_WEIGHT) continue
      if (family(count, i) / pixels < MIN_COVERAGE) continue
      if (best === -1 || family(weight, i) > family(weight, best)) best = i
    }
    if (best === -1) break
    picks.push(best)
  }

  const lights = picks.map(i => asLight(colourOf(i)))
  // A cover in one colour family gets that colour's neighbours, not a stranger
  // from across the wheel: amber brings gold and ember, blue brings indigo and
  // cyan. With two real colours the third leans away from the second. The step
  // is small on purpose — 30° from orange is an acid lime no cover asked for.
  const [h0, s0, l0] = rgbToHsl(...lights[0])
  if (lights.length === 1) {
    lights.push(hslToRgb(h0 + NEIGHBOUR_DEG, s0, clamp(l0 + 0.05, 0.47, 0.64)))
    lights.push(hslToRgb(h0 - NEIGHBOUR_DEG, clamp(s0 * 0.95, 0.5, 0.92), clamp(l0 - 0.06, 0.42, 0.6)))
  } else if (lights.length === 2) {
    const [h1] = rgbToHsl(...lights[1])
    const towardSecond = ((h1 - h0 + 540) % 360) - 180
    lights.push(hslToRgb(h0 + (towardSecond > 0 ? -NEIGHBOUR_DEG : NEIGHBOUR_DEG), s0, clamp(l0 + 0.04, 0.47, 0.64)))
  }

  const glow: [RGB, RGB, RGB] = [lights[0], lights[1], lights[2]]
  return {
    accent: liftForControls(glow[0]),
    glow,
    ink: mix([255, 255, 255], glow[0], 0.26),
    muted: false,
    tone,
  }
}

// No colour to speak of: light the page in the cover's own faint cast (a warm
// paper white for a sepia photograph, a cool silver for a blue-black one)
// rather than inventing a hue the picture does not have.
function mutedPalette(average: RGB, tone: number): SharePalette {
  const [h, s] = rgbToHsl(...average)
  // A truly grey average has no meaningful hue; lean warm, like paper.
  const hue = s < 0.03 ? 38 : h
  const glow: [RGB, RGB, RGB] = [
    hslToRgb(hue, 0.24, 0.74),
    hslToRgb(hue + 38, 0.16, 0.58),
    hslToRgb(hue - 30, 0.2, 0.84),
  ]
  return {
    accent: hslToRgb(hue, 0.22, 0.86),
    glow,
    ink: hslToRgb(hue, 0.3, 0.93),
    muted: true,
    tone,
  }
}

// ── CSS helpers ─────────────────────────────────────────────────────────────
export const rgbCss = ([r, g, b]: RGB) => `rgb(${r},${g},${b})`
export const rgbaCss = ([r, g, b]: RGB, a: number) => `rgba(${r},${g},${b},${a})`
/** "r,g,b" — for a CSS variable used inside rgba(var(--x), a). */
export const rgbTriplet = ([r, g, b]: RGB) => `${r},${g},${b}`
