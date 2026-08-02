// ─── Released-catalog lookup (Spotify → Deezer fallback) ────────────────────
// Pulls an artist's already-released discography — titles, release dates,
// types, UPCs, and per-track ISRCs — so the pipeline can import past releases
// and backfill the ISRCs that waterfall re-releases must reuse.
//
// Two sources, tried in this order:
//   • Spotify Web API (client-credentials app token — public catalog data, no
//     artist login needed). Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET.
//   • Deezer public API — zero credentials, works out of the box (DistroKid
//     distributes to Deezer by default). Slower for ISRCs (one call per track,
//     capped) but needs no setup.
//
// The API-shaped mappers (mapSpotifyCatalog / mapDeezerCatalog) and the input
// parser are pure so scripts/catalog-test.mjs can exercise them on fixtures
// without network.

export type CatalogTrack = {
  trackNumber: number
  title: string
  isrc: string | null
  durationSeconds: number | null
}

export type CatalogRelease = {
  title: string
  releaseDate: string | null // YYYY-MM-DD (or YYYY / YYYY-MM as the source reports)
  releaseType: 'single' | 'ep' | 'album'
  upc: string | null
  url: string | null
  tracks: CatalogTrack[]
}

export type ArtistCatalog = {
  source: 'spotify' | 'deezer'
  artistName: string
  artistUrl: string | null
  releases: CatalogRelease[]
}

// Thrown for user-actionable failures (bad artist, source down) — the route
// forwards the message verbatim instead of a generic 500.
export class CatalogError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

export function spotifyConfigured(): boolean {
  return !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET
}

/**
 * Extract a Spotify artist id from any of the forms users paste: a profile URL
 * (with or without locale prefix / query string), a spotify:artist: URI, or a
 * bare 22-char base62 id. Returns null when the input isn't Spotify-shaped
 * (i.e. it's probably an artist name).
 */
export function parseSpotifyArtistId(input: string): string | null {
  const s = input.trim()
  const url = /open\.spotify\.com\/(?:[a-z-]+\/)?artist\/([0-9A-Za-z]{22})/.exec(s)
  if (url) return url[1]
  const uri = /^spotify:artist:([0-9A-Za-z]{22})$/.exec(s)
  if (uri) return uri[1]
  if (/^[0-9A-Za-z]{22}$/.test(s)) return s
  return null
}

// DistroKid types releases by track count (a 1–3 track drop is a "single").
// Trust the source's own single/album labels where they're stronger.
function typeFor(count: number, sourceType?: string | null): 'single' | 'ep' | 'album' {
  if (sourceType === 'album' && count > 6) return 'album'
  if (count <= 3) return 'single'
  if (count <= 6) return 'ep'
  return 'album'
}

// 15s per upstream call — a hung source should fail the request, not pin it.
const FETCH_TIMEOUT_MS = 15_000

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new CatalogError(`Upstream request failed (${res.status})`)
  return res.json()
}

/* eslint-disable @typescript-eslint/no-explicit-any -- raw upstream JSON */

// ── Spotify ──────────────────────────────────────────────────────────────────

// App token cache (client-credentials). Module-level like the rate limiters —
// one per process, refreshed a minute before expiry.
let spotifyToken: { token: string; expiresAt: number } | null = null

async function getSpotifyToken(): Promise<string> {
  if (spotifyToken && Date.now() < spotifyToken.expiresAt - 60_000) return spotifyToken.token
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new CatalogError('Spotify auth failed — check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET')
  const data = await res.json() as { access_token: string; expires_in: number }
  spotifyToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return spotifyToken.token
}

/**
 * Pure mapper from raw Spotify payloads to the normalized catalog. `albums`
 * are FULL album objects (they carry external_ids.upc + simplified tracks);
 * `isrcByTrackId` comes from the batched /v1/tracks lookup.
 */
