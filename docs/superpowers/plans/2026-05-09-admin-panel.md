# Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/admin` panel gated to admin-tier users with user management, usage stats, content moderation, and a Claude assistant that executes admin actions via natural language.

**Architecture:** Next.js App Router — server component layout handles the admin gate, individual tabs are a mix of server (read-only) and client (interactive) components. Six new API routes under `/api/admin/*` back the UI. Claude assistant uses the Anthropic SDK with tool-use to call admin operations directly.

**Tech Stack:** Next.js App Router, Supabase JS admin client, Anthropic SDK (`@anthropic-ai/sdk`), Lucide icons, existing CSS variables.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/proxy.ts` | Modify | Admin tier gate for `/admin/*` and `/api/admin/*` |
| `src/app/admin/layout.tsx` | Create | Server component: admin check + tab nav |
| `src/app/admin/page.tsx` | Create | Redirect → /admin/users |
| `src/app/admin/users/page.tsx` | Create | Client component: user table + CRUD |
| `src/app/admin/usage/page.tsx` | Create | Server component: usage stats table |
| `src/app/admin/content/page.tsx` | Create | Server component: all projects read-only |
| `src/app/admin/assistant/page.tsx` | Create | Client component: Claude chat |
| `src/app/api/admin/users/route.ts` | Create | GET list, POST create |
| `src/app/api/admin/users/[id]/route.ts` | Create | PATCH update, DELETE |
| `src/app/api/admin/stats/route.ts` | Create | GET usage stats |
| `src/app/api/admin/chat/route.ts` | Create | POST Claude assistant |

---

## Task 1: Admin gate in middleware

**Files:**
- Modify: `src/proxy.ts`

- [ ] **Open `src/proxy.ts`.** After the block that handles the fast-path JWT decode and sets `userId` (around line 83), add an admin check. The check must run AFTER `userId` is confirmed — insert it just before the `return NextResponse.next(...)` in the non-expired path, and similarly in the refresh path. Replace the two `return NextResponse.next({ request: { headers: requestHeaders } })` calls with a helper call. The cleanest approach: add a helper function and call it from both exit points.

Add this import at the top (already imported: `supabaseAdmin`):
```typescript
// no new imports needed
```

Add this helper function before the `proxy` export:
```typescript
async function withAdminCheck(
  request: NextRequest,
  userId: string,
  requestHeaders: Headers,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single()
    if (profile?.subscription_tier !== 'admin') {
      return pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        : NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }
  return NextResponse.next({ request: { headers: requestHeaders } })
}
```

Replace the two `return NextResponse.next({ request: { headers: requestHeaders } })` lines (one in the fast-path, one in the refresh-path) with:
```typescript
return withAdminCheck(request, userId, requestHeaders)
```

Also add `/api/admin` to `PUBLIC_PATHS`? **No** — admin routes require auth. Leave PUBLIC_PATHS unchanged.

- [ ] **Verify build passes:**
```bash
cd /Users/moodmixformat/mixbase && npm run build 2>&1 | tail -5
```
Expected: no errors.

- [ ] **Commit:**
```bash
git add src/proxy.ts
git commit -m "feat(admin): add admin tier gate to middleware"
```

---

## Task 2: Admin layout + shell

**Files:**
- Create: `src/app/admin/layout.tsx`
- Create: `src/app/admin/page.tsx`

- [ ] **Create `src/app/admin/layout.tsx`:**

```typescript
import { redirect } from 'next/navigation'
import { getUserId } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import AdminNav from './AdminNav'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const userId = await getUserId()
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('subscription_tier')
    .eq('id', userId)
    .single()

  if (profile?.subscription_tier !== 'admin') {
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-page)' }}>
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Admin</h1>
          <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: '#2dd4bf22', color: '#2dd4bf' }}>
            Platform Owner
          </span>
        </div>
        <AdminNav />
        <div className="mt-6">{children}</div>
      </div>
    </div>
  )
}
```

- [ ] **Create `src/app/admin/AdminNav.tsx`** (client component for active tab highlight):

```typescript
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/admin/users',     label: 'Users'     },
  { href: '/admin/usage',     label: 'Usage'     },
  { href: '/admin/content',   label: 'Content'   },
  { href: '/admin/assistant', label: 'Assistant' },
]

export default function AdminNav() {
  const path = usePathname()
  return (
    <nav className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
      {TABS.map(tab => {
        const active = path.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="px-4 py-2 text-sm font-medium transition-colors"
            style={{
              color: active ? '#2dd4bf' : 'var(--text-muted)',
              borderBottom: active ? '2px solid #2dd4bf' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
```

- [ ] **Create `src/app/admin/page.tsx`:**

```typescript
import { redirect } from 'next/navigation'
export default function AdminPage() {
  redirect('/admin/users')
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add src/app/admin/
git commit -m "feat(admin): admin layout, nav, and shell pages"
```

---

## Task 3: Admin Users API — list and create

**Files:**
- Create: `src/app/api/admin/users/route.ts`

- [ ] **Create `src/app/api/admin/users/route.ts`:**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'

async function assertAdmin(request: NextRequest): Promise<string | null> {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return null
  const { data } = await supabaseAdmin.from('profiles').select('subscription_tier').eq('id', userId).single()
  return data?.subscription_tier === 'admin' ? userId : null
}

// GET /api/admin/users — list all users with profile + current-month usage
export async function GET(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const userIds = users.map(u => u.id)

  const [profilesRes, usageRes] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, subscription_tier').in('id', userIds),
    supabaseAdmin.from('mb_usage').select('user_id, artwork_generations, video_generations')
      .in('user_id', userIds).eq('month', currentMonth()),
  ])

  const profileMap = Object.fromEntries((profilesRes.data ?? []).map(p => [p.id, p]))
  const usageMap   = Object.fromEntries((usageRes.data   ?? []).map(u => [u.user_id, u]))

  const result = users.map(u => ({
    id:               u.id,
    email:            u.email ?? '',
    created_at:       u.created_at,
    subscription_tier: profileMap[u.id]?.subscription_tier ?? 'free',
    artwork_used:     usageMap[u.id]?.artwork_generations ?? 0,
    video_used:       usageMap[u.id]?.video_generations   ?? 0,
  }))

  return NextResponse.json(result)
}

// POST /api/admin/users — create a new user
export async function POST(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { email, password, tier } = await request.json()
  if (!email || !password) return NextResponse.json({ error: 'email and password required' }, { status: 400 })

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (tier && tier !== 'free') {
    await supabaseAdmin.from('profiles').update({ subscription_tier: tier }).eq('id', data.user.id)
  }

  return NextResponse.json({ id: data.user.id, email: data.user.email }, { status: 201 })
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add src/app/api/admin/users/route.ts
git commit -m "feat(admin): GET/POST /api/admin/users"
```

---

## Task 4: Admin Users [id] API — update and delete

**Files:**
- Create: `src/app/api/admin/users/[id]/route.ts`

- [ ] **Create directory and file `src/app/api/admin/users/[id]/route.ts`:**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'

async function assertAdmin(request: NextRequest): Promise<boolean> {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return false
  const { data } = await supabaseAdmin.from('profiles').select('subscription_tier').eq('id', userId).single()
  return data?.subscription_tier === 'admin'
}

// PATCH /api/admin/users/[id] — update tier and/or reset usage
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params
  const { tier, resetUsage } = await request.json()

  if (tier) {
    const { error } = await supabaseAdmin.from('profiles').update({ subscription_tier: tier }).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (resetUsage) {
    await supabaseAdmin.from('mb_usage').delete().eq('user_id', id).eq('month', currentMonth())
  }

  return NextResponse.json({ ok: true })
}

// DELETE /api/admin/users/[id] — delete user account
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add 'src/app/api/admin/users/[id]/route.ts'
git commit -m "feat(admin): PATCH/DELETE /api/admin/users/[id]"
```

---

## Task 5: Users tab UI

**Files:**
- Create: `src/app/admin/users/page.tsx`

- [ ] **Create `src/app/admin/users/page.tsx`** (full client component — interactive table):

```typescript
'use client'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, RefreshCw } from 'lucide-react'

type AdminUser = {
  id: string
  email: string
  created_at: string
  subscription_tier: string
  artwork_used: number
  video_used: number
}

const TIERS = ['free', 'pro', 'studio', 'admin'] as const
const TIER_COLORS: Record<string, string> = {
  free: '#555', pro: '#2dd4bf', studio: '#a78bfa', admin: '#f59e0b',
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newTier, setNewTier] = useState<string>('free')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/admin/users')
    if (res.ok) setUsers(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function changeTier(userId: string, tier: string) {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    })
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, subscription_tier: tier } : u))
  }

  async function resetUsage(userId: string) {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetUsage: true }),
    })
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, artwork_used: 0, video_used: 0 } : u))
  }

  async function deleteUser(userId: string, email: string) {
    if (!confirm(`Delete account for ${email}? This cannot be undone.`)) return
    await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' })
    setUsers(prev => prev.filter(u => u.id !== userId))
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail, password: newPassword, tier: newTier }),
    })
    if (res.ok) {
      setShowCreate(false)
      setNewEmail('')
      setNewPassword('')
      setNewTier('free')
      load()
    } else {
      const d = await res.json()
      setError(d.error ?? 'Failed to create user')
    }
    setCreating(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {loading ? 'Loading…' : `${users.length} accounts`}
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
          style={{ background: '#2dd4bf', color: '#0a0a0a' }}
        >
          <Plus size={13} /> New User
        </button>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <form
            onSubmit={createUser}
            className="rounded-2xl p-6 w-full max-w-sm space-y-4"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>New User</h2>
            <input
              type="email"
              placeholder="Email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              required
              className="w-full text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
            <input
              type="password"
              placeholder="Password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              className="w-full text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
            <select
              value={newTier}
              onChange={e => setNewTier(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
            >
              {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-sm rounded-lg"
                style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-40"
                style={{ background: '#2dd4bf', color: '#0a0a0a' }}
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Users table */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Email</th>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Tier</th>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Artwork</th>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Joined</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => (
              <tr
                key={u.id}
                style={{
                  background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <td className="px-4 py-3" style={{ color: 'var(--text)' }}>{u.email}</td>
                <td className="px-4 py-3">
                  <select
                    value={u.subscription_tier}
                    onChange={e => changeTier(u.id, e.target.value)}
                    className="text-xs font-medium px-2 py-1 rounded-lg outline-none"
                    style={{
                      background: TIER_COLORS[u.subscription_tier] + '22',
                      color: TIER_COLORS[u.subscription_tier] ?? 'var(--text)',
                      border: 'none',
                    }}
                  >
                    {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {u.artwork_used} used
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      onClick={() => resetUsage(u.id)}
                      title="Reset this month's usage"
                      className="p-1.5 rounded-lg transition-colors hover:opacity-80"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <RefreshCw size={13} />
                    </button>
                    <button
                      onClick={() => deleteUser(u.id, u.email)}
                      title="Delete account"
                      className="p-1.5 rounded-lg transition-colors hover:opacity-80"
                      style={{ color: '#f87171' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add src/app/admin/users/
git commit -m "feat(admin): users tab with CRUD table"
```

---

## Task 6: Stats API + Usage tab

**Files:**
- Create: `src/app/api/admin/stats/route.ts`
- Create: `src/app/admin/usage/page.tsx`

- [ ] **Create `src/app/api/admin/stats/route.ts`:**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { data: profile } = await supabaseAdmin.from('profiles').select('subscription_tier').eq('id', userId).single()
  if (profile?.subscription_tier !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const month = currentMonth()

  const [usageRes, profilesRes] = await Promise.all([
    supabaseAdmin.from('mb_usage').select('user_id, artwork_generations, video_generations').eq('month', month),
    supabaseAdmin.from('profiles').select('id, subscription_tier'),
  ])

  const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const emailMap = Object.fromEntries(users.map(u => [u.id, u.email ?? '']))
  const tierMap  = Object.fromEntries((profilesRes.data ?? []).map(p => [p.id, p.subscription_tier]))

  const rows = (usageRes.data ?? [])
    .map(r => ({
      user_id:   r.user_id,
      email:     emailMap[r.user_id] ?? '—',
      tier:      tierMap[r.user_id]  ?? 'free',
      artwork:   r.artwork_generations,
      video:     r.video_generations,
    }))
    .sort((a, b) => b.artwork - a.artwork)

  return NextResponse.json({ month, rows })
}
```

- [ ] **Create `src/app/admin/usage/page.tsx`** (server component):

```typescript
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'

const TIER_COLORS: Record<string, string> = {
  free: '#555', pro: '#2dd4bf', studio: '#a78bfa', admin: '#f59e0b',
}

export default async function AdminUsagePage() {
  const month = currentMonth()

  const [usageRes, profilesRes] = await Promise.all([
    supabaseAdmin.from('mb_usage').select('user_id, artwork_generations, video_generations').eq('month', month),
    supabaseAdmin.from('profiles').select('id, subscription_tier'),
  ])

  const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const emailMap = Object.fromEntries(users.map(u => [u.id, u.email ?? '']))
  const tierMap  = Object.fromEntries((profilesRes.data ?? []).map(p => [p.id, p.subscription_tier]))

  const rows = (usageRes.data ?? [])
    .map(r => ({
      user_id: r.user_id,
      email:   emailMap[r.user_id] ?? '—',
      tier:    tierMap[r.user_id]  ?? 'free',
      artwork: r.artwork_generations,
      video:   r.video_generations,
    }))
    .sort((a, b) => b.artwork - a.artwork)

  return (
    <div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Month: {month}</p>
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              {['Email', 'Tier', 'Artwork', 'Video'].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  No usage this month
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.user_id} style={{ background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                <td className="px-4 py-3" style={{ color: 'var(--text)' }}>{r.email}</td>
                <td className="px-4 py-3">
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: (TIER_COLORS[r.tier] ?? '#555') + '22', color: TIER_COLORS[r.tier] ?? 'var(--text-muted)' }}>
                    {r.tier}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: r.artwork > 20 ? '#f59e0b' : 'var(--text-muted)' }}>{r.artwork}</td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{r.video}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add src/app/api/admin/stats/route.ts src/app/admin/usage/page.tsx
git commit -m "feat(admin): stats API and usage tab"
```

---

## Task 7: Content tab

**Files:**
- Create: `src/app/admin/content/page.tsx`

- [ ] **Create `src/app/admin/content/page.tsx`** (server component — reads all projects via admin client):

```typescript
import { supabaseAdmin } from '@/lib/supabase'
import Link from 'next/link'

export default async function AdminContentPage() {
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id, title, user_id, created_at, mb_versions(id)')
    .order('created_at', { ascending: false })
    .limit(200)

  const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const emailMap = Object.fromEntries(users.map(u => [u.id, u.email ?? '—']))

  return (
    <div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
        {(projects ?? []).length} projects (most recent first)
      </p>
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              {['Project', 'Owner', 'Versions', 'Created'].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(projects ?? []).map((p, i) => {
              const versionCount = Array.isArray(p.mb_versions) ? (p.mb_versions as { id: string }[]).length : 0
              return (
                <tr key={p.id} style={{ background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                  <td className="px-4 py-3">
                    <Link href={`/projects/${p.id}`} className="hover:underline" style={{ color: '#2dd4bf' }}>
                      {p.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{emailMap[p.user_id]}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{versionCount}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(p.created_at).toLocaleDateString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add src/app/admin/content/page.tsx
git commit -m "feat(admin): content tab — all projects read-only"
```

---

## Task 8: Claude assistant API

**Files:**
- Create: `src/app/api/admin/chat/route.ts`

- [ ] **Create `src/app/api/admin/chat/route.ts`:**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'

const client = new Anthropic()

async function assertAdmin(request: NextRequest): Promise<boolean> {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return false
  const { data } = await supabaseAdmin.from('profiles').select('subscription_tier').eq('id', userId).single()
  return data?.subscription_tier === 'admin'
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_users',
    description: 'List all user accounts with their tier and this month\'s usage.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_stats',
    description: 'Get aggregate stats: total users, count by tier, total generations this month.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'set_user_tier',
    description: 'Change a user\'s subscription tier.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'User email address' },
        tier:  { type: 'string', enum: ['free', 'pro', 'studio', 'admin'], description: 'New tier' },
      },
      required: ['email', 'tier'],
    },
  },
  {
    name: 'reset_user_usage',
    description: 'Reset a user\'s generation usage for the current month to zero.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'User email address' },
      },
      required: ['email'],
    },
  },
  {
    name: 'create_user',
    description: 'Create a new user account.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email:    { type: 'string' },
        password: { type: 'string' },
        tier:     { type: 'string', enum: ['free', 'pro', 'studio', 'admin'] },
      },
      required: ['email', 'password'],
    },
  },
  {
    name: 'delete_user',
    description: 'Permanently delete a user account. ALWAYS confirm with the user before calling this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'User email address' },
      },
      required: ['email'],
    },
  },
]

async function executeTool(name: string, input: Record<string, string>): Promise<string> {
  try {
    if (name === 'list_users') {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const [profilesRes, usageRes] = await Promise.all([
        supabaseAdmin.from('profiles').select('id, subscription_tier'),
        supabaseAdmin.from('mb_usage').select('user_id, artwork_generations').eq('month', currentMonth()),
      ])
      const tierMap  = Object.fromEntries((profilesRes.data ?? []).map(p => [p.id, p.subscription_tier]))
      const usageMap = Object.fromEntries((usageRes.data   ?? []).map(u => [u.user_id, u.artwork_generations]))
      const rows = users.map(u => `${u.email} | ${tierMap[u.id] ?? 'free'} | artwork: ${usageMap[u.id] ?? 0}`)
      return rows.join('\n')
    }

    if (name === 'get_stats') {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const profilesRes = await supabaseAdmin.from('profiles').select('subscription_tier')
      const usageRes    = await supabaseAdmin.from('mb_usage').select('artwork_generations, video_generations').eq('month', currentMonth())
      const tierCounts  = (profilesRes.data ?? []).reduce((acc: Record<string, number>, p) => {
        acc[p.subscription_tier] = (acc[p.subscription_tier] ?? 0) + 1; return acc
      }, {})
      const totalArtwork = (usageRes.data ?? []).reduce((s, r) => s + r.artwork_generations, 0)
      const totalVideo   = (usageRes.data ?? []).reduce((s, r) => s + r.video_generations,   0)
      return JSON.stringify({ total_users: users.length, by_tier: tierCounts, artwork_this_month: totalArtwork, video_this_month: totalVideo })
    }

    if (name === 'set_user_tier') {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const user = users.find(u => u.email === input.email)
      if (!user) return `User not found: ${input.email}`
      await supabaseAdmin.from('profiles').update({ subscription_tier: input.tier }).eq('id', user.id)
      return `Changed ${input.email} to ${input.tier}`
    }

    if (name === 'reset_user_usage') {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const user = users.find(u => u.email === input.email)
      if (!user) return `User not found: ${input.email}`
      await supabaseAdmin.from('mb_usage').delete().eq('user_id', user.id).eq('month', currentMonth())
      return `Reset usage for ${input.email}`
    }

    if (name === 'create_user') {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email: input.email, password: input.password, email_confirm: true,
      })
      if (error) return `Error: ${error.message}`
      if (input.tier && input.tier !== 'free') {
        await supabaseAdmin.from('profiles').update({ subscription_tier: input.tier }).eq('id', data.user.id)
      }
      return `Created account for ${input.email} (${input.tier ?? 'free'})`
    }

    if (name === 'delete_user') {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const user = users.find(u => u.email === input.email)
      if (!user) return `User not found: ${input.email}`
      const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)
      if (error) return `Error: ${error.message}`
      return `Deleted account for ${input.email}`
    }

    return `Unknown tool: ${name}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
  }
}

export async function POST(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { messages } = await request.json()

  const systemPrompt = `You are the admin assistant for mixBase, a music mix versioning platform. Today is ${new Date().toISOString().split('T')[0]}.

