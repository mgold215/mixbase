// ─── Released-catalog lookup (Spotify → Deezer → MusicBrainz) ───────────────
// Pulls an artist's already-released discography — titles, release dates,
// types, UPCs, and per-track ISRCs — so the pipeline can import past releases
// and backfill the ISRCs that waterfall re-releases must reuse.
//
// Three sources, tried in this order:
//   • Spotify Web API (client-credentials app token — public catalog data, no
//     artist login needed). Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET.
//   • Deezer public API — zero credentials, works out of the box (DistroKid
//     distributes to Deezer by default). Slower for ISRCs (one call per track,
//     capped) but needs no setup.
//   • MusicBrainz — keyless too, and the one source that reliably answers
//     datacenter traffic: Deezer 403s some cloud IPs outright, which took the
//     whole feature down in production even though it worked locally.
//
// The API-shaped mappers (mapSpotifyCatalog / mapDeezerCatalog /
// mapMusicBrainzCatalog) and the input parser are pure so scripts/catalog-test.mjs can exercise them on fixtures
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

// Which public source a catalog (or a stored library row) came from.
export type CatalogSource = 'spotify' | 'deezer' | 'musicbrainz'

export type ArtistCatalog = {
  source: CatalogSource
  artistName: string
  artistUrl: string | null
  releases: CatalogRelease[]
}

