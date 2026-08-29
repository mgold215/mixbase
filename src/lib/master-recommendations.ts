// ─── Limiter & master-chain recommendations from a loudness measurement ──────
// Turns the Master Check numbers into the settings conversation a mastering
// engineer would have: what the ceiling should be, how hard the limiter should
// work, and what belongs in the chain BEFORE it. Everything is derived from
// the three measured values (integrated LUFS, loudest-3s short-term, sample
// peak) — no genre guessing, no spectral claims we can't back with data.
//
// Two derived figures drive the branching:
//   PLR (peak − integrated): on a limited master this approximates crest
//     factor. < 6 dB is slammed, 8–12 dB is healthy, > 12 dB is barely limited.
//   STI (short-term max − integrated): how far the loudest section rises above
//     the whole-track average — the "is the limiter only working on the drop"
//     signal a static readout can't show.
//
// Advice is phrased universally, with the identical move spelled out for the
// two staples (FabFilter Pro-L 2, iZotope Ozone 11) on a secondary line —
// concrete knob names help even users of other tools map the advice across.
// Pure and dependency-free like src/lib/loudness.ts, so the node test can
// exercise every branch (scripts/master-recommendations-test.mjs).

import type { LoudnessMeasurement } from './loudness'

export type MasterRecommendation = {
  /** The knob or chain area this touches ("Output ceiling", "Limiter drive"…). */
  area: string
  /** Universal, plugin-agnostic advice with the measured numbers baked in. */
  advice: string
  /** The same move in Pro-L 2 / Ozone 11 terms. */
  plugins?: string
}

const db = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '−∞')

export function masterRecommendations(m: LoudnessMeasurement): MasterRecommendation[] {
  const recs: MasterRecommendation[] = []
  const I = m.integratedLufs
  // Unmeasurable audio gets no settings advice — the verdict already errors.
  if (!Number.isFinite(I)) return recs

  const P = m.samplePeakDb
  const ST = m.shortTermMaxLufs
  const plr = Number.isFinite(P) ? P - I : NaN
  const sti = Number.isFinite(ST) ? ST - I : NaN
  const loud = I > -9 // club-level master; normalization will turn it down

  // ── Output ceiling — the one limiter parameter everyone gets to set once ──
  if (P > -0.3) {
    recs.push({
      area: 'Output ceiling',
      advice: `Peaks hit ${db(P)} dBFS — and that is SAMPLE peak, so true peaks read higher and lossy transcodes (Spotify/Apple) overshoot further still. Set the ceiling to −1.0 dBTP with true-peak limiting on${loud ? ', or −2.0 dBTP if this loud a master shows transcode distortion' : ''}. Perceived loudness barely moves; only the overs go.`,
      plugins: 'Pro-L 2: Output −1.0, True Peak Limiting ON, Oversampling 4×. Ozone 11 Maximizer: Ceiling −1.0 dBTP, True Peak mode ON.',
    })
  } else if (P > -1.05) {
    recs.push({
      area: 'Output ceiling',
      advice: `Ceiling looks set around ${db(P)} dB — right where it should be. Keep true-peak limiting and oversampling on so inter-sample peaks don't sneak past on encode.`,
      plugins: 'Pro-L 2: True Peak Limiting ON, Oversampling ≥4×. Ozone 11 Maximizer: True Peak mode ON.',
    })
  } else if (P < -2.5 && I < -12) {
    const free = -1 - P // dB of gain available before a −1 dBTP ceiling
    recs.push({
      area: 'Output ceiling',
      advice: `${free.toFixed(1)} dB of unused headroom below a −1 dBTP ceiling. Raising the limiter's input gain that much lifts the whole master to ~${db(I + free)} LUFS with essentially zero added limiting — free loudness before any trade-off starts.`,
      plugins: 'Pro-L 2: raise Gain until the meter just touches the ceiling. Ozone 11 Maximizer: lower Threshold by the same amount.',
    })
  }

  // ── Limiter drive — how much of the dynamics budget is already spent ──────
  if (Number.isFinite(plr)) {
    if (plr < 6) {
      recs.push({
        area: 'Limiter drive',
        advice: `Peak-to-loudness is ${plr.toFixed(1)} dB — slammed territory. Streaming normalization throws the level away and keeps only the flattening. Back the limiter's input gain off ~2 dB so it catches 2–4 dB at the loudest hits, and get density earlier in the chain (clipper or saturation on the mix bus) instead of at the ceiling.`,
        plugins: 'Pro-L 2: lower Gain until the GR meter peaks around 3 dB; Style Modern. Ozone 11: ease the Maximizer threshold; use the Exciter or Vintage Tape module earlier in the chain for density.',
      })
    } else if (plr > 12 && I < -16) {
      recs.push({
        area: 'Limiter drive',
        advice: `Only ${plr.toFixed(1)} dB peak-to-loudness at ${db(I)} LUFS — the limiter is barely working and the master sits below every platform target (−14). There's room to push the input ~${Math.min(4, Math.round(-14 - I))} dB before limiting becomes audible, if a competitive level is the goal.`,
        plugins: 'Pro-L 2: raise Gain, watch the GR meter stay under ~4 dB. Ozone 11 Maximizer: lower Threshold the same way.',
      })
    }
  }

  // ── Before the limiter — the chain work a limiter can't do ────────────────
  if (Number.isFinite(sti)) {
    if (sti > 5) {
      recs.push({
        area: 'Before the limiter',
        advice: `The loudest 3 s runs ${sti.toFixed(1)} dB above the track average, so one static limiter setting slams the drop and ignores everything else. Level the sections first: 1–2 dB of slow glue compression (≈2:1, slow attack, auto release) or ride the section levels with automation, then let the limiter handle only peaks.`,
        plugins: 'Ozone 11: add the Dynamics module before the Maximizer, ~1–2 dB of gain reduction. Pro-L 2: put any bus compressor ahead of it — the limiter stays last.',
      })
    } else if (sti < 1.5 && loud) {
      recs.push({
        area: 'Before the limiter',
        advice: `Every section is within ${sti.toFixed(1)} dB of the loudest 3 s — the track is wall-to-wall. If the drop should still lift, automate 1–2 dB dips into the quieter sections before the limiter; normalization won't give that contrast back.`,
        plugins: 'Do this in the mix/DAW with clip gain or fader automation — no limiter setting recreates section contrast.',
      })
    }
  }

  // ── Release & style — where dense masters win or lose ─────────────────────
  if (loud || (Number.isFinite(plr) && plr < 8)) {
    recs.push({
      area: 'Release & style',
      advice: 'At this density the release setting decides the sound: too fast pumps and distorts the low end, too slow ducks the tail of every kick. Start from auto/adaptive release near 100 ms, shorten until pumping appears, then back off one notch. Keep a few ms of lookahead.',
      plugins: 'Pro-L 2: Style Modern (Aggressive for harder EDM), Release ~100 ms with Auto on, Lookahead ~2 ms. Ozone 11 Maximizer: IRC IV Modern, Character around 5.',
    })
  }

  // ── Chain hygiene — always worth restating ────────────────────────────────
  recs.push({
    area: 'Chain order',
    advice: 'Limiter last, always: EQ → compression → saturation → limiter, with nothing after the ceiling — a post-limiter EQ or widener re-introduces the very overs the ceiling just caught. And gain-match when bypassing anything; louder always sounds better.',
    plugins: 'Ozone 11: Maximizer in the final module slot. Pro-L 2: last insert on the master bus, after any Ozone modules.',
  })

  return recs
}
