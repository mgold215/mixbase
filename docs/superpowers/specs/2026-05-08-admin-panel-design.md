# Admin Panel — Design Spec
**Date:** 2026-05-08
**Status:** Approved

---

## Overview

A full admin panel built into the existing mixbase Next.js app at `/admin`. Accessible only to users with `subscription_tier = 'admin'`. Matches the existing dark UI. Includes user management, usage analytics, content moderation, and an embedded Claude assistant that can answer questions and execute admin actions via natural language.

---

## Access Control

- Middleware checks `subscription_tier = 'admin'` on every `/admin` and `/api/admin/*` request.
- Implemented in `src/proxy.ts`: if the path starts with `/admin` or `/api/admin`, fetch the user's profile tier. If not `admin`, redirect to `/dashboard` with a 403.
- No client-side gating — all protection is server-side.

---

## Route Structure

```
/admin                          → redirect to /admin/users
/admin/users                    → Users tab
/admin/usage                    → Usage tab
/admin/content                  → Content tab
/admin/assistant                → Claude Assistant tab

/api/admin/users                GET (list), POST (create)
/api/admin/users/[id]           PATCH (update tier/email), DELETE
/api/admin/stats                GET (usage summary, counts by tier)
/api/admin/chat                 POST (streaming, Claude with tools)
```

---

## UI Layout

Reuses existing design tokens (`var(--bg-page)`, `var(--surface)`, `var(--border)`, `var(--text)`, teal accent `#2dd4bf`). Nav tab bar at the top of the admin area (Users / Usage / Content / Assistant), consistent with how other multi-section pages work in the app.

Each tab is a separate page component under `src/app/admin/`. A shared `AdminLayout` wrapper renders the tab bar and enforces the admin gate server-side.

---

## Tab: Users

**Purpose:** View and manage all user accounts.

**Display:** Table with columns — Email, Tier (badge), Created, Artwork used / limit this month, Actions.

**Actions per row:**
- Change tier — dropdown: free / pro / studio / admin
- Reset this month's usage (artwork + video back to 0)
- Delete account (with confirmation)

**Top of page:**
- "New User" button — modal with email, password, tier fields. Calls `POST /api/admin/users`.

**API backing:**
- `GET /api/admin/users` — joins `auth.users` + `profiles` + current month `mb_usage`. Returns array of `{ id, email, created_at, subscription_tier, artwork_used, video_used }`.
- `POST /api/admin/users` — calls `supabaseAdmin.auth.admin.createUser()` then sets profile tier.
- `PATCH /api/admin/users/[id]` — updates `profiles.subscription_tier`; if `resetUsage` flag set, deletes `mb_usage` row for current month.
- `DELETE /api/admin/users/[id]` — calls `supabaseAdmin.auth.admin.deleteUser()` (cascades via RLS/triggers).

---

## Tab: Usage

**Purpose:** See who's consuming generation credits.

**Display:** Table sorted by artwork_generations desc — Email, Tier, Artwork used, Video used, Month. Highlights anyone near their limit in amber.

**API backing:** `GET /api/admin/stats` — queries `mb_usage` joined to `profiles` and `auth.users` for current month.

---

## Tab: Content

**Purpose:** Read-only view of all projects across all users for moderation.

**Display:** Table — Project title, Owner email, # versions, Created. Clicking a project opens the existing `/projects/[id]` view (admin can see all projects because `supabaseAdmin` bypasses RLS).

**API backing:** Reuses existing `supabaseAdmin` queries, no new routes needed — page fetches directly server-side.

---

## Tab: Assistant

**Purpose:** Natural language interface for admin tasks.

**Display:** Chat UI matching the dark theme — message list, input at bottom, streaming responses. Tool invocations shown inline as pill-style status chips (e.g., `✓ Changed alice@example.com → pro`).

**Claude integration:**
- `POST /api/admin/chat` — receives `{ messages: [...] }`, calls Claude via Anthropic SDK with streaming and a defined tool set.
- Uses `claude-sonnet-4-6` (current model).
- System prompt establishes context: platform name, available tools, current date, instruction to be concise and confirm destructive actions before executing.

**Tools available to Claude:**

| Tool | Description |
|---|---|
| `list_users` | Returns all users with tier and usage |
| `set_user_tier` | Changes a user's subscription tier |
| `reset_user_usage` | Zeros out a user's current-month usage |
| `create_user` | Creates a new account |
| `delete_user` | Deletes a user (asks for confirmation first) |
| `get_stats` | Returns aggregate counts (users by tier, total usage) |

**Streaming:** Uses the Anthropic SDK's `.stream()` method piped into a `ReadableStream` response (same SDK already in use for summarize-feedback). Tool results are streamed back and rendered in the chat as they complete.

**Safety:** Claude is instructed to describe what it's about to do before calling destructive tools (`delete_user`), and the system prompt tells it to refuse if the intent is ambiguous.

---

## Security Model

1. `src/proxy.ts` — adds `/admin` and `/api/admin` path checks. Fetches profile tier for the authenticated user. Non-admins get redirected.
2. Every `/api/admin/*` route independently re-checks the tier via `X-User-Id` header (defense in depth).
3. All DB operations use `supabaseAdmin` (service role), which has full access and bypasses RLS.
4. The Claude assistant tools only call internal `/api/admin/*` routes — Claude never gets direct DB access.

---

## File Structure

```
src/app/admin/
  layout.tsx                  — AdminLayout: tab bar + admin gate
  page.tsx                    — redirects to /admin/users
  users/page.tsx              — Users tab
  usage/page.tsx              — Usage tab
  content/page.tsx            — Content tab
  assistant/page.tsx          — Assistant tab

src/app/api/admin/
  users/route.ts              — GET, POST
  users/[id]/route.ts         — PATCH, DELETE
  stats/route.ts              — GET
  chat/route.ts               — POST (streaming)
```

---

## Out of Scope

- Audit log (who changed what) — can add later
- Email notifications on tier changes — not needed yet
- Bulk operations — not needed yet
- Site-wide feature flags — not needed yet (tiers handle this)
