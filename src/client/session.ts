import { Vector3 } from 'three'
import type { SimEvent } from '../shared/combat/events'
import { getAbility } from '../shared/combat/registry'
import type { ClassId } from '../shared/combat/types'
import type { FighterSnap, Snapshot, TrainingCommand } from '../shared/net/protocol'
import { aimAtPoint } from '../shared/sim/aim'
import { World } from '../shared/sim/collision'
import { DT, MOVE, TICK_RATE } from '../shared/sim/constants'
import type { InputCmd } from '../shared/sim/input'
import { buildArena } from '../shared/sim/layout'
import type { MatchConfig } from '../shared/sim/match'
import { buildTraining } from '../shared/sim/trainingLayout'
import type { Audio } from './core/audio'
import type { Input } from './core/input'
import type { Renderer } from './core/renderer'
import { Interpolator, type InterpState } from './net/interpolation'
import { Predictor } from './net/prediction'
import { LocalTransport } from './net/transport'
import { Avatar } from './render/avatar'
import { CameraRig } from './render/camera'
import { type FighterView, Vfx } from './render/vfx'
import { type ThemeId, WorldView } from './render/world'
import type { Hud, HudView } from './ui/hud'

export interface SessionOptions {
  config: MatchConfig
  myId: number
  theme: ThemeId
  lagMs: number
  jitterMs: number
}

const projected = new Vector3()

