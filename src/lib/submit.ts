// ============================================================================
// SubmitBase — shared types + pure helpers for the curator-submission tab.
// Songs come from mb_projects/mb_versions; the listening link is the existing
// /share/<token> page. The curator directory lives in sb_curators.
// ============================================================================

export type CuratorType = 'playlist' | 'label' | 'blog' | 'radio' | 'influencer' | 'other'
export type ContactMethod = 'email' | 'instagram' | 'twitter' | 'soundcloud' | 'form' | 'other'
export type Confidence = 'VERIFIED' | 'UNVERIFIED'
export type SubmissionChannel = 'email' | 'form' | 'social' | 'spotify'
export type SubmissionStatus =
  | 'draft' | 'sent' | 'opened' | 'responded' | 'accepted' | 'rejected' | 'no_response'

export const SUBMISSION_STATUSES: SubmissionStatus[] = [
  'draft', 'sent', 'opened', 'responded', 'accepted', 'rejected', 'no_response',
]

export type Curator = {
  id: string
  user_id: string | null // null = shared starter directory
  name: string
  type: CuratorType | null
  platform: string | null
  genres: string[] | null
  contact_method: ContactMethod | null
  contact_value: string | null
  audience_size: number | null
  accepts_submissions: boolean
  guidelines: string | null
  confidence: Confidence
  source_url: string | null
  notes: string | null
  last_contacted: string | null
  created_at: string
}

export type SbSubmission = {
  id: string
  user_id: string
  project_id: string | null
  version_id: string | null
  curator_id: string | null
  channel: SubmissionChannel | null
  message: string | null
  share_url: string | null
  status: SubmissionStatus
  response_notes: string | null
  sent_at: string | null
  created_at: string
}

// A mixBASE song, distilled for the submission flow.
export type Song = {
  project_id: string
  title: string
  genre: string | null
  artwork_url: string | null
  share_token: string | null
  latest_version_id: string | null
  status: string | null
}

// ─── Message template ───
export const DEFAULT_TEMPLATE = `Subject: {track_title} — submission for {curator_name}

Hi {curator_name},

I'm moodmixformat, a {genre} producer. I think my new track
"{track_title}" could be a strong fit for {curator_name}.

Listen (private, download enabled): {track_url}

{pitch}

Thanks for taking a look — totally understand if it's not the right fit.
— Matt (moodmixformat)`

const TEMPLATE_KEY = 'submitbase:template'

export function loadTemplate(): string {
  if (typeof window === 'undefined') return DEFAULT_TEMPLATE
  return localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE
}
export function saveTemplate(value: string) {
  if (typeof window !== 'undefined') localStorage.setItem(TEMPLATE_KEY, value)
}
export function resetTemplate() {
  if (typeof window !== 'undefined') localStorage.removeItem(TEMPLATE_KEY)
}

// Fill merge fields. Supported: {curator_name} {track_title} {genre} {pitch} {track_url} {platform}
export function renderTemplate(
  template: string,
  curator: Curator,
  song: Song,
  shareUrl: string,
  pitch: string,
): string {
  const fields: Record<string, string> = {
    curator_name: curator.name || '',
    track_title: song.title || '',
    genre: song.genre || curator.genres?.[0] || 'electronic',
    pitch: pitch || '',
    track_url: shareUrl || '',
    platform: curator.platform || '',
  }
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in fields ? fields[key] : whole,
  )
}

// Split a rendered message into Subject + body (first `Subject:` line wins).
export function splitSubjectBody(rendered: string): { subject: string; body: string } {
  const lines = rendered.split('\n')
  if (lines[0]?.toLowerCase().startsWith('subject:')) {
    const subject = lines[0].slice('subject:'.length).trim()
    let rest = lines.slice(1)
    if (rest[0]?.trim() === '') rest = rest.slice(1)
    return { subject, body: rest.join('\n') }
  }
  return { subject: 'Music submission', body: rendered }
}

// ─── Send branching (section 9) ───
export const SPOTIFY_EDITORIAL_URL = 'https://artists.spotify.com'

export function isSpotifyEditorial(curator: Curator): boolean {
  return (curator.contact_value ?? '').trim() === SPOTIFY_EDITORIAL_URL
}

function looksLikeEmail(value: string): boolean {
  return value.includes('@') && !value.includes('://')
}

export type SendKind = 'email' | 'form' | 'social' | 'spotify'

export function resolveSend(curator: Curator): { kind: SendKind; channel: SubmissionChannel } {
  if (isSpotifyEditorial(curator)) return { kind: 'spotify', channel: 'spotify' }
  switch (curator.contact_method) {
    case 'email': return { kind: 'email', channel: 'email' }
    case 'form': return { kind: 'form', channel: 'form' }
    case 'instagram':
    case 'twitter':
    case 'soundcloud': return { kind: 'social', channel: 'social' }
    default: {
      const v = curator.contact_value ?? ''
      return looksLikeEmail(v) ? { kind: 'email', channel: 'email' } : { kind: 'form', channel: 'form' }
    }
  }
}

export function actionLabel(curator: Curator): string {
  switch (resolveSend(curator).kind) {
    case 'email': return 'Open email'
    case 'form': return 'Copy pitch & open form'
    case 'social': return 'Copy message & open profile'
    case 'spotify': return 'Open Spotify for Artists'
  }
}

