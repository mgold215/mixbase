// ─── Release-day ISRC lookup: the job ───────────────────────────────────────
// Applies the rules in release-isrc.ts. Once a day (from CHECK_HOUR_ET), each
// server process looks for pipeline releases that are out, have no ISRC and
// are due a lookup; for each user with one, it runs the same library sync as
// the "Sync Catalog" button, then copies the ISRC (and same-day UPC) from the
// library onto every pipeline release of theirs that is still blank.
//
// A day with nothing due costs one database read and no network calls.
// Production runs two processes; each keeps its own once-a-day flag, and a
// library sync newer than FRESH_SYNC_MS is not repeated, so the second
// process only fills blanks from what the first one fetched.
//
// Never overwrites an ISRC or UPC that is already set, and every failure is
// logged and swallowed: this must never take the server down.

import { supabaseAdmin } from './supabase'
import { syncLibraryForUser } from './library-sync'
import {
  CHECK_HOUR_ET, FRESH_SYNC_MS, easternParts, isReleaseDue, matchLibraryCodes, type LibraryCode,
} from './release-isrc'

type ReleaseRow = {
  id: string
  user_id: string
  title: string
  release_date: string | null
  isrc: string | null
  upc: string | null
  artist_name: string | null
}

const LOG = '[release-isrc]'

async function lastLibrarySync(userId: string): Promise<Date | null> {
  const { data, error } = await supabaseAdmin
    .from('mb_library_tracks')
    .select('updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(1)
  if (error) throw new Error(`library read failed: ${error.message}`)
  const at = data?.[0]?.updated_at
  return at ? new Date(at) : null
}

async function artistQueryFor(userId: string, releases: ReleaseRow[]): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('artist_name, spotify_url')
    .eq('id', userId)
    .maybeSingle()
  const fromProfile = data?.spotify_url?.trim() || data?.artist_name?.trim()
  if (fromProfile) return fromProfile
  return releases.find(r => r.artist_name?.trim())?.artist_name?.trim() ?? null
}

/** Copy library ISRCs onto this user's blank pipeline releases. Returns how many were filled. */
async function fillReleaseCodes(userId: string, releases: ReleaseRow[]): Promise<number> {
  const { data: library, error } = await supabaseAdmin
    .from('mb_library_tracks')
    .select('title, isrc, upc, release_date')
    .eq('user_id', userId)
    .limit(1000)
  if (error) throw new Error(`library read failed: ${error.message}`)

  let filled = 0
  for (const release of releases) {
    const codes = matchLibraryCodes(release, (library ?? []) as LibraryCode[])
    if (!codes) continue
    const patch: Record<string, string> = { isrc: codes.isrc, updated_at: new Date().toISOString() }
    if (codes.upc && !release.upc?.trim()) patch.upc = codes.upc
    const { data: written, error: writeErr } = await supabaseAdmin
      .from('mb_releases')
      .update(patch)
      .eq('id', release.id)
      .eq('user_id', userId)
      // Re-checked in the write itself: an ISRC typed in meanwhile wins.
      .or('isrc.is.null,isrc.eq.')
      .select('id')
    if (writeErr) console.error(`${LOG} could not save ISRC for "${release.title}": ${writeErr.message}`)
    else if (written?.length) {
      filled++
      console.log(`${LOG} filled ISRC for "${release.title}" (${release.release_date})`)
    }
  }
  return filled
}

/** One pass of the check. Exported for a manual run; the scheduler calls it daily. */
export async function runReleaseIsrcCheck(now: Date = new Date()): Promise<void> {
  const today = easternParts(now).date
  const { data, error } = await supabaseAdmin
    .from('mb_releases')
    .select('id, user_id, title, release_date, isrc, upc, artist_name')
    .not('release_date', 'is', null)
    .lte('release_date', today)
    .or('isrc.is.null,isrc.eq.')
    .limit(1000)
  if (error) {
    console.error(`${LOG} could not read releases: ${error.message}`)
    return
  }

  const byUser = new Map<string, ReleaseRow[]>()
  for (const r of (data ?? []) as ReleaseRow[]) {
    if (!r.user_id) continue
    byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r])
  }

  for (const [userId, releases] of byUser) {
    try {
      const last = await lastLibrarySync(userId)
      const lastDate = last ? easternParts(last).date : null
      const due = releases.filter(r => isReleaseDue(r.release_date, r.isrc, today, lastDate))
      if (!due.length) continue

      const fresh = last != null && now.getTime() - last.getTime() < FRESH_SYNC_MS
      if (!fresh) {
        const artist = await artistQueryFor(userId, releases)
        if (!artist) {
          console.error(`${LOG} ${due.length} release(s) due but the account has no artist name to look up`)
          continue
        }
        try {
          const result = await syncLibraryForUser(userId, artist)
          console.log(`${LOG} library synced from ${result.source}: ${result.created} new, ${result.updated} updated, ${result.failed} failed`)
        } catch (e) {
          console.error(`${LOG} catalog lookup failed: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
      }

      const filled = await fillReleaseCodes(userId, releases)
      console.log(`${LOG} ${due.length} release(s) due, ${filled} ISRC(s) filled`)
    } catch (e) {
      console.error(`${LOG} check failed for one account: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000
let started = false
let lastRunDate: string | null = null
let running = false

async function tick(): Promise<void> {
  if (running) return
  const { date, hour } = easternParts(new Date())
  if (hour < CHECK_HOUR_ET || lastRunDate === date) return
  running = true
  lastRunDate = date
  try {
    await runReleaseIsrcCheck()
  } catch (e) {
    console.error(`${LOG} run failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    running = false
  }
}

/**
 * Start the once-a-day check in this process (called from instrumentation.ts).
 * The first look is 2 to 30 minutes after boot, randomized so the two
 * production processes don't hit the catalog at the same moment, then hourly;
 * the hourly look only does anything once per Eastern day.
 */
export function startReleaseIsrcScheduler(): void {
  if (started) return
  started = true
  const firstDelay = (2 + Math.random() * 28) * 60 * 1000
  const first = setTimeout(() => {
    void tick()
    const every = setInterval(() => { void tick() }, HOUR_MS)
    every.unref?.()
  }, firstDelay)
  first.unref?.()
}
