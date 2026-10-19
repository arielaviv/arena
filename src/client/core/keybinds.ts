import { Btn } from '../../shared/sim/input'

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'slide'
  | 'lmb'
  | 'rmb'
  | 'q'
  | 'e'
  | 'f'
  | 'r'
  | 'c'
  | 'focusSelf'
  | 'focusAlly'

export type Keybinds = Record<Action, string>

// Codes are KeyboardEvent.code values, or Mouse0..Mouse4 for mouse buttons.
export const DEFAULT_KEYBINDS: Keybinds = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  slide: 'ShiftLeft',
  lmb: 'Mouse0',
  rmb: 'Mouse2',
  q: 'KeyQ',
  e: 'KeyE',
  f: 'KeyF',
  r: 'KeyR',
  c: 'KeyC',
  focusSelf: 'F1',
  focusAlly: 'F2',
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
  q: 'Crowd control',
  e: 'Defensive',
  f: 'Interrupt',
  r: 'Ultimate',
  c: 'Lum Berry',
  focusSelf: 'Focus self',
  focusAlly: 'Focus partner',
}

export const ACTION_BUTTON: Partial<Record<Action, number>> = {
  jump: Btn.Jump,
  slide: Btn.Slide,
  lmb: Btn.Lmb,
  rmb: Btn.Rmb,
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

export function sanitizeKeybinds(raw: unknown): Keybinds {
  const out: Keybinds = { ...DEFAULT_KEYBINDS }
  if (typeof raw !== 'object' || raw === null) return out
  for (const action of Object.keys(DEFAULT_KEYBINDS) as Action[]) {
    const v = (raw as Record<string, unknown>)[action]
    if (typeof v === 'string' && v.length > 0) out[action] = v
  }
  return out
}
