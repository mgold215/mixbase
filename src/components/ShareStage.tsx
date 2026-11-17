'use client'

import React, { type CSSProperties, type RefObject } from 'react'
import Image from 'next/image'
import CassetteIcon from '@/components/CassetteIcon'
import { PENDING_PALETTE, mix, rgbCss, rgbTriplet, type SharePalette } from '@/lib/share-palette'

// What the two public players are DRAWN with — the backdrop, the cover and the
// title — shared by the single-track page (ShareClient) and the album page
// (AlbumPlayer) so the two cannot drift apart in feel. The signals these read
// (the cover's palette, --energy, --beat, --px/--py) come from
// src/lib/share-fx.ts; the motion itself is CSS in globals.css (".share-…"),
// so nothing here runs per frame.
//
// Rules this file keeps (see .claude/skills/share-pages/SKILL.md → The alive layer):
//   · Anything that changes every frame changes only opacity or transform. A
//     blur is drawn once and then faded or moved, never re-blurred.
//   · The owner's handwriting is shown as written. Effects are light ON it
//     (a glow behind, a sweep across), never a recolouring of the ink.
//   · Everything stops for prefers-reduced-motion (globals.css).

/** The custom properties a player root carries; spread into its `style`. */
export function stageStyle(palette: SharePalette): CSSProperties {
  return {
    '--energy': 0,
    '--beat': 0,
    '--share-accent': rgbTriplet(palette.accent),
    // The glow behind the title: the cover's main colour pushed toward white,
    // so it reads as light even on a backdrop of that same colour.
    '--share-glow': rgbTriplet(mix(palette.glow[0], [255, 255, 255], 0.3)),
    '--share-ink': rgbTriplet(palette.ink),
  } as CSSProperties
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// The backdrop is the cover itself, blurred. White type has to stay readable
// on it, so a pale cover (a cassette on cream paper) is dimmed and a dark one
// (olive at night) is opened up — both land near the same depth. brightness()
// scales sRGB values, luminance follows at about the 2.2 power.
const BACKDROP_LUMINANCE = 0.15
function backdropBrightness(tone: number): number {
  return clamp(Math.pow(BACKDROP_LUMINANCE / Math.max(tone, 0.01), 1 / 2.2), 0.5, 1.3)
}

// ── Backdrop ────────────────────────────────────────────────────────────────
type BackdropProps = {
  /** Moved by useParallax. */
  innerRef: RefObject<HTMLDivElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  /** The visualizer loop that fills the page, when the song has one. */
  loopUrl: string | null
  artUrl: string | null
  palette: SharePalette
}

export function ShareBackdrop({ innerRef, videoRef, loopUrl, artUrl, palette }: BackdropProps) {
  const mode = loopUrl ? 'loop' : artUrl ? 'art' : 'none'
  return (
    // A little larger than the page: the pointer slides it a few pixels
    // (useParallax) and its edge must never come into view.
    <div
      ref={innerRef}
      className="share-backdrop absolute -inset-5 pointer-events-none overflow-hidden"
      data-mode={mode}
      data-lit={palette !== PENDING_PALETTE}
      style={{ transition: 'transform 0.6s ease-out' }}
    >
      {loopUrl ? (
        <video
          ref={videoRef}
          key={loopUrl}
          src={loopUrl}
          poster={artUrl ?? undefined}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: 'scale(1.04)' }}
        />
      ) : artUrl ? (
        // Drawn at a quarter of the page and scaled up (share-drift-wash): a
        // blur costs by the pixel, and a wash of colour has no detail to lose,
        // so this is the same picture for a sixteenth of the work. The blur
        // grows with the screen — what melts a cover on a phone leaves it a
        // recognisable smeared photograph on a laptop.
        <div className="share-drift-wash">
          <Image
            key={artUrl}
            src={artUrl} alt="" fill unoptimized
            className="object-cover"
            style={{ filter: `blur(clamp(7px, 1.5vmax, 22px)) saturate(1.9) brightness(${backdropBrightness(palette.tone).toFixed(2)})` }}
          />
        </div>
      ) : (
        <div className="absolute inset-0" style={{ background: '#08070c' }} />
      )}

      {/* Three lights in the cover's own colours, each on its own slow path.
          They add light (screen), so a loop underneath keeps its picture. */}
      <div className="share-lights" aria-hidden>
        <div className="share-aurora">
          {palette.glow.map((c, i) => <i key={i} style={{ backgroundColor: rgbCss(c) }} />)}
        </div>
        {/* The accent, swelling with the music. */}
        <div className="share-bloom" />
      </div>

      {/* Depth at the edges, and at the top and foot where the header and the
          feedback bar sit. */}
      <div className="share-vignette" />
      {/* Film grain: takes the banding out of the blur and gives the page the
          texture of the tape it is about. */}
      <div className="share-grain" />
    </div>
  )
}

// ── Cover ───────────────────────────────────────────────────────────────────
type CoverProps = {
  artUrl: string | null
  alt: string
  /** Tailwind width/height classes. */
  sizeClass: string
  priority?: boolean
}

