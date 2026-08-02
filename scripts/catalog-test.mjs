#!/usr/bin/env node
// Contract test for the pure parts of src/lib/catalog.ts — the released-
// catalog import that feeds waterfall ISRC reuse. No network: the fetchers'
// API-shaped mappers are exercised on fixtures modeled on real Spotify/Deezer
// payloads, and the input parser on every paste form users actually produce.
//
// Why it matters: a wrong ISRC mapping silently breaks stream carry-over on
// waterfall re-releases (the whole point of the feature), and a mis-parsed
// artist URL sends the lookup to the wrong artist's catalog.
//
// Run: node scripts/catalog-test.mjs   (also part of `npm run test:renderers`)

import { parseSpotifyArtistId, mapSpotifyCatalog, mapDeezerCatalog, flattenCatalogTracks, pickMusicBrainzRecordingIds } from '../src/lib/catalog.ts'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── parseSpotifyArtistId ─────────────────────────────────────────────────────
const ID = '4Z8W4fKeB5YxbusRsdQVPb'
check('plain artist URL', parseSpotifyArtistId(`https://open.spotify.com/artist/${ID}`) === ID)
check('URL with ?si= share junk', parseSpotifyArtistId(`https://open.spotify.com/artist/${ID}?si=abc123`) === ID)
check('locale-prefixed URL', parseSpotifyArtistId(`https://open.spotify.com/intl-de/artist/${ID}`) === ID)
check('spotify: URI', parseSpotifyArtistId(`spotify:artist:${ID}`) === ID)
check('bare 22-char id', parseSpotifyArtistId(ID) === ID)
check('artist NAME is not an id', parseSpotifyArtistId('Radiohead') === null)
check('track URL is not an artist', parseSpotifyArtistId(`https://open.spotify.com/track/${ID}`) === null)
check('empty input', parseSpotifyArtistId('   ') === null)

// ── mapSpotifyCatalog ────────────────────────────────────────────────────────
const spotifyArtist = { name: 'Test Artist', external_urls: { spotify: 'https://open.spotify.com/artist/x' } }
const spotifyAlbums = [
  {
    name: 'Old Single', album_type: 'single', release_date: '2024-03-01',
    external_ids: { upc: '198000000001' }, external_urls: { spotify: 'https://open.spotify.com/album/a1' },
    tracks: { items: [{ id: 't1', name: 'Old Single', track_number: 1, duration_ms: 183456 }] },
  },
  {
    name: 'New Drop', album_type: 'single', release_date: '2025-06-13',
    external_ids: { upc: '198000000002' }, external_urls: { spotify: 'https://open.spotify.com/album/a2' },
    tracks: { items: [
      { id: 't2', name: 'New Drop', track_number: 1, duration_ms: 201000 },
      { id: 't1', name: 'Old Single', track_number: 2, duration_ms: 183456 },
    ] },
  },
]
const isrcs = new Map([['t1', 'USABC2400001'], ['t2', 'USABC2500002']])
const sp = mapSpotifyCatalog(spotifyArtist, spotifyAlbums, isrcs)

check('spotify: artist name mapped', sp.artistName === 'Test Artist')
check('spotify: newest release first', sp.releases[0].title === 'New Drop', `got ${sp.releases[0]?.title}`)
check('spotify: UPC mapped', sp.releases[0].upc === '198000000002')
check('spotify: ISRC joined by track id', sp.releases[0].tracks[0].isrc === 'USABC2500002')
check('spotify: re-released track keeps ORIGINAL isrc', sp.releases[0].tracks[1].isrc === 'USABC2400001')
check('spotify: missing isrc → null, not undefined',
  mapSpotifyCatalog(spotifyArtist, spotifyAlbums, new Map()).releases[0].tracks[0].isrc === null)
check('spotify: duration ms → rounded seconds', sp.releases[0].tracks[0].durationSeconds === 201)
check('spotify: 1-track drop typed single', sp.releases[1].releaseType === 'single')

// 8-track album should type as album even when album_type says so too
const bigAlbum = {
  name: 'LP', album_type: 'album', release_date: '2023-01-01', external_ids: {},
  tracks: { items: Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, name: `T${i}`, track_number: i + 1, duration_ms: 60000 })) },
}
check('spotify: 8 tracks typed album', mapSpotifyCatalog(spotifyArtist, [bigAlbum], new Map()).releases[0].releaseType === 'album')

