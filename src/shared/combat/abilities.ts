import { Vector3 } from 'three'
import { type Aim, coneTarget, handPosition } from '../sim/aim'
import { segmentVsVertical } from '../sim/collision'
import { COMBAT, MOVE } from '../sim/constants'
import { chestY, type Fighter, findAura, hasCc, hurtHeight, isBlind, isIncapacitated } from '../sim/fighter'
import { Btn, held, pressed, SLOT_BUTTON } from '../sim/input'
import { endDash } from '../sim/movement'
import { applyEffects, cancelCast, consumeStacks, ULT_MAX } from './effects'
import { spawnHazard } from './entities'
import type { FailReason } from './events'
import type { CombatHost } from './host'
import { type AbilityDef, abilityAt, BLIND_RANGE, type Effect, type Side, type Slot } from './types'

const hand = new Vector3()
const USE_ORDER: readonly Slot[] = ['c', 'f', 'e', 'q', 'r', 'a3', 'a2', 'a1', 'rmb', 'lmb']

// Run one tick of ability input for a fighter: focus keys, cast progress,
// then at most one new ability use.
export function updateAbilities(host: CombatHost, f: Fighter, aim: Aim, dt: number): void {
  if (!f.alive) return
  const b = f.buttons
  const prev = f.prevButtons
  if (pressed(b, prev, Btn.FocusSelf)) f.focusAlly = f.id
  if (pressed(b, prev, Btn.FocusAlly)) {
    const ally = host.fighters.find((g) => g.team === f.team && g.id !== f.id && g.control !== 'dummy')
    const dummyAlly = host.fighters.find((g) => g.team === f.team && g.id !== f.id)
    f.focusAlly = (ally ?? dummyAlly ?? f).id
  }

  // Tab-target model: the client (or bot) says who is selected.
  const wantTarget = f.input.target
  if (wantTarget !== undefined) {
    if (wantTarget < 0) f.target = -1
    else {
      const g = host.byId(wantTarget)
      if (g?.alive && g.team !== f.team) f.target = g.id
    }
  }
  const wantAlly = f.input.ally
  if (wantAlly !== undefined && wantAlly >= 0) {
    const g = host.byId(wantAlly)
    if (g?.alive && g.team === f.team) f.focusAlly = g.id
  }
  const sticky = host.byId(f.target)
  if (sticky && !sticky.alive) f.target = -1

  if (f.cast) advanceCast(host, f, aim, dt)

  for (const slot of USE_ORDER) {
    const bit = SLOT_BUTTON[slot]
    if (!held(b, bit)) continue
    const isPress = pressed(b, prev, bit)
    if (f.cast && f.cast.ability.slot === slot) continue
    if (tryUse(host, f, slot, aim, isPress)) break
  }
}

function fail(host: CombatHost, f: Fighter, ability: AbilityDef, reason: FailReason, loud: boolean): false {
  if (loud) host.emit({ t: 'cast', src: f.id, ability: ability.id, action: 'fail', reason, target: -1 })
  return false
}

// The enemy an ability goes to: your selection, else whoever is under the
// crosshair, else the nearest enemy in front. An auto-pick becomes the selection.
export function enemyTarget(host: CombatHost, f: Fighter, aim: Aim, range: number): Fighter | null {
  const sel = host.byId(f.target)
  if (sel?.alive && sel.team !== f.team) return sel
  const under = aim.fighter >= 0 ? host.byId(aim.fighter) : undefined
  let pick: Fighter | null = under?.alive && under.team !== f.team ? under : null
  pick ??= coneTarget(f, aim, host.world, host.fighters, range, COMBAT.autoTargetAngle, false, false)
  if (pick) f.target = pick.id
  return pick
}

// Range at which an ability locks onto the enemy target, or null if it is
// aimed freely (lobs, ground zones, ally spells, cones).
function lockRange(a: AbilityDef): number | null {
  const t = a.target
  switch (t.kind) {
    case 'projectile':
      return t.gravity || t.hazard || t.side === 'ally' ? null : t.range
    case 'hitscan':
    case 'beam':
      return t.side === 'ally' ? null : t.range
    case 'targeted':
      return t.side === 'enemy' ? t.range : null
    case 'dash':
      return t.toTarget ? t.distance + 2 : null
    default:
      return null
  }
}

export function tryUse(host: CombatHost, f: Fighter, slot: Slot, aim: Aim, loud: boolean): boolean {
  const a = abilityAt(f.cls, slot)
  if (!a || !f.alive) return false
  if (f.auras.some((x) => x.def.noCast)) return fail(host, f, a, 'cc', loud)
  if (isIncapacitated(f) && !a.usableWhileCc) return fail(host, f, a, 'cc', loud)
  if (a.school === 'spell' && hasCc(f, 'silence')) return fail(host, f, a, 'silenced', loud)
  const timed = (a.castTime ?? 0) > 0 || a.channel !== undefined
  if (f.lockout > 0 && a.school === 'spell' && timed) return fail(host, f, a, 'lockout', loud)
  if (f.cooldowns[slot] > 0) return fail(host, f, a, 'cooldown', loud && slot !== 'lmb')
  if (f.gcd > 0 && !a.offGcd) return false
  if (f.resource < a.cost) return fail(host, f, a, 'resource', loud)
  const isUlt = a.tags.includes('ult')
  if (isUlt && f.ult < ULT_MAX) return fail(host, f, a, 'resource', loud)
  if (f.dash) return false
  if (f.cast) {
    if (!a.offGcd) return false
    cancelCast(host, f, 'moved')
  }

  // Pick and validate the target before paying anything.
  let targetId = -1
  const under = aim.fighter >= 0 ? host.byId(aim.fighter) : undefined
  const underAlly = under?.alive && under.team === f.team && under !== f ? under : null
  if (a.target.kind === 'targeted' && a.target.side === 'ally') {
    const range = a.target.range
    let t: Fighter | null = underAlly && inRangeAndSight(host, f, underAlly, range) ? underAlly : null
    if (!t) {
      const focus = host.byId(f.focusAlly)
      t = focus?.alive && inRangeAndSight(host, f, focus, range) ? focus : f
    }
    targetId = t.id
  } else if (a.target.kind === 'projectile' && a.target.side === 'both' && underAlly) {
    // Pollen Puff on the ally under the cursor.
    if (!inRangeAndSight(host, f, underAlly, a.target.range)) return fail(host, f, a, 'los', loud)
    targetId = underAlly.id
  } else {
    const range = lockRange(a)
    const t = range === null ? null : enemyTarget(host, f, aim, range)
    if (t && range !== null) {
      const d = Math.hypot(t.pos.x - f.pos.x, t.pos.z - f.pos.z)
      if (d > range) return fail(host, f, a, 'range', loud)
      if (
        (isBlind(f) && d > BLIND_RANGE) ||
        !host.world.lineOfSight(f.pos.x, f.pos.y + 1.5, f.pos.z, t.pos.x, chestY(t), t.pos.z)
      ) {
        return fail(host, f, a, 'los', loud)
      }
      targetId = t.id
    } else if (a.target.kind === 'targeted') {
      return fail(host, f, a, 'target', loud)
    }
  }

  let castTime = a.castTime ?? 0
  if (castTime > 0 && a.castBoost) {
    const b = a.castBoost
    const stacks = findAura(f, b.aura)
    if (stacks && stacks.stacks >= b.need) {
      castTime *= b.mult
      consumeStacks(host, f, stacks, b.consume)
    }
  }

  if (castTime > 0) {
    if (!f.grounded && !a.mobile) return fail(host, f, a, 'moved', loud)
    f.cast = { ability: a, elapsed: 0, duration: castTime, targetId, channel: false, tickTimer: 0 }
    f.gcd = COMBAT.gcd
    host.emit({ t: 'cast', src: f.id, ability: a.id, action: 'start', target: targetId })
    return true
  }

  f.resource -= a.cost
  if (isUlt) f.ult = 0
  f.cooldowns[slot] = a.cooldown
  if (!a.offGcd && !(a.channel && slot === 'lmb')) f.gcd = COMBAT.gcd

  if (a.channel) {
    f.cast = { ability: a, elapsed: 0, duration: a.channel.duration, targetId, channel: true, tickTimer: 0 }
    host.emit({ t: 'cast', src: f.id, ability: a.id, action: 'start', target: targetId })
    return true
  }

  resolve(host, f, a, targetId, aim)
  return true
}

