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
      {/* Minimal header */}
      <header className="relative z-50 flex-shrink-0 border-b border-white/5 px-6 py-4 flex items-center justify-between" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
        <span className="text-sm font-bold tracking-tight" style={{ color: 'rgba(255,255,255,0.5)' }}>mixBASE</span>
        <span className="text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>Private share</span>
      </header>

      <ShareClient version={version} />
    </div>
  )
}