// One match (or training visit): transport, prediction, rendering, HUD feed.
export class Session {
  readonly transport: LocalTransport
  readonly world: World
  readonly view: WorldView
  readonly mode: 'arena' | 'training'
  private readonly predictor: Predictor
  private readonly interp = new Interpolator()
  private readonly vfx: Vfx
  private readonly cam: CameraRig
  private readonly avatars = new Map<number, Avatar>()
  latest: Snapshot | null = null
  private serverClock = 0
  private latestTime = 0
  private acc = 0
  private seq = 0
  private time = 0
  timeScale = 1
  private hitStop = 0
  private readonly istate: InterpState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0 }
  private readonly renderPos = new Vector3()
  onEvent: ((e: SimEvent) => void) | null = null
  ready = false
  spectating: string | null = null
  private firstSnap: (() => void) | null = null
  // Dev/test only: overrides keyboard and mouse so headless runs can play.
  debugInput: { moveX?: number; moveZ?: number; buttons?: number } | null = null

  constructor(
    private readonly renderer: Renderer,
    private readonly input: Input,
    private readonly hud: Hud,
    private readonly audio: Audio,
    readonly opts: SessionOptions,
  ) {
    this.mode = opts.config.mode
    const geo = this.mode === 'training' ? buildTraining() : buildArena()
    this.world = new World(geo)
    this.world.setGates(this.mode === 'arena')
    this.predictor = new Predictor(this.world)
    const shadow = renderer.quality === 'high' ? 2048 : renderer.quality === 'medium' ? 1024 : 0
    this.view = new WorldView(renderer.scene, geo, opts.theme, shadow)
    const t = this.view.theme
    renderer.setPost({
      bloomStrength: t.bloom.strength,
      bloomThreshold: t.bloom.threshold,
      exposure: t.exposure,
    })
    this.vfx = new Vfx(renderer.scene)
    this.cam = new CameraRig(renderer.camera)
    this.transport = new LocalTransport(opts.config, opts.myId, {
      lagMs: opts.lagMs,
      jitterMs: opts.jitterMs,
    })
    this.transport.onMessage((msg) => {
      if (msg.type === 'snap') this.onSnapshot(msg.snap)
    })
    const spawn = geo.spawns[0][0]
    if (spawn) input.yaw = spawn.yaw
    input.pitch = -0.05
  }

  get myId(): number {
    return this.opts.myId
  }

  me(): FighterSnap | null {
    return this.latest?.fighters.find((f) => f.id === this.opts.myId) ?? null
  }

  refreshModels(): void {
    for (const av of this.avatars.values()) av.refreshModel()
  }

  sendTraining(cmd: TrainingCommand): void {
    this.transport.send({ type: 'training', cmd })
  }

  swapClass(classId: ClassId): void {
    this.sendTraining({ kind: 'swapClass', classId })
  }

  // Resolves once the world, avatars and every effect shader are compiled.
  async prepare(): Promise<void> {
    if (!this.latest) {
      await new Promise<void>((resolve) => {
        this.firstSnap = resolve
      })
    }
    const warm = this.vfx.warmupObjects()
    this.renderer.scene.add(warm)
    try {
      await this.renderer.gl.compileAsync(this.renderer.scene, this.renderer.camera)
    } catch {
      // compileAsync is an optimisation; rendering compiles lazily anyway
    }
    this.renderer.scene.remove(warm)
    this.ready = true
  }

  private onSnapshot(snap: Snapshot): void {
    const first = this.latest === null
    this.latest = snap
    this.latestTime = snap.tick / TICK_RATE
    if (first) this.serverClock = this.latestTime
    this.interp.push(snap)
    this.world.setGates(snap.mode === 'arena' && snap.phase === 'countdown')
    this.view.setGates(snap.mode === 'arena' && snap.phase === 'countdown')
    const mine = snap.fighters.find((f) => f.id === this.opts.myId)
    if (mine) this.predictor.reconcile(mine)
    this.vfx.sync(snap, this.latestTime)
    for (const f of snap.fighters) {
      let av = this.avatars.get(f.id)
      if (!av) {
        av = new Avatar(f.cls, f.team, mine ? mine.team : 0, f.id === this.opts.myId)
        this.avatars.set(f.id, av)
        this.renderer.scene.add(av.root)
      }
      av.setClass(f.cls)
    }
    for (const e of snap.events) this.handleEvent(e)
    if (first && this.firstSnap) {
      this.firstSnap()
      this.firstSnap = null
    }
  }

  private fighterView = (id: number): FighterView | undefined => {
    const f = this.latest?.fighters.find((x) => x.id === id)
    if (!f) return undefined
    const pos = this.positionOf(f)
    return {
      id,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      yaw: f.yaw,
      alive: f.alive,
      height: f.move === 'slide' ? MOVE.slideHeight : MOVE.height,
      auras: [],
      dashing: false,
      dashColor: '#fff',
    }
  }

  private handleEvent(e: SimEvent): void {
    this.vfx.onEvent(e, this.fighterView)
    this.hud.onEvent(e, this.opts.myId)
    this.onEvent?.(e)
    const me = this.opts.myId
    switch (e.t) {
      case 'damage':
        this.avatars.get(e.dst)?.hit()
        if (!e.tick && e.amount >= 60) this.avatars.get(e.dst)?.trigger('hit')
        if (e.dst === me && !e.tick) this.cam.addShake(Math.min(0.5, e.amount / 260))
        if (e.src === me && !e.tick)
          this.audio.play(e.amount >= 150 ? 'hit-big' : 'hit', e.amount >= 150 ? 1 : 0.7)
        if (e.src === me && e.amount >= 150) this.cam.kickFov(3)
        break
      case 'use': {
        const a = getAbility(e.ability)
        if (!a) break
        const kind = a.target.kind
        if (kind !== 'beam') {
          const melee = kind === 'melee' || kind === 'cone' || kind === 'dash'
          this.avatars.get(e.src)?.trigger(melee ? 'attack' : 'cast')
        }
        if (e.src !== me) break
        if (a.target.kind === 'dash') this.audio.play('dash')
        else if (a.slot === 'lmb') this.audio.play(`shoot-${a.element}`, 0.8, 0.05)
        else this.audio.play('cast-done', 0.7)
        break
      }
      case 'cast':
        if (e.src === me && e.action === 'start') this.audio.play('cast-start')
        if (e.src === me && e.action === 'fail') this.audio.play('error', 1, 0.2)
        break
      case 'interrupt':
        if (e.src === me || e.dst === me) {
          this.audio.play('interrupt')
          this.hitStop = 0.06
          this.cam.addShake(0.25)
        }
        break
      case 'heal':
        if (!e.tick && (e.src === me || e.dst === me)) this.audio.play('heal', 0.8)
        break
      case 'aura':
        if (e.action === 'apply' && e.dst === me && e.aura !== 'flame-charge') this.audio.play('cc', 0.5, 0.2)
        break
      case 'death':
        this.audio.play(e.src === me ? 'kill' : 'death')
        if (e.src === me) this.hitStop = 0.08
        break
      case 'detonate':
        this.cam.addShake(0.35)
        break
      case 'phase':
        if (e.phase === 'live') this.audio.play('fight')
        if (e.phase === 'ended') {
          const winner = this.latest?.winner
          for (const f of this.latest?.fighters ?? []) {
            if (f.team === winner && f.alive) this.avatars.get(f.id)?.trigger('emote')
          }
        }
        break
      default:
        break
    }
  }

  private positionOf(f: FighterSnap): Vector3 {
    if (f.id === this.opts.myId && this.predictor.fighter) {
      return this.renderPos
    }
    if (this.interp.sample(f.id, this.serverClock, this.istate)) {
      return projected.set(this.istate.x, this.istate.y, this.istate.z)
    }
    return projected.set(f.x, f.y, f.z)
  }

  debugAimAt(id: number): void {
    const f = this.latest?.fighters.find((x) => x.id === id)
    const me = this.predictor.fighter
    if (!f || !me) return
    const out = { yaw: 0, pitch: 0 }
    aimAtPoint(me, f.x, f.y + 1.1, f.z, out)
    this.input.yaw = out.yaw
    this.input.pitch = out.pitch
  }

  private buildCmd(): InputCmd {
    const d = this.debugInput
    if (d) {
      return {
        seq: ++this.seq,
        moveX: d.moveX ?? 0,
        moveZ: d.moveZ ?? 0,
        yaw: this.input.yaw,
        pitch: this.input.pitch,
        buttons: d.buttons ?? 0,
      }
    }
    const locked = this.input.locked
    return {
      seq: ++this.seq,
      moveX: locked ? this.input.moveX() : 0,
      moveZ: locked ? this.input.moveZ() : 0,
      yaw: this.input.yaw,
      pitch: this.input.pitch,
      buttons: locked ? this.input.buttons() : 0,
    }
  }

  update(dt: number): void {
    this.time += dt
    let scale = this.timeScale
    if (this.hitStop > 0) {
      this.hitStop -= dt
      scale *= 0.08
    }
    this.transport.timeScale = scale
    const sdt = dt * scale

    this.acc += Math.min(sdt, 0.1)
    while (this.acc >= DT) {
      this.acc -= DT
      const cmd = this.buildCmd()
      this.transport.send({ type: 'input', cmd })
      this.predictor.step(cmd)
    }
    this.transport.update(dt)
    this.serverClock = Math.min(this.serverClock + sdt, this.latestTime + 0.1)
    if (this.serverClock < this.latestTime - 0.25) this.serverClock = this.latestTime - 0.1

    // Local fighter: predicted, smoothed between ticks
    const p = this.predictor
    p.decayOffset(dt)
    const alpha = this.acc / DT
    this.renderPos.copy(p.prev).lerp(p.curr, alpha).add(p.offset)

    const snap = this.latest
    if (!snap) return
    const me = snap.fighters.find((f) => f.id === this.opts.myId)
    const pf = p.fighter

    const views: FighterView[] = []
    for (const f of snap.fighters) {
      const av = this.avatars.get(f.id)
      if (!av) continue
      const local = f.id === this.opts.myId
      let x = f.x
      let y = f.y
      let z = f.z
      let yaw = f.yaw
      let speed = Math.hypot(f.vx, f.vz)
      if (local && pf) {
        x = this.renderPos.x
        y = this.renderPos.y
        z = this.renderPos.z
        yaw = this.input.yaw
        speed = Math.hypot(pf.vel.x, pf.vel.z)
      } else if (this.interp.sample(f.id, this.serverClock, this.istate)) {
        x = this.istate.x
        y = this.istate.y
        z = this.istate.z
        yaw = this.istate.yaw
        speed = Math.hypot(this.istate.vx, this.istate.vz)
      }
      const move = local && pf ? pf.move : f.move
      const auraIds = f.auras.map((a) => a.id)
      av.update(
        dt,
        {
          x,
          y,
          z,
          yaw,
          speed,
          move,
          casting: f.cast !== null && !f.cast.channel,
          channel: f.cast?.channel ?? false,
          alive: f.alive,
          stunned: auraIds.includes('paralysis'),
          asleep: auraIds.includes('hypnosis') || auraIds.includes('sleep-powder'),
        },
        this.time,
      )
      const dashAbility = f.dash ? getAbility(f.dash.ability) : undefined
      views.push({
        id: f.id,
        x,
        y,
        z,
        yaw,
        alive: f.alive,
        height: move === 'slide' ? MOVE.slideHeight : MOVE.height,
        auras: auraIds,
        dashing: (local && pf ? pf.move : f.move) === 'dash',
        dashColor: dashAbility ? elementGlow(dashAbility.element) : '#ffffff',
        cast: f.cast?.ability ?? null,
        castFrac: f.cast ? f.cast.elapsed / Math.max(0.01, f.cast.duration) : 0,
      })
    }

    this.vfx.update(dt, this.serverClock, views)
    this.view.update(dt, this.time)

    // Camera: follow yourself, or spectate a living teammate once you're down.
    const spectate =
      me && !me.alive && snap.mode === 'arena'
        ? views.find(
            (v) => v.alive && v.id !== me.id && snap.fighters.find((f) => f.id === v.id)?.team === me.team,
          )
        : undefined
    this.spectating = spectate ? (snap.fighters.find((f) => f.id === spectate.id)?.name ?? null) : null
    if (pf) {
      const speedH = Math.hypot(pf.vel.x, pf.vel.z)
      this.cam.update(
        dt,
        spectate ? spectate.x : this.renderPos.x,
        spectate ? spectate.y : this.renderPos.y,
        spectate ? spectate.z : this.renderPos.z,
        this.input.yaw,
        this.input.pitch,
        pf.move === 'slide',
        speedH,
        this.world,
        this.renderer.baseFov,
      )
    }

    // HUD
    if (me) {
      const meView: FighterSnap = { ...me, x: this.renderPos.x, y: this.renderPos.y, z: this.renderPos.z }
      const fighters = snap.fighters.map((f) => {
        if (f.id === this.opts.myId) return meView
        const v = views.find((x) => x.id === f.id)
        return v ? { ...f, x: v.x, y: v.y, z: v.z } : f
      })
      const camera = this.renderer.camera
      const w = window.innerWidth
      const h = window.innerHeight
      const view: HudView = {
        me: meView,
        fighters,
        mode: snap.mode,
        phase: snap.phase,
        phaseTimer: snap.phaseTimer,
        project: (px, py, pz) => {
          projected.set(px, py, pz).project(camera)
          return {
            x: (projected.x * 0.5 + 0.5) * w,
            y: (-projected.y * 0.5 + 0.5) * h,
            visible: projected.z < 1 && projected.z > -1,
          }
        },
        hasLos: (a, b) => this.world.lineOfSight(a.x, a.y + 1.5, a.z, b.x, b.y + 1.1, b.z),
      }
      this.hud.update(view, dt)
      this.hud.setSpectating(this.spectating)
    }
  }

  dispose(): void {
    this.transport.close()
    this.view.dispose()
    for (const av of this.avatars.values()) {
      this.renderer.scene.remove(av.root)
      av.dispose()
    }
    this.renderer.scene.remove(this.vfx.group)
  }
}

function elementGlow(element: string): string {
  switch (element) {
    case 'fire':
      return '#ff7a1a'
    case 'water':
      return '#2fb8ff'
    case 'poison':
      return '#8be02b'
    case 'psychic':
      return '#e05cff'
    case 'grass':
      return '#4ade80'
    default:
      return '#ffffff'
  }
}
