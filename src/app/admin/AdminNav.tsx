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
