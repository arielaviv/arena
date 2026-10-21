import { CINDRAKE, CINDRAKE_AURAS } from '../classes/cindrake'
import { DUMMY } from '../classes/dummy'
import { LUMORA, LUMORA_AURAS } from '../classes/lumora'
import { PETALYN, PETALYN_AURAS } from '../classes/petalyn'
import { SHARED_AURAS } from '../classes/shared'
import { TIDEHORN, TIDEHORN_AURAS } from '../classes/tidehorn'
import { VENOMAW, VENOMAW_AURAS } from '../classes/venomaw'
import type { AbilityDef, AuraDef, ClassDef, ClassId } from './types'

export const CLASSES: Record<ClassId, ClassDef> = {
  cindrake: CINDRAKE,
  tidehorn: TIDEHORN,
  venomaw: VENOMAW,
  lumora: LUMORA,
  petalyn: PETALYN,
  dummy: DUMMY,
}

export const PLAYABLE: readonly ClassId[] = ['cindrake', 'venomaw', 'lumora', 'tidehorn', 'petalyn']
export const HEALERS: readonly ClassId[] = PLAYABLE.filter((id) => CLASSES[id].role === 'healer')
export const DPS: readonly ClassId[] = PLAYABLE.filter((id) => CLASSES[id].role === 'dps')

const AURAS = new Map<string, AuraDef>()
for (const list of [
  SHARED_AURAS,
  CINDRAKE_AURAS,
  TIDEHORN_AURAS,
  VENOMAW_AURAS,
  LUMORA_AURAS,
  PETALYN_AURAS,
]) {
  for (const a of list) {
    if (AURAS.has(a.id)) throw new Error(`duplicate aura ${a.id}`)
    AURAS.set(a.id, a)
  }
}

const ABILITIES = new Map<string, AbilityDef>()
for (const cls of Object.values(CLASSES)) {
  for (const a of Object.values(cls.abilities)) if (a) ABILITIES.set(a.id, a)
}

export function getAura(id: string): AuraDef {
  const a = AURAS.get(id)
  if (!a) throw new Error(`unknown aura ${id}`)
  return a
}

export function findAuraDef(id: string): AuraDef | undefined {
  return AURAS.get(id)
}

export function getAbility(id: string): AbilityDef | undefined {
  return ABILITIES.get(id)
}

export function allAuras(): IterableIterator<AuraDef> {
  return AURAS.values()
}

export function allAbilities(): IterableIterator<AbilityDef> {
  return ABILITIES.values()
}

// Every aura referenced by any ability must exist; checked by tests.
export function validateRegistry(): string[] {
  const missing: string[] = []
  const check = (effects: readonly import('./types').Effect[]) => {
    for (const e of effects) {
      if (e.kind === 'aura' && !AURAS.has(e.aura)) missing.push(e.aura)
      if (e.kind === 'delayed' || e.kind === 'chance') check(e.effects)
    }
  }
  for (const a of ABILITIES.values()) {
    check(a.effects)
    if (a.selfEffects) check(a.selfEffects)
    if (a.everyNth) check(a.everyNth.effects)
    if (a.combo) check(a.combo.finisher)
    if ((a.target.kind === 'projectile' || a.target.kind === 'ground') && a.target.hazard) {
      check(a.target.hazard.effects)
    }
  }
  return missing
}
