import { COMBAT } from '../sim/constants'
import { type Aura, chestY, type Fighter, findAura, hasCc, isImmune } from '../sim/fighter'
import { endDash, knockback } from '../sim/movement'
import type { CombatHost } from './host'
import { getAura } from './registry'
import { type AbilityDef, type AuraDef, type DamageBonus, type DrCategory, type Effect, SLOTS } from './types'

export const ULT_MAX = 100
const DR_MULT = [1, 0.5, 0.25, 0] as const
const THORNS_REACH = 5

// Set while a reflected spell resolves, so two Magic Coats can't ping-pong.
let reflecting = false

export function bonusApplies(b: DamageBonus, dst: Fighter): boolean {
  if (b.cc && !hasCc(dst, b.cc)) return false
  return !b.aura || findAura(dst, b.aura) !== undefined
}

function reflectable(a: AbilityDef): boolean {
  const k = a.target.kind
  return a.school === 'spell' && (k === 'projectile' || k === 'targeted' || k === 'hitscan')
}

// Apply a list of effects from src to dst. Harmful effects only land on
// enemies and helpful ones only on allies, so one list can serve both sides
// (Pollen Puff damages enemies and heals allies). Area effects (zones,
// delayed blasts) can't be reflected.
export function applyEffects(
  host: CombatHost,
  src: Fighter,
  dst: Fighter,
  ability: AbilityDef,
  effects: readonly Effect[],
  area = false,
): void {
  if (!dst.alive) return
  const enemy = src.team !== dst.team
  if (enemy && isImmune(dst)) {
    host.emit({ t: 'immune', src: src.id, dst: dst.id, aura: ability.id })
    return
  }
  if (enemy && !area && !reflecting && reflectable(ability)) {
    const coat = dst.auras.find((a) => a.def.reflect)
    if (coat) {
      removeAura(host, dst, coat, 'remove')
      host.emit({ t: 'reflect', src: src.id, dst: dst.id, ability: ability.id })
      reflecting = true
      try {
        applyEffects(host, dst, src, ability, effects)
      } finally {
        reflecting = false
      }
      return
    }
  }
  for (const e of effects) {
    switch (e.kind) {
      case 'damage': {
        if (!enemy) break
        let amount = e.amount
        const b = e.bonus
        if (b && bonusApplies(b, dst)) {
          const a = b.aura ? findAura(dst, b.aura) : undefined
          if (b.mult) amount *= b.mult
          if (b.perStack && a) amount += b.perStack * a.stacks
          if (b.consume && a) removeAura(host, dst, a, 'remove')
        }
        const dealt = dealDamage(host, src, dst, amount, ability.id, false)
        if (e.drain && dealt > 0) heal(host, src, src, dealt * e.drain, ability.id, false)
        break
      }
      case 'heal':
        if (enemy) break
        heal(host, src, dst, e.amount, ability.id, false)
        break
      case 'aura': {
        const def = getAura(e.aura)
        // Self-inflicted drawbacks (Overheat) are the one harmful aura on yourself.
        if (def.harmful !== enemy && src !== dst) break
        applyAura(host, src, dst, def, e.stacks ?? 1)
        break
      }
      case 'knockback': {
        if (!enemy || dst.auras.some((a) => a.def.knockImmune)) break
        let dx = dst.pos.x - src.pos.x
        let dz = dst.pos.z - src.pos.z
        const d = Math.hypot(dx, dz)
        if (d < 1e-3) {
          dx = Math.cos(src.yaw)
          dz = Math.sin(src.yaw)
        } else {
          dx /= d
          dz /= d
        }
        cancelCast(host, dst, 'moved')
        knockback(dst, dx, dz, e.force, e.lift)
        break
      }
      case 'interrupt':
        if (enemy) interrupt(host, src, dst, e.lockout)
        break
      case 'cleanse':
        if (!enemy) cleanse(host, src, dst, e.count, e.dispel)
        break
      case 'breakCc':
        breakCc(host, dst)
        break
      case 'chance':
        if (host.rng.next() < e.p) applyEffects(host, src, dst, ability, e.effects, true)
        break
      case 'delayed': {
        const id = host.nextId()
        host.delayed.push({
          id,
          owner: src.id,
          team: src.team,
          ability,
          targetId: dst.id,
          x: dst.pos.x,
          y: dst.pos.y,
          z: dst.pos.z,
          remaining: e.delay,
          radius: e.radius,
          follow: e.follow,
          side: e.side,
          effects: e.effects,
        })
        host.emit({
          t: 'delayed',
          id,
          ability: ability.id,
          src: src.id,
          target: dst.id,
          delay: e.delay,
          radius: e.radius,
        })
        break
      }
    }
  }
}

