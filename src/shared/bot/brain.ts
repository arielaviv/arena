import type { AbilityDef, AiTag, Slot } from '../combat/types'
import { aimAtPoint } from '../sim/aim'
import { makeRayHit } from '../sim/collision'
import { CAMERA } from '../sim/constants'
import { chestY, type Fighter, isIncapacitated } from '../sim/fighter'
import { Block } from '../sim/geometry'
import { Btn, type InputCmd, SLOT_BUTTON } from '../sim/input'
import type { MatchSim } from '../sim/match'
import { Rng } from '../sim/rng'

const hit = makeRayHit()
const SLOTS_BY_TAG_ORDER: readonly Slot[] = ['lmb', 'rmb', 'q', 'e', 'f', 'r', 'c']

interface Reaction {
  targetId: number
  at: number
}

// Role-aware utility AI. Reads the sim, writes an InputCmd: exactly what a
// human client would send, so bots and humans share every code path.
export class Brain {
  private readonly rng: Rng
  private seq = 0
  private time = 0
  private targetId = -1
  private retarget = 0
  private strafeDir = 1
  private strafeTimer = 0
  private interruptReact: Reaction | null = null
  private readonly aim = { yaw: 0, pitch: 0 }
  private readonly reaction: number
  private readonly aimError: number
  private readonly lead: number

  constructor(
    readonly id: number,
    readonly difficulty: number,
    seed: number,
  ) {
    this.rng = new Rng(seed)
    const d = Math.max(0, Math.min(1, difficulty))
    this.reaction = 0.65 - 0.4 * d
    this.aimError = 0.07 - 0.055 * d
    this.lead = 0.4 + 0.6 * d
  }

