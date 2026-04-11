'use client'

import dynamic from 'next/dynamic'
import FeedbackForm from '@/components/FeedbackForm'
import type { Version } from '@/lib/supabase'
import { audioProxyUrl } from '@/lib/supabase'

const WaveformPlayer = dynamic(() => import('@/components/WaveformPlayer'), { ssr: false })

type Props = {
  version: Version & { mb_projects: { title: string; artwork_url: string | null } | null }
}

export default function ShareClient({ version }: Props) {
  return (
    <div className="space-y-8">
      {/* Waveform player */}
      <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl p-5">
        <WaveformPlayer
          audioUrl={audioProxyUrl(version.audio_url)}
          allowDownload={version.allow_download}
          filename={version.audio_filename ?? undefined}
        />
      </div>

      {/* Public notes from artist */}
      {version.public_notes && (
        <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl p-5">
          <p className="text-xs text-[#555] mb-2 uppercase tracking-wider">Notes from the artist</p>
          <p className="text-sm text-[#888] leading-relaxed">{version.public_notes}</p>
        </div>
      )}

      {/* Feedback form */}
      <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl p-5">
        <FeedbackForm versionId={version.id} />
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-[#2a2a2a]">
        This is a private link. Please don't share it publicly.
      </p>
    </div>
  )
}
