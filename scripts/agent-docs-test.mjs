#!/usr/bin/env node
// Contract test: the instructions agents read stay short, and stay true.
//
// CLAUDE.md and AGENTS.md are read at the start of EVERY session, so every
// line in them costs attention on every task. They were cut to 82 lines on
// 2026-06-09 and grew back to 57 KB by 2026-11-17, because each feature's
// notes were appended as one more paragraph (Cassette Studio alone was a
// single 24,000-character line). The owner, 2026-11-17: "I feel they look
// completely wrong". Feature notes now live in .claude/skills/, which load
// only when the work calls for them.
//
// So this suite fails the build when:
//   - CLAUDE.md or AGENTS.md outgrows its budget, or grows a wall-of-text line
//   - the Next.js block `next dev` maintains in AGENTS.md is missing or doubled
//   - a skill is missing its name or description, or is too long to load well
//   - a skill exists that AGENTS.md's table does not list (nobody would find
//     it), or AGENTS.md points at one that does not exist
//   - a skill's reference file sends the reader on to another file
//   - an agent definition preloads a skill that does not exist
//   - a registered test suite is missing from the map in preflight-checks
//   - any of these files names a file in this repository that is not there
//
// Fail-first witness (RUN and confirmed): with the 2026-11-17 CLAUDE.md and
// AGENTS.md put back, this suite fails on the size budget, the longest line,
// the doubled Next.js heading and the skills the table does not list. With a
// suite name deleted from the preflight-checks table, it fails on that too.
//
// Run: node scripts/agent-docs-test.mjs  (also part of `npm test`)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname
const read = p => readFileSync(join(ROOT, p), 'utf8')

/** Read at the start of every session. Raise a budget only with the owner's yes. */
const BUDGET = {
  'CLAUDE.md': { lines: 60, chars: 6_000 },
  'AGENTS.md': { lines: 200, chars: 20_000 },
}
/** A line longer than this is a paragraph hiding in a bullet. */
const LONGEST_LINE = 500
/** The published limits for a skill (platform.claude.com → Agent Skills → best practices). */
const SKILL_BODY_LINES = 500
const SKILL_DESCRIPTION_CHARS = 1024
/** A reference file longer than this needs a table of contents at its top. */
const REFERENCE_NEEDS_CONTENTS = 100

const WHERE_IT_GOES = 'move the detail into the feature\'s skill (AGENTS.md → Keeping these files small)'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

// ── A. The two always-loaded files ───────────────────────────────────────────
console.log('agent-docs: the files every session reads\n')

for (const [file, budget] of Object.entries(BUDGET)) {
  const text = read(file)
  const lines = text.split('\n')
  check(`${file} is within ${budget.lines} lines`, lines.length <= budget.lines,
    `${lines.length} lines: ${WHERE_IT_GOES}`)
  check(`${file} is within ${budget.chars} characters`, text.length <= budget.chars,
    `${text.length} characters: ${WHERE_IT_GOES}`)
  const long = lines.map((l, i) => [i + 1, l.length]).filter(([, n]) => n > LONGEST_LINE)
  check(`${file} has no line over ${LONGEST_LINE} characters`, long.length === 0,
    long.map(([n, len]) => `line ${n} is ${len}`).join(', ') + `: ${WHERE_IT_GOES}`)
}

check('CLAUDE.md imports AGENTS.md on its first line', read('CLAUDE.md').split('\n')[0].trim() === '@AGENTS.md',
  'without the import, Claude Code sessions never see AGENTS.md')

const agents = read('AGENTS.md')
const count = (text, needle) => text.split(needle).length - 1
check('AGENTS.md carries the Next.js block exactly once',
  count(agents, '<!-- BEGIN:nextjs-agent-rules -->') === 1 && count(agents, '<!-- END:nextjs-agent-rules -->') === 1,
  '`next dev` writes this block and re-adds it when removed; keep the one it wrote')
