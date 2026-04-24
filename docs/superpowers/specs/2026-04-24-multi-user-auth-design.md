# Multi-User Auth Architecture — Design Spec

## Overview

Replace mixbase's single shared password with proper multi-user accounts using Supabase Auth. Users sign up with email/password or social login (Google, Apple). All data becomes user-owned with Row-Level Security enforcing isolation. Existing data migrates to the first account created.

## Auth Provider

Supabase Auth (built into the existing Supabase project `mdefkqaawrusoaojstpq`).

### Login Methods

- **Email + password** — native Supabase Auth signup/signin
- **Google OAuth** — configured in Supabase dashboard + Google Cloud Console
- **Apple Sign In** — configured in Supabase dashboard + Apple Developer account (required for iOS App Store)

### Session Management

- **Web**: `@supabase/ssr` handles cookies, server-side session validation, and token refresh
- **iOS**: Supabase Swift SDK handles JWT storage in Keychain, refresh tokens, session persistence
- Access tokens expire after 1 hour (Supabase default), SDK auto-refreshes
- Refresh tokens never expire, single-use

### What Gets Removed

- `MIXBASE_PASSWORD` env var — no longer needed
- `SESSION_SECRET` env var — no longer needed
- `mb-session` cookie — replaced by Supabase session cookies
- Current `/api/auth` password check endpoint — replaced by Supabase Auth flow
- Current middleware password validation — replaced by Supabase session validation

## Database Changes

### New Table: `profiles`

```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  is_owner boolean default false,
  created_at timestamptz default now()
);
```

Auto-populated via a Supabase database trigger on `auth.users` insert.

### Add `user_id` to Existing Tables

Tables that get a `user_id uuid references auth.users(id)` column:

| Table | Column Added | Notes |
|-------|-------------|-------|
| `mb_projects` | `user_id` | NOT NULL after migration |
| `mb_releases` | `user_id` | NOT NULL after migration |
| `mb_collections` | `user_id` | NOT NULL after migration |
| `mb_activity` | `user_id` | NOT NULL after migration |
| `mb_favorites` | `user_id` | NOT NULL, add to unique constraint |
| `mb_spotify_auth` | `user_id` | NOT NULL |

Tables that inherit ownership through foreign keys (no `user_id` needed):

| Table | Inherits Via |
|-------|-------------|
| `mb_versions` | `project_id` → `mb_projects.user_id` |
| `mb_collection_items` | `collection_id` → `mb_collections.user_id` |
| `mb_feedback` | Public (anonymous feedback on share links) |
| `mb_press_kits` | `project_id` → `mb_projects.user_id` |
| `mb_social_posts` | `project_id` → `mb_projects.user_id` |
| `mb_curator_submissions` | `project_id` → `mb_projects.user_id` |
| `mb_spotify_links` | `project_id` → `mb_projects.user_id` |
| `mb_spotify_stats` | `spotify_link_id` → `mb_spotify_links` → `mb_projects.user_id` |

### Migration Strategy

1. Add `user_id` columns as nullable first
2. First-user trigger populates all existing rows (see First-User Migration below)
3. Alter columns to NOT NULL after migration

## Row-Level Security (RLS)

Enable RLS on all tables. Every table gets `alter table <name> enable row level security`.

### Policies

**mb_projects:**
```sql
-- Owner can do everything with their projects
create policy "users_own_projects" on mb_projects
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**mb_versions:**
```sql
-- Owner access through project ownership
create policy "users_own_versions" on mb_versions
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- Public read access via share token (for /share/[token] pages)
create policy "public_share_access" on mb_versions
  for select using (share_token is not null);
```

**mb_releases:**
```sql
create policy "users_own_releases" on mb_releases
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**mb_collections:**
```sql
create policy "users_own_collections" on mb_collections
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**mb_collection_items:**
```sql
create policy "users_own_collection_items" on mb_collection_items
  for all using (
    collection_id in (select id from mb_collections where user_id = auth.uid())
  ) with check (
    collection_id in (select id from mb_collections where user_id = auth.uid())
  );