export function buildMailto(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// ─── Filtering ───
export type SortKey = 'name' | 'type'
export type FilterState = {
  search: string
  genres: string[]
  types: CuratorType[]
  methods: ContactMethod[]
  confidence: Confidence | 'all'
  sort: SortKey
}
export const EMPTY_FILTERS: FilterState = {
  search: '', genres: [], types: [], methods: [], confidence: 'all', sort: 'name',
}

export function allGenres(curators: Curator[]): string[] {
  const set = new Set<string>()
  for (const c of curators) for (const g of c.genres ?? []) set.add(g)
  return Array.from(set).sort()
}

export function applyFilters(curators: Curator[], f: FilterState): Curator[] {
  const q = f.search.trim().toLowerCase()
  const out = curators.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false
    if (f.types.length && !(c.type && f.types.includes(c.type))) return false
    if (f.methods.length && !(c.contact_method && f.methods.includes(c.contact_method))) return false
    if (f.confidence !== 'all' && c.confidence !== f.confidence) return false
    if (f.genres.length) {
      const cg = c.genres ?? []
      if (!f.genres.some((g) => cg.includes(g))) return false
    }
    return true
  })
  out.sort((a, b) => {
    if (f.sort === 'type') {
      const t = (a.type ?? '').localeCompare(b.type ?? '')
      if (t !== 0) return t
    }
    return a.name.localeCompare(b.name)
  })
  return out
}

// ─── CSV import (section 10) ───
export type CuratorInsert = {
  name: string
  type: CuratorType | null
  platform: string | null
  genres: string[] | null
  contact_method: ContactMethod | null
  contact_value: string | null
  audience_size: number | null
  accepts_submissions: boolean
  guidelines: string | null
  confidence: Confidence
  source_url: string | null
}

const VALID_TYPES: CuratorType[] = ['playlist', 'label', 'blog', 'radio', 'influencer', 'other']
const VALID_METHODS: ContactMethod[] = ['email', 'instagram', 'twitter', 'soundcloud', 'form', 'other']

function parseCsvGrid(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else { field += c }
    } else if (c === '"') { inQuotes = true }
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); field = ''; row = []
    } else { field += c }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

export function parseCuratorCsv(text: string): { rows: CuratorInsert[]; errors: string[] } {
  const grid = parseCsvGrid(text)
  const errors: string[] = []
  const rows: CuratorInsert[] = []
  if (grid.length === 0) return { rows, errors: ['File is empty.'] }
  const header = grid[0].map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  if (col('name') === -1) return { rows, errors: ['Missing required "name" column.'] }

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]
    const get = (name: string) => {
      const idx = col(name)
      return idx === -1 ? '' : (cells[idx] ?? '').trim()
    }
    const rowNum = r + 1
    const name = get('name')
    if (!name) { errors.push(`Row ${rowNum}: skipped (no name).`); continue }

    const typeRaw = get('type').toLowerCase()
    const type = VALID_TYPES.includes(typeRaw as CuratorType) ? (typeRaw as CuratorType) : typeRaw ? 'other' : null
    const methodRaw = get('contact_method').toLowerCase()
    const contact_method = VALID_METHODS.includes(methodRaw as ContactMethod) ? (methodRaw as ContactMethod) : methodRaw ? 'other' : null
    const genresRaw = get('genres')
    const genres = genresRaw ? genresRaw.split(';').map((g) => g.trim()).filter(Boolean) : null
    const audienceRaw = get('audience_size')
    const audience_size = audienceRaw ? Number(audienceRaw) : null
    if (audience_size !== null && Number.isNaN(audience_size)) {
      errors.push(`Row ${rowNum}: skipped (audience_size not a number).`); continue
    }
    const acceptsRaw = get('accepts_submissions').toLowerCase()
    const accepts_submissions = acceptsRaw === '' ? true : acceptsRaw !== 'false'
    const confidence: Confidence = get('confidence').toUpperCase() === 'UNVERIFIED' ? 'UNVERIFIED' : 'VERIFIED'

    rows.push({
      name,
      type,
      platform: get('platform') || null,
      genres,
      contact_method,
      contact_value: get('contact_value') || null,
      audience_size,
      accepts_submissions,
      guidelines: get('guidelines') || null,
      confidence,
      source_url: get('source_url') || null,
    })
  }
  return { rows, errors }
}

function escapeCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export const CSV_HEADER = 'name,type,platform,genres,contact_method,contact_value,audience_size,accepts_submissions,guidelines,confidence,source_url'

export function curatorsToCsv(curators: Curator[]): string {
  const lines = [CSV_HEADER]
  for (const c of curators) {
    lines.push([
      c.name ?? '',
      c.type ?? '',
      c.platform ?? '',
      (c.genres ?? []).join(';'),
      c.contact_method ?? '',
      c.contact_value ?? '',
      c.audience_size != null ? String(c.audience_size) : '',
      String(c.accepts_submissions),
      c.guidelines ?? '',
      c.confidence ?? '',
      c.source_url ?? '',
    ].map((x) => escapeCell(String(x))).join(','))
  }
  return lines.join('\n')
}

export const EXAMPLE_CSV = `${CSV_HEADER}
My Favorite Label,label,web,house;tech house,form,https://example.com/demos,,true,Private SoundCloud links only,VERIFIED,https://example.com/demos
A Tastemaker Blog,blog,web,bass;dubstep,email,demos@exampleblog.com,50000,true,Personalize your email,UNVERIFIED,https://forum.example.com/thread
`
