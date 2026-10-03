// Cassette Studio — motion, the asset half. Turns a Cassette Studio cover
// into a short, seamlessly looping video WITHOUT any AI: the same real
// cassette layer and scene plate the still was made from, moved the way a
// camera and a playing tape actually move.
//
// Split in two so the render workers never load sharp:
//   cassette-motion.ts        (this file) finds the reel hubs and cuts the
//                             spinning sprite out of the cassette layer — once
//                             per render, on the main thread, with sharp.
//   cassette-motion-scene.ts  the per-frame drawing (camera, parallax, reels,
//                             grain, title card) — sharp-free, loaded by every
//                             worker in src/lib/cassette-render-worker.ts.
// The scene module is re-exported here so callers have one import.
//
// Relative, extension-full imports only, no server-only imports —
// scripts/cassette-motion-test.mjs drives it directly under Node.

import sharp from 'sharp'
import type { Hub } from './cassette-motion-scene.ts'

export * from './cassette-motion-scene.ts'

/**
 * Find the two reel hubs in a cassette layer (RGBA, w×h). A cut-out cassette's
 * hub holes are see-through (alpha≈0) blobs fully enclosed by the shell; the
 * two biggest roundish ones in the middle band are the hubs. When the holes
 * aren't see-through in this photo it reports detected=false along with where
 * compact-cassette geometry (IEC 60094 hub pitch 42.5 mm on a 100.4 mm shell)
 * puts them — informational only: prepareMotionAssets spins nothing then.
 */
export function findHubs(rgba: Buffer, w: number, h: number): { hubs: Hub[]; detected: boolean } {
  const n = w * h
  const clear = new Uint8Array(n)
  for (let i = 0; i < n; i++) clear[i] = rgba[i * 4 + 3] < 24 ? 1 : 0
  const label = new Int32Array(n)
  const stack = new Int32Array(n)
  const blobs: { area: number; sx: number; sy: number; x0: number; y0: number; x1: number; y1: number; edge: boolean }[] = []
  for (let s = 0; s < n; s++) {
    if (!clear[s] || label[s]) continue
    const id = blobs.length + 1
    let sp = 0
    stack[sp++] = s
    label[s] = id
    const b = { area: 0, sx: 0, sy: 0, x0: w, y0: h, x1: -1, y1: -1, edge: false }
    while (sp) {
      const i = stack[--sp]
      const x = i % w, y = (i - x) / w
      b.area++; b.sx += x; b.sy += y
      if (x < b.x0) b.x0 = x
      if (x > b.x1) b.x1 = x
      if (y < b.y0) b.y0 = y
      if (y > b.y1) b.y1 = y
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) b.edge = true
      if (x > 0 && clear[i - 1] && !label[i - 1]) { label[i - 1] = id; stack[sp++] = i - 1 }
      if (x < w - 1 && clear[i + 1] && !label[i + 1]) { label[i + 1] = id; stack[sp++] = i + 1 }
      if (y > 0 && clear[i - w] && !label[i - w]) { label[i - w] = id; stack[sp++] = i - w }
      if (y < h - 1 && clear[i + w] && !label[i + w]) { label[i + w] = id; stack[sp++] = i + w }
    }
    blobs.push(b)
  }
  const minArea = (w * 0.012) ** 2
  const maxArea = (w * 0.12) ** 2
  const cands = blobs
    .filter(b => !b.edge && b.area >= minArea && b.area <= maxArea)
    .filter(b => {
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1
      const aspect = bw / bh
      const fill = b.area / (bw * bh)   // a disc fills π/4 ≈ 0.785 of its box
      const cy = b.sy / b.area
      return aspect > 0.7 && aspect < 1.4 && fill > 0.45 && cy > h * 0.2 && cy < h * 0.75
    })
    .sort((a, b) => b.area - a.area)
    .map(b => ({ cx: b.sx / b.area, cy: b.sy / b.area, r: Math.max(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1) / 2 }))
  // Two matching holes (same size, same height, far apart) → use both.
  // Otherwise trust the clearest one and MIRROR it: a cassette's hubs sit
  // symmetrically about the shell's centre line (the layer is trimmed to the
  // shell, so that line is w/2). Cut-out models often leave one hub
  // semi-opaque — in the reference photo only the right one comes out clear.
  if (cands.length >= 2) {
    const [p, q] = cands
    const ratio = p.r / q.r
    if (ratio > 0.75 && ratio < 1.33 && Math.abs(p.cy - q.cy) < 0.3 * p.r && Math.abs(p.cx - q.cx) > w * 0.25) {
      return { hubs: [p, q].sort((a, b) => a.cx - b.cx), detected: true }
    }
  }
  if (cands.length >= 1) {
    const p = cands[0]
    const m = { cx: w - p.cx, cy: p.cy, r: p.r }
    if (Math.abs(m.cx - p.cx) > w * 0.25) return { hubs: [p, m].sort((a, b) => a.cx - b.cx), detected: true }
  }
  const r = w * 0.04
  return { hubs: [{ cx: w * 0.288, cy: h * 0.44, r }, { cx: w * 0.712, cy: h * 0.44, r }], detected: false }
}

