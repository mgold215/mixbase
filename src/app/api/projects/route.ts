import { NextRequest, NextResponse } from 'next/server'
import { getProjects, createProject, logActivity } from '@/lib/localdb'

export async function GET() {
  const projects = getProjects()
  return NextResponse.json(projects)
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { title, genre, bpm, key_signature } = body

  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  const project = createProject({ title: title.trim(), genre, bpm, key_signature })

  logActivity({
    type: 'project_created',
    project_id: project.id,
    description: `Project "${project.title}" created`,
  })

  return NextResponse.json(project, { status: 201 })
}