  think(sim: MatchSim, f: Fighter, dt: number): InputCmd {
    this.time += dt
    this.seq++
    const cmd: InputCmd = { seq: this.seq, moveX: 0, moveZ: 0, yaw: f.yaw, pitch: f.pitch, buttons: 0 }
    if (!f.alive || sim.phase === 'ended') return cmd

    const enemies = sim.fighters.filter((g) => g.alive && g.team !== f.team)
    const allies = sim.fighters.filter((g) => g.alive && g.team === f.team)
    if (sim.phase === 'countdown') {
      // Walk to the gate and wait.
      this.steer(sim, f, cmd, -Math.sign(f.pos.x) * 1, 0, 0.6)
      return cmd
    }
    if (enemies.length === 0) return cmd

    const target = this.pickTarget(sim, f, enemies)
    if (!target) return cmd
    const healer = f.cls.role === 'healer'
    const dist = Math.hypot(target.pos.x - f.pos.x, target.pos.z - f.pos.z)
    const hasLos = sim.world.lineOfSight(
      f.pos.x,
      f.pos.y + 1.5,
      f.pos.z,
      target.pos.x,
      chestY(target),
      target.pos.z,
    )
    const hpPct = f.hp / f.maxHp

    // Default aim: the target, with lead for projectiles and some human error.
    this.aimAt(f, target, this.primarySpeed(f), cmd)

    let wantStill = false
    let pressedSlot: Slot | null = null
    const ready = (slot: Slot) => this.ready(f, f.cls.abilities[slot])

    // 1. Trinket out of crowd control when it matters.
    if (isIncapacitated(f) && ready('c') && (hpPct < 0.55 || this.rng.chance(0.02))) {
      pressedSlot = 'c'
    }

    // 2. Interrupt enemy casts after a human-like reaction delay.
    if (!pressedSlot) {
      const caster = enemies.find(
        (e) => e.cast && e.cast.ability.school === 'spell' && !e.cast.channel && e.cast.duration > 0.6,
      )
      if (caster?.cast) {
        if (!this.interruptReact || this.interruptReact.targetId !== caster.id) {
          this.interruptReact = {
            targetId: caster.id,
            at: this.time + this.reaction + this.rng.range(0, 0.15),
          }
        }
        const kickSlot = this.slotWith(f, 'interrupt')
        if (
          kickSlot &&
          ready(kickSlot) &&
          this.time >= this.interruptReact.at &&
          this.inAbilityRange(f, caster, f.cls.abilities[kickSlot])
        ) {
          this.aimAt(f, caster, 0, cmd)
          pressedSlot = kickSlot
        }
      } else {
        this.interruptReact = null
      }
    }

    // 3. Healing and dispels.
    if (!pressedSlot && (healer || f.cls.abilities.lmb.tags.includes('heal'))) {
      const hurt = this.mostHurtAlly(sim, f, allies)
      if (hurt) {
        const pct = hurt.hp / hurt.maxHp
        const dispelSlot = this.slotWith(f, 'dispel', 'ult')
        const ccd = allies.find((a) => a.auras.some((x) => x.def.cc && x.def.dispel === 'magic'))
        if (dispelSlot && ready(dispelSlot) && ccd && this.rng.chance(0.08 + 0.2 * this.difficulty)) {
          this.aimAt(f, ccd, 0, cmd)
          pressedSlot = dispelSlot
        } else if (
          healer &&
          pct < 0.45 &&
          f.ult >= 100 &&
          ready('r') &&
          f.cls.abilities.r.tags.includes('heal')
        ) {
          pressedSlot = 'r'
        } else if (healer && pct < 0.72 && ready('rmb')) {
          this.aimAt(f, hurt, 0, cmd)
          pressedSlot = 'rmb'
          wantStill = true
        } else if (healer && pct < 0.85 && ready('e') && f.cls.abilities.e.tags.includes('heal')) {
          this.aimAt(f, hurt, 0, cmd)
          pressedSlot = 'e'
        }
      }
    }
    if (f.cast && (f.cast.ability.castTime ?? 0) > 0) wantStill = true

    // 4. Defensive when low.
    if (!pressedSlot && hpPct < 0.4) {
      const defSlot = this.slotWith(f, 'defensive', 'heal')
      if (defSlot && ready(defSlot) && this.rng.chance(0.15)) {
        const def = f.cls.abilities[defSlot]
        if (def.target.kind === 'dash') {
          // Dash away from the target.
          cmd.yaw = Math.atan2(f.pos.z - target.pos.z, f.pos.x - target.pos.x)
          cmd.pitch = 0
        }
        pressedSlot = defSlot
      }
    }

    // 5. Ultimate.
    if (!pressedSlot && f.ult >= 100 && ready('r') && !f.cls.abilities.r.tags.includes('heal') && hasLos) {
      if (
        this.inAbilityRange(f, target, f.cls.abilities.r) &&
        (target.hp / target.maxHp < 0.7 || this.rng.chance(0.01))
      ) {
        this.aimAt(f, target, 0, cmd)
        pressedSlot = 'r'
      }
    }

    // 6. Crowd control: prefer the enemy healer.
    if (!pressedSlot && ready('q') && this.rng.chance(0.04 + 0.08 * this.difficulty)) {
      const ccTarget = enemies.find((e) => e.cls.role === 'healer') ?? target
      const q = f.cls.abilities.q
      const alreadyCc = ccTarget.auras.some((a) => a.def.cc && a.def.cc !== 'root')
      if (!alreadyCc && this.inAbilityRange(f, ccTarget, q) && this.hasLos(sim, f, ccTarget)) {
        this.aimAt(f, ccTarget, q.target.kind === 'projectile' ? q.target.speed : 0, cmd)
        pressedSlot = 'q'
      }
    }

    // 7. Signature move (damage casts / melee finishers).
    if (!pressedSlot && !healer && ready('rmb') && hasLos) {
      const rmb = f.cls.abilities.rmb
      const isCast = (rmb.castTime ?? 0) > 0
      const meleeClose = enemies.some(
        (e) => Math.hypot(e.pos.x - f.pos.x, e.pos.z - f.pos.z) < 5 && e.cls.id === 'venomaw',
      )
      if (
        this.inAbilityRange(f, target, rmb) &&
        (!isCast || !meleeClose) &&
        this.rng.chance(isCast ? 0.05 : 0.2)
      ) {
        pressedSlot = 'rmb'
        if (isCast) wantStill = true
      }
    }

    // 8. Primary.
    if (!pressedSlot && hasLos && this.inAbilityRange(f, target, f.cls.abilities.lmb)) {
      pressedSlot = 'lmb'
    }

    if (pressedSlot) cmd.buttons |= SLOT_BUTTON[pressedSlot]

    // Movement
    if (!wantStill && !isIncapacitated(f)) this.move(sim, f, target, dist, hasLos, hpPct, allies, cmd, dt)
    return cmd
  }

  private ready(f: Fighter, a: AbilityDef): boolean {
    if (f.cooldowns[a.slot] > 0 || f.resource < a.cost) return false
    if (a.tags.includes('ult') && f.ult < 100) return false
    if (f.cast && !a.offGcd) return false
    return true
  }

