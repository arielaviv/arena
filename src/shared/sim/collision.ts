import type { Vector3 } from 'three'
import { Block, type Prism, type Surface, toLocalX, toLocalZ, type WorldGeometry } from './geometry'

export interface RayHit {
  t: number
  nx: number
  ny: number
  nz: number
  prism: number // -1 when the ground was hit
}

export function makeRayHit(): RayHit {
  return { t: 0, nx: 0, ny: 1, nz: 0, prism: -1 }
}

const scratchHit = makeRayHit()
const EPS = 1e-9

export class World {
  readonly geo: WorldGeometry
  readonly prisms: Prism[]
  readonly surfaces: Surface[]

  constructor(geo: WorldGeometry) {
    this.geo = geo
    this.prisms = geo.prisms.map((p) => ({ ...p }))
    this.surfaces = geo.surfaces
  }

  setGates(closed: boolean): void {
    for (const p of this.prisms) if (p.tag === 'gate') p.enabled = closed
  }

  gatesClosed(): boolean {
    for (const p of this.prisms) if (p.tag === 'gate') return p.enabled
    return false
  }

  // Height of one walkable surface at (x, z), or NaN when outside its footprint.
  surfaceHeight(s: Surface, x: number, z: number): number {
    if (s.kind === 'disc') {
      const dx = x - s.cx
      const dz = z - s.cz
      return dx * dx + dz * dz <= s.r * s.r ? s.y : Number.NaN
    }
    const lx = toLocalX(s, x, z)
    const lz = toLocalZ(s, x, z)
    if (Math.abs(lx) > s.hx || Math.abs(lz) > s.hz) return Number.NaN
    if (s.kind === 'flat') return s.y
    return s.yLow + ((lx + s.hx) / (2 * s.hx)) * (s.yHigh - s.yLow)
  }

  // Highest walkable height at (x, z) that is not above maxY. -Infinity if none.
  groundHeight(x: number, z: number, maxY: number): number {
    let best = Number.NEGATIVE_INFINITY
    for (const s of this.surfaces) {
      const h = this.surfaceHeight(s, x, z)
      if (!Number.isNaN(h) && h <= maxY && h > best) best = h
    }
    for (const p of this.prisms) {
      if (!p.enabled || (p.mask & Block.Move) === 0 || p.tag === 'barrier') continue
      if (p.y1 > maxY || p.y1 <= best) continue
      const lx = toLocalX(p, x, z)
      const lz = toLocalZ(p, x, z)
      if (Math.abs(lx) <= p.hx + 0.15 && Math.abs(lz) <= p.hz + 0.15) best = p.y1
    }
    return best
  }

  // Push a vertical capsule (pos = feet centre) out of every blocking prism.
  // Prisms whose top is within `step` of the feet count as floor, not wall.
  resolveCapsule(pos: Vector3, radius: number, height: number, step: number): boolean {
    let hit = false
    for (let iter = 0; iter < 3; iter++) {
      let moved = false
      for (const p of this.prisms) {
        if (!p.enabled || (p.mask & Block.Move) === 0) continue
        if (p.y1 <= pos.y + step || p.y0 >= pos.y + height) continue
        const lx = toLocalX(p, pos.x, pos.z)
        const lz = toLocalZ(p, pos.x, pos.z)
        const cx = lx < -p.hx ? -p.hx : lx > p.hx ? p.hx : lx
        const cz = lz < -p.hz ? -p.hz : lz > p.hz ? p.hz : lz
        let dx = lx - cx
        let dz = lz - cz
        const d2 = dx * dx + dz * dz
        if (d2 >= radius * radius) continue
        let push: number
        if (d2 > EPS) {
          const d = Math.sqrt(d2)
          push = radius - d
          dx /= d
          dz /= d
        } else {
          const px = p.hx - Math.abs(lx)
          const pz = p.hz - Math.abs(lz)
          if (px < pz) {
            dx = lx >= 0 ? 1 : -1
            dz = 0
            push = px + radius
          } else {
            dx = 0
            dz = lz >= 0 ? 1 : -1
            push = pz + radius
          }
        }
        // Back to world space
        pos.x += (dx * p.cos - dz * p.sin) * push
        pos.z += (dx * p.sin + dz * p.cos) * push
        moved = true
        hit = true
      }
      if (!moved) break
    }
    return hit
  }

  // Ray against prisms matching `mask`. Direction must be normalised.
  raycastPrisms(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
    mask: number,
    out: RayHit,
  ): boolean {
    let found = false
    let best = maxT
    for (const p of this.prisms) {
      if (!p.enabled || (p.mask & mask) === 0) continue
      if (rayPrism(p, ox, oy, oz, dx, dy, dz, best, scratchHit)) {
        best = scratchHit.t
        out.t = scratchHit.t
        out.nx = scratchHit.nx
        out.ny = scratchHit.ny
        out.nz = scratchHit.nz
        out.prism = p.id
        found = true
      }
    }
    return found
  }

