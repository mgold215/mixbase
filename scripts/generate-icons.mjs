#!/usr/bin/env node
// Regenerates the favicon + PWA icons from the cassette mark (the same shape
// as src/components/CassetteIcon.tsx), teal on the app's dark background.
// Outputs: public/icons/icon-512.png, icon-192.png, apple-touch-icon.png
// (180px) and src/app/favicon.ico (16/32/48 PNG-in-ICO — valid for every
// modern browser).
//
// Run: node scripts/generate-icons.mjs   (one-shot; artifacts are committed)

import sharp from 'sharp'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 512-grid version of CassetteIcon, scaled up with strokes thick enough to
// survive 16px. Full-bleed rounded background keeps `purpose: any maskable`
// working in the PWA manifest.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="100" fill="#080808"/>
  <g stroke="#2dd4bf" stroke-width="30" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <rect x="66" y="130" width="380" height="252" rx="40"/>
    <circle cx="178" cy="238" r="42"/>
    <circle cx="334" cy="238" r="42"/>
    <path d="M220 238h72"/>
    <path d="M150 382l24-66h164l24 66"/>
  </g>
</svg>`

const svg = Buffer.from(SVG)
const png = (size) => sharp(svg, { density: 300 }).resize(size, size).png().toBuffer()

// A valid .ico is a tiny directory header followed by embedded PNGs.
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  const blobs = []
  let offset = 6 + 16 * images.length
  for (const { size, data } of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // width
    e.writeUInt8(size >= 256 ? 0 : size, 1) // height
    e.writeUInt8(0, 2)  // palette
    e.writeUInt8(0, 3)  // reserved
    e.writeUInt16LE(1, 4)  // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
    blobs.push(data)
  }
  return Buffer.concat([header, ...entries, ...blobs])
}

writeFileSync(join(root, 'public/icons/icon-512.png'), await png(512))
writeFileSync(join(root, 'public/icons/icon-192.png'), await png(192))
writeFileSync(join(root, 'public/icons/apple-touch-icon.png'), await png(180))
writeFileSync(join(root, 'src/app/favicon.ico'), buildIco([
  { size: 16, data: await png(16) },
  { size: 32, data: await png(32) },
  { size: 48, data: await png(48) },
]))
console.log('✅ wrote icon-512.png, icon-192.png, apple-touch-icon.png, favicon.ico')
