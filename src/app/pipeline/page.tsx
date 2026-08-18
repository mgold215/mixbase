import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Nav from '@/components/Nav'
import PipelineClient from './PipelineClient'

export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const userId = await getUserId()

  // mb_versions has no user_id column — scope it through the project join so
  // all the queries can run in parallel instead of waiting on project ids.
  const [releasesRes, projectsRes, versionsRes, profileRes, libraryRes] = await Promise.all([
    supabaseAdmin
      .from('mb_releases')
      .select('*, mb_projects(title, artwork_url, finalized_artwork_url)')
      .eq('user_id', userId)
      .order('release_date', { ascending: true, nullsFirst: false }),
    supabaseAdmin
      .from('mb_projects')
      .select('id, title')
      .eq('user_id', userId)
      .order('title'),
    supabaseAdmin
      .from('mb_versions')
      .select('id, project_id, version_number, label, status, audio_url, audio_filename, mb_projects!inner(user_id)')
      .eq('mb_projects.user_id', userId)
      .order('version_number', { ascending: false }),
    // Seeds the waterfall-form prefill and the catalog-import search box.
    // On any error (e.g. columns missing pre-migration) the page just renders
    // without prefill — never fail the board over a convenience.
    supabaseAdmin
      .from('profiles')
      .select('artist_name, spotify_url')
      .eq('id', userId)
      .maybeSingle(),
    // Released-library ISRC/UPC lookup for waterfall re-releases. On any
    // error (e.g. table missing pre-migration) the board renders without the
    // fallback — never fail the page over it.
    supabaseAdmin
      .from('mb_library_tracks')
      .select('title, isrc, upc')
      .eq('user_id', userId)
      .limit(1000),
  ])

  // The board's own data. A failure here must NOT fall through to empty arrays:
  // rendered as emptiness it is indistinguishable from a brand-new account, so
  // the user reads "my releases are gone" (or the version picker says "No
  // versions yet" for a project that has plenty) and nobody ever files it as a
  // bug. That is the opposite of the two reads above, which degrade on purpose
  // and say so — those are convenience prefill, these are the page.
  //
  // Throwing hands the request to src/app/error.tsx, the route-level boundary
  // that exists for exactly this ("unhandled render/data errors in any page"):
  // branded recovery screen, Try again, and the error captured to Sentry.
  const loadError = releasesRes.error ?? projectsRes.error ?? versionsRes.error
  if (loadError) throw new Error(`Pipeline data failed to load: ${loadError.message}`)

  // Strip the join helper column so PipelineClient's prop shape is unchanged.
  const versions = (versionsRes.data ?? []).map(v => ({
    id: v.id,
    project_id: v.project_id,
    version_number: v.version_number,
    label: v.label,
    status: v.status,
    audio_url: v.audio_url,
    audio_filename: v.audio_filename,
  }))

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        <PipelineClient
          initialReleases={releasesRes.data ?? []}
          projects={projectsRes.data ?? []}
          versions={versions}
          profile={profileRes.error ? null : (profileRes.data ?? null)}
          libraryTracks={libraryRes.error ? [] : (libraryRes.data ?? [])}
        />
      </div>
    </div>
  )
}
