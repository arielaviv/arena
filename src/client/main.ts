import './ui/styles.css'
import { App } from './app/app'

const canvas = document.getElementById('scene')
const ui = document.getElementById('ui')
if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('missing #scene or #ui')

const app = new App(canvas, ui)

let last = performance.now()
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  app.frame(dt)
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

if (import.meta.env.DEV) {
  Object.assign(window, { __arena: app })
}
