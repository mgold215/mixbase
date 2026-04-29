'use client'

import { useState } from 'react'
import WaveformPlayer from './WaveformPlayer'
import { StatusBadge } from './StatusBadge'
import { type Version } from '@/lib/supabase'
import { ArrowLeftRight } from 'lucide-react'

type Props = {
  versions: Version[]
}

// A/B comparison: play two versions and switch between them at the same position
export default function ABCompare({ versions }: Props) {
  const [versionA, setVersionA] = useState(versions[0]?.id ?? '')
  const [versionB, setVersionB] = useState(versions[1]?.id ?? '')
  const [syncTime, setSyncTime] = useState<number | undefined>()
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A')

  const verA = versions.find(v => v.id === versionA)
  const verB = versions.find(v => v.id === versionB)

  function handleTimeUpdateA(t: number) {
    if (activeSlot === 'A') setSyncTime(t)
  }

  function handleTimeUpdateB(t: number) {
    if (activeSlot === 'B') setSyncTime(t)
  }

  function swapVersions() {
    const tmp = versionA
    setVersionA(versionB)
    setVersionB(tmp)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>A/B Compare</h3>
        <button
          onClick={swapVersions}
          className="flex items-center gap-1.5 text-xs transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeftRight size={13} />
          Swap
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Version A */}
        <div
          className="rounded-xl p-4 cursor-pointer transition-colors"
          style={{
            backgroundColor: 'var(--surface)',
            border: `1px solid ${activeSlot === 'A' ? 'rgba(45,212,191,0.4)' : 'var(--border)'}`,
          }}
          onClick={() => setActiveSlot('A')}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[#2dd4bf] bg-[#2dd4bf]/10 px-1.5 py-0.5 rounded">A</span>
              <select
                value={versionA}
                onChange={e => setVersionA(e.target.value)}
                onClick={e => e.stopPropagation()}
                className="bg-transparent text-sm focus:outline-none"
                style={{ color: 'var(--text)' }}
              >
                {versions.map(v => (
                  <option key={v.id} value={v.id} style={{ backgroundColor: 'var(--surface)' }}>
                    v{v.version_number}{v.label ? ` — ${v.label}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {verA && <StatusBadge status={verA.status} size="sm" />}
          </div>

          {verA && (
            <WaveformPlayer
              audioUrl={verA.audio_url}
              syncPosition={activeSlot === 'B' ? syncTime : undefined}
              onTimeUpdate={handleTimeUpdateA}
              compact
            />
          )}
        </div>

        {/* Version B */}
        <div
          className="rounded-xl p-4 cursor-pointer transition-colors"
          style={{
            backgroundColor: 'var(--surface)',
            border: `1px solid ${activeSlot === 'B' ? 'rgba(45,212,191,0.4)' : 'var(--border)'}`,
          }}
          onClick={() => setActiveSlot('B')}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded">B</span>
              <select
                value={versionB}
                onChange={e => setVersionB(e.target.value)}
                onClick={e => e.stopPropagation()}
                className="bg-transparent text-sm focus:outline-none"
                style={{ color: 'var(--text)' }}
              >
                {versions.map(v => (
                  <option key={v.id} value={v.id} style={{ backgroundColor: 'var(--surface)' }}>
                    v{v.version_number}{v.label ? ` — ${v.label}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {verB && <StatusBadge status={verB.status} size="sm" />}
          </div>

          {verB && (
            <WaveformPlayer
              audioUrl={verB.audio_url}
              syncPosition={activeSlot === 'A' ? syncTime : undefined}
              onTimeUpdate={handleTimeUpdateB}
              compact
            />
          )}
        </div>
      </div>

      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Click a panel to set it as active. Switching panels keeps the playback position in sync.
      </p>
    </div>
  )
}
