'use client'

import { useState, useRef, useEffect, type ChangeEvent, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { usePlayer } from '@/contexts/PlayerContext'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { StatusBadge, StatusPipeline } from '@/components/StatusBadge'
import ArtworkGenerator from '@/components/ArtworkGenerator'
import MasterCheck, { writeLoudnessCache } from '@/components/MasterCheck'
import { formatDuration, formatFileSize, STATUSES, STATUS_CONFIG, audioProxyUrl, type Project, type Version, type Feedback } from '@/lib/supabase'
import { normalizeStatus, versionDisplayLabel, versionKind, type MixStatus } from '@/lib/mix-status'
import { loudnessFromRow, type LoudnessInput, type VersionLoudnessRow } from '@/lib/loudness-compare'
import { measureLoudness, canMeasureInBrowser, type LoudnessMeasurement } from '@/lib/loudness'
import {
  AUTO_MEASURE_MAX_FILE_BYTES, autoMeasureProbeFrames, fitsAutoMeasureBudget, canAttemptAutoMeasure,
} from '@/lib/loudness-auto'
import { trackShareUrl } from '@/lib/share-url'
import { formatReleaseDate } from '@/lib/release-plan'
import { buildPunchList, buildSummaryExport, buildMixReport } from '@/lib/punch-list'
import { analyzeFile } from '@/lib/audio-analysis'
import { copyToClipboard } from '@/lib/clipboard'
import type { FeedComment } from '@/lib/feed'
import {
  ArrowLeft, Plus, Share2, Check, MessageSquare, Star, Trash2, Upload, Pencil, CalendarRange, ExternalLink, Play, Pause, Download,
  Sparkles, History, X, ClipboardList, Copy, FileText, Mic,
} from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import AddToCollectionButton from '@/components/AddToCollectionButton'
import type { Release } from '@/lib/supabase'

const CHECKLIST_ITEMS = [
  { key: 'mixing_done' as const,       label: 'Mixing done' },
  { key: 'mastering_done' as const,    label: 'Mastering done' },
  { key: 'artwork_ready' as const,     label: 'Artwork ready' },
  { key: 'dsp_submitted' as const,     label: 'DSP submitted' },
  { key: 'social_posts_done' as const, label: 'Social posts scheduled' },
  { key: 'press_release_done' as const,label: 'Press release done' },
]

const Visualizer = dynamic(() => import('@/components/Visualizer'), { ssr: false })
const VideoFinalizer = dynamic(() => import('@/components/VideoFinalizer'), { ssr: false })

type VersionWithFeedback = Version & { mb_feedback: Feedback[] }

// ─── Auto-measure loudness after an upload ───────────────────────────────────
// Measuring a mix has always been possible (MasterCheck's "Measure loudness"
// button), but it costs a full RE-DOWNLOAD: the button fetches the track back
// out of Supabase storage purely to decode it. At the end of an upload the
// browser is still holding the local `File`, so the same measurement is
// available without the round trip. That saving — not "free CPU" — is the whole
// justification for doing this automatically.
//
// Everything here is at module scope and takes only what it needs. It captures
// no component state and returns nothing to the upload flow, so there is no way
// for it to interfere with the upload that triggered it.

/**
 * Decode the just-uploaded file and measure it — but only if this device can do
 * so cheaply. Returns null for every "not worth it" and every failure, which
 * the caller treats identically: no number, no error, nothing said.
 *
 * Three gates, cheapest first:
 *   1. File bytes, before anything is read into memory.
 *   2. Decoded memory — the same `canMeasureInBrowser` ceiling the manual
 *      button uses, computed from the exact decoded shape.
 *   3. Measured time on THIS device, via a short timing probe.
 */
async function measureUploadedFile(file: File): Promise<LoudnessMeasurement | null> {
  // Gate 1. Bounds the arrayBuffer() allocation before it happens — a 2 GB
  // upload (the app's ceiling) must never be pulled into memory by a background
  // task nobody asked for. Checked here as well as in the conjunction below,
  // because the conjunction can only run once the bytes are already read.
  if (file.size > AUTO_MEASURE_MAX_FILE_BYTES) return null

  let ctx: AudioContext | null = null
  try {
    const bytes = await file.arrayBuffer()
    ctx = new AudioContext()
    const decoded = await ctx.decodeAudioData(bytes)

    // Gate 2. Exact sample count and channel layout in hand — refuse before
    // allocating the filter working set rather than during it. Note this is
    // derived from the DECODED audio, never from `duration_seconds`, which is
    // null on 141 of 357 production rows (every iOS upload). A compressed file
    // is exactly why the byte cap above is not sufficient on its own.
    if (!canAttemptAutoMeasure(file.size, decoded.length, decoded.numberOfChannels, canMeasureInBrowser)) return null

    const channels: Float32Array[] = []
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c))

    // Gate 3. Time a short prefix to learn what this device costs per sample,
    // then extrapolate. The probe's LOUDNESS is discarded and never shown — a
    // prefix of a mix with a quiet intro reads nothing like the mix (that false
    // premise is what got this feature deferred once already). It is a
    // stopwatch, nothing more.
    const probeFrames = autoMeasureProbeFrames(decoded.sampleRate, decoded.length)
    if (probeFrames <= 0) return null
    const probeStart = performance.now()
    measureLoudness(channels.map(ch => ch.subarray(0, probeFrames)), decoded.sampleRate)
    const probeMs = performance.now() - probeStart
    if (!fitsAutoMeasureBudget(probeMs, probeFrames, decoded.length)) return null

    return measureLoudness(channels, decoded.sampleRate)
  } catch {
    // Unsupported codec, a decode failure, an AudioContext the browser refused,
    // out of memory — all the same answer. The mix uploaded fine; it simply has
    // no measurement yet, and the manual button still works.
    return null
  } finally {
    // Free the decoder — a lingering context competes with playback. Wrapped
    // rather than `.catch()`-ed: older WebKit returns undefined from close()
    // instead of a promise, and a TypeError thrown from a `finally` would
    // replace the value being returned. The caller swallows it either way, but
    // this keeps the "cannot fail" guarantee where this function states it.
    try { await ctx?.close() } catch { /* already closed, or no promise */ }
  }
}

/**
 * Fire-and-forget the measurement once the version row exists.
 *
 * STRUCTURALLY UNABLE TO AFFECT THE UPLOAD. It is called after the upload has
 * already reported success, it is not awaited, it returns void rather than a
 * promise anyone could accidentally await, and every stage inside it swallows
 * its own failures. The upload path cannot observe this running, finishing, or
 * failing.
 *
 * Deferred to idle so the decode never competes with the render that just
 * added the new mix to the page. `requestIdleCallback` carries a timeout so a
 * permanently busy tab still gets its measurement instead of silently never
 * measuring; browsers without it (older Safari) fall back to a plain delay.
 */
// Serializes auto-measures. Each one is allowed up to the `canMeasureInBrowser`
// ceiling on its own; two uploaded back to back could otherwise decode at the
// same time and double that, which is exactly the peak the gate exists to cap.
// A tail-chained promise keeps them one at a time without dropping any, and a
// rejection can never poison the chain because the body below never rejects.
let autoMeasureChain: Promise<void> = Promise.resolve()

function scheduleAutoMeasure(
  file: File,
  versionId: string,
  onSaved: (row: VersionLoudnessRow) => void,
): void {
  const run = () => {
    autoMeasureChain = autoMeasureChain.then(async () => {
      try {
        const m = await measureUploadedFile(file)
        if (!m) return

        // Cache FIRST, then persist. If the POST fails (offline, rate limited,
        // or migration 032 still unapplied and its runtime heal not yet won),
        // the number survives locally and MasterCheck's existing backfill
        // pushes it up on the next mount. No retry logic needed here.
        writeLoudnessCache(versionId, m)

        // The existing hardened route — rate limited, range validated, server
        // clock, and already carrying the missing-column heal for 032. This is
        // deliberately the SAME door the manual button uses; a second write
        // path would be a second thing to keep honest.
        const res = await fetch(`/api/versions/${versionId}/loudness`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(m),
        })
        if (!res.ok) return
        const data = await res.json().catch(() => null)
        if (data?.version) onSaved(data.version as VersionLoudnessRow)
      } catch {
        // Nothing to report. The upload succeeded; this did not happen.
      }
    })
  }

  try {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 15_000 })
    else setTimeout(run, 1_200)
  } catch {
    // Even the scheduling is guarded — this must never throw into the caller.
  }
}

type Props = {
  project: Project
  initialVersions: VersionWithFeedback[]
  initialRelease: Release | null
  /** Comments other artists left in the community feed, keyed by version id.
   *  Server-loaded for EVERY version of this project, not just the current mix. */
  initialFeedComments?: Record<string, FeedComment[]>
  inModal?: boolean
  /** Owner account only — pre-fills the artwork generator's house-style prompt */
  ownerDefaults?: boolean
}

