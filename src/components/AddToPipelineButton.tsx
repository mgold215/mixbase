'use client'

import { useState, type MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2 } from 'lucide-react'

type Props = {
  projectId: string
  projectTitle: string
  hasRelease: boolean
}

export default function AddToPipelineButton({ projectId, projectTitle, hasRelease }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleClick(e: MouseEvent) {
    e.preventDefault()
    if (hasRelease) {
      router.push('/pipeline')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: projectTitle, project_id: projectId }),
      })
      if (res.ok) router.push('/pipeline')
      else router.push('/pipeline')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="flex items-center justify-between w-full px-3 py-2 rounded-xl text-xs font-medium transition-colors bg-[#a78bfa]/10 hover:bg-[#a78bfa]/20 text-[#a78bfa] disabled:opacity-60"
    >
      <span>{hasRelease ? 'View in Release Pipeline' : 'Add to Release Pipeline'}</span>
      {loading ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
    </button>
  )
}
