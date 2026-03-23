'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, CalendarRange, LogOut } from 'lucide-react'

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  const links = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/pipeline', label: 'Release Pipeline', icon: CalendarRange },
  ]

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-14 bg-[#080808]/90 backdrop-blur-md border-b border-[#1a1a1a] flex items-center px-6">
      {/* Logo */}
      <Link href="/dashboard" className="text-lg font-bold text-white tracking-tight mr-8">
        Mixfolio
      </Link>

      {/* Nav links */}
      <div className="flex items-center gap-1 flex-1">
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                active
                  ? 'text-white bg-[#1a1a1a]'
                  : 'text-[#666] hover:text-white hover:bg-[#111]'
              }`}
            >
              <Icon size={15} />
              {label}
            </Link>
          )
        })}
      </div>

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-[#555] hover:text-white hover:bg-[#111] transition-colors"
      >
        <LogOut size={15} />
        Logout
      </button>
    </nav>
  )
}
