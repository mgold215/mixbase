import Nav from '@/components/Nav'
import SessionClient from './SessionClient'

export const dynamic = 'force-dynamic'

// /session — the Mix Session: open notes on each song's current mix, ticked off
// as you work, with the AI session assistant. Data comes from GET
// /api/mix-session on the client — the same route the native app calls — so
// the two can never disagree about what's left to do.
export default function SessionPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 pb-36 md:pb-12 py-6 sm:py-8">
          <div className="mb-5">
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Mix Session</h1>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Every open note on each song&apos;s current mix — tick them off as you work
            </p>
          </div>
          <SessionClient />
        </div>
      </div>
    </div>
  )
}
