// Single source of truth for visualizer/video "kind" display + filtering.
//
// A saved `mb_visualizers` row is one of: 'free' (canvas loop), 'ai' (Runway),
// or 'youtube' / 'shorts' (finished renders). PR #42 made BOTH the Media tab
// and the project "Choose from Media" picker list every kind — before, they
// only listed free+ai — so both surfaces need identical labels. Keeping them
// here (instead of a copy per component) means the labels can't drift, and the
// pure filter helpers below let the Media kind-filter chips be unit-tested with
// no React/DOM.

// Canonical display order for the kinds we know about.
export const VISUALIZER_KINDS = ['ai', 'free', 'youtube', 'shorts'] as const

export const VISUALIZER_KIND_LABEL: Record<string, string> = {
  ai: 'AI',
  free: 'Free',
  youtube: 'YouTube',
  shorts: 'Shorts',
}

// Label for any kind, with a safe fallback for an unknown/future kind so the
// UI never renders a blank pill.
export function visualizerKindLabel(kind: string): string {
  return VISUALIZER_KIND_LABEL[kind] ?? 'Video'
}

// The distinct kinds actually present in a library, in the canonical order
// above (any unrecognized kind is appended in first-seen order so a new render
// type still shows up). Powers the filter chips: we only ever show a "Shorts"
// chip when the user actually has a Shorts video.
export function availableKinds<T extends { kind: string }>(items: T[]): string[] {
  const present = new Set(items.map(i => i.kind))
  const ordered: string[] = VISUALIZER_KINDS.filter(k => present.has(k))
  for (const i of items) {
    if (!ordered.includes(i.kind)) ordered.push(i.kind)
  }
  return ordered
}

// Filter a library by kind. The sentinel 'all' returns everything, so a caller
// can pass its raw filter state straight in.
export function filterByKind<T extends { kind: string }>(items: T[], kind: string): T[] {
  if (kind === 'all') return items
  return items.filter(i => i.kind === kind)
}
