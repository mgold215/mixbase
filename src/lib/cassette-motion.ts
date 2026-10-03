// Cassette Studio — motion. Turns a Cassette Studio cover into a short,
// seamlessly looping video WITHOUT any AI: the same real cassette layer and
// scene plate the still was made from, moved the way a camera and a playing
// tape actually move.
//
//   reels    — the two hubs turn, as on a playing deck. Each completes a whole
//              number of revolutions per loop, so the loop has no seam.
//   camera   — a slow handheld-style drift and breathing zoom (periodic).
//   depth    — the far scene moves less than the cassette and the surface it
//              stands on (two-plane parallax, blended across the horizon).
//   film     — fresh grain every frame (a real camera's noise is temporal; a
//              frozen grain pattern over moving pixels reads as a filter) and
//              a whisper of exposure breathing.
//   lettering— static on top, like a title card.
//
// Pure maths + @napi-rs/canvas + sharp, no server-only imports — the render
// worker and scripts/cassette-motion-test.mjs both drive it directly.

import sharp from 'sharp'
import { frameRng, loopSin } from './free-effects.ts'

export type Box = { left: number; top: number; width: number; height: number }
export type Hub = { cx: number; cy: number; r: number }

/**
 * Find the two reel hubs in a cassette layer (RGBA, w×h). A cut-out cassette's
 * hub holes are see-through (alpha≈0) blobs fully enclosed by the shell; the
 * two biggest roundish ones in the middle band are the hubs. Falls back to
 * compact-cassette geometry (IEC 60094 hub pitch 42.5 mm on a 100.4 mm shell)
 * when the holes aren't see-through in this photo.
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
  /** PNG: the cassette layer with both hub discs cut out. */
  staticPng: Buffer
  /** PNG: one hub disc (2R×2R), centre at (R,R), alpha-feathered at its rim. */
  hubSpritePng: Buffer
  /** Hub centres in LAYER pixels, left then right. */
  hubs: Hub[]
  /** Sprite radius in layer pixels. */
  spriteR: number
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
    detected,
  }
}

// ── Framing ─────────────────────────────────────────────────────────────────

export type Rect = { x: number; y: number; w: number; h: number }

/**
 * The window of the square cover a W×H video shows: full height for portrait
 * (centred on the cassette), full width for landscape (centred on the
 * cassette's middle), clamped inside the cover.
 */
export function motionCrop(cover: number, box: Box, W: number, H: number): Rect {
  const a = W / H
  const cx = box.left + box.width / 2
  const cy = box.top + box.height / 2
  if (a <= 1) {
    const w = cover * a
    return { x: clampN(cx - w / 2, 0, cover - w), y: 0, w, h: cover }
  }
  const h = cover / a
  return { x: 0, y: clampN(cy - h / 2, 0, cover - h), w: cover, h }
}

/**
 * Where the handwriting goes in a W×H frame: same rules as the still
 * (applyLettering in cassette-studio.ts) but against the video frame, so a 9:16
 * Canvas doesn't crop the title the square cover had bottom-left.
 */
export function letteringRect(W: number, H: number, lw: number, lh: number, position: string, size: string): Rect {
  const frac = size === 'small' ? 0.32 : size === 'large' ? 0.54 : 0.42
  const base = Math.min(W, H)
  let w = base * frac * (W < H ? 1.25 : 1)
  let h = w * (lh / lw)
  if (h > H * 0.3) { h = H * 0.3; w = h * (lw / lh) }
  const m = base * 0.06
  const x = position.endsWith('left') ? m : position.endsWith('right') ? W - m - w : (W - w) / 2
  const y = position.startsWith('top') ? m : H - m - h - (W < H ? H * 0.06 : 0)
  return { x, y, w, h }
}

// ── Frames ──────────────────────────────────────────────────────────────────

type Img = CanvasImageSource & { width: number; height: number }
type Ctx = CanvasRenderingContext2D
export type MotionLayerFactory = (w: number, h: number) => { canvas: CanvasImageSource; ctx: Ctx }

export type MotionSetup = {
  W: number
  H: number
  duration: number
  fps: number
  seed: number
  /** Square cover size the plate/box/hubs are expressed in (3000). */
  cover: number
  plate: Img
  staticLayer: Img
  hubSprite: Img
  box: Box
  /** Hub centres in layer pixels (layer is box.width×box.height at cover scale… or any scale: see layerScale). */
  hubs: Hub[]
  spriteR: number
  /** Layer pixels → cover pixels (layer image width / box.width inverse). */
  layerScale: number
  lettering: { image: Img; rect: Rect } | null
  createLayer: MotionLayerFactory
}

/** Whole revolutions per 6 s: supply and take-up reels turn at different rates. */
const REVS_PER_6S: [number, number] = [2, 3]

