# mixBASE Executive Layer — Design

**Date:** 2026-08-19 · **Status:** Approved for build (autonomous session; Matt reviews after)

## Purpose

Put an accountable executive layer over mixBASE's automated operations. Four AI executives
(CEO, CFO, CTO, CHRO) meet daily, review real production/cost/process data, make decisions,
execute the safe ones, and report to Matt through Slack channels he can read and reply in.

The layer sits ON TOP of the existing `mixbase-product-management` daily task (the "ops team").
It does not replace it — it reads that task's output (the memory backlog), audits it, and directs it.

## Roles

| Exec | Owns | Primary data sources |
|---|---|---|
| CEO | Product direction, growth, the meeting itself | Activity signals (storage objects + table rows — NOT `mb_usage`), App Store state, roadmap queue |
| CFO | Cost & revenue | Railway usage, Supabase storage bytes, AI API spend surface, Stripe state, unit economics |
| CTO | Prod health, deploys, security | `/api/health`, git remotes vs local worktrees, GitHub Actions, Sentry, migrations backlog |
| CHRO | The agent workforce & process quality | Run retrospectives, briefing defects, skill/memory hygiene, Matt's decision-backlog age |

## Slack topology (all visible to Matt)

- `#mixbase-boardroom` (public, `C0BS7TTH5CG`) — daily meeting minutes, decisions, action list
- `#mixbase-ceo-office` (private, `C0BRBJMTXLN`) — CEO's candid private feedback; Matt's directives to the CEO
- `#mixbase-cfo-office` (private, `C0BRH7PHJQL`) — same, CFO
- `#mixbase-cto-office` (private, `C0BR7A58JAF`) — same, CTO
- `#mixbase-chro-office` (private, `C0BS7TU3KB2`) — same, CHRO

Matt's messages in any office channel are standing directives: each exec reads their channel
at the start of every meeting and treats Matt's replies as binding.

## Daily meeting protocol (the `exec-daily-meeting` skill)

1. **Read directives** — new Matt messages in the 5 channels since the last meeting.
2. **Fact pack** — memory backlog, prod health, git remote-vs-local scan, one Supabase count query,
   Sentry/Railway quick status. Bounded (≤ ~10 tool calls).
3. **Executive session** — the four execs run as parallel subagents. Each returns: a ≤5-bullet
   domain report, one challenge to another exec, proposed actions split into
   auto-executable vs needs-Matt, and a private feedback note.
4. **Synthesis** — minutes in the CEO's voice: state of the business, disagreements and how they
   were resolved, decisions, action-list delta.
5. **Publish** — minutes to the boardroom; each private note to its office channel.
6. **Execute** — only the auto-executable class (see guardrails), logged in a boardroom thread.

## Guardrails — what execs may do without Matt

**Allowed (reversible, already-sanctioned paths):** ship fully-gated green work via the
`ship-to-prod` skill (lint+build+tests+gitleaks green); re-run CI; post to Slack; update
memory/skills through the normal PR gate.

**Never without Matt:** anything destructive (deletes, reaping, `--force`), spend increases,
pricing/tier changes, Stripe live mode, App Store resubmission (explicitly withdrawn at Matt's
request 2026-08-14), applying refuted migration 028, new paid infrastructure.

## Data honesty rules

- `mb_usage` cannot see owner/admin activity since 2026-08-02 — never derive product conclusions
  from it. Use storage objects and table rows.
- ~7 profiles, ~2 active humans: every trend is directional, never statistically significant.
- Numbers in reports must name their source; a claim with no source is an opinion.

## Scheduling & relationship to the ops agents (v3 — Matt's final directive, 2026-08-19)

**The executives are independent oversight. Other agents work; the executives evaluate their
work.** The `mixbase-product-management` daily run and sibling automations operate exactly as
before. The `mixbase-exec-daily` routine fires afterwards (~8:06 AM ET): the four execs treat
the ops run's report as claims, verify them independently, grade the run (scorecard in the
minutes), remediate delivery failures (shipping stranded fully-gated green work is the only
work execs do themselves), and feed evaluations + recommended priorities back through the
memory backlog — the ops agents read them as input, not orders. Subagent tiering: opus for
the execs and any verification where a wrong conclusion misleads Matt; sonnet for mechanical
checks. `mixbase-exec-office-hours` (hourly, 7am–11pm ET) answers Matt's Slack messages
between meetings and ships stranded green work under the same rules.

(A v2 iteration briefly had the exec layer *govern* the ops run; Matt rejected it the same
evening — evaluation, not takeover.)

## Alternatives considered

- **One "chief of staff" agent instead of four execs** — cheaper, but loses the adversarial
  cross-examination (each exec must challenge another), which is the main quality mechanism.
- **GitHub Actions + Slack webhooks instead of a scheduled Claude routine** — more robust headless,
  but requires new Slack bot tokens and re-implements agent logic outside Claude Code; the existing
  daily task already proves scheduled routines reach all MCP tools.
