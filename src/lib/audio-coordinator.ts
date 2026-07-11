// Cross-player coordination — ensures only one audio source plays at a time.
//
// The app has two independent audio elements in the same document: the shared
// PlayerContext element (mini player / full player) and the share page's local
// element. Each announces on its 'play' event and pauses when any other source
// announces. A window CustomEvent needs no context plumbing and covers every
// play path (clicks, media-session, iOS auto-resume retries).

const EVT = 'mixbase:audio-play'
const STOP_EVT = 'mixbase:audio-stop'

export function announcePlay(sourceId: string) {
  window.dispatchEvent(new CustomEvent<string>(EVT, { detail: sourceId }))
}

/** Subscribe `pause` to fire whenever a different source starts playing. Returns unsubscribe. */
export function onOtherSourcePlay(sourceId: string, pause: (otherSourceId: string) => void): () => void {
  const handler = (e: Event) => {
    const other = (e as CustomEvent<string>).detail
    if (other !== sourceId) pause(other)
  }
  window.addEventListener(EVT, handler)
  return () => window.removeEventListener(EVT, handler)
}

/** Announce that a source stopped (pause / ended / unmount) so the UI can react —
 *  e.g. the mini player hides while an in-page album player is the active source
 *  and reappears once it stops. */
export function announceStop(sourceId: string) {
  window.dispatchEvent(new CustomEvent<string>(STOP_EVT, { detail: sourceId }))
}

/** Subscribe to stop announcements from any source. Returns unsubscribe. */
export function onSourceStop(handler: (sourceId: string) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<string>).detail)
  window.addEventListener(STOP_EVT, listener)
  return () => window.removeEventListener(STOP_EVT, listener)
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
