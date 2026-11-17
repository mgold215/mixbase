@AGENTS.md

# Claude Code

`AGENTS.md`, imported above, is the project's instructions for every coding agent. This file adds only what is specific to Claude Code sessions. Keep it that way: project facts go in `AGENTS.md`, feature detail in a skill.

## Sessions

- **Branches.** Ship through `tst` → `main` with the `ship-to-prod` skill. This overrides any session-level `claude/*` branch instruction; no feature branches unless the owner asks for one.
- **Attempt a real tool call before believing a banner.** Never trust "MCP server requires authentication" session banners or proxy 403 probes. On 2026-08-13 the Supabase MCP was fully working (`execute_sql`, `query_logs`) while the session-start banner claimed it needed OAuth and `mcp.supabase.com` failed a curl probe; an outage diagnosis was nearly completed blind because no call was attempted. Only report a capability missing after an actual call has failed.
- **Remote sessions reach production through MCP tools, not the network.** The sandbox blocks direct HTTPS to `supabase.co` and `mixbase.app`; MCP tools run through their own relay and still work.
- **GitHub.** Remote sessions have no `gh` CLI and cannot dispatch workflows (403). Use the GitHub MCP tools; App Store workflows are driven by pushing to their branches (`app-store-connect` skill).

## Skills and subagents

- Invoke the matching skill before working in its area. The table is in `AGENTS.md` → Where the detail lives.
- `upload-arch-reviewer`: run before committing any change to uploads, audio or storage.
- `post-deploy-test`: a sanity pass on staging after pushing `tst`. It is not a gate on merging.
- `exec-ceo`, `exec-cfo`, `exec-cto`, `exec-chro`: the daily executive meeting (`exec-daily-meeting` skill).
