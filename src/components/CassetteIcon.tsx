import type { CSSProperties } from 'react'

// The app-wide "no artwork" mark: a cassette, drawn lucide-style (24px grid,
// stroke = currentColor) so it drops in anywhere a lucide icon was — color
// comes from the surrounding text color exactly like <Music /> did. Also the
// source shape for the favicon/PWA icons (scripts/generate-icons.mjs).
export default function CassetteIcon({ size = 24, strokeWidth = 2, className, style }: {
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <circle cx="8" cy="11" r="2" />
      <circle cx="16" cy="11" r="2" />
      <path d="M10 11h4" />
      <path d="M6.5 19l1.2-3.5h8.6L17.5 19" />
    </svg>
  )
}
