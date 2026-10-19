import { CLASSES, getAbility, getAura } from '../../shared/combat/registry'
import { DR_CATEGORIES, SLOTS } from '../../shared/combat/types'
import type { FighterSnap } from '../../shared/net/protocol'
import { type Fighter, makeFighter } from '../../shared/sim/fighter'

export function fighterFromSnap(s: FighterSnap): Fighter {
  const f = makeFighter(s.id, s.team, s.name, CLASSES[s.cls], s.control, s.x, s.y, s.z, s.yaw)
  applySnap(f, s)
  return f
}

// Copy authoritative state into a local Fighter (used for prediction).
export function applySnap(f: Fighter, s: FighterSnap): void {
  if (f.cls.id !== s.cls) f.cls = CLASSES[s.cls]
  f.pos.set(s.x, s.y, s.z)
  f.vel.set(s.vx, s.vy, s.vz)
  f.yaw = s.yaw
  f.pitch = s.pitch
  f.grounded = s.grounded
  f.move = s.move
  f.sprintTimer = s.sprintTimer
  f.slideTimer = s.slideTimer
  f.slideCooldown = s.slideCooldown
  f.slideHeld = s.slideHeld
  f.prevButtons = s.prevButtons
  f.hp = s.hp
  f.maxHp = s.maxHp
  f.resource = s.res
  f.maxResource = s.maxRes
  f.alive = s.alive
  f.gcd = s.gcd
  f.lockout = s.lockout
  f.ult = s.ult
  f.comboStep = s.combo
  f.focusAlly = s.focus
  f.target = s.target
  SLOTS.forEach((slot, i) => {
    f.cooldowns[slot] = s.cd[i] ?? 0
  })
  DR_CATEGORIES.forEach((cat, i) => {
    f.dr[cat].level = s.dr[i] ?? 0
    f.dr[cat].timer = s.drTimers[i] ?? 0
  })
  f.auras = s.auras.map((a) => ({
    def: getAura(a.id),
    source: a.src,
    remaining: a.rem,
    duration: a.dur,
    stacks: a.stacks,
    tickTimer: 0,
    ticks: 0,
    damageTaken: 0,
  }))
  const castAbility = s.cast ? getAbility(s.cast.ability) : undefined
  f.cast =
    s.cast && castAbility
      ? {
          ability: castAbility,
          elapsed: s.cast.elapsed,
          duration: s.cast.duration,
          targetId: s.cast.target,
          channel: s.cast.channel,
          tickTimer: 0,
        }
      : null
  const dashAbility = s.dash ? getAbility(s.dash.ability) : undefined
  f.dash =
    s.dash && dashAbility
      ? {
          ability: dashAbility,
          dirX: s.dash.dx,
          dirZ: s.dash.dz,
          remaining: s.dash.rem,
          speed: s.dash.speed,
          targetId: -1,
          hit: true,
        }
      : null
  f.lastSeq = s.lastSeq
  f.stats.damage = s.damage
  f.stats.healing = s.healing
  f.stats.interrupts = s.interrupts
  f.stats.cc = s.ccDone
}
