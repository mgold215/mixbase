'use client'

// Stub — full implementation coming in Task 2
type Props = {
  projectId: string
  projectTitle: string
  artworkUrl: string | null | undefined
  onSwitchToArtwork: () => void
}

export default function Visualizer({ projectTitle, onSwitchToArtwork }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
      <p className="text-[#555] text-sm">Visualizer coming soon for <span className="text-white">{projectTitle}</span></p>
      <button
        onClick={onSwitchToArtwork}
        className="text-xs text-[#2dd4bf] hover:underline"
      >
        Go to Artwork tab
      </button>
    </div>
  )
}
