#!/usr/bin/env node
// Contract test for the artwork-generation model registry + resolver
// (src/lib/artwork-models.ts).
//
// The route reserves a monthly artwork slot BEFORE the paid Replicate call, then
// selects the model endpoint + input builder from a client-supplied `model`
// string. The old selection — `MODEL_ENDPOINTS[model] ?? MODEL_ENDPOINTS.flux` —
// looked safe but a crafted `model` naming an inherited Object.prototype member
// (`__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`) resolves
// TRUTHY, so `??` never falls back. The route then called inputFn(prompt) on a
// non-function (or fetch()'d a non-URL endpoint) and threw — a 500 that lands
// after the slot was reserved and off any refund path, silently BURNING the
// user's monthly quota. resolveModelKey closes this with an own-property gate.
//
// This locks the resolver so the gap can't silently return. A "witness" assert
// reproduces the old vulnerable pattern and proves it WOULD have crashed, so the
// test is fail-first against the pre-fix behaviour.
//
// Runs on Node 22 native TS type-stripping, same as the other renderer tests.
// Run: node scripts/artwork-models-test.mjs  (also part of `npm run test:renderers`)

import {
  MODEL_ENDPOINTS,
  MODEL_INPUTS,
  IMAGE_MODELS,
  resolveModelKey,
  composeLook,
  DEFAULT_MODEL,
  LOOK_VANTAGE,
  LOOK_LIGHT,
  LOOK_WEATHER,
  LOOK_MOOD,
} from '../src/lib/artwork-models.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

console.log('artwork-models: registry integrity')

const KEYS = Object.keys(MODEL_ENDPOINTS)
check('6 models registered', KEYS.length === 6, `${KEYS.length}`)
check('default model is a real key', KEYS.includes(DEFAULT_MODEL), DEFAULT_MODEL)
check(
  'endpoints and inputs have identical key sets',
  KEYS.length === Object.keys(MODEL_INPUTS).length && KEYS.every(k => k in MODEL_INPUTS),
)
check(
  'every endpoint is an https Replicate URL',
  KEYS.every(k => typeof MODEL_ENDPOINTS[k] === 'string'
    && MODEL_ENDPOINTS[k].startsWith('https://api.replicate.com/')),
)
check(
  'every input builder returns an object carrying the prompt',
  KEYS.every(k => {
    const out = MODEL_INPUTS[k]('the-prompt')
    return out && typeof out === 'object' && out.prompt === 'the-prompt'
  }),
)

console.log('\nartwork-models: resolveModelKey — crash-proof selection')

// Witness: reproduce the OLD vulnerable selection and prove it broke. This is
// what makes the suite fail-first — these two facts are the bug.
const oldEndpoint = m => MODEL_ENDPOINTS[m] ?? MODEL_ENDPOINTS.flux
const oldInputFn  = m => MODEL_INPUTS[m] ?? MODEL_INPUTS.flux
check(
  'WITNESS: old pattern picked a non-URL endpoint for "__proto__" (the bug)',
  typeof oldEndpoint('__proto__') !== 'string',
)
check(
  'WITNESS: old pattern picked a non-function input for "__proto__" (the bug)',
  typeof oldInputFn('__proto__') !== 'function',
)

// Every valid key passes through untouched.
for (const k of KEYS) {
  check(`valid key "${k}" resolves to itself`, resolveModelKey(k) === k)
}

// Crafted inherited-prototype names collapse to the default (no crash).
for (const bad of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype']) {
  check(`crafted "${bad}" resolves to ${DEFAULT_MODEL}`, resolveModelKey(bad) === DEFAULT_MODEL)
}

// Ordinary unknown strings and non-strings also collapse to the default.
for (const junk of ['bogus', '', 'FLUX', ' flux ']) {
  check(`unknown string ${JSON.stringify(junk)} → ${DEFAULT_MODEL}`, resolveModelKey(junk) === DEFAULT_MODEL)
}
for (const junk of [null, undefined, 123, {}, [], true]) {
  check(`non-string ${JSON.stringify(junk) ?? String(junk)} → ${DEFAULT_MODEL}`, resolveModelKey(junk) === DEFAULT_MODEL)
}

// The payoff: for ANY input, the resolved key yields a usable endpoint + a
// callable input builder — i.e. the route can never throw on selection again.
check(
  'resolved key is always usable (endpoint URL + callable input) for hostile inputs',
  ['__proto__', 'constructor', 'toString', 'bogus', '', null, undefined, 42].every(m => {
    const key = resolveModelKey(m)
    const ep = MODEL_ENDPOINTS[key]
    const fn = MODEL_INPUTS[key]
    return typeof ep === 'string' && ep.startsWith('https://') && typeof fn === 'function'
      && fn('p').prompt === 'p'
  }),
)

console.log('\nartwork-models: IMAGE_MODELS UI list stays 1:1 with the registry')

// The client selectors (Artwork tab + collection cover picker) render this list
// and send its ids straight to the paid route. `satisfies` proves at compile
// time that every id is a real key; these runtime asserts additionally prove the
// list is EXHAUSTIVE and duplicate-free, so a model can't be added to the
// registry (or removed) without its selector entry moving in lockstep.
const uiIds = IMAGE_MODELS.map(m => m.id)
check('one UI entry per registered model', IMAGE_MODELS.length === KEYS.length, `${IMAGE_MODELS.length} vs ${KEYS.length}`)
check('every UI id is a real registry key', uiIds.every(id => KEYS.includes(id)), uiIds.join(','))
check('every registry key has exactly one UI entry (no drift)',
  KEYS.every(k => uiIds.filter(id => id === k).length === 1))
check('UI ids are unique', new Set(uiIds).size === uiIds.length)
check('every UI entry has a non-empty label',
  IMAGE_MODELS.every(m => typeof m.label === 'string' && m.label.trim().length > 0))
check('resolveModelKey accepts every UI id unchanged (selector can never burn quota)',
  IMAGE_MODELS.every(m => resolveModelKey(m.id) === m.id))

console.log('\nartwork-models: composeLook')

// The pool phrases themselves contain commas, so a ", " split can't recover the
// axes. Instead check membership in the full vantage×light×weather×mood product:
// a valid output must be exactly one of these combinations, which proves each
// axis was picked from its own pool and joined in order.
const VALID_LOOKS = new Set()
for (const v of LOOK_VANTAGE) for (const l of LOOK_LIGHT) for (const w of LOOK_WEATHER) for (const m of LOOK_MOOD)
  VALID_LOOKS.add([v, l, w, m].join(', '))
check('valid-look product is 6×6×5×5', VALID_LOOKS.size === 900, `${VALID_LOOKS.size}`)

const look = composeLook()
check('composeLook returns a non-empty string', typeof look === 'string' && look.length > 0)
check('composeLook output is a valid vantage×light×weather×mood combination', VALID_LOOKS.has(look), look)
// Sample enough runs to catch an out-of-bounds pick or empty pool.
check(
  '200 runs all produce valid combinations',
  Array.from({ length: 200 }, composeLook).every(l => VALID_LOOKS.has(l)),
)

console.log(failures === 0 ? '\nAll artwork-models tests passed' : `\n${failures} artwork-models test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
