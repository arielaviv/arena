// One player command per sim tick. Humans and bots send exactly the same thing.
export interface InputCmd {
  seq: number
  moveX: number // strafe, -1 left .. 1 right
  moveZ: number // -1 back .. 1 forward
  yaw: number
  pitch: number
  buttons: number
  // Tab-target model: the enemy you have selected and the ally your heals go to
  // (fighter ids, -1 = none). Bots fill these too.
  target?: number
  ally?: number
  // Ground point under the cursor (WoW-style @cursor casts); optional.
  aimX?: number
  aimY?: number
  aimZ?: number
}

export const Btn = {
  Jump: 1 << 0,
  Slide: 1 << 1,
  Lmb: 1 << 2,
  Rmb: 1 << 3,
  Q: 1 << 4,
  E: 1 << 5,
  F: 1 << 6,
  R: 1 << 7,
  C: 1 << 8,
  FocusSelf: 1 << 9,
  FocusAlly: 1 << 10,
  A1: 1 << 11,
  A2: 1 << 12,
  A3: 1 << 13,
} as const

export const SLOT_BUTTON = {
  lmb: Btn.Lmb,
  rmb: Btn.Rmb,
  q: Btn.Q,
  e: Btn.E,
  f: Btn.F,
  r: Btn.R,
  c: Btn.C,
  a1: Btn.A1,
  a2: Btn.A2,
  a3: Btn.A3,
} as const

export function pressed(buttons: number, prev: number, bit: number): boolean {
  return (buttons & bit) !== 0 && (prev & bit) === 0
}

export function held(buttons: number, bit: number): boolean {
  return (buttons & bit) !== 0
}