export function mapSpotifyCatalog(
  artist: any,
  albums: any[],
  isrcByTrackId: Map<string, string>,
): ArtistCatalog {
  const releases: CatalogRelease[] = albums.map(album => {
    const items: any[] = album?.tracks?.items ?? []
    const tracks: CatalogTrack[] = items.map((t, i) => ({
      trackNumber: t?.track_number ?? i + 1,
      title: t?.name ?? 'Untitled',
      isrc: isrcByTrackId.get(t?.id) ?? null,
      durationSeconds: t?.duration_ms != null ? Math.round(t.duration_ms / 1000) : null,
    }))
    return {
      title: album?.name ?? 'Untitled',
      releaseDate: album?.release_date ?? null,
      releaseType: typeFor(tracks.length, album?.album_type),
      upc: album?.external_ids?.upc ?? null,
      url: album?.external_urls?.spotify ?? null,
      tracks,
    }
  })
  releases.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
  return {
    source: 'spotify',
    artistName: artist?.name ?? 'Unknown artist',
    artistUrl: artist?.external_urls?.spotify ?? null,
    releases,
  }
}

async function fetchSpotifyCatalog(query: string): Promise<ArtistCatalog> {
  const token = await getSpotifyToken()
  const auth = { Authorization: `Bearer ${token}` }
  const api = 'https://api.spotify.com/v1'

  // Resolve the artist: pasted profile URL/id directly, otherwise name search
  // (exact case-insensitive match preferred over Spotify's fuzzy first hit).
  let artist: any
  const id = parseSpotifyArtistId(query)
  if (id) {
    artist = await getJson(`${api}/artists/${id}`, auth)
  } else {
    const found: any = await getJson(`${api}/search?type=artist&limit=5&q=${encodeURIComponent(query)}`, auth)
    const items: any[] = found?.artists?.items ?? []
    if (!items.length) throw new CatalogError(`No Spotify artist found for "${query}"`, 404)
    artist = items.find(a => a?.name?.toLowerCase() === query.trim().toLowerCase()) ?? items[0]
  }

  // All albums/singles/compilations, paged (200 is plenty for an indie catalog).
  const albumIds: string[] = []
  for (let offset = 0; offset < 200; offset += 50) {
    const page: any = await getJson(
      `${api}/artists/${artist.id}/albums?include_groups=album,single,compilation&market=US&limit=50&offset=${offset}`,
      auth,
    )
    const items: any[] = page?.items ?? []
    albumIds.push(...items.map(a => a.id))
    if (!page?.next) break
  }

  // Full album objects (UPC + tracklists), 20 per batch — the API's batch cap.
  const albums: any[] = []
  for (let i = 0; i < albumIds.length; i += 20) {
    const batch: any = await getJson(`${api}/albums?ids=${albumIds.slice(i, i + 20).join(',')}&market=US`, auth)
    albums.push(...(batch?.albums ?? []).filter(Boolean))
  }

  // ISRCs live only on FULL track objects — batch /v1/tracks, 50 per call.
  const trackIds = albums.flatMap(a => (a?.tracks?.items ?? []).map((t: any) => t?.id)).filter(Boolean)
  const isrcByTrackId = new Map<string, string>()
  for (let i = 0; i < trackIds.length; i += 50) {
    const batch: any = await getJson(`${api}/tracks?ids=${trackIds.slice(i, i + 50).join(',')}&market=US`, auth)
    for (const t of batch?.tracks ?? []) {
      if (t?.id && t?.external_ids?.isrc) isrcByTrackId.set(t.id, t.external_ids.isrc)
    }
  }

  return mapSpotifyCatalog(artist, albums, isrcByTrackId)
}

// ── Deezer ───────────────────────────────────────────────────────────────────

// ISRC needs one /track/{id} call each on Deezer — cap the total so a huge
// catalog can't turn one request into hundreds of upstream calls.
const DEEZER_ISRC_CAP = 150

// Deezer reports failures — including "Quota limit exceeded" (code 4) — as
// HTTP 200 bodies with an `error` envelope. Reading those as data is exactly
// how ISRCs silently came back empty: every throttled /track call looked like
// a track without an ISRC. This wrapper surfaces the envelope and retries
// quota trips with a backoff sized to Deezer's 50-requests-per-5s window.
async function getDeezerJson(url: string, attempts = 4): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const data: any = await getJson(url)
    if (!data?.error) return data
    const isQuota = data.error.code === 4 || /quota/i.test(String(data.error.message ?? ''))
    if (isQuota && attempt < attempts) {
      await new Promise(r => setTimeout(r, 1500 * attempt))
      continue
    }
    throw new CatalogError(`Deezer error: ${data.error.message ?? 'unknown'}`)
  }
}

/**
 * Pure mapper from raw Deezer payloads (artist + FULL album objects, whose
 * track entries have been annotated with `isrc` where fetched).
 */
