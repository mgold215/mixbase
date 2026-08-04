import type { spawn } from 'child_process'

// The child-process watchdog shared by every ffmpeg/ffprobe spawn in the app.
//
// It lived inside video-render.ts until 2026-08-04, when the WebM→MP4
// visualizer transcode added a fourth spawn site in a different module and
// re-implemented half of it (kill without reject). Extracted here rather than
// imported from video-render.ts because that module pulls in finalize-render →
// `sharp`, a heavyweight native dep the /api/visualizer/save route has no use
// for. Deliberately dependency-free so any module can arm a child cheaply.

// A child that has exited but whose stdio never closed is almost certainly held
// by a surviving descendant. Draining takes milliseconds in practice, so this
// grace is generous.
export const EXIT_DRAIN_GRACE_MS = 30_000

// Node's spawn `timeout` option does fire killSignal at the deadline, but the
// promise here is settled by `close`, which waits for the stdio pipes to drain.
// A process that survives the signal — or that leaves a descendant holding
// stderr — never emits `close`, so the await hangs forever anyway. So we arm our
// OWN timer that SIGKILLs the child AND rejects the promise directly. Settling
// is the part that matters: it's what lets buildFinalVideo's `finally` delete
// the temp dir and lets the job release its concurrency slot. (Rejecting after
// a resolve is a no-op, so the race is harmless.)
// SIGKILL rather than the default SIGTERM: ffmpeg CATCHES SIGTERM and exits 255,
// which is indistinguishable from a genuine encode failure — and a truly wedged
// ffmpeg may never process it at all, which is precisely the case we are
// defending against.
//
// Returns `touch()`, which resets the idle timer; callers call it whenever the
// child reports progress. Pass idleMs <= 0 for a hard deadline only.
export function armDeadline(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
  idleMs: number,
  label: string,
  reject: (err: Error) => void,
): () => void {
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const fail = (message: string) => {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
    reject(new Error(message))
  }
  const hard = setTimeout(
    () => fail(`${label} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`),
    timeoutMs,
  )
  hard.unref?.()
  const touch = () => {
    if (idleMs <= 0 || closed) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => fail(`${label} stopped reporting progress for ${Math.round(idleMs / 1000)}s and was killed`),
      idleMs,
    )
    idleTimer.unref?.()
  }
  touch()

  const clearAll = () => { clearTimeout(hard); clearTimeout(idleTimer); clearTimeout(drainTimer) }
  proc.on('close', () => { closed = true; clearAll() })
  proc.on('error', () => { closed = true; clearAll() })
  proc.on('exit', () => {
    // `exit` means the child itself is gone; callers settle on `close`, which
    // additionally waits for the stdio pipes to drain. A surviving descendant
    // holding stderr can withhold `close` indefinitely — the exact hang this
    // watchdog exists to bound — so don't simply stand down here. Draining after
    // the child is gone takes milliseconds, so give it a short grace and then
    // settle anyway. (ffmpeg/ffprobe don't fork, so this is belt-and-braces.)
    clearTimeout(hard)
    clearTimeout(idleTimer)
    if (closed) return
    drainTimer = setTimeout(
      () => fail(`${label} exited but its output never closed`),
      EXIT_DRAIN_GRACE_MS,
    )
    drainTimer.unref?.()
  })
  return touch
}
