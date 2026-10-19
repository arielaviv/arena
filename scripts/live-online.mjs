// Live check: open the deployed site, queue, and log the matchmaking/room websockets.
// Usage: node scripts/live-online.mjs <screenshot.png>
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const log = []
const t0 = Date.now()
page.on('websocket', (ws) => {
  const kind = ws.url().includes('/queue') ? 'queue' : ws.url().includes('/room/') ? 'room' : ws.url()
  log.push(`${Date.now() - t0}ms open ${kind}`)
  let n = 0
  ws.on('framereceived', (f) => { if (n++ < 2) log.push(`${Date.now() - t0}ms ${kind} <- ${String(f.payload).slice(0, 40)}`) })
})
page.on('pageerror', (e) => log.push('pageerror ' + e.message))
await page.goto('https://arena-ecru-six.vercel.app/?shots')
await page.waitForTimeout(6000)
await page.locator('text=PLAY >> visible=true').first().click()
await page.waitForTimeout(400)
await page.keyboard.press('Digit4')
await page.waitForTimeout(12000)
await page.screenshot({ path: process.argv[2] })
console.log(log.join('\n'))
await browser.close()
