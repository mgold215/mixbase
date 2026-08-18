// Recipe construction, macro resolution, and validation — the pure logic tier
// of the FX engine. No DOM, no side effects; scripts/fx-test.mjs runs this
// file in Node, so keep it that way (relative .ts imports only).

import {
  EFFECTS,
  EFFECT_IDS,
  resolveParams,
  type EffectId,
  type ParamValue,
} from '../free-effects.ts'
import {
  MAX_FX_ENTRIES,
  RECIPE_MAX_JSON_BYTES,
  type Mod,
  type ModSource,
  type VizFormat,
  type VizRecipe,
} from './types.ts'

const FORMATS: VizFormat[] = ['canvas', 'youtube', 'square', 'story']
const MOD_SOURCES: ModSource[] = ['bass', 'mid', 'treble', 'rms', 'beat', 'flux']

export const DEFAULT_BPM = 122

// ── Macros ──────────────────────────────────────────────────────────────────
// A macro is one big slider that scales a family of per-effect params by id.
// Position 0.5 is neutral (multiplier exactly 1 → the shipped look); 0 halves,
// 1 doubles (multiplier = 4^(m-0.5)), always re-clamped to each param's spec
// range. Param ids are shared across effects on purpose — 'punch' means the
// same thing on pulse and strobe — so one target list covers the registry.

export type MacroDef = { id: string; label: string; targets: string[] }

export const MACROS: MacroDef[] = [
  {
    id: 'energy',
    label: 'Energy',
    targets: [
      'punch', 'flash', 'warp', 'strength', 'bloom', 'glow', 'ring',
      'light', 'rim', 'sheen', 'caustics', 'grade', 'split', 'dim', 'blur', 'fog',
    ],
  },
  {
    id: 'motion',
    label: 'Motion',
    targets: ['zoom', 'motion', 'sway', 'drift', 'ripple', 'twist', 'waves'],
  },
  {
    id: 'texture',
    label: 'Texture',
    targets: ['grain', 'vignette', 'fringe', 'cast', 'jitter', 'tracking', 'density', 'size'],
  },
]

export function macroMultiplier(position: number): number {
  const m = Math.min(1, Math.max(0, position))
  return Math.pow(4, m - 0.5)
}

// Resolve the params actually handed to EffectDef.create(): base params
// (defaults filled, clamped) with each macro's multiplier applied to its
// targets, re-clamped to spec. All-neutral macros return the base values
// untouched — multiplier 1 is exact, so the default look survives bit for bit.
export function applyMacros(
  effectId: EffectId,
  baseParams: Record<string, ParamValue> | undefined,
  macros: Record<string, number> | undefined,
): Record<string, ParamValue> {
  const specs = EFFECTS[effectId].params
  const out = resolveParams(specs, baseParams)
  if (!macros) return out
  for (const macro of MACROS) {
    const pos = macros[macro.id]
    if (typeof pos !== 'number' || !Number.isFinite(pos) || pos === 0.5) continue
    const mult = macroMultiplier(pos)
    for (const spec of specs) {
      if (spec.type !== 'slider' || !macro.targets.includes(spec.id)) continue
      out[spec.id] = (out[spec.id] as number) * mult
    }
  }
  // Second resolve re-clamps every multiplied value to its spec range.
  return resolveParams(specs, out)
}

// ── Construction ────────────────────────────────────────────────────────────

export function neutralMacros(): Record<string, number> {
  const m: Record<string, number> = {}
  for (const macro of MACROS) m[macro.id] = 0.5
  return m
}

export function defaultRecipe(effectId: EffectId, format: VizFormat, seed: number): VizRecipe {
  return {
    v: 1,
    format,
    fps: 30,
    resolution: 'standard',
    seed: seed >>> 0,
    scene: { id: effectId, params: resolveParams(EFFECTS[effectId].params) },
    fx: [],
    macros: neutralMacros(),
    palette: { colors: [], locked: false },
    audio: null,
    bpm: DEFAULT_BPM,
  }
}

// ── Validation ──────────────────────────────────────────────────────────────
// The only door for untrusted recipe data (localStorage drafts now, DB
// settings later). Clamps what it can, drops what it doesn't know, and
// returns null only when the recipe is unusable (wrong version, unknown scene,
// absurd size) — a stale draft degrades, it never crashes the editor.

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

// Same RFC 4122 shape as isUuid() in src/lib/validators.ts, inlined rather than
// imported: that module is server-side (it calls Buffer in
// projectIdFromUploadId and derives module-level state from process.env for the
// SSRF allow-list), while recipe.ts is bundled into the browser AND loaded by
// scripts/fx-test.mjs under Node type-stripping. Pulling it in would ship
// upload/SSRF helpers to the client for one regex. Keep the two in sync.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function validateRecipe(raw: unknown): VizRecipe | null {
  if (!isRecord(raw)) return null
  if (raw.v !== 1) return null

  const scene = isRecord(raw.scene) ? raw.scene : null
  const sceneId = scene?.id
  if (typeof sceneId !== 'string' || !(EFFECT_IDS as string[]).includes(sceneId)) return null
  const effectId = sceneId as EffectId

  const format: VizFormat = FORMATS.includes(raw.format as VizFormat)
    ? (raw.format as VizFormat)
    : 'canvas'

  const macros: Record<string, number> = {}
  const rawMacros = isRecord(raw.macros) ? raw.macros : {}
  for (const macro of MACROS) {
    macros[macro.id] = Math.min(1, Math.max(0, finiteOr(rawMacros[macro.id], 0.5)))
  }

  const rawPalette = isRecord(raw.palette) ? raw.palette : {}
  const colors = Array.isArray(rawPalette.colors)
    ? rawPalette.colors.filter((c): c is string => typeof c === 'string' && HEX_COLOR.test(c)).slice(0, 8)
    : []

  // versionId must be a real mb_versions UUID, not just a short string: this
  // segment is persisted to mb_visualizers.settings and phase 2 resolves the id
  // against the versions table. Anything else — a path, an injection attempt, a
  // stale non-UUID draft — drops the whole audio segment to null, which is the
  // already-supported "synthetic BPM" mode rather than an error.
  const rawAudio = isRecord(raw.audio) ? raw.audio : null
  const audio =
    rawAudio && typeof rawAudio.versionId === 'string' && UUID_RE.test(rawAudio.versionId)
      ? {
          versionId: rawAudio.versionId,
          startSec: Math.max(0, finiteOr(rawAudio.startSec, 0)),
          bpm: Math.min(200, Math.max(60, finiteOr(rawAudio.bpm, DEFAULT_BPM))),
          offsetSec: Math.max(0, finiteOr(rawAudio.offsetSec, 0)),
        }
      : null

  // Phase 1 has no GL fx registry yet — entries are dropped (the type keeps
  // the field so later phases validate instead of discard).
  void MAX_FX_ENTRIES

  const recipe: VizRecipe = {
    v: 1,
    format,
    fps: 30,
    resolution: raw.resolution === 'high' && format === 'youtube' ? 'high' : 'standard',
    seed: finiteOr(raw.seed, 1) >>> 0,
    scene: {
      id: effectId,
      // resolveParams drops unknown ids, fills defaults, clamps ranges.
      params: resolveParams(
        EFFECTS[effectId].params,
        isRecord(scene?.params) ? (scene.params as Record<string, ParamValue>) : undefined,
      ),
    },
    fx: [],
    macros,
    palette: { colors, locked: rawPalette.locked === true },
    audio,
    bpm: Math.min(200, Math.max(60, Math.round(finiteOr(raw.bpm, DEFAULT_BPM)))),
  }

  if (JSON.stringify(recipe).length > RECIPE_MAX_JSON_BYTES) return null
  return recipe
}

// Sanity-check a Mod shape (used by later phases; exported now so validation
// logic lives in one place from the start).
export function isValidMod(v: unknown): v is Mod {
  return (
    isRecord(v) &&
    MOD_SOURCES.includes(v.source as ModSource) &&
    typeof v.target === 'string' &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    v.amount >= -1 &&
    v.amount <= 1
  )
}