// Thrown for user-actionable failures (bad artist, source down) — the route
// forwards the message verbatim instead of a generic 500.
export class CatalogError extends Error {
  status: number
  /**
   * The status the UPSTREAM source returned, when the failure came from one.
   * Separate from `status` (what we hand the browser) so a caller can tell a
   * refused request apart from a rejected query without parsing the message.
   */
  upstreamStatus?: number
  constructor(message: string, status = 502, upstreamStatus?: number) {
    super(message)
    this.status = status
    this.upstreamStatus = upstreamStatus
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

// Node's fetch sends no User-Agent at all, and the CDNs in front of these
// public APIs answer that with a flat 403 from datacenter IPs — which is
// exactly how "Sync Catalog" failed on Railway while working from a laptop.
// Identify ourselves on every call (MusicBrainz asks for this outright).
const CLIENT_HEADERS: Record<string, string> = {
  'User-Agent': 'mixBASE/1.0 (https://mixbase.app)',
  'Accept': 'application/json',
}

/** Which service a URL belongs to, for error messages a user can act on. */
function upstreamName(url: string): string {
  let host = ''
  try { host = new URL(url).host } catch { /* non-URL — fall through */ }
  if (host.includes('deezer')) return 'Deezer'
  if (host.includes('musicbrainz')) return 'MusicBrainz'
  if (host.includes('spotify')) return 'Spotify'
  return 'The catalog source'
}

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    headers: { ...CLIENT_HEADERS, ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    // A bare "Upstream request failed (403)" reached the user and named no
    // source — leave a breadcrumb in the deploy log and say who refused.
    console.error(`[catalog] ${upstreamName(url)} responded ${res.status} for ${url}`)
    throw new CatalogError(`${upstreamName(url)} refused the request (${res.status})`, 502, res.status)
  }
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

// ── MusicBrainz (keyless fallback source) ────────────────────────────────────
// Deezer's public API answers some datacenter IPs with a flat 403 — that is
// how "Sync Catalog" broke in production while working from a laptop, and no
// header or retry fixes an IP-level block. MusicBrainz is the other keyless
// source that welcomes server traffic (it only asks for a descriptive
// User-Agent), and it carries the two fields this feature exists for: per-
// recording ISRCs and the release barcode (UPC). Browsing releases BY ARTIST
// with recordings+isrcs included returns a whole indie discography in one or
// two calls, so the fallback costs a second, not a minute.

const MB_HEADERS = { 'User-Agent': 'mixBASE/1.0 (https://mixbase.app)' }
const MB_API = 'https://musicbrainz.org/ws/2'
const MB_PAGE = 100
// MusicBrainz asks for ~1 request/second from applications.
const MB_PACE_MS = 1100
// A catalog this big is a label, not an artist — stop rather than page forever.
const MB_MAX_RELEASES = 300

// MusicBrainz lists every edition of a release (per country, per format). The
// library wants one row per release, so collapse a release-group to its
// richest edition — the one carrying the most ISRCs, since ISRC coverage is
// uneven across editions and an ISRC is the field a waterfall re-release
// cannot do without. The DATE always comes from the release-group's
// first-release-date where known, so collapsing never reports a reissue date.
function mbIsrcCount(release: CatalogRelease): number {
  return release.tracks.filter(t => t.isrc).length
}

/**
 * Pure mapper from a MusicBrainz artist + browsed releases (fetched with
 * `inc=recordings+isrcs+release-groups`) to the normalized catalog.
 */
export function mapMusicBrainzCatalog(artist: any, releases: any[]): ArtistCatalog {
  const byGroup = new Map<string, CatalogRelease>()

  for (const release of releases) {
    const group = release?.['release-group'] ?? null
    const groupId: string = group?.id ?? release?.id ?? ''
    if (!groupId) continue

    const tracks: CatalogTrack[] = []
    for (const medium of (release?.media ?? [])) {
      for (const [i, t] of ((medium?.tracks ?? []) as any[]).entries()) {
        const lengthMs = t?.length ?? t?.recording?.length ?? null
        tracks.push({
          trackNumber: t?.position ?? i + 1,
          title: t?.title || t?.recording?.title || 'Untitled',
          isrc: t?.recording?.isrcs?.[0] ?? null,
          durationSeconds: lengthMs != null ? Math.round(lengthMs / 1000) : null,
        })
      }
    }

    const mapped: CatalogRelease = {
      title: group?.title || release?.title || 'Untitled',
      // The group's first-release-date is the ORIGINAL drop; a single edition's
      // `date` may be a later reissue in another country.
      releaseDate: group?.['first-release-date'] || release?.date || null,
      releaseType: typeFor(tracks.length, String(group?.['primary-type'] ?? '').toLowerCase()),
      upc: release?.barcode || null,
      url: release?.id ? `https://musicbrainz.org/release/${release.id}` : null,
      tracks,
    }

    const existing = byGroup.get(groupId)
    // Richest edition wins: more ISRCs first, then the fuller tracklist.
    if (!existing
      || mbIsrcCount(mapped) > mbIsrcCount(existing)
      || (mbIsrcCount(mapped) === mbIsrcCount(existing) && mapped.tracks.length > existing.tracks.length)) {
      byGroup.set(groupId, mapped)
    }
  }

  const out = [...byGroup.values()]
  out.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
  return {
    source: 'musicbrainz',
    artistName: artist?.name ?? 'Unknown artist',
    artistUrl: artist?.id ? `https://musicbrainz.org/artist/${artist.id}` : null,
    releases: out,
  }
}

async function fetchMusicBrainzCatalog(name: string): Promise<ArtistCatalog> {
  const escaped = name.replace(/["\\]/g, ' ').trim()
  const search: any = await getJson(
    `${MB_API}/artist?query=${encodeURIComponent(`artist:"${escaped}"`)}&fmt=json&limit=5`,
    MB_HEADERS,
  )
  const candidates: any[] = search?.artists ?? []
  if (!candidates.length) throw new CatalogError(`No artist found for "${name}"`, 404)
  const artist = candidates.find(a => String(a?.name ?? '').toLowerCase() === name.trim().toLowerCase()) ?? candidates[0]

  // ISRCs are the point of the sync, but they are not worth losing the whole
  // fallback over: if this server's MusicBrainz rejects `inc=isrcs`, drop it
  // and keep the titles/dates/UPCs — the per-row "Find ISRC" button fills the
  // rest. A 503 here means "you went too fast", so it earns one paced retry.
  let inc = 'recordings+isrcs+release-groups'
  const browse = async (offset: number): Promise<any> => {
    const url = (i: string) => `${MB_API}/release?artist=${artist.id}&inc=${i}&fmt=json&limit=${MB_PAGE}&offset=${offset}`
    try {
      return await getJson(url(inc), MB_HEADERS)
    } catch (e) {
      const upstream = e instanceof CatalogError ? e.upstreamStatus : undefined
      if (upstream === 400 && inc.includes('isrcs')) {
        console.error('[catalog] MusicBrainz rejected inc=isrcs — retrying without ISRCs')
        inc = 'recordings+release-groups'
        return await getJson(url(inc), MB_HEADERS)
      }
      if (upstream === 503) {
        await new Promise(r => setTimeout(r, MB_PACE_MS * 2))
        return await getJson(url(inc), MB_HEADERS)
      }
      throw e
    }
  }

  const releases: any[] = []
  for (let offset = 0; offset < MB_MAX_RELEASES; offset += MB_PAGE) {
    if (offset > 0) await new Promise(r => setTimeout(r, MB_PACE_MS))
    const page: any = await browse(offset)
    const items: any[] = page?.releases ?? []
    releases.push(...items)
    if (items.length < MB_PAGE || releases.length >= (page?.['release-count'] ?? 0)) break
  }
  if (!releases.length) throw new CatalogError(`MusicBrainz lists no releases for "${artist.name}"`, 404)

  return mapMusicBrainzCatalog(artist, releases)
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
 * a Spotify artist URL/URI/id or a plain artist name.
 *
 * Source order: Spotify when API keys are configured, otherwise Deezer with
 * MusicBrainz behind it. The fallback is not belt-and-braces: Deezer's public
 * API returns 403 to some datacenter IPs, so a keyless deployment that only
 * knew Deezer could not sync at all from the host it actually runs on.
 */
export async function fetchArtistCatalog(query: string): Promise<ArtistCatalog> {
  const q = query.trim()
  if (!q) throw new CatalogError('Artist name or Spotify artist link required', 400)

  if (spotifyConfigured()) return fetchSpotifyCatalog(q)

  let name = q
  const spotifyId = parseSpotifyArtistId(q)
  if (spotifyId) {
    const resolved = await spotifyUrlToName(spotifyId)
    if (!resolved) {
      throw new CatalogError(
        'Could not resolve that Spotify link without API keys — enter the artist name instead, or set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.',
        400,
      )
    }
    name = resolved
  }

  let deezerFailure: CatalogError | null = null
  try {
    const catalog = await fetchDeezerCatalog(name)
    // An artist page with nothing on it is a miss, not an answer — a fresh
    // DistroKid drop can be live on MusicBrainz before Deezer lists it.
    if (catalog.releases.length) return catalog
    deezerFailure = new CatalogError(`Deezer lists no releases for "${catalog.artistName}"`, 404)
  } catch (e) {
    deezerFailure = e instanceof CatalogError ? e : new CatalogError('Deezer lookup failed')
  }

  try {
    return await fetchMusicBrainzCatalog(name)
  } catch (e) {
    const mb = e instanceof CatalogError ? e : new CatalogError('MusicBrainz lookup failed')
    // Both keyless sources are out. Say what each one did — a 403 from a
    // datacenter IP and "no such artist" need completely different fixes —
    // and point at the credentials that make this path reliable.
    const bothMissed = deezerFailure.status === 404 && mb.status === 404
    throw new CatalogError(
      bothMissed
        ? `${deezerFailure.message}. ${mb.message}. Check the artist spelling, or paste your Spotify artist link.`
        : `${deezerFailure.message}. Fallback: ${mb.message}. Set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET for a source that does not block server traffic.`,
      bothMissed ? 404 : 502,
    )
  }
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

// The subset of a stored library row that a re-sync is allowed to consult when
// deciding what to keep. Deliberately structural (not the full DB row) so the
// merge stays pure and unit-testable.
export type StoredLibraryFacts = Partial<Omit<LibraryTrackRow, 'title' | 'release_title'>>

// Fields where a previously-known value must never be replaced by a blank.
// `title`/`release_title`/`source` are excluded on purpose: they are always
// present on an incoming row and identify WHICH release we're describing, so a
// genuine correction upstream should win.
const PRESERVED_ON_BLANK = ['isrc', 'upc', 'release_date', 'source_url', 'artist_name'] as const

/**
 * Merge a freshly fetched catalog row over the stored one: **new facts win over
 * blanks, but blanks never win over facts.**
 *
 * The sync route's own comment has always promised this; the code did a blind
 * spread, so every re-sync overwrote all columns including with `null`. That was
 * silent data loss, and the ISRC was the expensive part to lose: per-track ISRC
 * lookups are best-effort (`.catch(() => null)`) and rate-capped, so one Deezer
 * throttle turned a real ISRC into `null` — destroying a code the user had
 * fetched via the MusicBrainz "Find ISRC" button or typed by hand. That code is
 * exactly what `validateForDistroKid` needs for a waterfall re-release to keep
 * its streaming history, so losing it silently costs real money.
 *
 * Pure: no clock, no I/O. The caller owns `project_id` and `updated_at`.
 */
export function mergeLibraryRow(existing: StoredLibraryFacts, incoming: LibraryTrackRow): LibraryTrackRow {
  const merged: LibraryTrackRow = { ...incoming }
  // Every preserved field is a nullable string, so one keyed view over both
  // objects keeps the loop readable — TypeScript can't narrow an assignment
  // across a union of keys without it.
  const target = merged as unknown as Record<string, string | null>
  const stored = existing as Record<string, string | null | undefined>
  for (const key of PRESERVED_ON_BLANK) {
    // Blank means "this sync didn't learn it", not "this is known to be empty".
    const incomingValue = target[key]
    const existingValue = stored[key]
    const incomingBlank = incomingValue === null || incomingValue === undefined || incomingValue === ''
    if (incomingBlank && existingValue != null && existingValue !== '') {
      target[key] = existingValue
    }
  }
  return merged
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