  private slotWith(f: Fighter, tag: AiTag, exclude?: AiTag): Slot | null {
    for (const s of SLOTS_BY_TAG_ORDER) {
      const a = f.cls.abilities[s]
      if (a.tags.includes(tag) && (!exclude || !a.tags.includes(exclude))) return s
    }
    return null
  }

  private inAbilityRange(f: Fighter, g: Fighter, a: AbilityDef): boolean {
    const d = Math.hypot(g.pos.x - f.pos.x, g.pos.z - f.pos.z)
    const t = a.target
    switch (t.kind) {
      case 'projectile':
        return d < t.range * 0.85
      case 'hitscan':
      case 'targeted':
      case 'beam':
      case 'ground':
        return d < t.range
      case 'cone':
      case 'melee':
        return d < t.range + 0.3
      case 'dash':
        return d < t.distance + 1
      case 'nova':
        return d < t.radius
      case 'self':
        return true
    }
  }

  private hasLos(sim: MatchSim, f: Fighter, g: Fighter): boolean {
    return sim.world.lineOfSight(f.pos.x, f.pos.y + 1.5, f.pos.z, g.pos.x, chestY(g), g.pos.z)
  }

  private primarySpeed(f: Fighter): number {
    const t = f.cls.abilities.lmb.target
    return t.kind === 'projectile' ? t.speed : 0
  }

  private aimAt(f: Fighter, g: Fighter, projectileSpeed: number, cmd: InputCmd): void {
    let tx = g.pos.x
    let ty = chestY(g)
    let tz = g.pos.z
    if (projectileSpeed > 0) {
      const d = Math.hypot(tx - f.pos.x, tz - f.pos.z)
      const tof = d / projectileSpeed
      tx += g.vel.x * tof * this.lead
      tz += g.vel.z * tof * this.lead
      ty += Math.max(0, g.vel.y) * tof * 0.3 * this.lead
    }
    aimAtPoint(f, tx, ty, tz, this.aim)
    cmd.yaw = this.aim.yaw + (this.rng.next() - 0.5) * this.aimError
    cmd.pitch = Math.max(
      CAMERA.pitchMin,
      Math.min(CAMERA.pitchMax, this.aim.pitch + (this.rng.next() - 0.5) * this.aimError * 0.6),
    )
  }

