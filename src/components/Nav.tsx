'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, LayoutGrid, PlayCircle, ClipboardList, Library, Images, Sun, Moon, UserCircle } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { useTheme } from '@/contexts/ThemeContext'

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const { currentTrack } = usePlayer()
  const { theme, toggleTheme } = useTheme()
  const [artistName, setArtistName] = useState('')

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.artist_name) setArtistName(d.artist_name) })
      .catch(() => {})
  }, [])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  // Desktop top-nav links
  const links = [
    { href: '/dashboard', label: 'Projects' },
    { href: '/collections', label: 'Collections' },
    { href: '/media', label: 'Media' },
    { href: '/pipeline', label: 'Pipeline' },
    { href: '/player', label: 'Player' },
  ]

  // Mobile bottom tab bar items
  const tabs = [
    { href: '/dashboard',   label: 'Projects',    icon: LayoutGrid,    match: '/dashboard' },
    { href: '/collections', label: 'Collections', icon: Library,       match: '/collections' },
    { href: '/media',       label: 'Media',       icon: Images,        match: '/media' },
    { href: currentTrack ? `/player?track=${currentTrack.project_id}` : '/player', label: 'Player', icon: PlayCircle, match: '/player' },
    { href: '/pipeline',    label: 'Pipeline',    icon: ClipboardList, match: '/pipeline' },
  ]

  function isTabActive(tab: typeof tabs[number]) {
    return pathname.startsWith(tab.match)
  }

  // Whether the mini player is currently visible (affects bottom tab spacing)
  const miniPlayerVisible = !!currentTrack && !pathname.startsWith('/player')

  return (
    <>
      {/* ── Top nav bar (always visible, links hidden on mobile) ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 h-12 border-b flex items-center px-5" style={{ backgroundColor: 'color-mix(in srgb, var(--nav-bg) 90%, transparent)', borderColor: 'var(--border)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', position: 'relative' }}>
        {artistName && (
          <span
            className="absolute left-1/2 -translate-x-1/2 font-[family-name:var(--font-jost)] text-[13px] font-semibold tracking-[0.08em] uppercase pointer-events-none"
            style={{ color: 'var(--text-muted)' }}
          >
            {artistName}
          </span>
        )}
        {/* Logo */}
        <Link href="/dashboard" className="mr-6 flex items-baseline gap-0.5 font-[family-name:var(--font-jost)]">
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--text)' }}>mix</span><span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--accent)' }}>BASE</span>
        </Link>

        {/* Divider — hidden on mobile */}
        <div className="w-px h-4 bg-[#1e1e1e] mr-5 hidden md:block" />

        {/* Nav links — hidden on mobile, shown on desktop */}
        <div className="hidden md:flex items-center gap-5 flex-1">
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
                style={{ textShadow: active ? '0 0 20px rgba(45, 212, 191, 0.4)' : undefined }}
              >
                {label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-px bg-[var(--accent)] opacity-90" />
                )}
              </Link>
            )
          })}
        </div>

        {/* Spacer on mobile to push logout to right */}
        <div className="flex-1 md:hidden" />

        {/* Profile */}
        <Link
          href="/profile"
          className="p-1.5 rounded-md transition-colors mr-1"
          style={{ color: pathname === '/profile' ? 'var(--accent)' : 'var(--text-muted)' }}
          title="Account"
        >
          <UserCircle size={14} strokeWidth={1.5} />
        </Link>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-md transition-colors mr-2"
          style={{ color: 'var(--text-muted)' }}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
        </button>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="p-1.5 rounded-md text-[#3a3a3a] hover:text-[#888] transition-colors"
          title="Log out"
        >
          <LogOut size={14} strokeWidth={1.5} />
        </button>
      </nav>

      {/* ── Bottom tab bar (mobile only, below md breakpoint, hidden on full player) ── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 border-t md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', backgroundColor: 'color-mix(in srgb, var(--nav-bg) 90%, transparent)', borderColor: 'var(--border)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      >
        <div className="flex items-center justify-around h-16">
          {tabs.map((tab) => {
            const active = isTabActive(tab)
            const Icon = tab.icon
            return (
              <Link
                key={tab.label}
                href={tab.href}
                className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors ${
                  active ? 'text-[#2dd4bf]' : 'text-[#555]'
                }`}
              >
                <Icon size={22} strokeWidth={active ? 2 : 1.5} />
                <span className="text-[10px] tracking-wide">{tab.label}</span>
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
