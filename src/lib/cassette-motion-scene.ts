// Cassette Studio — motion, the per-frame half. Turns a Cassette Studio cover
// into a short, seamlessly looping video WITHOUT any AI: the same real cassette
// layer and scene plate the still was made from, moved the way a camera and a
// playing tape actually move.
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
// SHARP-FREE ON PURPOSE. This module is what the render workers
// (src/lib/cassette-render-worker.ts) load, once per worker thread; the asset
// prep that needs sharp lives in cassette-motion.ts and runs once on the main
// thread. Relative, extension-full imports only and nothing but free-effects
// helpers, so Turbopack's worker bundle and Node type stripping
// (scripts/cassette-motion-test.mjs) both load it as is.

import { frameRng, loopSin } from './free-effects.ts'

export type Box = { left: number; top: number; width: number; height: number }
export type Hub = { cx: number; cy: number; r: number }
export type Rect = { x: number; y: number; w: number; h: number }

// ── Framing ─────────────────────────────────────────────────────────────────

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
  /**
   * Hub centres in LAYER pixels (left then right). EMPTY when the hubs were
   * not found in the photo (prepareMotionAssets' detected=false): nothing
   * spins, and the cassette is drawn exactly as photographed.
   */
  hubs: Hub[]
  spriteR: number
  /** Layer image pixels per cover pixel (staticLayer.width / box.width; 1 for a box-size layer). */
  layerScale: number
  lettering: { image: Img; rect: Rect } | null
  createLayer: MotionLayerFactory
  /** Fresh film grain every frame. Default true; tests turn it off to compare frames exactly. */
  grain?: boolean
}

/** Whole revolutions per 6 s: supply and take-up reels turn at different rates. */
const REVS_PER_6S: [number, number] = [2, 3]

/**
 * Build the frame renderer. The returned draw(ctx, frame) takes the GLOBAL
 * frame index and derives the loop position itself (t = (frame % total) /
 * total), so frame K renders identically whichever worker draws it and
 * whatever was drawn before it — which is what lets the render be sliced
 * across workers seamlessly. The caller resets ctx before each frame (the
 * @napi-rs/canvas snapshot leak — see cassette-render-worker.ts); the draw
 * paints the whole frame, so the reset changes no pixel.
 */
export function createCassetteMotion(s: MotionSetup) {
  const { W, H, cover, box } = s
  const crop = motionCrop(cover, box, W, H)
  const k = W / crop.w                         // cover px → frame px
  const C = { x: W / 2, y: H / 2 }
  const total = Math.max(1, Math.round(s.duration * s.fps))
  const loops = Math.max(1, Math.round(s.duration / 6))
  const revs = REVS_PER_6S.map(r => r * loops)
  const grain = s.grain !== false
  const spin = s.hubs.length > 0 && s.spriteR > 0

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
  const tiles = grain
    ? Array.from({ length: 4 }, (_, n) => {
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
    : []

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
    const t = (((frame % total) + total) % total) / total
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
    // reset(), not clearRect(): @napi-rs/canvas keeps a snapshot of every
    // canvas drawn INTO a context until that context is reset, so the plate
    // drawn here each frame would otherwise pile up one plate-sized copy per
    // frame for the whole render (the leak free-render-worker.ts documents).
    // reset() also clears the pixels and every piece of state set below.
    const n = near.ctx
    n.reset()
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
    if (spin) {
      s.hubs.forEach((hb, i) => {
        // Clockwise (seen from the front) on both reels, as on a deck playing side A.
        const angle = Math.PI * 2 * revs[i % revs.length] * t
        ctx.save()
        ctx.translate(box.left + hb.cx * L, box.top + hb.cy * L)
        ctx.rotate(angle)
        const R = s.spriteR * L
        ctx.drawImage(s.hubSprite, -R, -R, 2 * R, 2 * R)
        ctx.restore()
      })
    }

    // Film: fresh grain every frame, faint exposure breathing, vignette.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (grain) {
      ctx.globalCompositeOperation = 'overlay'
      ctx.globalAlpha = 0.16
      const tile = tiles[Math.floor(fr() * tiles.length)]
      const ox = -Math.floor(fr() * TILE), oy = -Math.floor(fr() * TILE)
      for (let y = oy; y < H; y += TILE) for (let x = ox; x < W; x += TILE) ctx.drawImage(tile, x, y)
    }
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

function clampN(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }
