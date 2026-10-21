import { Brain } from '../bot/brain'
import { updateAbilities } from '../combat/abilities'
import { dealDamage, updateFighterTimers } from '../combat/effects'
import { updateDashContact, updateDelayed, updateHazards, updateProjectiles } from '../combat/entities'
import type { SimEvent } from '../combat/events'
import type { CombatHost, Delayed, Hazard, Projectile } from '../combat/host'
import { CLASSES } from '../combat/registry'
import type { ClassId } from '../combat/types'
import { type Aim, computeAim, makeAim } from './aim'
import { World } from './collision'
import { CAMERA, DT } from './constants'
import { DummyBrain } from './dummies'
import { type Control, type Fighter, makeFighter } from './fighter'
import type { InputCmd } from './input'
import { buildArena } from './layout'
import { stepMovement } from './movement'
import { Rng } from './rng'
import { buildTraining } from './trainingLayout'

export type MatchMode = 'arena' | 'training'
export type Phase = 'countdown' | 'live' | 'ended'

export interface SlotConfig {
  classId: ClassId
  name: string
  control: Exclude<Control, 'dummy'>
}

export interface MatchConfig {
  mode: MatchMode
  seed: number
  teams: [SlotConfig[], SlotConfig[]]
  countdown?: number
  difficulty?: number // 0 easy .. 1 hard
}

const RESPAWN_TRAINING = 1.5

export class MatchSim implements CombatHost {
  readonly world: World
  readonly fighters: Fighter[] = []
  readonly projectiles: Projectile[] = []
  readonly hazards: Hazard[] = []
  readonly delayed: Delayed[] = []
  readonly rng: Rng
  readonly training: boolean
  readonly mode: MatchMode
  readonly difficulty: number
  tick = 0
  phase: Phase
  phaseTimer: number
  winner: -1 | 0 | 1 = -1
  aggressorOn = false
  infiniteResource = false
  private events: SimEvent[] = []
  private idCounter = 1000
  private brains = new Map<number, Brain>()
  private dummyBrains = new Map<number, DummyBrain>()
  private aims = new Map<number, Aim>()
  private respawn = new Map<number, number>()
  private inputQueues = new Map<number, InputCmd[]>()

  constructor(cfg: MatchConfig) {
    this.mode = cfg.mode
    this.training = cfg.mode === 'training'
    this.rng = new Rng(cfg.seed)
    this.world = new World(this.training ? buildTraining() : buildArena())
    const difficulty = cfg.difficulty ?? 0.4
    this.difficulty = difficulty

    let id = 1
    for (const team of [0, 1] as const) {
      const spawns = this.world.geo.spawns[team]
      cfg.teams[team].forEach((slot, i) => {
        const s = spawns[i % spawns.length]
        if (!s) return
        const f = makeFighter(
          id++,
          team,
          slot.name,
          CLASSES[slot.classId],
          slot.control,
          s.x,
          s.y,
          s.z,
          s.yaw,
        )
        this.fighters.push(f)
        this.aims.set(f.id, makeAim())
        if (slot.control === 'bot') this.brains.set(f.id, new Brain(f.id, difficulty, cfg.seed + f.id * 7919))
      })
    }
    if (this.training) {
      for (const spot of this.world.geo.dummies) {
        const team = spot.role === 'ally' ? 0 : 1
        const name =
          spot.role === 'ally' ? 'Ally Dummy' : `${spot.role[0]?.toUpperCase()}${spot.role.slice(1)} Dummy`
        const f = makeFighter(id++, team, name, CLASSES.dummy, 'dummy', spot.x, 0, spot.z, spot.yaw)
        f.dummyRole = spot.role
        if (spot.role === 'ally') f.hp = Math.round(f.maxHp * 0.55)
        this.fighters.push(f)
        this.aims.set(f.id, makeAim())
        this.dummyBrains.set(f.id, new DummyBrain(f.id, spot.railHalf ?? 0))
      }
      this.world.setGates(false)
      this.phase = 'live'
      this.phaseTimer = 0
    } else {
      this.world.setGates(true)
      this.phase = 'countdown'
      this.phaseTimer = cfg.countdown ?? 3
    }
  }

  nextId(): number {
    return this.idCounter++
  }

  emit(e: SimEvent): void {
    this.events.push(e)
  }

  byId(id: number): Fighter | undefined {
    for (const f of this.fighters) if (f.id === id) return f
    return undefined
  }

  aimOf(id: number): Aim | undefined {
    return this.aims.get(id)
  }

  // Human inputs are queued and consumed one per tick, so bursts from a
  // jittery connection never drop a command (or a quick key tap).
  setInput(id: number, cmd: InputCmd): void {
    const f = this.byId(id)
    if (f?.control !== 'human') return
    let q = this.inputQueues.get(id)
    if (!q) {
      q = []
      this.inputQueues.set(id, q)
    }
    const clean = sanitizeInput(cmd, f.input)
    if (!clean) return
    const last = q.length > 0 ? (q[q.length - 1]?.seq ?? 0) : f.input.seq
    if (clean.seq <= last && clean.seq !== 0) return
    q.push(clean)
  }

