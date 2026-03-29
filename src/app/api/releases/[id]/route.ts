import { NextRequest, NextResponse } from 'next/server'
import { updateRelease, deleteRelease } from '@/lib/localdb'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params
  const body = await request.json()
  const updated = updateRelease(id, body)
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  deleteRelease(id)
  return NextResponse.json({ ok: true })
}
