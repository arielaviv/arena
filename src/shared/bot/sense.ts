import { findAuraDef } from '../combat/registry'
import {
  type AbilityDef,
  type AiTag,
  abilityAt,
  type CcKind,
  type DrCategory,
  type Effect,
  type Side,
  type Slot,
} from '../combat/types'
import { type Fighter, hasCc, isIncapacitated, isRooted, speedMultiplier } from '../sim/fighter'

// Read-only facts the bot brain needs about fighters and ability data. Pure
// functions over sim state, so they are cheap to test and share.

export const SLOT_ORDER: readonly Slot[] = ['lmb', 'rmb', 'q', 'e', 'f', 'r', 'c', 'a1', 'a2', 'a3']
export const EXTRA_SLOTS: readonly Slot[] = ['a1', 'a2', 'a3']
const DR_MULT = [1, 0.5, 0.25, 0] as const

export interface CcInfo {
  kind: CcKind
  cat: DrCategory | null
  duration: number
  breaksOnDamage: boolean
}

const ccCache = new Map<string, CcInfo | null>()

function findCc(effects: readonly Effect[]): CcInfo | null {
  for (const e of effects) {
    if (e.kind === 'aura') {
      const def = findAuraDef(e.aura)
      if (def?.harmful && def.cc) {
        return {
          kind: def.cc,
          cat: def.dr ?? null,
          duration: def.duration,
          breaksOnDamage: def.breakOnDamage === true || def.breakAfterDamage !== undefined,
        }
      }
    } else if (e.kind === 'delayed') {
      const inner = findCc(e.effects)
      if (inner) return inner
    }
  }
  return null
}

// Crowd control an ability applies, directly or through a hazard it leaves.
export function ccOf(a: AbilityDef): CcInfo | null {
  let info = ccCache.get(a.id)
  if (info === undefined) {
    info = findCc(a.effects)
    if (!info && a.target.kind === 'projectile' && a.target.hazard) info = findCc(a.target.hazard.effects)
    ccCache.set(a.id, info)
  }
  return info
}

export function cleansesMagic(a: AbilityDef): boolean {
  return a.effects.some((e) => e.kind === 'cleanse' && e.dispel.includes('magic'))
}

export function drMult(g: Fighter, cat: DrCategory | null): number {
  if (!cat) return 1
  return DR_MULT[Math.min(3, g.dr[cat].level)] ?? 0
}

export function pct(g: Fighter): number {
  return g.hp / g.maxHp
}

export function flatDist(a: Fighter, b: Fighter): number {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
}

export function isMelee(g: Fighter): boolean {
  return g.cls.abilities.lmb.target.kind === 'melee'
}

export function isTimed(a: AbilityDef): boolean {
  return (a.castTime ?? 0) > 0
}

// Crowd control that damage breaks: hitting the target wastes it.
export function fragileCc(g: Fighter): boolean {
  for (const a of g.auras) {
    if (a.def.cc && (a.def.breakOnDamage || a.def.breakAfterDamage !== undefined)) return true
  }
  return false
}

// Seconds of hard crowd control (or any crowd control) left on a fighter.
export function ccLeft(g: Fighter, hardOnly: boolean): number {
  let best = 0
  for (const a of g.auras) {
    const cc = a.def.cc
    if (!cc || (hardOnly && cc !== 'stun' && cc !== 'sleep' && cc !== 'confuse')) continue
    if (a.remaining > best) best = a.remaining
  }
  return best
}

// Seconds a fighter cannot walk anywhere (hard crowd control or a root).
export function pinnedFor(g: Fighter): number {
  let best = ccLeft(g, true)
  if (isRooted(g)) {
    for (const a of g.auras) if (a.def.cc === 'root' && a.remaining > best) best = a.remaining
  }
  return best
}

export function slowed(g: Fighter): boolean {
  return speedMultiplier(g) < 0.9
}

export function hostile(f: Fighter, team: 0 | 1, side: Side): boolean {
  if (side === 'both') return true
  return side === 'enemy' ? team !== f.team : false
}

export function ready(f: Fighter, a: AbilityDef): boolean {
  if (f.cooldowns[a.slot] > 0 || f.resource < a.cost) return false
  if (a.tags.includes('ult') && f.ult < 100) return false
  if (isIncapacitated(f) && !a.usableWhileCc) return false
  if (a.school === 'spell' && hasCc(f, 'silence')) return false
  const timed = isTimed(a) || a.channel !== undefined
  if (timed && a.school === 'spell' && f.lockout > 0) return false
  if (isTimed(a) && !a.mobile && !f.grounded) return false
  if (!a.offGcd && f.gcd > 0) return false
  // A held channel on the primary (Psybeam) is dropped to use something else.
  if (f.cast && !a.offGcd && !(f.cast.channel && f.cast.ability.slot === 'lmb')) return false
  return true
}

export function standsToCast(a: AbilityDef): boolean {
  return !a.mobile && (isTimed(a) || a.channel !== undefined) && a.slot !== 'lmb'
}

export function slotWith(f: Fighter, tag: AiTag, exclude?: AiTag): Slot | null {
  for (const s of SLOT_ORDER) {
    const a = abilityAt(f.cls, s)
    if (a?.tags.includes(tag) && (!exclude || !a.tags.includes(exclude))) return s
  }
  return null
}

// Aura ids an ability puts on its target (for keeping DoTs rolling).
export function appliedAuras(a: AbilityDef): string[] {
  const ids: string[] = []
  for (const e of a.effects) if (e.kind === 'aura') ids.push(e.aura)
  return ids
}

export function inRange(f: Fighter, g: Fighter, a: AbilityDef): boolean {
  const d = flatDist(f, g)
  const t = a.target
  switch (t.kind) {
    case 'projectile':
      return d < t.range * 0.85
    case 'hitscan':
    case 'targeted':
    case 'beam':
    case 'ground':
      return d < t.range
    case 'cone':
    case 'melee':
      return d < t.range + 0.3
    case 'dash':
      return d < t.distance + 1
    case 'nova':
      return d < t.radius
    case 'self':
      return true
  }
}

export function primarySpeed(f: Fighter): number {
  const t = f.cls.abilities.lmb.target
  return t.kind === 'projectile' ? t.speed : 0
}
