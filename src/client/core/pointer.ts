import type { Input } from './input'

const DRAG_PX = 4
export const ZOOM_MIN = 2.5
export const ZOOM_MAX = 13

// Classic mouse: a visible cursor for picking units, either button dragged
// to turn the camera (pointer lock while held, so turning never hits the
// screen edge), and the wheel to zoom.
export class Pointer {
  x = window.innerWidth / 2
  y = window.innerHeight / 2
  enabled = false
  zoom = 6
  private press: { button: number; x: number; y: number; dragged: boolean } | null = null
  onClick: ((button: number, x: number, y: number) => void) | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    input: Input,
  ) {
    canvas.addEventListener('mousemove', (e) => {
      if (input.locked) return
      this.x = e.clientX
      this.y = e.clientY
    })
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || (e.button !== 0 && e.button !== 2)) return
      if (this.press) return
      this.press = { button: e.button, x: e.clientX, y: e.clientY, dragged: false }
    })
    document.addEventListener('mousemove', (e) => {
      const p = this.press
      if (!p) return
      if (!p.dragged && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_PX) {
        p.dragged = true
        input.lock()
      }
      // Until the lock engages, turn by the raw movement.
      if (p.dragged && !input.locked) input.turn(e.movementX, e.movementY)
    })
    window.addEventListener('mouseup', (e) => {
      const p = this.press
      if (!p || e.button !== p.button) return
      this.press = null
      if (p.dragged) input.unlock()
      else this.onClick?.(p.button, p.x, p.y)
    })
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return
        e.preventDefault()
        const step = Math.sign(e.deltaY) * 0.12
        this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * (1 + step)))
      },
      { passive: false },
    )
  }

  get dragging(): boolean {
    return this.press?.dragged ?? false
  }

  setCursor(css: string): void {
    if (this.canvas.style.cursor !== css) this.canvas.style.cursor = css
  }
}
