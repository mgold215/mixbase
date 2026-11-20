// Finding a song's Logic project on the owner's Mac, with nobody to ask.
//
// The pure half (pickProject) scores the Logic projects on the Mac against
// what mixBASE knows about the song: its title and the filenames of the mixes
// uploaded for it. The other half (listProjects) is how the projects are
// found: Spotlight first, and a walk of the usual folders when Spotlight has
// nothing (its index can be off or rebuilding).

import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import { basename, join } from 'node:path'

/** A name with everything that varies between a title and a filename removed. */
export function nameKey(name) {
  return String(name ?? '')
    .replace(/\.(logicx|wav|wave|aif|aiff|mp3|m4a|flac)$/i, '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    // "- MIX 3", "master2", "v4", "final", "bounce", "copy" say which take, not which song.
    .replace(/\b(mix|master|mstr|bounce|final|copy|intern|alt|version|ver|v)[\s._#-]*\d*(\.\d+)*\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Which project is this song's? `names` are the song's title and the
 * filenames of its mixes (a song renamed in mixBASE keeps its old name on
 * disk). `projects` are { path, mtimeMs }.
 *
 * A project matches when its name IS one of the song's names, or one contains
 * the other as whole words. Among matches the closest name wins, then the one
 * saved most recently. Answers { path } or { error } in words for the owner.
 */
export function pickProject(names, projects) {
  const keys = [...new Set(names.map(nameKey).filter(k => k.length >= 2))]
  if (!keys.length) return { error: 'The song has no title to look for a Logic project by' }
  const words = s => ` ${s} `
  const scored = []
  for (const p of projects) {
    const key = nameKey(basename(p.path))
    if (!key) continue
    let score = 0
    for (const k of keys) {
      if (key === k) score = Math.max(score, 3)
      else if (words(key).includes(words(k))) score = Math.max(score, 2)
      else if (words(k).includes(words(key)) && key.length >= 4) score = Math.max(score, 1)
    }
    if (score) scored.push({ ...p, score })
  }
  if (!scored.length) {
    return { error: `Could not find a Logic project for "${names[0]}" on this Mac (looked at ${projects.length} project${projects.length === 1 ? '' : 's'}). Name the project like the song and try again.` }
  }
  scored.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)
  return { path: scored[0].path, others: scored.slice(1, 6).map(s => s.path) }
}

const SKIP_DIRS = new Set(['Library', 'node_modules', 'Applications', '.Trash', 'Pictures', 'Movies', 'Photos Library.photoslibrary'])

function run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => p.kill(), timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.on('close', () => { clearTimeout(timer); resolve(out) })
    p.on('error', () => { clearTimeout(timer); resolve('') })
  })
}

async function walk(dir, depth, out, deadline) {
  if (depth < 0 || Date.now() > deadline) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.name.toLowerCase().endsWith('.logicx')) { out.push(full); continue }
    if (SKIP_DIRS.has(e.name) || /\.(app|bundle|photoslibrary|musiclibrary|band|framework)$/i.test(e.name)) continue
    await walk(full, depth - 1, out, deadline)
  }
}

/**
 * Every Logic project on this Mac the helper can see, as { path, mtimeMs }.
 * `exclude` are folders never offered (the intern's own working copies).
 */
export async function listProjects({ exclude = [], home = os.homedir() } = {}) {
  let paths = (await run('/usr/bin/mdfind', ['kMDItemFSName == "*.logicx"c'], 20_000)).split('\n').filter(Boolean)
  if (!paths.length) {
    const deadline = Date.now() + 90_000
    await walk(home, 7, paths, deadline)
    let volumes = []
    try { volumes = (await readdir('/Volumes', { withFileTypes: true })).filter(v => v.isDirectory() || v.isSymbolicLink()).map(v => join('/Volumes', v.name)) } catch { /* none */ }
    for (const v of volumes) {
      // The startup disk appears in /Volumes as a link to "/".
      try { if ((await stat(v)).dev === (await stat('/')).dev) continue } catch { continue }
      await walk(v, 6, paths, deadline)
    }
  }
  const out = []
  for (const path of new Set(paths)) {
    if (exclude.some(x => path.startsWith(x)) || /\/(\.Trash|\.Trashes|Backups\.backupdb)\//.test(path)) continue
    // A project's own backups and alternatives live inside the package.
    if (/\.logicx\/.+\.logicx$/i.test(path)) continue
    try { out.push({ path, mtimeMs: (await stat(path)).mtimeMs }) } catch { /* gone */ }
  }
  return out
}

/** "EVERGREEN - MIX 2.wav" → { filename: "EVERGREEN - MIX 2 (intern).wav", label: "MIX 2 (intern)" } */
export function internNames(song) {
  const stem = String(song.audio_filename ?? `${song.title} - ${song.version_label}`).replace(/\.[^.]+$/, '').replace(/\s*\(intern[^)]*\)\s*$/i, '')
  const label = String(song.version_label ?? 'MIX').replace(/\s*\(intern[^)]*\)\s*$/i, '')
  return { filename: `${stem} (intern).wav`, label: `${label} (intern)` }
}