export function mapDeezerCatalog(artist: any, albums: any[]): ArtistCatalog {
  const releases: CatalogRelease[] = albums.map(album => {
    const items: any[] = album?.tracks?.data ?? []
    const tracks: CatalogTrack[] = items.map((t, i) => ({
      trackNumber: i + 1,
      title: t?.title ?? 'Untitled',
      isrc: t?.isrc || null,
      durationSeconds: t?.duration ?? null,
    }))
    return {
      title: album?.title ?? 'Untitled',
      releaseDate: album?.release_date ?? null,
      releaseType: typeFor(tracks.length, album?.record_type),
      upc: album?.upc || null,
      url: album?.link ?? null,
      tracks,
    }
  })
  releases.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
  return {
    source: 'deezer',
    artistName: artist?.name ?? 'Unknown artist',
    artistUrl: artist?.link ?? null,
    releases,
  }
}

async function fetchDeezerCatalog(name: string): Promise<ArtistCatalog> {
  const api = 'https://api.deezer.com'
  const found = await getDeezerJson(`${api}/search/artist?q=${encodeURIComponent(name)}&limit=5`)
  const candidates: any[] = found?.data ?? []
  if (!candidates.length) throw new CatalogError(`No artist found for "${name}"`, 404)
  const artist = candidates.find(a => a?.name?.toLowerCase() === name.trim().toLowerCase()) ?? candidates[0]

  const albumList = await getDeezerJson(`${api}/artist/${artist.id}/albums?limit=100`)
  const albumIds: number[] = (albumList?.data ?? []).map((a: any) => a.id)

  // Full album objects (UPC + tracklist) — small paced batches to stay inside
  // Deezer's 50-requests-per-5s public quota (quota trips retry via the
  // wrapper, but not tripping it at all is faster).
  const albums: any[] = []
  for (let i = 0; i < albumIds.length; i += 5) {
    const batch = await Promise.all(albumIds.slice(i, i + 5).map(id => getDeezerJson(`${api}/album/${id}`).catch(() => null)))
    albums.push(...batch.filter(Boolean))
    if (i + 5 < albumIds.length) await new Promise(r => setTimeout(r, 400))
  }

  // The embedded tracklist is truncated on long albums — fetch the full list
  // when the album says it has more tracks than the embed carries.
  for (const album of albums) {
    const embedded: any[] = album?.tracks?.data ?? []
    if (album?.nb_tracks > embedded.length) {
      const full = await getDeezerJson(`${api}/album/${album.id}/tracks?limit=100`).catch(() => null)
      if (full?.data?.length) album.tracks = { data: full.data }
    }
  }

  // Annotate tracks with ISRCs (full track object only), newest albums first
  // so the cap spends its budget on the releases a waterfall actually reuses.
  albums.sort((a, b) => String(b?.release_date ?? '').localeCompare(String(a?.release_date ?? '')))
  const pending: any[] = albums.flatMap(a => a?.tracks?.data ?? []).slice(0, DEEZER_ISRC_CAP)
  for (let i = 0; i < pending.length; i += 5) {
    await Promise.all(pending.slice(i, i + 5).map(async t => {
      const full = await getDeezerJson(`${api}/track/${t.id}`).catch(() => null)
      if (full?.isrc) t.isrc = full.isrc
    }))
    if (i + 5 < pending.length) await new Promise(r => setTimeout(r, 400))
  }

  return mapDeezerCatalog(artist, albums)
}

// Resolve a pasted Spotify artist URL to the artist's display name using
// Spotify's public oEmbed endpoint — no credentials needed. Lets the Deezer
// fallback work even when the user gave us a Spotify link.
async function spotifyUrlToName(artistId: string): Promise<string | null> {
  try {
    const data: any = await getJson(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/artist/${artistId}`)}`,
    )
    return typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : null
  } catch {
    return null
  }
}

/**
 * Fetch the artist's released catalog. `query` is whatever the user gave us —
 * a Spotify artist URL/URI/id or a plain artist name. Uses Spotify when API
 * keys are configured, otherwise falls back to Deezer (resolving a pasted
 * Spotify URL to a name via oEmbed first).
 */
