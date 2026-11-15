// Renders the PNG app icons from public/favicon.svg with Playwright's Chromium (a dev dependency).
// Run via `make icons` (node scripts/icons.mjs <web dir>); commit the PNGs it writes.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const webDir = process.argv[2]
const require = createRequire(join(webDir, 'package.json'))
const { chromium } = require('@playwright/test')

const svg = readFileSync(join(webDir, 'public/favicon.svg'), 'utf8')
// Full-bleed: same artwork, background without rounded corners (iOS masks it).
const fullBleed = svg.replace('rx="14" ', '')
if (fullBleed === svg) throw new Error('rx not found')

const jobs = [
  { out: 'public/apple-touch-icon.png', size: 180, svg: fullBleed },
  { out: 'public/icon-192.png', size: 192, svg },
  { out: 'public/icon-512.png', size: 512, svg },
]

const browser = await chromium.launch()
for (const j of jobs) {
  const page = await browser.newPage({ viewport: { width: j.size, height: j.size }, deviceScaleFactor: 1 })
  const sized = j.svg.replace('<svg ', `<svg style="display:block" width="${j.size}" height="${j.size}" `)
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`)
  await page.locator('svg').screenshot({ path: join(webDir, j.out), omitBackground: true })
  await page.close()
  console.log('wrote', j.out)
}
await browser.close()
