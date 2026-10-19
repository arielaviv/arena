import { describe, expect, it } from 'vitest'
import { BACKFILL_SECONDS, planMatch, type QueuedPlayer, toMatchConfig } from '../src/shared/net/matchmaking'
import { emptyInput } from '../src/shared/sim/fighter'
import { sanitizeInput } from '../src/shared/sim/match'
import { Rng } from '../src/shared/sim/rng'

const player = (id: string, classId: QueuedPlayer['classId'], joinedAt = 0): QueuedPlayer => ({
  id,
  classId,
  name: id,
  difficulty: 0.5,
  joinedAt,
})

describe('matchmaking', () => {
  it('waits for the backfill window when the match is not full', () => {
    expect(planMatch([player('a', 'cindrake')], 1, new Rng(1))).toBeNull()
    const plan = planMatch([player('a', 'cindrake')], BACKFILL_SECONDS + 0.1, new Rng(1))
    expect(plan?.players).toEqual(['a'])
    expect(plan?.slots.filter((s) => s.playerId === null)).toHaveLength(3)
  })

  it('starts immediately with four humans in the right roles', () => {
    const q = [
      player('a', 'cindrake'),
      player('b', 'tidehorn'),
      player('c', 'venomaw'),
      player('d', 'petalyn'),
    ]
    const plan = planMatch(q, 0, new Rng(1))
    expect(plan?.players).toHaveLength(4)
    expect(plan?.slots.every((s) => s.playerId !== null)).toBe(true)
  })

  it('spreads two humans across teams and fills healer and dps slots', () => {
    const plan = planMatch([player('a', 'cindrake'), player('b', 'lumora')], BACKFILL_SECONDS, new Rng(2))
    const humans = plan?.slots.filter((s) => s.playerId) ?? []
    expect(new Set(humans.map((s) => s.team)).size).toBe(2)
    for (const team of [0, 1]) {
      const row = plan?.slots.filter((s) => s.team === team) ?? []
      expect(row.map((s) => s.index).sort()).toEqual([0, 1])
    }
  })

  it('maps players to the fighter ids the sim will assign', () => {
    const plan = planMatch([player('a', 'tidehorn')], BACKFILL_SECONDS, new Rng(3))
    if (!plan) throw new Error('no plan')
    const { config, fighterOf } = toMatchConfig(plan, 7, 3)
    expect(config.teams[0]).toHaveLength(2)
    expect(config.teams[1]).toHaveLength(2)
    expect(fighterOf.get('a')).toBe(1) // healer slot of team 0
  })
})

describe('input sanitizing', () => {
  it('clamps and drops non-finite values', () => {
    const bad = {
      seq: 5,
      moveX: 9,
      moveZ: Number.NaN,
      yaw: Number.POSITIVE_INFINITY,
      pitch: 4,
      buttons: 1 << 20,
    }
    const clean = sanitizeInput(bad, emptyInput())
    expect(clean).not.toBeNull()
    expect(clean?.moveX).toBe(1)
    expect(clean?.moveZ).toBe(0)
    expect(Number.isFinite(clean?.yaw)).toBe(true)
    expect(clean?.pitch).toBeLessThanOrEqual(1.2)
    expect(clean?.buttons).toBe(0)
  })

  it('rejects commands without a valid sequence number', () => {
    expect(sanitizeInput({ ...emptyInput(), seq: Number.NaN }, emptyInput())).toBeNull()
  })
})