check('the Next.js notice is not repeated outside that block', count(agents, 'This is NOT the Next.js you know') === 1,
  'a hand-written copy beside the managed block says the same thing twice')

// ── B. Skills ────────────────────────────────────────────────────────────────
console.log('\nagent-docs: skills\n')

const SKILLS_DIR = '.claude/skills'
const skills = readdirSync(join(ROOT, SKILLS_DIR)).filter(d => statSync(join(ROOT, SKILLS_DIR, d)).isDirectory()).sort()
check('there are skills to check', skills.length >= 6, `only ${skills.length} found: the scan is not reading ${SKILLS_DIR}`)

for (const name of skills) {
  const path = `${SKILLS_DIR}/${name}/SKILL.md`
  if (!existsSync(join(ROOT, path))) { check(`${name} has a SKILL.md`, false); continue }
  const text = read(path)
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!front) { check(`${name}: SKILL.md starts with frontmatter`, false); continue }
  const field = key => front[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim() ?? ''
  const body = text.slice(front[0].length).split('\n').length
  const problems = [
    field('name') !== name && `name is "${field('name')}", the folder is "${name}"`,
    !field('description') && 'no description, so nothing tells a session when to read it',
    field('description') && !/\bUse (before|when|every time|proactively)\b/.test(field('description')) && 'the description says what the skill covers but not when to use it ("Use before…", "Use when…")',
    field('description').length > SKILL_DESCRIPTION_CHARS && `description is ${field('description').length} characters (cut off after ${SKILL_DESCRIPTION_CHARS})`,
    body > SKILL_BODY_LINES && `body is ${body} lines (limit ${SKILL_BODY_LINES}): move reference detail into a file beside SKILL.md`,
  ].filter(Boolean)
  check(`${name}: name, description and length`, problems.length === 0, problems.join('; '))

  // Reference files sit one level below SKILL.md. A reference that points on
  // to another file tends to be read in part, or not at all.
  for (const file of readdirSync(join(ROOT, SKILLS_DIR, name)).filter(f => f.endsWith('.md') && f !== 'SKILL.md')) {
    const ref = read(`${SKILLS_DIR}/${name}/${file}`)
    const onward = [...ref.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map(m => m[1])
    const refProblems = [
      !text.includes(`](${file})`) && 'SKILL.md does not link to it, so nothing leads a reader there',
      onward.length > 0 && `it links on to ${onward.join(', ')}: link every reference file from SKILL.md instead`,
      ref.split('\n').length > REFERENCE_NEEDS_CONTENTS && !/^## Contents$/m.test(ref) && `it is over ${REFERENCE_NEEDS_CONTENTS} lines with no "## Contents" list at the top`,
    ].filter(Boolean)
    check(`${name}/${file}: a reference one level below SKILL.md`, refProblems.length === 0, refProblems.join('; '))
  }
}

// The table in AGENTS.md is how a session (or an agent that has no skills)
// finds these files, so it must list every one of them and nothing else.
const tableStart = agents.indexOf('## Where the detail lives')
const tableEnd = agents.indexOf('\n## ', tableStart + 1)
const table = tableStart === -1 ? '' : agents.slice(tableStart, tableEnd === -1 ? undefined : tableEnd)
const listed = [...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(m => m[1]).sort()
check('AGENTS.md has the "Where the detail lives" table', listed.length > 0)
const unlisted = skills.filter(s => !listed.includes(s))
const gone = listed.filter(s => !skills.includes(s))
check('every skill is listed in that table', unlisted.length === 0, `add a row for: ${unlisted.join(', ')}`)
check('every row in that table is a skill that exists', gone.length === 0, `no such skill: ${gone.join(', ')}`)
const pointed = [...new Set([...agents.matchAll(/→ `([a-z0-9-]+)`$/gm)].map(m => m[1]))]
const deadPointers = pointed.filter(s => !skills.includes(s))
check('every bullet in AGENTS.md that ends "→ `skill`" names a skill that exists', pointed.length > 0 && deadPointers.length === 0, `no such skill: ${deadPointers.join(', ')}`)

// Agent definitions: each says when to use it, and any skill it preloads exists.
const AGENTS_DIR = '.claude/agents'
for (const file of readdirSync(join(ROOT, AGENTS_DIR)).filter(f => f.endsWith('.md')).sort()) {
  const text = read(`${AGENTS_DIR}/${file}`)
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)
  const name = front?.[1].match(/^name:\s*(.+)$/m)?.[1].trim()
  const preloads = front ? [...front[1].matchAll(/^\s+-\s+([a-z0-9-]+)\s*$/gm)].map(m => m[1]) : []
  const problems = [
    !front && 'no frontmatter',
    front && name !== file.replace(/\.md$/, '') && `name is "${name}", the file is "${file}"`,
    front && !/^description:\s*\S/m.test(front[1]) && 'no description',
    ...preloads.filter(s => !skills.includes(s)).map(s => `preloads a skill that does not exist: ${s}`),
  ].filter(Boolean)
  check(`agent ${file.replace(/\.md$/, '')}`, problems.length === 0, problems.join('; '))
}

// The map of "which suites cover which area" must name every suite the runner
// runs, or it quietly stops being the place to look.
const runner = read('scripts/run-renderer-tests.mjs')
const suitesBlock = runner.slice(runner.indexOf('const SUITES = ['), runner.indexOf(']', runner.indexOf('const SUITES = [')))
const registered = [...suitesBlock.matchAll(/'([a-z0-9-]+)-test\.mjs'/g)].map(m => m[1])
const preflight = read(`${SKILLS_DIR}/preflight-checks/SKILL.md`)
const unmapped = registered.filter(s => !preflight.includes('`' + s + '`'))
check('the runner\'s suite list was read', registered.length >= 80, `only ${registered.length} found`)
check('preflight-checks names every registered suite', unmapped.length === 0, `add to its table: ${unmapped.join(', ')}`)

// ── C. Nothing points at a file that is not there ────────────────────────────
console.log('\nagent-docs: every file these documents name exists\n')

function markdownUnder(dir) {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const p = `${dir}/${name}`
    return statSync(join(ROOT, p)).isDirectory() ? markdownUnder(p) : name.endsWith('.md') ? [p] : []
  })
}
const documents = ['CLAUDE.md', 'AGENTS.md', ...markdownUnder('.claude/skills'), ...markdownUnder('.claude/agents')]

