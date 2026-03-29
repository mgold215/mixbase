/**
 * Local JSON-file database — replaces Supabase for the self-contained prototype.
 * Data is stored in <project-root>/data/db.json.
 * File uploads are stored in public/uploads/ and served as static assets.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ---- Path constants ----
const DATA_DIR = join(process.cwd(), 'data')
const DB_FILE = join(DATA_DIR, 'db.json')
const DB_TMP = join(DATA_DIR, 'db.tmp.json')

// ---- Types (mirrors SQL schema) ----

export type Project = {
  id: string
  title: string
  artwork_url: string | null
  genre: string | null
  bpm: number | null
  key_signature: string | null
  created_at: string
  updated_at: string
}

export type Version = {
  id: string
  project_id: string
  version_number: number
  label: string | null
  audio_url: string
  audio_filename: string | null
  duration_seconds: number | null
  file_size_bytes: number | null
  status: 'WIP' | 'Mix/Master' | 'Finished' | 'Released'
  private_notes: string | null
  public_notes: string | null
  change_log: string | null
  share_token: string
  allow_download: boolean
  created_at: string
}

export type Feedback = {
  id: string
  version_id: string
  reviewer_name: string
  rating: number | null
  comment: string | null
  timestamp_seconds: number | null
  created_at: string
}

export type Release = {
  id: string
  title: string
  release_date: string | null
  project_id: string | null
  genre: string | null
  label: string | null
  isrc: string | null
  notes: string | null
  mixing_done: boolean
  mastering_done: boolean
  artwork_ready: boolean
  dsp_submitted: boolean
  social_posts_done: boolean
  press_release_done: boolean
  dsp_spotify: boolean
  dsp_apple_music: boolean
  dsp_tidal: boolean
  dsp_bandcamp: boolean
  dsp_soundcloud: boolean
  dsp_youtube: boolean
  dsp_amazon: boolean
  created_at: string
  updated_at: string
}

export type Activity = {
  id: string
  type: string
  project_id: string | null
  version_id: string | null
  release_id: string | null
  description: string | null
  created_at: string
}

type DB = {
  projects: Project[]
  versions: Version[]
  feedback: Feedback[]
  releases: Release[]
  activity: Activity[]
}

// ---- DB I/O ----

function readDb(): DB {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(DB_FILE)) {
    const empty: DB = { projects: [], versions: [], feedback: [], releases: [], activity: [] }
    writeFileSync(DB_FILE, JSON.stringify(empty, null, 2))
    return empty
  }
  return JSON.parse(readFileSync(DB_FILE, 'utf8')) as DB
}

function writeDb(db: DB): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(DB_TMP, JSON.stringify(db, null, 2))
  renameSync(DB_TMP, DB_FILE)
}

function now(): string {
  return new Date().toISOString()
}

// ---- Projects ----

export function getProjects(): (Project & { mf_versions: Pick<Version, 'id' | 'status' | 'created_at'>[] })[] {
  const db = readDb()
  return db.projects
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map(p => ({
      ...p,
      mf_versions: db.versions
        .filter(v => v.project_id === p.id)
        .sort((a, b) => a.version_number - b.version_number)
        .map(v => ({ id: v.id, status: v.status, created_at: v.created_at })),
    }))
}

export function getProject(id: string): (Project & { mf_versions: (Version & { mf_feedback: Feedback[] })[] }) | null {
  const db = readDb()
  const project = db.projects.find(p => p.id === id)
  if (!project) return null
  return {
    ...project,
    mf_versions: db.versions
      .filter(v => v.project_id === id)
      .sort((a, b) => b.version_number - a.version_number)
      .map(v => ({
        ...v,
        mf_feedback: db.feedback.filter(f => f.version_id === v.id),
      })),
  }
}

export function createProject(data: { title: string; genre?: string | null; bpm?: number | null; key_signature?: string | null }): Project {
  const db = readDb()
  const project: Project = {
    id: randomUUID(),
    title: data.title,
    genre: data.genre ?? null,
    bpm: data.bpm ?? null,
    key_signature: data.key_signature ?? null,
    artwork_url: null,
    created_at: now(),
    updated_at: now(),
  }
  db.projects.push(project)
  writeDb(db)
  return project
}

export function updateProject(id: string, data: Partial<Project>): Project | null {
  const db = readDb()
  const idx = db.projects.findIndex(p => p.id === id)
  if (idx === -1) return null
  db.projects[idx] = { ...db.projects[idx], ...data, updated_at: now() }
  writeDb(db)
  return db.projects[idx]
}

export function deleteProject(id: string): void {
  const db = readDb()
  const versionIds = db.versions.filter(v => v.project_id === id).map(v => v.id)
  db.feedback = db.feedback.filter(f => !versionIds.includes(f.version_id))
  db.versions = db.versions.filter(v => v.project_id !== id)
  db.projects = db.projects.filter(p => p.id !== id)
  writeDb(db)
}

// ---- Versions ----

export function createVersion(data: {
  project_id: string
  audio_url: string
  audio_filename?: string | null
  duration_seconds?: number | null
  file_size_bytes?: number | null
  label?: string | null
  status?: Version['status']
  private_notes?: string | null
  public_notes?: string | null
  change_log?: string | null
  allow_download?: boolean
}): Version {
  const db = readDb()
  const existingVersions = db.versions.filter(v => v.project_id === data.project_id)
  const nextVersion = existingVersions.length > 0
    ? Math.max(...existingVersions.map(v => v.version_number)) + 1
    : 1
  const shareToken = randomUUID().replace(/-/g, '')
  const version: Version = {
    id: randomUUID(),
    project_id: data.project_id,
    version_number: nextVersion,
    label: data.label ?? null,
    audio_url: data.audio_url,
    audio_filename: data.audio_filename ?? null,
    duration_seconds: data.duration_seconds ?? null,
    file_size_bytes: data.file_size_bytes ?? null,
    status: data.status ?? 'WIP',
    private_notes: data.private_notes ?? null,
    public_notes: data.public_notes ?? null,
    change_log: data.change_log ?? null,
    share_token: shareToken,
    allow_download: data.allow_download ?? false,
    created_at: now(),
  }
  db.versions.push(version)
  // Update project updated_at
  const pidx = db.projects.findIndex(p => p.id === data.project_id)
  if (pidx !== -1) db.projects[pidx].updated_at = now()
  writeDb(db)
  return version
}

export function getVersion(id: string): (Version & { mf_feedback: Feedback[] }) | null {
  const db = readDb()
  const version = db.versions.find(v => v.id === id)
  if (!version) return null
  return { ...version, mf_feedback: db.feedback.filter(f => f.version_id === id) }
}

export function getVersionByToken(token: string): (Version & { mf_projects: Project | null }) | null {
  const db = readDb()
  const version = db.versions.find(v => v.share_token === token)
  if (!version) return null
  return {
    ...version,
    mf_projects: db.projects.find(p => p.id === version.project_id) ?? null,
  }
}

export function updateVersion(id: string, data: Partial<Version>): (Version & { mf_feedback: Feedback[] }) | null {
  const db = readDb()
  const idx = db.versions.findIndex(v => v.id === id)
  if (idx === -1) return null
  db.versions[idx] = { ...db.versions[idx], ...data }
  writeDb(db)
  return { ...db.versions[idx], mf_feedback: db.feedback.filter(f => f.version_id === id) }
}

export function deleteVersion(id: string): void {
  const db = readDb()
  db.feedback = db.feedback.filter(f => f.version_id !== id)
  db.versions = db.versions.filter(v => v.id !== id)
  writeDb(db)
}

// ---- Releases ----

export function getReleases(): (Release & { mf_projects: { title: string; artwork_url: string | null } | null })[] {
  const db = readDb()
  const releases = db.releases.map(r => ({
    ...r,
    mf_projects: r.project_id
      ? (db.projects.find(p => p.id === r.project_id) ?? null)
        ? { title: db.projects.find(p => p.id === r.project_id)!.title, artwork_url: db.projects.find(p => p.id === r.project_id)!.artwork_url }
        : null
      : null,
  }))
  // Sort: nulls last, then ascending by release_date
  return releases.sort((a, b) => {
    if (!a.release_date && !b.release_date) return 0
    if (!a.release_date) return 1
    if (!b.release_date) return -1
    return a.release_date.localeCompare(b.release_date)
  })
}

export function createRelease(data: {
  title: string
  release_date?: string | null
  project_id?: string | null
  genre?: string | null
  label?: string | null
  isrc?: string | null
  notes?: string | null
}): Release {
  const db = readDb()
  const release: Release = {
    id: randomUUID(),
    title: data.title,
    release_date: data.release_date ?? null,
    project_id: data.project_id ?? null,
    genre: data.genre ?? null,
    label: data.label ?? null,
    isrc: data.isrc ?? null,
    notes: data.notes ?? null,
    mixing_done: false,
    mastering_done: false,
    artwork_ready: false,
    dsp_submitted: false,
    social_posts_done: false,
    press_release_done: false,
    dsp_spotify: false,
    dsp_apple_music: false,
    dsp_tidal: false,
    dsp_bandcamp: false,
    dsp_soundcloud: false,
    dsp_youtube: false,
    dsp_amazon: false,
    created_at: now(),
    updated_at: now(),
  }
  db.releases.push(release)
  writeDb(db)
  return release
}

export function updateRelease(id: string, data: Partial<Release>): Release | null {
  const db = readDb()
  const idx = db.releases.findIndex(r => r.id === id)
  if (idx === -1) return null
  db.releases[idx] = { ...db.releases[idx], ...data, updated_at: now() }
  writeDb(db)
  return db.releases[idx]
}

export function deleteRelease(id: string): void {
  const db = readDb()
  db.releases = db.releases.filter(r => r.id !== id)
  writeDb(db)
}

// ---- Feedback ----

export function createFeedback(data: {
  version_id: string
  reviewer_name?: string
  rating?: number | null
  comment: string
  timestamp_seconds?: number | null
}): { feedback: Feedback; version: Pick<Version, 'project_id' | 'version_number'> | null } {
  const db = readDb()
  const feedback: Feedback = {
    id: randomUUID(),
    version_id: data.version_id,
    reviewer_name: data.reviewer_name?.trim() || 'Anonymous',
    rating: data.rating ?? null,
    comment: data.comment.trim(),
    timestamp_seconds: data.timestamp_seconds ?? null,
    created_at: now(),
  }
  db.feedback.push(feedback)
  const version = db.versions.find(v => v.id === data.version_id) ?? null
  writeDb(db)
  return {
    feedback,
    version: version ? { project_id: version.project_id, version_number: version.version_number } : null,
  }
}

// ---- Activity ----

export function logActivity(data: {
  type: string
  project_id?: string | null
  version_id?: string | null
  release_id?: string | null
  description?: string | null
}): void {
  const db = readDb()
  const entry: Activity = {
    id: randomUUID(),
    type: data.type,
    project_id: data.project_id ?? null,
    version_id: data.version_id ?? null,
    release_id: data.release_id ?? null,
    description: data.description ?? null,
    created_at: now(),
  }
  db.activity.unshift(entry)
  if (db.activity.length > 200) db.activity = db.activity.slice(0, 200)
  writeDb(db)
}

export function getActivity(limit = 20): Activity[] {
  const db = readDb()
  return db.activity.slice(0, limit)
}