```

**mb_activity:**
```sql
create policy "users_own_activity" on mb_activity
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**mb_favorites:**
```sql
create policy "users_own_favorites" on mb_favorites
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**mb_feedback:**
```sql
-- Anyone can submit feedback (public share pages)
create policy "public_feedback_insert" on mb_feedback
  for insert with check (true);

-- Only project owner can read feedback on their versions
create policy "owner_reads_feedback" on mb_feedback
  for select using (
    version_id in (
      select v.id from mb_versions v
      join mb_projects p on v.project_id = p.id
      where p.user_id = auth.uid()
    )
  );
```

**mb_press_kits, mb_social_posts, mb_curator_submissions:**
```sql
-- Access through project ownership
create policy "users_own_<table>" on <table>
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );
```

**mb_spotify_auth:**
```sql
create policy "users_own_spotify_auth" on mb_spotify_auth
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**mb_spotify_links, mb_spotify_stats:** Access through project ownership chain.

**profiles:**
```sql
-- Users can read any profile (for displaying collaborator names)
create policy "public_read_profiles" on profiles
  for select using (true);

-- Users can only update their own profile
create policy "users_update_own_profile" on profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());
```

### Storage Bucket Policies

Update `mf-audio` and `mf-artwork` bucket policies:
- Authenticated users can upload to their own folder: `<user_id>/<filename>`
- Public read stays the same (audio proxy and artwork display)
- Service-role key still used for upload URL generation (bypasses size limits)

## First-User Migration

### Trigger: Auto-assign ownership to first account

```sql
create or replace function handle_first_user()
returns trigger as $$
begin
  -- Create profile
  insert into profiles (id, display_name, is_owner)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), false);

  -- Check if this is the first user
  if (select count(*) from profiles) = 1 then
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_first_user();
```

After the first user signs up and data is migrated, alter all `user_id` columns to NOT NULL via a follow-up migration (run manually after first signup).

## Web App Changes

### Supabase Client (`src/lib/supabase.ts`)

Replace the current two-client setup with three:

```typescript
// Server-side authenticated client (API routes, server components)
// Uses @supabase/ssr createServerClient with cookie handling
// Carries the user's JWT — RLS enforces access control
export function createServerSupabaseClient(cookies)

// Browser-side authenticated client (client components)
// Uses @supabase/ssr createBrowserClient
// Auto-refreshes tokens, manages session in cookies
export function createBrowserSupabaseClient()

// Admin client (service-role — upload URLs, audio proxy, migrations)
// Same as current supabaseAdmin — bypasses RLS
export const supabaseAdmin = createClient(URL, SERVICE_ROLE_KEY)
```

### Middleware (`src/middleware.ts`)

Replace password cookie check with Supabase session validation:

```typescript
// Use @supabase/ssr to read session from cookies
// If valid session → allow request
// If no session → redirect to /login
// Public paths unchanged: /login, /share/, /api/feedback, /api/audio, /api/health, /api/tus
// Add new public paths: /signup, /auth/callback (OAuth redirect)
```

### Login Page (`src/app/login/page.tsx`)

Replace password input with:
- Email + password form (sign in)
- "Sign in with Google" button
- "Sign in with Apple" button
- "Create account" link → signup page

### New: Signup Page (`src/app/signup/page.tsx`)

- Email + password + display name
- "Sign up with Google" button
- "Sign up with Apple" button
- Email verification flow (Supabase sends confirmation email)

### New: Auth Callback Route (`src/app/auth/callback/route.ts`)

Handles OAuth redirect from Google/Apple:
- Exchanges auth code for session
- Sets session cookies
- Redirects to /dashboard

### API Routes

All API routes that currently use `supabaseAdmin` for user-facing queries switch to the authenticated server client. This means RLS automatically filters by user. `supabaseAdmin` is kept only for:
- `/api/upload-url` — generating signed upload URLs (service-role needed)
- `/api/audio/[...path]` — audio proxy (no user context needed, public read)
- `/api/tus` — chunked uploads (service-role needed to bypass size limits)
- `/api/db-init` — schema initialization (admin only)

### Share Pages (`/share/[token]`)

