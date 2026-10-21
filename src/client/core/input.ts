import { CAMERA } from '../../shared/sim/constants'
import { ACTION_BUTTON, type Action, defaultKeybinds, type Keybinds } from './keybinds'

// Keyboard + mouse with rebindable actions. Owns the look angles. In action
// controls the mouse is pointer-locked; in classic controls the keyboard
// works with a free cursor and pointer lock is only held while turning.
export class Input {
  yaw = 0
  pitch = 0
  sensitivity = 0.0022
  classic = true
  private down = new Set<string>()
  // Keys pressed since the last tick read them, so a tap shorter than a
  // tick still reaches the sim.
  private tapped = new Set<string>()
  private binds: Keybinds = defaultKeybinds('classic')
  private codeToBits = new Map<string, number>()
  private readonly canvas: HTMLCanvasElement
  // While set, the next key or mouse button is captured for rebinding.
  private capture: ((code: string) => void) | null = null
  onLockChange: ((locked: boolean) => void) | null = null
  onKey: ((code: string, shift: boolean) => void) | null = null

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
      if (this.codeToBits.has(e.code) || e.code === 'Tab' || (e.code === 'Space' && this.active))
        e.preventDefault()
      if (!e.repeat) {
        this.onKey?.(e.code, e.shiftKey)
        this.tapped.add(e.code)
      }
      this.down.add(e.code)
    })
    window.addEventListener('keyup', (e) => this.down.delete(e.code))
    window.addEventListener('blur', () => {
      this.down.clear()
      this.tapped.clear()
    })
    window.addEventListener('mousedown', (e) => {
      const code = `Mouse${e.button}`
      if (this.capture) {
        e.preventDefault()
        const cb = this.capture
        this.capture = null
        cb(code)
        return
      }
      if (this.locked || (this.classic && e.target === canvas)) {
        this.down.add(code)
        this.tapped.add(code)
      }
    })
    window.addEventListener('mouseup', (e) => this.down.delete(`Mouse${e.button}`))
    window.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('mousemove', (e) => {
      if (this.locked) this.turn(e.movementX, e.movementY)
    })
    document.addEventListener('pointerlockchange', () => {
      // Classic turning locks and unlocks constantly; keys stay held.
      if (!this.locked && !this.classic) {
        this.down.clear()
        this.tapped.clear()
      }
      this.onLockChange?.(this.locked)
    })
  }

  turn(dx: number, dy: number): void {
    this.yaw += dx * this.sensitivity
    this.pitch -= dy * this.sensitivity
    this.pitch = Math.max(CAMERA.pitchMin, Math.min(CAMERA.pitchMax, this.pitch))
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

  // Whether keys and buttons drive the fighter right now.
  get active(): boolean {
    return this.classic || this.locked
  }

  lock(): void {
    if (this.locked) return
    const req = this.canvas.requestPointerLock() as Promise<void> | undefined
    req?.catch(() => {})
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock()
  }

  isDown(action: Action): boolean {
    return this.down.has(this.binds[action])
  }

  moveX(): number {
    return (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0)
  }

  moveZ(): number {
    return (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0)
  }

  // Forget taps made in menus, so they don't fire as spells in the match.
  clearTaps(): void {
    this.tapped.clear()
  }

  // Read once per tick: held keys plus anything tapped since the last read.
  buttons(): number {
    let b = 0
    for (const code of this.down) b |= this.codeToBits.get(code) ?? 0
    for (const code of this.tapped) b |= this.codeToBits.get(code) ?? 0
    this.tapped.clear()
    return b
  }
}
