// Recipe state for the free FX studio: one reducer over the VizRecipe object,
// with a per-project localStorage draft so tweaks survive tab switches and
// reloads. Drafts re-enter through validateRecipe(), so a stale or hand-edited
// draft degrades to defaults instead of crashing the editor.

import { useEffect, useReducer } from 'react'
import type { EffectId, ParamValue } from '@/lib/free-effects'
import { DEFAULT_BPM, defaultRecipe, validateRecipe } from '@/lib/fx/recipe'
import type { VizFormat, VizRecipe } from '@/lib/fx/types'
import { EFFECTS, resolveParams } from '@/lib/free-effects'

export type VizRecipeAction =
  | { type: 'format'; format: VizFormat }
  | { type: 'scene'; id: EffectId }
  | { type: 'param'; id: string; value: ParamValue }
  | { type: 'resetParams' }
  | { type: 'macro'; id: string; value: number }
  | { type: 'bpm'; bpm: number }
  | { type: 'seed'; seed: number }
  | { type: 'resolution'; resolution: 'standard' | 'high' }

function reducer(recipe: VizRecipe, action: VizRecipeAction): VizRecipe {
  switch (action.type) {
    case 'format':
      return { ...recipe, format: action.format, resolution: 'standard' }
    case 'scene':
      // Params reset to the new effect's defaults (ids only partially overlap
      // across effects); macros/seed/bpm are cross-effect and persist.
      return { ...recipe, scene: { id: action.id, params: resolveParams(EFFECTS[action.id].params) } }
    case 'param':
      return { ...recipe, scene: { ...recipe.scene, params: { ...recipe.scene.params, [action.id]: action.value } } }
    case 'resetParams':
      return { ...recipe, scene: { ...recipe.scene, params: resolveParams(EFFECTS[recipe.scene.id].params) } }
    case 'macro':
      return { ...recipe, macros: { ...recipe.macros, [action.id]: Math.min(1, Math.max(0, action.value)) } }
    case 'bpm':
      return { ...recipe, bpm: Math.min(200, Math.max(60, Math.round(action.bpm))) }
    case 'seed':
      return { ...recipe, seed: action.seed >>> 0 }
    case 'resolution':
      // 4K is a youtube-only offer (vertical formats are capped by their
      // platforms at 1080×1920) — validateRecipe enforces the same rule.
      return { ...recipe, resolution: recipe.format === 'youtube' ? action.resolution : 'standard' }
  }
}

const draftKey = (projectId: string | undefined) => `mixbase:vizdraft:${projectId ?? 'noproject'}:v1`

function initRecipe(projectId: string | undefined, projectBpm: number | null | undefined): VizRecipe {
  const seed = Math.floor(Math.random() * 2 ** 31)
  const detected =
    projectBpm && Number.isFinite(projectBpm)
      ? Math.min(200, Math.max(60, Math.round(projectBpm)))
      : null

  const fresh = defaultRecipe('kenburns', 'canvas', seed)
  fresh.bpm = detected ?? DEFAULT_BPM
  if (typeof window === 'undefined') return fresh
  try {
    const raw = window.localStorage.getItem(draftKey(projectId))
    if (!raw) return fresh
    const draft = validateRecipe(JSON.parse(raw))
    if (!draft) return fresh
    // The detected tempo must still reach a returning user. The draft used to
    // be returned as-is, so the moment ANY draft existed for a project — and
    // the write-through effect below creates one on first render — the "prefill
    // from detected BPM" feature could never fire again for that project.
    //
    // A draft always carries a bpm, so "the user set one" can only be read as
    // "it differs from the default". Leaving DEFAULT_BPM in place is the case
    // where nothing was ever chosen, and that is the one we overwrite; a tempo
    // the user actually dialled in always wins over detection.
    return detected !== null && draft.bpm === DEFAULT_BPM ? { ...draft, bpm: detected } : draft
  } catch {
    return fresh
  }
}

export function useVizRecipe(projectId: string | undefined, projectBpm: number | null | undefined) {
  const [recipe, dispatch] = useReducer(
    reducer,
    undefined,
    () => initRecipe(projectId, projectBpm),
  )

  // Write-through draft. Failures (private mode, quota) are non-fatal.
  useEffect(() => {
    try {
      window.localStorage.setItem(draftKey(projectId), JSON.stringify(recipe))
    } catch {
      // localStorage unavailable — drafts just don't persist
    }
  }, [projectId, recipe])

  return { recipe, dispatch }
}