  drainEvents(): SimEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  step(): void {
    this.tick++
    this.updatePhase()

    for (const f of this.fighters) {
      const q = this.inputQueues.get(f.id)
      if (q && q.length > 0) {
        // Fell behind (clock drift or a burst): skip ahead but keep it short.
        while (q.length > 10) q.shift()
        const next = q.shift()
        if (next) f.input = next
      }
      const brain = this.brains.get(f.id)
      if (brain) f.input = brain.think(this, f, DT)
      const dummy = this.dummyBrains.get(f.id)
      if (dummy) f.input = dummy.think(this, f, DT)
    }

    const frozen = this.phase === 'ended'
    for (const f of this.fighters) {
      f.buttons = frozen ? 0 : f.input.buttons
      if (frozen) f.input = { ...f.input, moveX: 0, moveZ: 0, buttons: 0 }
      stepMovement(f, f.input, this.world, DT)
      updateDashContact(this, f)
    }
    if (!frozen) {
      for (const f of this.fighters) {
        const aim = this.aims.get(f.id)
        if (!aim) continue
        computeAim(f, this.world, this.fighters, aim)
        updateAbilities(this, f, aim, DT)
      }
      updateProjectiles(this, DT)
      updateHazards(this, DT)
      updateDelayed(this, DT)
    }
    for (const f of this.fighters) {
      updateFighterTimers(this, f, DT)
      if (this.infiniteResource && f.control === 'human') {
        f.resource = f.maxResource
        f.ult = 100
      }
      f.prevButtons = f.buttons
      f.lastSeq = f.input.seq
    }

    if (this.training) this.updateTraining()
    else this.checkWin()
  }

  private updatePhase(): void {
    if (this.phase === 'countdown') {
      this.phaseTimer -= DT
      if (this.phaseTimer <= 0) {
        this.phase = 'live'
        this.phaseTimer = 0
        this.world.setGates(false)
        this.emit({ t: 'phase', phase: 'live', timer: 0 })
      }
    } else if (this.phase === 'live') {
      this.phaseTimer += DT
    } else {
      this.phaseTimer += DT
    }
  }

  private checkWin(): void {
    if (this.phase !== 'live') return
    const alive = [false, false]
    for (const f of this.fighters) if (f.alive) alive[f.team] = true
    if (alive[0] && alive[1]) return
    this.winner = alive[0] ? 0 : alive[1] ? 1 : -1
    this.phase = 'ended'
    this.phaseTimer = 0
    this.emit({ t: 'phase', phase: 'ended', timer: 0 })
  }

  private updateTraining(): void {
    for (const f of this.fighters) {
      if (!f.alive) {
        const t = (this.respawn.get(f.id) ?? RESPAWN_TRAINING) - DT
        if (t > 0) {
          this.respawn.set(f.id, t)
          continue
        }
        this.respawn.delete(f.id)
        f.alive = true
        f.hp = f.dummyRole === 'ally' ? Math.round(f.maxHp * 0.55) : f.maxHp
        f.resource = f.maxResource
        f.pos.set(f.spawnX, 0, f.spawnZ)
        f.vel.set(0, 0, 0)
        f.yaw = f.spawnYaw
        continue
      }
      // Dummies out of combat for 5 s reset to full health.
      if (f.control === 'dummy' && f.dummyRole !== 'ally' && f.combatTimer > 5 && f.hp < f.maxHp) {
        f.hp = f.maxHp
      }
    }
  }

  // Hand a disconnected player's fighter to the AI.
  takeOver(id: number): void {
    const f = this.byId(id)
    if (f?.control !== 'human' || this.training) return
    f.control = 'bot'
    this.brains.set(f.id, new Brain(f.id, this.difficulty, (this.rng.getState() ^ (f.id * 2654435761)) >>> 0))
  }

  // Training toggles
  resetCooldowns(id: number): void {
    const f = this.byId(id)
    if (!f) return
    for (const k of Object.keys(f.cooldowns) as Array<keyof typeof f.cooldowns>) f.cooldowns[k] = 0
    f.lockout = 0
  }

  swapClass(id: number, classId: ClassId): void {
    const f = this.byId(id)
    if (!f) return
    f.cls = CLASSES[classId]
    f.maxHp = f.cls.maxHp
    f.hp = f.maxHp
    f.maxResource = f.cls.maxResource
    f.resource = f.maxResource
    f.cast = null
    f.dash = null
    f.comboStep = 0
    f.nthCount = 0
    this.resetCooldowns(id)
  }

  // Used by the training "ally dummy": environmental damage from the enemy side.
  hurtFromEnvironment(target: Fighter, amount: number): void {
    const src = this.fighters.find((f) => f.team !== target.team) ?? target
    dealDamage(this, src, target, amount, 'environment', false)
  }
}

const ALL_BUTTONS = (1 << 14) - 1

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// Inputs can come from an untrusted network client: clamp everything so a
// bad packet can never put NaN or out-of-range values into the sim.
export function sanitizeInput(cmd: InputCmd, prev: InputCmd): InputCmd | null {
  if (!finite(cmd.seq) || cmd.seq < 0) return null
  const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
    finite(v) ? Math.max(lo, Math.min(hi, v)) : fallback
  return {
    seq: Math.floor(cmd.seq),
    moveX: clamp(cmd.moveX, -1, 1, 0),
    moveZ: clamp(cmd.moveZ, -1, 1, 0),
    yaw: finite(cmd.yaw) ? cmd.yaw % (Math.PI * 64) : prev.yaw,
    pitch: clamp(cmd.pitch, CAMERA.pitchMin, CAMERA.pitchMax, prev.pitch),
    buttons: finite(cmd.buttons) ? Math.floor(cmd.buttons) & ALL_BUTTONS : 0,
    // Missing = keep the current selection (older clients never send these).
    target: finite(cmd.target) ? Math.floor(cmd.target) : undefined,
    ally: finite(cmd.ally) ? Math.floor(cmd.ally) : undefined,
    ...(finite(cmd.aimX) && finite(cmd.aimY) && finite(cmd.aimZ)
      ? {
          aimX: clamp(cmd.aimX, -200, 200, 0),
          aimY: clamp(cmd.aimY, -20, 60, 0),
          aimZ: clamp(cmd.aimZ, -200, 200, 0),
        }
      : {}),
  }
}