// ── Asset prep (once per render, before any frame) ──────────────────────────

/** Opaque up to this × hole radius, feathered out to SPRITE_R — inside the
 *  label window on a compact cassette (the window edge is ≈1.4× out). */
const SPRITE_RIN = 1.12
const SPRITE_R = 1.36

export type MotionAssets = {
  /** PNG: the cassette layer with both hub discs cut out (the layer untouched when detected=false). */
  staticPng: Buffer
  /** PNG: one hub disc (2R×2R), centre at (R,R), alpha-feathered at its rim (1×1 transparent when detected=false). */
  hubSpritePng: Buffer
  /** Hub centres in LAYER pixels, left then right. EMPTY when detected=false: nothing spins. */
  hubs: Hub[]
  /** Sprite radius in layer pixels (0 when detected=false). */
  spriteR: number
  /** True when see-through hub holes were found in the photo (findHubs). */
  detected: boolean
}

/**
 * Cut the hubs out of the cassette layer and build the spinning sprite. ONE
 * sprite drawn at both centres: the two hubs are the same moulded part, and
 * the clearest hole in the photo (the one the cut-out model got right) is the
 * one that should spin in both places.
 */
export async function prepareMotionAssets(layer: Buffer, w: number, h: number): Promise<MotionAssets> {
  const { hubs, detected } = findHubs(layer, w, h)
  // No hub holes in this photo → nothing to spin. Guessing the hubs from
  // shell geometry and cutting there would tear a hole in whatever the photo
  // actually has at that spot (a label, a window, a sticker) and spin it, so
  // the cassette is left exactly as photographed and only the camera moves.
  if (!detected) {
    return {
      staticPng: await sharp(layer, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
      hubSpritePng: await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
      hubs: [],
      spriteR: 0,
      detected: false,
    }
  }
  // Clearest hub = the one with the most see-through pixels inside its hole.
  const clearCount = (hb: Hub) => {
    let n = 0
    const r = Math.floor(hb.r)
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue
      const px = Math.round(hb.cx + x), py = Math.round(hb.cy + y)
      if (px < 0 || py < 0 || px >= w || py >= h) continue
      if (layer[(py * w + px) * 4 + 3] < 24) n++
    }
    return n
  }
  const src = clearCount(hubs[0]) >= clearCount(hubs[1]) ? hubs[0] : hubs[1]
  const r = Math.max(hubs[0].r, hubs[1].r)
  const R = Math.ceil(r * SPRITE_R), Rin = r * SPRITE_RIN
  const S = 2 * R
  const sprite = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - R, dy = y + 0.5 - R
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d >= R) continue
      const sx = Math.round(src.cx + dx), sy = Math.round(src.cy + dy)
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
      const si = (sy * w + sx) * 4, o = (y * S + x) * 4
      const feather = d <= Rin ? 1 : 1 - smooth((d - Rin) / (R - Rin))
      sprite[o] = layer[si]; sprite[o + 1] = layer[si + 1]; sprite[o + 2] = layer[si + 2]
      sprite[o + 3] = Math.round(layer[si + 3] * feather)
    }
  }
  const stat = Buffer.from(layer)
  for (const hb of hubs) {
    const x0 = Math.max(0, Math.floor(hb.cx - Rin)), x1 = Math.min(w - 1, Math.ceil(hb.cx + Rin))
    const y0 = Math.max(0, Math.floor(hb.cy - Rin)), y1 = Math.min(h - 1, Math.ceil(hb.cy + Rin))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - hb.cx, dy = y + 0.5 - hb.cy
      if (dx * dx + dy * dy < Rin * Rin) stat[(y * w + x) * 4 + 3] = 0
    }
  }
  return {
    staticPng: await sharp(stat, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
    hubSpritePng: await sharp(sprite, { raw: { width: S, height: S, channels: 4 } }).png().toBuffer(),
    hubs,
    spriteR: R,
    detected: true,
  }
}

function smooth(t: number) { const c = t < 0 ? 0 : t > 1 ? 1 : t; return c * c * (3 - 2 * c) }
