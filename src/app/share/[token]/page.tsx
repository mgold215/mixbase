import { getVersionByToken } from '@/lib/localdb'
import { notFound } from 'next/navigation'
import Image from 'next/image'
import ShareClient from './ShareClient'
import { formatDuration } from '@/lib/supabase'
import { StatusBadge } from '@/components/StatusBadge'

export const dynamic = 'force-dynamic'

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const version = getVersionByToken(token)
  if (!version) notFound()

  const project = version.mf_projects

  return (
    <div className="min-h-screen bg-[#080808] flex flex-col">
      <header className="border-b border-[#111] px-6 py-4 flex items-center justify-between">
        <span className="text-sm font-bold text-[#555] tracking-tight">Mixfolio</span>
        <span className="text-xs text-[#333]">Private share</span>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-6 py-12">
        <div className="flex gap-5 mb-8">
          <div className="relative w-24 h-24 rounded-xl overflow-hidden bg-[#111] flex-shrink-0 border border-[#1a1a1a]">
            {project?.artwork_url ? (
              <Image
                src={project.artwork_url}
                alt={project.title}
                fill
                className="object-cover"
                unoptimized={project.artwork_url.startsWith('/')}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-[#333] text-2xl">♪</div>
            )}
          </div>
          <div className="pt-1">
            <h1 className="text-xl font-bold text-white">{project?.title ?? 'Untitled'}</h1>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-sm text-[#555]">Version {version.version_number}</span>
              {version.label && <span className="text-sm text-[#444]">— {version.label}</span>}
            </div>
            <div className="flex items-center gap-3 mt-2">
              <StatusBadge status={version.status} size="sm" />
              {version.duration_seconds && (
                <span className="text-xs text-[#444]">{formatDuration(version.duration_seconds)}</span>
              )}
              {project?.genre && <span className="text-xs text-[#444]">{project.genre}</span>}
            </div>
          </div>
        </div>

        <ShareClient version={version} />
      </main>
    </div>
  )
}