  raycastGround(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
    out: RayHit,
  ): boolean {
    let found = false
    let best = maxT
    for (const s of this.surfaces) {
      let t: number
      let nx = 0
      let ny = 1
      let nz = 0
      if (s.kind === 'ramp') {
        const slope = (s.yHigh - s.yLow) / (2 * s.hx)
        const lox = toLocalX(s, ox, oz)
        const ldx = dx * s.cos + dz * s.sin
        const denom = dy - ldx * slope
        if (Math.abs(denom) < EPS) continue
        t = (s.yLow + (lox + s.hx) * slope - oy) / denom
        const inv = 1 / Math.sqrt(slope * slope + 1)
        // local normal (-slope, 1, 0) back to world
        nx = -slope * inv * s.cos
        ny = inv
        nz = -slope * inv * s.sin
      } else {
        if (dy > -EPS) continue
        t = (s.y - oy) / dy
      }
      if (t < 0 || t >= best) continue
      const h = this.surfaceHeight(s, ox + dx * t, oz + dz * t)
      if (Number.isNaN(h)) continue
      best = t
      out.t = t
      out.nx = nx
      out.ny = ny
      out.nz = nz
      out.prism = -1
      found = true
    }
    return found
  }

  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
    mask: number,
    out: RayHit,
  ): boolean {
    const a = this.raycastPrisms(ox, oy, oz, dx, dy, dz, maxT, mask, out)
    const limit = a ? out.t : maxT
    const b = this.raycastGround(ox, oy, oz, dx, dy, dz, limit, out)
    return a || b
  }

  // True when nothing that blocks line of sight sits between a and b.
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < EPS) return true
    return !this.raycastPrisms(ax, ay, az, dx / len, dy / len, dz / len, len, Block.Los, scratchHit)
  }
}

function rayPrism(
  p: Prism,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: RayHit,
): boolean {
  const lo0 = toLocalX(p, ox, oz)
  const lo2 = toLocalZ(p, ox, oz)
  const ld0 = dx * p.cos + dz * p.sin
  const ld2 = -dx * p.sin + dz * p.cos
  let tmin = 0
  let tmax = maxT
  let axis = -1
  let sign = 0

  // x slab
  if (Math.abs(ld0) < EPS) {
    if (lo0 < -p.hx || lo0 > p.hx) return false
  } else {
    const inv = 1 / ld0
    let t1 = (-p.hx - lo0) * inv
    let t2 = (p.hx - lo0) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    if (t1 > tmin) {
      tmin = t1
      axis = 0
      sign = ld0 > 0 ? -1 : 1
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return false
  }
  // y slab
  if (Math.abs(dy) < EPS) {
    if (oy < p.y0 || oy > p.y1) return false
  } else {
    const inv = 1 / dy
    let t1 = (p.y0 - oy) * inv
    let t2 = (p.y1 - oy) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    if (t1 > tmin) {
      tmin = t1
      axis = 1
      sign = dy > 0 ? -1 : 1
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return false
  }
  // z slab
  if (Math.abs(ld2) < EPS) {
    if (lo2 < -p.hz || lo2 > p.hz) return false
  } else {
    const inv = 1 / ld2
    let t1 = (-p.hz - lo2) * inv
    let t2 = (p.hz - lo2) * inv
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    if (t1 > tmin) {
      tmin = t1
      axis = 2
      sign = ld2 > 0 ? -1 : 1
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return false
  }

  out.t = tmin
  if (axis === 0) {
    out.nx = sign * p.cos
    out.ny = 0
    out.nz = sign * p.sin
  } else if (axis === 1) {
    out.nx = 0
    out.ny = sign
    out.nz = 0
  } else if (axis === 2) {
    out.nx = -sign * p.sin
    out.ny = 0
    out.nz = sign * p.cos
  } else {
    // Started inside: report an immediate hit facing back along the ray.
    out.nx = -dx
    out.ny = -dy
    out.nz = -dz
  }
  out.prism = p.id
  return true
}

export interface SegmentClosest {
  s: number
  t: number
  dist2: number
}

const closest: SegmentClosest = { s: 0, t: 0, dist2: 0 }

// Closest points between segment P = p0 + s*(p1 - p0) and the vertical segment
// Q = (qx, qy0, qz) .. (qx, qy1, qz). Returns a shared scratch object.
export function segmentVsVertical(
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  qx: number,
  qy0: number,
  qy1: number,
  qz: number,
): SegmentClosest {
  const d1x = p1x - p0x
  const d1y = p1y - p0y
  const d1z = p1z - p0z
  const d2y = qy1 - qy0
  const rx = p0x - qx
  const ry = p0y - qy0
  const rz = p0z - qz
  const a = d1x * d1x + d1y * d1y + d1z * d1z
  const e = d2y * d2y
  const f = d2y * ry
  let s = 0
  let t = 0
  if (a <= EPS && e <= EPS) {
    s = 0
    t = 0
  } else if (a <= EPS) {
    s = 0
    t = clamp01(f / e)
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz
    if (e <= EPS) {
      t = 0
      s = clamp01(-c / a)
    } else {
      const b = d1y * d2y
      const denom = a * e - b * b
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }
  const cx = p0x + d1x * s - qx
  const cy = p0y + d1y * s - (qy0 + d2y * t)
  const cz = p0z + d1z * s - qz
  closest.s = s
  closest.t = t
  closest.dist2 = cx * cx + cy * cy + cz * cz
  return closest
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
