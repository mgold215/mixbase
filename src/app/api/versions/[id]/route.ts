import { NextRequest, NextResponse } from 'next/server'
import { getVersion, updateVersion, deleteVersion, logActivity } from '@/lib/localdb'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const version = getVersion(id)
  if (!version) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(version)
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params
  const body = await request.json()

  const existing = getVersion(id)
  const updated = updateVersion(id, body)
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Log status change
  if (body.status && existing && body.status !== existing.status) {
    logActivity({
      type: 'status_change',
      project_id: existing.project_id,
      version_id: id,
      description: `v${existing.version_number} moved from ${existing.status} to ${body.status}`,
    })
  }

  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  deleteVersion(id)
  return NextResponse.json({ ok: true })
}
