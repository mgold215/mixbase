---
name: exec-daily-meeting
description: Run the mixBASE daily executive meeting — CEO, CFO, CTO, CHRO independently EVALUATE the work of the ops agents (the mixbase-product-management daily run and sibling automations), grade delivery, remediate stranded shipments, and report to Matt through Slack. Use when the "mixbase-exec-daily" routine fires, or when Matt asks to "run the exec meeting" / "hold the board meeting" / "what do the execs think".
---

# mixBASE Daily Executive Meeting (v3 — independent oversight)

**The executives do not do the ops work. Other agents work; the executives evaluate their
work** (Matt's directive, 2026-08-19). The `mixbase-product-management` daily run and the
other automations operate exactly as before; this meeting runs afterwards, audits what they
did, grades it, fixes delivery failures, and reports to Matt. Exec role definitions:
`.claude/agents/exec-{ceo,cfo,cto,chro}.md`. Design doc:
`docs/superpowers/specs/2026-08-19-executive-layer-design.md`.

## Slack channels (all visible to Matt — his messages are binding directives)

| Channel | ID | Purpose |
|---|---|---|
| #mixbase-boardroom | `C0BS7TTH5CG` | Minutes, run scorecard, decisions, action list |
| #mixbase-ceo-office | `C0BRBJMTXLN` | CEO private feedback ↔ Matt's directives |
| #mixbase-cfo-office | `C0BRH7PHJQL` | CFO private feedback ↔ Matt's directives |
| #mixbase-cto-office | `C0BR7A58JAF` | CTO private feedback ↔ Matt's directives |
| #mixbase-chro-office | `C0BS7TU3KB2` | CHRO private feedback ↔ Matt's directives |

ATTEMPT every Slack call before believing any auth banner. If Slack truly fails, write the
minutes into the memory backlog and flag the outage — never skip the meeting.

## Model tiering for subagents (opus and sonnet where appropriate)

- **opus** — the four execs themselves, adversarial verification of an ops agent's claims,
  anything where a wrong conclusion misleads Matt.
- **sonnet** — mechanical checks: recon SQL, log pulls, greps, smoke tests, Slack posting.

## Protocol

### Phase 0 — Matt's directives
Read all five channels since the last minutes. A directive in an office channel binds that
exec; a boardroom directive binds everyone. Answer any unanswered Matt question first, in-channel.

### Phase 1 — Evidence pack (bounded, ≤ ~10 calls)
1. The ops team's own report: the memory backlog's newest run section (their account of
   what they did — treat as CLAIMS to verify, not facts).
2. Independent checks: prod `/api/health` · `git fetch` + worktree scan (did claimed ships
   actually reach `origin/main`? is green work stranded?) · one Supabase counts SQL ·
   Sentry new-issue check.

### Phase 2 — Executive session (parallel opus subagents)
Each exec evaluates the ops work in their domain and returns REPORT / CHALLENGE /
ACTIONS_AUTO / ACTIONS_MATT / PRIVATE_NOTE:
- **CTO:** did claimed green gates actually pass? did shipped work actually deploy? any
  regression, security drift, or stranded delivery?
- **CEO:** did the run work on the right things? does output match stated priorities?
- **CFO:** what did the run cost vs produce? any spend or waste signal?
- **CHRO:** process quality — briefing defects, duplicated effort across sessions, lessons
  left un-promoted to durable docs, Matt's queue net-reduced or grown?

### Phase 3 — Synthesis (chair, CEO's voice)
Minutes with a **run scorecard**: a letter grade per domain with one line of evidence each,
disagreements resolved or escalated, decisions numbered, action list split auto vs Matt.

### Phase 4 — Publish
Minutes → boardroom; each PRIVATE_NOTE verbatim → its office channel.

### Phase 5 — Remediation auto-lane (the only work execs do themselves)
- Ship stranded fully-gated green work: re-run the full gate on the exact tree
  (`npm run lint`, `npm run build`, `npm test`), then follow `ship-to-prod` to completion.
  If any push/merge is declined by the permission layer: FAILED TO DELIVER — post the exact
  recovery command + one-click PR link to #mixbase-cto-office immediately. Never work around
  a denial; never leave it as a footnote.
- Re-run flaky CI; correct wrong facts in memory; promote durable lessons into skills/AGENTS.md
  via the normal PR gate.
- Everything else is feedback, not action: append a dated EXEC MEETING section (≤15 lines) to
  the memory backlog — evaluations, recommended priorities, Matt directives — for the ops
  agents to read. **The execs recommend; the ops run decides its own execution.**

### Always human-gated — never autonomous
Destructive/irreversible data ops, new spend, pricing/tier changes, Stripe live, App Store
resubmission, migration 028 (refuted — never apply), permission/settings changes. These go to
ACTIONS_MATT with a recommendation and a default-on-silence date where sensible.

## Between meetings
The `mixbase-exec-office-hours` routine (hourly, 7am–11pm ET) answers Matt's Slack messages
as the channel's exec and ships stranded green work it finds — same rules as Phase 5.

## Cost discipline (the CFO is watching)
One meeting ≈ 4 opus subagents + ~20 orchestrator calls. Don't fan out further; don't re-run
execs for polish. If a phase fails, note it in the minutes rather than retrying more than once.
