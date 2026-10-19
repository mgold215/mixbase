// Finalize Artwork's option set — the ONE list every client renders from.
// The web Artwork tab imports it directly; the native app (iOS + macOS) reads
// it from GET /api/finalize-artwork. A position, size, filter or colour added
// here therefore reaches both clients at once — the app needs no update — and
// the renderer (finalize-render.ts) validates against these same arrays, so a
// control can never offer something the server would silently replace.
//
// Deliberately free of sharp (and anything server-only) so the browser bundle
// can import it. The `.ts` extension keeps it loadable by Node's type
// stripping, which the unit suites use to import the real renderer.
import { TEXT_COLORS } from './text-colors.ts'

// `${vertical}-${horizontal}` — a 3×3 anchor grid, in reading order (top row
// first), which is how both clients lay it out.
export const POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const
export type Position = (typeof POSITIONS)[number]

export const SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const
export type Size = (typeof SIZE_OPTIONS)[number]['value']
export const SIZES: readonly Size[] = SIZE_OPTIONS.map(s => s.value)

// Whole-image colour grades (the matrices live in finalize-render.ts).
export const FILTER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'warm', label: 'Warm' },
  { value: 'golden', label: 'Golden' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'cool', label: 'Cool' },
  { value: 'icy', label: 'Icy' },
  { value: 'vivid', label: 'Vivid' },
  { value: 'mono', label: 'B&W' },
] as const
export type Filter = (typeof FILTER_OPTIONS)[number]['value']
export const FILTERS: readonly Filter[] = FILTER_OPTIONS.map(f => f.value)

// Text colour is any #RRGGBB hex; white unless the user picks otherwise.
export const DEFAULT_TEXT_COLOR = '#FFFFFF'

export const FINALIZE_DEFAULTS: {
  position: Position
  size: Size
  filter: Filter
  color: string
  showRule: boolean
} = {
  position: 'top-left',
  size: 'medium',
  filter: 'none',
  color: DEFAULT_TEXT_COLOR,
  // Divider line between artist name and title — on unless switched off.
  showRule: true,
}

/** The GET /api/finalize-artwork body — what the native app builds its controls from. */
export function finalizeOptionsPayload() {
  return {
    positions: [...POSITIONS],
    sizes: SIZE_OPTIONS.map(s => ({ ...s })),
    filters: FILTER_OPTIONS.map(f => ({ ...f })),
    colors: TEXT_COLORS.map(c => ({ ...c })),
    defaults: FINALIZE_DEFAULTS,
  }
}
