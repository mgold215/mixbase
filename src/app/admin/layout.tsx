import { redirect } from 'next/navigation'
import { getUserId } from '@/lib/auth'
import { isAdminIdentity } from '@/lib/admin-identity'
import AdminNav from './AdminNav'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // getUserId() redirects to /login internally if no session — always returns a string
  const userId = await getUserId()

  // Identity, not tier — subscription_tier is self-writable. See
  // src/lib/admin-identity.ts.
  if (!(await isAdminIdentity(userId))) {
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
