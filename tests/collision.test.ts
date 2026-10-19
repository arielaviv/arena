import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { makeRayHit, segmentVsVertical, World } from '../src/shared/sim/collision'
import { Block } from '../src/shared/sim/geometry'
import { ARENA, buildArena, PILLAR_ANGLES } from '../src/shared/sim/layout'
import { buildTraining } from '../src/shared/sim/trainingLayout'

const world = new World(buildArena())

describe('arena layout', () => {
  it('has four pillars evenly spaced around an open centre', () => {
    const pillars = world.prisms.filter((p) => p.tag === 'pillar')
    expect(pillars).toHaveLength(4)
    for (const p of pillars) expect(Math.hypot(p.cx, p.cz)).toBeCloseTo(ARENA.pillarRing, 5)
    expect(world.lineOfSight(-5, 1.5, 0, 5, 1.5, 0)).toBe(true)
  })

  it('has two spawns per team inside the start rooms behind closed gates', () => {
    expect(world.geo.spawns[0]).toHaveLength(2)
    expect(world.geo.spawns[1]).toHaveLength(2)
    expect(world.gatesClosed()).toBe(true)
    const s = world.geo.spawns[1][0]!
    expect(world.lineOfSight(s.x, s.y + 1.6, s.z, 0, 1.6, 0)).toBe(false)
    world.setGates(false)
    expect(world.lineOfSight(s.x, s.y + 1.6, 0, 0, 1.6, 0)).toBe(true)
    world.setGates(true)
  })
})

describe('line of sight', () => {
  it('is blocked by every pillar from both sides', () => {
    for (const a of PILLAR_ANGLES) {
      const c = Math.cos(a)
      const s = Math.sin(a)
      expect(world.lineOfSight(c * 20, 1.5, s * 20, c * 3, 1.5, s * 3)).toBe(false)
      expect(world.lineOfSight(c * 3, 1.5, s * 3, c * 20, 1.5, s * 20)).toBe(false)
    }
  })

  it('low cover hides a sliding target but not a standing one', () => {
    const eye = { x: 0, y: 1.62, z: 28 }
    expect(world.lineOfSight(eye.x, eye.y, eye.z, 0, 0.5, 17.5)).toBe(false)
    expect(world.lineOfSight(eye.x, eye.y, eye.z, 0, 1.2, 17.5)).toBe(true)
  })

  it('works in the training grounds pillar', () => {
    const t = new World(buildTraining())
    expect(t.lineOfSight(2, 1.5, -2, 2, 1.5, -16)).toBe(false)
    expect(t.lineOfSight(-14, 1.5, 0, 10, 1.5, -4)).toBe(true)
  })
})

describe('raycast', () => {
  it('hits the near face of a pillar with an outward normal', () => {
    const angle = PILLAR_ANGLES[0]
    const dirX = Math.cos(angle)
    const dirZ = Math.sin(angle)
    const hit = makeRayHit()
    expect(world.raycast(0, 1.5, 0, dirX, 0, dirZ, 50, Block.Shot, hit)).toBe(true)
    expect(hit.t).toBeCloseTo(ARENA.pillarRing - ARENA.pillarHalf, 4)
    expect(hit.nx * dirX + hit.nz * dirZ).toBeCloseTo(-1, 4)
  })

  it('hits the floor when aiming down', () => {
    const hit = makeRayHit()
    const len = Math.hypot(1, 1)
    expect(world.raycast(0, 2, 0, 1 / len, -1 / len, 0, 50, Block.Shot, hit)).toBe(true)
    expect(hit.prism).toBe(-1)
    expect(hit.ny).toBeCloseTo(1)
    expect(hit.t).toBeCloseTo(2 * len, 4)
  })
})

describe('ground and capsule', () => {
  it('reads floor, ramp and room heights', () => {
    expect(world.groundHeight(0, 0, 10)).toBe(0)
    const rampMid = ARENA.rampStart + ARENA.rampLength / 2
    expect(world.groundHeight(rampMid, 0, 10)).toBeCloseTo(ARENA.roomY / 2, 4)
    expect(world.groundHeight(-rampMid, 0, 10)).toBeCloseTo(ARENA.roomY / 2, 4)
    expect(world.groundHeight(40, 0, 10)).toBeCloseTo(ARENA.roomY, 4)
  })

  it('lets you stand on low cover once above it', () => {
    expect(world.groundHeight(0, ARENA.coverZ, 1.2)).toBeCloseTo(ARENA.coverHeight, 4)
    expect(world.groundHeight(0, ARENA.coverZ, 0.5)).toBe(0)
  })

  it('pushes a capsule out of a pillar corner', () => {
    const p = world.prisms.find((x) => x.tag === 'pillar')!
    // Just inside the corner in local space
    const lx = p.hx - 0.1
    const lz = p.hz - 0.1
    const pos = new Vector3(p.cx + lx * p.cos - lz * p.sin, 0, p.cz + lx * p.sin + lz * p.cos)
    expect(world.resolveCapsule(pos, 0.45, 1.8, 0.45)).toBe(true)
    const rx = (pos.x - p.cx) * p.cos + (pos.z - p.cz) * p.sin
    const rz = -(pos.x - p.cx) * p.sin + (pos.z - p.cz) * p.cos
    const outside = Math.abs(rx) >= p.hx + 0.449 || Math.abs(rz) >= p.hz + 0.449
    expect(outside).toBe(true)
  })

  it('keeps you inside the ring wall', () => {
    const pos = new Vector3(0, 0, ARENA.radius)
    world.resolveCapsule(pos, 0.45, 1.8, 0.45)
    expect(Math.hypot(pos.x, pos.z)).toBeLessThan(ARENA.radius)
  })
})

describe('segment vs vertical capsule axis', () => {
  it('finds the closest approach', () => {
    const c = segmentVsVertical(-5, 1, 0.3, 5, 1, 0.3, 0, 0.45, 1.35, 0)
    expect(c.s).toBeCloseTo(0.5)
    expect(Math.sqrt(c.dist2)).toBeCloseTo(0.3)
  })
})
