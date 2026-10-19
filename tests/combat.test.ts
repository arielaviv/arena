import { describe, expect, it } from 'vitest'
import { applyAura, dealDamage, updateFighterTimers } from '../src/shared/combat/effects'
import type { SimEvent } from '../src/shared/combat/events'
import { CLASSES, getAura, validateRegistry } from '../src/shared/combat/registry'
import type { ClassId } from '../src/shared/combat/types'
import { aimAtPoint } from '../src/shared/sim/aim'
import { DT } from '../src/shared/sim/constants'
import { chestY, type Fighter } from '../src/shared/sim/fighter'
import { Btn, type InputCmd } from '../src/shared/sim/input'
import { MatchSim } from '../src/shared/sim/match'

function duel(a: ClassId, b: ClassId, seed = 1): { sim: MatchSim; me: Fighter; foe: Fighter } {
  const sim = new MatchSim({
    mode: 'arena',
    seed,
    countdown: 0.05,
    teams: [[{ classId: a, name: 'me', control: 'human' }], [{ classId: b, name: 'foe', control: 'human' }]],
  })
  for (let i = 0; i < 6; i++) sim.step()
  const me = sim.fighters[0]!
  const foe = sim.fighters[1]!
  return { sim, me, foe }
}

let seq = 0
function press(sim: MatchSim, f: Fighter, buttons: number, target?: Fighter): void {
  const aim = { yaw: f.yaw, pitch: f.pitch }
  if (target) aimAtPoint(f, target.pos.x, chestY(target), target.pos.z, aim)
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

function place(f: Fighter, x: number, z: number): void {
  f.pos.set(x, 0, z)
  f.vel.set(0, 0, 0)
}

describe('registry', () => {
  it('every referenced aura exists', () => {
    expect(validateRegistry()).toEqual([])
  })
})

describe('auras', () => {
  it('sleep breaks on damage', () => {
    const { sim, me, foe } = duel('lumora', 'cindrake')
    applyAura(sim, me, foe, getAura('hypnosis'), 1)
    expect(foe.auras.some((a) => a.def.id === 'hypnosis')).toBe(true)
    dealDamage(sim, me, foe, 10, 'test', false)
    expect(foe.auras.some((a) => a.def.id === 'hypnosis')).toBe(false)
  })

  it('stuns diminish 100 / 50 / 25 / immune', () => {
    const { sim, me, foe } = duel('venomaw', 'cindrake')
    const durations: number[] = []
    for (let i = 0; i < 4; i++) {
      applyAura(sim, me, foe, getAura('paralysis'), 1)
      const a = foe.auras.find((x) => x.def.id === 'paralysis')
      durations.push(a ? a.remaining : 0)
      foe.auras.length = 0
    }
    expect(durations).toEqual([1.5, 0.75, 0.375, 0])
  })

  it('diminishing returns reset after 15 s', () => {
    const { sim, me, foe } = duel('venomaw', 'cindrake')
    applyAura(sim, me, foe, getAura('paralysis'), 1)
    foe.auras.length = 0
    for (let i = 0; i < 60 * 17; i++) updateFighterTimers(sim, foe, DT)
    expect(foe.dr.stun.level).toBe(0)
  })

  it('bleed ticks double while the target moves', () => {
    const still = duel('venomaw', 'cindrake')
    const moving = duel('venomaw', 'cindrake')
    for (const [ctx, isMoving] of [
      [still, false],
      [moving, true],
    ] as const) {
      applyAura(ctx.sim, ctx.me, ctx.foe, getAura('bleed'), 1)
      ctx.foe.hp = 5000
      ctx.foe.maxHp = 5000
      for (let i = 0; i < 60 * 3; i++) {
        ctx.foe.moving = isMoving
        updateFighterTimers(ctx.sim, ctx.foe, DT)
      }
    }
    const stillLost = 5000 - still.foe.hp
    const movingLost = 5000 - moving.foe.hp
    expect(movingLost).toBe(stillLost * 2)
  })

  it('poison stacks to five', () => {
    const { sim, me, foe } = duel('venomaw', 'cindrake')
    for (let i = 0; i < 8; i++) applyAura(sim, me, foe, getAura('poison'), 1)
    expect(foe.auras.find((a) => a.def.id === 'poison')?.stacks).toBe(5)
  })

  it('Lum Berry clears crowd control', () => {
    const { sim, me, foe } = duel('cindrake', 'venomaw')
    applyAura(sim, foe, me, getAura('paralysis'), 1)
    press(sim, me, Btn.C)
    run(sim, 2)
    expect(me.auras.some((a) => a.def.cc)).toBe(false)
    expect(me.cooldowns.c).toBeGreaterThan(40)
  })
})

describe('casting', () => {
  it('a targeted cast fails if line of sight is lost when it finishes', () => {
    const { sim, me, foe } = duel('lumora', 'cindrake')
    place(me, -6, 0)
    place(foe, 6, 0)
    press(sim, me, Btn.Rmb, foe)
    run(sim, 2)
    expect(me.cast?.ability.id).toBe('hypnosis')
    press(sim, me, 0, foe)
    // Hide the target behind the north-east pillar.
    place(foe, 13, 13)
    const events = run(sim, 100)
    const failed = events.find((e) => e.t === 'cast' && e.action === 'fail' && e.reason === 'los')
    expect(failed).toBeDefined()
    expect(foe.auras.some((a) => a.def.id === 'hypnosis')).toBe(false)
  })

  it('moving cancels a cast', () => {
    const { sim, me, foe } = duel('cindrake', 'tidehorn')
    place(me, -6, 0)
    place(foe, 6, 0)
    press(sim, me, Btn.Rmb, foe)
    run(sim, 3)
    expect(me.cast).not.toBeNull()
    sim.setInput(me.id, { seq: ++seq, moveX: 0, moveZ: 1, yaw: me.yaw, pitch: me.pitch, buttons: 0 })
    run(sim, 2)
    expect(me.cast).toBeNull()
  })

  it('an interrupt stops the cast and locks out casting', () => {
    const { sim, me, foe } = duel('lumora', 'cindrake')
    place(me, -6, 0)
    place(foe, 6, 0)
    press(sim, foe, Btn.Rmb, me)
    run(sim, 10)
    expect(foe.cast?.ability.id).toBe('fire-blast')
    press(sim, me, Btn.F, foe)
    const events = run(sim, 2)
    expect(events.some((e) => e.t === 'interrupt' && e.dst === foe.id)).toBe(true)
    expect(foe.cast).toBeNull()
    expect(foe.lockout).toBeGreaterThan(2.5)
    press(sim, foe, Btn.Rmb, me)
    run(sim, 3)
    expect(foe.cast).toBeNull()
  })

  it('Ember burns on every third hit', () => {
    const { sim, me, foe } = duel('cindrake', 'tidehorn')
    place(me, -4, 0)
    place(foe, 4, 0)
    let burned = false
    for (let i = 0; i < 3; i++) {
      press(sim, me, Btn.Lmb, foe)
      run(sim, 1)
      press(sim, me, 0, foe)
      run(sim, 30)
    }
    burned = foe.auras.some((a) => a.def.id === 'burn')
    expect(burned).toBe(true)
  })

  it('healers heal an ally under the crosshair', () => {
    const sim = new MatchSim({
      mode: 'arena',
      seed: 3,
      countdown: 0.05,
      teams: [
        [
          { classId: 'tidehorn', name: 'healer', control: 'human' },
          { classId: 'cindrake', name: 'dps', control: 'human' },
        ],
        [{ classId: 'venomaw', name: 'foe', control: 'human' }],
      ],
    })
    run(sim, 6)
    const [healer, dps] = sim.fighters as [Fighter, Fighter]
    place(healer, -6, 0)
    place(dps, 4, 0)
    dps.hp = 400
    press(sim, healer, Btn.Rmb, dps)
    run(sim, 2)
    press(sim, healer, 0, dps)
    run(sim, 110)
    const heal = CLASSES.tidehorn.abilities.rmb.effects.find((e) => e.kind === 'heal')
    expect(dps.hp).toBe(400 + (heal?.kind === 'heal' ? heal.amount : 0))
  })
})

describe('determinism', () => {
  function hashSim(sim: MatchSim): number {
    let h = 0
    for (const f of sim.fighters) {
      h = (h * 31 + Math.round(f.pos.x * 1000)) | 0
      h = (h * 31 + Math.round(f.pos.z * 1000)) | 0
      h = (h * 31 + f.hp) | 0
      h = (h * 31 + f.auras.length) | 0
    }
    return (h * 31 + sim.rng.getState()) | 0
  }

  it('same seed and inputs give the same state', () => {
    const make = () =>
      new MatchSim({
        mode: 'arena',
        seed: 42,
        countdown: 0.5,
        teams: [
          [
            { classId: 'cindrake', name: 'a', control: 'bot' },
            { classId: 'tidehorn', name: 'b', control: 'bot' },
          ],
          [
            { classId: 'venomaw', name: 'c', control: 'bot' },
            { classId: 'petalyn', name: 'd', control: 'bot' },
          ],
        ],
      })
    const a = make()
    const b = make()
    for (let i = 0; i < 60 * 30; i++) {
      a.step()
      b.step()
    }
    expect(hashSim(a)).toBe(hashSim(b))
  })
})
