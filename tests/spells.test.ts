import { describe, expect, it } from 'vitest'
import { applyAura, dealDamage } from '../src/shared/combat/effects'
import type { SimEvent } from '../src/shared/combat/events'
import { getAura } from '../src/shared/combat/registry'
import type { ClassId } from '../src/shared/combat/types'
import { aimAtPoint } from '../src/shared/sim/aim'
import { chestY, type Fighter, findAura } from '../src/shared/sim/fighter'
import { Btn, type InputCmd } from '../src/shared/sim/input'
import { MatchSim } from '../src/shared/sim/match'

function duel(a: ClassId, b: ClassId): { sim: MatchSim; me: Fighter; foe: Fighter } {
  const sim = new MatchSim({
    mode: 'arena',
    seed: 7,
    countdown: 0.05,
    teams: [[{ classId: a, name: 'me', control: 'human' }], [{ classId: b, name: 'foe', control: 'human' }]],
  })
  for (let i = 0; i < 6; i++) sim.step()
  return { sim, me: sim.fighters[0]!, foe: sim.fighters[1]! }
}

let seq = 0
interface Press {
  target?: Fighter // selected enemy (tab target)
  aimAt?: Fighter // crosshair on this fighter
  yaw?: number
  ground?: { x: number; z: number }
}

