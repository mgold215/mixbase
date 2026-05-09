import { supabaseAdmin } from '@/lib/supabase'
import Link from 'next/link'

export default async function AdminContentPage() {
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id, title, user_id, created_at, mb_versions(id)')
    .order('created_at', { ascending: false })
    .limit(200)

  const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const users = listData?.users ?? []
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
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{emailMap[p.user_id] ?? '—'}</td>
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
