import { CAMERA } from '../../shared/sim/constants'
import { ACTION_BUTTON, type Action, DEFAULT_KEYBINDS, type Keybinds } from './keybinds'

// Keyboard + mouse with pointer lock and rebindable actions. Owns the look angles.
export class Input {
  yaw = 0
  pitch = 0
  sensitivity = 0.0022
  private down = new Set<string>()
  private binds: Keybinds = { ...DEFAULT_KEYBINDS }
  private codeToBits = new Map<string, number>()
  private readonly canvas: HTMLCanvasElement
  // While set, the next key or mouse button is captured for rebinding.
  private capture: ((code: string) => void) | null = null
  onLockChange: ((locked: boolean) => void) | null = null
  onKey: ((code: string) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.setBinds(this.binds)
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault()
        const cb = this.capture
        this.capture = null
        cb(e.code)
        return
      }
      if (this.codeToBits.has(e.code) || e.code === 'Tab' || (e.code === 'Space' && this.locked))
        e.preventDefault()
      if (!e.repeat) this.onKey?.(e.code)
      this.down.add(e.code)
    })
    window.addEventListener('keyup', (e) => this.down.delete(e.code))
    window.addEventListener('blur', () => this.down.clear())
    window.addEventListener('mousedown', (e) => {
      const code = `Mouse${e.button}`
      if (this.capture) {
        e.preventDefault()
        const cb = this.capture
        this.capture = null
        cb(code)
        return
      }
      if (this.locked) this.down.add(code)
    })
    window.addEventListener('mouseup', (e) => this.down.delete(`Mouse${e.button}`))
    window.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return
      this.yaw += e.movementX * this.sensitivity
      this.pitch -= e.movementY * this.sensitivity
      this.pitch = Math.max(CAMERA.pitchMin, Math.min(CAMERA.pitchMax, this.pitch))
    })
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.down.clear()
      this.onLockChange?.(this.locked)
    })
  }

  setBinds(binds: Keybinds): void {
    this.binds = { ...binds }
    this.codeToBits.clear()
    for (const [action, code] of Object.entries(this.binds) as Array<[Action, string]>) {
      const bit = ACTION_BUTTON[action]
      if (bit !== undefined) this.codeToBits.set(code, (this.codeToBits.get(code) ?? 0) | bit)
    }
  }

  get keybinds(): Keybinds {
    return this.binds
  }

  captureNext(cb: (code: string) => void): void {
    this.capture = cb
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  lock(): void {
    if (this.locked) return
    const req = this.canvas.requestPointerLock() as Promise<void> | undefined
    req?.catch(() => {})
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock()
  }

  private isDown(action: Action): boolean {
    return this.down.has(this.binds[action])
  }

  moveX(): number {
    return (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0)
  }

  moveZ(): number {
    return (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0)
  }

  buttons(): number {
    let b = 0
    for (const code of this.down) b |= this.codeToBits.get(code) ?? 0
    return b
  }
}
