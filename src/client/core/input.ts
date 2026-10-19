import { CAMERA } from '../../shared/sim/constants'
import { Btn } from '../../shared/sim/input'

const KEY_BUTTONS: Record<string, number> = {
  Space: Btn.Jump,
  ShiftLeft: Btn.Slide,
  ShiftRight: Btn.Slide,
  KeyQ: Btn.Q,
  KeyE: Btn.E,
  KeyF: Btn.F,
  KeyR: Btn.R,
  KeyC: Btn.C,
  F1: Btn.FocusSelf,
  F2: Btn.FocusAlly,
}

// Keyboard + mouse with pointer lock. Owns the look angles.
export class Input {
  yaw = 0
  pitch = 0
  sensitivity = 0.0022
  private keys = new Set<string>()
  private mouse = 0
  private readonly canvas: HTMLCanvasElement
  onLockChange: ((locked: boolean) => void) | null = null
  onKey: ((code: string) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1' || e.code === 'F2' || e.code === 'Tab' || (e.code === 'Space' && this.locked)) {
        e.preventDefault()
      }
      if (!e.repeat) this.onKey?.(e.code)
      this.keys.add(e.code)
    })
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => {
      this.keys.clear()
      this.mouse = 0
    })
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return
      if (e.button === 0) this.mouse |= Btn.Lmb
      if (e.button === 2) this.mouse |= Btn.Rmb
    })
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse &= ~Btn.Lmb
      if (e.button === 2) this.mouse &= ~Btn.Rmb
    })
    window.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return
      this.yaw += e.movementX * this.sensitivity
      this.pitch -= e.movementY * this.sensitivity
      this.pitch = Math.max(CAMERA.pitchMin, Math.min(CAMERA.pitchMax, this.pitch))
    })
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) {
        this.keys.clear()
        this.mouse = 0
      }
      this.onLockChange?.(this.locked)
    })
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

  isDown(code: string): boolean {
    return this.keys.has(code)
  }

  moveX(): number {
    return (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
  }

  moveZ(): number {
    return (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
  }

  buttons(): number {
    let b = this.mouse
    for (const code of this.keys) b |= KEY_BUTTONS[code] ?? 0
    return b
  }
}
