// Shared helpers for the SOURCE-CONTRACT halves of the test suites.
//
// Several suites assert things a pure test cannot see — the ORDER of two
// statements, the presence of a guard, the absence of an owner filter. Those
// assertions read the source file as text, and text assertions rot in two
// specific ways this module exists to prevent:
//
//   1. MATCHING INSIDE A COMMENT. A guard deleted from the code but still
//      described in the comment above it would keep its assertion green.
//      `stripComments` removes comments (respecting string and template
//      literals, so 'https://…' survives) before anything is matched.
//
//   2. MAGIC CHARACTER WINDOWS. `/anchor[\s\S]{0,1400}?thing/` is a guess about
//      how far apart two things sit, and every edit in between moves them. One
//      such assertion in project-delete-assets-test.mjs was measured 1450
//      characters short of the code it claimed to police — it could not see
//      either query it was guarding. `functionBody` and `bracketedBlock` slice
//      the ACTUAL syntactic region instead, so distance stops mattering.
//
// Both extractors return '' when they cannot find or balance the region, which
// would make a "does NOT contain" assertion vacuously true. Always pair one
// with a positive check that the region was found and contains what it should —
// see the `…was located` checks in the suites.
//
// Not named *-test.mjs on purpose: scripts/run-renderer-tests.mjs treats every
// scripts/*-test.mjs as a suite it must list and run.

/**
 * Remove line and block comments, leaving string and template literals intact.
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
      if (c === quote) quote = null
      out += c; i++; continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    out += c; i++
  }
  return out
}

/**
 * The source of one balanced bracketed region, from `marker` through the
 * bracket that closes the first `open` after it.
 *
 * Quoted spans are skipped whole, so a brace inside a string — or a `${…}`
 * inside a template literal — cannot unbalance the count. Returns '' if the
 * marker is absent or the region never closes.
 */
export function bracketedBlock(src, marker, open = '{', close = '}') {
  const start = src.indexOf(marker)
  if (start === -1) return ''
  const from = src.indexOf(open, start)
  if (from === -1) return ''
  let depth = 0
  let quote = null
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

/**
 * The signature and full body of the function `marker` introduces.
 *
 * Use this instead of a character window whenever an assertion is about what a
 * particular function does or does not contain.
 */
export function functionBody(src, marker) {
  return bracketedBlock(src, marker)
}
