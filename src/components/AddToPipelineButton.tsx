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
      title={hasRelease ? 'View in Release Pipeline' : 'Add to Release Pipeline'}
      className="flex items-center justify-center w-7 h-7 rounded-lg text-xs transition-colors bg-[#2dd4bf]/10 hover:bg-[#2dd4bf]/20 text-[#2dd4bf] disabled:opacity-60"
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
    </button>
  )
}
