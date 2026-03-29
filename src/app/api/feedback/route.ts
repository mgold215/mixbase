import { NextRequest, NextResponse } from 'next/server'
import { createFeedback, logActivity } from '@/lib/localdb'

export async function POST(request: NextRequest) {
  const { version_id, reviewer_name, rating, comment } = await request.json()

  if (!version_id || !comment?.trim()) {
    return NextResponse.json({ error: 'version_id and comment are required' }, { status: 400 })
  }

  const { feedback, version } = createFeedback({
    version_id,
    reviewer_name,
    rating,
    comment,
  })

  if (version) {
    logActivity({
      type: 'feedback_received',
      project_id: version.project_id,
      version_id,
      description: `Feedback from ${reviewer_name || 'Anonymous'} on v${version.version_number}`,
    })
  }

  return NextResponse.json(feedback, { status: 201 })
}
