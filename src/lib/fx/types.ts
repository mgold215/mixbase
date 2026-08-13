// FX engine recipe types — the persisted contract for a visualizer look.
//
// A recipe fully describes one visual: the scene effect + its params, the GL
// post-FX stack (Phase 3), macro positions, palette, seed, and the audio
// segment that drives modulation (Phase 2). It round-trips through
// localStorage drafts and, from the export phase on, an `mb_visualizers
// .settings` jsonb column — so everything here must survive hand-editing,
// stale versions, and unknown future fields. validateRecipe() in recipe.ts is
// the only door back in.
//
// Node-testable: imported by scripts/fx-test.mjs via type stripping, hence the
// relative .ts import (same pattern as video-jobs.ts / schema-heal.ts).

import type { EffectId, ParamValue } from '../free-effects.ts'

export type VizFormat = 'canvas' | 'youtube' | 'square' | 'story'

// Audio feature that can drive a parameter (Phase 2+). 'beat' is the shaped
// kick envelope; the rest are normalized 0..1 band/level tracks.
export type ModSource = 'bass' | 'mid' | 'treble' | 'rms' | 'beat' | 'flux'

// One modulation routing: `target` names a param id on the fx entry it lives
// on; `amount` scales how far the source pushes it (-1..1).
export type Mod = { source: ModSource; target: string; amount: number }

// One entry in the GL post-FX stack (Phase 3). Kept in the type now so saved
// recipes are forward-shaped; Phase 1 always stores an empty stack.
export type FxEntry = { id: string; params: Record<string, ParamValue>; mods: Mod[] }

export type VizRecipe = {
  v: 1 // engine version — bump only on a breaking recipe change
  format: VizFormat
  fps: 30
  // 'high' = 4K, offered on the youtube format only, capability-gated.
  resolution: 'standard' | 'high'
  seed: number
  scene: { id: EffectId; params: Record<string, ParamValue> }
  fx: FxEntry[]
  // Macro slider positions 0..1 (0.5 = neutral). Kept so re-opening a saved
  // recipe restores the sliders, not just their resolved result.
  macros: Record<string, number>
  palette: { colors: string[]; locked: boolean }
  // The mix segment that modulation reacts to; null = synthetic BPM mode.
  audio: { versionId: string; startSec: number; bpm: number; offsetSec: number } | null
  // Synthetic/manual tempo fallback for beat-synced effects.
  bpm: number
}

// Hard ceiling on a serialized recipe. Anything bigger is hostile or corrupt —
// a full recipe with every param explicit is ~2 KB.
export const RECIPE_MAX_JSON_BYTES = 16_384

export const MAX_FX_ENTRIES = 6
