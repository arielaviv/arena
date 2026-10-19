import type { World } from '../sim/collision'
import type { Fighter } from '../sim/fighter'
import type { Rng } from '../sim/rng'
import type { SimEvent } from './events'
import type { AbilityDef, Effect, HazardDef, Side } from './types'

export interface Projectile {
  id: number
  owner: number
  team: 0 | 1
  ability: AbilityDef
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  radius: number
  gravity: number
  range: number
  side: Side
  hazard?: HazardDef
  nth: boolean
  alive: boolean
}

export interface Hazard {
  id: number
  owner: number
  team: 0 | 1
  ability: AbilityDef
  def: HazardDef
  x: number
  y: number
  z: number
  remaining: number
  tickTimer: number
  hit: number[]
}

export interface Delayed {
  id: number
  owner: number
  team: 0 | 1
  ability: AbilityDef
  targetId: number
  x: number
  y: number
  z: number
  remaining: number
  radius: number
  follow: boolean
  side: Side
  effects: readonly Effect[]
}

// What the combat engine needs from the match. MatchSim implements it.
export interface CombatHost {
  readonly world: World
  readonly fighters: Fighter[]
  readonly projectiles: Projectile[]
  readonly hazards: Hazard[]
  readonly delayed: Delayed[]
  readonly rng: Rng
  readonly training: boolean
  nextId(): number
  emit(e: SimEvent): void
  byId(id: number): Fighter | undefined
}
