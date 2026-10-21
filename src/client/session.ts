import { Vector3 } from 'three'
import type { SimEvent } from '../shared/combat/events'
import { CLASSES, getAbility } from '../shared/combat/registry'
import { type AbilityDef, abilityAt, type ClassId, SLOTS } from '../shared/combat/types'
import type { FighterSnap, Snapshot, TrainingCommand } from '../shared/net/protocol'
import { aimAtPoint } from '../shared/sim/aim'
import { World } from '../shared/sim/collision'
import { CAMERA, DT, MOVE, TICK_RATE } from '../shared/sim/constants'
import { Btn, type InputCmd, SLOT_BUTTON } from '../shared/sim/input'
import { buildArena } from '../shared/sim/layout'
import type { MatchConfig } from '../shared/sim/match'
import { buildTraining } from '../shared/sim/trainingLayout'
import type { Audio } from './core/audio'
import type { Input } from './core/input'
import type { ControlScheme } from './core/keybinds'
import type { Pointer } from './core/pointer'
import type { Renderer } from './core/renderer'
import { Interpolator, type InterpState } from './net/interpolation'
import { Predictor } from './net/prediction'
import { LocalTransport, type Transport } from './net/transport'
import { Avatar } from './render/avatar'
import { CameraRig } from './render/camera'
import { TargetRings } from './render/targetRings'
import { type FighterView, Vfx } from './render/vfx'
import { type ThemeId, WorldView } from './render/world'
import { Targeting, type Unit } from './targeting'
import type { Hud, HudView } from './ui/hud'

export interface SessionOptions {
  config: MatchConfig
  myId: number
  theme: ThemeId
  lagMs: number
  jitterMs: number
  // Online matches pass a WebSocket transport; otherwise the match runs in-page.
  transport?: Transport
  controls: ControlScheme
}

const projected = new Vector3()

// Cursor shapes for classic controls: a blade over enemies, a hand over allies.
const SWORD_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M3 3 L17 17 M3 3 L9 4 L19 14 L14 19 L4 9 Z" fill="#fb7185" stroke="#18181b" stroke-width="1.5" stroke-linejoin="round"/><path d="M15 21 L21 15 M18 18 L24 24" stroke="#18181b" stroke-width="3" stroke-linecap="round"/><path d="M15 21 L21 15 M18 18 L24 24" stroke="#fda4af" stroke-width="1.5" stroke-linecap="round"/></svg>')}") 3 3, crosshair`
const HAND_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="8" fill="#14532d" stroke="#18181b" stroke-width="1.5"/><path d="M13 8 V18 M8 13 H18" stroke="#86efac" stroke-width="2.5" stroke-linecap="round"/></svg>')}") 13 13, pointer`

// How far the primary reaches, for auto-attack.
function reach(a: AbilityDef): number {
  const t = a.target
  switch (t.kind) {
    case 'projectile':
    case 'hitscan':
    case 'beam':
    case 'targeted':
      return t.range
    case 'melee':
    case 'cone':
      return t.range + 1
    default:
      return 0
  }
}

// Whether pressing this ability wants an enemy selected first.
function wantsEnemy(a: AbilityDef): boolean {
  const t = a.target
  switch (t.kind) {
    case 'projectile':
      return !t.gravity && !t.hazard && t.side !== 'ally'
    case 'hitscan':
    case 'beam':
    case 'melee':
      return true
    case 'targeted':
      return t.side === 'enemy'
    case 'dash':
      return t.toTarget === true
    default:
      return false
  }
}

// One match (or training visit): transport, prediction, rendering, HUD feed.
export class Session {
  readonly transport: Transport
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
  // Classic controls: selection, heal target and auto-attack live here.
  classic: boolean
  readonly targeting = new Targeting()
  private readonly rings: TargetRings
  private units: Unit[] = []
  private lastButtons = 0

  constructor(
    private readonly renderer: Renderer,
    private readonly input: Input,
    private readonly hud: Hud,
    private readonly audio: Audio,
    private readonly pointer: Pointer,
    readonly opts: SessionOptions,
  ) {
    this.mode = opts.config.mode
    this.classic = opts.controls === 'classic'
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
    this.rings = new TargetRings(renderer.scene)
    this.transport =
      opts.transport ??
      new LocalTransport(opts.config, opts.myId, { lagMs: opts.lagMs, jitterMs: opts.jitterMs })
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
      await this.renderer.compile(this.renderer.scene)
    } catch {
      // compileAsync is an optimisation; rendering compiles lazily anyway
    }
    this.renderer.scene.remove(warm)
    // Let the first real frames draw (some drivers finish shader work there)
    // so the reveal and the countdown start on a smooth frame.
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await nextFrame()
    await nextFrame()
    await nextFrame()
    this.ready = true
    // Online rooms wait for this before starting the gate countdown.
    this.transport.send({ type: 'ready' })
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
        if (!e.tick) this.avatars.get(e.dst)?.hit(e.amount >= 100 ? 0.65 : 0.4)
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

  setControls(scheme: ControlScheme): void {
    this.classic = scheme === 'classic'
    if (!this.classic) this.targeting.auto = false
  }

