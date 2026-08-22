// ── Smart mix status ─────────────────────────────────────────────────────────
// The workflow statuses are Mix → Master → Finished → Released. There is no
// hand-picked "WIP" step anymore: the artist's own filenames carry the state.
// Uploading "MIX 3.wav" is a work-in-progress mix; "MASTER 2.wav" means they're
// mastering. This module is the single authority for reading that convention —
// the upload route uses it to stamp status + label on new versions, and every
// display surface uses it to name rows that predate stored labels.
//
// Pure and dependency-free on purpose: it is imported by client components,
// API routes, and the unit suite (scripts/mix-status-test.mjs) alike.

export const MIX_STATUSES = ['Mix', 'Master', 'Finished', 'Released'] as const
export type MixStatus = (typeof MIX_STATUSES)[number]

/** The two kinds a bounce can be — the statuses a fresh upload can detect into. */
export type MixKind = 'Mix' | 'Master'

export type ParsedVersionName = {
  kind: MixKind
  /** Number as written ("MIX 3.1" → "3.1"), or null for a bare token ("master.wav"). */
  number: string | null
  /** Canonical label ("MASTER 2"), or null when the token carried no number —
   *  the upload route then synthesizes the next number for that kind. */
  label: string | null
}

// A token counts only as a standalone word: "remaster"/"mixdown" must not
// match, but "MASTER2", "mix_3" and "Mix 3.1" must. Master is tested first so
// a name carrying both ("mix master 2") reads as the master it is.
const KIND_TOKENS: Array<[MixKind, RegExp]> = [
  ['Master', /(?:^|[^a-z])master(?:[\s._#-]*(\d+(?:\.\d+)*))?(?![a-z])/i],
  ['Mix', /(?:^|[^a-z])mix(?:[\s._#-]*(\d+(?:\.\d+)*))?(?![a-z])/i],
]

/** Parse a filename or stored label into its mix/master identity, or null. */
export function parseVersionName(name: string | null | undefined): ParsedVersionName | null {
  if (!name) return null
  const base = name.replace(/\.[^.]+$/, '')
  for (const [kind, re] of KIND_TOKENS) {
    const m = re.exec(base)
    if (m) {
      const number = m[1] ?? null
      return { kind, number, label: number ? `${kind.toUpperCase()} ${number}` : null }
    }
  }
  return null
}

/**
 * Collapse any stored status — including the retired 'WIP' and 'Mix/Master'
 * values a stale client or an unmigrated row can still carry — onto the
 * current set. Unknown strings read as 'Mix', the floor of the pipeline.
 */
export function normalizeStatus(status: string | null | undefined): MixStatus {
  if (status === 'Master' || status === 'Mix/Master') return 'Master'
  if (status === 'Finished' || status === 'Released') return status
  return 'Mix'
}

/** Status a fresh upload should get, from its filename alone. */
export function statusForUpload(filename: string | null | undefined): MixStatus {
  return parseVersionName(filename)?.kind ?? 'Mix'
}

type VersionNameSource = {
  label?: string | null
  audio_filename?: string | null
  status?: string | null
}

/**
 * Which side of the history a version belongs to. The artist's own naming wins
 * (a released "MASTER 3" stays a master); rows with no parseable name fall
 * back to status — anything past 'Mix' is master-stage work.
 */
export function versionKind(v: VersionNameSource): MixKind {
  const parsed = parseVersionName(v.label) ?? parseVersionName(v.audio_filename)
  if (parsed) return parsed.kind
  return normalizeStatus(v.status) === 'Mix' ? 'Mix' : 'Master'
}

/** Display name for a version row: stored label → parsed filename → "Mix N"/"Master N". */
export function versionDisplayLabel(v: VersionNameSource & { version_number: number }): string {
  if (v.label) return v.label
  const parsed = parseVersionName(v.audio_filename)
  if (parsed?.label) return parsed.label
  return `${versionKind(v)} ${v.version_number}`
}

/**
 * Next label for a numberless upload of `kind` ("master.wav" after "MASTER 2"
 * exists → "MASTER 3"). Counts from the highest number already claimed for
 * that kind across labels and filenames, so hand-numbered and synthesized
 * uploads share one sequence.
 */
export function nextKindLabel(kind: MixKind, versions: VersionNameSource[]): string {
  let max = 0
  for (const v of versions) {
    const parsed = parseVersionName(v.label) ?? parseVersionName(v.audio_filename)
    if (parsed?.kind !== kind || !parsed.number) continue
    const n = Math.floor(parseFloat(parsed.number))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${kind.toUpperCase()} ${max + 1}`
}
