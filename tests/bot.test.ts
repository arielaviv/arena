import { describe, expect, it } from 'vitest'
import { navInfo, segmentHitsPrism, waypoint } from '../src/shared/bot/nav'
import { applyAura } from '../src/shared/combat/effects'
import type { SimEvent } from '../src/shared/combat/events'
import { getAura } from '../src/shared/combat/registry'
import type { ClassId } from '../src/shared/combat/types'
import { aimAtPoint } from '../src/shared/sim/aim'
import { chestY, type Fighter } from '../src/shared/sim/fighter'
import type { InputCmd } from '../src/shared/sim/input'
import { Btn } from '../src/shared/sim/input'
import { MatchSim, type SlotConfig } from '../src/shared/sim/match'

function match(team0: SlotConfig[], team1: SlotConfig[], seed = 1, difficulty = 1): MatchSim {
  const sim = new MatchSim({ mode: 'arena', seed, countdown: 0.05, difficulty, teams: [team0, team1] })
  for (let i = 0; i < 6; i++) sim.step()
  return sim
}

const bot = (classId: ClassId, name = classId): SlotConfig => ({ classId, name, control: 'bot' })
const human = (classId: ClassId, name = classId): SlotConfig => ({ classId, name, control: 'human' })

function place(f: Fighter, x: number, z: number): void {
  f.pos.set(x, 0, z)
  f.vel.set(0, 0, 0)
}

let seq = 0
function press(sim: MatchSim, f: Fighter, buttons: number, at?: Fighter): void {
  const aim = { yaw: f.yaw, pitch: f.pitch }
  if (at) aimAtPoint(f, at.pos.x, chestY(at), at.pos.z, aim)
  const cmd: InputCmd = { seq: ++seq, moveX: 0, moveZ: 0, yaw: aim.yaw, pitch: aim.pitch, buttons }
  sim.setInput(f.id, cmd)
}

function run(sim: MatchSim, ticks: number): SimEvent[] {
  const out: SimEvent[] = []
  for (let i = 0; i < ticks; i++) {
    sim.step()
    out.push(...sim.drainEvents())
  }
  return out
}

describe('navigation', () => {
  it('walks around a pillar instead of into it', () => {
    const sim = match([bot('cindrake')], [bot('venomaw')])
    const nav = navInfo(sim.world)
    const pillar = nav.pillars.find((p) => p.cx > 0 && p.cz > 0)!
    const out = { x: 0, z: 0 }
    // Straight through the north-east pillar.
    waypoint(nav, pillar.cx - 6, pillar.cz - 6, pillar.cx + 6, pillar.cz + 6, out)
    expect(out.x === pillar.cx + 6 && out.z === pillar.cz + 6).toBe(false)
    expect(segmentHitsPrism(pillar, pillar.cx - 6, pillar.cz - 6, out.x, out.z, 0)).toBe(-1)
  })

  it('keeps the straight line when nothing is in the way', () => {
    const sim = match([bot('cindrake')], [bot('venomaw')])
    const out = { x: 0, z: 0 }
    const len = waypoint(navInfo(sim.world), -5, 0, 5, 0, out)
    expect(out).toEqual({ x: 5, z: 0 })
    expect(len).toBeCloseTo(10)
  })
})

