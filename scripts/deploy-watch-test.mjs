#!/usr/bin/env node
// Contract test: every top-level path either deploys the site or is on record
// as not needing to.
//
// railway.toml lists `watchPatterns`: Railway deploys only when a merge touches
// one of them (2026-11-18, after three notes-only merges in one evening each
// restarted production). The danger of such a list is the opposite failure: a
// new file the build depends on is added at the top level, nobody adds it to
// the list, and a change to it merges, shows green, and never goes live.
//
// So every top-level file or folder git tracks must be in exactly one place:
//   - watched in railway.toml, or
//   - listed in DOES_NOT_DEPLOY below, with the reason.
//
// Run: node scripts/deploy-watch-test.mjs  (also part of `npm test`)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url).pathname

/** Top-level paths that never reach the running site, each with why. */
const DOES_NOT_DEPLOY = {
  '.claude': 'notes and settings for coding agents',
  '.env.example': 'a list of variable names; real values live in Railway',
  '.github': 'CI and app-store workflows, run by GitHub',
  '.gitignore': 'git only',
  '.gitleaks.toml': 'secret scanning, run in CI and before commits',
  '.husky': 'git hooks on a developer machine',
  '.mcp.json': 'tool connections for coding agents',
  'AGENTS.md': 'notes for coding agents',
  'CLAUDE.md': 'notes for coding agents',
  'README.md': 'documentation',
  'docs': 'documentation',
  'eslint.config.mjs': 'lint runs in CI, not in the deployed build',
  'ios': 'the iOS app ships through TestFlight',
  'macos': 'the Mac app ships through TestFlight',
  'playwright.config.ts': 'end-to-end tests',
  'scripts': 'tests and one-off tools; the site imports nothing from here',
  'supabase': 'database files, applied to Supabase by hand (database-changes skill)',
  'tests': 'end-to-end tests',
}
/** The site cannot be built without these, so they must always be watched. */
const MUST_WATCH = ['src', 'public', 'package.json', 'package-lock.json', 'next.config.ts', 'railway.toml']

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

console.log('deploy-watch: what makes Railway deploy\n')

const toml = readFileSync(ROOT + 'railway.toml', 'utf8')
const block = toml.match(/^watchPatterns\s*=\s*\[([\s\S]*?)\]/m)
check('railway.toml has a watchPatterns list', !!block)
const patterns = block ? [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : []
// "/src/**" → "src"; "/package.json" → "package.json"
const watched = [...new Set(patterns.map(p => p.replace(/^\//, '').split('/')[0]))]
check('every pattern is anchored at the repository root', patterns.every(p => p.startsWith('/')),
  `not anchored: ${patterns.filter(p => !p.startsWith('/')).join(', ')}`)

const tracked = [...new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).map(f => f.split('/')[0]))].sort()
check('git lists the repository', tracked.length >= 20, `only ${tracked.length} top-level paths found`)

const missingMust = MUST_WATCH.filter(p => !watched.includes(p))
check('everything the build cannot do without is watched', missingMust.length === 0, `add to watchPatterns: ${missingMust.join(', ')}`)

const undecided = tracked.filter(p => !watched.includes(p) && !(p in DOES_NOT_DEPLOY))
check('every top-level path is watched or listed as "does not deploy"', undecided.length === 0,
  `decide for: ${undecided.join(', ')} (add to watchPatterns in railway.toml if the site is built from it, else to DOES_NOT_DEPLOY here with the reason)`)

const both = watched.filter(p => p in DOES_NOT_DEPLOY)
check('no path is in both lists', both.length === 0, both.join(', '))

const gone = [...watched, ...Object.keys(DOES_NOT_DEPLOY)].filter(p => !tracked.includes(p))
check('neither list names a path that no longer exists', gone.length === 0, `remove: ${gone.join(', ')}`)

// The site must really import nothing from a folder said not to deploy.
// (`git grep` exits 1 when it finds nothing, which is the passing case.)
let imports = ''
try {
  imports = execFileSync('git', ['grep', '-lE', "from ['\"](\\.\\./)+(scripts|supabase|docs|tests)/", '--', 'src'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch (err) {
  if (err.status !== 1) throw err
}
check('nothing under src/ imports from a folder that does not deploy', imports === '', imports.replace(/\n/g, ', '))

if (failures) { console.error(`\n${failures} deploy-watch check(s) failed`); process.exit(1) }
console.log('\nall deploy-watch checks passed')
