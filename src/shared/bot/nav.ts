import { World } from '../sim/collision'
import { MOVE } from '../sim/constants'
import { type Prism, toLocalX, toLocalZ } from '../sim/geometry'

export interface Point {
  x: number
  z: number
}

export interface NavInfo {
  sight: World
  obstacles: readonly Prism[]
  pillars: readonly Prism[]
  spots: readonly Point[] // standing spots hugging the pillars, for cover searches
}

// Clearance used when testing whether a straight walk is blocked, and the
// distance from a face at which we round a corner.
const BLOCK_PAD = MOVE.radius + 0.15
const CORNER_PAD = MOVE.radius + 0.75

const cache = new WeakMap<World, NavInfo>()

// Pillars and low cover are the only things inside the ring. A reduced world
// holding just them answers sight-line questions between two points in the
// ring exactly (the ring wall never sits between them) for a fraction of the
// cost of the full world.
export function navInfo(world: World): NavInfo {
  let info = cache.get(world)
  if (!info) {
    const obstacles = world.prisms.filter((p) => p.tag === 'pillar' || p.tag === 'cover')
    const sight = world.geo.id === 'arena' ? new World({ ...world.geo, prisms: obstacles }) : world
    const pillars = obstacles.filter((p) => p.tag === 'pillar')
    info = { sight, obstacles, pillars, spots: pillarSpots(pillars, 12) }
    cache.set(world, info)
  }
  return info
}

// Entry parameter (0..1) where the segment a->b enters the prism footprint
// grown by `pad`, or -1 when it stays clear. A segment that starts inside and
// heads outward does not count as blocked, so a fighter hugging a wall can
// still walk away from it.
export function segmentHitsPrism(
  p: Prism,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  pad: number,
): number {
  const hx = p.hx + pad
  const hz = p.hz + pad
  const lax = toLocalX(p, ax, az)
  const laz = toLocalZ(p, ax, az)
  const lbx = toLocalX(p, bx, bz)
  const lbz = toLocalZ(p, bx, bz)
  if (Math.abs(lax) <= hx && Math.abs(laz) <= hz) {
    const outA = Math.max(Math.abs(lax) - p.hx, Math.abs(laz) - p.hz)
    const outB = Math.max(Math.abs(lbx) - p.hx, Math.abs(lbz) - p.hz)
    return outB > outA ? -1 : 0
  }
  const dx = lbx - lax
  const dz = lbz - laz
  let t0 = 0
  let t1 = 1
  if (Math.abs(dx) < 1e-9) {
    if (Math.abs(lax) > hx) return -1
  } else {
    const a = (-hx - lax) / dx
    const b = (hx - lax) / dx
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
    if (t0 > t1) return -1
  }
  if (Math.abs(dz) < 1e-9) {
    if (Math.abs(laz) > hz) return -1
  } else {
    const a = (-hz - laz) / dz
    const b = (hz - laz) / dz
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
    if (t0 > t1) return -1
  }
  return t0
}

function firstBlocker(
  obstacles: readonly Prism[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
): Prism | null {
  let best: Prism | null = null
  let bestT = 2
  for (const p of obstacles) {
    const t = segmentHitsPrism(p, ax, az, bx, bz, BLOCK_PAD)
    if (t >= 0 && t < bestT) {
      bestT = t
      best = p
    }
  }
  return best
}

const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

// Where to walk next on the way from a to b: b itself when the way is clear,
// otherwise the corner of the first obstacle in the way that gives the
// shortest detour. Writes the point into `out` and returns the path length.
export function waypoint(nav: NavInfo, ax: number, az: number, bx: number, bz: number, out: Point): number {
  out.x = bx
  out.z = bz
  const p = firstBlocker(nav.obstacles, ax, az, bx, bz)
  if (!p) return Math.hypot(bx - ax, bz - az)
  let best = Number.POSITIVE_INFINITY
  for (const [sx, sz] of CORNERS) {
    const lx = sx * (p.hx + CORNER_PAD)
    const lz = sz * (p.hz + CORNER_PAD)
    const cx = p.cx + lx * p.cos - lz * p.sin
    const cz = p.cz + lx * p.sin + lz * p.cos
    const d1 = Math.hypot(cx - ax, cz - az)
    if (d1 < 0.5) continue
    // Walking along a face is fine (we slide), so only the bare footprint blocks a corner.
    if (segmentHitsPrism(p, ax, az, cx, cz, 0) >= 0) continue
    const cost = d1 + Math.hypot(bx - cx, bz - cz)
    if (cost < best) {
      best = cost
      out.x = cx
      out.z = cz
    }
  }
  return Number.isFinite(best) ? best : Math.hypot(bx - ax, bz - az)
}

function pillarSpots(pillars: readonly Prism[], perPillar: number): Point[] {
  const out: Point[] = []
  for (const p of pillars) {
    const r = Math.hypot(p.hx, p.hz) + MOVE.radius + 0.4
    for (let i = 0; i < perPillar; i++) {
      const a = p.yaw + (i / perPillar) * Math.PI * 2
      out.push({ x: p.cx + Math.cos(a) * r, z: p.cz + Math.sin(a) * r })
    }
  }
  return out
}
