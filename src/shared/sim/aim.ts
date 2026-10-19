import { Vector3 } from 'three'
import { makeRayHit, segmentVsVertical, type World } from './collision'
import { CAMERA, MOVE } from './constants'
import { chestY, type Fighter, hurtHeight } from './fighter'
import { Block } from './geometry'

export interface Aim {
  ox: number
  oy: number
  oz: number
  dx: number
  dy: number
  dz: number
  px: number // aim point
  py: number
  pz: number
  dist: number
  fighter: number // fighter under the crosshair, -1 if none
}

export function makeAim(): Aim {
  return { ox: 0, oy: 0, oz: 0, dx: 1, dy: 0, dz: 0, px: 0, py: 0, pz: 0, dist: 0, fighter: -1 }
}

const hit = makeRayHit()
const MAX_AIM = 140

// Canonical camera pivot height for a fighter (drops while sliding).
export function pivotY(f: Fighter): number {
  return f.pos.y + CAMERA.height - (f.move === 'slide' ? CAMERA.slideDrop : 0)
}

export function aimDirection(yaw: number, pitch: number, out: Vector3): Vector3 {
  const cp = Math.cos(pitch)
  return out.set(cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw))
}

// Where the fighter's crosshair points: a ray from the canonical over-the-
// shoulder camera, started level with the fighter so geometry behind them
// never blocks their aim.
export function computeAim(f: Fighter, world: World, fighters: readonly Fighter[], out: Aim): Aim {
  const cp = Math.cos(f.pitch)
  const dx = cp * Math.cos(f.yaw)
  const dy = Math.sin(f.pitch)
  const dz = cp * Math.sin(f.yaw)
  // right = (-sin, 0, cos)
  const rx = -Math.sin(f.yaw)
  const rz = Math.cos(f.yaw)
  const py = pivotY(f)
  let ox = f.pos.x - dx * CAMERA.distance + rx * CAMERA.shoulder
  let oy = py - dy * CAMERA.distance
  let oz = f.pos.z - dz * CAMERA.distance + rz * CAMERA.shoulder
  const t0 = Math.max(0, (f.pos.x - ox) * dx + (py - oy) * dy + (f.pos.z - oz) * dz)
  ox += dx * t0
  oy += dy * t0
  oz += dz * t0

  let best = MAX_AIM
  let target = -1
  if (world.raycast(ox, oy, oz, dx, dy, dz, MAX_AIM, Block.Shot, hit)) best = hit.t
  const ex = ox + dx * best
  const ey = oy + dy * best
  const ez = oz + dz * best
  for (const g of fighters) {
    if (g === f || !g.alive) continue
    const c = segmentVsVertical(
      ox,
      oy,
      oz,
      ex,
      ey,
      ez,
      g.pos.x,
      g.pos.y + MOVE.radius,
      g.pos.y + hurtHeight(g) - MOVE.radius,
      g.pos.z,
    )
    if (c.dist2 <= MOVE.radius * MOVE.radius) {
      const t = c.s * best
      if (t < best) {
        best = t
        target = g.id
      }
    }
  }

  out.ox = ox
  out.oy = oy
  out.oz = oz
  out.dx = dx
  out.dy = dy
  out.dz = dz
  out.dist = best
  out.px = ox + dx * best
  out.py = oy + dy * best
  out.pz = oz + dz * best
  out.fighter = target
  return out
}

// Best fighter inside an aim cone (for targeted spells): closest to the ray,
// within range, with line of sight from the caster's eye.
export function coneTarget(
  f: Fighter,
  aim: Aim,
  world: World,
  fighters: readonly Fighter[],
  range: number,
  maxAngle: number,
  wantAlly: boolean,
  includeSelf: boolean,
): Fighter | null {
  let best: Fighter | null = null
  let bestScore = Number.POSITIVE_INFINITY
  const eyeY = f.pos.y + 1.5
  for (const g of fighters) {
    if (!g.alive) continue
    if (g === f) continue
    const ally = g.team === f.team
    if (ally !== wantAlly) continue
    const cy = chestY(g)
    const vx = g.pos.x - aim.ox
    const vy = cy - aim.oy
    const vz = g.pos.z - aim.oz
    const along = vx * aim.dx + vy * aim.dy + vz * aim.dz
    if (along <= 0) continue
    const vl = Math.sqrt(vx * vx + vy * vy + vz * vz)
    const angle = Math.acos(Math.min(1, along / vl))
    if (angle > maxAngle && aim.fighter !== g.id) continue
    const dist = Math.hypot(g.pos.x - f.pos.x, g.pos.z - f.pos.z)
    if (dist > range) continue
    if (!world.lineOfSight(f.pos.x, eyeY, f.pos.z, g.pos.x, cy, g.pos.z)) continue
    const score = aim.fighter === g.id ? -1 : angle
    if (score < bestScore) {
      bestScore = score
      best = g
    }
  }
  if (!best && includeSelf && wantAlly) return f
  return best
}

const tmp = new Vector3()

// Spawn point for projectiles: the caster's casting hand.
export function handPosition(f: Fighter, out: Vector3): Vector3 {
  const rx = -Math.sin(f.yaw)
  const rz = Math.cos(f.yaw)
  aimDirection(f.yaw, 0, tmp)
  return out.set(
    f.pos.x + rx * 0.4 + tmp.x * 0.5,
    f.pos.y + hurtHeight(f) * 0.7,
    f.pos.z + rz * 0.4 + tmp.z * 0.5,
  )
}

// Yaw/pitch that put the canonical over-the-shoulder crosshair on a point.
// Bots and dummies aim with this, so they press the same inputs a human would.
export function aimAtPoint(
  f: Fighter,
  tx: number,
  ty: number,
  tz: number,
  out: { yaw: number; pitch: number },
): void {
  const dx = tx - f.pos.x
  const dz = tz - f.pos.z
  const dh = Math.max(0.5, Math.hypot(dx, dz))
  const s = Math.min(CAMERA.shoulder, dh * 0.95)
  out.yaw = Math.atan2(dz, dx) - Math.asin(s / dh)
  const along = Math.sqrt(Math.max(0.01, dh * dh - s * s))
  out.pitch = Math.max(CAMERA.pitchMin, Math.min(CAMERA.pitchMax, Math.atan2(ty - pivotY(f), along)))
}
