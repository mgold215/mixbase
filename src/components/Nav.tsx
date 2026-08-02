'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogOut, LayoutGrid, PlayCircle, ClipboardList, Library, ListMusic, Images, Sun, Moon, UserCircle, Send, Rss, MoreHorizontal, Bell, MessageSquare, Star } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { useTheme } from '@/contexts/ThemeContext'
import { timeAgo } from '@/lib/time'
import { notificationHref, type NotificationSource } from '@/lib/notifications'

type NotificationItem = {
  id: string
  description: string | null
  project_id: string | null
  version_id: string | null
  source: NotificationSource
  created_at: string
}

export default function Nav() {
  const pathname = usePathname()
  const { currentTrack } = usePlayer()
  const { theme, toggleTheme } = useTheme()
  const [artistName, setArtistName] = useState('')
  // Overflow menu open state. No close-on-navigate handling is needed: Nav is
  // rendered per page (not in the layout), so it remounts — and thus resets —
  // on every route change, and every in-menu action already closes it.
  const [menuOpen, setMenuOpen] = useState(false)

  // Notifications: things other people did to your work (feed comments,
  // share-page feedback). Badge shows arrivals since the bell was last opened.
  const [notifOpen, setNotifOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.artist_name) setArtistName(d.artist_name) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () => fetch('/api/notifications')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        setUnread(d.unread ?? 0)
        setNotifications(d.items ?? [])
      })
      .catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  function openNotifications() {
    setMenuOpen(false)
    setNotifOpen(o => !o)
    if (!notifOpen && unread > 0) {
      // Opening the bell marks everything seen (server cursor + local badge)
      setUnread(0)
      fetch('/api/notifications', { method: 'POST' }).catch(() => {})
    }
  }

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
    { href: '/library', label: 'Released' },
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
    { href: '/library',  label: 'Released', icon: ListMusic },
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

        {/* Notifications bell */}
        <button
          onClick={openNotifications}
          className="relative p-1.5 rounded-md transition-colors mr-1"
          style={{ color: notifOpen ? 'var(--accent)' : 'var(--text-muted)' }}
          title="Notifications"
          aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
          aria-expanded={notifOpen}
        >
          <Bell size={14} strokeWidth={1.5} />
          {unread > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full font-semibold"
              style={{ background: 'var(--accent)', color: '#0d0b08', fontSize: 8, minWidth: 13, height: 13, padding: '0 3px' }}
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>

        {/* Overflow menu (mobile only) — Pipeline & Submit */}
        <button
          onClick={() => { setNotifOpen(false); setMenuOpen(o => !o) }}
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
        {/* Notifications dropdown — anchored to the bar like the overflow menu */}
        {notifOpen && (
          <div
            className="absolute top-full right-3 mt-1 z-50 rounded-xl border overflow-hidden w-72 max-w-[calc(100vw-24px)]"
            style={{ backgroundColor: 'var(--nav-bg)', borderColor: 'var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}
          >
            {notifications.length === 0 ? (
              <p className="px-4 py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                No notifications yet — comments and feedback on your mixes show up here.
              </p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {notifications.map(n => {
                  // Icon distinguishes the two sources. The DESTINATION is
                  // deliberately identical for both (notificationHref) so a
                  // misclassified legacy row costs an icon, never a dead link.
                  const SourceIcon = n.source === 'feed_comment' ? MessageSquare : Star
                  return (
                    <Link
                      key={n.id}
                      href={notificationHref(n)}
                      className="flex items-start gap-2 px-4 py-2.5 transition-colors hover:bg-white/5"
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onClick={() => setNotifOpen(false)}
                    >
                      <SourceIcon
                        size={11}
                        className="mt-0.5 flex-shrink-0"
                        style={{ color: 'var(--text-muted)' }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        {/* break-words + line-clamp: the description embeds a
                            reviewer-supplied name, so one row must never be
                            able to overflow the panel or push the rest out. */}
                        <span className="block text-xs leading-snug break-words line-clamp-3" style={{ color: 'var(--text)' }}>
                          {n.description ?? 'New activity on your mix'}
                        </span>
                        <span className="block mt-0.5" style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                          {timeAgo(n.created_at)}
                        </span>
                      </span>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        )}

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

      {/* Backdrop — closes any open dropdown on an outside tap */}
      {(menuOpen || notifOpen) && (
        <div className="fixed inset-0 z-40" onClick={() => { setMenuOpen(false); setNotifOpen(false) }} />
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
