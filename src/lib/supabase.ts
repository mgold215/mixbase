import { createClient } from '@supabase/supabase-js'

// Hardcoded as fallbacks — these are public keys, safe to expose in client code
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU'

// Server-only admin client — uses service role key if available, falls back to anon
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[supabase] SUPABASE_SERVICE_ROLE_KEY not set — admin client falling back to anon key. Uploads and size-limited ops WILL FAIL in production.')
}
export const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY
)

// ---- Type definitions ----

export type Project = {
  id: string
  title: string
  artwork_url: string | null
  finalized_artwork_url: string | null
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
  status: 'WIP' | 'Mix/Master' | 'Finished' | 'Released'
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

export const STATUS_CONFIG = {
  'WIP':        { label: 'WIP',          color: 'text-yellow-400',  bg: 'bg-yellow-400/10',  border: 'border-yellow-400/30',  step: 1 },
  'Mix/Master': { label: 'Mix / Master', color: 'text-blue-400',    bg: 'bg-blue-400/10',    border: 'border-blue-400/30',    step: 2 },
  'Finished':   { label: 'Finished',     color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30', step: 3 },
  'Released':   { label: 'Released',     color: 'text-teal-400',  bg: 'bg-teal-400/10',  border: 'border-teal-400/30',  step: 4 },
}

export const STATUSES = ['WIP', 'Mix/Master', 'Finished', 'Released'] as const

export function audioProxyUrl(supabaseUrl: string): string {
  const marker = '/storage/v1/object/public/mf-audio/'
  const idx = supabaseUrl.indexOf(marker)
  if (idx === -1) return supabaseUrl
  return `/api/audio/${supabaseUrl.slice(idx + marker.length)}`
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
