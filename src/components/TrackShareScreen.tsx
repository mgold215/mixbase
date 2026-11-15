import ShareClient from '@/app/share/[token]/ShareClient'
import type { TrackShareData } from '@/lib/track-share'

// The public single-track player screen, rendered by both of its addresses —
// the canonical /listen/<artist>/<title>/<token> and the original
// /share/<token> that every link ever sent still points at. Pure presentation;
// data loading lives in src/lib/track-share.ts.
export default function TrackShareScreen({ data }: { data: TrackShareData }) {
  const { version, artistName, letteringUrl } = data
  return (
    <div className="share-screen relative bg-black flex flex-col">
      {/* Header — floats over the player's backdrop (which runs to the top of
          the screen), a soft shade behind it instead of a solid bar. The page
          is always dark, whatever theme the visitor uses in the app. */}
      <header className="share-header absolute inset-x-0 top-0 z-50 h-12 flex items-center px-5">
        {/* Logo — same lettering as Nav */}
        <span className="font-[family-name:var(--font-jost)] flex items-baseline gap-0">
          <span className="text-[15px] font-bold tracking-[0.04em] text-white">mix</span>
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: '#2dd4bf' }}>BASE</span>
        </span>

        {/* Right-side label — pushed to the far right */}
        <span className="ml-auto text-[13px] font-[family-name:var(--font-jost)] tracking-wide">
          <span style={{ color: '#2dd4bf' }}>{artistName}</span>
          {' '}
          <span className="text-white">private</span>
          {' '}
          <span className="text-white/50">share</span>
        </span>
      </header>

      <ShareClient version={version} artistName={artistName} letteringUrl={letteringUrl} />
    </div>
  )
}
