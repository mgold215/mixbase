import { STATUS_CONFIG, STATUSES } from '@/lib/supabase'
import { normalizeStatus } from '@/lib/mix-status'

type Props = {
  status: string
  size?: 'sm' | 'md'
}

// Color badge for Mix / Master / Finished / Released. normalizeStatus folds
// retired values ('WIP', 'Mix/Master') from unmigrated rows onto the set.
export function StatusBadge({ status, size = 'md' }: Props) {
  const config = STATUS_CONFIG[normalizeStatus(status)]
  const sizeClass = size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-xs px-2.5 py-1'
  return (
    <span className={`inline-flex items-center rounded-full border font-medium ${config.color} ${config.bg} ${config.border} ${sizeClass}`}>
      {config.label}
    </span>
  )
}

type PipelineProps = {
  currentStatus: string
  className?: string
}

// Visual progress bar: Mix → Master → Finished → Released
export function StatusPipeline({ currentStatus, className = '' }: PipelineProps) {
  const normalized = normalizeStatus(currentStatus)
  const currentStep = STATUS_CONFIG[normalized].step

  return (
    <div className={`flex items-center gap-0 ${className}`}>
      {STATUSES.map((status, i) => {
        const config = STATUS_CONFIG[status]
        const step = config.step
        const isActive = step <= currentStep
        const isCurrent = status === normalized

        return (
          <div key={status} className="flex items-center">
            {/* Step dot */}
            <div className={`relative flex items-center justify-center`}>
              <div className={`w-2 h-2 rounded-full transition-colors ${
                isCurrent ? `ring-2 ring-offset-1 ring-offset-[#111] ${config.color.replace('text-', 'ring-')} ${config.color.replace('text-', 'bg-').replace('-400', '-400')}` :
                isActive ? 'bg-[#444]' : 'bg-[#222]'
              }`}
                style={isCurrent ? { backgroundColor: 'currentColor' } : {}}
              />
            </div>

            {/* Label below */}
            <div className="flex flex-col items-center mx-1">
              <span className={`text-[10px] whitespace-nowrap ${
                isCurrent ? config.color : isActive ? 'text-[#555]' : 'text-[#333]'
              }`}>
                {status}
              </span>
            </div>

            {/* Connector line */}
            {i < STATUSES.length - 1 && (
              <div className={`w-6 h-px mx-1 ${isActive && step < currentStep ? 'bg-[#333]' : 'bg-[#1e1e1e]'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}