export function ShareCover({ artUrl, alt, sizeClass, priority }: CoverProps) {
  return (
    <div className={`share-in share-cover ${sizeClass}`} style={{ animationDelay: '80ms' }}>
      {/* The cover's own colours spilling out behind it. */}
      <div
        className="share-cover-halo"
        style={artUrl ? { backgroundImage: `url("${cssUrl(artUrl)}")` } : { background: 'rgb(var(--share-glow))' }}
      />
      <div className="share-cover-float">
        <div className="share-cover-tilt">
          <div className="share-cover-card">
            {artUrl ? (
              <Image key={artUrl} src={artUrl} alt={alt} fill className="object-cover" unoptimized priority={priority} />
            ) : (
              <div className="absolute inset-0 bg-[#1a1a1a] flex items-center justify-center">
                <CassetteIcon size={64} className="text-[#333]" />
              </div>
            )}
            {/* Light on the sleeve: one that follows the pointer, one that
                crosses on its own every few seconds. */}
            <div className="share-cover-sheen" />
            <div className="share-cover-glint" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Title ───────────────────────────────────────────────────────────────────
type TitleProps = {
  title: string
  /** The title in the artist's own handwriting (white ink on transparency). */
  letteringUrl?: string | null
  /** 'hero' on the single-track page, 'compact' for the album's now-playing. */
  size?: 'hero' | 'compact'
}

export function ShareTitle({ title, letteringUrl, size = 'hero' }: TitleProps) {
  if (letteringUrl) return <HandwrittenTitle title={title} letteringUrl={letteringUrl} />
  return <TypedTitle title={title} size={size} />
}

// A storage URL inside url("…"): nothing in one should need escaping, but a
// quote or a backslash must never be able to close the string.
function cssUrl(url: string): string {
  return url.replace(/["\\\n\r]/g, c => encodeURIComponent(c))
}

// The handwriting is written in from the left, then light crosses it now and
// then; behind it a glow in the cover's colour follows the music. The ink
// itself is the artist's file, untouched.
function HandwrittenTitle({ title, letteringUrl }: { title: string; letteringUrl: string }) {
  const hand = { '--hand': `url("${cssUrl(letteringUrl)}")` } as CSSProperties
  return (
    <>
      <div className="share-hand-write">
        <div className="share-hand relative mx-auto h-[5.5rem] sm:h-32 w-[min(88vw,640px)]" style={hand}>
          <span className="share-title-late absolute inset-0" aria-hidden>
            <span className="share-hand-layer share-title-glow" />
          </span>
          <span className="share-hand-layer share-title-fringe" data-side="a" aria-hidden />
          <span className="share-hand-layer share-title-fringe" data-side="b" aria-hidden />
          <span className="share-title-shine absolute inset-0">
            <Image
              src={letteringUrl} alt={title} fill unoptimized
              className="object-contain"
              style={{ filter: 'drop-shadow(0 2px 12px rgba(0,0,0,0.6))' }}
            />
          </span>
        </div>
      </div>
      <h1 className="sr-only">{title}</h1>
    </>
  )
}

// Letters, not code units: an emoji or an accented letter is one shape.
function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment)
  }
  return Array.from(text)
}

// The whole reveal takes about this long however many letters there are.
const LETTER_STEP_MS = 38
const REVEAL_SPAN_MS = 700

function TypedTitle({ title, size }: { title: string; size: 'hero' | 'compact' }) {
  const words = title.split(/\s+/).filter(Boolean).map(graphemes)
  // Where each word's first letter falls in the run (a space counts as one).
  const starts: number[] = []
  let count = 0
  for (const word of words) { starts.push(count); count += word.length + 1 }
  const step = Math.min(LETTER_STEP_MS, Math.round(REVEAL_SPAN_MS / Math.max(1, count)))
  // A long title steps down a size so it does not fill the phone.
  const long = title.length > 22
  const scale = size === 'hero'
    ? (long ? 'text-[1.7rem] sm:text-4xl' : 'text-[2.2rem] sm:text-5xl')
    : (long ? 'text-xl sm:text-2xl' : 'text-2xl sm:text-3xl')

  // Each layer lays the same words out the same way, so they sit exactly on
  // one another: the letters themselves, a blurred copy behind them (the
  // glow), and two tinted copies that part on the beat.
  const layer = (animated: boolean) => words.map((word, w) => (
    <React.Fragment key={w}>
      {w > 0 && ' '}
      <span className="share-word">
        {word.map((ch, c) => (
          <span
            key={c}
            className="share-letter"
            style={animated ? ({ '--i': starts[w] + c } as CSSProperties) : undefined}
          >{ch}</span>
        ))}
      </span>
    </React.Fragment>
  ))

  return (
    <h1
      aria-label={title}
      className={`share-title ${scale}`}
      style={{ '--step': `${step}ms` } as CSSProperties}
    >
      <span className="share-title-layer share-title-late" aria-hidden>
        <span className="share-title-glow">{layer(false)}</span>
      </span>
      <span className="share-title-layer share-title-fringe" data-side="a" aria-hidden>{layer(false)}</span>
      <span className="share-title-layer share-title-fringe" data-side="b" aria-hidden>{layer(false)}</span>
      <span className="share-title-main share-title-shine" aria-hidden>{layer(true)}</span>
    </h1>
  )
}
