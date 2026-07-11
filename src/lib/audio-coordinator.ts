// Cross-player coordination — ensures only one audio source plays at a time.
//
// The app has two independent audio elements in the same document: the shared
// PlayerContext element (mini player / full player) and the share page's local
// element. Each announces on its 'play' event and pauses when any other source
// announces. A window CustomEvent needs no context plumbing and covers every
// play path (clicks, media-session, iOS auto-resume retries).

const EVT = 'mixbase:audio-play'

export function announcePlay(sourceId: string) {
  window.dispatchEvent(new CustomEvent<string>(EVT, { detail: sourceId }))
}

/** Subscribe `pause` to fire whenever a different source starts playing. Returns unsubscribe. */
export function onOtherSourcePlay(sourceId: string, pause: () => void): () => void {
  const handler = (e: Event) => {
    if ((e as CustomEvent<string>).detail !== sourceId) pause()
  }
  window.addEventListener(EVT, handler)
  return () => window.removeEventListener(EVT, handler)
}

// ── Media-session transport ownership ───────────────────────────────────────
// The lock-screen / Control Center / headphone transport (mediaSession action
// handlers) must belong to whichever player is actively playing, or "next"
// navigates the wrong queue: PlayerContext's app-wide list instead of, say,
// the album player's tracklist. Sources claim ownership on their 'play' event
// and register their own handlers; PlayerContext only (re)registers its
// handlers while it owns the session (or nobody does), so an in-page player's
// claim survives PlayerContext re-renders and track refetches.
let mediaSessionOwner: string | null = null

export function claimMediaSession(sourceId: string) {
  mediaSessionOwner = sourceId
}

/** True while sourceId holds the transport. */
export function ownsMediaSession(sourceId: string): boolean {
  return mediaSessionOwner === sourceId
}

/** Release ownership (e.g. on unmount) so the default player can take over. */
export function releaseMediaSession(sourceId: string) {
  if (mediaSessionOwner === sourceId) mediaSessionOwner = null
}

/** True when sourceId may (re)register handlers: it owns the session or nobody does. */
export function canRegisterMediaSession(sourceId: string): boolean {
  return mediaSessionOwner === null || mediaSessionOwner === sourceId
}
