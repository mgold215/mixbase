'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  const links = [
    { href: '/dashboard', label: 'Projects' },
    { href: '/pipeline', label: 'Pipeline' },
    { href: '/player', label: 'Player' },
  ]

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-12 bg-[#0a0a0a] border-b border-[#161616] flex items-center px-5">
      {/* Logo */}
      <Link href="/dashboard" className="mr-6 flex items-baseline gap-0.5 font-[family-name:var(--font-jost)]">
        <span className="text-[15px] font-bold text-[#e0e0e0] uppercase tracking-[0.04em]">mix</span>
        <span className="text-[15px] font-bold text-[#5eead4] uppercase tracking-[0.04em]">Base</span>
      </Link>

      {/* Divider */}
      <div className="w-px h-4 bg-[#1e1e1e] mr-5" />

      {/* Nav links */}
      <div className="flex items-center gap-5 flex-1">
        {links.map(({ href, label }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`relative text-[13px] tracking-wide transition-colors py-3.5 ${
                active
                  ? 'text-white'
                  : 'text-[#555] hover:text-[#999]'
              }`}
            >
              {label}
              {active && (
                <span className="absolute bottom-0 left-0 right-0 h-px bg-[#5eead4]" />
              )}
            </Link>
          )
        })}
      </div>

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="p-1.5 rounded-md text-[#3a3a3a] hover:text-[#888] transition-colors"
        title="Log out"
      >
        <LogOut size={14} strokeWidth={1.5} />
      </button>
    </nav>
  )
}