/** A backticked token that starts like one of these is a path in this repository. */
const REPO_PATH = /^(src|scripts|ios|macos|docs|supabase|tests|public|\.github|\.claude)\//
/** A pattern or a placeholder, not one file: `scripts/*-test.mjs`, `<projectId>/…`. */
const NOT_ONE_FILE = /[<>*{}…]|\.\.\.\//
/** Named on purpose BECAUSE it is not there, each with why. */
const NAMED_AS_ABSENT = {
  'src/middleware.ts': 'the notes say the middleware is src/proxy.ts and not this file',
}

let named = 0
for (const doc of documents) {
  const text = read(doc)
  const missing = []
  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    const path = token.replace(/[),.;:]+$/, '')
    if (!REPO_PATH.test(path) || /\s/.test(path)) continue
    if (existsSync(join(ROOT, path))) { named++; continue }
    if (!NOT_ONE_FILE.test(path) && !NAMED_AS_ABSENT[path]) missing.push(path)
  }
  // Links between a skill's own files: [lettering.md](lettering.md)
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(target)) continue
    if (existsSync(join(ROOT, dirname(doc), target))) named++
    else missing.push(`${target} (linked)`)
  }
  check(`${doc}`, missing.length === 0, `names files that do not exist: ${[...new Set(missing)].join(', ')}`)
}
check('the scan found the paths these documents name', named >= 80, `only ${named} found: the scan is not reading the documents`)

if (failures) { console.error(`\n${failures} agent-docs check(s) failed`); process.exit(1) }
console.log('\nall agent-docs checks passed')
