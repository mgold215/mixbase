#!/usr/bin/env node
// Regression harness for the curator-submission link fields (src/lib/submit.ts
// renderTemplate + src/lib/social-links.ts resolveArtistLinks).
//
// What it locks:
//  - resolveArtistLinks: a stored profile URL wins; a blank/invalid one falls
//    back to a keyless name-search link; neither present + no name → null.
//  - renderTemplate: the download / Spotify / YouTube links land in the pitch,
//    an empty field drops its whole line (no dangling "Spotify:" label), and a
//    template that never positions a link token still ships it as a footer.
//
// Pure source logic — no DB / network. Run: node scripts/submit-links-test.mjs
// (also part of `npm run test:renderers`)

import {
  resolveArtistLinks, spotifySearchUrl, youtubeSearchUrl, isHttpUrl,
} from '../src/lib/social-links.ts'
import { renderTemplate, DEFAULT_TEMPLATE } from '../src/lib/submit.ts'

let failures = 0
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`) }
  else { console.error(`FAIL  ${name}`); failures++ }
}

const curator = {
  id: 'c1', user_id: null, name: 'Test Curator', type: 'playlist', platform: 'web',
  genres: ['house'], contact_method: 'email', contact_value: 'a@b.com', audience_size: null,
  accepts_submissions: true, guidelines: null, confidence: 'VERIFIED', source_url: null,
  notes: null, last_contacted: null, created_at: '',
}
const song = (over = {}) => ({
  project_id: 'p1', title: 'Night Drive', genre: 'house', artwork_url: null,
  share_token: 'tok123', latest_version_id: 'v1', status: 'final',
  download_url: 'https://mixbase.app/api/audio/p1/mix.wav?download=1&filename=mix.wav',
  ...over,
})
const links = { spotify_url: 'https://open.spotify.com/artist/abc', youtube_url: 'https://youtube.com/@moodmixformat' }
const shareUrl = 'https://mixbase.app/share/tok123'

// ── social-links ──
console.log('resolveArtistLinks:')
{
  const r = resolveArtistLinks({ artistName: 'Moodmix', spotifyUrl: null, youtubeUrl: null })
  check('name fallback → spotify search', r.spotify?.url === spotifySearchUrl('Moodmix') && r.spotify.source === 'name')
  check('name fallback → youtube search', r.youtube?.url === youtubeSearchUrl('Moodmix') && r.youtube.source === 'name')
}
{
  const r = resolveArtistLinks({ artistName: 'X', spotifyUrl: 'https://open.spotify.com/artist/abc', youtubeUrl: '   ' })
  check('stored spotify wins (source profile)', r.spotify?.url === 'https://open.spotify.com/artist/abc' && r.spotify.source === 'profile')
  check('blank youtube → name fallback', r.youtube?.source === 'name')
}
{
  const r = resolveArtistLinks({ artistName: '', spotifyUrl: null, youtubeUrl: null })
  check('no name + no url → null links', r.spotify === null && r.youtube === null)
}
{
  const r = resolveArtistLinks({ artistName: 'X', spotifyUrl: 'not-a-url', youtubeUrl: 'ftp://x' })
  check('invalid stored url ignored → name fallback', r.spotify?.source === 'name' && r.youtube?.source === 'name')
}
check('isHttpUrl rejects javascript:', !isHttpUrl('javascript:alert(1)'))

// ── renderTemplate ──
console.log('renderTemplate (DEFAULT_TEMPLATE, all links present):')
{
  const out = renderTemplate(DEFAULT_TEMPLATE, curator, song(), shareUrl, 'Great for late-night sets.', links)
  check('carries download link', out.includes(song().download_url))
  check('carries spotify link', out.includes(links.spotify_url))
  check('carries youtube link', out.includes(links.youtube_url))
  check('carries listen link', out.includes(shareUrl))
  check('no unresolved tokens', !/\{[a-z_]+\}/.test(out))
  check('no dangling empty label', !/:\s*$/m.test(out.replace(/\n+$/,'')))
}

console.log('renderTemplate (missing audio → no download link):')
{
  const out = renderTemplate(DEFAULT_TEMPLATE, curator, song({ download_url: null }), shareUrl, 'x', links)
  check('download line dropped', !out.includes('Download (WAV)'))
  check('spotify still present', out.includes(links.spotify_url))
}

console.log('renderTemplate (no artist links set):')
{
  const out = renderTemplate(DEFAULT_TEMPLATE, curator, song(), shareUrl, 'x', { spotify_url: null, youtube_url: null })
  check('spotify line dropped', !out.includes('Spotify:'))
  check('youtube line dropped', !out.includes('YouTube:'))
  check('download still present', out.includes('Download (WAV)'))
}

console.log('renderTemplate (empty pitch tidies whitespace):')
{
  const out = renderTemplate(DEFAULT_TEMPLATE, curator, song(), shareUrl, '', links)
  check('no triple newline runs', !/\n{3,}/.test(out))
}

console.log('renderTemplate (legacy template without link tokens → footer append):')
{
  const legacy = 'Subject: {track_title}\n\nHi {curator_name}, listen: {track_url}\n\n— Me'
  const out = renderTemplate(legacy, curator, song(), shareUrl, '', links)
  check('appends download footer', out.includes(`Download (WAV): ${song().download_url}`))
  check('appends spotify footer', out.includes(`Spotify: ${links.spotify_url}`))
  check('appends youtube footer', out.includes(`YouTube: ${links.youtube_url}`))
  check('footer after body', out.indexOf('Spotify:') > out.indexOf('listen:'))
}

console.log('renderTemplate (legacy template, only spotify set → only spotify footer):')
{
  const legacy = 'Hi {curator_name}'
  const out = renderTemplate(legacy, curator, song({ download_url: null }), shareUrl, '', { spotify_url: links.spotify_url, youtube_url: null })
  check('spotify appended', out.includes(`Spotify: ${links.spotify_url}`))
  check('youtube NOT appended', !out.includes('YouTube:'))
  check('download NOT appended', !out.includes('Download (WAV)'))
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1) }
console.log('\nAll submit-links checks passed.')
