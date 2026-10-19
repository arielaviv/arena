import type { Quality, Renderer } from '../core/renderer'

// Watches frame times. Early in a match it steps quality down until the game
// holds ~60 fps; `?fps` shows a small overlay.
export class PerfMonitor {
  private samples: number[] = []
  private sampleTime = 0
  private settleTime = 0
  private locked = false
  private readonly overlay: HTMLDivElement | null
  private overlayTimer = 0
  private frames = 0
  onDowngrade: ((q: Quality) => void) | null = null

  constructor(
    private readonly renderer: Renderer,
    showOverlay: boolean,
  ) {
    if (showOverlay) {
      this.overlay = document.createElement('div')
      this.overlay.className =
        'pointer-events-none fixed left-2 top-2 z-50 rounded bg-black/60 px-2 py-1 font-mono text-[11px] text-zinc-200'
      document.body.appendChild(this.overlay)
    } else {
      this.overlay = null
    }
  }

  // Start a fresh measurement window (called when a match begins).
  arm(): void {
    this.samples = []
    this.sampleTime = 0
    this.settleTime = 0
    this.locked = false
  }

  frame(dt: number): void {
    this.frames++
    this.overlayTimer += dt
    if (this.overlay && this.overlayTimer >= 0.5) {
      const fps = this.frames / this.overlayTimer
      const info = this.renderer.gl.info
      this.overlay.textContent = `${fps.toFixed(0)} fps · ${this.renderer.quality} · ${info.render.calls} calls`
      this.overlayTimer = 0
      this.frames = 0
    }
    if (this.locked) return
    // Ignore the first second (shader compiles, loading hitches).
    this.settleTime += dt
    if (this.settleTime < 1) return
    this.samples.push(dt)
    this.sampleTime += dt
    if (this.sampleTime < 2.5) return
    const sorted = [...this.samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0.016
    this.samples = []
    this.sampleTime = 0
    if (median > 1 / 52) {
      const next: Quality | null =
        this.renderer.quality === 'high' ? 'medium' : this.renderer.quality === 'medium' ? 'low' : null
      if (next) {
        this.renderer.setQuality(next)
        this.onDowngrade?.(next)
        this.settleTime = 0
        return
      }
    }
    this.locked = true
  }
}
