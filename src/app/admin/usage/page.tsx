import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'

export default async function AdminUsagePage() {
  const month = currentMonth()

  const usageRes = await supabaseAdmin.from('mb_usage').select('user_id, artwork_generations, video_generations').eq('month', month)

  const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const users = listData?.users ?? []
  const emailMap = Object.fromEntries(users.map(u => [u.id, u.email ?? '']))

  const rows = (usageRes.data ?? [])
    .map(r => ({
      user_id: r.user_id,
      email:   emailMap[r.user_id] ?? '—',
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
              {['Email', 'Artwork', 'Video'].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  No usage this month
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.user_id} style={{ background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                <td className="px-4 py-3" style={{ color: 'var(--text)' }}>{r.email}</td>
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