  private unit(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id)
  }

  private myUnit(): Unit | undefined {
    return this.unit(this.opts.myId)
  }

  // A unit clicked in the world or on a frame: enemies become the target,
  // allies (and yourself) the heal target. Right-click also starts attacking.
  select(id: number, attack = false): void {
    const u = this.unit(id)
    const me = this.myUnit()
    if (!u || !me || !u.alive) return
    if (u.team === me.team) {
      this.targeting.ally = id
      return
    }
    this.targeting.target = id
    if (attack) this.targeting.auto = true
  }

  click(button: number, x: number, y: number): void {
    const id = this.targeting.pick(this.units, x, y, this.renderer.camera)
    if (id >= 0) this.select(id, button === 2)
  }

  tabTarget(): void {
    const me = this.myUnit()
    if (!me) return
    this.targeting.target = this.targeting.next(this.units, me, this.renderer.camera)
  }

  // Escape: drop the target first (and stop attacking). False if nothing to drop.
  clearTarget(): boolean {
    const t = this.targeting
    if (t.target < 0 && !t.auto) return false
    t.target = -1
    t.auto = false
    return true
  }

  // Classic: fill in who we target, who we heal and where the cursor is.
  private classicCmd(cmd: InputCmd): void {
    const t = this.targeting
    const meSnap = this.me()
    const me = this.myUnit()
    if (!meSnap || !me) return
    const sel = this.unit(t.target)
    if (t.target >= 0 && !sel?.alive) {
      t.target = -1
      t.auto = false
    }
    const cls = CLASSES[meSnap.cls]
    const fresh = cmd.buttons & ~this.lastButtons
    this.lastButtons = cmd.buttons
    if (fresh & Btn.FocusSelf) t.ally = me.id
    if (fresh & Btn.FocusAlly) {
      const partner = this.units.find((u) => u.team === me.team && u.id !== me.id && u.alive)
      if (partner) t.ally = partner.id
    }
    // Casting with nothing selected picks the enemy in front.
    if (t.target < 0) {
      for (const slot of SLOTS) {
        const a = abilityAt(cls, slot)
        if (!a || !(fresh & SLOT_BUTTON[slot]) || !wantsEnemy(a)) continue
        t.target = t.acquire(this.units, me, this.renderer.camera, (u) => this.sees(me, u))
        break
      }
    }
    // The primary key starts auto-attack on the target.
    if (fresh & Btn.Lmb && t.target >= 0) t.auto = true
    const target = this.unit(t.target)
    if (t.auto && target) {
      const d = Math.hypot(target.x - me.x, target.z - me.z)
      if (d <= reach(cls.abilities.lmb)) cmd.buttons |= Btn.Lmb
    }
    cmd.target = t.target
    // Heals go to the ally under the cursor, else the chosen one, else you.
    const hovered = this.unit(t.hover)
    const healTo = hovered && hovered.team === me.team ? hovered : this.unit(t.ally)
    cmd.ally = healTo?.alive ? healTo.id : me.id
    const g = t.ground(this.pointer.x, this.pointer.y, this.renderer.camera, this.world)
    if (g) {
      cmd.aimX = g.x
      cmd.aimY = g.y
      cmd.aimZ = g.z
    }
  }

  private sees(a: Unit, b: Unit): boolean {
    return this.world.lineOfSight(a.x, a.y + 1.5, a.z, b.x, b.y + b.height * 0.62, b.z)
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
    const active = this.input.active
    const cmd: InputCmd = d
      ? {
          seq: ++this.seq,
          moveX: d.moveX ?? 0,
          moveZ: d.moveZ ?? 0,
          yaw: this.input.yaw,
          pitch: this.input.pitch,
          buttons: d.buttons ?? 0,
        }
      : {
          seq: ++this.seq,
          moveX: active ? this.input.moveX() : 0,
          moveZ: active ? this.input.moveZ() : 0,
          yaw: this.input.yaw,
          pitch: this.input.pitch,
          buttons: active ? this.input.buttons() : 0,
        }
    if (this.classic) this.classicCmd(cmd)
    return cmd
  }

  update(dt: number): void {
    this.time += dt
    // Online the server owns time: no slow motion or hit-stop in the tick rate.
    let scale = this.transport.online ? 1 : this.timeScale
    if (this.hitStop > 0) {
      this.hitStop -= dt
      if (!this.transport.online) scale *= 0.08
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
    this.cam.distance = this.classic ? this.pointer.zoom : CAMERA.distance
    this.cam.shoulder = this.classic ? 0.3 : CAMERA.shoulder
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

    this.units = views.map((v) => ({
      id: v.id,
      team: snap.fighters.find((f) => f.id === v.id)?.team ?? 0,
      x: v.x,
      y: v.y,
      z: v.z,
      height: v.height,
      alive: v.alive,
    }))
    this.updateClassic(dt)

    // HUD
    if (me) {
      const meView: FighterSnap = { ...me, x: this.renderPos.x, y: this.renderPos.y, z: this.renderPos.z }
      if (this.classic) {
        meView.target = this.targeting.target
        meView.focus = this.targeting.ally >= 0 ? this.targeting.ally : me.id
      }
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

  private updateClassic(dt: number): void {
    const t = this.targeting
    if (!this.classic) {
      this.pointer.setCursor('')
      const target = this.unit(this.me()?.target ?? -1)
      this.rings.update(dt, target ?? null, null, null)
      return
    }
    t.hover = this.pointer.dragging
      ? -1
      : t.pick(this.units, this.pointer.x, this.pointer.y, this.renderer.camera)
    const me = this.myUnit()
    const hovered = this.unit(t.hover)
    this.pointer.setCursor(
      !hovered || !me || hovered.id === me.id ? '' : hovered.team === me.team ? HAND_CURSOR : SWORD_CURSOR,
    )
    const target = this.unit(t.target)
    const ally = t.ally !== this.opts.myId ? this.unit(t.ally) : undefined
    const hover = hovered && hovered.id !== t.target && hovered.id !== t.ally ? hovered : undefined
    this.rings.update(
      dt,
      target?.alive ? target : null,
      ally?.alive ? ally : null,
      hover && hover.id !== this.opts.myId ? hover : null,
    )
  }

  dispose(): void {
    this.pointer.setCursor('')
    this.rings.dispose()
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
