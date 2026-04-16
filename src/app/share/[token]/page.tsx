import { supabaseAdmin } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import ShareClient from './ShareClient'

export const dynamic = 'force-dynamic'

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const { data: version, error } = await supabaseAdmin
    .from('mb_versions')
    .select('*, mb_projects(*)')
    .eq('share_token', token)
    .single()

  if (error || !version) notFound()

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header — matches site nav style */}
      <header
        className="relative z-50 flex-shrink-0 h-12 border-b flex items-center px-5"
        style={{ backgroundColor: 'var(--nav-bg)', borderColor: 'var(--border)' }}
      >
        {/* Logo — same markup as Nav */}
        <span className="font-[family-name:var(--font-jost)] flex items-baseline gap-0">
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--text)' }}>mix</span>
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--accent)' }}>BASE</span>
        </span>

        {/* Right-side label — pushed to the far right */}
        <span className="ml-auto text-[13px] font-[family-name:var(--font-jost)] tracking-wide">
          <span style={{ color: 'var(--accent)' }}>moodmixformat</span>
          {' '}
          <span className="text-white">private</span>
          {' '}
          <span style={{ color: 'var(--text-muted)' }}>share</span>
        </span>
      </header>

      <ShareClient version={version} />
    </div>
  )
}
