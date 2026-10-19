import type { SimEvent } from '../combat/events'
import type { ClassId } from '../combat/types'
import type { Control, DummyRole, MoveState } from '../sim/fighter'
import type { InputCmd } from '../sim/input'
import type { MatchMode, Phase } from '../sim/match'

export interface AuraSnap {
  id: string
  rem: number
  dur: number
  stacks: number
  src: number
}

export interface CastSnap {
  ability: string
  elapsed: number
  duration: number
  target: number
  channel: boolean
}

export interface DashSnap {
  ability: string
  dx: number
  dz: number
  rem: number
  speed: number
}

export interface FighterSnap {
  id: number
  team: 0 | 1
  name: string
  cls: ClassId
  control: Control
  dummyRole?: DummyRole
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  grounded: boolean
  move: MoveState
  sprintTimer: number
  slideTimer: number
  slideCooldown: number
  slideHeld: boolean
  prevButtons: number
  hp: number
  maxHp: number
  res: number
  maxRes: number
  alive: boolean
  cast: CastSnap | null
  dash: DashSnap | null
  cd: number[]
  gcd: number
  lockout: number
  ult: number
  combo: number
  auras: AuraSnap[]
  dr: number[]
  drTimers: number[]
  focus: number
  target: number
  lastSeq: number
  damage: number
  healing: number
  interrupts: number
  ccDone: number
}

export interface ProjectileSnap {
  id: number
  ability: string
  owner: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

export interface HazardSnap {
  id: number
  ability: string
  owner: number
  x: number
  y: number
  z: number
  radius: number
  rem: number
}

export interface DelayedSnap {
  id: number
  ability: string
  owner: number
  x: number
  y: number
  z: number
  radius: number
  rem: number
  target: number
}

export interface Snapshot {
  tick: number
  mode: MatchMode
  phase: Phase
  phaseTimer: number
  winner: -1 | 0 | 1
  fighters: FighterSnap[]
  projectiles: ProjectileSnap[]
  hazards: HazardSnap[]
  delayed: DelayedSnap[]
  events: SimEvent[]
  aggressorOn: boolean
}

export type TrainingCommand =
  | { kind: 'swapClass'; classId: ClassId }
  | { kind: 'resetCooldowns' }
  | { kind: 'aggressor'; on: boolean }
  | { kind: 'infinite'; on: boolean }

export type ServerMessage =
  | { type: 'welcome'; you: number; mode: MatchMode; seed: number }
  | { type: 'snap'; snap: Snapshot }

export type ClientMessage =
  | { type: 'input'; cmd: InputCmd }
  | { type: 'inputs'; cmds: InputCmd[] }
  | { type: 'ready' }
  | { type: 'training'; cmd: TrainingCommand }

// Matchmaking socket (/queue) → client.
export type QueueMessage =
  | { type: 'queued'; players: number }
  | { type: 'match'; room: string; token: string; you: number; theme: 'sky' | 'caldera' }
