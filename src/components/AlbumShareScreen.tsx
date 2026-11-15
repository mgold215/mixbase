import AlbumPlayer from '@/components/AlbumPlayer'
import type { AlbumShareData } from '@/lib/album-share'

// The public album/collection player screen, rendered by the canonical
// /album/<artist>/<title>/<token> route (and formerly /share/album/<token>,
// which now redirects there). Pure presentation — data loading lives in
// src/lib/album-share.ts.
export default function AlbumShareScreen({ data }: { data: AlbumShareData }) {
  return (
    <div className="share-screen relative bg-black flex flex-col">
      {/* Header — matches the single-track share page: it floats over the
          backdrop, so the picture runs to the top of the screen */}
      <header className="share-header absolute inset-x-0 top-0 z-50 h-12 flex items-center px-5">
        <span className="font-[family-name:var(--font-jost)] flex items-baseline gap-0">
          <span className="text-[15px] font-bold tracking-[0.04em] text-white">mix</span>
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: '#2dd4bf' }}>BASE</span>
        </span>

        <span className="ml-auto text-[13px] font-[family-name:var(--font-jost)] tracking-wide">
          <span style={{ color: '#2dd4bf' }}>{data.artistName}</span>
          {' '}
          <span className="text-white">{data.typeLabel.toLowerCase()}</span>
          {' '}
          <span className="text-white/50">share</span>
        </span>
      </header>

      <AlbumPlayer
        title={data.title}
        typeLabel={data.typeLabel}
        coverUrl={data.coverUrl}
        artistName={data.artistName}
        tracks={data.tracks}
        sourceId="album-share-player"
        footnote="Shared privately via mixBASE"
        underHeader
      />
    </div>
  )
}
