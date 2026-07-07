// Copy text to the clipboard with a fallback for contexts where the async
// Clipboard API is unavailable or blocked (insecure origin, some iOS webviews,
// denied permission). Resolves true on success, false if every path failed —
// callers should only show "Copied!" when it returns true.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  return legacyCopy(text)
}

// Synchronous execCommand fallback via a hidden textarea. Must run inside a user
// gesture to be allowed by the browser.
export function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
