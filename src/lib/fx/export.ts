// Full-resolution export path: frame-by-frame WebCodecs H.264 encode with
// explicit timestamps, muxed to a faststart MP4 by mediabunny (MPL-2.0,
// unmodified dependency, dynamically imported so it never touches other
// pages' bundles).
//
// Why this replaces realtime MediaRecorder capture as the primary path:
//  - We set every frame's timestamp ourselves (frame / fps), so the output has
//    EXACTLY N frames at exact positions — no wall clock, no dropped or
//    duplicated frames, and therefore a mathematically seamless loop even on a
//    slow machine.
//  - Hardware H.264 encodes faster than realtime — a 6 s clip takes seconds,
//    not 6 s of enforced waiting.
//  - The result is already the shape every surface plays (h264/faststart/mp4),
//    so the server only validates it — no transcode.
// MediaRecorder remains the fallback for browsers without WebCodecs
// (see FreeStudio.tsx).

export type ExportOpts = {
  canvas: HTMLCanvasElement
  // Renders frame f onto the canvas (the same renderer the preview uses).
  drawFrame: (frame: number) => void
  totalFrames: number
  fps: number
  isCancelled: () => boolean
  onProgress: (pct: number) => void
}

// ~0.15 bits per pixel per frame: 1080×1920@30 ≈ 9.3 Mbps, 4K@30 ≈ 37 Mbps.
// Clamped to sane bounds; hardware encoders treat this as a target, not a law.
export function pickBitrate(width: number, height: number, fps = 30): number {
  const raw = width * height * fps * 0.15
  return Math.round(Math.min(45_000_000, Math.max(6_000_000, raw)))
}

// True when this browser can hardware-encode H.264 at the given dimensions.
// Checked per resolution because 4K needs a higher codec level than 1080p.
export async function canExportMp4(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false
  try {
    const { canEncodeVideo } = await import('mediabunny')
    return await canEncodeVideo('avc', { width, height, bitrate: pickBitrate(width, height) })
  } catch {
    return false
  }
}

// Encode the loop to an MP4 blob. Returns null on a deliberate cancel.
// Throws on encoder/mux failure — the caller decides the fallback.
export async function exportMp4(opts: ExportOpts): Promise<Blob | null> {
  const { canvas, drawFrame, totalFrames, fps, isCancelled, onProgress } = opts
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource } = await import('mediabunny')

  const target = new BufferTarget()
  const output = new Output({
    // in-memory faststart puts the moov atom first — required by the finalize
    // route's head-of-file validation and instant playback start everywhere.
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: pickBitrate(canvas.width, canvas.height, fps),
    keyFrameInterval: 2,
  })
  output.addVideoTrack(source)
  await output.start()

  try {
    const dt = 1 / fps
    for (let frame = 0; frame < totalFrames; frame++) {
      if (isCancelled()) {
        await output.cancel()
        return null
      }
      drawFrame(frame)
      // add() awaits encoder + writer backpressure internally, so this loop
      // can't outrun the hardware; the timestamp is the frame grid, not time.
      await source.add(frame * dt, dt)
      onProgress(Math.round((frame / totalFrames) * 100))
      // Yield to the event loop periodically so progress paints and the tab
      // stays responsive during the (brief) encode burst.
      if (frame % 8 === 7) await new Promise(r => setTimeout(r, 0))
    }
    source.close()
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  }

  if (!target.buffer) throw new Error('mux produced no output')
  return new Blob([target.buffer], { type: 'video/mp4' })
}
