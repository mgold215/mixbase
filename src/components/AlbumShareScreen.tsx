import AlbumPlayer from '@/components/AlbumPlayer'
import type { AlbumShareData } from '@/lib/album-share'

// The public album/collection player screen, rendered by the canonical
// /album/<artist>/<title>/<token> route (and formerly /share/album/<token>,
// which now redirects there). Pure presentation — data loading lives in
// src/lib/album-share.ts.
export default function AlbumShareScreen({ data }: { data: AlbumShareData }) {
  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header — matches the single-track share page */}
      <header
        className="relative z-50 flex-shrink-0 h-12 border-b flex items-center px-5"
        style={{ backgroundColor: 'var(--nav-bg)', borderColor: 'var(--border)' }}
      >
        <span className="font-[family-name:var(--font-jost)] flex items-baseline gap-0">
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--text)' }}>mix</span>
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--accent)' }}>BASE</span>
        </span>

        <span className="ml-auto text-[13px] font-[family-name:var(--font-jost)] tracking-wide">
          <span style={{ color: 'var(--accent)' }}>{data.artistName}</span>
          {' '}
          <span className="text-white">{data.typeLabel.toLowerCase()}</span>
          {' '}
          <span style={{ color: 'var(--text-muted)' }}>share</span>
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
      />
    </div>
  )
}
