import ModalShell from '@/components/ModalShell'
import NewProjectForm from '@/app/projects/new/NewProjectForm'

// Static sibling of (.)projects/[id] — without it the dynamic interceptor
// would swallow /projects/new. Renders the creation form as a modal too.
export default function NewProjectModalPage() {
  return (
    <ModalShell>
      <div className="max-w-lg mx-auto px-6 py-10">
        <NewProjectForm />
      </div>
    </ModalShell>
  )
}
