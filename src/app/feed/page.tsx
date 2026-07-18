import { getUserId } from '@/lib/auth'
import { getFeed, type FeedItem } from '@/lib/feed'
import Nav from '@/components/Nav'
import FeedClient from './FeedClient'

export const dynamic = 'force-dynamic'

export default async function FeedPage() {
  const userId = await getUserId()

  let items: FeedItem[] = []
  let loadError = false
  try {
    items = await getFeed()
  } catch {
    loadError = true
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 pb-36 md:pb-12 py-6 sm:py-8">
          <div className="mb-1">
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Feed</h1>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              New uploads from every artist on mixBASE — listen and leave notes
            </p>
          </div>
          <FeedClient initialItems={items} currentUserId={userId} loadError={loadError} />
        </div>
      </div>
    </div>
  )
}
