// Preset text colors for baked-in overlays (finalized artwork + final videos).
// White first — it's the default everywhere. Any custom #RRGGBB is also
// accepted via the picker; the server validates and falls back to white.
export const TEXT_COLORS: { value: string; label: string }[] = [
  { value: '#FFFFFF', label: 'White' },
  { value: '#000000', label: 'Black' },
  { value: '#F5EFE0', label: 'Cream' },
  { value: '#D4AF37', label: 'Gold' },
  { value: '#E03A3E', label: 'Red' },
  { value: '#2DD4BF', label: 'Teal' },
  { value: '#F472B6', label: 'Pink' },
  { value: '#60A5FA', label: 'Blue' },
]