export function createCassetteMotion(s: MotionSetup) {
  const { W, H, cover, box } = s
  const crop = motionCrop(cover, box, W, H)
  const k = W / crop.w                         // cover px → frame px
  const C = { x: W / 2, y: H / 2 }
  const total = Math.round(s.duration * s.fps)
  const loops = Math.max(1, Math.round(s.duration / 6))
  const revs = REVS_PER_6S.map(r => r * loops)

  // Plate pre-scaled ONCE to frame resolution (+ the crop window), so each
  // frame's two plate draws are 1:1-ish blits, not 3000px downsamples.
  const plateW = Math.round(cover * k)
  const pre = s.createLayer(plateW, plateW)
  pre.ctx.imageSmoothingQuality = 'high'
  pre.ctx.drawImage(s.plate, 0, 0, plateW, plateW)

  // Near-plane mask: the cassette and the surface it stands on move with the
  // camera; the far scene moves ~half as much. Blend across a band above the
  // cassette's base line.
  const near = s.createLayer(W, H)
  const base = box.top + box.height
  // Static grain tiles; each frame picks one and an offset from frameRng.
  const TILE = 256
  const tiles = Array.from({ length: 4 }, (_, n) => {
    const t = s.createLayer(TILE, TILE)
    const img = t.ctx.createImageData(TILE, TILE)
    const r = frameRng(s.seed ^ 0x51ed, n)
    for (let i = 0; i < TILE * TILE; i++) {
      const v = 128 + (r() + r() + r() - 1.5) * 70
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
      img.data[i * 4 + 3] = 255
    }
    t.ctx.putImageData(img, 0, 0)
    return t.canvas
  })

  // Camera for loop position t ∈ [0,1): a slow breathing zoom and a handheld
  // drift (fundamental + a faint 3rd harmonic), all integer cycles → seamless.
  const camera = (t: number, depth: number) => {
    const z = 1.06 + (0.018 * loopSin(t, 1)) * depth
    const dx = (0.011 * W * loopSin(t, 1, 0.4) + 0.0025 * W * loopSin(t, 3, 1.3)) * depth
    const dy = (0.007 * H * loopSin(t, 1, 2.1) + 0.0018 * H * loopSin(t, 2, 0.7)) * depth
    // cover px → frame px, then zoom about the frame centre, then drift.
    const a = k * z
    return { a, e: C.x * (1 - z) - crop.x * a + dx, f: C.y * (1 - z) - crop.y * a + dy }
  }

  return function draw(ctx: Ctx, frame: number) {
    const t = (frame % total) / total
    const fr = frameRng(s.seed, frame)
    const cn = camera(t, 1)
    const cf = camera(t, 0.5)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'

    // Far plane.
    ctx.setTransform(cf.a / k, 0, 0, cf.a / k, cf.e, cf.f)
    ctx.drawImage(pre.canvas, 0, 0)

    // Near plane, masked to the band at and below the cassette's base.
    const n = near.ctx
    n.setTransform(1, 0, 0, 1, 0, 0)
    n.globalCompositeOperation = 'source-over'
    n.clearRect(0, 0, W, H)
    n.setTransform(cn.a / k, 0, 0, cn.a / k, cn.e, cn.f)
    n.drawImage(pre.canvas, 0, 0)
    n.setTransform(1, 0, 0, 1, 0, 0)
    const yBase = base * cn.a + cn.f
    const band = 0.22 * cover * cn.a
    const g = n.createLinearGradient(0, yBase - band, 0, yBase - band * 0.15)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,1)')
    n.globalCompositeOperation = 'destination-in'
    n.fillStyle = g
    n.fillRect(0, 0, W, H)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(near.canvas, 0, 0)

    // The cassette, on the near plane; its hubs turning.
    const L = 1 / s.layerScale              // layer px → cover px
    ctx.setTransform(cn.a, 0, 0, cn.a, cn.e, cn.f)
    ctx.drawImage(s.staticLayer, box.left, box.top, box.width, box.height)
    s.hubs.forEach((hb, i) => {
      // Clockwise (seen from the front) on both reels, as on a deck playing side A.
      const angle = Math.PI * 2 * revs[i] * t
      ctx.save()
      ctx.translate(box.left + hb.cx * L, box.top + hb.cy * L)
      ctx.rotate(angle)
      const R = s.spriteR * L
      ctx.drawImage(s.hubSprite, -R, -R, 2 * R, 2 * R)
      ctx.restore()
    })

    // Film: fresh grain every frame, faint exposure breathing, vignette.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'overlay'
    ctx.globalAlpha = 0.16
    const tile = tiles[Math.floor(fr() * tiles.length)]
    const ox = -Math.floor(fr() * TILE), oy = -Math.floor(fr() * TILE)
    for (let y = oy; y < H; y += TILE) for (let x = ox; x < W; x += TILE) ctx.drawImage(tile, x, y)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 0.025 * (1 + loopSin(t, 2, 0.9)) / 2
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.globalAlpha = 1
    const vg = ctx.createRadialGradient(C.x, C.y, Math.min(W, H) * 0.35, C.x, C.y, Math.hypot(C.x, C.y))
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,0.32)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, W, H)

    // Title card.
    if (s.lettering) {
      const r = s.lettering.rect
      ctx.drawImage(s.lettering.image, r.x, r.y, r.w, r.h)
    }
  }
}

function smooth(t: number) { const c = t < 0 ? 0 : t > 1 ? 1 : t; return c * c * (3 - 2 * c) }
function clampN(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }
