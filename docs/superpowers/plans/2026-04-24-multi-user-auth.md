# Multi-User Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single shared password with Supabase Auth multi-user accounts (email/password + Google/Apple OAuth), add per-user data ownership with Row-Level Security.

**Architecture:** Supabase Auth handles signup/login/sessions. `@supabase/ssr` manages server-side cookie sessions in Next.js. All tables get `user_id` columns with RLS policies. First signup inherits all existing data. API routes switch from `supabaseAdmin` to authenticated client so RLS enforces access.

**Tech Stack:** `@supabase/ssr`, Supabase Auth, Next.js 16 App Router, PostgreSQL RLS

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `supabase/migrations/006_multi_user_auth.sql` | Create | Profiles table, user_id columns, RLS policies, first-user trigger |
| `src/lib/supabase.ts` | Rewrite | Three clients: browser, server, admin. Types updated with user_id |
| `src/lib/supabase-server.ts` | Create | Server-side authenticated client factory (used by API routes + server components) |
| `src/lib/supabase-browser.ts` | Create | Browser-side authenticated client factory (used by client components) |
| `src/middleware.ts` | Rewrite | Supabase session validation with cookie refresh |
| `src/app/login/page.tsx` | Rewrite | Email/password + Google/Apple social login |
| `src/app/signup/page.tsx` | Create | Account creation page |
| `src/app/auth/callback/route.ts` | Create | OAuth redirect handler |
| `src/app/api/auth/route.ts` | Delete | Old password check — no longer needed |
| `src/app/api/auth/logout/route.ts` | Rewrite | Supabase signOut |
| `src/app/api/projects/route.ts` | Modify | Use authenticated client, add user_id to inserts |
| `src/app/api/projects/[id]/route.ts` | Modify | Use authenticated client |
| `src/app/api/versions/route.ts` | Modify | Use authenticated client |
| `src/app/api/versions/[id]/route.ts` | Modify | Use authenticated client |
| `src/app/api/releases/route.ts` | Modify | Use authenticated client, add user_id to inserts |
| `src/app/api/releases/[id]/route.ts` | Modify | Use authenticated client |
| `src/app/api/collections/route.ts` | Modify | Use authenticated client, add user_id to inserts |
| `src/app/api/collections/[id]/route.ts` | Modify | Use authenticated client |
| `src/app/api/collections/[id]/items/route.ts` | Modify | Use authenticated client |
| `src/app/api/media/route.ts` | Modify | Use authenticated client |
| `src/app/api/generate-artwork/route.ts` | Modify | Use authenticated client |
| `src/app/api/tracks/route.ts` | Modify | Use authenticated client |
| `src/app/api/upload-url/route.ts` | Keep | Stays on supabaseAdmin (service-role needed) |
| `src/app/api/audio/[...path]/route.ts` | Keep | Stays as-is (public read, no auth needed) |
| `src/app/api/tus/route.ts` | Keep | Stays on supabaseAdmin (service-role needed) |
| `src/app/api/tus/[uploadId]/route.ts` | Keep | Stays on supabaseAdmin |
| `src/app/api/feedback/route.ts` | Keep | Stays public (anonymous feedback) |
| `src/app/api/health/route.ts` | Keep | Stays public |
| `src/app/api/db-init/route.ts` | Keep | Stays on supabaseAdmin |
| `src/app/api/visualizer/runway/route.ts` | Modify | Use authenticated client |
| `package.json` | Modify | Add @supabase/ssr dependency |

---

### Task 1: Database Migration — Profiles, User IDs, RLS

**Files:**
- Create: `supabase/migrations/006_multi_user_auth.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/006_multi_user_auth.sql`:

