// Data model for classes, abilities and auras. Class kits are pure data built
// from these unions; the engine in this folder interprets them.

export type Slot = 'lmb' | 'rmb' | 'q' | 'e' | 'f' | 'r' | 'c'
export const SLOTS: readonly Slot[] = ['lmb', 'rmb', 'q', 'e', 'f', 'r', 'c']

export type Element = 'fire' | 'water' | 'poison' | 'psychic' | 'grass' | 'normal'
export type Role = 'healer' | 'dps'
export type ResourceKind = 'mana' | 'energy'
export type School = 'physical' | 'spell'
export type DrCategory = 'stun' | 'incap' | 'disorient' | 'root' | 'silence'
export const DR_CATEGORIES: readonly DrCategory[] = ['stun', 'incap', 'disorient', 'root', 'silence']
export type CcKind = 'stun' | 'sleep' | 'root' | 'confuse' | 'silence'
export type DispelType = 'magic' | 'poison' | 'physical' | 'none'

export type AiTag =
  | 'primary'
  | 'nuke'
  | 'dot'
  | 'cc'
  | 'interrupt'
  | 'defensive'
  | 'mobility'
  | 'gapCloser'
  | 'heal'
  | 'dispel'
  | 'ult'
  | 'trinket'

export interface AuraTick {
  interval: number
  damage?: number
  heal?: number
  escalate?: number // added to damage on every tick (Badly Poisoned)
  movingMult?: number // multiplier while the target is moving (Bleed)
  perStack?: boolean // amount scales with stacks (Poison)
}

export interface AuraDef {
  id: string
  name: string
  harmful: boolean
  duration: number
  dispel: DispelType
  color: string
  glyph: string
  maxStacks?: number
  tick?: AuraTick
  cc?: CcKind
  dr?: DrCategory
  breakOnDamage?: boolean
  breakAfterDamage?: number
  slow?: number
  speed?: number
  damageTaken?: number
  damageDealt?: number
  healingTaken?: number
  immuneRootSlow?: boolean
}

export type Effect =
  | { kind: 'damage'; amount: number; bonus?: { aura: string; mult: number; consume?: boolean } }
  | { kind: 'heal'; amount: number }
  | { kind: 'aura'; aura: string; stacks?: number }
  | { kind: 'knockback'; force: number; lift: number }
  | { kind: 'interrupt'; lockout: number }
  | { kind: 'cleanse'; count: number; dispel: readonly DispelType[] }
  | { kind: 'breakCc' }
  | {
      kind: 'delayed'
      delay: number
      radius: number
      follow: boolean
      side: Side
      effects: readonly Effect[]
      vfx: string
    }

export type Side = 'enemy' | 'ally' | 'both'

export interface HazardDef {
  radius: number
  duration: number
  interval: number
  side: Side
  effects: readonly Effect[]
  oncePerTarget?: boolean
  vfx: string
}

export type Targeting =
  | {
      kind: 'projectile'
      speed: number
      radius: number
      range: number
      gravity?: number
      side?: Side
      hazard?: HazardDef
      count?: number
      spread?: number
    }
  | { kind: 'hitscan'; range: number; side?: Side }
  | { kind: 'targeted'; range: number; side: 'enemy' | 'ally' }
  | { kind: 'self' }
  | { kind: 'ground'; range: number; radius: number; side: Side }
  | { kind: 'cone'; range: number; angle: number; side?: Side }
  | { kind: 'melee'; range: number; angle: number }
  | { kind: 'dash'; distance: number; speed: number; hitRadius: number; toTarget?: boolean }
  | { kind: 'beam'; range: number; radius: number; side?: Side }
  | { kind: 'nova'; radius: number; side: Side }

export interface AbilityDef {
  id: string
  name: string
  slot: Slot
  element: Element
  school: School
  cost: number
  cooldown: number
  castTime?: number
  channel?: { duration: number; interval: number }
  offGcd?: boolean
  usableWhileCc?: boolean
  mobile?: boolean // can move while casting or channeling
  target: Targeting
  effects: readonly Effect[]
  selfEffects?: readonly Effect[]
  everyNth?: { n: number; effects: readonly Effect[] }
  combo?: { steps: number; window: number; finisher: readonly Effect[] }
  tags: readonly AiTag[]
  vfx: string
  blurb: string
}

export type ClassId = 'cindrake' | 'tidehorn' | 'venomaw' | 'lumora' | 'petalyn' | 'dummy'

export interface ClassDef {
  id: ClassId
  name: string
  element: Element
  role: Role
  archetype: string
  maxHp: number
  resource: ResourceKind
  maxResource: number
  regen: number
  speedMult?: number
  colors: { primary: string; secondary: string; glow: string }
  abilities: Record<Slot, AbilityDef>
}
