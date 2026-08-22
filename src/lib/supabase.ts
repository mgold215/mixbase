import { createClient } from '@supabase/supabase-js'
import { decodeJwt } from 'jose'
import { MIX_STATUSES, type MixStatus } from './mix-status'

// Hardcoded as fallbacks — these are public keys, safe to expose in client code
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU'

// Extract the `role` claim from a Supabase JWT-style API key without verifying
// it (we only need to know what PostgREST will treat it as). jose's decodeJwt
// is runtime-agnostic — this module is pulled into the Edge middleware bundle,
// where a hand-rolled Buffer decode would silently fail and false-alarm on a
// perfectly good key. Returns null for anything that doesn't parse.
function jwtRole(key: string): string | null {
  try {
    return (decodeJwt(key).role as string | undefined) ?? null
  } catch {
    return null
  }
}

// True only when SUPABASE_SERVICE_ROLE_KEY will actually get service-role
// power from Supabase. This catches BOTH failure modes we've been bitten by:
// the variable being missing entirely, and the variable being set to the wrong
// key (e.g. the anon key pasted in its place) — either way the admin client
// degrades to anon: RLS-filtered reads come back empty and every server-side
// write dies with an RLS violation while the app otherwise looks healthy.
// New-style secret keys (sb_secret_...) aren't JWTs; trust the prefix.
// .trim() matters: a stray leading/trailing space or newline from pasting the
// key into a Railway variable breaks BOTH the prefix test and the JWT parse, so
// a perfectly good key reads as invalid and the middleware 503s every /api/*
// route — a total outage with a misleading cause.
const rawServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined
export const serviceRoleKeyValid: boolean = !!rawServiceKey && (
  rawServiceKey.startsWith('sb_secret_') || jwtRole(rawServiceKey) === 'service_role'
)

// Server-side only. This module is also pulled into the client bundle (it
// exports SUPABASE_URL/audioProxyUrl), where the service key is absent BY
// DESIGN — so firing there printed a guaranteed false alarm in every visitor's
// console, leaked internal env-var names, and taught us to ignore the one
// signal that catches a genuinely misconfigured deploy.
if (!serviceRoleKeyValid && typeof window === 'undefined') {
  console.error(
    rawServiceKey
      ? '[supabase] SUPABASE_SERVICE_ROLE_KEY is set but is NOT a service-role key (wrong key pasted?) — admin client is running as anon. All server-side writes WILL FAIL with RLS violations.'
      : '[supabase] SUPABASE_SERVICE_ROLE_KEY not set — admin client falling back to anon key. Uploads and size-limited ops WILL FAIL in production.'
  )
}

// Server-only admin client — uses service role key if available, falls back to anon.
//
// ⚠️ NEVER call a session-ESTABLISHING auth method on this client
// (`signInWithPassword`, `signUp`, `refreshSession`, `setSession`, `verifyOtp`).
// Use `createSessionClient()` below instead. `auth.admin.*` is fine — it always
// sends the service key explicitly.
//
// Why this is not a style preference. supabase-js resolves the token for EVERY
// PostgREST and Storage request through SupabaseClient._getAccessToken():
//
//     if (this.accessToken) return await this.accessToken()
//     const { data } = await this.auth.getSession()
//     return data.session?.access_token ?? this.supabaseKey
//
// The service key is only the FALLBACK. The moment a session lands on this
// client, every later `.from()` and `.storage` call from this process sends that
// user's access token instead — at role `authenticated`, not `service_role`.
// This module is a singleton on a long-lived Railway process, so one sign-in
// re-identified the whole server until the next deploy.
//
// It shipped that way and it was silent, because the damage is mostly INVISIBLE:
// storage RLS grants DELETE on mf-audio/mf-artwork/mf-video only to
// `auth.role() = 'service_role'`, so an `authenticated` delete matches no policy,
// removes zero rows, and storage-api answers `200` with a body of `[]`.
// supabase-js reports `{ data: [], error: null }` — NO error — so every cleanup
// path in the app "succeeded" while deleting nothing. Confirmed in production
// 2026-08-15: 10/10 delete_many calls returned an empty array, and 259 objects
// (~5.2 GB) had accumulated across the three buckets, including files belonging
// to deleted accounts.
export const supabaseAdmin = createClient(
  SUPABASE_URL,
  rawServiceKey ?? SUPABASE_ANON_KEY
)