```sql
-- ============================================================================
-- Migration 006: Multi-User Auth
-- Adds user ownership to all tables, enables Row-Level Security,
-- creates profiles table, and sets up first-user migration trigger.
-- ============================================================================

-- 1. Profiles table (auto-populated on signup)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  is_owner boolean default false,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "anyone_can_read_profiles" on profiles
  for select using (true);

create policy "users_update_own_profile" on profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());

-- 2. Add user_id columns (nullable first — migration fills them)

alter table mb_projects
  add column if not exists user_id uuid references auth.users(id);

alter table mb_releases
  add column if not exists user_id uuid references auth.users(id);

alter table mb_collections
  add column if not exists user_id uuid references auth.users(id);

alter table mb_activity
  add column if not exists user_id uuid references auth.users(id);

alter table mb_favorites
  add column if not exists user_id uuid references auth.users(id);

alter table mb_spotify_auth
  add column if not exists user_id uuid references auth.users(id);

-- 3. Indexes on user_id columns
create index if not exists idx_projects_user_id on mb_projects(user_id);
create index if not exists idx_releases_user_id on mb_releases(user_id);
create index if not exists idx_collections_user_id on mb_collections(user_id);
create index if not exists idx_activity_user_id on mb_activity(user_id);

-- 4. Enable RLS on all tables

alter table mb_projects enable row level security;
alter table mb_versions enable row level security;
alter table mb_releases enable row level security;
alter table mb_collections enable row level security;
alter table mb_collection_items enable row level security;
alter table mb_activity enable row level security;
alter table mb_favorites enable row level security;
alter table mb_feedback enable row level security;
alter table mb_spotify_auth enable row level security;
alter table mb_spotify_links enable row level security;
alter table mb_spotify_stats enable row level security;
alter table mb_press_kits enable row level security;
alter table mb_social_posts enable row level security;
alter table mb_curator_submissions enable row level security;

-- 5. Drop old permissive policies from migration 005
drop policy if exists "Enable all access for all users" on mb_spotify_auth;
drop policy if exists "Enable all access for all users" on mb_spotify_links;
drop policy if exists "Enable all access for all users" on mb_spotify_stats;
drop policy if exists "Enable all access for all users" on mb_favorites;
drop policy if exists "Enable all access for all users" on mb_press_kits;
drop policy if exists "Enable all access for all users" on mb_social_posts;
drop policy if exists "Enable all access for all users" on mb_curator_submissions;

-- 6. RLS Policies

-- mb_projects: owner access only
create policy "users_own_projects" on mb_projects
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_versions: access through project ownership
create policy "users_own_versions" on mb_versions
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_versions: public read via share token (for /share/[token] pages)
create policy "public_share_read" on mb_versions
  for select using (share_token is not null);

-- mb_releases: owner access only
create policy "users_own_releases" on mb_releases
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_collections: owner access only
create policy "users_own_collections" on mb_collections
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_collection_items: access through collection ownership
create policy "users_own_collection_items" on mb_collection_items
  for all using (
    collection_id in (select id from mb_collections where user_id = auth.uid())
  ) with check (
    collection_id in (select id from mb_collections where user_id = auth.uid())
  );

-- mb_activity: owner access only
create policy "users_own_activity" on mb_activity
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_favorites: owner access only
create policy "users_own_favorites" on mb_favorites
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_feedback: anyone can insert (public share pages), owner reads
create policy "public_feedback_insert" on mb_feedback
  for insert with check (true);

create policy "owner_reads_feedback" on mb_feedback
  for select using (
    version_id in (
      select v.id from mb_versions v
      join mb_projects p on v.project_id = p.id
      where p.user_id = auth.uid()
    )
  );

-- mb_spotify_auth: owner access only
create policy "users_own_spotify_auth" on mb_spotify_auth
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_spotify_links: access through project ownership
create policy "users_own_spotify_links" on mb_spotify_links
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_spotify_stats: access through spotify_links -> project ownership
create policy "users_own_spotify_stats" on mb_spotify_stats
  for all using (
    spotify_link_id in (
      select sl.id from mb_spotify_links sl
      join mb_projects p on sl.project_id = p.id
      where p.user_id = auth.uid()
    )
  ) with check (
    spotify_link_id in (
      select sl.id from mb_spotify_links sl
      join mb_projects p on sl.project_id = p.id
      where p.user_id = auth.uid()
    )
  );

-- mb_press_kits: access through project ownership
create policy "users_own_press_kits" on mb_press_kits
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_social_posts: access through project ownership
create policy "users_own_social_posts" on mb_social_posts
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_curator_submissions: access through project ownership
create policy "users_own_curator_submissions" on mb_curator_submissions
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- 7. First-user trigger: auto-create profile and migrate existing data
create or replace function handle_new_user()
returns trigger as $$
declare
  user_count int;
begin
  -- Create profile for every new user
  insert into profiles (id, display_name, avatar_url, is_owner)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.raw_user_meta_data->>'avatar_url',
    false
  );

  -- Check if this is the first user
  select count(*) into user_count from profiles;

  if user_count = 1 then
    -- Mark as owner
    update profiles set is_owner = true where id = new.id;

    -- Migrate all existing data to this user
    update mb_projects set user_id = new.id where user_id is null;
    update mb_releases set user_id = new.id where user_id is null;
    update mb_collections set user_id = new.id where user_id is null;
    update mb_activity set user_id = new.id where user_id is null;
    update mb_favorites set user_id = new.id where user_id is null;
    update mb_spotify_auth set user_id = new.id where user_id is null;
  end if;

  return new;
end;
$$ language plpgsql security definer;

-- Drop trigger if it exists (idempotent)
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/006_multi_user_auth.sql
git commit -m "feat: add migration 006 — multi-user auth schema with RLS"
```

