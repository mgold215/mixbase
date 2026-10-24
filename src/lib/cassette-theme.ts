// Cassette Studio — the owner's THEME: one saved recipe that every release is
// rendered in, so the covers and clips read as one body of work (the same
// cassette, framed the same way, lettered the same way, finished with the
// same look, moving the same way) while the SCENE changes from song to song.
//
// Client-safe (no sharp, no server imports): both screens show and edit the
// theme, the routes store it, scripts/cassette-theme-test.mjs pins the key.
//
// ── Storage ─────────────────────────────────────────────────────────────────
// One 1×1 PNG in the owner's studio folder whose KEY holds the recipe (the
// mf-artwork bucket takes images only, and every other studio file already
// carries its metadata the same way):
//
//   studio/<userId>/theme-<ts>-s<subject>-p<x>-<y>-<scale>-l<mode><align>-c<color>-<position>-<size>-f<look>-m<formats>-t<0|1>.png
//
//   ts        when the theme was saved (the newest one wins)
//   subject   the stamp of the cassette cut-out, subject-<stamp>.png
//   x y scale where the cassette goes, as whole percents of the cover, or `a`
//             for the server's own framing (placeSubject's default)
//   mode      what the handwriting says: t = the song's title, typed from the
//             glyph bank; b = artist name + title, typed; e = the song's own
//             photographed lettering, if it has one; n = none
//   align     typed lettering alignment: l / c / r
//   color     ink: rrggbb or `auto`
//   position  one of LETTERING_POSITIONS;  size  one of LETTERING_SIZES
//   look      a cover-filters code (encodeFilter), or 0 for none
//   formats   which clips to render and pin after the cover: a run of
//             c (canvas) s (square) y (youtube) t (story), or 0 for none
//   t         1 = the clips carry the handwritten title, 0 = plain
//
// parseThemeKey pins the shape, and the owner via the prefix, before a key is
// ever acted on.

import { decodeFilter, encodeFilter, type FilterSettings } from './cover-filters.ts'
import { LETTERING_POSITIONS, LETTERING_SIZES, type LetteringPosition, type LetteringSize } from './cassette-studio.ts'

export const THEME_LETTERING_MODES = ['title', 'artist-title', 'existing', 'none'] as const
export type ThemeLetteringMode = (typeof THEME_LETTERING_MODES)[number]
export const THEME_ALIGNS = ['left', 'center', 'right'] as const
export type ThemeAlign = (typeof THEME_ALIGNS)[number]
export const THEME_FORMATS = ['canvas', 'square', 'youtube', 'story'] as const
export type ThemeFormat = (typeof THEME_FORMATS)[number]

export type StudioTheme = {
  /** The stamp of studio/<uid>/subject-<stamp>.png. */
  subjectTs: string
  /** Cassette placement as fractions of the cover; null = the server's default. */
  placement: { x: number | null; y: number | null; scale: number | null }
  lettering: ThemeLetteringMode
  align: ThemeAlign
  /** '#rrggbb' or 'auto'. */
  color: string
  position: LetteringPosition
  size: LetteringSize
  /** The look every cover is finished with, or null. */
  filter: FilterSettings | null
  /** Clips rendered and pinned after each cover, in this order. */
  formats: ThemeFormat[]
  /** Whether those clips carry the handwritten title. */
  clipTitle: boolean
  /** When it was saved (ms). */
  ts: string
}

const MODE_CODE: Record<ThemeLetteringMode, string> = { title: 't', 'artist-title': 'b', existing: 'e', none: 'n' }
const ALIGN_CODE: Record<ThemeAlign, string> = { left: 'l', center: 'c', right: 'r' }
const FORMAT_CODE: Record<ThemeFormat, string> = { canvas: 'c', square: 's', youtube: 'y', story: 't' }

const pct = (v: number | null) => (v === null ? 'a' : String(Math.max(0, Math.min(100, Math.round(v * 100)))))

