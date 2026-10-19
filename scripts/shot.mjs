// Headless smoke test + screenshots against the dev server.
// Usage: node scripts/shot.mjs <outDir> [steps...]
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const out = process.argv[2] ?? 'shots'
const url = process.env.ARENA_URL ?? 'http://127.0.0.1:5180/?shots'
mkdirSync(out, { recursive: true })

const candidates = [
  process.env.CHROME_PATH,
  `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1200\\chrome-win64\\chrome.exe`,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)
const executablePath = candidates.find((p) => existsSync(p))

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: (process.env.ARENA_GL === 'soft'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=d3d11', '--enable-gpu', '--enable-gpu-rasterization']
  ).concat(['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']),
})
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const logs = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`))

const wait = (ms) => page.waitForTimeout(ms)
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) })

await page.goto(url, { waitUntil: 'load' })
await wait(3500)
await shot('01-title')

const steps = process.argv.slice(3)
for (const step of steps) {
  const i = step.indexOf(':')
  const kind = i < 0 ? step : step.slice(0, i)
  const arg = i < 0 ? '' : step.slice(i + 1)
  if (kind === 'click') await page.locator(`text=${arg} >> visible=true`).first().click()
  else if (kind === 'key') await page.keyboard.press(arg)
  else if (kind === 'wait') await wait(Number(arg))
  else if (kind === 'shot') await shot(arg)
  else if (kind === 'eval') console.log(await page.evaluate(arg))
  else if (kind === 'js') console.log(await page.evaluate(decodeURIComponent(arg)))
}

console.log(logs.length ? logs.join('\n') : 'no console errors')
await browser.close()
