import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import Nav from '@/components/Nav'
import NewProjectForm from './NewProjectForm'

export default function NewProjectPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <div className="max-w-lg mx-auto px-6 py-12">
          <Link href="/dashboard" className="flex items-center gap-2 text-sm mb-8 transition-colors w-fit"
            style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft size={14} />
            Back
          </Link>
          <NewProjectForm />
        </div>
      </div>
    </div>
  )
}
