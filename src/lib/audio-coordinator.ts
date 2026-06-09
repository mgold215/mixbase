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
