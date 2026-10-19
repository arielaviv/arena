import { makeRayHit, segmentVsVertical } from '../sim/collision'
import { MOVE } from '../sim/constants'
import { chestY, type Fighter, hurtHeight } from '../sim/fighter'
import { Block } from '../sim/geometry'
import { endDash } from '../sim/movement'
import { applyEffects } from './effects'
import type { CombatHost, Projectile } from './host'
import type { AbilityDef, HazardDef, Side } from './types'

const hit = makeRayHit()

function sideOk(side: Side, team: 0 | 1, owner: number, g: Fighter): boolean {
  if (g.id === owner) return false
  if (side === 'both') return true
  return side === 'enemy' ? g.team !== team : g.team === team
}

export function spawnHazard(
  host: CombatHost,
  owner: Fighter,
  ability: AbilityDef,
  def: HazardDef,
  x: number,
  y: number,
  z: number,
): void {
  const id = host.nextId()
  host.hazards.push({
    id,
    owner: owner.id,
    team: owner.team,
    ability,
    def,
    x,
    y,
    z,
    remaining: def.duration,
    tickTimer: 0,
    hit: [],
  })
  host.emit({
    t: 'hazard',
    id,
    ability: ability.id,
    src: owner.id,
    x,
    y,
    z,
    radius: def.radius,
    duration: def.duration,
  })
}

function projectileEffects(p: Projectile) {
  const nth = p.ability.everyNth
  return p.nth && nth ? [...p.ability.effects, ...nth.effects] : p.ability.effects
}

export function updateProjectiles(host: CombatHost, dt: number): void {
  for (const p of host.projectiles) {
    if (!p.alive) continue
    const owner = host.byId(p.owner)
    p.vy -= p.gravity * dt
    const sx = p.vx * dt
    const sy = p.vy * dt
    const sz = p.vz * dt
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz)
    if (len < 1e-6) continue
    const dx = sx / len
    const dy = sy / len
    const dz = sz / len

    let tWorld = Number.POSITIVE_INFINITY
    if (host.world.raycast(p.x, p.y, p.z, dx, dy, dz, len, Block.Shot, hit)) tWorld = hit.t
    const wnx = hit.nx
    const wny = hit.ny
    const wnz = hit.nz

    let target: Fighter | null = null
    let tFighter = Number.POSITIVE_INFINITY
    for (const g of host.fighters) {
      if (!g.alive || !sideOk(p.side, p.team, p.owner, g)) continue
      const r = MOVE.radius + p.radius
      const c = segmentVsVertical(
        p.x,
        p.y,
        p.z,
        p.x + sx,
        p.y + sy,
        p.z + sz,
        g.pos.x,
        g.pos.y + MOVE.radius,
        g.pos.y + hurtHeight(g) - MOVE.radius,
        g.pos.z,
      )
      if (c.dist2 > r * r) continue
      const t = c.s * len
      if (t < tFighter) {
        tFighter = t
        target = g
      }
    }

    if (target && tFighter <= tWorld) {
      p.alive = false
      const ix = p.x + dx * tFighter
      const iy = p.y + dy * tFighter
      const iz = p.z + dz * tFighter
      host.emit({
        t: 'impact',
        ability: p.ability.id,
        src: p.owner,
        x: ix,
        y: iy,
        z: iz,
        nx: -dx,
        ny: -dy,
        nz: -dz,
      })
      if (owner) {
        applyEffects(host, owner, target, p.ability, projectileEffects(p))
        if (p.hazard) spawnHazard(host, owner, p.ability, p.hazard, target.pos.x, target.pos.y, target.pos.z)
      }
      continue
    }
    if (tWorld <= len) {
      p.alive = false
      const ix = p.x + dx * tWorld
      const iy = p.y + dy * tWorld
      const iz = p.z + dz * tWorld
      host.emit({
        t: 'impact',
        ability: p.ability.id,
        src: p.owner,
        x: ix,
        y: iy,
        z: iz,
        nx: wnx,
        ny: wny,
        nz: wnz,
      })
      if (owner && p.hazard) {
        const gy = host.world.groundHeight(ix, iz, iy + 0.5)
        spawnHazard(host, owner, p.ability, p.hazard, ix, Number.isFinite(gy) ? gy : iy, iz)
      }
      continue
    }
    p.x += sx
    p.y += sy
    p.z += sz
    p.range -= len
    if (p.range <= 0) p.alive = false
  }
  compact(host.projectiles, (p) => p.alive)
}

