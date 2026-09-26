'use client'

// "Share to feed" checkbox shown next to every mix upload. Ticked by default;
// unticked uploads are saved with in_feed = false and never appear on the
// community feed (see POST /api/versions and getFeed in src/lib/feed.ts).
export default function ShareToFeedToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label
      className="inline-flex items-center gap-2 text-sm cursor-pointer select-none"
      style={{ color: 'var(--text-secondary)', opacity: disabled ? 0.5 : 1 }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 rounded cursor-pointer"
        style={{ accentColor: '#2dd4bf' }}
      />
      Share to feed
    </label>
  )
}
