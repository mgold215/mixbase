#!/usr/bin/env node
// Try one command against Logic Pro through the mixBASE Intern helper running
// on this Mac (macos/MixbaseIntern). For looking at what Logic exposes and for
// checking a step by hand; the job loop (intern-worker.mjs) uses the same commands.
//
//   node scripts/intern-ax.mjs ping
//   node scripts/intern-ax.mjs app.windows
//   node scripts/intern-ax.mjs ax.dump '{"el":"e12","depth":2}'
//   node scripts/intern-ax.mjs ax.find '{"role":"AXButton","titleHas":"Bounce"}'
//   node scripts/intern-ax.mjs ax.menu '{"path":["File","Bounce","Project or Section..."],"press":false}'
//
// The commands are listed in macos/MixbaseIntern/Sources/AX.swift (dispatch).
// Element handles ("e12") stay valid until `ax.reset` or the helper restarts.

import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOCKET = join(process.env.INTERN_SUPPORT ?? join(os.homedir(), 'Library/Application Support/MixbaseIntern'), 'ax.sock')

/** Send one command over the helper's local socket and resolve with its result. */
export function socketCall(cmd, args = {}, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET)
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`${cmd}: no answer from the helper in ${timeoutMs / 1000}s`)) }, timeoutMs)
    sock.on('connect', () => sock.write(`${JSON.stringify({ ...args, rpc: 1, cmd })}\n`))
    sock.on('data', d => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer); sock.end()
      const reply = JSON.parse(buf.slice(0, nl))
      if (reply.ok) resolve(reply.result); else reject(new Error(reply.error ?? `${cmd} failed`))
    })
    sock.on('error', err => { clearTimeout(timer); reject(new Error(`The helper is not reachable (${err.code ?? err.message}). Is mixBASE Intern running?`)) })
  })
}

/** A dump or a list of elements as an indented outline, one element a line. */
export function outline(node, depth = 0) {
  if (Array.isArray(node)) return node.map(n => outline(n, depth)).join('')
  if (!node || typeof node !== 'object' || !node.h) return `${JSON.stringify(node)}\n`
  const bits = [node.h, node.role, node.sub, node.title && JSON.stringify(node.title), node.desc && `desc=${JSON.stringify(node.desc)}`,
    node.id && `id=${node.id}`, 'value' in node && `value=${JSON.stringify(node.value).slice(0, 60)}`, node.vdesc && `(${node.vdesc})`,
    node.help && `help=${JSON.stringify(node.help).slice(0, 60)}`, node.enabled === false && 'DISABLED', node.selected && 'SELECTED',
    node.frame && `@${node.frame.map(Math.round).join(',')}`, node.n && !node.children && `[${node.n} inside]`].filter(Boolean)
  return `${'  '.repeat(depth)}${bits.join(' ')}\n${(node.children ?? []).map(c => outline(c, depth + 1)).join('')}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // -t prints dumps and lists as an outline instead of JSON.
  const tree = process.argv.includes('-t')
  const [cmd, json] = process.argv.slice(2).filter(a => a !== '-t')
  if (!cmd) { process.stderr.write('Usage: node scripts/intern-ax.mjs <command> [json arguments]\n'); process.exit(2) }
  socketCall(cmd, json ? JSON.parse(json) : {})
    .then(r => process.stdout.write(tree ? outline(r) : `${JSON.stringify(r, null, 1)}\n`))
    .catch(err => { process.stderr.write(`${err.message}\n`); process.exit(1) })
}