---

### Task 2: Install @supabase/ssr and Create Client Utilities

**Files:**
- Modify: `package.json`
- Create: `src/lib/supabase-server.ts`
- Create: `src/lib/supabase-browser.ts`
- Modify: `src/lib/supabase.ts`

- [ ] **Step 1: Install @supabase/ssr**

```bash
cd /Users/moodmixformat/mixbase && npm install @supabase/ssr
```

- [ ] **Step 2: Create server client utility**

Create `src/lib/supabase-server.ts`:

```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'

// Authenticated server client for API routes and server components.
// Carries the user's JWT via cookies — RLS enforces access control.
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // setAll called from Server Component — safe to ignore
            // if middleware is refreshing sessions
          }
        },
      },
    }
  )
}
```

- [ ] **Step 3: Create browser client utility**

Create `src/lib/supabase-browser.ts`:

```typescript
import { createBrowserClient } from '@supabase/ssr'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'

// Browser client for client components.
// Manages session in cookies, auto-refreshes tokens.
export function createClient() {
  return createBrowserClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  )
}
```

- [ ] **Step 4: Update src/lib/supabase.ts — keep exports, add user_id to types**

Add `user_id` to the `Project`, `Release`, `Activity` types. Keep `supabaseAdmin`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, utility functions, and status config. Remove the old `supabase` browser client (replaced by `supabase-browser.ts`).

In `src/lib/supabase.ts`, remove line 8 (`export const supabase = ...`) and add `user_id: string` to these types:

```typescript
// Add to Project type:
  user_id: string

// Add to Release type:
  user_id: string

// Add to Activity type:
  user_id: string
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/supabase-server.ts src/lib/supabase-browser.ts src/lib/supabase.ts
git commit -m "feat: add @supabase/ssr client utilities for multi-user auth"
```

---

### Task 3: Rewrite Middleware for Supabase Session Validation

**Files:**
- Modify: `src/middleware.ts`

- [ ] **Step 1: Rewrite middleware**

Replace the full contents of `src/middleware.ts`:

```typescript
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Routes that never require authentication
const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/auth/callback',
  '/share/',
  '/api/feedback',
  '/api/audio',
  '/api/audio-url',
  '/api/health',
  '/api/db-init',
  '/api/tus',
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow public paths and static assets
  if (
    PUBLIC_PATHS.some(p => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.match(/\.(svg|png|jpg|jpeg|gif|webp|ico)$/)
  ) {
    return NextResponse.next()
  }

  // Create a response object that we can modify
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU',
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Update request cookies (for downstream server components)
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          // Create fresh response with updated request
          supabaseResponse = NextResponse.next({ request })
          // Set cookies on response (sent back to browser)
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: Do not add code between createServerClient and auth.getUser()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // IMPORTANT: Return supabaseResponse — it carries refreshed session cookies
  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] **Step 2: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: replace password middleware with Supabase session auth"
```

