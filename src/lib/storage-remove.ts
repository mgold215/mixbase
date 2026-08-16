import { supabaseAdmin } from '@/lib/supabase'

// Deleting from Supabase Storage without being able to lie about it.
//
// `supabaseAdmin.storage.from(b).remove(paths)` resolves to
// `{ data: FileObject[], error: null }` where `data` lists the objects it
// ACTUALLY removed. When a delete is refused by storage RLS it is not an error:
// the policy simply matches no rows, storage-api answers `200` with `[]`, and
// supabase-js hands back `{ data: [], error: null }`.
//
// So the natural-looking guard
//
//     const { error } = await supabase.storage.from(b).remove(paths)
//     if (error) console.error(...)
//
// is blind to total failure. That is exactly how mixBASE leaked 259 objects
// (~5.2 GB) across mf-audio/mf-artwork/mf-video while every delete path in the
// app reported success — including account deletion, which left users' audio in
// a public bucket after their row was gone. (Root cause was the shared admin
// client picking up a user session and dropping to role `authenticated`; fixed
// in src/lib/supabase.ts. This helper is the second line of defence: even with
// the right role, a policy change or a revoked grant would otherwise fail
// silently again.)
//
// Use this instead of calling `.remove()` directly anywhere the removal matters.
export type RemoveOutcome = {
  // Keys storage confirmed it deleted.
  removed: string[]
  // Keys we asked about that storage did NOT confirm. Either already gone or
  // refused — the response cannot tell us which, so callers must not treat this
  // as success.
  unconfirmed: string[]
  // Transport/API error, if the call failed outright.
  error: string | null
  // True only when every requested key was confirmed removed.
  ok: boolean
}

export async function removeStorageObjects(bucket: string, paths: string[]): Promise<RemoveOutcome> {
  const requested = paths.filter(Boolean)
  if (requested.length === 0) return { removed: [], unconfirmed: [], error: null, ok: true }

  const { data, error } = await supabaseAdmin.storage.from(bucket).remove(requested)
  if (error) {
    return { removed: [], unconfirmed: requested, error: error.message, ok: false }
  }

  // `data` lists the objects storage actually removed. Guard the shape — an
  // unexpected payload must read as "unconfirmed", never as success.
  const returned = Array.isArray(data)
    ? data.map(o => (o && typeof o === 'object' && 'name' in o ? String((o as { name: unknown }).name) : ''))
        .filter(Boolean)
    : []
  const returnedSet = new Set(returned)

  // `FileObject.name` is documented as "relative to the prefix", and remove()
  // returns `storage.objects` rows whose `name` column holds the FULL key —
  // which is what we send. Both readings are accepted rather than betting on
  // one: if the shape were ever a basename, an exact-match-only comparison
  // would mark every successful delete as unconfirmed and bury the one signal
  // that matters. A basename is only accepted when it is unambiguous within
  // this batch, so it can never merge two distinct keys into one confirmation.
  const basename = (k: string) => k.slice(k.lastIndexOf('/') + 1)

  // A basename is only trusted when exactly one requested key claims it. Note
  // this counts a bucket-ROOT key (no '/') as claiming its own name, which is
  // what makes the EXACT-match branch safe too: if the batch held both
  // `clip.wav` and `proj/clip.wav` and the server echoed basenames, a bare
  // `clip.wav` in the response would otherwise "confirm" the root key when the
  // prefixed one was what got deleted. Root keys are not hypothetical — the iOS
  // app writes `<UUID>-v19-<ts>.wav` straight to the bucket root in mf-audio,
  // while the web app writes `<projectId>/<ts>.wav`, so both shapes coexist and
  // a delete-account batch can contain the two together.
  const claims = new Map<string, number>()
  for (const p of requested) {
    const b = basename(p)
    claims.set(b, (claims.get(b) ?? 0) + 1)
  }

  // Decide the echo STYLE once, from the response, instead of per key. Any
  // returned name containing '/' means the server is echoing full keys (what it
  // actually does — `storage.objects.name` holds the whole key), and then exact
  // matching is unambiguous for every shape including root keys. Only when every
  // returned name is bare do we fall back to basenames, and then a key is
  // confirmed solely if it is the unique claimant of that basename.
  const fullKeyEcho = returned.some(n => n.includes('/'))
  const isRemoved = (p: string) =>
    fullKeyEcho
      ? returnedSet.has(p)
      : (claims.get(basename(p)) ?? 0) === 1 && returnedSet.has(basename(p))

  const removed = requested.filter(isRemoved)
  const unconfirmed = requested.filter(p => !isRemoved(p))

  return { removed, unconfirmed, error: null, ok: unconfirmed.length === 0 }
}

// Remove and log loudly when storage did not confirm. Returns whether every key
// was confirmed gone, so callers that must not claim success can branch on it.
//
// The "confirmed nothing at all" case gets its own message because it is the
// signature of a systemic permission failure rather than a stale key — that
// distinction is what would have surfaced the incident in hours instead of months.
export async function removeStorageObjectsLogged(
  bucket: string,
  paths: string[],
  context: string,
): Promise<boolean> {
  const outcome = await removeStorageObjects(bucket, paths)
  if (outcome.error) {
    console.error(`[${context}] storage remove failed on ${bucket}: ${outcome.error}`)
  } else if (outcome.removed.length === 0 && outcome.unconfirmed.length > 0) {
    console.error(
      `[${context}] storage remove confirmed NOTHING on ${bucket} (asked for ${outcome.unconfirmed.length}). ` +
      `This is the signature of a permissions failure, not a stale key — check that the admin client still has service_role.`,
    )
  } else if (outcome.unconfirmed.length > 0) {
    console.warn(
      `[${context}] storage remove unconfirmed on ${bucket}: ${outcome.unconfirmed.join(', ')} ` +
      `(removed ${outcome.removed.length}/${outcome.removed.length + outcome.unconfirmed.length})`,
    )
  }
  return outcome.ok
}