export function dealDamage(
  host: CombatHost,
  src: Fighter,
  dst: Fighter,
  raw: number,
  abilityId: string,
  isTick: boolean,
): number {
  if (!dst.alive) return 0
  if (src.team !== dst.team && isImmune(dst)) return 0
  let mult = 1
  for (const a of src.auras) if (a.def.damageDealt !== undefined) mult *= a.def.damageDealt
  for (const a of dst.auras) if (a.def.damageTaken !== undefined) mult *= a.def.damageTaken
  const amount = Math.max(1, Math.round(raw * mult))
  dst.hp -= amount
  dst.combatTimer = 0
  src.combatTimer = 0
  src.stats.damage += amount
  src.ult = Math.min(ULT_MAX, src.ult + amount / 14)
  dst.ult = Math.min(ULT_MAX, dst.ult + amount / 45)
  host.emit({
    t: 'damage',
    src: src.id,
    dst: dst.id,
    amount,
    absorbed: 0,
    ability: abilityId,
    tick: isTick,
    x: dst.pos.x,
    y: chestY(dst) + 0.5,
    z: dst.pos.z,
  })

  // Damage breaks sleep, and enough of it breaks confusion.
  for (let i = dst.auras.length - 1; i >= 0; i--) {
    const a = dst.auras[i]
    if (!a) continue
    if (a.def.breakOnDamage) {
      removeAura(host, dst, a, 'break')
      continue
    }
    if (a.def.breakAfterDamage !== undefined) {
      a.damageTaken += amount
      if (a.damageTaken >= a.def.breakAfterDamage) removeAura(host, dst, a, 'break')
    }
  }

  // Spiky Shield hurts whoever hits the holder up close (not damage over time).
  if (
    !isTick &&
    src !== dst &&
    src.alive &&
    Math.hypot(src.pos.x - dst.pos.x, src.pos.z - dst.pos.z) < THORNS_REACH
  ) {
    const spikes = dst.auras.find((a) => a.def.thorns)
    if (spikes?.def.thorns) dealDamage(host, dst, src, spikes.def.thorns, spikes.def.id, true)
  }

  if (dst.hp <= 0) kill(host, dst, src)
  return amount
}

export function heal(
  host: CombatHost,
  src: Fighter,
  dst: Fighter,
  raw: number,
  abilityId: string,
  isTick: boolean,
): number {
  if (!dst.alive) return 0
  let mult = 1
  for (const a of dst.auras) if (a.def.healingTaken !== undefined) mult *= a.def.healingTaken
  const amount = Math.round(Math.min(dst.maxHp - dst.hp, raw * mult))
  if (amount <= 0) return 0
  dst.hp += amount
  src.stats.healing += amount
  src.ult = Math.min(ULT_MAX, src.ult + amount / 10)
  host.emit({ t: 'heal', src: src.id, dst: dst.id, amount, ability: abilityId, tick: isTick })
  return amount
}

function kill(host: CombatHost, dst: Fighter, src: Fighter): void {
  dst.hp = 0
  dst.alive = false
  dst.cast = null
  endDash(dst)
  dst.auras.length = 0
  host.emit({ t: 'death', dst: dst.id, src: src.id })
}