export function updateHazards(host: CombatHost, dt: number): void {
  for (const h of host.hazards) {
    h.remaining -= dt
    h.tickTimer -= dt
    if (h.tickTimer > 0) continue
    h.tickTimer += h.def.interval
    const owner = host.byId(h.owner)
    if (!owner) continue
    for (const g of host.fighters) {
      if (!g.alive) continue
      const sideMatch =
        h.def.side === 'both' || (h.def.side === 'enemy' ? g.team !== h.team : g.team === h.team)
      if (!sideMatch) continue
      if (h.def.oncePerTarget && h.hit.includes(g.id)) continue
      if (Math.hypot(g.pos.x - h.x, g.pos.z - h.z) > h.def.radius + MOVE.radius) continue
      if (Math.abs(g.pos.y - h.y) > 2.5) continue
      h.hit.push(g.id)
      applyEffects(host, owner, g, h.ability, h.def.effects)
    }
  }
  compact(host.hazards, (h) => h.remaining > 0)
}

export function updateDelayed(host: CombatHost, dt: number): void {
  for (const d of host.delayed) {
    d.remaining -= dt
    if (d.follow) {
      const t = host.byId(d.targetId)
      if (t?.alive) {
        d.x = t.pos.x
        d.y = t.pos.y
        d.z = t.pos.z
      }
    }
    if (d.remaining > 0) continue
    host.emit({
      t: 'detonate',
      id: d.id,
      ability: d.ability.id,
      src: d.owner,
      x: d.x,
      y: d.y,
      z: d.z,
      radius: d.radius,
    })
    const owner = host.byId(d.owner)
    if (!owner) continue
    for (const g of host.fighters) {
      if (!g.alive) continue
      const sideMatch = d.side === 'both' || (d.side === 'enemy' ? g.team !== d.team : g.team === d.team)
      if (!sideMatch) continue
      if (Math.hypot(g.pos.x - d.x, g.pos.z - d.z) > d.radius + MOVE.radius) continue
      if (Math.abs(g.pos.y - d.y) > 3) continue
      if (!host.world.lineOfSight(d.x, d.y + 1, d.z, g.pos.x, chestY(g), g.pos.z)) continue
      applyEffects(host, owner, g, d.ability, d.effects)
    }
  }
  compact(host.delayed, (d) => d.remaining > 0)
}

// Dashes with effects (Fire Fang, Aqua Jet, Sucker Punch) hit the first enemy
// they touch and stop there.
export function updateDashContact(host: CombatHost, f: Fighter): void {
  const d = f.dash
  if (!d || d.hit || d.ability.effects.length === 0 || d.ability.target.kind !== 'dash') return
  const r = d.ability.target.hitRadius
  for (const g of host.fighters) {
    if (g === f || !g.alive || g.team === f.team) continue
    if (Math.hypot(g.pos.x - f.pos.x, g.pos.z - f.pos.z) > r + MOVE.radius) continue
    if (Math.abs(g.pos.y - f.pos.y) > 2) continue
    d.hit = true
    host.emit({
      t: 'impact',
      ability: d.ability.id,
      src: f.id,
      x: g.pos.x,
      y: chestY(g),
      z: g.pos.z,
      nx: -d.dirX,
      ny: 0,
      nz: -d.dirZ,
    })
    applyEffects(host, f, g, d.ability, d.ability.effects)
    endDash(f)
    return
  }
  if (d.remaining <= 1e-4 && d.targetId >= 0) {
    // Arrived next to the target without touching: still connect.
    const g = host.byId(d.targetId)
    if (g?.alive && Math.hypot(g.pos.x - f.pos.x, g.pos.z - f.pos.z) < r + 1.5) {
      d.hit = true
      applyEffects(host, f, g, d.ability, d.ability.effects)
    }
  }
}

function compact<T>(arr: T[], keep: (v: T) => boolean): void {
  let j = 0
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] as T
    if (keep(v)) arr[j++] = v
  }
  arr.length = j
}
