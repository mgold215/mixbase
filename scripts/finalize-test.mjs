// Standalone proof: does my buildFinalized() darken pixels?
// Generates a known-color image, runs it through the same Sharp pipeline I
// commit to the route, then samples pixels in a region with NO text overlay.
// Input pixel === output pixel ⇒ no darkening. Input ≠ output ⇒ I'm wrong.

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
  const ruleSvg = placement.showRule ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="white" fill-opacity="0.75"/>` : ''
  const overlayH  = Math.round(totalH * 2.2)
  const overlayY  = Math.max(0, Math.round(cy - overlayH / 2))
  const overlayHc = Math.min(overlayH, height - overlayY)
  const op = placement.overlayOpacity.toFixed(2)
  const overlayLayer = placement.overlayOpacity > 0.02
    ? Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000" stop-opacity="0"/><stop offset="30%" stop-color="#000" stop-opacity="${op}"/><stop offset="70%" stop-color="#000" stop-opacity="${op}"/><stop offset="100%" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect x="0" y="${overlayY}" width="${width}" height="${overlayHc}" fill="url(#g)"/></svg>`)
    : null
  const textSvg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${artistPaths}${ruleSvg}${titlePaths}</svg>`)
  const layers = []
  if (overlayLayer) layers.push({ input: overlayLayer, blend: 'over' })
  layers.push({ input: textSvg, blend: 'over' })
  return img.composite(layers).jpeg({ quality: 94 }).toBuffer()
}

async function samplePixel(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const idx = (y * info.width + x) * info.channels
  return [data[idx], data[idx + 1], data[idx + 2]]
}

async function run() {
  // Build a 1024x1024 input with a known dim cyberpunk-ish color (RGB 32,42,52)
  const w = 1024, h = 1024
  const inputBuf = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 32, g: 42, b: 52 } },
  }).jpeg({ quality: 100 }).toBuffer()

  console.log('SOURCE pixel at (100,100):', await samplePixel(inputBuf, 100, 100))

  // Bottom-zone placement (textCenterY=0.85), no overlay, no rule.
  // Sample pixel at (100,100) — far away from the text region.
  const out = await buildFinalized(inputBuf, 'NEVERTHELESS', 'moodmixformat', {
    textCenterY: 0.85, overlayOpacity: 0.0, showRule: true,
  })
  console.log('OUTPUT pixel at (100,100):', await samplePixel(out, 100, 100))

  // Sample pixel at center of cover — well above the text band
  console.log('SOURCE pixel at (512,400):', await samplePixel(inputBuf, 512, 400))
  console.log('OUTPUT pixel at (512,400):', await samplePixel(out, 512, 400))

  // With a backdrop opacity, what happens to pixel under the text band?
  const out2 = await buildFinalized(inputBuf, 'NEVERTHELESS', 'moodmixformat', {
    textCenterY: 0.85, overlayOpacity: 0.20, showRule: true,
  })
  console.log('OVERLAY-ON pixel at (100,100) [outside band]:', await samplePixel(out2, 100, 100))
  console.log('OVERLAY-ON pixel at (100,870) [inside band]:', await samplePixel(out2, 100, 870))
}

run().catch(e => { console.error(e); process.exit(1) })
