'use client'

import { useEffect, useState } from 'react'

// The signed-in artist's public name, for the share links the web app copies:
// mixbase.app/listen/<artist>/<title>/<token> reads better in a chat than a
// bare token. One GET /api/auth/me per page load, shared by every caller on
// the page (Nav already makes the same call for the greeting). Until it
// answers — or if it never does — callers get null and trackShareUrl still
// builds a link that works (the server upgrades it to the pretty address).
let cached: Promise<string | null> | null = null

function load(): Promise<string | null> {
  if (!cached) {
    cached = fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => (typeof d?.artist_name === 'string' && d.artist_name.trim() ? d.artist_name.trim() : null))
      .catch(() => null)
  }
  return cached
}

export function useArtistName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    load().then(n => { if (alive) setName(n) })
    return () => { alive = false }
  }, [])
  return name
}