/** The storage key for a theme. Throws on a theme that cannot be encoded (a bad colour or subject stamp). */
export function themeKey(userId: string, theme: Omit<StudioTheme, 'ts'>, ts: string | number): string {
  if (!/^\d{10,16}$/.test(theme.subjectTs)) throw new Error('bad subject stamp')
  const color = /^#[0-9a-f]{6}$/i.test(theme.color) ? theme.color.slice(1).toLowerCase() : 'auto'
  const formats = theme.formats.filter((f, i, a) => a.indexOf(f) === i).map(f => FORMAT_CODE[f]).join('') || '0'
  const look = theme.filter ? encodeFilter(theme.filter) : '0'
  return `studio/${userId}/theme-${ts}-s${theme.subjectTs}-p${pct(theme.placement.x)}-${pct(theme.placement.y)}-${pct(theme.placement.scale)}` +
    `-l${MODE_CODE[theme.lettering]}${ALIGN_CODE[theme.align]}-c${color}-${theme.position}-${theme.size}-f${look}-m${formats}-t${theme.clipTitle ? 1 : 0}.png`
}

const THEME_LEAF = new RegExp(
  '^theme-(\\d{10,16})-s(\\d{10,16})-p(a|\\d{1,3})-(a|\\d{1,3})-(a|\\d{1,3})-l([tben])([lcr])-c([0-9a-f]{6}|auto)' +
  `-(${LETTERING_POSITIONS.join('|')})-(${LETTERING_SIZES.join('|')})-f(0|[0-9a-z]{1,40})-m(0|[csyt]{1,4})-t([01])\\.png$`,
)

/** Parse one of THIS user's theme keys, or null for any other key (including a look code that does not decode). */
export function parseThemeKey(key: unknown, userId: string): StudioTheme | null {
  if (typeof key !== 'string') return null
  const prefix = `studio/${userId}/`
  if (!key.startsWith(prefix)) return null
  const m = THEME_LEAF.exec(key.slice(prefix.length))
  if (!m) return null
  // A percent over 100 is not a placement — the whole key is refused.
  for (const v of [m[3], m[4], m[5]]) if (v !== 'a' && Number(v) > 100) return null
  const frac = (v: string): number | null => (v === 'a' ? null : Number(v) / 100)
  let filter: FilterSettings | null = null
  if (m[11] !== '0') {
    filter = decodeFilter(m[11])
    if (!filter) return null
  }
  const formats: ThemeFormat[] = []
  if (m[12] !== '0') {
    for (const ch of m[12]) {
      const f = (Object.keys(FORMAT_CODE) as ThemeFormat[]).find(k => FORMAT_CODE[k] === ch)
      if (f && !formats.includes(f)) formats.push(f)
    }
  }
  const lettering = (Object.keys(MODE_CODE) as ThemeLetteringMode[]).find(k => MODE_CODE[k] === m[6])!
  const align = (Object.keys(ALIGN_CODE) as ThemeAlign[]).find(k => ALIGN_CODE[k] === m[7])!
  return {
    ts: m[1],
    subjectTs: m[2],
    placement: { x: frac(m[3]), y: frac(m[4]), scale: frac(m[5]) },
    lettering,
    align,
    color: m[8] === 'auto' ? 'auto' : `#${m[8]}`,
    position: m[9] as LetteringPosition,
    size: m[10] as LetteringSize,
    filter,
    formats,
    clipTitle: m[13] === '1',
  }
}

/** The theme as the routes send it to a client (and accept it back). */
export type ThemeJson = {
  subject: string
  place_x: number | null
  place_y: number | null
  place_scale: number | null
  lettering: ThemeLetteringMode
  align: ThemeAlign
  color: string
  position: LetteringPosition
  size: LetteringSize
  filter: FilterSettings | null
  formats: ThemeFormat[]
  clip_title: boolean
  saved_at: string
}

export function themeToJson(userId: string, t: StudioTheme): ThemeJson {
  return {
    subject: `studio/${userId}/subject-${t.subjectTs}.png`,
    place_x: t.placement.x, place_y: t.placement.y, place_scale: t.placement.scale,
    lettering: t.lettering, align: t.align, color: t.color, position: t.position, size: t.size,
    filter: t.filter, formats: t.formats, clip_title: t.clipTitle,
    saved_at: new Date(Number(t.ts)).toISOString(),
  }
}

/** The text a theme letters a song with, or null when it letters nothing typed. */
export function themeLetteringText(mode: ThemeLetteringMode, title: string, artist: string): string | null {
  const t = title.trim().replace(/\s+/g, ' ')
  if (mode === 'title') return t || null
  if (mode === 'artist-title') {
    const a = artist.trim().replace(/\s+/g, ' ')
    return a && t ? `${a}\n${t}` : t || a || null
  }
  return null
}
