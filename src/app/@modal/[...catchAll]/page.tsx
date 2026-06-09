// Parallel-route slots keep their last active state on client-side navigation.
// This catch-all matches every non-intercepted route and renders nothing, so
// the project modal closes when navigating anywhere else (e.g. /pipeline).
export default function CatchAll() {
  return null
}