function inRangeAndSight(host: CombatHost, f: Fighter, g: Fighter, range: number): boolean {
  if (g === f) return true
  const d = Math.hypot(g.pos.x - f.pos.x, g.pos.z - f.pos.z)
  if (d > range || (isBlind(f) && d > BLIND_RANGE)) return false
  return host.world.lineOfSight(f.pos.x, f.pos.y + 1.5, f.pos.z, g.pos.x, chestY(g), g.pos.z)
}

function advanceCast(host: CombatHost, f: Fighter, aim: Aim, dt: number): void {
  const c = f.cast
  if (!c) return
  const a = c.ability
  const moving = Math.abs(f.input.moveX) > 0.01 || Math.abs(f.input.moveZ) > 0.01 || !f.grounded
  if (moving && !a.mobile) {
    cancelCast(host, f, 'moved')
    return
  }
  if (c.channel) {
    // Held primaries (Psybeam) stop when released.
    if (a.slot === 'lmb' && !held(f.buttons, Btn.Lmb)) {
      host.emit({ t: 'cast', src: f.id, ability: a.id, action: 'success', target: c.targetId })
      f.cast = null
      return
    }
    c.tickTimer -= dt
    if (c.tickTimer <= 0 && a.channel) {
      c.tickTimer += a.channel.interval
      resolve(host, f, a, c.targetId, aim)
    }
    c.elapsed += dt
    if (c.elapsed >= c.duration) {
      host.emit({ t: 'cast', src: f.id, ability: a.id, action: 'success', target: c.targetId })
      f.cast = null
    }
    return
  }

  c.elapsed += dt
  if (c.elapsed < c.duration) return

  // Cast completes: re-check target and line of sight, then pay and resolve.
  f.cast = null
  if (c.targetId >= 0 && c.targetId !== f.id) {
    const t = host.byId(c.targetId)
    const range = lockRange(a) ?? (a.target.kind === 'targeted' ? a.target.range : 40)
    if (!t?.alive) {
      fail(host, f, a, 'target', true)
      return
    }
    const d = Math.hypot(t.pos.x - f.pos.x, t.pos.z - f.pos.z)
    if (d > range + 2) {
      fail(host, f, a, 'range', true)
      return
    }
    if (
      (isBlind(f) && d > BLIND_RANGE) ||
      !host.world.lineOfSight(f.pos.x, f.pos.y + 1.5, f.pos.z, t.pos.x, chestY(t), t.pos.z)
    ) {
      fail(host, f, a, 'los', true)
      return
    }
  }
  if (f.resource < a.cost) {
    fail(host, f, a, 'resource', true)
    return
  }
  if (a.tags.includes('ult')) {
    if (f.ult < ULT_MAX) {
      fail(host, f, a, 'resource', true)
      return
    }
    f.ult = 0
  }
  f.resource -= a.cost
  f.cooldowns[a.slot] = a.cooldown
  host.emit({ t: 'cast', src: f.id, ability: a.id, action: 'success', target: c.targetId })
  resolve(host, f, a, c.targetId, aim)
}

function sideMatches(side: Side, f: Fighter, g: Fighter): boolean {
  if (side === 'both') return true
  return side === 'enemy' ? g.team !== f.team : g.team === f.team
}

function emitUse(
  host: CombatHost,
  f: Fighter,
  a: AbilityDef,
  tx: number,
  ty: number,
  tz: number,
  target: number,
): void {
  handPosition(f, hand)
  host.emit({ t: 'use', src: f.id, ability: a.id, x: hand.x, y: hand.y, z: hand.z, tx, ty, tz, target })
}

function withNth(f: Fighter, a: AbilityDef): readonly Effect[] {
  if (!a.everyNth) return a.effects
  f.nthCount++
  if (f.nthCount % a.everyNth.n === 0) return [...a.effects, ...a.everyNth.effects]
  return a.effects
}

