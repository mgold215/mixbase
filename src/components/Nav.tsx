'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogOut, LayoutGrid, PlayCircle, ClipboardList, Library, Images, Sun, Moon, UserCircle, Send, Rss, MoreHorizontal } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { useTheme } from '@/contexts/ThemeContext'

export default function Nav() {
  const pathname = usePathname()
  const { currentTrack } = usePlayer()
  const { theme, toggleTheme } = useTheme()
  const [artistName, setArtistName] = useState('')
  // Overflow menu open state. No close-on-navigate handling is needed: Nav is
  // rendered per page (not in the layout), so it remounts — and thus resets —
  // on every route change, and every in-menu action already closes it.
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.artist_name) setArtistName(d.artist_name) })
      .catch(() => {})
  }, [])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    // Hard navigation: flushes the client router cache so no authed page
    // content (or stale login redirects) survives the auth-state change.
    window.location.assign('/login')
  }

  // Desktop top-nav links
  const links = [
    { href: '/dashboard', label: 'Projects' },
    { href: '/feed', label: 'Feed' },
    { href: '/collections', label: 'Collections' },
    { href: '/media', label: 'Media' },
    { href: '/pipeline', label: 'Pipeline' },
    { href: '/submit', label: 'Submit' },
    { href: '/player', label: 'Player' },
  ]

  // Mobile bottom tab bar items. Pipeline and Submit live in the top-bar
  // "more" menu instead — five tabs keeps the bar comfortable to hit.
  const tabs = [
    { href: '/dashboard',   label: 'Projects',    icon: LayoutGrid,    match: '/dashboard' },
    { href: '/feed',        label: 'Feed',        icon: Rss,           match: '/feed' },
    { href: '/collections', label: 'Collections', icon: Library,       match: '/collections' },
    { href: '/media',       label: 'Media',       icon: Images,        match: '/media' },
    { href: currentTrack ? `/player?track=${currentTrack.project_id}` : '/player', label: 'Player', icon: PlayCircle, match: '/player' },
  ]

  // Mobile top-bar overflow menu (the tabs we pulled off the bottom bar)
  const menuItems = [
    { href: '/pipeline', label: 'Pipeline', icon: ClipboardList },
    { href: '/submit',   label: 'Submit',   icon: Send },
  ]

  function isTabActive(tab: typeof tabs[number]) {
    return pathname.startsWith(tab.match)
  }

  return (
    <>
      {/* ── Top nav bar (always visible, links hidden on mobile) ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 h-12 border-b flex items-center px-5" style={{ backgroundColor: 'color-mix(in srgb, var(--nav-bg) 90%, transparent)', borderColor: 'var(--border)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', position: 'relative' }}>
        {artistName && (
          <span
            className="absolute left-1/2 -translate-x-1/2 font-[family-name:var(--font-jost)] text-[13px] font-semibold tracking-[0.08em] pointer-events-none"
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

        {/* Overflow menu (mobile only) — Pipeline & Submit */}
        <button
          onClick={() => setMenuOpen(o => !o)}
          className="p-1.5 rounded-md transition-colors mr-1 md:hidden"
          style={{ color: menuOpen || menuItems.some(m => pathname.startsWith(m.href)) ? 'var(--accent)' : 'var(--text-muted)' }}
          title="More"
          aria-label="More"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal size={14} strokeWidth={1.5} />
        </button>

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
        {/* Overflow dropdown — absolutely positioned inside the bar so it stays
            anchored to it wherever the bar is (the bar's inline position style
            makes viewport-fixed coordinates unreliable here) */}
        {menuOpen && (
          <div
            className="absolute top-full right-3 mt-1 z-50 rounded-xl border overflow-hidden md:hidden"
            style={{ backgroundColor: 'var(--nav-bg)', borderColor: 'var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}
          >
            {menuItems.map(({ href, label, icon: Icon }) => {
              const active = pathname.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-2.5 px-4 py-3 text-[13px] tracking-wide transition-colors"
                  style={{ color: active ? 'var(--accent)' : 'var(--text)' }}
                  onClick={() => setMenuOpen(false)}
                >
                  <Icon size={15} strokeWidth={active ? 2 : 1.5} />
                  {label}
                </Link>
              )
            })}
          </div>
        )}
      </nav>

      {/* Backdrop — closes the overflow menu on any outside tap */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMenuOpen(false)} />
      )}

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