  private pickTarget(sim: MatchSim, f: Fighter, enemies: Fighter[]): Fighter | null {
    this.retarget -= 1 / 60
    const current = enemies.find((e) => e.id === this.targetId)
    if (current && this.retarget > 0) return current
    this.retarget = 1.5 + this.rng.range(0, 1.5)
    // Follow a human teammate's target when there is one.
    const human = sim.fighters.find((g) => g.team === f.team && g.control === 'human' && g.alive)
    const humanAim = human ? sim.aimOf(human.id) : undefined
    if (humanAim && humanAim.fighter >= 0) {
      const t = enemies.find((e) => e.id === humanAim.fighter)
      if (t) {
        this.targetId = t.id
        return t
      }
    }
    let best: Fighter | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const e of enemies) {
      const d = Math.hypot(e.pos.x - f.pos.x, e.pos.z - f.pos.z)
      const score = (e.hp / e.maxHp) * 30 + d * 0.6 + (this.hasLos(sim, f, e) ? 0 : 12)
      if (score < bestScore) {
        bestScore = score
        best = e
      }
    }
    this.targetId = best ? best.id : -1
    return best
  }

  private mostHurtAlly(sim: MatchSim, f: Fighter, allies: Fighter[]): Fighter | null {
    let best: Fighter | null = null
    let bestPct = 1
    for (const a of allies) {
      const pct = a.hp / a.maxHp
      if (pct >= bestPct) continue
      if (a !== f) {
        if (Math.hypot(a.pos.x - f.pos.x, a.pos.z - f.pos.z) > 38) continue
        if (!this.hasLos(sim, f, a)) continue
      }
      best = a
      bestPct = pct
    }
    return best
  }

  private move(
    sim: MatchSim,
    f: Fighter,
    target: Fighter,
    dist: number,
    hasLos: boolean,
    hpPct: number,
    allies: Fighter[],
    cmd: InputCmd,
    dt: number,
  ): void {
    const melee = f.cls.abilities.lmb.target.kind === 'melee'
    const healer = f.cls.role === 'healer'
    const preferred = melee ? 2.2 : healer ? 17 : 19
    let wx = 0
    let wz = 0
    const tx = target.pos.x - f.pos.x
    const tz = target.pos.z - f.pos.z
    const td = Math.max(0.01, Math.hypot(tx, tz))

    if (hpPct < 0.3 && !melee && this.rng.chance(0.9)) {
      // Break line of sight behind the nearest pillar.
      const hide = this.hideSpot(sim, f, target)
      if (hide) {
        wx = hide.x - f.pos.x
        wz = hide.z - f.pos.z
      }
    } else if (healer) {
      // Stay near the partner with line of sight, away from enemies.
      const partner = allies.find((a) => a !== f)
      if (partner) {
        const px = partner.pos.x - f.pos.x
        const pz = partner.pos.z - f.pos.z
        const pd = Math.hypot(px, pz)
        const partnerLos = this.hasLos(sim, f, partner)
        if (pd > 22 || !partnerLos) {
          wx += px / (pd || 1)
          wz += pz / (pd || 1)
        }
      }
      if (dist < 12) {
        wx -= tx / td
        wz -= tz / td
      }
    } else {
      const err = td - preferred
      wx += (tx / td) * Math.max(-1, Math.min(1, err / 4))
      wz += (tz / td) * Math.max(-1, Math.min(1, err / 4))
      if (!hasLos) {
        wx += tx / td
        wz += tz / td
      }
    }

    // Strafe
    this.strafeTimer -= dt
    if (this.strafeTimer <= 0) {
      this.strafeDir = this.rng.chance(0.5) ? 1 : -1
      this.strafeTimer = this.rng.range(0.6, 1.8)
    }
    const strafe = melee ? 0.35 : 0.8
    wx += (-tz / td) * this.strafeDir * strafe
    wz += (tx / td) * this.strafeDir * strafe

    // Stay inside the ring
    const r = Math.hypot(f.pos.x, f.pos.z)
    if (r > 25 && sim.mode === 'arena') {
      wx -= (f.pos.x / r) * (r - 25) * 0.4
      wz -= (f.pos.z / r) * (r - 25) * 0.4
    }

    this.steer(sim, f, cmd, wx, wz, 1)

    if (melee && dist > 6 && f.grounded && this.rng.chance(0.02)) cmd.buttons |= Btn.Slide
    if (!melee && f.grounded && this.rng.chance(0.006)) cmd.buttons |= Btn.Jump
  }

  private hideSpot(sim: MatchSim, f: Fighter, threat: Fighter): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null
    let bestD = Number.POSITIVE_INFINITY
    for (const p of sim.world.prisms) {
      if (p.tag !== 'pillar') continue
      const ax = p.cx - threat.pos.x
      const az = p.cz - threat.pos.z
      const al = Math.hypot(ax, az) || 1
      const off = Math.max(p.hx, p.hz) * 1.41 + 1.6
      const x = p.cx + (ax / al) * off
      const z = p.cz + (az / al) * off
      const d = Math.hypot(x - f.pos.x, z - f.pos.z)
      if (d < bestD) {
        bestD = d
        best = { x, z }
      }
    }
    return best
  }

  // Turn a desired world direction into strafe/forward input relative to the
  // aim yaw, sidestepping pillars that block the way.
  private steer(sim: MatchSim, f: Fighter, cmd: InputCmd, wx: number, wz: number, scale: number): void {
    let len = Math.hypot(wx, wz)
    if (len < 0.05) return
    wx /= len
    wz /= len
    const probe = 2.2
    if (sim.world.raycastPrisms(f.pos.x, f.pos.y + 0.9, f.pos.z, wx, 0, wz, probe, Block.Move, hit)) {
      const left = rotate(wx, wz, 1.1)
      const right = rotate(wx, wz, -1.1)
      const leftBlocked = sim.world.raycastPrisms(
        f.pos.x,
        f.pos.y + 0.9,
        f.pos.z,
        left.x,
        0,
        left.z,
        probe,
        Block.Move,
        hit,
      )
      const pick = leftBlocked ? right : left
      wx = pick.x
      wz = pick.z
    }
    len = Math.min(1, scale)
    const c = Math.cos(cmd.yaw)
    const s = Math.sin(cmd.yaw)
    cmd.moveZ = (wx * c + wz * s) * len
    cmd.moveX = (-wx * s + wz * c) * len
  }
}

function rotate(x: number, z: number, a: number): { x: number; z: number } {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: x * c - z * s, z: x * s + z * c }
}
