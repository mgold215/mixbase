---
name: exec-daily-meeting
description: The executive governance protocol for the mixbase-product-management daily run — the CEO/CFO/CTO/CHRO layer RUNS the daily iteration, ships continuously through ship-to-prod, and reports through Slack. Use at the START of every mixbase-product-management run, when the scheduled routine fires, or when Matt asks to "run the exec meeting" / "hold the board meeting" / "what do the execs think".
---

# mixBASE Executive Governance (v2 — governs the daily product-management run)

**Standing directive from Matt (2026-08-19): the executive layer runs the daily
product-management iteration autonomously and ships continuously — one delivery pipeline,
not a separate meeting beside the ops run.** This skill is HOW the daily run operates,
start to finish. Exec role definitions: `.claude/agents/exec-{ceo,cfo,cto,chro}.md`.
Design doc: `docs/superpowers/specs/2026-08-19-executive-layer-design.md`.

## Slack channels (all visible to Matt — his messages are binding directives)

| Channel | ID | Purpose |
|---|---|---|
| #mixbase-boardroom | `C0BS7TTH5CG` | Minutes, decisions, action list, execution log |
| #mixbase-ceo-office | `C0BRBJMTXLN` | CEO private feedback ↔ Matt's directives |
| #mixbase-cfo-office | `C0BRH7PHJQL` | CFO private feedback ↔ Matt's directives |
| #mixbase-cto-office | `C0BR7A58JAF` | CTO private feedback ↔ Matt's directives |
| #mixbase-chro-office | `C0BS7TU3KB2` | CHRO private feedback ↔ Matt's directives |

ATTEMPT every Slack call before believing any auth banner. If Slack truly fails, write the
minutes into the memory backlog and flag the outage — never skip the meeting.

## Model tiering for subagents (Matt's directive: opus and sonnet where appropriate)

- **opus** — executive reasoning and synthesis, architecture decisions, code review,
  adversarial verification of another agent's work, anything where a wrong conclusion ships.
- **sonnet** — mechanical work: recon SQL and log pulls, censuses/greps, smoke tests,
  formatting, Slack posting, single-file well-specified edits.
- Rule of thumb: if the subagent's output will be trusted without independent re-verification,
  it runs on opus; if it's cheap to check or mechanical, sonnet.

## The run, in order

### 1. Morning meeting (sets the day's priorities)
- Read Matt's messages in all five channels since the last minutes — binding.
- Fact pack (bounded, ≤ ~10 calls): memory backlog, prod `/api/health`, `git fetch` +
  worktree scan for stranded work, one Supabase counts SQL, Sentry new-issue check.
- Convene all four execs as parallel **opus** subagents (each embodies its role file; returns
  REPORT / CHALLENGE / ACTIONS_AUTO / ACTIONS_MATT / PRIVATE_NOTE).
- Synthesize minutes in the CEO's voice; post to the boardroom; post each PRIVATE_NOTE to its
  office channel. Never silently drop a disagreement.
- The meeting's output is the run's work queue, priority-ordered by the CEO.

### 2. Execution (the ops work, under CTO direction)
- Work the queue with subagents tiered per the table above; disjoint file ownership across
  concurrent agents; brief them with premises they can refute.
- **Ship each unit as it goes green — do not batch.** Full gate first (`npm run lint`,
  `npm run build`, `npm test`, gitleaks), then follow the `ship-to-prod` skill to completion.
  If the session's permission layer declines any push or merge step, that is FAILED TO
  DELIVER: execute the CTO's push-denial protocol immediately (recovery command + one-click
  link to #mixbase-cto-office) — never a quiet footnote, never a workaround.
- Post one-line progress notes to the boardroom thread as things ship.

### 3. Always human-gated — never autonomous
Destructive or irreversible data operations (deleting user data, account erasure, storage
reaping), new spend or paid infrastructure, pricing/tier changes, Stripe live mode, App Store
resubmission, migration 028 (refuted — never apply), and changes to permission settings or
this governance protocol's authority boundaries. These go to ACTIONS_MATT with a
recommendation and a default-on-silence date where sensible.

### 4. Close of run (CHRO)
- Retro: what shipped, what stalled, briefing defects, lessons → promote durable ones into
  skills/AGENTS.md the same day (via the normal PR gate).
- Append a dated EXEC MEETING section (≤15 lines) to the memory backlog: decisions, ship log,
  action-list delta, any Matt directives received — so the next run starts current.
- Verify Matt's ask-list net-reduced his queue; consolidate if it grew.

## Between runs
The `mixbase-exec-office-hours` routine (hourly, 7am–11pm ET) answers Matt's Slack messages
as the channel's exec and, when it finds fully-gated green work stranded off `origin/main`,
drives it through `ship-to-prod` (same denial-escalation rule). The daily run remains the
deep-work vehicle; office hours keep latency low and delivery continuous.

## Cost discipline (the CFO is watching)
Tier aggressively — most subagent work is sonnet-grade. Opus is for judgment, not plumbing.
If a phase fails, note it in the minutes rather than retrying more than once.