export function resolve(host: CombatHost, f: Fighter, a: AbilityDef, targetId: number, aim: Aim): void {
  resolveTarget(host, f, a, targetId, aim)
  // After the hit, so a self-debuff (Overheat) can't weaken its own spell.
  if (a.selfEffects) applyEffects(host, f, f, a, a.selfEffects)
}

function resolveTarget(host: CombatHost, f: Fighter, a: AbilityDef, targetId: number, aim: Aim): void {
  const t = a.target
  switch (t.kind) {
    case 'self':
      emitUse(host, f, a, f.pos.x, f.pos.y, f.pos.z, f.id)
      break

    case 'projectile': {
      handPosition(f, hand)
      const count = t.count ?? 1
      const nth = a.everyNth !== undefined && (f.nthCount + 1) % a.everyNth.n === 0
      if (a.everyNth) f.nthCount++
      const locked = host.byId(targetId)
      const goal = locked?.alive && locked !== f && !t.gravity ? locked : null
      let dx = (goal ? goal.pos.x : aim.px) - hand.x
      let dy = (goal ? chestY(goal) : aim.py) - hand.y
      let dz = (goal ? goal.pos.z : aim.pz) - hand.z
      const len = Math.hypot(dx, dy, dz) || 1
      dx /= len
      dy /= len
      dz /= len
      // Lobbed projectiles aim up a little so they land near the crosshair.
      if (t.gravity) dy += Math.min(0.5, (t.gravity * len) / (2 * t.speed * t.speed))
      for (let i = 0; i < count; i++) {
        const spread = count > 1 ? (i - (count - 1) / 2) * (t.spread ?? 0.08) : 0
        const cs = Math.cos(spread)
        const sn = Math.sin(spread)
        const vx = dx * cs - dz * sn
        const vz = dx * sn + dz * cs
        const id = host.nextId()
        const proj = {
          id,
          owner: f.id,
          team: f.team,
          ability: a,
          x: hand.x,
          y: hand.y,
          z: hand.z,
          vx: vx * t.speed,
          vy: dy * t.speed,
          vz: vz * t.speed,
          radius: t.radius,
          gravity: t.gravity ?? 0,
          // Homing shots chase the target a bit past their nominal range.
          range: goal ? t.range * 1.6 : t.range,
          side: t.side ?? 'enemy',
          nth,
          alive: true,
          homing: goal ? goal.id : -1,
        }
        host.projectiles.push(t.hazard ? { ...proj, hazard: t.hazard } : proj)
      }
      if (goal) emitUse(host, f, a, goal.pos.x, chestY(goal), goal.pos.z, goal.id)
      else emitUse(host, f, a, aim.px, aim.py, aim.pz, aim.fighter)
      break
    }

    case 'hitscan': {
      const locked = host.byId(targetId)
      const g = locked?.alive ? locked : rayFighter(host, f, aim, t.range, 0.25, t.side ?? 'enemy')
      const ex = g ? g.pos.x : aim.ox + aim.dx * Math.min(aim.dist, t.range)
      const ey = g ? chestY(g) : aim.oy + aim.dy * Math.min(aim.dist, t.range)
      const ez = g ? g.pos.z : aim.oz + aim.dz * Math.min(aim.dist, t.range)
      emitUse(host, f, a, ex, ey, ez, g ? g.id : -1)
      if (g) applyEffects(host, f, g, a, withNth(f, a))
      break
    }

    case 'targeted': {
      const g = host.byId(targetId)
      if (!g?.alive) break
      if (a.blinkBehind) blinkBehind(host, f, g)
      emitUse(host, f, a, g.pos.x, chestY(g), g.pos.z, g.id)
      applyEffects(host, f, g, a, withNth(f, a))
      break
    }

    case 'ground': {
      // @cursor casts send the ground point; otherwise use the crosshair.
      let px = f.input.aimX ?? aim.px
      let pz = f.input.aimZ ?? aim.pz
      const dx = px - f.pos.x
      const dz = pz - f.pos.z
      const d = Math.hypot(dx, dz)
      if (d > t.range) {
        px = f.pos.x + (dx / d) * t.range
        pz = f.pos.z + (dz / d) * t.range
      }
      const py = host.world.groundHeight(px, pz, aim.py + 1)
      const y = Number.isFinite(py) ? py : 0
      emitUse(host, f, a, px, y, pz, -1)
      if (t.hazard) spawnHazard(host, f, a, t.hazard, px, y, pz)
      for (const e of a.effects) {
        if (e.kind !== 'delayed') continue
        const id = host.nextId()
        host.delayed.push({
          id,
          owner: f.id,
          team: f.team,
          ability: a,
          targetId: -1,
          x: px,
          y,
          z: pz,
          remaining: e.delay,
          radius: e.radius,
          follow: false,
          side: e.side,
          effects: e.effects,
        })
        host.emit({
          t: 'delayed',
          id,
          ability: a.id,
          src: f.id,
          target: -1,
          delay: e.delay,
          radius: e.radius,
        })
      }
      const instant = a.effects.filter((e) => e.kind !== 'delayed')
      if (instant.length > 0) {
        for (const g of host.fighters) {
          if (!g.alive || !sideMatches(t.side, f, g)) continue
          if (Math.hypot(g.pos.x - px, g.pos.z - pz) <= t.radius) applyEffects(host, f, g, a, instant)
        }
      }
      break
    }

    case 'nova': {
      emitUse(host, f, a, f.pos.x, f.pos.y, f.pos.z, f.id)
      for (const g of host.fighters) {
        if (!g.alive || !sideMatches(t.side, f, g)) continue
        if (Math.hypot(g.pos.x - f.pos.x, g.pos.z - f.pos.z) > t.radius) continue
        if (g !== f && !host.world.lineOfSight(f.pos.x, f.pos.y + 1.5, f.pos.z, g.pos.x, chestY(g), g.pos.z))
          continue
        applyEffects(host, f, g, a, a.effects)
      }
      break
    }

    case 'cone':
    case 'melee': {
      const range = t.range
      const half = t.angle / 2
      const side: Side = t.kind === 'cone' ? (t.side ?? 'enemy') : 'enemy'
      let effects = withNth(f, a)
      if (a.combo) {
        f.comboStep = (f.comboStep % a.combo.steps) + 1
        f.comboTimer = a.combo.window
        if (f.comboStep === a.combo.steps) effects = [...effects, ...a.combo.finisher]
      }
      let fx = Math.cos(f.yaw)
      let fz = Math.sin(f.yaw)
      if (t.kind === 'melee') {
        // Swing at your target when it's in reach, whichever way the camera faces.
        const sel = host.byId(f.target)
        if (sel?.alive && sel.team !== f.team) {
          const dx = sel.pos.x - f.pos.x
          const dz = sel.pos.z - f.pos.z
          const d = Math.hypot(dx, dz)
          if (d <= range + 1 && d > 1e-3) {
            fx = dx / d
            fz = dz / d
          }
        }
      }
      emitUse(host, f, a, f.pos.x + fx * range, f.pos.y + 1, f.pos.z + fz * range, -1)
      for (const g of host.fighters) {
        if (g === f || !g.alive || !sideMatches(side, f, g)) continue
        const dx = g.pos.x - f.pos.x
        const dz = g.pos.z - f.pos.z
        const d = Math.hypot(dx, dz)
        if (d > range + MOVE.radius || Math.abs(g.pos.y - f.pos.y) > 2.2) continue
        const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / (d || 1))))
        if (d > 1 && ang > half) continue
        if (!host.world.lineOfSight(f.pos.x, f.pos.y + 1.2, f.pos.z, g.pos.x, chestY(g), g.pos.z)) continue
        applyEffects(host, f, g, a, effects)
      }
      break
    }

    case 'dash': {
      let dirX = aim.dx
      let dirZ = aim.dz
      let dist: number = t.distance
      let tid = -1
      if (t.toTarget) {
        const locked = host.byId(targetId)
        const g = locked?.alive
          ? locked
          : coneTarget(
              f,
              aim,
              host.world,
              host.fighters,
              t.distance + 2,
              COMBAT.aimAssistAngle * 1.6,
              false,
              false,
            )
        if (g) {
          dirX = g.pos.x - f.pos.x
          dirZ = g.pos.z - f.pos.z
          dist = Math.max(0, Math.hypot(dirX, dirZ) - 1.1)
          tid = g.id
        }
      }
      const l = Math.hypot(dirX, dirZ) || 1
      dirX /= l
      dirZ /= l
      cancelCast(host, f, 'moved')
      f.dash = { ability: a, dirX, dirZ, remaining: dist, speed: t.speed, targetId: tid, hit: false }
      f.vel.y = 0
      emitUse(host, f, a, f.pos.x + dirX * dist, f.pos.y, f.pos.z + dirZ * dist, tid)
      break
    }

    case 'beam': {
      // A locked beam stays on its target while it is in range and sight.
      const locked = host.byId(targetId)
      const g =
        targetId >= 0
          ? locked?.alive && inRangeAndSight(host, f, locked, t.range + 2)
            ? locked
            : null
          : rayFighter(host, f, aim, t.range, t.radius, t.side ?? 'enemy')
      handPosition(f, hand)
      const ex = g ? g.pos.x : aim.ox + aim.dx * Math.min(aim.dist, t.range)
      const ey = g ? chestY(g) : aim.oy + aim.dy * Math.min(aim.dist, t.range)
      const ez = g ? g.pos.z : aim.oz + aim.dz * Math.min(aim.dist, t.range)
      host.emit({
        t: 'use',
        src: f.id,
        ability: a.id,
        x: hand.x,
        y: hand.y,
        z: hand.z,
        tx: ex,
        ty: ey,
        tz: ez,
        target: g ? g.id : -1,
      })
      if (g) applyEffects(host, f, g, a, a.effects)
      break
    }
  }
}

