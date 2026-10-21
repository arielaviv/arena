import { Btn } from '../../shared/sim/input'

// Classic: visible cursor, click units to target, drag to turn the camera,
// spells on the number row. Action: mouselook with a crosshair, primary and
// signature on the mouse buttons.
export type ControlScheme = 'classic' | 'action'

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'slide'
  | 'lmb'
  | 'rmb'
  | 'a1'
  | 'a2'
  | 'a3'
  | 'q'
  | 'e'
  | 'f'
  | 'r'
  | 'c'
  | 'target'
  | 'focusSelf'
  | 'focusAlly'

export type Keybinds = Record<Action, string>

const SHARED = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  slide: 'ShiftLeft',
  q: 'KeyQ',
  e: 'KeyE',
  f: 'KeyF',
  r: 'KeyR',
  c: 'KeyC',
  target: 'Tab',
  focusSelf: 'F1',
  focusAlly: 'F2',
} as const

// Codes are KeyboardEvent.code values, or Mouse0..Mouse4 for mouse buttons.
const CLASSIC: Keybinds = {
  ...SHARED,
  lmb: 'Digit1',
  rmb: 'Digit2',
  a1: 'Digit3',
  a2: 'Digit4',
  a3: 'Digit5',
}
const ACTION: Keybinds = { ...SHARED, lmb: 'Mouse0', rmb: 'Mouse2', a1: 'Digit1', a2: 'Digit2', a3: 'Digit3' }

export function defaultKeybinds(scheme: ControlScheme): Keybinds {
  return { ...(scheme === 'classic' ? CLASSIC : ACTION) }
}

export const ACTION_LABEL: Record<Action, string> = {
  forward: 'Forward',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  jump: 'Jump',
  slide: 'Slide',
  lmb: 'Primary',
  rmb: 'Signature',
  a1: 'Spell 1',
  a2: 'Spell 2',
  a3: 'Spell 3',
  q: 'Crowd control',
  e: 'Defensive',
  f: 'Interrupt',
  r: 'Ultimate',
  c: 'Lum Berry',
  target: 'Next target',
  focusSelf: 'Focus self',
  focusAlly: 'Focus partner',
}

export const ACTION_BUTTON: Partial<Record<Action, number>> = {
  jump: Btn.Jump,
  slide: Btn.Slide,
  lmb: Btn.Lmb,
  rmb: Btn.Rmb,
  a1: Btn.A1,
  a2: Btn.A2,
  a3: Btn.A3,
  q: Btn.Q,
  e: Btn.E,
  f: Btn.F,
  r: Btn.R,
  c: Btn.C,
  focusSelf: Btn.FocusSelf,
  focusAlly: Btn.FocusAlly,
}

const MOUSE_NAMES = ['LMB', 'MMB', 'RMB', 'M4', 'M5']

// Short label for a binding, as shown on the action bar.
export function keyLabel(code: string): string {
  if (code.startsWith('Mouse')) return MOUSE_NAMES[Number(code.slice(5))] ?? code
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift'
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl'
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt'
  if (code === 'Space') return 'Space'
  if (code === 'Backquote') return '`'
  return code.replace('Arrow', '')
}

export function sanitizeKeybinds(raw: unknown, scheme: ControlScheme): Keybinds {
  const out = defaultKeybinds(scheme)
  if (typeof raw !== 'object' || raw === null) return out
  for (const action of Object.keys(out) as Action[]) {
    const v = (raw as Record<string, unknown>)[action]
    if (typeof v === 'string' && v.length > 0) out[action] = v
  }
  return out
}