describe('bot pillar play', () => {
  it('breaks line of sight when targeted by Hypnosis', () => {
    let juked = 0
    for (let seed = 1; seed <= 5; seed++) {
      const sim = match([bot('cindrake', 'bot')], [human('lumora', 'caster')], seed)
      const [me, foe] = sim.fighters as [Fighter, Fighter]
      // Next to the north-east pillar, caster out in the open to the south-west.
      place(me, 3.5, 6)
      place(foe, -14, -4)
      run(sim, 1)
      press(sim, foe, Btn.Rmb, me)
      run(sim, 2)
      expect(foe.cast?.ability.id).toBe('hypnosis')
      press(sim, foe, 0, me)
      const events = run(sim, 100)
      const failed = events.some((e) => e.t === 'cast' && e.action === 'fail' && e.reason === 'los')
      if (failed && !me.auras.some((a) => a.def.id === 'hypnosis')) juked++
    }
    expect(juked).toBeGreaterThanOrEqual(4)
  })

  it('steps out of an Eruption telegraph', () => {
    let dodged = 0
    for (let seed = 1; seed <= 4; seed++) {
      const sim = match([bot('lumora', 'bot')], [human('cindrake', 'caster')], seed)
      const [me, foe] = sim.fighters as [Fighter, Fighter]
      place(me, 0, -4)
      place(foe, -16, -4)
      foe.ult = 100
      run(sim, 1)
      const aim = { yaw: 0, pitch: 0 }
      aimAtPoint(foe, me.pos.x - 1.5, 0.05, me.pos.z, aim)
      sim.setInput(foe.id, { seq: ++seq, moveX: 0, moveZ: 0, yaw: aim.yaw, pitch: aim.pitch, buttons: Btn.R })
      run(sim, 2)
      press(sim, foe, 0)
      expect(sim.delayed.length).toBe(1)
      const events = run(sim, 70)
      if (!events.some((e) => e.t === 'damage' && e.ability === 'eruption' && e.dst === me.id)) dodged++
    }
    expect(dodged).toBeGreaterThanOrEqual(3)
  })
})

describe('bot healer', () => {
  it('heals a hurt partner', () => {
    const sim = match([bot('tidehorn', 'healer'), human('cindrake', 'dps')], [human('venomaw', 'foe')])
    const [healer, dps, foe] = sim.fighters as [Fighter, Fighter, Fighter]
    place(healer, -8, 0)
    place(dps, 0, 0)
    place(foe, 26, 0)
    dps.hp = 400
    run(sim, 60 * 3)
    expect(dps.hp).toBeGreaterThan(600)
  })

  it('dispels sleep off its partner', () => {
    const sim = match([bot('petalyn', 'healer'), human('cindrake', 'dps')], [human('lumora', 'foe')])
    const [healer, dps, foe] = sim.fighters as [Fighter, Fighter, Fighter]
    place(healer, -8, 0)
    place(dps, 0, 0)
    place(foe, 26, 0)
    applyAura(sim, foe, dps, getAura('hypnosis'), 1)
    run(sim, 60)
    expect(dps.auras.some((a) => a.def.id === 'hypnosis')).toBe(false)
    expect(healer.cooldowns.e).toBeGreaterThan(0)
  })
})

describe('bot crowd control', () => {
  it('trinkets a stun when low', () => {
    const sim = match([bot('cindrake', 'bot')], [human('venomaw', 'foe')])
    const [me, foe] = sim.fighters as [Fighter, Fighter]
    place(me, 0, 0)
    place(foe, 3, 0)
    me.hp = Math.round(me.maxHp * 0.3)
    applyAura(sim, foe, me, getAura('paralysis'), 1)
    run(sim, 40)
    expect(me.auras.some((a) => a.def.id === 'paralysis')).toBe(false)
    expect(me.cooldowns.c).toBeGreaterThan(40)
  })

  it('does not trinket a short stun at full health', () => {
    const sim = match([bot('cindrake', 'bot')], [human('venomaw', 'foe')])
    const [me, foe] = sim.fighters as [Fighter, Fighter]
    place(me, 0, 0)
    place(foe, 20, 0)
    applyAura(sim, foe, me, getAura('paralysis'), 1)
    run(sim, 40)
    expect(me.cooldowns.c).toBe(0)
  })

  it('locks the enemy healer down while its partner is low', () => {
    const sim = match([bot('lumora', 'bot')], [human('tidehorn', 'healer'), human('cindrake', 'dps')])
    const [me, healer, dps] = sim.fighters as [Fighter, Fighter, Fighter]
    place(me, -12, 0)
    place(healer, 6, -4)
    place(dps, 4, 4)
    dps.hp = Math.round(dps.maxHp * 0.35)
    const events = run(sim, 60 * 3)
    const slept = events.some(
      (e) => e.t === 'aura' && e.action === 'apply' && e.dst === healer.id && e.aura === 'hypnosis',
    )
    expect(slept).toBe(true)
  })
})