// Shadow Sneak: step out of the target's shadow, facing its back. Falls back
// to striking from where you stand if a wall is in the way.
function blinkBehind(host: CombatHost, f: Fighter, g: Fighter): void {
  const bx = -Math.cos(g.yaw)
  const bz = -Math.sin(g.yaw)
  for (const back of [1.4, 0.9]) {
    const x = g.pos.x + bx * back
    const z = g.pos.z + bz * back
    if (!host.world.lineOfSight(g.pos.x, g.pos.y + 1, g.pos.z, x, g.pos.y + 1, z)) continue
    const y = host.world.groundHeight(x, z, g.pos.y + 1.5)
    if (!Number.isFinite(y)) continue
    cancelCast(host, f, 'moved')
    endDash(f)
    f.pos.set(x, y, z)
    f.vel.set(0, 0, 0)
    host.world.resolveCapsule(f.pos, MOVE.radius, hurtHeight(f), MOVE.step)
    f.yaw = Math.atan2(g.pos.z - f.pos.z, g.pos.x - f.pos.x)
    return
  }
}

// First fighter along the aim ray (fat ray of the given radius) within range,
// stopping at world geometry.
function rayFighter(
  host: CombatHost,
  f: Fighter,
  aim: Aim,
  range: number,
  radius: number,
  side: Side,
): Fighter | null {
  const maxT = Math.min(aim.dist + 0.5, 140)
  const ex = aim.ox + aim.dx * maxT
  const ey = aim.oy + aim.dy * maxT
  const ez = aim.oz + aim.dz * maxT
  let best: Fighter | null = null
  let bestT = Number.POSITIVE_INFINITY
  for (const g of host.fighters) {
    if (g === f || !g.alive || !sideMatches(side, f, g)) continue
    const r = MOVE.radius + radius
    const c = segmentVsVertical(
      aim.ox,
      aim.oy,
      aim.oz,
      ex,
      ey,
      ez,
      g.pos.x,
      g.pos.y + r,
      g.pos.y + hurtHeight(g) - MOVE.radius,
      g.pos.z,
    )
    if (c.dist2 > r * r) continue
    const tAlong = c.s * maxT
    if (tAlong >= bestT) continue
    if (Math.hypot(g.pos.x - f.pos.x, g.pos.z - f.pos.z) > range) continue
    if (!host.world.lineOfSight(f.pos.x, f.pos.y + 1.5, f.pos.z, g.pos.x, chestY(g), g.pos.z)) continue
    best = g
    bestT = tAlong
  }
  return best
}