// Throwaway client for the calls that MUST establish a user session: sign-in,
// sign-up's post-create sign-in, password change re-auth, and token refresh.
//
// Fresh per call and never reused, so the session it acquires dies with it and
// can never leak onto a data path. Sessions are not persisted or auto-refreshed:
// this client exists to hand back one set of tokens, which the caller puts in
// cookies — it is not a logged-in client that anything reads from afterwards.
// Logins are rare relative to data requests, so the extra allocation is noise,
// and with autoRefreshToken off it starts no background timers to leak.
export function createSessionClient() {
  return createClient(SUPABASE_URL, rawServiceKey ?? SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

// ---- Type definitions ----

export type Project = {
  id: string
  title: string
  artwork_url: string | null
  finalized_artwork_url: string | null
  visualizer_url: string | null
  // Horizontal 16:9 pin (migration 020) — feeds the Full-Length finalize.
  // Optional-shaped (?? null at read sites) since prod rows can predate it.
  visualizer_wide_url?: string | null
  genre: string | null
  bpm: number | null
  key_signature: string | null
  share_token: string | null
  created_at: string
  updated_at: string
  user_id: string
}

// Listings, tiles, share pages, etc. should show the finalized render (with
// artist/title overlay) when present, falling back to the raw source. Project
// page reads both fields directly to drive its preview + Finalize button.
export function displayArtworkUrl(p: {
  artwork_url?: string | null
  finalized_artwork_url?: string | null
}): string | null {
  return p.finalized_artwork_url ?? p.artwork_url ?? null
}

export type Version = {
  id: string
  project_id: string
  version_number: number
  label: string | null
  audio_url: string
  audio_filename: string | null
  duration_seconds: number | null
  file_size_bytes: number | null
  status: MixStatus
  private_notes: string | null
  public_notes: string | null
  change_log: string | null
  share_token: string | null
  allow_download: boolean
  created_at: string
}

export type Feedback = {
  id: string
  version_id: string
  reviewer_name: string
  rating: number | null
  comment: string | null
  timestamp_seconds: number | null
  created_at: string
}

export type Release = {
  id: string
  user_id: string
  title: string
  release_date: string | null
  project_id: string | null
  final_version_id: string | null
  genre: string | null
  label: string | null
  isrc: string | null
  notes: string | null
  mixing_done: boolean
  mastering_done: boolean
  artwork_ready: boolean
  dsp_submitted: boolean
  social_posts_done: boolean
  press_release_done: boolean
  dsp_spotify: boolean
  dsp_apple_music: boolean
  dsp_tidal: boolean
  dsp_bandcamp: boolean
  dsp_soundcloud: boolean
  dsp_youtube: boolean
  dsp_amazon: boolean
  // DistroKid submission metadata (migration 026)
  artist_name: string | null
  release_type: 'single' | 'ep' | 'album'
  featured_artists: string | null
  songwriters: string | null
  producers: string | null
  explicit: boolean
  instrumental: boolean
  language: string
  secondary_genre: string | null
  version_info: string | null
  upc: string | null
  // Waterfall sequencing: releases sharing a group id form one run;
  // position is 1-based in drop order (1 = first single).
  waterfall_group_id: string | null
  waterfall_position: number | null
  created_at: string
  updated_at: string
}

export type Activity = {
  id: string
  user_id: string
  type: string
  project_id: string | null
  version_id: string | null
  release_id: string | null
  description: string | null
  created_at: string
}

// StatusPipeline derives ring-*/bg-* classes from `color` at runtime, which
// Tailwind's scanner can't see — these literals keep them in the build:
// ring-blue-400 bg-blue-400 ring-violet-400 bg-violet-400
// ring-emerald-400 bg-emerald-400 ring-teal-400 bg-teal-400
export const STATUS_CONFIG: Record<MixStatus, { label: string; color: string; bg: string; border: string; step: number }> = {
  'Mix':      { label: 'Mix',      color: 'text-blue-400',    bg: 'bg-blue-400/10',    border: 'border-blue-400/30',    step: 1 },
  'Master':   { label: 'Master',   color: 'text-violet-400',  bg: 'bg-violet-400/10',  border: 'border-violet-400/30',  step: 2 },
  'Finished': { label: 'Finished', color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30', step: 3 },
  'Released': { label: 'Released', color: 'text-teal-400',    bg: 'bg-teal-400/10',    border: 'border-teal-400/30',    step: 4 },
}

export const STATUSES = MIX_STATUSES

export function audioProxyUrl(supabaseUrl: string): string {
  const marker = '/storage/v1/object/public/mf-audio/'
  const idx = supabaseUrl.indexOf(marker)
  if (idx === -1) return supabaseUrl
  return `/api/audio/${supabaseUrl.slice(idx + marker.length)}`
}

// Rewrite an mf-artwork public URL to our same-origin proxy so iOS can render it on
// the lock screen / Control Center (see src/app/api/artwork/[...path]/route.ts).
// Non-mf-artwork URLs (e.g. transient Replicate URLs) are returned unchanged.
export function artworkProxyUrl(url: string): string {
  const marker = '/storage/v1/object/public/mf-artwork/'
  const idx = url.indexOf(marker)
  if (idx === -1) return url
  return `/api/artwork/${url.slice(idx + marker.length)}`
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
