import { NextRequest, NextResponse } from 'next/server'
import { getReleases, createRelease, logActivity } from '@/lib/localdb'

export async function GET() {
  const releases = getReleases()
  return NextResponse.json(releases)
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { title, release_date, project_id, genre, label, isrc, notes } = body

  if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 })

  const release = createRelease({ title: title.trim(), release_date, project_id, genre, label, isrc, notes })

  logActivity({
    type: 'release_created',
    project_id: project_id ?? null,
    release_id: release.id,
    description: `Release "${release.title}" added to pipeline`,
  })

  return NextResponse.json(release, { status: 201 })
}
