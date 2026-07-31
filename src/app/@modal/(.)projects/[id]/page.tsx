import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import ModalShell from '@/components/ModalShell'
import ProjectClient from '@/app/projects/[id]/ProjectClient'
import { getFeedCommentsForVersions, type FeedComment } from '@/lib/feed'

export const dynamic = 'force-dynamic'

// Intercepts client-side navigation to /projects/[id] (e.g. from the dashboard
// grid) and renders the project view in a modal over the current page. Hard
// loads and shared URLs still get the full page at src/app/projects/[id].
export default async function ProjectModalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await getUserId()

  const [projectRes, versionsRes, releaseRes, profileRes] = await Promise.all([
    supabaseAdmin.from('mb_projects').select('*').eq('id', id).eq('user_id', userId).single(),
    supabaseAdmin
      .from('mb_versions')
      .select('*, mb_feedback(*)')
      .eq('project_id', id)
      .order('version_number', { ascending: false }),
    supabaseAdmin
      .from('mb_releases')
      .select('*')
      .eq('project_id', id)
      .maybeSingle(),
    supabaseAdmin.from('profiles').select('is_owner').eq('id', userId).maybeSingle(),
  ])

  if (projectRes.error || !projectRes.data) return null

  // Same shape as the full page: fetched AFTER the ownership gate above, keyed
  // to this project's own versions. Kept in sync so the modal doesn't quietly
  // hide notes the full page shows.
  const versions = versionsRes.data ?? []
  const feedComments = await getFeedCommentsForVersions(versions.map(v => v.id))
  const feedCommentsByVersion: Record<string, FeedComment[]> = {}
  for (const c of feedComments) (feedCommentsByVersion[c.version_id] ??= []).push(c)

  return (
    <ModalShell>
      <ProjectClient
        project={projectRes.data}
        initialVersions={versions}
        initialRelease={releaseRes.data ?? null}
        initialFeedComments={feedCommentsByVersion}
        inModal
        ownerDefaults={profileRes.data?.is_owner === true}
      />
    </ModalShell>
  )
}
