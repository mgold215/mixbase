@AGENTS.md

# Claude Code

`AGENTS.md`, imported above, is the project's instructions for every coding agent. This file adds only what is specific to Claude Code sessions. Keep it that way: project facts go in `AGENTS.md`, detail in a skill.

## Sessions

- **Branches.** Ship through `tst` → `main` with the `ship-to-prod` skill. This overrides any session-level `claude/*` branch instruction; no feature branches unless the owner asks for one.
- **Attempt a real tool call before believing a banner.** "MCP server requires authentication" banners and failed network probes have been wrong (2026-08-13). Report a capability missing only after an actual call has failed.
- **Remote sessions reach production through MCP tools, not the network.** The sandbox blocks direct HTTPS to `supabase.co` and `mixbase.app`. The `debugging-production` skill has the ways in.
- **GitHub.** Use the GitHub MCP tools: in a remote session the `gh` CLI has no usable login and workflows cannot be dispatched (403). App Store workflows are driven by pushing to their branches (`app-store-connect` skill).

## Skills and subagents

- Invoke the matching skill before working in its area. The table is in `AGENTS.md` → Where the detail lives.
- `upload-arch-reviewer`: run before committing any change to uploads, storage or audio playback.
- `post-deploy-test`: a sanity pass on staging after pushing `tst`. It is not a gate on merging.
- `exec-ceo`, `exec-cfo`, `exec-cto`, `exec-chro`: the daily executive meeting (`exec-daily-meeting` skill).