---

### Task 4: Create OAuth Callback Route

**Files:**
- Create: `src/app/auth/callback/route.ts`

- [ ] **Step 1: Create the callback route**

Create `src/app/auth/callback/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

// GET /auth/callback — handles OAuth redirect from Google/Apple
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const response = NextResponse.redirect(`${origin}${next}`)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU',
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`)
  }

  return response
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/auth/callback/route.ts
git commit -m "feat: add OAuth callback route for Google/Apple sign-in"
```

---

### Task 5: Rewrite Login Page

**Files:**
- Modify: `src/app/login/page.tsx`

- [ ] **Step 1: Rewrite login page with email/password + social buttons**

Replace the full contents of `src/app/login/page.tsx`:

```tsx
'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'

const STYLES = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulseGlow {
    0%, 100% { box-shadow: 0 0 0px 0px rgba(45,212,191,0); }
    50%       { box-shadow: 0 0 18px 4px rgba(45,212,191,0.35); }
  }
  .login-btn:hover:not(:disabled) {
    animation: pulseGlow 1.4s ease infinite;
  }
`

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleEmailLogin(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/dashboard')
      router.refresh()
    }
  }

  async function handleOAuth(provider: 'google' | 'apple') {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (error) setError(error.message)
  }

  return (
    <>
      <style>{STYLES}</style>

      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: 'var(--bg-page)', position: 'relative', overflow: 'hidden' }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 70% 50% at 50% 50%, rgba(45,212,191,0.07) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        <div className="w-full max-w-sm" style={{ position: 'relative', zIndex: 1 }}>
          <div
            className="text-center mb-10"
            style={{ animation: 'fadeUp 0.5s ease both' }}
          >
            <h1 className="text-3xl font-bold tracking-[0.04em] font-[family-name:var(--font-jost)]">
              <span style={{ color: 'var(--text)' }}>mix</span>
              <span style={{ color: 'var(--accent)' }}>BASE</span>
            </h1>
            <p className="text-xs uppercase tracking-[0.2em] mt-1" style={{ color: '#86efac' }}>ROUGH-TO-RELEASE</p>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>Track the evolution of your mixes</p>
          </div>

          <div
            className="rounded-2xl p-8"
            style={{
              animation: 'fadeUp 0.5s ease 0.1s both',
              backgroundColor: 'rgba(15,21,19,0.82)',
              border: '1px solid var(--border)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          >
            {/* Social login buttons */}
            <div className="space-y-3 mb-6">
              <button
                type="button"
                onClick={() => handleOAuth('google')}
                className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                Continue with Google
              </button>
              <button
                type="button"
                onClick={() => handleOAuth('apple')}
                className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
                Continue with Apple
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
              <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>or</span>
              <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
            </div>

            {/* Email/password form */}
            <form onSubmit={handleEmailLogin} className="space-y-4">
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  autoFocus
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>

              {error && (
                <p className="text-red-400 text-sm">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading || !email || !password}
                className="login-btn w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            <p className="text-center text-sm mt-5" style={{ color: 'var(--text-muted)' }}>
              No account?{' '}
              <a href="/signup" className="underline" style={{ color: 'var(--accent)' }}>Create one</a>
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat: rewrite login page with email/password + Google/Apple OAuth"
```

---

### Task 6: Create Signup Page

**Files:**
- Create: `src/app/signup/page.tsx`

- [ ] **Step 1: Create signup page**

Create `src/app/signup/page.tsx`:

