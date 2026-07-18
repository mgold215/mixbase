// src/lib/usage-refund.ts
// Pure refund planner for the monthly generation quota. Dependency-free (no DB,
// no imports) so the two invariants that matter can be unit-tested without a
// live database — see scripts/usage-refund-test.mjs.
//
// Used by tier.ts refundUsage(): given the current mb_usage row and the feature
// being refunded, return the decremented patch, or null when there's nothing to
// hand back.
//
// Invariants:
//   (1) it decrements ONLY the feature that was reserved, never the other counter;
//   (2) the `current <= 0` guard means the counter can never go negative — a
//       double-refund or a refund with no reservation is a no-op.

export function planUsageRefund(
  feature: 'artwork' | 'video',
  row: { artwork_generations: number; video_generations: number } | null | undefined,
): { artwork_generations: number } | { video_generations: number } | null {
  if (!row) return null // no usage row → nothing was reserved → nothing to refund
  const current = feature === 'artwork' ? row.artwork_generations : row.video_generations
  if (current <= 0) return null
  return feature === 'artwork'
    ? { artwork_generations: current - 1 }
    : { video_generations: current - 1 }
}
