import ShareClient from '@/app/share/[token]/ShareClient'
import type { TrackShareData } from '@/lib/track-share'

// The public single-track player screen, rendered by both of its addresses —
// the canonical /listen/<artist>/<title>/<token> and the original
// /share/<token> that every link ever sent still points at. Pure presentation;
// data loading lives in src/lib/track-share.ts.
export default function TrackShareScreen({ data }: { data: TrackShareData }) {
  const { version, artistName, letteringUrl } = data
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
          <span style={{ color: 'var(--accent)' }}>{artistName}</span>
          {' '}
          <span className="text-white">private</span>
          {' '}
          <span style={{ color: 'var(--text-muted)' }}>share</span>
        </span>
      </header>

      <ShareClient version={version} artistName={artistName} letteringUrl={letteringUrl} />
    </div>
  )
}