```tsx
'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'

const STYLES = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleSignup(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: displayName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setSuccess(true)
    }
  }

  async function handleOAuth(provider: 'google' | 'apple') {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (error) setError(error.message)
  }

  if (success) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: 'var(--bg-page)' }}
      >
        <div className="w-full max-w-sm text-center">
          <h1 className="text-2xl font-bold mb-4" style={{ color: 'var(--text)' }}>Check your email</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            We sent a confirmation link to <strong style={{ color: 'var(--text)' }}>{email}</strong>.
            Click it to activate your account.
          </p>
          <a
            href="/login"
            className="inline-block mt-6 text-sm underline"
            style={{ color: 'var(--accent)' }}
          >
            Back to sign in
          </a>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{STYLES}</style>
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: 'var(--bg-page)', position: 'relative', overflow: 'hidden' }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 70% 50% at 50% 50%, rgba(45,212,191,0.07) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        <div className="w-full max-w-sm" style={{ position: 'relative', zIndex: 1 }}>
          <div className="text-center mb-10" style={{ animation: 'fadeUp 0.5s ease both' }}>
            <h1 className="text-3xl font-bold tracking-[0.04em] font-[family-name:var(--font-jost)]">
              <span style={{ color: 'var(--text)' }}>mix</span>
              <span style={{ color: 'var(--accent)' }}>BASE</span>
            </h1>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>Create your account</p>
          </div>

          <div
            className="rounded-2xl p-8"
            style={{
              animation: 'fadeUp 0.5s ease 0.1s both',
              backgroundColor: 'rgba(15,21,19,0.82)',
              border: '1px solid var(--border)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          >
            {/* Social signup buttons */}
            <div className="space-y-3 mb-6">
              <button
                type="button"
                onClick={() => handleOAuth('google')}
                className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                Sign up with Google
              </button>
              <button
                type="button"
                onClick={() => handleOAuth('apple')}
                className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
                Sign up with Apple
              </button>
            </div>

            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
              <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>or</span>
              <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
            </div>

            <form onSubmit={handleSignup} className="space-y-4">
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  autoFocus
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button
                type="submit"
                disabled={loading || !email || !password}
                className="w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
              >
                {loading ? 'Creating account...' : 'Create Account'}
              </button>
            </form>

            <p className="text-center text-sm mt-5" style={{ color: 'var(--text-muted)' }}>
              Already have an account?{' '}
              <a href="/login" className="underline" style={{ color: 'var(--accent)' }}>Sign in</a>
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/signup/page.tsx
git commit -m "feat: add signup page with email/password + social auth"
```

---

### Task 7: Rewrite Auth API Routes

**Files:**
- Modify: `src/app/api/auth/route.ts`
- Modify: `src/app/api/auth/logout/route.ts`

- [ ] **Step 1: Replace old password auth with a redirect**

Replace `src/app/api/auth/route.ts`:

```typescript
import { NextResponse } from 'next/server'

// Old password auth removed — Supabase Auth handles login client-side.
// This route returns a 410 Gone so any old clients get a clear signal.
export async function POST() {
  return NextResponse.json(
    { error: 'Password auth removed. Use /login for Supabase Auth.' },
    { status: 410 }
  )
}
```

- [ ] **Step 2: Rewrite logout to use Supabase signOut**

Replace `src/app/api/auth/logout/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// POST /api/auth/logout — sign out via Supabase and clear session cookies
export async function POST() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/auth/route.ts src/app/api/auth/logout/route.ts
git commit -m "feat: replace password auth API with Supabase Auth signOut"
```

---

### Task 8: Update API Routes to Use Authenticated Client

Every API route that currently imports `supabaseAdmin` for user-facing queries must switch to the authenticated server client. This makes RLS enforce per-user access automatically.

**Routes that switch to authenticated client:**
- `src/app/api/projects/route.ts`
- `src/app/api/projects/[id]/route.ts`
- `src/app/api/versions/route.ts`
- `src/app/api/versions/[id]/route.ts`
- `src/app/api/releases/route.ts`
- `src/app/api/releases/[id]/route.ts`
- `src/app/api/collections/route.ts`
- `src/app/api/collections/[id]/route.ts`
- `src/app/api/collections/[id]/items/route.ts`
- `src/app/api/media/route.ts`
- `src/app/api/generate-artwork/route.ts`
- `src/app/api/tracks/route.ts`
- `src/app/api/visualizer/runway/route.ts`