function drCategory(def: AuraDef): DrCategory | undefined {
  return def.dr
}

export function applyAura(host: CombatHost, src: Fighter, dst: Fighter, def: AuraDef, stacks: number): void {
  if (!dst.alive) return
  // Immunities
  if ((def.cc === 'root' || def.slow) && dst.auras.some((a) => a.def.immuneRootSlow)) {
    host.emit({ t: 'immune', src: src.id, dst: dst.id, aura: def.id })
    return
  }
  let duration = def.duration
  const cat = drCategory(def)
  if (cat) {
    const dr = dst.dr[cat]
    const mult = DR_MULT[Math.min(dr.level, 3)] ?? 0
    if (mult === 0) {
      host.emit({ t: 'immune', src: src.id, dst: dst.id, aura: def.id })
      return
    }
    duration *= mult
    dr.level = Math.min(3, dr.level + 1)
    dr.timer = duration + COMBAT.drReset
    host.emit({ t: 'dr', dst: dst.id, cat, level: dr.level })
  }

  const existing = dst.auras.find((a) => a.def.id === def.id)
  if (existing) {
    existing.remaining = Math.max(existing.remaining, duration)
    existing.duration = Math.max(existing.duration, duration)
    existing.stacks = Math.min(def.maxStacks ?? 1, existing.stacks + stacks)
    existing.source = src.id
    host.emit({
      t: 'aura',
      src: src.id,
      dst: dst.id,
      aura: def.id,
      action: 'refresh',
      stacks: existing.stacks,
      duration: existing.remaining,
    })
  } else {
    const aura: Aura = {
      def,
      source: src.id,
      remaining: duration,
      duration,
      stacks: Math.min(def.maxStacks ?? 1, stacks),
      tickTimer: def.tick?.interval ?? 0,
      ticks: 0,
      damageTaken: 0,
    }
    dst.auras.push(aura)
    host.emit({
      t: 'aura',
      src: src.id,
      dst: dst.id,
      aura: def.id,
      action: 'apply',
      stacks: aura.stacks,
      duration,
    })
  }

  if (def.cc) {
    if (src.team !== dst.team) {
      src.stats.cc++
      src.ult = Math.min(ULT_MAX, src.ult + 5)
    }
    if (def.cc === 'stun' || def.cc === 'sleep' || def.cc === 'confuse') {
      cancelCast(host, dst, 'cc')
      endDash(dst)
      if (def.cc === 'confuse') dst.confuseYaw = host.rng.range(0, Math.PI * 2)
    } else if (def.cc === 'silence' && dst.cast?.ability.school === 'spell') {
      cancelCast(host, dst, 'silenced')
    }
  }
}

// Spend stacks of an aura (Heat, Tide); removes it when none are left.
export function consumeStacks(host: CombatHost, f: Fighter, aura: Aura, n: number): void {
  if (aura.stacks <= n) {
    removeAura(host, f, aura, 'remove')
    return
  }
  aura.stacks -= n
  host.emit({
    t: 'aura',
    src: aura.source,
    dst: f.id,
    aura: aura.def.id,
    action: 'refresh',
    stacks: aura.stacks,
    duration: aura.remaining,
  })
}

export function removeAura(
  host: CombatHost,
  f: Fighter,
  aura: Aura,
  action: 'remove' | 'expire' | 'break' | 'dispel',
): void {
  const i = f.auras.indexOf(aura)
  if (i < 0) return
  f.auras.splice(i, 1)
  host.emit({ t: 'aura', src: aura.source, dst: f.id, aura: aura.def.id, action, stacks: 0, duration: 0 })
}

export function cancelCast(host: CombatHost, f: Fighter, reason: 'moved' | 'cc' | 'silenced'): void {
  if (!f.cast) return
  host.emit({
    t: 'cast',
    src: f.id,
    ability: f.cast.ability.id,
    action: 'cancel',
    reason,
    target: f.cast.targetId,
  })
  f.cast = null
}

