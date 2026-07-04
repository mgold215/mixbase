import Link from 'next/link'
import { cookies } from 'next/headers'
import { Upload, Star, Send, ClipboardList, Sparkles, Film } from 'lucide-react'
import { TIER_PRICES, TIER_LIMITS } from '@/lib/tier'

const LANDING_TITLE = 'mixBASE — Rough-to-release. Version control for music.'
const LANDING_DESCRIPTION =
  'Versioned audio uploads, timestamped feedback via share links, a release pipeline, AI cover art and visualizers — one home for your mixes from rough to release.'

export const metadata = {
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: { canonical: '/' },
  // Page-specific share-preview copy (overrides the site defaults in layout.tsx
  // for the most-shared URL — the marketing landing page).
  openGraph: {
    type: 'website',
    siteName: 'mixBASE',
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    url: '/',
    images: [{ url: '/icons/icon-512.png', width: 512, height: 512, alt: 'mixBASE' }],
  },
  twitter: {
    card: 'summary',
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    images: ['/icons/icon-512.png'],
  },
}

const FEATURES = [
  {
    icon: Upload,
    title: 'Versioned uploads',
    body: 'Every bounce lives under one project — WAV, MP3, FLAC and more, up to 2 GB per file with resumable uploads. Never hunt through "final_final_v3" folders again.',
  },
  {
    icon: Star,
    title: 'Label & curator pitching',
    body: 'Pitch playlists, labels, blogs and radio from a built-in curator directory — message templates auto-fill your private listening link, and a tracker logs every pitch, status and response rate.',
  },
  {
    icon: Send,
    title: 'Share links with timestamped notes',
    body: 'Send a private link — no account needed on their end. Collaborators drop feedback pinned to the exact second in the track.',
  },
  {
    icon: ClipboardList,
    title: 'Release pipeline & Spotify launch',
    body: 'A checklist board for every release: mixing, mastering, artwork, DSP submission, pre-save, Spotify Canvas, Marquee and ad campaigns — plus editorial pitching via Spotify for Artists.',
  },
  {
    icon: Sparkles,
    title: 'AI cover artwork',
    body: 'Describe the vibe and generate release-ready cover art with Flux and Imagen, then finalize it with your title and artist name.',
  },
  {
    icon: Film,
    title: 'AI visualizer video',
    body: 'Turn your artwork into a moving visualizer — a Canvas-style loop that plays behind your track in the full-screen waveform player.',
  },
]

const STEPS = [
  { n: '01', title: 'Upload a rough', body: 'Start a project and drop in your first bounce. Each new mix stacks as a version, not a new file mess.' },
  { n: '02', title: 'Share for feedback', body: 'Send share links for timestamped feedback and keep notes where the music is.' },
  { n: '03', title: 'Release', body: 'Work the pipeline checklist, pitch curators and labels, generate artwork and visualizers, and walk the track out the door.' },
]