**Routes that stay on supabaseAdmin (no change):**
- `src/app/api/upload-url/route.ts` (service-role for signed URLs)
- `src/app/api/audio/[...path]/route.ts` (public, no auth)
- `src/app/api/tus/route.ts` (service-role for uploads)
- `src/app/api/tus/[uploadId]/route.ts` (service-role)
- `src/app/api/feedback/route.ts` (public)
- `src/app/api/health/route.ts` (public)
- `src/app/api/db-init/route.ts` (admin only)

**Files:**
- Modify: all 13 routes listed above

- [ ] **Step 1: Update projects route**

In `src/app/api/projects/route.ts`, make these changes:

1. Replace import: `import { supabaseAdmin } from '@/lib/supabase'` → `import { createClient } from '@/lib/supabase-server'`
2. At the top of each handler, add: `const supabase = await createClient()`
3. Replace all `supabaseAdmin` references with `supabase`
4. In POST, add `user_id` to the activity insert by getting the user:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

export async function GET() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('mb_projects')
    .select('*')
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { title, genre, bpm, key_signature } = body

  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('mb_projects')
    .insert({ title: title.trim(), genre, bpm, key_signature, user_id: user.id })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabase.from('mb_activity').insert({
    type: 'project_created',
    project_id: data.id,
    description: `Project "${data.title}" created`,
    user_id: user.id,
  })

  return NextResponse.json(data, { status: 201 })
}
```

- [ ] **Step 2: Update all remaining routes with the same pattern**

Apply the same transformation to each route file:
1. Replace `import { supabaseAdmin } from '@/lib/supabase'` with `import { createClient } from '@/lib/supabase-server'`
2. Add `const supabase = await createClient()` at the top of each handler
3. Replace `supabaseAdmin` with `supabase`
4. For any `INSERT` that targets a table with `user_id`, get the user and include `user_id: user.id`
5. For `GET`/`PATCH`/`DELETE` handlers, RLS handles filtering automatically — no code changes needed beyond the client swap

Routes with `user_id` inserts needed:
- `src/app/api/projects/route.ts` — POST inserts to `mb_projects` + `mb_activity`
- `src/app/api/versions/route.ts` — POST inserts to `mb_activity`
- `src/app/api/releases/route.ts` — POST inserts to `mb_releases` + `mb_activity`
- `src/app/api/collections/route.ts` — POST inserts to `mb_collections`

Routes that only need the client swap (no user_id inserts):
- `src/app/api/projects/[id]/route.ts`
- `src/app/api/versions/[id]/route.ts`
- `src/app/api/releases/[id]/route.ts`
- `src/app/api/collections/[id]/route.ts`
- `src/app/api/collections/[id]/items/route.ts`
- `src/app/api/media/route.ts`
- `src/app/api/generate-artwork/route.ts`
- `src/app/api/tracks/route.ts`
- `src/app/api/visualizer/runway/route.ts`

For each of these, the transformation is mechanical:

```typescript
// Before (every route):
import { supabaseAdmin } from '@/lib/supabase'
// ...
const { data, error } = await supabaseAdmin.from('table').select('*')

// After (every route):
import { createClient } from '@/lib/supabase-server'
// ...
const supabase = await createClient()
const { data, error } = await supabase.from('table').select('*')
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/projects/route.ts src/app/api/projects/\[id\]/route.ts \
  src/app/api/versions/route.ts src/app/api/versions/\[id\]/route.ts \
  src/app/api/releases/route.ts src/app/api/releases/\[id\]/route.ts \
  src/app/api/collections/route.ts src/app/api/collections/\[id\]/route.ts \
  src/app/api/collections/\[id\]/items/route.ts \
  src/app/api/media/route.ts src/app/api/generate-artwork/route.ts \
  src/app/api/tracks/route.ts src/app/api/visualizer/runway/route.ts
