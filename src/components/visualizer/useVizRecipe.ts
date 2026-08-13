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
  }
}

const draftKey = (projectId: string | undefined) => `mixbase:vizdraft:${projectId ?? 'noproject'}:v1`

function initRecipe(projectId: string | undefined, projectBpm: number | null | undefined): VizRecipe {
  const seed = Math.floor(Math.random() * 2 ** 31)
  const fresh = defaultRecipe('kenburns', 'canvas', seed)
  if (projectBpm && Number.isFinite(projectBpm)) {
    fresh.bpm = Math.min(200, Math.max(60, Math.round(projectBpm)))
  } else {
    fresh.bpm = DEFAULT_BPM
  }
  if (typeof window === 'undefined') return fresh
  try {
    const raw = window.localStorage.getItem(draftKey(projectId))
    if (!raw) return fresh
    const parsed = validateRecipe(JSON.parse(raw))
    return parsed ?? fresh
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