export default async function Home() {
  const authed = (await cookies()).get('sb-authed')?.value === '1'

  const tiers = [
    {
      name: 'Free',
      price: TIER_PRICES.free,
      highlight: false,
      perks: [
        'Unlimited projects, versions & share links',
        `${TIER_LIMITS.free.artworkGenerations} AI artworks / month`,
        'Curator & label pitch tracker',
        'Release pipeline & collections',
      ],
    },
    {
      name: 'Pro',
      price: TIER_PRICES.pro,
      highlight: true,
      perks: [
        'Everything in Free',
        `${TIER_LIMITS.pro.artworkGenerations} AI artworks / month`,
        'Priority artwork generation',
      ],
    },
    {
      name: 'Studio',
      price: TIER_PRICES.studio,
      highlight: false,
      perks: [
        'Everything in Pro',
        `${TIER_LIMITS.studio.artworkGenerations} AI artworks / month`,
        `${TIER_LIMITS.studio.videoGenerations} AI visualizer videos / month`,
      ],
    },
  ]

  const wordmark = (
    <span className="font-bold tracking-[0.04em]">
      <span style={{ color: 'var(--text)' }}>mix</span>
      <span style={{ color: 'var(--accent)' }}>BASE</span>
    </span>
  )

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text)' }}>

      {/* Top bar */}
      <header className="max-w-5xl mx-auto flex items-center justify-between px-4 py-5">
        <span className="text-lg">{wordmark}</span>
        <nav className="flex items-center gap-3">
          {authed ? (
            <Link
              href="/dashboard"
              className="font-semibold text-sm px-5 py-2 rounded-xl"
              style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
            >
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="text-sm px-4 py-2 rounded-xl hover:underline" style={{ color: 'var(--text-secondary)' }}>
                Sign in
              </Link>
              <Link
                href="/signup"
                className="font-semibold text-sm px-5 py-2 rounded-xl"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse 70% 50% at 50% 40%, rgba(45,212,191,0.07) 0%, transparent 70%)' }}
        />
        <div className="relative max-w-3xl mx-auto text-center px-4 pt-20 pb-24">
          <p className="text-xs uppercase tracking-[0.2em] mb-4" style={{ color: '#4ade80' }}>ROUGH-TO-RELEASE</p>
          <h1 className="text-5xl sm:text-6xl leading-tight" style={{ fontFamily: 'var(--font-bebas)' }}>
            Version control for your music
          </h1>
          <p className="text-base sm:text-lg mt-4 max-w-xl mx-auto" style={{ color: 'var(--text-secondary)' }}>
            One home for every mix — upload roughs, collect timestamped feedback, pitch curators and labels, and track each song all the way to release day.
          </p>
          <div className="flex items-center justify-center gap-3 mt-8">
            {authed ? (
              <Link
                href="/dashboard"
                className="font-semibold px-8 py-3 rounded-xl"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
              >
                Go to your dashboard →
              </Link>
            ) : (
              <>
                <Link
                  href="/signup"
                  className="font-semibold px-8 py-3 rounded-xl"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
                >
                  Start free
                </Link>
                <Link
                  href="/login"
                  className="font-semibold px-8 py-3 rounded-xl"
                  style={{ border: '1px solid var(--border)', color: 'var(--text)' }}
                >
                  Sign in
                </Link>
              </>
            )}
          </div>
          {!authed && (
            <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>Free plan · no card required</p>
          )}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-4 pb-20">
        <h2 className="text-3xl text-center mb-8" style={{ fontFamily: 'var(--font-bebas)' }}>
          Everything between the rough and the release
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(f => (
            <div
              key={f.title}
              className="rounded-xl p-5"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <f.icon size={20} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold text-sm mt-3 mb-1.5">{f.title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-4xl mx-auto px-4 pb-20">
        <h2 className="text-3xl text-center mb-8" style={{ fontFamily: 'var(--font-bebas)' }}>
          How it works
        </h2>
        <div className="grid sm:grid-cols-3 gap-6">
          {STEPS.map(s => (
            <div key={s.n}>
              <p className="text-2xl mb-2" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{s.n}</p>
              <h3 className="font-semibold text-sm mb-1.5">{s.title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="max-w-4xl mx-auto px-4 pb-24">
        <h2 className="text-3xl text-center mb-8" style={{ fontFamily: 'var(--font-bebas)' }}>
          Simple pricing
        </h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {tiers.map(t => (
            <div
              key={t.name}
              className="rounded-2xl p-6 flex flex-col"
              style={{
                backgroundColor: 'var(--surface)',
                border: t.highlight ? '1px solid var(--accent)' : '1px solid var(--border)',
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold">{t.name}</h3>
                {t.highlight && (
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                  >
                    Most popular
                  </span>
                )}
              </div>
              <p className="text-2xl font-bold mb-4">{t.price}</p>
              <ul className="space-y-2 text-sm flex-1" style={{ color: 'var(--text-secondary)' }}>
                {t.perks.map(p => (
                  <li key={p} className="flex gap-2">
                    <span style={{ color: 'var(--accent)' }}>✓</span>
                    {p}
                  </li>
                ))}
              </ul>
              <Link
                href={authed ? '/profile' : '/signup'}
                className="block text-center font-semibold text-sm px-4 py-2.5 rounded-xl mt-6"
                style={
                  t.highlight
                    ? { backgroundColor: 'var(--accent)', color: 'var(--bg)' }
                    : { border: '1px solid var(--border)', color: 'var(--text)' }
                }
              >
                {authed ? 'Manage plan' : t.name === 'Free' ? 'Start free' : `Get ${t.name}`}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid var(--border)' }}>
        <div className="max-w-5xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-sm">{wordmark}</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <Link href="/privacy" className="hover:underline">Privacy</Link>
            <Link href="/terms" className="hover:underline">Terms</Link>
            <Link href="/support" className="hover:underline">Support</Link>
            <Link href="/dmca" className="hover:underline">DMCA</Link>
          </nav>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>© 2026 moodmixformat, LLC</p>
        </div>
      </footer>
    </div>
  )
}
