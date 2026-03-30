import { supabaseAdmin } from '@/lib/supabase'
import Nav from '@/components/Nav'
import FeedClient from './FeedClient'

export const dynamic = 'force-dynamic'

export default async function FeedPage() {
  const { data: versions } = await supabaseAdmin
    .from('mf_versions')
    .select(`
      id, version_number, label, audio_url, audio_filename,
      duration_seconds, status, feedback_context, created_at,
      mf_projects ( id, title, artwork_url, genre, bpm ),
      mf_feedback ( id, producer_handle, tags, comment, rating, timestamp_seconds, created_at, is_community )
    `)
    .eq('open_for_feedback', true)
    .order('created_at', { ascending: false })

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <FeedClient initialVersions={(versions ?? []) as any} />
      </div>
    </div>
  )
}