function press(sim: MatchSim, f: Fighter, buttons: number, o: Press = {}): void {
  const aim = { yaw: o.yaw ?? f.yaw, pitch: 0 }
  if (o.aimAt) aimAtPoint(f, o.aimAt.pos.x, chestY(o.aimAt), o.aimAt.pos.z, aim)
  const cmd: InputCmd = { seq: ++seq, moveX: 0, moveZ: 0, yaw: aim.yaw, pitch: aim.pitch, buttons }
  if (o.target) cmd.target = o.target.id
  if (o.ground) {
    cmd.aimX = o.ground.x
    cmd.aimY = 0
    cmd.aimZ = o.ground.z
  }
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

function tap(sim: MatchSim, f: Fighter, buttons: number, o: Press = {}, after = 2): SimEvent[] {
  press(sim, f, buttons, o)
  const ev = run(sim, 1)
  press(sim, f, 0, { ...o, ground: undefined })
  return [...ev, ...run(sim, after)]
}

function damageFrom(events: SimEvent[], ability: string): number {
  let n = 0
  for (const e of events) if (e.t === 'damage' && e.ability === ability) n += e.amount
  return n
}

describe('tab targeting', () => {
  it('a shot at the selected target homes in even when aimed away', () => {
    const { sim, me, foe } = duel('cindrake', 'tidehorn')
    place(me, -6, 0)
    place(foe, 6, 0)
    const events = tap(sim, me, Btn.Lmb, { target: foe, yaw: Math.PI / 2 }, 40)
    expect(damageFrom(events, 'ember')).toBeGreaterThan(0)
    expect(me.target).toBe(foe.id)
  })

  it('a selected target behind a pillar fails with line of sight and costs nothing', () => {
    const { sim, me, foe } = duel('cindrake', 'tidehorn')
    place(me, -6, 0)
    place(foe, 13, 13)
    const mana = me.resource
    const events = tap(sim, me, Btn.A1, { target: foe })
    expect(events.some((e) => e.t === 'cast' && e.action === 'fail' && e.reason === 'los')).toBe(true)
    expect(me.resource).toBe(mana)
    expect(me.cooldowns.a1).toBe(0)
  })

  it('with nothing selected, the enemy under the crosshair becomes the target', () => {
    const { sim, me, foe } = duel('cindrake', 'tidehorn')
    place(me, -6, 0)
    place(foe, 6, 0)
    tap(sim, me, Btn.A1, { aimAt: foe })
    expect(me.target).toBe(foe.id)
    expect(findAura(foe, 'will-o-wisp')).toBeDefined()
  })
})

describe('new spells', () => {
  it('three Embers of Heat make Fire Blast instant', () => {
    const { sim, me, foe } = duel('cindrake', 'tidehorn')
    place(me, -6, 0)
    place(foe, 6, 0)
    for (let i = 0; i < 3; i++) tap(sim, me, Btn.Lmb, { target: foe }, 30)
    expect(findAura(me, 'heat')?.stacks).toBe(3)
    const events = tap(sim, me, Btn.Rmb, { target: foe })
    expect(me.cast).toBeNull()
    expect(damageFrom(events, 'fire-blast')).toBeGreaterThan(0)
    expect(findAura(me, 'heat')).toBeUndefined()
  })

  it('Magic Coat bounces a Fire Blast back at its caster', () => {
    const { sim, me, foe } = duel('lumora', 'cindrake')
    place(me, -6, 0)
    place(foe, 6, 0)
    tap(sim, me, Btn.A1)
    expect(findAura(me, 'magic-coat')).toBeDefined()
    press(sim, foe, Btn.Rmb, { target: me })
    const events = run(sim, 100)
    expect(events.some((e) => e.t === 'reflect')).toBe(true)
    expect(me.hp).toBe(me.maxHp)
    expect(foe.hp).toBeLessThan(foe.maxHp)
  })

  it('Withdraw makes you immune but unable to act', () => {
    const { sim, me, foe } = duel('tidehorn', 'cindrake')
    tap(sim, me, Btn.A3)
    expect(dealDamage(sim, foe, me, 200, 'test', false)).toBe(0)
    expect(me.hp).toBe(me.maxHp)
    const events = tap(sim, me, Btn.Lmb, { target: foe })
    expect(events.some((e) => e.t === 'cast' && e.action === 'fail' && e.reason === 'cc')).toBe(true)
  })

  it('Spiky Shield spikes melee attackers only', () => {
    const { sim, me, foe } = duel('petalyn', 'venomaw')
    place(me, 0, 0)
    place(foe, 2, 0)
    tap(sim, me, Btn.A3)
    expect(findAura(me, 'spiky-shield')).toBeDefined()
    const before = foe.hp
    dealDamage(sim, foe, me, 50, 'poison-jab', false)
    expect(foe.hp).toBe(before - 35)
    place(foe, 12, 0)
    dealDamage(sim, foe, me, 50, 'test', false)
    expect(foe.hp).toBe(before - 35)
  })

  it('Leech Seed heals the caster', () => {
    const { sim, me, foe } = duel('petalyn', 'cindrake')
    place(me, -6, 0)
    place(foe, 6, 0)
    me.hp = 800
    tap(sim, me, Btn.A1, { target: foe }, 200)
    expect(me.hp).toBeGreaterThan(800)
    expect(foe.hp).toBeLessThan(foe.maxHp)
  })

  it('Venoshock spends poison stacks for bonus damage', () => {
    const { sim, me, foe } = duel('venomaw', 'tidehorn')
    place(me, 0, 0)
    place(foe, 2, 0)
    applyAura(sim, me, foe, getAura('poison'), 5)
    const events = tap(sim, me, Btn.A1, { target: foe })
    expect(damageFrom(events, 'venoshock')).toBe(40 + 30 * 5)
    expect(findAura(foe, 'poison')).toBeUndefined()
  })

  it('Dream Eater triples on a sleeping target and drains', () => {
    const { sim, me, foe } = duel('lumora', 'cindrake')
    place(me, -6, 0)
    place(foe, 6, 0)
    me.hp = 600
    applyAura(sim, me, foe, getAura('hypnosis'), 1)
    const events = tap(sim, me, Btn.A2, { target: foe })
    expect(damageFrom(events, 'dream-eater')).toBe(270)
    expect(me.hp).toBe(600 + 135)
  })

  it('Shadow Sneak appears behind the target', () => {
    const { sim, me, foe } = duel('venomaw', 'cindrake')
    place(me, -6, 0)
    place(foe, 6, 0)
    press(sim, foe, 0, { yaw: Math.PI })
    run(sim, 2)
    tap(sim, me, Btn.A3, { target: foe }, 1)
    expect(me.pos.x).toBeGreaterThan(foe.pos.x)
    expect(Math.hypot(me.pos.x - foe.pos.x, me.pos.z - foe.pos.z)).toBeLessThan(2)
  })

  it('enemies inside Smokescreen cannot target past 6 m', () => {
    const { sim, me, foe } = duel('venomaw', 'lumora')
    place(me, -6, 0)
    place(foe, 6, 0)
    tap(sim, me, Btn.A2, { ground: { x: 6, z: 0 } }, 3)
    expect(findAura(foe, 'smokescreen')).toBeDefined()
    const events = tap(sim, foe, Btn.Rmb, { target: me })
    expect(events.some((e) => e.t === 'cast' && e.action === 'fail' && e.reason === 'los')).toBe(true)
  })
})