git commit -m "feat: switch API routes from supabaseAdmin to authenticated client"
```

---

### Task 9: Update Client Components That Import Old Supabase Client

**Files:**
- Grep for: `from '@/lib/supabase'` in client components and update to `from '@/lib/supabase-browser'`

- [ ] **Step 1: Find all client-side imports of the old supabase client**

```bash
grep -rn "from '@/lib/supabase'" src/ --include='*.tsx' --include='*.ts' | grep -v 'route.ts' | grep -v 'supabase.ts' | grep -v 'supabase-server.ts' | grep -v 'supabase-browser.ts'
```

For each file that imports `supabase` (the browser client) from `@/lib/supabase`:
- If it uses `supabase.from(...)` for queries in a `'use client'` component, change import to `import { createClient } from '@/lib/supabase-browser'` and add `const supabase = createClient()` at the top of the component.
- If it only imports types (`Project`, `Version`, etc.) or utility functions (`audioProxyUrl`, `formatDuration`), keep importing from `@/lib/supabase` — those exports stay there.

- [ ] **Step 2: Commit**

```bash
git add -u src/
git commit -m "feat: update client components to use supabase-browser client"
```

---

### Task 10: Run Migration and Verify Build

- [ ] **Step 1: Run the migration against Supabase**

```bash
# Connect to Supabase and run migration 006
cd /Users/moodmixformat/mixbase
npx supabase db push --linked
```

If `supabase db push` isn't available or fails, run the SQL directly via the Supabase dashboard SQL editor at:
`https://supabase.com/dashboard/project/mdefkqaawrusoaojstpq/sql`

Paste the contents of `supabase/migrations/006_multi_user_auth.sql` and execute.

- [ ] **Step 2: Verify the build compiles**

```bash
cd /Users/moodmixformat/mixbase && npm run build
```

Fix any TypeScript errors. Common issues:
- Components importing the deleted `supabase` export — switch to `createClient()` from `supabase-browser.ts`
- Missing `user_id` in insert objects — add it
- Type mismatches on `user_id` field

- [ ] **Step 3: Test locally**

```bash
npm run dev
```

1. Visit `http://localhost:3000/login` — should show email/password + social buttons
2. Visit `http://localhost:3000/signup` — should show signup form
3. Create an account with email/password
4. Check Supabase dashboard → Authentication → Users — new user should appear
5. Check `profiles` table — profile row with `is_owner = true` should exist
6. Check `mb_projects` table — all existing projects should have `user_id` set to your new user ID
7. Visit `/dashboard` — should show your projects (same as before)
8. Visit `/share/[any-existing-token]` — should still work without login

- [ ] **Step 4: Commit any fixes and push**

```bash
git add -u
git commit -m "fix: resolve build errors from multi-user auth migration"
git push origin mobile-app
```

---

### Task 11: Configure Supabase Auth Providers (Manual)

These are dashboard configurations, not code changes.

- [ ] **Step 1: Enable email/password provider**

Supabase dashboard → Authentication → Providers → Email:
- Enable email provider (should be on by default)
- Confirm email: ON (sends verification email)
- Secure email change: ON

- [ ] **Step 2: Configure Google OAuth** (optional — can defer)

1. Google Cloud Console → Create OAuth 2.0 credentials
2. Authorized redirect URI: `https://mdefkqaawrusoaojstpq.supabase.co/auth/v1/callback`
3. Supabase dashboard → Authentication → Providers → Google → paste Client ID + Secret

- [ ] **Step 3: Configure Apple Sign In** (optional — can defer, needed for iOS App Store)

1. Apple Developer account → Certificates, Identifiers & Profiles → Service IDs
2. Create Service ID with Sign In with Apple capability
3. Configure domains + return URL: `https://mdefkqaawrusoaojstpq.supabase.co/auth/v1/callback`
4. Generate private key
5. Supabase dashboard → Authentication → Providers → Apple → paste Service ID + Private Key

- [ ] **Step 4: Set redirect URLs**

Supabase dashboard → Authentication → URL Configuration:
- Site URL: `https://www.mixbase.app`
- Redirect URLs:
  - `https://www.mixbase.app/auth/callback`
  - `https://mixbase-staging.up.railway.app/auth/callback`
  - `http://localhost:3000/auth/callback`
