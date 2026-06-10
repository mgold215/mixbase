// Parallel-route slots keep their last active state on client-side navigation.
// This catch-all matches every non-intercepted route and renders nothing, so
// the project modal closes when navigating anywhere else (e.g. /pipeline).
// generateStaticParams marks the segment static — without it the slot is
// dynamic, adding a server round-trip to EVERY navigation, even between
// otherwise static pages. (force-static would conflict with force-dynamic
// sibling pages.)
export function generateStaticParams(): Array<{ catchAll: string[] }> {
  return []
}

export default function CatchAll() {
  return null
}