// ── mapDeezerCatalog ─────────────────────────────────────────────────────────
const dzArtist = { name: 'Test Artist', link: 'https://www.deezer.com/artist/1' }
const dzAlbums = [
  {
    title: 'EP One', record_type: 'ep', release_date: '2024-11-08', upc: '198000000003',
    link: 'https://www.deezer.com/album/9',
    tracks: { data: [
      { id: 1, title: 'A', duration: 190, isrc: 'USABC2400009' },
      { id: 2, title: 'B', duration: 200 }, // isrc never annotated (cap hit)
      { id: 3, title: 'C', duration: 210, isrc: '' }, // Deezer empty-string isrc
      { id: 4, title: 'D', duration: 220, isrc: 'USABC2400012' },
    ] },
  },
]
const dz = mapDeezerCatalog(dzArtist, dzAlbums)
check('deezer: annotated isrc kept', dz.releases[0].tracks[0].isrc === 'USABC2400009')
check('deezer: unannotated → null', dz.releases[0].tracks[1].isrc === null)
check('deezer: empty-string isrc → null', dz.releases[0].tracks[2].isrc === null)
check('deezer: UPC mapped', dz.releases[0].upc === '198000000003')
check('deezer: 4 tracks typed ep', dz.releases[0].releaseType === 'ep')
check('deezer: positions are 1-based sequence', dz.releases[0].tracks.map(t => t.trackNumber).join(',') === '1,2,3,4')

// Defensive: mappers must not throw on sparse/malformed upstream objects.
const sparse = mapSpotifyCatalog({}, [{ tracks: {} }, {}], new Map())
check('spotify: sparse payload survives', sparse.releases.length === 2 && sparse.artistName === 'Unknown artist')
const dzSparse = mapDeezerCatalog({}, [{}])
check('deezer: sparse payload survives', dzSparse.releases.length === 1 && dzSparse.releases[0].tracks.length === 0)

// ── flattenCatalogTracks ─────────────────────────────────────────────────────
// The waterfall shape: "Old Single" appears on its own 2024 drop AND re-released
// on 2025's "New Drop" under the SAME ISRC. The library must hold it ONCE,
// attributed to the ORIGINAL (oldest) release — that release is the ISRC's home.
const flat = flattenCatalogTracks(sp)
check('flatten: one row per recording', flat.length === 2, `got ${flat.length}`)
const oldSingle = flat.find(r => r.title === 'Old Single')
check('flatten: re-released track attributed to ORIGINAL drop', oldSingle?.release_title === 'Old Single' && oldSingle?.release_date === '2024-03-01')
check('flatten: original drop UPC kept', oldSingle?.upc === '198000000001')
check('flatten: artist carried onto rows', flat.every(r => r.artist_name === 'Test Artist'))
check('flatten: source carried onto rows', flat.every(r => r.source === 'spotify'))
// Year-only precision must not reach the DB's date column
const yearOnly = flattenCatalogTracks(mapSpotifyCatalog(spotifyArtist, [{ ...spotifyAlbums[0], release_date: '2024' }], isrcs))
check('flatten: year-only date → null (DB column is a date)', yearOnly[0].release_date === null)
// Without ISRCs the same title on two releases still dedupes by title
const noIsrcFlat = flattenCatalogTracks(mapSpotifyCatalog(spotifyArtist, spotifyAlbums, new Map()))
check('flatten: no-ISRC dedupe falls back to title', noIsrcFlat.length === 2)

// ── pickMusicBrainzRecordingIds ──────────────────────────────────────────────
const mbPayload = {
  recordings: [
    { id: 'r-wrong-title', score: 100, title: 'Other Song', 'artist-credit': [{ name: 'Test Artist' }] },
    { id: 'r-wrong-artist', score: 99, title: 'My Song', 'artist-credit': [{ name: 'Someone Else' }] },
    { id: 'r-low', score: 80, title: 'My Song', 'artist-credit': [{ artist: { name: 'Test Artist' } }] },
    { id: 'r-best', score: 95, title: 'my song', 'artist-credit': [{ name: 'test artist' }] },
  ],
}
const ids = pickMusicBrainzRecordingIds(mbPayload, 'My Song', 'Test Artist')
check('musicbrainz: only exact title+artist matches', ids.length === 2 && !ids.includes('r-wrong-title') && !ids.includes('r-wrong-artist'))
check('musicbrainz: best score first', ids[0] === 'r-best')
check('musicbrainz: nested artist.name credit accepted', ids.includes('r-low'))
check('musicbrainz: empty payload survives', pickMusicBrainzRecordingIds({}, 'X', 'Y').length === 0)

if (failures) {
  console.error(`\n❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL CHECKS PASSED')
