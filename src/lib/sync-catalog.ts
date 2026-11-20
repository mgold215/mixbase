// Shapes and pure helpers of the public sync catalog (/sync/<token>), kept
// apart from the server loader (src/lib/sync-share.ts) so the client page and
// the unit suite can import them without pulling in the service-role client.

export type SyncTrack = {
  id: string
  title: string
  genre: string | null
  bpm: number | null
  key: string | null
  duration: number | null
  artworkUrl: string | null
  audioUrl: string
  instrumentalUrl: string | null
}

export type SyncCatalogData = {
  title: string
  artistName: string
  coverUrl: string | null
  tracks: SyncTrack[]
}

/** Pure: "3:07" for 187.4 seconds, '' when unknown. */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Pure: the gate. Only a collection explicitly marked for sync is served. */
export function isSyncCatalog(row: { is_sync?: unknown } | null | undefined): boolean {
  return row?.is_sync === true
}
