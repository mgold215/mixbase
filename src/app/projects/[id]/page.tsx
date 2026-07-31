import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import { getFeedCommentsForVersions, type FeedComment } from '@/lib/feed'
import ProjectClient from './ProjectClient'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
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

  if (projectRes.error || !projectRes.data) notFound()

  // Feed comments are fetched SEQUENTIALLY, after the ownership gate above, on
  // purpose: notFound() throws, so this never runs for a non-owner. Adding it
  // to the Promise.all would read another artist's comments for a caller we
  // have not yet authorized — which is the exact shape of the earlier
  // share-page leak. The id list comes from versionsRes (already scoped to this
  // project), never from anything client-supplied.
  //
  // getFeedCommentsForVersions is total, so this await cannot 500 the page.
  const versions = versionsRes.data ?? []
  const feedComments = await getFeedCommentsForVersions(versions.map(v => v.id))

  const feedCommentsByVersion: Record<string, FeedComment[]> = {}
  for (const c of feedComments) (feedCommentsByVersion[c.version_id] ??= []).push(c)

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <ProjectClient
        project={projectRes.data}
        initialVersions={versions}
        initialRelease={releaseRes.data ?? null}
        initialFeedComments={feedCommentsByVersion}
        ownerDefaults={profileRes.data?.is_owner === true}
      />
    </div>
  )
}
