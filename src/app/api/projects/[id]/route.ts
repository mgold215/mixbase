import { NextRequest, NextResponse } from 'next/server'
import { getProject, updateProject, deleteProject } from '@/lib/localdb'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const project = getProject(id)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ project, versions: project.mf_versions })
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params
  const body = await request.json()
  const updated = updateProject(id, body)
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  deleteProject(id)
  return NextResponse.json({ ok: true })
}
