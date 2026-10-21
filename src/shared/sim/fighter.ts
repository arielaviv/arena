import { Vector3 } from 'three'
import type { AbilityDef, AuraDef, ClassDef, DrCategory, Slot } from '../combat/types'
import { MOVE } from './constants'
import type { InputCmd } from './input'

export type MoveState = 'idle' | 'run' | 'sprint' | 'air' | 'slide' | 'dash'
export type Control = 'human' | 'bot' | 'dummy'
export type DummyRole = 'standard' | 'caster' | 'mover' | 'aggressor' | 'ally'

export interface Aura {
  def: AuraDef
  source: number
  remaining: number
  duration: number
  stacks: number
  tickTimer: number
  ticks: number
  damageTaken: number
}

export interface CastState {
  ability: AbilityDef
  elapsed: number
  duration: number
  targetId: number
  channel: boolean
  tickTimer: number
}

export interface DashState {
  ability: AbilityDef
  dirX: number
  dirZ: number
  remaining: number
  speed: number
  targetId: number
  hit: boolean
}

export interface DrState {
  level: number
  timer: number
}

export interface FighterStats {
  damage: number
  healing: number
  interrupts: number
  cc: number
}

export interface Fighter {
  id: number
  team: 0 | 1
  name: string
  cls: ClassDef
  control: Control
  dummyRole?: DummyRole
  pos: Vector3
  vel: Vector3
  yaw: number
  pitch: number
  grounded: boolean
  move: MoveState
  sprintTimer: number
  slideTimer: number
  slideCooldown: number
  slideHeld: boolean
  moving: boolean
  hp: number
  maxHp: number
  resource: number
  maxResource: number
  alive: boolean
  cast: CastState | null
  dash: DashState | null
  cooldowns: Record<Slot, number>
  gcd: number
  lockout: number
  comboStep: number
  comboTimer: number
  nthCount: number
  auras: Aura[]
  dr: Record<DrCategory, DrState>
  ult: number
  buttons: number
  prevButtons: number
  input: InputCmd
  lastSeq: number
  focusAlly: number
  target: number // selected enemy (tab target, click, or auto-picked on cast)
  // Spell queue: a key tapped during the global cooldown or a cast fires
  // as soon as it can, within the window.
  queued: Slot | null
  queueTimer: number
  confuseYaw: number
  combatTimer: number
  stats: FighterStats
  safe: Vector3 // last grounded position, for the fall safety net
  spawnX: number
  spawnZ: number
  spawnYaw: number
}

export function emptyInput(): InputCmd {
  return { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }
}

export function makeFighter(
  id: number,
  team: 0 | 1,
  name: string,
  cls: ClassDef,
  control: Control,
  x: number,
  y: number,
  z: number,
  yaw: number,
): Fighter {
  return {
    id,
    team,
    name,
    cls,
    control,
    pos: new Vector3(x, y, z),
    vel: new Vector3(),
    yaw,
    pitch: 0,
    grounded: true,
    move: 'idle',
    sprintTimer: 0,
    slideTimer: 0,
    slideCooldown: 0,
    slideHeld: false,
    moving: false,
    hp: cls.maxHp,
    maxHp: cls.maxHp,
    resource: cls.maxResource,
    maxResource: cls.maxResource,
    alive: true,
    cast: null,
    dash: null,
    cooldowns: { lmb: 0, rmb: 0, q: 0, e: 0, f: 0, r: 0, c: 0, a1: 0, a2: 0, a3: 0 },
    gcd: 0,
    lockout: 0,
    comboStep: 0,
    comboTimer: 0,
    nthCount: 0,
    auras: [],
    dr: {
      stun: { level: 0, timer: 0 },
      incap: { level: 0, timer: 0 },
      disorient: { level: 0, timer: 0 },
      root: { level: 0, timer: 0 },
      silence: { level: 0, timer: 0 },
    },
    ult: 0,
    buttons: 0,
    prevButtons: 0,
    input: { ...emptyInput(), yaw },
    lastSeq: 0,
    focusAlly: id,
    target: -1,
    queued: null,
    queueTimer: 0,
    confuseYaw: 0,
    combatTimer: 0,
    stats: { damage: 0, healing: 0, interrupts: 0, cc: 0 },
    safe: new Vector3(x, y, z),
    spawnX: x,
    spawnZ: z,
    spawnYaw: yaw,
  }
}

export function hurtHeight(f: Fighter): number {
  return f.move === 'slide' ? MOVE.slideHeight : MOVE.height
}

export function eyeHeight(f: Fighter): number {
  return f.move === 'slide' ? MOVE.slideEye : MOVE.eye
}

// Chest point used for line-of-sight checks and targeting.
export function chestY(f: Fighter): number {
  return f.pos.y + hurtHeight(f) * 0.62
}

export function hasCc(f: Fighter, kind: 'stun' | 'sleep' | 'root' | 'confuse' | 'silence'): boolean {
  for (const a of f.auras) if (a.def.cc === kind) return true
  return false
}

// Stunned, asleep or confused: cannot act at all (except a trinket).
export function isIncapacitated(f: Fighter): boolean {
  for (const a of f.auras) {
    const cc = a.def.cc
    if (cc === 'stun' || cc === 'sleep' || cc === 'confuse') return true
  }
  return false
}

export function isImmune(f: Fighter): boolean {
  return f.auras.some((a) => a.def.immune)
}

export function isBlind(f: Fighter): boolean {
  return f.auras.some((a) => a.def.blind)
}

export function findAura(f: Fighter, id: string): Aura | undefined {
  for (const a of f.auras) if (a.def.id === id) return a
  return undefined
}

export function speedMultiplier(f: Fighter): number {
  let slow = 0
  let speed = 0
  let immune = false
  for (const a of f.auras) {
    if (a.def.immuneRootSlow) immune = true
    if (a.def.slow && a.def.slow > slow) slow = a.def.slow
    if (a.def.speed && a.def.speed > speed) speed = a.def.speed
  }
  if (immune) slow = 0
  return (1 - slow) * (1 + speed)
}

export function isRooted(f: Fighter): boolean {
  let rooted = false
  for (const a of f.auras) {
    if (a.def.immuneRootSlow) return false
    if (a.def.cc === 'root') rooted = true
  }
  return rooted
}
