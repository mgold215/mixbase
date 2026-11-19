'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { audioProxyUrl } from '@/lib/supabase'
import { audioDownloadFileName } from '@/lib/download'
import { formatDuration, type SyncCatalogData, type SyncTrack } from '@/lib/sync-catalog'

// The public sync catalog page (/sync/<token>). Built for a music supervisor
// scanning a pitch: what each track is (BPM, key, genre, length), the full mix
// and the instrumental one tap apart, a download of each, and who to license
// from. One <audio> element plays whichever take is chosen.

type Take = 'full' | 'instrumental'
type Now = { id: string; take: Take } | null

function metaLine(t: SyncTrack): string {
  return [
    t.bpm ? `${t.bpm} BPM` : null,
    t.key,
    t.genre,
    formatDuration(t.duration) || null,
  ].filter(Boolean).join(' · ')
}

export default function SyncCatalog({ data }: { data: SyncCatalogData }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [now, setNow] = useState<Now>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onTime = () => setProgress(a.duration ? a.currentTime / a.duration : 0)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd = () => { setPlaying(false); setProgress(0) }
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onEnd)
    return () => {
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('ended', onEnd)
    }
  }, [])

  function toggle(track: SyncTrack, take: Take) {
    const a = audioRef.current
    if (!a) return
    const url = take === 'instrumental' ? track.instrumentalUrl : track.audioUrl
    if (!url) return
    if (now?.id === track.id && now.take === take) {
      if (a.paused) void a.play().catch(() => {})
      else a.pause()
      return
    }
    // Same song, other take: keep the position so A/B-ing the two is one tap.
    const keepAt = now?.id === track.id ? a.currentTime : 0
    a.src = audioProxyUrl(url)
    setNow({ id: track.id, take })
    setProgress(0)
    const start = () => {
      if (keepAt > 0) a.currentTime = keepAt
      void a.play().catch(() => {})
    }
    if (keepAt > 0) a.addEventListener('loadedmetadata', start, { once: true })
    else start()
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current
    if (!a || !a.duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * a.duration
  }

  const withInstrumental = data.tracks.filter(t => t.instrumentalUrl).length

  return (
    <main className="share-screen bg-[#0b0b0c] text-white">
      <audio ref={audioRef} preload="none" />
      <div className="mx-auto max-w-3xl px-5 pb-24 pt-10 sm:pt-16">
        <header className="flex items-center gap-5">
          {data.coverUrl && (
            <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-white/5 sm:h-28 sm:w-28">
              <Image src={data.coverUrl} alt={data.artistName} fill className="object-cover" unoptimized />
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] text-white/50">Sync catalog</p>
            <h1 className="mt-1 truncate text-3xl font-semibold sm:text-4xl">{data.artistName}</h1>
            <p className="mt-1 text-sm text-white/60">
              {data.tracks.length} {data.tracks.length === 1 ? 'track' : 'tracks'}
              {withInstrumental > 0 ? ` · ${withInstrumental} with instrumental` : ''}
            </p>
          </div>
        </header>

        <section className="mt-8 rounded-xl border border-white/10 bg-white/[0.04] p-4 text-sm leading-relaxed text-white/80">
          <p>
            <span className="font-semibold text-white">One-stop.</span>{' '}
            Master and publishing are both controlled by {data.artistName}: one license covers both sides.
          </p>
          <p className="mt-2 text-white/60">To license a track or ask for stems and edits, reply to the email this link came in.</p>
        </section>

        <ol className="mt-8 divide-y divide-white/10">
          {data.tracks.map((t, i) => {
            const active = now?.id === t.id
            const fullName = audioDownloadFileName(t.audioUrl, `${data.artistName} - ${t.title}`)
            const instName = t.instrumentalUrl
              ? audioDownloadFileName(t.instrumentalUrl, `${data.artistName} - ${t.title} (Instrumental)`)
              : null
            return (
              <li key={t.id} className="py-4">
                <div className="flex items-center gap-4">
                  <span className="w-5 shrink-0 text-right text-sm tabular-nums text-white/40">{i + 1}</span>
                  <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-white/5">
                    {t.artworkUrl && <Image src={t.artworkUrl} alt="" fill className="object-cover" unoptimized />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{t.title}</p>
                    <p className="truncate text-xs text-white/50">{metaLine(t)}</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 pl-9 sm:pl-[4.25rem]">
                  <TakeButton
                    label="Full mix"
                    on={active && now?.take === 'full' && playing}
                    onClick={() => toggle(t, 'full')}
                  />
                  {t.instrumentalUrl && (
                    <TakeButton
                      label="Instrumental"
                      on={active && now?.take === 'instrumental' && playing}
                      onClick={() => toggle(t, 'instrumental')}
                    />
                  )}
                  <a
                    className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:border-white/40 hover:text-white"
                    href={`${audioProxyUrl(t.audioUrl)}?download=1&filename=${encodeURIComponent(fullName)}`}
                    download={fullName}
                  >
                    Download mix
                  </a>
                  {t.instrumentalUrl && instName && (
                    <a
                      className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:border-white/40 hover:text-white"
                      href={`${audioProxyUrl(t.instrumentalUrl)}?download=1&filename=${encodeURIComponent(instName)}`}
                      download={instName}
                    >
                      Download instrumental
                    </a>
                  )}
                </div>

                {active && (
                  <div
                    className="ml-9 mt-3 h-1.5 cursor-pointer rounded-full bg-white/10 sm:ml-[4.25rem]"
                    onClick={seek}
                    role="progressbar"
                    aria-valuenow={Math.round(progress * 100)}
                  >
                    <div className="h-full rounded-full bg-white" style={{ width: `${progress * 100}%` }} />
                  </div>
                )}
              </li>
            )
          })}
        </ol>

        <footer className="mt-12 text-center text-xs text-white/30">Hosted on mixBASE</footer>
      </div>
    </main>
  )
}

function TakeButton({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${on ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
      aria-pressed={on}
    >
      <span aria-hidden>{on ? '❚❚' : '▶'}</span>
      {label}
    </button>
  )
}
