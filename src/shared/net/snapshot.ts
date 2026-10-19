import type { SimEvent } from '../combat/events'
import { DR_CATEGORIES, SLOTS } from '../combat/types'
import type { Fighter } from '../sim/fighter'
import type { MatchSim } from '../sim/match'
import type { FighterSnap, Snapshot } from './protocol'

export function snapFighter(f: Fighter): FighterSnap {
  const snap: FighterSnap = {
    id: f.id,
    team: f.team,
    name: f.name,
    cls: f.cls.id,
    control: f.control,
    x: f.pos.x,
    y: f.pos.y,
    z: f.pos.z,
    vx: f.vel.x,
    vy: f.vel.y,
    vz: f.vel.z,
    yaw: f.yaw,
    pitch: f.pitch,
    grounded: f.grounded,
    move: f.move,
    sprintTimer: f.sprintTimer,
    slideTimer: f.slideTimer,
    slideCooldown: f.slideCooldown,
    slideHeld: f.slideHeld,
    prevButtons: f.prevButtons,
    hp: f.hp,
    maxHp: f.maxHp,
    res: f.resource,
    maxRes: f.maxResource,
    alive: f.alive,
    cast: f.cast
      ? {
          ability: f.cast.ability.id,
          elapsed: f.cast.elapsed,
          duration: f.cast.duration,
          target: f.cast.targetId,
          channel: f.cast.channel,
        }
      : null,
    dash: f.dash
      ? {
          ability: f.dash.ability.id,
          dx: f.dash.dirX,
          dz: f.dash.dirZ,
          rem: f.dash.remaining,
          speed: f.dash.speed,
        }
      : null,
    cd: SLOTS.map((s) => f.cooldowns[s]),
    gcd: f.gcd,
    lockout: f.lockout,
    ult: f.ult,
    combo: f.comboStep,
    auras: f.auras.map((a) => ({
      id: a.def.id,
      rem: a.remaining,
      dur: a.duration,
      stacks: a.stacks,
      src: a.source,
    })),
    dr: DR_CATEGORIES.map((c) => f.dr[c].level),
    drTimers: DR_CATEGORIES.map((c) => f.dr[c].timer),
    focus: f.focusAlly,
    target: f.target,
    lastSeq: f.lastSeq,
    damage: f.stats.damage,
    healing: f.stats.healing,
    interrupts: f.stats.interrupts,
    ccDone: f.stats.cc,
  }
  if (f.dummyRole) snap.dummyRole = f.dummyRole
  return snap
}

export function buildSnapshot(sim: MatchSim, events: SimEvent[]): Snapshot {
  return {
    tick: sim.tick,
    mode: sim.mode,
    phase: sim.phase,
    phaseTimer: sim.phaseTimer,
    winner: sim.winner,
    fighters: sim.fighters.map(snapFighter),
    projectiles: sim.projectiles.map((p) => ({
      id: p.id,
      ability: p.ability.id,
      owner: p.owner,
      x: p.x,
      y: p.y,
      z: p.z,
      vx: p.vx,
      vy: p.vy,
      vz: p.vz,
    })),
    hazards: sim.hazards.map((h) => ({
      id: h.id,
      ability: h.ability.id,
      owner: h.owner,
      x: h.x,
      y: h.y,
      z: h.z,
      radius: h.def.radius,
      rem: h.remaining,
    })),
    delayed: sim.delayed.map((d) => ({
      id: d.id,
      ability: d.ability.id,
      owner: d.owner,
      x: d.x,
      y: d.y,
      z: d.z,
      radius: d.radius,
      rem: d.remaining,
      target: d.targetId,
    })),
    events,
    aggressorOn: sim.aggressorOn,
  }
}