You have tools to manage users (list, create, change tier, reset usage, delete). Use them to answer questions and execute admin actions.

Rules:
- Be concise. One or two sentences per response unless listing data.
- For delete_user: always describe what you're about to do and ask for confirmation before calling the tool, unless the user has already confirmed.
- When listing users, format the output clearly.
- If you don't understand a request, ask for clarification.`

  // Agentic loop: call Claude, handle tool_use, repeat until done
  const msgs: Anthropic.MessageParam[] = messages

  let finalText = ''
  const toolLog: { tool: string; result: string }[] = []

  for (let i = 0; i < 5; i++) { // max 5 turns to prevent runaway loops
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: msgs,
    })

    msgs.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text')
      finalText = textBlock?.type === 'text' ? textBlock.text : ''
      break
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const result = await executeTool(block.name, block.input as Record<string, string>)
        toolLog.push({ tool: block.name, result })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
      msgs.push({ role: 'user', content: toolResults })
    }
  }

  return NextResponse.json({ text: finalText, toolLog })
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add src/app/api/admin/chat/route.ts
git commit -m "feat(admin): Claude assistant API with tool-use"
```

---

## Task 9: Assistant tab UI

**Files:**
- Create: `src/app/admin/assistant/page.tsx`

- [ ] **Create `src/app/admin/assistant/page.tsx`:**

```typescript
'use client'
import { useState, useRef, useEffect } from 'react'
import { Send } from 'lucide-react'