export default function ProjectClient({ project, initialVersions, initialRelease, initialFeedComments = {}, inModal = false, ownerDefaults = false }: Props) {
  const [versions, setVersions] = useState(initialVersions)
  const [artwork, setArtwork] = useState(project.artwork_url)
  const [finalizedArtwork, setFinalizedArtwork] = useState(project.finalized_artwork_url)
  // ?? null: prod rows can predate the 015/020 migrations (columns self-heal on first write)
  const [visualizer, setVisualizer] = useState(project.visualizer_url ?? null)
  const [visualizerWide, setVisualizerWide] = useState(project.visualizer_wide_url ?? null)
  // Acapella slot (migration 035) — same optional shape as the pins.
  const [acapella, setAcapella] = useState(project.acapella_url ?? null)
  const [acapellaUploading, setAcapellaUploading] = useState(false)
  const [acapellaPct, setAcapellaPct] = useState(0)
  const [acapellaStatus, setAcapellaStatus] = useState('')
  const acapellaInputRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadStatus, setUploadStatus] = useState('')
  const [savedNoteKey, setSavedNoteKey] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [editingProject, setEditingProject] = useState(false)
  const [projectForm, setProjectForm] = useState({
    title: project.title,
    genre: project.genre ?? '',
    bpm: project.bpm?.toString() ?? '',
    key_signature: project.key_signature ?? '',
  })
  const [projectSaved, setProjectSaved] = useState(false)
  const [release, setRelease] = useState<Release | null>(initialRelease)
  const [startingRelease, setStartingRelease] = useState(false)
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [summaryLoading, setSummaryLoading] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<Record<string, string>>({})
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [deletingProject, setDeletingProject] = useState(false)
  // Transient error toast so failed mutations surface instead of silently
  // no-op'ing and leaving the UI out of sync with the DB.
  const [actionError, setActionError] = useState<string | null>(null)
  function flashError(msg: string) {
    setActionError(msg)
    setTimeout(() => setActionError(null), 4000)
  }
  const router = useRouter()

  // Deliberately NOT pulled from the context: ensureAudioChain / setEQGains.
  // ensureAudioChain calls createMediaElementSource on the app's one <audio>
  // element, which is irreversible for the page session and whose failure mode
  // is silence everywhere. Nothing on this page needs an EQ.
  const { playUrl, currentUrl, currentTime, duration, isPlaying, seek, togglePlay, pause, refreshTracks, registerUnmeasuredVersions } = usePlayer()

  // ── Self-healing duration backfill ─────────────────────────────────────────
  // 40% of mb_versions rows have duration_seconds NULL, and the consequences are
  // all over this page: the header omits the length, feedback markers can't be
  // placed on the scrubber, and the archived list falls back to a live readout.
  //
  // This page is the only surface holding the FULL version list — current mix
  // AND every archived mix — next to each row's stored value, so it is what
  // knows which mixes are worth measuring. It does not do the measuring: the
  // engine owns the one <audio> element, reads the length off the element
  // itself, and writes it back once. Splitting it that way is what keeps the
  // healing correct (no React state, which can lag or hold Infinity, in the
  // path) and unduplicated (one writer for every playback surface).
  //
  // Registration is not gated on playback. Registering a mix costs a Map entry;
  // the write only ever happens if the user actually plays it.
  useEffect(() => {
    const unmeasured = versions
      .filter(v => v.duration_seconds == null)
      .map(v => ({ versionId: v.id, url: audioProxyUrl(v.audio_url) }))
    if (unmeasured.length > 0) registerUnmeasuredVersions(unmeasured)
  }, [versions, registerUnmeasuredVersions])

  // Push edits to the rest of the app: the player's client-side track list
  // (refreshTracks) and the server-rendered pages cached by the router —
  // dashboard stage chips, pipeline, the dashboard visible under the modal.
  function syncAfterMutation() {
    refreshTracks()
    router.refresh()
  }

  function handleArtworkUpdated(url: string) {
    setArtwork(url)
    syncAfterMutation()
  }

  function handleFinalizedUpdated(url: string | null) {
    setFinalizedArtwork(url)
    syncAfterMutation()
  }

  function handleVisualizerUpdated(url: string | null) {
    setVisualizer(url)
    syncAfterMutation()
  }

  function handleWideVisualizerUpdated(url: string | null) {
    setVisualizerWide(url)
    syncAfterMutation()
  }

  // ?v=<version_id> — set by a notification link so the page can open the note
  // that was clicked.
  //
  // useSearchParams, NOT a useState initializer reading window.location: the
  // bell is rendered ON this page, so the most likely click is a notification
  // for the project already open. That is a search-params-only navigation,
  // which does not remount this component — an initializer would never re-run
  // and the deep link would silently do nothing in exactly its commonest case.
  // Reading the hook also keeps server and client renders in agreement (the
  // page is force-dynamic), instead of rendering collapsed on the server and
  // expanded on the client.
  //
  // Validated as a UUID before use: the value is URL-supplied, and it is only
  // ever compared against version ids we already loaded — never interpolated
  // into a CSS selector or a redirect, both of which would turn a crafted
  // value into a thrown SyntaxError or an open redirect.
  const rawHighlight = useSearchParams().get('v')
  const highlightVersionId =
    rawHighlight && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawHighlight)
      ? rawHighlight
      : null

  // Tab state — persists in URL hash
  const [activeTab, setActiveTab] = useState<'versions' | 'artwork' | 'visualizer' | 'video'>(() => {
    if (typeof window === 'undefined') return 'versions'
    const hash = window.location.hash.replace('#', '')
    if (hash === 'artwork' || hash === 'visualizer' || hash === 'video') return hash
    return 'versions'
  })

  function switchTab(tab: 'versions' | 'artwork' | 'visualizer' | 'video') {
    setActiveTab(tab)
    if (typeof window !== 'undefined') {
      history.replaceState(null, '', `#${tab}`)
    }
  }

  const projectStatus = versions.reduce<MixStatus>((best, v) => {
    const candidate = normalizeStatus(v.status)
    return STATUS_CONFIG[candidate].step > STATUS_CONFIG[best].step ? candidate : best
  }, 'Mix')

  async function copyShareLink() {
    if (!project.share_token) return
    const url = trackShareUrl(project.share_token)
    // copyToClipboard tries the async API then a hidden-textarea fallback, so we
    // only flash "Copied!" when the text actually made it to the clipboard.
    if (await copyToClipboard(url)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      flashError('Could not copy the link — long-press to copy it manually.')
    }
  }

  async function deleteProject() {
    if (!confirm('Delete this project and all its mixes? This cannot be undone.')) return
    setDeletingProject(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
      if (res.ok) {
        refreshTracks()
        if (inModal) router.back()
        else router.push('/dashboard')
        router.refresh()
      } else {
        setDeletingProject(false)
        flashError('Could not delete the project — please try again.')
      }
    } catch {
      setDeletingProject(false)
      flashError('Could not delete the project — check your connection.')
    }
  }

  async function updateStatus(versionId: string, newStatus: Version['status']) {
    const prevStatus = versions.find(v => v.id === versionId)?.status
    // Optimistic — revert on failure so the badge can't lie about the DB.
    setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: newStatus } : v))
    try {
      const res = await fetch(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        syncAfterMutation()
      } else {
        if (prevStatus) setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: prevStatus } : v))
        flashError('Could not update the status — reverted.')
      }
    } catch {
      if (prevStatus) setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: prevStatus } : v))
      flashError('Could not update the status — check your connection.')
    }
  }

  async function updateNotes(versionId: string, field: 'private_notes' | 'public_notes', value: string) {
    try {
      const res = await fetch(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (res.ok) {
        const key = `${versionId}-${field}`
        setSavedNoteKey(key)
        setTimeout(() => setSavedNoteKey(null), 2000)
      } else {
        flashError('Notes did not save — please retry before leaving the page.')
      }
    } catch {
      flashError('Notes did not save — check your connection and retry.')
    }
  }

  // Per-mix opt-in that puts a "Download" button on the public share page, so
  // the people you send the link to can grab the full-quality original.
  // Optimistic, then reconciled against the server exactly like updateStatus:
  // this switch states what the artist is offering the public, so it must never
  // end up showing the opposite of what the DB holds. Reverting to `!allow`
  // rather than the captured previous value did exactly that when a failed
  // request settled after a successful one, and without syncAfterMutation()
  // nothing ever corrected it.
  async function updateAllowDownload(versionId: string, allow: boolean) {
    const prevAllow = versions.find(v => v.id === versionId)?.allow_download ?? false
    setVersions(prev => prev.map(v => v.id === versionId ? { ...v, allow_download: allow } : v))
    const revert = () =>
      setVersions(prev => prev.map(v => v.id === versionId ? { ...v, allow_download: prevAllow } : v))
    try {
      const res = await fetch(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_download: allow }),
      })
      if (res.ok) {
        syncAfterMutation()
      } else {
        revert()
        flashError('Could not change the download setting — reverted.')
      }
    } catch {
      revert()
      flashError('Could not change the download setting — check your connection.')
    }
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (fileInputRef.current) fileInputRef.current.value = ''

    analyzeFile(file).then(result => {
      if (result) {
        setProjectForm(p => ({
          ...p,
          bpm: p.bpm || result.bpm.toString(),
          key_signature: p.key_signature || result.key,
        }))
      }
    })

    await handleUpload(file)
  }

  // TUS chunked upload for large files (bypasses Supabase's non-resumable size limit)
  async function tusUpload(file: File, filename: string, contentType: string, onPct: (pct: number) => void): Promise<{ ok: boolean; error?: string }> {
    const { Upload } = await import('tus-js-client')
    const bucketName = 'mf-audio'
    return new Promise((resolve) => {
      const upload = new Upload(file, {
        endpoint: '/api/tus',
        chunkSize: 8 * 1024 * 1024, // 8 MB — under Railway's 10 MB wall
        retryDelays: [0, 1000, 3000, 5000],
        // Without this, a fingerprint is never stored and findPreviousUploads()
        // below can never match — resume is opt-in in tus-js-client.
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        metadata: {
          bucketName,
          objectName: filename,
          contentType,
          cacheControl: '3600',
        },
        headers: { 'x-upsert': 'true' },
        onProgress: (bytesUploaded, bytesTotal) => {
          onPct(Math.round((bytesUploaded / bytesTotal) * 80))
        },
        onSuccess: () => resolve({ ok: true }),
        onError: (err) => resolve({ ok: false, error: err.message }),
      })

      // Actually resume. The retryDelays ladder above only covers ~9 seconds
      // within one session; anything longer (a tunnel, a backgrounded tab that
      // Safari discards) fell back to restarting a multi-gigabyte upload from
      // byte 0. The server side has always been resume-capable — HEAD returns
      // the offset with Cache-Control: no-store — it was simply never asked.
      // Failing to look up a previous upload must not block a fresh one.
      upload.findPreviousUploads()
        .then(previous => { if (previous.length) upload.resumeFromPreviousUpload(previous[0]) })
        .catch(() => {})
        .then(() => upload.start())
    })
  }

  // Bytes → mf-audio under `filename`: signed URL ≤ 50 MB (direct to Supabase,
  // no Railway in the byte path), TUS chunked above, 413 auto-fallback to TUS.
  // Shared by the mix upload and the acapella slot so the byte-path rules live
  // in exactly one place.
  async function uploadAudioToStorage(
    file: File,
    filename: string,
    contentType: string,
    onPct: (pct: number) => void,
    onStatus: (status: string) => void,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const publicUrl = () => {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'
      return `${supabaseUrl}/storage/v1/object/public/mf-audio/${filename}`
    }

    // Files > 50MB use TUS chunked upload (bypasses Supabase non-resumable size limit)
    if (file.size > 50 * 1024 * 1024) {
      onStatus('Uploading (chunked)...')
      const tusResult = await tusUpload(file, filename, contentType, onPct)
      if (!tusResult.ok) return { ok: false, error: tusResult.error ?? 'Upload failed' }
      return { ok: true, url: publicUrl() }
    }

    // Small files: signed URL direct to Supabase (fast, no Railway in the path)
    const urlRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, contentType }),
    })
    const urlData = await urlRes.json()
    if (!urlRes.ok) return { ok: false, error: urlData.error ?? 'Could not get upload URL' }

    const putResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) onPct(Math.round((ev.loaded / ev.total) * 80))
      })
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true })
        else resolve({ ok: false, error: xhr.responseText || `HTTP ${xhr.status}` })
      })
      xhr.addEventListener('error', () => resolve({ ok: false, error: 'Network error' }))
      xhr.open('PUT', urlData.signedUrl)
      xhr.setRequestHeader('Content-Type', contentType)
      xhr.setRequestHeader('x-upsert', 'true')
      xhr.send(file)
    })

    if (putResult.ok) return { ok: true, url: urlData.publicUrl as string }

    // If signed URL fails with 413, retry with TUS
    if (putResult.error?.includes('413') || putResult.error?.includes('exceeded the maximum')) {
      onStatus('Retrying with chunked upload...')
      onPct(0)
      const tusResult = await tusUpload(file, filename, contentType, onPct)
      if (!tusResult.ok) return { ok: false, error: tusResult.error ?? 'Upload failed' }
      return { ok: true, url: publicUrl() }
    }
    return { ok: false, error: putResult.error ?? 'Upload failed' }
  }

  // ── Acapella slot ──────────────────────────────────────────────────────────
  // One pinned vocals-only file per project: uploaded beside the mixes in
  // mf-audio under an acapella- prefixed key, then PATCHed onto the row.
  async function handleAcapellaSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (acapellaInputRef.current) acapellaInputRef.current.value = ''
    if (file.size > 2 * 1024 * 1024 * 1024) {
      setAcapellaStatus('Error: File too large (max 2GB)')
      return
    }

    setAcapellaUploading(true)
    setAcapellaPct(0)
    setAcapellaStatus('Uploading...')

    const ext = (file.name.split('.').pop() ?? 'wav').toLowerCase()
    const filename = `${project.id}/acapella-${Date.now()}.${ext}`
    const mimeByExt: Record<string, string> = {
      wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
      mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
    }
    const contentType = file.type || mimeByExt[ext] || 'application/octet-stream'

    const up = await uploadAudioToStorage(file, filename, contentType, setAcapellaPct, setAcapellaStatus)
    if (!up.ok) {
      setAcapellaStatus(`Error: ${up.error}`)
      setAcapellaPct(0)
      setAcapellaUploading(false)
      return
    }

    setAcapellaPct(90)
    setAcapellaStatus('Saving...')
    const res = await fetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acapella_url: up.url }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      setAcapellaStatus(`Error: ${err?.error ?? 'Could not save the acapella'}`)
      setAcapellaPct(0)
      setAcapellaUploading(false)
      return
    }
    setAcapella(up.url)
    setAcapellaStatus('')
    setAcapellaPct(0)
    setAcapellaUploading(false)
    syncAfterMutation()
  }

  // Clears the slot (the bytes stay under the project prefix and are removed
  // with the project, same as replaced artwork).
  async function removeAcapella() {
    const prev = acapella
    setAcapella(null)
    const res = await fetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acapella_url: null }),
    })
    if (!res.ok) {
      setAcapella(prev)
      flashError('Could not remove the acapella. Try again.')
    }
  }

  // Saved file name for the acapella download (title-acapella.<real ext>).
  function acapellaDownloadName(): string {
    const base = (projectForm.title || project.title).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'song'
    const ext = acapella?.split('?')[0].split('.').pop() ?? 'wav'
    return `${base}-acapella.${ext}`
  }

  async function handleUpload(file: File) {
    if (file.size > 2 * 1024 * 1024 * 1024) {
      setUploadStatus('Error: File too large (max 2GB)')
      return
    }
    setUploading(true)
    setUploadPct(0)
    setUploadStatus('Uploading...')

    const ext = file.name.split('.').pop()
    const filename = `${project.id}/${Date.now()}.${ext}`

    const mimeByExt: Record<string, string> = {
      wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
      mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
    }
    const fileExt = (file.name.split('.').pop() ?? '').toLowerCase()
    const contentType = file.type || mimeByExt[fileExt] || 'application/octet-stream'

    const up = await uploadAudioToStorage(file, filename, contentType, setUploadPct, setUploadStatus)
    if (!up.ok) {
      setUploadStatus(`Error: ${up.error}`)
      setUploadPct(0)
      setUploading(false)
      return
    }
    const audioUrl = up.url

    setUploadPct(85)
    setUploadStatus('Reading metadata...')

    let audioDuration: number | null = null
    try {
      audioDuration = await new Promise((resolve) => {
        const audio = new Audio(audioProxyUrl(audioUrl))
        // Only need duration — don't buffer the whole file we just uploaded.
        audio.preload = 'metadata'
        audio.addEventListener('loadedmetadata', () => {
          // This probe is where NEW nulls are minted, so it must resolve an
          // honest null rather than a number-shaped non-number.
          // `loadedmetadata` does not guarantee a usable duration: it is NaN if
          // metadata parsed without a length, and Infinity for a stream whose
          // length the browser cannot determine — and this reads back through
          // /api/audio, which only forwards Content-Length when Supabase sends
          // one. `Math.round` propagates both unchanged.
          //
          // Today JSON.stringify happens to hide that (`{"d":Infinity}` is not
          // JSON, so both encode to null and the column ends up NULL either
          // way) — which is exactly why it went unnoticed. The bug is that the
          // value is only correct by accident: any change to how it travels (a
          // query param, `String(d)`, a client-side display, a future heal that
          // reads it back) turns a silent null into "NaN" or a stored Infinity
          // that the write-once rule could never let anyone correct.
          const d = audio.duration
          resolve(Number.isFinite(d) && d > 0 ? Math.round(d) : null)
        })
        audio.addEventListener('error', () => resolve(null))
        setTimeout(() => resolve(null), 8000)
      })
    } catch {
      audioDuration = null
    }

    setUploadPct(92)
    setUploadStatus('Saving mix...')

    // No label or status here on purpose: the server reads both off the
    // filename ("MIX 3" → a Mix, "MASTER 2" → a Master) and numbers bare
    // tokens itself — see src/lib/mix-status.ts.
    const versionRes = await fetch('/api/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        audio_url: audioUrl,
        audio_filename: file.name,
        duration_seconds: audioDuration,
        file_size_bytes: file.size,
      }),
    })

    const newVersion = await versionRes.json()
    if (versionRes.ok) {
      setUploadPct(100)
      setUploadStatus('Done!')
      setTimeout(() => {
        setVersions(prev => [{ ...newVersion, mb_feedback: [] }, ...prev])
        setUploadPct(0)
        setUploadStatus('')
        setUploading(false)
        syncAfterMutation()
        // Measure the mix from the File we still have in hand, skipping the
        // re-download MasterCheck's button would pay. Scheduled from HERE, after
        // the new row is in `versions`, so the result folds into a row that
        // exists — and after the upload has already reported success, so it
        // cannot delay or fail it. Not awaited, by design.
        scheduleAutoMeasure(file, newVersion.id as string, row => handleMeasured(newVersion.id as string, row))
      }, 600)
    } else {
      setUploadStatus(`Error: ${newVersion.error ?? 'Unknown error'}`)
      setUploadPct(0)
      setUploading(false)
    }
  }

  async function restoreVersion(archivedVersion: VersionWithFeedback) {
    setRestoring(true)
    try {
      const res = await fetch('/api/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: project.id,
          audio_url: archivedVersion.audio_url,
          audio_filename: archivedVersion.audio_filename,
          duration_seconds: archivedVersion.duration_seconds,
          file_size_bytes: archivedVersion.file_size_bytes,
          label: archivedVersion.label,
          // Restoring re-inserts the row, so carry its status — bringing back
          // "MASTER 2" must not demote it to a fresh Mix.
          status: archivedVersion.status,
        }),
      })
      if (res.ok) {
        const newVersion = await res.json()
        setVersions(prev => [{ ...newVersion, mb_feedback: [] }, ...prev])
        closeArchived()
        syncAfterMutation()
      } else {
        flashError('Could not restore that mix — please try again.')
      }
    } catch {
      flashError('Could not restore that mix — check your connection.')
    } finally {
      setRestoring(false)
    }
  }

  async function summarizeFeedback(versionId: string) {
    setSummaryLoading(versionId)
    setSummaryError(prev => { const next = { ...prev }; delete next[versionId]; return next })
    try {
      const res = await fetch('/api/chat/summarize-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSummaryError(prev => ({ ...prev, [versionId]: data.error ?? 'Failed to summarize' }))
        return
      }
      setSummaries(prev => ({ ...prev, [versionId]: data.summary as string }))
    } catch (err) {
      setSummaryError(prev => ({ ...prev, [versionId]: err instanceof Error ? err.message : 'Network error' }))
    } finally {
      setSummaryLoading(null)
    }
  }

  async function saveProject() {
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: projectForm.title.trim() || project.title,
          genre: projectForm.genre.trim() || null,
          bpm: projectForm.bpm ? parseInt(projectForm.bpm) : null,
          key_signature: projectForm.key_signature.trim() || null,
        }),
      })
      if (res.ok) {
        setProjectSaved(true)
        setEditingProject(false)
        setTimeout(() => setProjectSaved(false), 2000)
        syncAfterMutation()
      } else {
        flashError('Could not save project details — please try again.')
      }
    } catch {
      flashError('Could not save project details — check your connection.')
    }
  }

  async function startRelease() {
    setStartingRelease(true)
    try {
      const res = await fetch('/api/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: projectForm.title || project.title, project_id: project.id }),
      })
      if (res.ok) {
        const data = await res.json()
        setRelease(data)
        syncAfterMutation()
      } else {
        flashError('Could not start the release — please try again.')
      }
    } catch {
      flashError('Could not start the release — check your connection.')
    } finally {
      setStartingRelease(false)
    }
  }

  async function toggleReleaseCheck(field: string, current: boolean) {
    if (!release) return
    // Optimistic toggle with rollback so the checkbox reflects the DB truth.
    setRelease(prev => prev ? { ...prev, [field]: !current } : prev)
    try {
      const res = await fetch(`/api/releases/${release.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: !current }),
      })
      if (!res.ok) {
        setRelease(prev => prev ? { ...prev, [field]: current } : prev)
        flashError('Could not update the checklist — reverted.')
      }
    } catch {
      setRelease(prev => prev ? { ...prev, [field]: current } : prev)
      flashError('Could not update the checklist — check your connection.')
    }
  }

  const releaseProgress = release
    ? Math.round((CHECKLIST_ITEMS.filter(c => release[c.key]).length / CHECKLIST_ITEMS.length) * 100)
    : 0

  // Current mix = highest version_number (index 0, sorted desc). Everything else is archived.
  const currentMix = versions[0] ?? null
  const archivedVersions = versions.slice(1)

  // ── Closing the archive ends the audition it started ───────────────────────
  // Archived mixes play through the app's ONE shared <audio> element (see the
  // modal below), so leaving the modal would otherwise leave an old mix playing
  // in the mini player with no obvious way back to it.
  //
  // The stop is keyed on the URL rather than on a "we started it" flag: if the
  // user was already playing the CURRENT mix when they opened the archive, that
  // playback is not ours to stop. Every close path — the X, the backdrop, and
  // Restore — goes through here, which is why setArchivedOpen(false) appears
  // exactly once in this file.
  function closeArchived() {
    if (currentUrl && archivedVersions.some(av => audioProxyUrl(av.audio_url) === currentUrl)) pause()
    setArchivedOpen(false)
  }

  // ── Cross-version loudness ─────────────────────────────────────────────────
  // A measurement now lives on the version row (migration 032), so the page can
  // show what CHANGED between two mixes — the thing a DAW can't tell you,
  // because it only ever has one bounce open.

  // The comparison partner for a mix is the nearest OLDER mix that actually has
  // a stored measurement — NOT simply the one before it. Skipping unmeasured
  // mixes is what makes the delta appear as soon as any two points in the
  // history have numbers, instead of only when two consecutive uploads happen to
  // have been measured.
  function previousMeasuredFor(index: number): { loudness: LoudnessInput; label: string } | null {
    // A -1 from a findIndex miss must not alias to "compare against the newest
    // mix" (the loop below would start at 0). No match → no comparison partner.
    if (index < 0) return null
    for (let i = index + 1; i < versions.length; i++) {
      const loudness = loudnessFromRow(versions[i])
      if (loudness) return { loudness, label: versionDisplayLabel(versions[i]) }
    }
    return null
  }

  // ── Smart version history ──────────────────────────────────────────────────
  // Masters and mixes are different animals: the mixes are the working history,
  // the masters are the candidates for release. The archive shows them as two
  // sections (masters first) instead of one undifferentiated pile. Kind comes
  // from the artist's own filenames/labels ("MASTER 2" stays a master even
  // once Released), falling back to status for unnamed rows.
  const archivedMasters = archivedVersions.filter(v => versionKind(v) === 'Master')
  const archivedMixes = archivedVersions.filter(v => versionKind(v) === 'Mix')
  const masterCount = versions.filter(v => versionKind(v) === 'Master').length
  const mixCount = versions.length - masterCount

  // Fold the saved columns straight back into the version row so the readout and
  // every later comparison update without a refetch.
  function handleMeasured(versionId: string, row: VersionLoudnessRow) {
    setVersions(prev => prev.map(v => (v.id === versionId ? { ...v, ...row } : v)))
  }

  return (
    <div className={inModal ? '' : 'pt-14'}>
      {actionError && (
        <div
          className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg"
          style={{ backgroundColor: 'var(--surface)', color: '#f87171', border: '1px solid var(--surface-2)' }}
          role="alert"
        >
          {actionError}
        </div>
      )}
      <div className={inModal ? 'max-w-4xl mx-auto px-5 sm:px-6 py-6 pb-16' : 'max-w-4xl mx-auto px-6 py-8 pb-36 md:pb-10'}>
        {!inModal && (
          <Link href="/dashboard" className="flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text)] text-sm mb-6 transition-colors w-fit">
            <ArrowLeft size={14} />
            Dashboard
          </Link>
        )}

        {/* Project header */}
        <div className="flex gap-6 mb-8">
          <div className="flex-shrink-0 w-32">
            <ArtworkGenerator
              projectId={project.id}
              projectTitle={project.title}
              genre={project.genre}
              currentArtwork={artwork}
              currentFinalized={finalizedArtwork}
              onArtworkUpdated={handleArtworkUpdated}
              onFinalizedUpdated={handleFinalizedUpdated}
              showFinalize={false}
              showActions={false}
              ownerDefaults={ownerDefaults}
            />
          </div>

          <div className="flex-1 min-w-0 pt-1">
            {editingProject ? (
              <div className="space-y-3 mb-4">
                <input
                  type="text"
                  value={projectForm.title}
                  onChange={e => setProjectForm(p => ({ ...p, title: e.target.value }))}
                  className="w-full bg-[var(--input-bg)] border border-[#2dd4bf]/30 rounded-xl px-3 py-2 text-lg font-bold text-[var(--text)] focus:outline-none focus:border-[#2dd4bf]/60"
                />
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-[var(--text-muted)] mb-1">Genre</label>
                    <input type="text" value={projectForm.genre} onChange={e => setProjectForm(p => ({ ...p, genre: e.target.value }))} placeholder="e.g. Techno" className="w-full bg-[var(--input-bg)] rounded-lg px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none" style={{ border: '1px solid var(--border)' }} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[var(--text-muted)] mb-1">BPM</label>
                    <input type="number" value={projectForm.bpm} onChange={e => setProjectForm(p => ({ ...p, bpm: e.target.value }))} placeholder="e.g. 140" className="w-full bg-[var(--input-bg)] rounded-lg px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none" style={{ border: '1px solid var(--border)' }} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[var(--text-muted)] mb-1">Key</label>
                    <input type="text" value={projectForm.key_signature} onChange={e => setProjectForm(p => ({ ...p, key_signature: e.target.value }))} placeholder="e.g. Am" className="w-full bg-[var(--input-bg)] rounded-lg px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none" style={{ border: '1px solid var(--border)' }} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveProject} className="bg-[#2dd4bf] hover:bg-[#14b8a6] text-[#0a0a0a] text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors">Save</button>
                  <button onClick={() => setEditingProject(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs px-3 py-1.5 rounded-lg transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-2xl font-bold text-[var(--text)]">{projectForm.title || project.title}</h1>
                  <button onClick={() => setEditingProject(true)} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors" title="Edit project details">
                    <Pencil size={13} />
                  </button>
                  {projectSaved && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Check size={10} /> Saved</span>}
                </div>
                <div className="flex items-center gap-3 text-sm text-[var(--text-muted)] mb-3">
                  {(projectForm.genre || project.genre) && <span>{projectForm.genre || project.genre}</span>}
                  {(projectForm.bpm || project.bpm) && <span>{projectForm.bpm || project.bpm} BPM</span>}
                  {(projectForm.key_signature || project.key_signature) && <span>{projectForm.key_signature || project.key_signature}</span>}
                  <span>{mixCount} mix{mixCount !== 1 ? 'es' : ''}</span>
                  {masterCount > 0 && <span>{masterCount} master{masterCount !== 1 ? 's' : ''}</span>}
                </div>

                {/* Project actions row */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <AddToCollectionButton projectId={project.id} />
                  {project.share_token && (
                    <button
                      onClick={copyShareLink}
                      className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                        copied
                          ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
                          : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] border-[var(--border)]'
                      }`}
                    >
                      {copied ? <Check size={12} /> : <Share2 size={12} />}
                      {copied ? 'Copied!' : 'Share'}
                    </button>
                  )}
                  <button
                    onClick={deleteProject}
                    disabled={deletingProject}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-red-400 hover:border-red-400/30 transition-colors disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                    {deletingProject ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </>
            )}
            <StatusPipeline currentStatus={projectStatus} />
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 border-b" style={{ borderColor: 'var(--surface-2)' }}>
          {(['versions', 'artwork', 'visualizer', 'video'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => switchTab(tab)}
              className="px-4 py-2.5 text-sm font-medium capitalize transition-colors relative"
              style={{
                color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {tab === 'artwork' ? 'Artwork' : tab === 'visualizer' ? 'Visualizer' : tab === 'video' ? 'Video' : 'Song Info'}
            </button>
          ))}
        </div>

        {/* Tab content — Mixes */}
        {activeTab === 'versions' && (
          <div>

            {/* Upload button */}
            <div className="flex items-center gap-3 mb-6">
              {uploading ? (
                <div className="flex items-center gap-3 rounded-xl px-4 py-2.5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <span className="text-xs text-[var(--text-secondary)] flex-shrink-0">{uploadStatus}</span>
                  <div className="w-32 h-1 bg-[var(--surface-2)] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ backgroundColor: uploadPct === 100 ? '#34d399' : '#2dd4bf', width: `${uploadPct}%` }}
                    />
                  </div>
                  <span className="text-xs text-[var(--text-muted)] flex-shrink-0">{uploadPct}%</span>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] text-[#0a0a0a] text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                  >
                    <Upload size={15} />
                    Update Mix
                  </button>
                  {uploadStatus.startsWith('Error') && (
                    <span className="text-xs text-red-400">{uploadStatus}</span>
                  )}
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.aiff,.aif,.flac,.m4a,.ogg"
                className="sr-only"
                aria-label="Upload a new mix audio file"
                onChange={handleFileSelect}
              />
            </div>

            {/* Acapella slot — one pinned vocals-only file per project */}
            <div className="mb-6 rounded-xl px-4 py-3" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <Mic size={15} className="text-[#2dd4bf] flex-shrink-0" />
                  <span className="text-sm font-medium text-[var(--text)]">Acapella</span>
                  {!acapella && !acapellaUploading && (
                    <span className="text-xs text-[var(--text-muted)] truncate">— vocals-only version of this song</span>
                  )}
                </div>
                {acapellaUploading ? (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-[var(--text-secondary)]">{acapellaStatus}</span>
                    <div className="w-24 h-1 bg-[var(--surface-2)] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{ backgroundColor: acapellaPct === 100 ? '#34d399' : '#2dd4bf', width: `${acapellaPct}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    {acapella && (
                      <a
                        href={`${audioProxyUrl(acapella)}?download=1&filename=${encodeURIComponent(acapellaDownloadName())}`}
                        className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
                      >
                        Download
                      </a>
                    )}
                    <button
                      onClick={() => acapellaInputRef.current?.click()}
                      className="text-xs font-semibold text-[#2dd4bf] hover:text-[#14b8a6] transition-colors"
                    >
                      {acapella ? 'Replace' : 'Upload acapella'}
                    </button>
                    {acapella && (
                      <button
                        onClick={removeAcapella}
                        className="text-xs text-[var(--text-muted)] hover:text-red-400 transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </div>
              {acapellaStatus.startsWith('Error') && !acapellaUploading && (
                <p className="text-xs text-red-400 mt-2">{acapellaStatus}</p>
              )}
              {acapella && !acapellaUploading && (
                <audio controls preload="none" src={audioProxyUrl(acapella)} className="w-full mt-3 h-9" />
              )}
              <input
                ref={acapellaInputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.aiff,.aif,.flac,.m4a,.ogg"
                className="sr-only"
                aria-label="Upload an acapella audio file"
                onChange={handleAcapellaSelect}
              />
            </div>

            {/* Current mix */}
            {currentMix === null ? (
              <div className="text-center py-16 text-[var(--text-muted)]">
                <CassetteIcon size={32} className="mx-auto mb-3 text-[#2a2a2a]" />
                <p className="text-sm">No mixes yet — upload your first mix above</p>
              </div>
            ) : (
              <CurrentMixCard
                version={currentMix}
                feedComments={initialFeedComments[currentMix.id] ?? []}
                projectTitle={projectForm.title || project.title}
                artwork={artwork}
                currentUrl={currentUrl}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                seek={seek}
                togglePlay={togglePlay}
                playUrl={playUrl}
                savedNoteKey={savedNoteKey}
                summaries={summaries}
                summaryLoading={summaryLoading}
                summaryError={summaryError}
                onUpdateStatus={updateStatus}
                onUpdateNotes={updateNotes}
                onSummarizeFeedback={summarizeFeedback}
                onToggleAllowDownload={updateAllowDownload}
                shareEnabled={Boolean(project.share_token)}
                loudness={loudnessFromRow(currentMix)}
                previousMeasured={previousMeasuredFor(0)}
                onMeasured={handleMeasured}
              />
            )}

            {/* Restore older mix */}
            {archivedVersions.length > 0 && (
              <div className="mt-5">
                <button
                  onClick={() => setArchivedOpen(true)}
                  className="flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                >
                  <History size={13} />
                  Version history ({archivedVersions.length} earlier version{archivedVersions.length !== 1 ? 's' : ''})
                </button>
              </div>
            )}

            {/* Notes left on mixes that are no longer current. Without this the
                notifications bell links here for feedback the page can't show. */}
            <EarlierMixNotes
              // Remount when the deep-link target changes: the auto-open state
              // is computed in a useState initializer, and a search-params-only
              // navigation would otherwise leave it stale.
              key={highlightVersionId ?? 'none'}
              versions={archivedVersions}
              feedCommentsByVersion={initialFeedComments}
              highlightVersionId={highlightVersionId}
            />

            {/* Release Pipeline */}
            <div className="mt-10 mb-2">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <CalendarRange size={16} className="text-[#2dd4bf]" />
                  <h2 className="text-sm font-semibold text-[var(--text)]">Release Pipeline</h2>
                </div>
                {release && (
                  <Link
                    href="/pipeline"
                    className="flex items-center gap-1 text-xs text-[#555] hover:text-[#2dd4bf] transition-colors"
                  >
                    View in Pipeline
                    <ExternalLink size={11} />
                  </Link>
                )}
              </div>

              {release ? (
                <div className="rounded-2xl p-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-3 mb-5">
                    <div className="flex-1 h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${releaseProgress}%`,
                          backgroundColor: releaseProgress === 100 ? '#34d399' : releaseProgress >= 50 ? '#2dd4bf' : '#555',
                        }}
                      />
                    </div>
                    <span className="text-xs text-[var(--text-muted)] flex-shrink-0">{releaseProgress}%</span>
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                    {CHECKLIST_ITEMS.map(item => (
                      <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={release[item.key]}
                          onChange={() => toggleReleaseCheck(item.key, release[item.key])}
                          className="accent-[#2dd4bf] w-3.5 h-3.5 flex-shrink-0"
                        />
                        <span className={`text-sm transition-colors ${release[item.key] ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)] group-hover:text-[var(--text)]'}`}>
                          {item.label}
                        </span>
                      </label>
                    ))}
                  </div>

                  {release.release_date && (
                    <p className="text-xs text-[var(--text-muted)] mt-4">
                      Target date: {formatReleaseDate(release.release_date, { month: 'long', day: 'numeric', year: 'numeric' })}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  onClick={startRelease}
                  disabled={startingRelease}
                  className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 text-[#0a0a0a] text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
                >
                  <Plus size={15} />
                  {startingRelease ? 'Creating…' : 'Start Release Pipeline'}
                </button>
              )}
            </div>

          </div>
        )}

        {/* Tab content — Artwork */}
        {activeTab === 'artwork' && (
          <div className="max-w-2xl">
            <ArtworkGenerator
              projectId={project.id}
              projectTitle={project.title}
              genre={project.genre}
              currentArtwork={artwork}
              currentFinalized={finalizedArtwork}
              onArtworkUpdated={handleArtworkUpdated}
              onFinalizedUpdated={handleFinalizedUpdated}
              ownerDefaults={ownerDefaults}
            />
          </div>
        )}

        {/* Tab content — Visualizer */}
        {activeTab === 'visualizer' && (
          <Visualizer
            projectId={project.id}
            projectTitle={project.title}
            artworkUrl={artwork}
            visualizerUrl={visualizer}
            onVisualizerUpdated={handleVisualizerUpdated}
            wideVisualizerUrl={visualizerWide}
            onWideVisualizerUpdated={handleWideVisualizerUpdated}
            onSwitchToArtwork={() => switchTab('artwork')}
            projectBpm={project.bpm}
            audioUrl={currentMix ? audioProxyUrl(currentMix.audio_url) : null}
            audioVersionId={currentMix?.id ?? null}
          />
        )}

        {/* Tab content — Video (finished full-length / Short renders) */}
        {activeTab === 'video' && (
          <VideoFinalizer
            projectId={project.id}
            visualizerUrl={visualizer}
            wideVisualizerUrl={visualizerWide}
            hasAudio={versions.length > 0}
            onSwitchToVisualizer={() => switchTab('visualizer')}
          />
        )}

      </div>

      {/* Archived mixes modal */}
      {archivedOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          onClick={e => { if (e.target === e.currentTarget) closeArchived() }}
        >
          <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold text-[var(--text)]">Version History</h3>
              <button onClick={() => closeArchived()} className="text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="overflow-y-auto max-h-96">
              {([['Masters', archivedMasters], ['Mixes', archivedMixes]] as [string, VersionWithFeedback[]][])
                .filter(([, list]) => list.length > 0)
                .map(([heading, list]) => (
              <div key={heading}>
                {/* Section headers only earn their space once both kinds exist. */}
                {archivedMasters.length > 0 && archivedMixes.length > 0 && (
                  <div className="px-5 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]" style={{ backgroundColor: 'var(--surface-2)' }}>
                    {heading} ({list.length})
                  </div>
                )}
                <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {list.map(av => {
                // Deltas compare against the full chronological history, so the
                // index is looked up in `versions` — the grouped sections above
                // reorder the display, never the comparison.
                const previous = previousMeasuredFor(versions.findIndex(x => x.id === av.id))
                const avLabel = versionDisplayLabel(av)
                // Same proxied URL the download link and MasterCheck use. It has
                // to be the proxy: Supabase's public URLs don't reliably send
                // Accept-Ranges, so a raw URL plays but cannot seek or report a
                // duration — and it would never match `currentUrl` below either.
                const avUrl = audioProxyUrl(av.audio_url)
                // "Is this the mix playing?" is asked of the shared engine, not
                // of local state. That is what makes one-at-a-time structural
                // rather than bookkeeping: there is a single <audio> element, so
                // starting one archived mix stops whatever else was playing, and
                // no second row can believe it is still active.
                const avActive = currentUrl === avUrl
                const avPlaying = avActive && isPlaying
                return (
                <div key={av.id} className="px-5 py-4 hover:bg-[var(--surface-2)] transition-colors">
                  <div className="flex items-center gap-3">
                    {/* 36px round target — big enough to hit on a phone, and a
                        plain tap (no drag) so it never fights the list scroll. */}
                    <button
                      onClick={() => {
                        if (avActive) togglePlay()
                        else playUrl(avUrl, project.title, undefined, artwork ?? undefined, avLabel)
                      }}
                      aria-label={avPlaying ? `Pause ${avLabel}` : `Play ${avLabel}`}
                      title={avPlaying ? `Pause ${avLabel}` : `Play ${avLabel}`}
                      className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-colors"
                      style={avActive
                        ? { backgroundColor: 'rgba(45,212,191,0.12)', border: '1px solid #2dd4bf', color: '#2dd4bf' }
                        : { backgroundColor: 'var(--surface-2)', border: '1px solid var(--surface-3)', color: 'var(--text)' }}
                    >
                      {avPlaying ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[var(--text)] flex items-center gap-2 flex-wrap">
                        {avLabel}
                        {avActive && (
                          <span className="text-[10px] text-[#2dd4bf] bg-[#2dd4bf]/10 px-1.5 py-0.5 rounded-full leading-none">
                            {isPlaying ? 'Playing' : 'Paused'}
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--text-muted)]">
                        <span>{new Date(av.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        {/* While it plays, the stored length gives way to the real
                            one — which is the only length there is for the many
                            rows whose duration_seconds is null (iOS uploads). */}
                        {avActive ? (
                          <span className="tabular-nums">{formatDuration(currentTime)} / {formatDuration(duration || av.duration_seconds)}</span>
                        ) : av.duration_seconds ? (
                          <span>{formatDuration(av.duration_seconds)}</span>
                        ) : null}
                        {av.file_size_bytes && <span>{formatFileSize(av.file_size_bytes)}</span>}
                      </div>
                    </div>
                    <StatusBadge status={av.status} size="sm" />
                    <a
                      href={`${avUrl}?download=1&filename=${encodeURIComponent(av.audio_filename ?? 'mix.wav')}`}
                      download={av.audio_filename ?? 'mix.wav'}
                      className="text-[var(--text-muted)] hover:text-[var(--text)] transition-colors flex-shrink-0"
                      title={`Download original file${av.audio_filename ? ` (${av.audio_filename})` : ''}`}
                    >
                      <Download size={13} />
                    </a>
                    <button
                      onClick={() => restoreVersion(av)}
                      disabled={restoring}
                      className="text-xs font-medium text-[#2dd4bf] hover:text-[#5eead4] disabled:opacity-50 disabled:cursor-wait transition-colors flex-shrink-0"
                    >
                      {restoring ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>

                  {/* Archived mixes get the full master check too, and this is
                      not cosmetic: a comparison needs two measured points, and
                      the older one is always in here. Without a way to measure
                      an archived mix the delta would have exactly one data point
                      forever — and opening this modal also backfills the
                      pre-persistence localStorage readings for every old mix at
                      once. */}
                  <div className="mt-3">
                    <MasterCheck
                      versionId={av.id}
                      audioUrl={avUrl}
                      fileSizeBytes={av.file_size_bytes ?? null}
                      initial={loudnessFromRow(av)}
                      previous={previous?.loudness ?? null}
                      previousLabel={previous?.label ?? null}
                      onMeasured={row => handleMeasured(av.id, row)}
                    />
                  </div>
                </div>
                )
              })}
                </div>
              </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <p className="text-[11px] text-[var(--text-muted)]">Restoring a version makes it current again. The old one stays in this history.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Current mix card ─────────────────────────────────────────────────────────

type CurrentMixCardProps = {
  version: VersionWithFeedback
  /** Community-feed comments on THIS version (other artists). */
  feedComments: FeedComment[]
  projectTitle: string
  artwork: string | null
  currentUrl: string | null
  currentTime: number
  duration: number
  isPlaying: boolean
  seek: (t: number) => void
  togglePlay: () => void
  playUrl: (url: string, title: string, artist?: string, artwork?: string, label?: string, startAt?: number) => void
  savedNoteKey: string | null
  summaries: Record<string, string>
  summaryLoading: string | null
  summaryError: Record<string, string>
  onUpdateStatus: (id: string, status: Version['status']) => void
  onUpdateNotes: (id: string, field: 'private_notes' | 'public_notes', value: string) => void
  onSummarizeFeedback: (id: string) => void
  onToggleAllowDownload: (id: string, allow: boolean) => void
  /** Project has a share link, so the download toggle actually reaches someone. */
  shareEnabled: boolean
  /** Stored BS.1770-4 measurement for this mix (migration 032), or null. */
  loudness: LoudnessInput | null
  /** Nearest older mix that has one, for the delta. */
  previousMeasured: { loudness: LoudnessInput; label: string } | null
  onMeasured: (versionId: string, row: VersionLoudnessRow) => void
}

function CurrentMixCard({
  version, feedComments, projectTitle, artwork,
  currentUrl, currentTime, duration, isPlaying, seek, togglePlay, playUrl,
  savedNoteKey, summaries, summaryLoading, summaryError,
  onUpdateStatus, onUpdateNotes, onSummarizeFeedback, onToggleAllowDownload,
  shareEnabled, loudness, previousMeasured, onMeasured,
}: CurrentMixCardProps) {
  const vUrl = audioProxyUrl(version.audio_url)
  const isActive = currentUrl === vUrl
  const vPct = isActive && duration > 0 ? (currentTime / duration) * 100 : 0
  const displayDuration = isActive ? duration : (version.duration_seconds ?? 0)
  const feedback = version.mb_feedback ?? []
  const ratedFeedback = feedback.filter(f => f.rating)
  const avgRating = ratedFeedback.length > 0
    ? (ratedFeedback.reduce((s, f) => s + f.rating!, 0) / ratedFeedback.length).toFixed(1)
    : null
  const label = versionDisplayLabel(version)

  // Jump the shared player to a timestamped piece of feedback. If this mix is
  // already playing, seek in place; otherwise start it at that position.
  const goToTimestamp = (t: number) => {
    if (isActive) seek(t)
    else playUrl(vUrl, projectTitle, undefined, artwork ?? undefined, label, t)
  }

  // Copy Markdown to the clipboard, flashing a "Copied!" confirmation; where the
  // Clipboard API is unavailable (some webviews / non-secure contexts) fall back
  // to downloading it as a .md file so the export still works inside the iOS
  // wrapper. Shared by all three feedback exports below.
  const copyMarkdown = async (md: string, filename: string, onCopied: () => void) => {
    try {
      await navigator.clipboard.writeText(md)
      onCopied()
    } catch {
      const blob = new Blob([md], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }
  }
  const flash = (set: (v: boolean) => void) => () => {
    set(true)
    setTimeout(() => set(false), 2000)
  }

  // Export feedback as a Markdown "punch list" (timestamped notes first, ordered
  // by their moment in the track) the musician can paste straight into a DAW
  // session or a doc.
  const [copiedPunch, setCopiedPunch] = useState(false)
  const copyPunchList = () =>
    copyMarkdown(buildPunchList(`${projectTitle} — ${label}`, feedback), `${label} — punch list.md`, flash(setCopiedPunch))

  // Export the AI feedback summary as Markdown so the model's read of the room
  // can leave the app (session doc, message to a collaborator, release notes).
  const [copiedSummary, setCopiedSummary] = useState(false)
  const copySummary = () => {
    const summary = summaries[version.id]
    if (!summary) return
    copyMarkdown(buildSummaryExport(`${projectTitle} — ${label}`, summary, feedback), `${label} — AI summary.md`, flash(setCopiedSummary))
  }

  // Export the combined "mix report" — AI summary + punch list in one document —
  // the single thing a musician carries into a session or hands a collaborator.
  // Degrades to a plain punch list when no summary has been generated yet.
  const [copiedReport, setCopiedReport] = useState(false)
  const copyMixReport = () =>
    copyMarkdown(buildMixReport(`${projectTitle} — ${label}`, summaries[version.id] ?? '', feedback), `${label} — mix report.md`, flash(setCopiedReport))

  // Pinned-feedback markers on the scrubber. Each timestamped comment becomes a
  // dot on the timeline (orange ≤3★, cyan ≥4★, muted if unrated) — hover for the
  // note, click to seek. Needs a known duration to place dots, so it's hidden
  // until the mix is active or we have its stored length.
  const markerColor = (rating: number | null | undefined) =>
    rating == null ? 'var(--text-muted)' : rating <= 3 ? '#fb923c' : '#2dd4bf'
  const markers = displayDuration > 0
    ? feedback
        .filter(f => f.timestamp_seconds != null)
        .map(f => ({ f, pct: Math.min(100, Math.max(0, (f.timestamp_seconds! / displayDuration) * 100)) }))
    : []

  return (
    <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>

      {/* ── Header row ── */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--text)]">{label}</span>
          <span className="text-[10px] text-[#2dd4bf] bg-[#2dd4bf]/10 px-1.5 py-0.5 rounded-full leading-none">Current</span>
          <span className="text-[var(--border)]">·</span>
          <span className="text-xs text-[var(--text-muted)]">
            {new Date(version.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
          {version.duration_seconds != null && (
            <><span className="text-[var(--border)]">·</span><span className="text-xs text-[var(--text-muted)]">{formatDuration(version.duration_seconds)}</span></>
          )}
          {version.file_size_bytes != null && (
            <><span className="text-[var(--border)]">·</span><span className="text-xs text-[var(--text-muted)]">{formatFileSize(version.file_size_bytes)}</span></>
          )}
          {feedback.length > 0 && (
            <><span className="text-[var(--border)]">·</span>
            <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
              <MessageSquare size={10} />{feedback.length}{avgRating ? ` · ★ ${avgRating}` : ''}
            </span></>
          )}
        </div>
        <StatusBadge status={version.status} size="sm" />
      </div>

      {/* ── Body ── */}
      <div className="px-4 pb-4 pt-3 space-y-4" style={{ borderTop: '1px solid var(--border)' }}>

        {/* Player */}
        <div>
          <div
            className="relative w-full h-8 rounded-lg overflow-hidden mb-2"
            style={{ backgroundColor: 'var(--input-bg)' }}
          >
            <div
              className="absolute bottom-0 left-0 h-0.5 transition-all duration-100"
              style={{ backgroundColor: 'var(--accent)', width: `${vPct}%` }}
            />
            <input
              type="range" min={0} max={displayDuration || 1} step={0.1}
              value={isActive ? currentTime : 0}
              onChange={e => {
                if (isActive) seek(Number(e.target.value))
                else playUrl(vUrl, projectTitle, undefined, artwork ?? undefined, label)
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            {markers.map(({ f, pct }) => (
              <button
                key={f.id}
                type="button"
                onClick={e => { e.stopPropagation(); goToTimestamp(f.timestamp_seconds!) }}
                aria-label={`${f.reviewer_name} at ${formatDuration(f.timestamp_seconds)}: ${f.comment}`}
                title={`${f.reviewer_name}${f.rating ? ` · ${f.rating}★` : ''} @ ${formatDuration(f.timestamp_seconds)}\n${f.comment}`}
                className="absolute bottom-0 z-10 w-2 h-2 -translate-x-1/2 rounded-full ring-1 ring-black/40 hover:scale-150 transition-transform cursor-pointer"
                style={{ left: `${pct}%`, backgroundColor: markerColor(f.rating) }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => {
                if (isActive) togglePlay()
                else playUrl(vUrl, projectTitle, undefined, artwork ?? undefined, label)
              }}
              className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full transition-colors"
              style={{ backgroundColor: 'var(--surface-2)', border: '1px solid var(--surface-3)', color: 'var(--text)' }}
            >
              {isActive && isPlaying ? <Pause size={12} /> : <Play size={12} />}
            </button>
            <span className="text-xs tabular-nums text-[var(--text-muted)]">
              {formatDuration(isActive ? currentTime : 0)} / {formatDuration(displayDuration || null)}
            </span>
            <div className="flex-1" />
            {/* Owner can always re-download the original upload (e.g. to submit
                the WAV to a distributor) — ?download=1 makes the audio proxy
                stream it as an attachment under its original filename. */}
            <a
              href={`${vUrl}?download=1&filename=${encodeURIComponent(version.audio_filename ?? 'mix.wav')}`}
              download={version.audio_filename ?? 'mix.wav'}
              className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
              title={`Download original file${version.audio_filename ? ` (${version.audio_filename})` : ''}`}
            >
              <Download size={13} />
              Original
            </a>
          </div>

          {/* Opt this mix's original into the public share page, so whoever you
              send the link to can download the same full-quality file. */}
          {shareEnabled && (
            <label
              className="flex items-center gap-2 mt-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer select-none"
              title="Adds a Download button to this project's public share page"
            >
              <input
                type="checkbox"
                checked={Boolean(version.allow_download)}
                onChange={e => onToggleAllowDownload(version.id, e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-[var(--accent)] cursor-pointer"
              />
              Let people with the share link download this file
            </label>
          )}
        </div>

        {version.change_log && (
          <p className="text-xs text-[var(--text-muted)] px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-2)' }}>
            {version.change_log}
          </p>
        )}

        {/* Measured loudness + per-DSP normalization verdict — the substance
            behind the pipeline's "Mastering done" checkbox — plus the delta
            against the last measured mix. */}
        <MasterCheck
          versionId={version.id}
          audioUrl={vUrl}
          fileSizeBytes={version.file_size_bytes ?? null}
          initial={loudness}
          previous={previousMeasured?.loudness ?? null}
          previousLabel={previousMeasured?.label ?? null}
          onMeasured={row => onMeasured(version.id, row)}
        />

        {/* Status */}
        <div className="flex gap-1.5 flex-wrap">
          {STATUSES.map(s => {
            const conf = STATUS_CONFIG[s]
            const active = normalizeStatus(version.status) === s
            return (
              <button key={s} onClick={() => onUpdateStatus(version.id, s)}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? `${conf.color} ${conf.bg} ${conf.border}`
                    : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-secondary)]'
                }`}
              >{conf.label}</button>
            )
          })}
        </div>

        {/* Notes */}
        <div className="grid grid-cols-2 gap-3">
          {(['private_notes', 'public_notes'] as const).map(field => (
            <div key={field}>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-[var(--text-muted)]">
                  {field === 'private_notes' ? 'Private notes' : 'Public notes'}
                </label>
                {savedNoteKey === `${version.id}-${field}` && (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-0.5"><Check size={9} /> Saved</span>
                )}
              </div>
              <textarea
                defaultValue={version[field] ?? ''}
                onBlur={e => onUpdateNotes(version.id, field, e.target.value)}
                placeholder={field === 'private_notes' ? 'Your notes…' : 'Visible to listeners…'}
                aria-label={field === 'private_notes' ? 'Private notes' : 'Public notes'}
                rows={2}
                className="w-full rounded-lg px-3 py-2 text-xs text-[var(--text)] focus:outline-none resize-none"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
              />
            </div>
          ))}
        </div>

        {/* Feedback */}
        {feedback.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-[var(--text-muted)]">Feedback</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={copyPunchList}
                  title="Copy feedback as a timestamp-ordered punch list"
                  className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                >
                  {copiedPunch ? <Check size={10} /> : <ClipboardList size={10} />}
                  {copiedPunch ? 'Copied!' : 'Punch list'}
                </button>
                {summaries[version.id] && (
                  <button
                    onClick={copyMixReport}
                    title="Copy the AI summary and punch list together as one mix report"
                    className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                  >
                    {copiedReport ? <Check size={10} /> : <FileText size={10} />}
                    {copiedReport ? 'Copied!' : 'Mix report'}
                  </button>
                )}
                <button
                  onClick={() => onSummarizeFeedback(version.id)}
                  disabled={summaryLoading === version.id}
                  className="flex items-center gap-1 text-[11px] text-[#2dd4bf] hover:text-[#5eead4] disabled:opacity-50 transition-colors"
                >
                  <Sparkles size={10} />
                  {summaryLoading === version.id ? 'Summarizing…' : summaries[version.id] ? 'Re-summarize' : 'Summarize with AI'}
                </button>
              </div>
            </div>
            {summaryError[version.id] && <p className="text-xs text-red-400 mb-2">{summaryError[version.id]}</p>}
            {summaries[version.id] && (
              <div className="rounded-xl p-3 mb-2" style={{ backgroundColor: 'var(--surface-2)', border: '1px solid #2dd4bf22' }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <Sparkles size={10} className="text-[#2dd4bf]" />
                    <span className="text-[10px] uppercase tracking-wide text-[#2dd4bf]">AI Summary</span>
                  </div>
                  <button
                    onClick={copySummary}
                    title="Copy the AI summary as Markdown"
                    className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                  >
                    {copiedSummary ? <Check size={10} /> : <Copy size={10} />}
                    {copiedSummary ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <SummaryView markdown={summaries[version.id]} />
              </div>
            )}
            <div className="space-y-1.5">
              {feedback.map(f => (
                <div key={f.id} className="rounded-xl px-3 py-2.5" style={{ backgroundColor: 'var(--surface-2)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-medium text-[var(--text-secondary)] truncate">{f.reviewer_name}</span>
                      {f.timestamp_seconds != null && (
                        <button
                          type="button"
                          onClick={() => goToTimestamp(f.timestamp_seconds!)}
                          title={`Play from ${formatDuration(f.timestamp_seconds)}`}
                          className="inline-flex items-center gap-1 text-[10px] text-[#2dd4bf] bg-[#2dd4bf]/10 hover:bg-[#2dd4bf]/20 rounded-full px-1.5 py-0.5 leading-none transition-colors flex-shrink-0"
                        >
                          <Play size={8} className="fill-[#2dd4bf]" />
                          {formatDuration(f.timestamp_seconds)}
                        </button>
                      )}
                    </div>
                    {f.rating && (
                      <div className="flex gap-0.5">
                        {[1,2,3,4,5].map(s => (
                          <Star key={s} size={9} className={s <= f.rating! ? 'text-[#2dd4bf] fill-[#2dd4bf]' : 'text-[var(--text-muted)]'} />
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">{f.comment}</p>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">{new Date(f.created_at).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Community-feed comments from other artists. Kept visually distinct
            from share-page Feedback above: that is a curator/client responding
            to a link you sent; this is a peer replying in the public feed. */}
        {feedComments.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <MessageSquare size={10} className="text-[var(--text-muted)]" />
              <span className="text-[11px] text-[var(--text-muted)]">From other artists</span>
            </div>
            <div className="space-y-1.5">
              {feedComments.map(c => (
                <div key={c.id} className="rounded-xl px-3 py-2.5" style={{ backgroundColor: 'var(--surface-2)' }}>
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-xs font-medium text-[var(--text-secondary)] truncate">{c.artist}</span>
                    <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0">
                      {new Date(c.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words">{c.comment}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Notes on earlier mixes ───────────────────────────────────────────────────
// The project page used to render notes for the CURRENT mix only: feedback was
// read inside CurrentMixCard, and archived versions appeared solely in the
// restore modal, which shows no notes at all. So a curator's feedback on v3
// became invisible the moment v4 was uploaded — even though the loader had
// already fetched it, and even though the notifications bell links here. This
// section is the fix: every note on every earlier mix, from both sources.

type EarlierMixNotesProps = {
  versions: VersionWithFeedback[]
  feedCommentsByVersion: Record<string, FeedComment[]>
  highlightVersionId: string | null
}

function EarlierMixNotes({ versions, feedCommentsByVersion, highlightVersionId }: EarlierMixNotesProps) {
  const withNotes = versions
    .map(v => ({
      version: v,
      feedback: v.mb_feedback ?? [],
      comments: feedCommentsByVersion[v.id] ?? [],
    }))
    .filter(g => g.feedback.length + g.comments.length > 0)

  // A notification deep-links with ?v=<version_id>. Treat it strictly as a
  // hint: mb_activity.version_id has no foreign key and version deletion does
  // not clean it up, so it may not match anything here. Opening the section
  // when it DOES match is the whole benefit; a miss just leaves it collapsed.
  // Derived at mount rather than in an effect — highlightVersionId is read once
  // from the URL, so there is nothing to synchronize afterwards.
  const [open, setOpen] = useState(
    () => highlightVersionId != null && withNotes.some(g => g.version.id === highlightVersionId),
  )

  if (withNotes.length === 0) return null

  const total = withNotes.reduce((s, g) => s + g.feedback.length + g.comments.length, 0)

  return (
    <div className="mt-5">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
      >
        <MessageSquare size={12} />
        Notes on earlier mixes ({total})
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          {withNotes.map(({ version: v, feedback, comments }) => (
            <div
              key={v.id}
              className="rounded-xl p-3"
              style={{
                backgroundColor: 'var(--surface)',
                border: `1px solid ${v.id === highlightVersionId ? '#2dd4bf66' : 'var(--border)'}`,
              }}
            >
              <p className="text-[11px] text-[var(--text-muted)] mb-2">
                {versionDisplayLabel(v)}
                {' · '}
                {new Date(v.created_at).toLocaleDateString()}
              </p>
              <div className="space-y-1.5">
                {feedback.map(f => (
                  <div key={f.id} className="rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--surface-2)' }}>
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-xs font-medium text-[var(--text-secondary)] truncate">{f.reviewer_name}</span>
                      {f.rating && (
                        <div className="flex gap-0.5 flex-shrink-0">
                          {[1, 2, 3, 4, 5].map(st => (
                            <Star key={st} size={9} className={st <= f.rating! ? 'text-[#2dd4bf] fill-[#2dd4bf]' : 'text-[var(--text-muted)]'} />
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words">{f.comment}</p>
                  </div>
                ))}
                {comments.map(c => (
                  <div key={c.id} className="rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--surface-2)' }}>
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-xs font-medium text-[var(--text-secondary)] truncate">{c.artist}</span>
                      <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0">from the feed</span>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words">{c.comment}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Lightweight Markdown renderer for AI summaries ────────────────────────────

function SummaryView({ markdown }: { markdown: string }) {
  const lines = markdown.split('\n')
  const blocks: ReactNode[] = []
  let bulletGroup: string[] = []

  function flushBullets() {
    if (bulletGroup.length === 0) return
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="list-disc pl-4 space-y-1 mb-2">
        {bulletGroup.map((b, i) => (
          <li key={i} className="text-xs text-[var(--text-secondary)]">{renderInline(b)}</li>
        ))}
      </ul>,
    )
    bulletGroup = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flushBullets(); continue }
    if (line.startsWith('## ')) {
      flushBullets()
      blocks.push(
        <p key={`h-${blocks.length}`} className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text)] mt-2 mb-1">
          {line.slice(3)}
        </p>,
      )
    } else if (line.startsWith('- ')) {
      bulletGroup.push(line.slice(2))
    } else {
      flushBullets()
      blocks.push(
        <p key={`p-${blocks.length}`} className="text-xs text-[var(--text-secondary)] mb-2">
          {renderInline(line)}
        </p>,
      )
    }
  }
  flushBullets()
  return <>{blocks}</>
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(_[^_]+_)/g)
  return parts.map((part, i) => {
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return <em key={i} className="text-[var(--text-muted)]">{part.slice(1, -1)}</em>
    }
    return <span key={i}>{part}</span>
  })
}