export function interrupt(host: CombatHost, src: Fighter, dst: Fighter, lockout: number): boolean {
  const c = dst.cast
  if (c?.ability.school !== 'spell' || !((c.ability.castTime ?? 0) > 0 || c.channel)) return false
  dst.cast = null
  dst.lockout = lockout
  src.stats.interrupts++
  src.ult = Math.min(ULT_MAX, src.ult + 12)
  host.emit({ t: 'cast', src: dst.id, ability: c.ability.id, action: 'interrupted', target: c.targetId })
  host.emit({ t: 'interrupt', src: src.id, dst: dst.id, ability: c.ability.id, lockout })
  return true
}

export function cleanse(
  host: CombatHost,
  _src: Fighter,
  dst: Fighter,
  count: number,
  types: readonly string[],
): number {
  let removed = 0
  // Crowd control first, then everything else, newest first.
  const order = [...dst.auras].reverse().sort((a, b) => Number(Boolean(b.def.cc)) - Number(Boolean(a.def.cc)))
  for (const a of order) {
    if (removed >= count) break
    if (!a.def.harmful || !types.includes(a.def.dispel)) continue
    removeAura(host, dst, a, 'dispel')
    removed++
  }
  return removed
}

export function breakCc(host: CombatHost, f: Fighter): void {
  for (let i = f.auras.length - 1; i >= 0; i--) {
    const a = f.auras[i]
    if (a?.def.harmful && (a.def.cc || a.def.slow)) removeAura(host, f, a, 'dispel')
  }
}

// Durations, ticks, diminishing returns, cooldowns and resource regen.
export function updateFighterTimers(host: CombatHost, f: Fighter, dt: number): void {
  for (const k of SLOTS) {
    if (f.cooldowns[k] > 0) f.cooldowns[k] = Math.max(0, f.cooldowns[k] - dt)
  }
  f.gcd = Math.max(0, f.gcd - dt)
  f.lockout = Math.max(0, f.lockout - dt)
  if (f.comboTimer > 0) {
    f.comboTimer -= dt
    if (f.comboTimer <= 0) f.comboStep = 0
  }
  f.combatTimer += dt
  for (const cat of ['stun', 'incap', 'disorient', 'root', 'silence'] as const) {
    const dr = f.dr[cat]
    if (dr.level > 0) {
      dr.timer -= dt
      if (dr.timer <= 0) {
        dr.level = 0
        host.emit({ t: 'dr', dst: f.id, cat, level: 0 })
      }
    }
  }
  if (!f.alive) return

  f.resource = Math.min(f.maxResource, f.resource + f.cls.regen * dt)

  for (let i = f.auras.length - 1; i >= 0; i--) {
    const a = f.auras[i]
    if (!a) continue
    const tick = a.def.tick
    if (tick) {
      a.tickTimer -= dt
      while (a.tickTimer <= 1e-9 && f.alive && f.auras.includes(a)) {
        a.tickTimer += tick.interval
        a.ticks++
        const src = host.byId(a.source) ?? f
        const stackMult = tick.perStack ? a.stacks : 1
        if (tick.damage) {
          let dmg = (tick.damage + (tick.escalate ?? 0) * (a.ticks - 1)) * stackMult
          if (tick.movingMult && f.moving) dmg *= tick.movingMult
          const dealt = dealDamage(host, src, f, dmg, a.def.id, true)
          if (tick.drain && dealt > 0 && src !== f) heal(host, src, src, dealt * tick.drain, a.def.id, true)
        }
        if (tick.heal) heal(host, src, f, tick.heal * stackMult, a.def.id, true)
      }
      if (!f.alive) return
      if (!f.auras.includes(a)) continue
    }
    a.remaining -= dt
    if (a.remaining <= 0) removeAura(host, f, a, 'expire')
  }
}
