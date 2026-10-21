import { type PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three'
import { makeRayHit, type World } from '../shared/sim/collision'
import { Block } from '../shared/sim/geometry'

// A fighter as the client sees it this frame (rendered position).
export interface Unit {
  id: number
  team: 0 | 1
  x: number
  y: number
  z: number
  height: number
  alive: boolean
}

const v = new Vector3()
const ray = new Raycaster()
const ndc = new Vector2()
const hit = makeRayHit()
const TAB_RANGE = 45
const AUTO_RANGE = 40
const AUTO_ANGLE = 0.7

function toScreen(x: number, y: number, z: number, cam: PerspectiveCamera): { x: number; y: number } | null {
  v.set(x, y, z).project(cam)
  if (v.z < -1 || v.z > 1) return null
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight }
}

// Classic controls: who you have selected, who your heals go to, and
// whether your primary auto-repeats on the target.
export class Targeting {
  target = -1
  ally = -1
  hover = -1
  auto = false

  // The unit drawn under a screen point, nearest the camera first.
  pick(units: readonly Unit[], sx: number, sy: number, cam: PerspectiveCamera): number {
    let best = -1
    let bestDepth = Number.POSITIVE_INFINITY
    for (const u of units) {
      if (!u.alive) continue
      const feet = toScreen(u.x, u.y, u.z, cam)
      const head = toScreen(u.x, u.y + u.height + 0.25, u.z, cam)
      if (!feet || !head) continue
      const tall = Math.max(10, feet.y - head.y)
      const half = Math.max(16, tall * 0.34)
      const cx = (feet.x + head.x) / 2
      if (Math.abs(sx - cx) > half || sy < head.y - 8 || sy > feet.y + 8) continue
      const depth = cam.position.distanceToSquared(v.set(u.x, u.y, u.z))
      if (depth < bestDepth) {
        bestDepth = depth
        best = u.id
      }
    }
    return best
  }

  // Tab: the next enemy in front of the camera, nearest first.
  next(units: readonly Unit[], me: Unit, cam: PerspectiveCamera): number {
    const list = this.inFront(units, me, cam, TAB_RANGE, 0.2).sort((a, b) => a.dist - b.dist)
    if (list.length === 0) return this.target
    const i = list.findIndex((c) => c.u.id === this.target)
    return list[(i + 1) % list.length]?.u.id ?? -1
  }

  // Casting with nothing selected picks the enemy nearest the screen centre.
  acquire(units: readonly Unit[], me: Unit, cam: PerspectiveCamera, sees: (u: Unit) => boolean): number {
    let best = -1
    let bestScore = Number.POSITIVE_INFINITY
    for (const c of this.inFront(units, me, cam, AUTO_RANGE, Math.cos(AUTO_ANGLE))) {
      if (!sees(c.u)) continue
      const score = Math.acos(Math.min(1, c.dot)) + c.dist * 0.01
      if (score < bestScore) {
        bestScore = score
        best = c.u.id
      }
    }
    return best
  }

  private inFront(
    units: readonly Unit[],
    me: Unit,
    cam: PerspectiveCamera,
    range: number,
    minDot: number,
  ): Array<{ u: Unit; dist: number; dot: number }> {
    cam.getWorldDirection(v)
    const fx = v.x
    const fz = v.z
    const fl = Math.hypot(fx, fz) || 1
    const out: Array<{ u: Unit; dist: number; dot: number }> = []
    for (const u of units) {
      if (!u.alive || u.team === me.team) continue
      const dx = u.x - me.x
      const dz = u.z - me.z
      const dist = Math.hypot(dx, dz)
      if (dist > range) continue
      const dot = dist < 1e-3 ? 1 : (dx * fx + dz * fz) / (dist * fl)
      if (dot < minDot) continue
      out.push({ u, dist, dot })
    }
    return out
  }

  // World point under the cursor, for spells cast at the cursor.
  ground(sx: number, sy: number, cam: PerspectiveCamera, world: World): Vector3 | null {
    ndc.set((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1)
    ray.setFromCamera(ndc, cam)
    const o = ray.ray.origin
    const d = ray.ray.direction
    if (!world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 140, Block.Shot, hit)) return null
    return v.set(o.x + d.x * hit.t, o.y + d.y * hit.t, o.z + d.z * hit.t)
  }
}