No changes. These remain fully public. The share page queries versions by `share_token` using the anon client, which works because the `public_share_access` RLS policy allows SELECT on versions with a non-null share_token.

## iOS App Changes

### Auth Flow

Replace the empty password gate with Supabase Swift SDK auth:

```swift
// Initialize with Supabase Swift SDK
let supabase = SupabaseClient(
  supabaseURL: URL(string: "https://mdefkqaawrusoaojstpq.supabase.co")!,
  supabaseKey: "anon-key"
)

// Email/password sign in
try await supabase.auth.signIn(email: email, password: password)

// Apple Sign In (uses ASAuthorizationController)
try await supabase.auth.signInWithApple()

// Google Sign In
try await supabase.auth.signInWithOAuth(.google)
```

### Data Access

Replace custom `SupabaseService.swift` REST calls with Supabase Swift SDK queries. The SDK automatically includes the user's JWT, so RLS handles access control:

```swift
// Fetch only this user's projects (RLS enforces)
let projects = try await supabase.from("mb_projects").select().execute()
```

### Session Persistence

Supabase Swift SDK stores tokens in iOS Keychain automatically. User stays logged in across app launches.

## New Dependencies

### Web App
- `@supabase/ssr` — server-side auth for Next.js (cookie-based sessions)
- Remove: no new dependencies beyond this

### iOS App
- `supabase-swift` — official Supabase Swift SDK (replaces custom SupabaseService)

## Public Routes (Updated)

| Route | Auth Required | Notes |
|-------|--------------|-------|
| `/login` | No | Sign in page |
| `/signup` | No | Account creation |
| `/auth/callback` | No | OAuth redirect handler |
| `/share/[token]` | No | Public share pages |
| `/api/auth` | No | Removed (Supabase handles) |
| `/api/feedback` | No | Anonymous feedback |
| `/api/audio/[...path]` | No | Audio proxy (public read) |
| `/api/health` | No | Health check |
| `/api/tus` | No | Chunked uploads (service-role) |
| All other routes | Yes | Supabase session required |

## Environment Variables

### Removed
- `MIXBASE_PASSWORD`
- `SESSION_SECRET`

### Unchanged
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `REPLICATE_API_TOKEN`

### New (configured in Supabase dashboard, not env vars)
- Google OAuth Client ID + Secret (Supabase dashboard → Auth → Providers)
- Apple Service ID + Private Key (Supabase dashboard → Auth → Providers)

## Scalability Notes

- **Free tier**: supports ~5-10 concurrent users, 50,000 MAU, 1 GB storage
- **Pro tier ($25/mo)**: 500 concurrent, 100,000 MAU, 100 GB storage, connection pooling
- **Architecture scales linearly** — RLS adds minimal overhead, Supabase Auth handles up to 100K MAU on Pro
- **Audio proxy** remains a bottleneck at scale — future improvement: serve directly from Supabase Storage or add CDN
- **No caching layer** currently — add ISR/revalidation if concurrent users exceed ~50

## File Changes Summary

| File | Action |
|------|--------|
| `supabase/migrations/006_multi_user_auth.sql` | Create: profiles table, user_id columns, RLS policies, first-user trigger |
| `src/lib/supabase.ts` | Rewrite: three-client setup with @supabase/ssr |
| `src/middleware.ts` | Rewrite: Supabase session validation |
| `src/app/login/page.tsx` | Rewrite: email/password + social login buttons |
| `src/app/signup/page.tsx` | Create: account creation page |
| `src/app/auth/callback/route.ts` | Create: OAuth redirect handler |
| `src/app/api/auth/route.ts` | Remove: old password check |
| `src/app/api/auth/logout/route.ts` | Rewrite: Supabase signOut |
| All API routes in `src/app/api/` | Update: use authenticated server client instead of supabaseAdmin |
| `ios/mixBase/Services/SupabaseService.swift` | Rewrite: use Supabase Swift SDK |
| `ios/mixBase/Views/Auth/LoginView.swift` | Create: login screen with email + social |
| `ios/mixBase/Views/Auth/SignupView.swift` | Create: signup screen |
| `package.json` | Add: @supabase/ssr |
