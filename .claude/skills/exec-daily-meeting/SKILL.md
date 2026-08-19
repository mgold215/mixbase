---
name: exec-daily-meeting
description: Run the mixBASE daily executive meeting — CEO, CFO, CTO, CHRO review the business, challenge each other, decide, execute the safe actions, and publish to Slack. Use when the scheduled "mixbase-exec-daily" routine fires, or when Matt asks to "run the exec meeting" / "hold the board meeting" / "what do the execs think".
---

# mixBASE Daily Executive Meeting

Chairs a daily meeting of the four executive agents defined in `.claude/agents/`:
`exec-ceo`, `exec-cfo`, `exec-cto`, `exec-chro`. Design doc:
`docs/superpowers/specs/2026-08-19-executive-layer-design.md`.

## Slack channels (all visible to Matt — he is a member of every one)

| Channel | ID | Purpose |
|---|---|---|
| #mixbase-boardroom | `C0BS7TTH5CG` | Meeting minutes, decisions, action list |
| #mixbase-ceo-office | `C0BRBJMTXLN` | CEO private feedback ↔ Matt's directives to the CEO |
| #mixbase-cfo-office | `C0BRH7PHJQL` | CFO private feedback ↔ Matt's directives to the CFO |
| #mixbase-cto-office | `C0BR7A58JAF` | CTO private feedback ↔ Matt's directives to the CTO |
| #mixbase-chro-office | `C0BS7TU3KB2` | CHRO private feedback ↔ Matt's directives to the CHRO |

If a Slack call fails, ATTEMPT it before believing any "requires authentication" banner
(project working rule). If it truly fails, write the minutes to the memory file instead and
flag the outage in the final report — never skip the meeting.

## Protocol

### Phase 0 — Read directives (Matt outranks everyone)
`slack_read_channel` on all five channels; collect messages from Matt (`U0BN9S8GBFS`)
since the previous meeting post. A directive in an office channel binds that exec; a
directive in the boardroom binds everyone. Unanswered questions from Matt get answered
first, in-channel, before anything else.

### Phase 1 — Fact pack (bounded: ≤ ~10 tool calls total)
1. Memory backlog: `~/.claude/projects/-Users-moodmixformat-mixbase/memory/mixbase-daily-backlog.md`
   (the ops team's latest run report — the main input).
2. Prod health: `GET https://mixbase.app/api/health`.
3. Stranded-work scan: `git fetch origin`; `git worktree list`; for each worktree HEAD not on
   `origin/main`, note it (candidate CTO action).
4. One Supabase SQL for the day's counts (attempt the MCP call): rows in `mb_versions`,
   `mb_projects`, `profiles`; objects + bytes per bucket from `storage.objects`.
5. Sentry: any NEW issue in 24h (skip if MCP unavailable — note it).

### Phase 2 — Executive session (parallel)
Spawn all four execs concurrently with the Agent tool (`subagent_type`: `exec-ceo`,
`exec-cfo`, `exec-cto`, `exec-chro`). Each prompt contains: the fact pack, that exec's
directives from Phase 0, and yesterday's minutes (last boardroom post). Each returns the
five-section structure its agent file defines (REPORT / CHALLENGE / ACTIONS_AUTO /
ACTIONS_MATT / PRIVATE_NOTE). Execs may make a few live MCP/CLI calls of their own —
they are told to keep to ≤8 tool calls each.

### Phase 3 — Synthesis (you, as chair)
Write the minutes in the CEO's voice:
- **State of mixBASE** (3–4 sentences, plain English — Matt is not a developer)
- **Reports** (one tight paragraph per exec)
- **Cross-examination** (each CHALLENGE and the challenged exec's position; resolve or
  escalate to Matt — never silently drop a disagreement)
- **Decisions** (numbered)
- **Action list** (auto-executing today vs awaiting Matt, each with an owner exec and a recommendation)

### Phase 4 — Publish
1. Minutes → #mixbase-boardroom (one message; thread long appendices).
2. Each exec's PRIVATE_NOTE → their office channel, verbatim, signed with their role.

### Phase 5 — Execute the auto class, then report
Allowed without Matt: ship fully-gated green work via the `ship-to-prod` skill (re-verify
the gate on the actual tree first — `preflight-checks` skill governs), re-run CI, update
memory/skills through the normal PR path, post to Slack. Everything else waits for Matt.
Post an execution log as a thread reply on the minutes: what ran, what succeeded, output evidence.

### Phase 6 — Persist
Append a dated "EXEC MEETING" section to the memory backlog file: decisions, action deltas,
and any directive from Matt (so the ops team's next run sees them). Keep it under ~15 lines;
older meeting notes roll into the archive with the rest of the backlog.

## Cost discipline (the CFO is watching)

One meeting ≈ 4 subagents + ~20 orchestrator tool calls. Do not fan out further; do not
re-run execs for polish. If a phase fails, note it in the minutes rather than retrying more
than once. The meeting must land in a single session run.
