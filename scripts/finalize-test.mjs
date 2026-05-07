// Standalone proof: does my buildFinalized() darken pixels?
// Generates a known-color image, runs it through the SAME Sharp pipeline the
// route uses, then samples pixels in regions both far from and adjacent to
// the text. Far from text MUST be pixel-identical. Adjacent to text picks up
// drop shadow but only in a narrow halo.

import sharp from 'sharp'
import { readFileSync } from 'fs'
import { join } from 'path'
import opentype from 'opentype.js'
const { parse: parseFont } = opentype

const FONT_BUF = readFileSync(join(process.cwd(), 'src/fonts/FuturaBold.ttf'))
const FONT_AB  = FONT_BUF.buffer.slice(FONT_BUF.byteOffset, FONT_BUF.byteOffset + FONT_BUF.byteLength)
const FONT = parseFont(FONT_AB)

function textToSvgPaths(text, cx, baselineY, fontSize, letterSpacing, fill, fillOpacity) {
  const glyphs = FONT.stringToGlyphs(text)
  const scale  = fontSize / FONT.unitsPerEm
  let totalW = 0
  glyphs.forEach((g, i) => {
    totalW += (g.advanceWidth ?? 0) * scale
    if (i < glyphs.length - 1) totalW += letterSpacing
  })
  let x = cx - totalW / 2
  const parts = []
  for (const g of glyphs) {
    const pathObj = g.getPath(x, baselineY, fontSize)
    const svgEl   = pathObj.toSVG(1)
    const dMatch  = svgEl.match(/d="([^"]+)"/)
    if (dMatch) parts.push(`<path d="${dMatch[1]}" fill="${fill}" fill-opacity="${fillOpacity}"/>`)
    x += (g.advanceWidth ?? 0) * scale + letterSpacing
  }
  return { markup: parts.join('\n'), totalW }
}

async function buildFinalized(imageBuffer, title, artist, placement) {
  const img = sharp(imageBuffer)
  const { width = 1024, height = 1024 } = await img.metadata()
  const cx = Math.round(width * 0.5)
  const cy = Math.round(placement.textCenterY * height)
  const artistSize = Math.round(width * 0.018)
  const artistLS   = Math.round(artistSize * 0.22)
  const titleSize  = Math.round(width * 0.038)
  const titleLS    = Math.round(titleSize  * 0.06)
  const ruleH      = placement.showRule ? Math.max(1, Math.round(width * 0.0015)) : 0
  const gapAbove   = placement.showRule ? Math.round(width * 0.014) : Math.round(width * 0.010)
  const gapBelow   = placement.showRule ? Math.round(width * 0.006) : 0
  const totalH     = artistSize + gapAbove + ruleH + gapBelow + titleSize
  const artistY = Math.round(cy - totalH / 2 + artistSize)
  const ruleY   = Math.round(artistY + gapAbove)
  const titleY  = Math.round(ruleY + ruleH + gapBelow + titleSize)
  const { markup: artistPaths, totalW: artistW } = textToSvgPaths(artist.toLowerCase(), cx, artistY, artistSize, artistLS, 'white', 0.90)
  const { markup: titlePaths } = textToSvgPaths(title.toUpperCase(), cx, titleY, titleSize, titleLS, 'white', 1.00)
  const ruleW = Math.round(artistW)
  const ruleX = Math.round(cx - ruleW / 2)
  const ruleSvg = placement.showRule
    ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.75" filter="url(#textShadow)"/>`
    : ''
  const shadowSigma = Math.max(2, Math.round(titleSize * 0.08))
  const textSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="${Math.round(shadowSigma * 0.5)}" stdDeviation="${shadowSigma}" flood-color="#000" flood-opacity="0.65"/>
        </filter>
      </defs>
      <g filter="url(#textShadow)">${artistPaths}${titlePaths}</g>
      ${ruleSvg}
    </svg>`
  )
  return img
    .composite([{ input: textSvg, blend: 'over' }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer()
}

async function samplePixel(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const idx = (y * info.width + x) * info.channels
  return [data[idx], data[idx + 1], data[idx + 2]]
}

function eq(a, b, tol = 0) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol
}

async function run() {
  const w = 1024, h = 1024
  const SRC_RGB = { r: 32, g: 42, b: 52 }   // dim cyberpunk-ish
  const inputBuf = await sharp({
    create: { width: w, height: h, channels: 3, background: SRC_RGB },
  }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()

  const out = await buildFinalized(inputBuf, 'NEVERTHELESS', 'moodmixformat', {
    textCenterY: 0.85,
    showRule: true,
  })

  // Sample points: top-left corner, far-from-text middle, top-right
  const tests = [
    { name: 'corner (10,10)',         pt: [10, 10] },
    { name: 'middle (512,400)',       pt: [512, 400] },
    { name: 'top-right (1000,30)',    pt: [1000, 30] },
    { name: 'left edge mid (5,500)',  pt: [5, 500] },
  ]

  let allPass = true
  console.log(`Source RGB: [${SRC_RGB.r}, ${SRC_RGB.g}, ${SRC_RGB.b}]`)
  console.log('---')
  for (const t of tests) {
    const pix = await samplePixel(out, t.pt[0], t.pt[1])
    const pass = eq([SRC_RGB.r, SRC_RGB.g, SRC_RGB.b], pix, 1)  // 1-LSB tolerance for JPEG round-trip
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${t.name.padEnd(24)} → [${pix.join(', ')}]`)
    if (!pass) allPass = false
  }

  // Pixel directly under text glyph (should be brighter — white)
  const textSamplePix = await samplePixel(out, 512, 875)  // rough center of title row
  console.log('---')
  console.log(`text-row sample (512,875)        → [${textSamplePix.join(', ')}]   (expect brighter from glyph or shadow)`)

  console.log('---')
  console.log(allPass ? '✅ ALL non-text pixels match source within 1 LSB.' : '❌ FAILURE — code is touching pixels it shouldn\'t.')
  process.exit(allPass ? 0 : 1)
}

run().catch(e => { console.error(e); process.exit(1) })
