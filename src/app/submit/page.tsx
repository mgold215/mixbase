import { supabaseAdmin, displayArtworkUrl, audioProxyUrl } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import { SITE_URL } from '@/lib/site'
import { resolveArtistLinks } from '@/lib/social-links'
import Nav from '@/components/Nav'
import SubmitClient from './SubmitClient'
import type { ArtistLinks, Curator, SbSubmission, Song } from '@/lib/submit'

export const dynamic = 'force-dynamic'

// Absolute, public download URL for a version's audio — the WAV a curator or
// distributor grabs. Goes through the public /api/audio proxy (?download=1 →
// Content-Disposition: attachment) and is anchored to the canonical domain so
// it survives being pasted into an email. Null unless the audio is an mf-audio
// object (the only shape the proxy serves).
function buildDownloadUrl(audioUrl: string | null, title: string, filename: string | null): string | null {
  if (!audioUrl) return null
  const proxied = audioProxyUrl(audioUrl)
  if (!proxied.startsWith('/api/audio')) return null
  const name = filename || `${title || 'mix'}.wav`
  return `${SITE_URL}${proxied}?download=1&filename=${encodeURIComponent(name)}`
}

export default async function SubmitPage() {
  const userId = await getUserId()

  // Songs come straight from the user's mixBASE projects + their versions.
  const projectsRes = await supabaseAdmin
    .from('mb_projects')
    .select('id, title, genre, artwork_url, finalized_artwork_url, share_token, mb_versions(id, version_number, audio_url, audio_filename, status)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  const songs: Song[] = (projectsRes.data ?? []).map((p) => {
    type V = { id: string; version_number: number; audio_url: string | null; audio_filename: string | null; status: string | null }
    const versions: V[] = (p.mb_versions ?? []) as V[]
    const latest = [...versions]
      .filter((v) => v.audio_url)
      .sort((a, b) => b.version_number - a.version_number)[0]
    return {
      project_id: p.id,
      title: p.title,
      genre: p.genre,
      artwork_url: displayArtworkUrl(p),
      share_token: p.share_token,
      latest_version_id: latest?.id ?? null,
      status: latest?.status ?? null,
      download_url: buildDownloadUrl(latest?.audio_url ?? null, p.title, latest?.audio_filename ?? null),
    }
  })

  // The artist's own links, auto-included in every pitch. Exact profile URLs win;
  // otherwise a keyless name-search link derived from the artist name. Falls back
  // to an artist_name-only read if the social columns predate migration 021, so
  // name-search links still work before the migration lands.
  type ProfileRow = { artist_name?: string | null; spotify_url?: string | null; youtube_url?: string | null }
  let profile: ProfileRow | null = null
  const fullRead = await supabaseAdmin
    .from('profiles')
    .select('artist_name, spotify_url, youtube_url')
    .eq('id', userId)
    .maybeSingle()
  if (fullRead.error) {
    const nameOnly = await supabaseAdmin.from('profiles').select('artist_name').eq('id', userId).maybeSingle()
    profile = (nameOnly.data as ProfileRow | null) ?? null
  } else {
    profile = (fullRead.data as ProfileRow | null) ?? null
  }

  const resolved = resolveArtistLinks({
    artistName: profile?.artist_name ?? null,
    spotifyUrl: profile?.spotify_url ?? null,
    youtubeUrl: profile?.youtube_url ?? null,
  })
  const artistLinks: ArtistLinks = {
    spotify_url: resolved.spotify?.url ?? null,
    youtube_url: resolved.youtube?.url ?? null,
  }

  const curatorsRes = await supabaseAdmin
    .from('sb_curators')
    .select('*')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('name')

  const submissionsRes = await supabaseAdmin
    .from('sb_submissions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <SubmitClient
          songs={songs}
          artistLinks={artistLinks}
          initialCurators={(curatorsRes.data ?? []) as Curator[]}
          initialSubmissions={(submissionsRes.data ?? []) as SbSubmission[]}
          userId={userId}
        />
      </div>
    </div>
  )
}
