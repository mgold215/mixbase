'use client'

import { useState } from 'react'
import { Usb } from 'lucide-react'

// "Include in THUMB DRIVE" — the switch on each song's page. On puts the song
// in the artist's THUMB DRIVE (their auto-filled "all my songs" playlist, at
// the top); off takes it out, and it stays out — later mixes don't add it back.
// Same route as the app: PUT /api/projects/[id]/thumb-drive.
//
// The page renders this with key={String(initialIncluded)}, so when the server
// value changes under it (a first mix uploaded here adds the song) the switch
// remounts with the new truth instead of holding a stale local copy.

type Props = {
  projectId: string
  initialIncluded: boolean
  /** The song has at least one uploaded mix (without one there's nothing to play yet). */
  hasMix: boolean
}

export default function ThumbDriveToggle({ projectId, initialIncluded, hasMix }: Props) {
  const [included, setIncluded] = useState(initialIncluded)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Optimistic, reverted on any failure — the switch must never show the
  // opposite of what's in the database, because THUMB DRIVE is shared by link.
  async function toggle() {
    if (saving) return
    const next = !included
    setIncluded(next)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/thumb-drive`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ included: next }),
      })
      if (!res.ok) {
        setIncluded(!next)
        setError("Couldn't update THUMB DRIVE — try again.")
      }
    } catch {
      setIncluded(!next)
      setError("Couldn't update THUMB DRIVE — check your connection.")
    } finally {
      setSaving(false)
    }
  }

  const hint = included
    ? 'In your THUMB DRIVE — switch off to remove it'
    : hasMix
      ? 'Not in your THUMB DRIVE — switch on to add it'
      : 'Joins your THUMB DRIVE automatically when its first mix is uploaded'

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={included}
        aria-label="Include in THUMB DRIVE"
        onClick={toggle}
        disabled={saving}
        title={hint}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-60"
        style={included
          ? { backgroundColor: 'var(--surface)', color: 'var(--accent)', border: '1px solid var(--accent)' }
          : { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }
        }
      >
        <Usb size={14} />
        <span>THUMB DRIVE</span>
        {/* The switch itself */}
        <span
          aria-hidden="true"
          className="relative inline-block w-7 h-4 rounded-full transition-colors"
          style={{ backgroundColor: included ? 'var(--accent)' : 'var(--surface-3)' }}
        >
          <span
            className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all"
            style={{ left: included ? 14 : 2 }}
          />
        </span>
      </button>
      {!included && !hasMix && !error && (
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Joins with its first mix</span>
      )}
      {error && <span className="text-[11px] text-red-400" role="alert">{error}</span>}
    </div>
  )
}