export async function fetchArtistCatalog(query: string): Promise<ArtistCatalog> {
  const q = query.trim()
  if (!q) throw new CatalogError('Artist name or Spotify artist link required', 400)

  if (spotifyConfigured()) return fetchSpotifyCatalog(q)

  const spotifyId = parseSpotifyArtistId(q)
  if (spotifyId) {
    const name = await spotifyUrlToName(spotifyId)
    if (!name) {
      throw new CatalogError(
        'Could not resolve that Spotify link without API keys — enter the artist name instead, or set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.',
        400,
      )
    }
    return fetchDeezerCatalog(name)
  }
  return fetchDeezerCatalog(q)
}

// ── Library flattening ───────────────────────────────────────────────────────

// One row per RECORDING for the released library. A waterfall re-releases the
// same track (same ISRC) on several releases — the library wants it once,
// attributed to its ORIGINAL drop (that release is the ISRC's home).
export type LibraryTrackRow = {
  title: string
  artist_name: string
  isrc: string | null
  upc: string | null
  release_title: string
  release_date: string | null // strict YYYY-MM-DD or null (DB column is a date)
  release_type: string
  source: string
  source_url: string | null
}

/** Pure: flatten a fetched catalog into deduped library rows, oldest release wins per recording. */
export function flattenCatalogTracks(catalog: ArtistCatalog): LibraryTrackRow[] {
  // Oldest release first so the first occurrence of a recording is its original drop.
  const oldestFirst = [...catalog.releases].sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999'))
  const byKey = new Map<string, LibraryTrackRow>()
  for (const rel of oldestFirst) {
    for (const t of rel.tracks) {
      const key = t.isrc?.trim() ? `isrc:${t.isrc.trim()}` : `title:${t.title.trim().toLowerCase()}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        title: t.title,
        artist_name: catalog.artistName,
        isrc: t.isrc?.trim() || null,
        upc: rel.upc,
        release_title: rel.title,
        release_date: rel.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(rel.releaseDate) ? rel.releaseDate : null,
        release_type: rel.releaseType,
        source: catalog.source,
        source_url: rel.url,
      })
    }
  }
  return [...byKey.values()]
}

// ── MusicBrainz single-track ISRC lookup ────────────────────────────────────
// Second keyless source for filling ISRC gaps one track at a time (their open
// API asks for a descriptive User-Agent and ~1 req/s — fine for a per-row
// "Find ISRC" button, deliberately not used for bulk sync).

/* eslint-disable @typescript-eslint/no-explicit-any -- raw upstream JSON */

const MB_HEADERS = { 'User-Agent': 'mixBASE/1.0 (https://mixbase.app)' }

/**
 * Pure: pick the recording ids worth an ISRC lookup from a MusicBrainz
 * recording-search payload — exact title match and the artist in the credit,
 * best search score first. (Search results never include ISRCs; each id needs
 * a follow-up lookup with inc=isrcs.)
 */
export function pickMusicBrainzRecordingIds(payload: any, title: string, artist: string): string[] {
  const recs: any[] = payload?.recordings ?? []
  const t = title.trim().toLowerCase()
  const a = artist.trim().toLowerCase()
  return recs
    .filter(r => String(r?.title ?? '').toLowerCase() === t)
    .filter(r => (r?.['artist-credit'] ?? []).some((c: any) => String(c?.name ?? c?.artist?.name ?? '').toLowerCase() === a))
    .sort((x, y) => (y?.score ?? 0) - (x?.score ?? 0))
    .map(r => r?.id)
    .filter(Boolean)
}

export async function findIsrcViaMusicBrainz(title: string, artist: string): Promise<string | null> {
  const esc = (s: string) => s.replace(/["\\]/g, ' ').trim()
  const query = `recording:"${esc(title)}" AND artist:"${esc(artist)}"`
  const search = await getJson(
    `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`,
    MB_HEADERS,
  )
  // Check up to 3 matching recordings, paced to MusicBrainz's ~1 req/s ask.
  for (const id of pickMusicBrainzRecordingIds(search, title, artist).slice(0, 3)) {
    await new Promise(r => setTimeout(r, 1100))
    const rec: any = await getJson(`https://musicbrainz.org/ws/2/recording/${id}?fmt=json&inc=isrcs`, MB_HEADERS).catch(() => null)
    if (rec?.isrcs?.length) return rec.isrcs[0]
  }
  return null
}

/* eslint-enable @typescript-eslint/no-explicit-any */