type Message = {
  role: 'user' | 'assistant'
  text: string
  toolLog?: { tool: string; result: string }[]
}

export default function AdminAssistantPage() {
  const [messages, setMessages] = useState<Message[]>([{
    role: 'assistant',
    text: 'Hi — I can help you manage users, check usage stats, and run admin actions. What do you need?',
  }])
  const [input, setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    const userMsg: Message = { role: 'user', text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    // Build the messages array for the API (exclude the initial greeting)
    const apiMessages = [...messages.slice(1), userMsg]
      .map(m => ({ role: m.role, content: m.text }))

    try {
      const res = await fetch('/api/admin/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: data.text ?? 'Done.',
        toolLog: data.toolLog?.length ? data.toolLog : undefined,
      }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Something went wrong. Try again.' }])
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col h-[600px]">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 pb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className="max-w-[80%] rounded-2xl px-4 py-3 text-sm"
              style={{
                background: m.role === 'user' ? '#2dd4bf' : 'var(--surface)',
                color:      m.role === 'user' ? '#0a0a0a'  : 'var(--text)',
                border:     m.role === 'assistant' ? '1px solid var(--border)' : 'none',
              }}
            >
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.toolLog && m.toolLog.length > 0 && (
                <div className="mt-2 space-y-1">
                  {m.toolLog.map((t, j) => (
                    <div key={j} className="flex items-start gap-2 text-xs" style={{ color: '#2dd4bf' }}>
                      <span className="flex-shrink-0">✓</span>
                      <span className="font-mono">{t.tool}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-3 text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={send} className="flex gap-2 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask anything or give an instruction…"
          disabled={loading}
          className="flex-1 text-sm px-4 py-2.5 rounded-xl outline-none"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-4 py-2.5 rounded-xl font-medium disabled:opacity-40 transition-colors"
          style={{ background: '#2dd4bf', color: '#0a0a0a' }}
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Verify build:**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Commit:**
```bash
git add src/app/admin/assistant/page.tsx
git commit -m "feat(admin): Claude assistant chat UI"
```

---

## Task 10: Wire up, push, and deploy

- [ ] **Add `/api/admin` to middleware PUBLIC_PATHS? No** — admin routes require auth, leave as-is. Confirm `src/proxy.ts` has the `withAdminCheck` helper in place from Task 1.

- [ ] **Final lint + build:**
```bash
cd /Users/moodmixformat/mixbase && npm run lint 2>&1 | grep -c error || true && npm run build 2>&1 | tail -5
```
Expected: 0 errors, clean build output.

- [ ] **Push tst → staging:**
```bash
git push origin tst
```

- [ ] **Verify staging (wait ~45s for deploy):**
```bash
sleep 45 && curl -sL -o /dev/null -w "%{http_code}" https://mixbase-staging.up.railway.app/login
```
Expected: `200`

- [ ] **Merge to main:**
```bash
git checkout main && git merge --ff-only tst && git push origin main && git checkout tst
```

- [ ] **Verify production:**
```bash
sleep 45 && curl -sL -o /dev/null -w "%{http_code}" https://mixbase-production.up.railway.app/login
```
Expected: `200`
