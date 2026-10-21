import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { SimEvent } from '../../shared/combat/events'
import { getAbility } from '../../shared/combat/registry'
import type { AbilityDef, Element } from '../../shared/combat/types'
import type { Snapshot } from '../../shared/net/protocol'
import {
  beamMaterial,
  decalMaterial,
  flameMaterial,
  fxTime,
  orbMaterial,
  runeMaterial,
  shieldMaterial,
  shockwaveMaterial,
  slashMaterial,
} from './fx/materials'
import { FxSystem, type Palette } from './fx/system'
import { Particles } from './particles'
import { NOISE_GLSL } from './shaderlib'

export const ELEMENT: Record<Element, Palette> = {
  fire: { core: '#fff1c2', glow: '#ff7a1a', spark: '#ffb347' },
  water: { core: '#e6fbff', glow: '#2fb8ff', spark: '#9ae6ff' },
  poison: { core: '#f2ffd0', glow: '#8be02b', spark: '#b26bff' },
  psychic: { core: '#fff0ff', glow: '#e05cff', spark: '#ffa6ff' },
  grass: { core: '#f3ffe8', glow: '#4ade80', spark: '#ffc2e2' },
  normal: { core: '#ffffff', glow: '#d4d4d8', spark: '#fafafa' },
}

// A few moves get their own palette.
const OVERRIDE: Record<string, Palette> = {
  'night-slash': { core: '#f5e1ff', glow: '#7c3aed', spark: '#2e1065' },
  toxic: { core: '#f5e1ff', glow: '#a855f7', spark: '#84cc16' },
  'sleep-powder': { core: '#f0fff4', glow: '#86efac', spark: '#bbf7d0' },
  'floral-healing': { core: '#fff1f8', glow: '#f472b6', spark: '#fbcfe8' },
  aromatherapy: { core: '#fff1f8', glow: '#f9a8d4', spark: '#fde68a' },
  'jungle-healing': { core: '#f7fee7', glow: '#22c55e', spark: '#fde047' },
  'life-dew': { core: '#ecfeff', glow: '#67e8f9', spark: '#a5f3fc' },
  'pollen-puff': { core: '#fffbeb', glow: '#facc15', spark: '#fde68a' },
  hypnosis: { core: '#faf5ff', glow: '#a855f7', spark: '#e9d5ff' },
  'future-sight': { core: '#fdf4ff', glow: '#c026d3', spark: '#f0abfc' },
  'lum-berry': { core: '#fff7ed', glow: '#fb923c', spark: '#fde047' },
  'will-o-wisp': { core: '#e0f2fe', glow: '#3b82f6', spark: '#a5b4fc' },
  overheat: { core: '#fff7d6', glow: '#ff4d00', spark: '#ffd166' },
  scald: { core: '#fff7ed', glow: '#38bdf8', spark: '#fdba74' },
  'rain-dance': { core: '#ecfeff', glow: '#38bdf8', spark: '#bae6fd' },
  withdraw: { core: '#f0f9ff', glow: '#7dd3fc', spark: '#e0f2fe' },
  venoshock: { core: '#f7fee7', glow: '#84cc16', spark: '#a855f7' },
  smokescreen: { core: '#e4e4e7', glow: '#71717a', spark: '#d4d4d8' },
  'shadow-sneak': { core: '#ede9fe', glow: '#6d28d9', spark: '#312e81' },
  'magic-coat': { core: '#f5f3ff', glow: '#8b5cf6', spark: '#ddd6fe' },
  'dream-eater': { core: '#fdf4ff', glow: '#d946ef', spark: '#f0abfc' },
  nightmare: { core: '#ede9fe', glow: '#7c3aed', spark: '#1e1b4b' },
  'leech-seed': { core: '#f0fdf4', glow: '#22c55e', spark: '#86efac' },
  ingrain: { core: '#f7fee7', glow: '#65a30d', spark: '#bef264' },
  'spiky-shield': { core: '#f0fdf4', glow: '#16a34a', spark: '#bbf7d0' },
}

export function palette(abilityId: string): Palette {
  const o = OVERRIDE[abilityId]
  if (o) return o
  const a = getAbility(abilityId)
  return ELEMENT[a?.element ?? 'normal']
}

export function abilityColors(abilityId: string): Palette {
  return palette(abilityId)
}

interface ProjectileView {
  mesh: Group
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  gravity: number
  t0: number
  seen: boolean
  p: Palette
  ability: string
  spin: Mesh | null
}

export interface FighterView {
  id: number
  x: number
  y: number
  z: number
  yaw: number
  alive: boolean
  height: number
  auras: readonly string[]
  dashing: boolean
  dashColor: string
  cast?: string | null
  castFrac?: number
}

function hazardMaterial(color: string): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: fxTime,
      uColor: { value: new Color(color) },
      uLife: { value: 1 },
      uFill: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uLife; uniform float uFill;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        float a = atan(p.y, p.x);
        float swirl = fbm(vec2(a * 2.0 + uTime * 1.5 - r * 3.0, r * 4.0 - uTime));
        float rim = smoothstep(0.86, 0.97, r) * smoothstep(1.0, 0.97, r);
        float body = smoothstep(1.0, 0.2, r) * (0.14 + swirl * 0.45);
        float fill = smoothstep(uFill, uFill - 0.04, r) * step(0.001, uFill) * 0.35;
        float dash = step(0.5, fract(a * 6.0 / 6.28318 - uTime * 0.5)) * rim;
        float alpha = (rim * 0.9 + dash * 0.6 + body + fill) * uLife;
        gl_FragColor = vec4(uColor * (1.3 + swirl), alpha);
      }
    `,
  })
}

const tmp = new Vector3()
const up = new Vector3(0, 1, 0)

interface Persistent {
  mesh: Mesh
  mat: ShaderMaterial
  seen: boolean
}

export class Vfx {
  readonly group = new Group()
  readonly particles = new Particles()
  readonly fx: FxSystem
  private projectiles = new Map<number, ProjectileView>()
  private hazards = new Map<
    number,
    { mesh: Mesh; mat: ShaderMaterial; rem: number; total: number; ability: string; p: Palette }
  >()
  private delayed = new Map<
    number,
    { mesh: Mesh; mat: ShaderMaterial; rem: number; total: number; ability: string; target: number }
  >()
  private beams = new Map<number, { mesh: Mesh; mat: ShaderMaterial; ttl: number }>()
  private runes = new Map<number, Persistent>()
  private auraFx = new Map<string, Persistent>()
  private readonly sphereGeo = new SphereGeometry(1, 16, 12)
  private time = 0
  private fighters: readonly FighterView[] = []

  constructor(scene: Scene) {
    this.fx = new FxSystem(this.particles)
    this.group.add(this.particles.points, this.fx.group)
    scene.add(this.group)
  }

  // Move warm-up meshes in front of a camera so a real draw includes them.
  warmupVisible(cam: { position: Vector3 }): void {
    this.group.traverse((o) => {
      if ((o as Mesh).isMesh && o.position.y < -100)
        o.position.set(cam.position.x * 0.5 + o.position.x, 2, cam.position.z * 0.5)
    })
  }

  // One mesh per effect shader, parked under the floor so the renderer can
  // compile them all up front instead of hitching on the first cast.
  warmupObjects(): Group {
    const g = new Group()
    const geo = new SphereGeometry(0.5, 8, 6)
    const p = ELEMENT.fire
    const mats = [
      orbMaterial(p.core, p.glow),
      flameMaterial(p.core, p.glow),
      shockwaveMaterial(p.glow),
      shieldMaterial(p.glow),
      beamMaterial(p.core, p.glow),
      slashMaterial(p.glow),
      runeMaterial(p.glow),
      decalMaterial(p.glow, true),
      decalMaterial(p.glow, false),
      hazardMaterial(p.glow),
      new MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    ]
    mats.forEach((m, i) => {
      const mesh = new Mesh(geo, m)
      mesh.position.set(i * 1.2, -300, 0)
      mesh.frustumCulled = false
      g.add(mesh)
    })
    return g
  }

  private fighter(id: number): FighterView | undefined {
    return this.fighters.find((f) => f.id === id)
  }

  private chest(id: number): Vector3 | undefined {
    const f = this.fighter(id)
    return f ? tmp.set(f.x, f.y + f.height * 0.62, f.z) : undefined
  }

  // ---- snapshot-driven objects ------------------------------------------

  sync(snap: Snapshot, serverTime: number): void {
    for (const v of this.projectiles.values()) v.seen = false
    for (const pr of snap.projectiles) {
      let v = this.projectiles.get(pr.id)
      const ability = getAbility(pr.ability)
      if (!v) {
        v = this.makeProjectile(pr.ability, ability, pr.x, pr.y, pr.z, serverTime)
        this.projectiles.set(pr.id, v)
      }
      v.x = pr.x
      v.y = pr.y
      v.z = pr.z
      v.vx = pr.vx
      v.vy = pr.vy
      v.vz = pr.vz
      v.gravity = ability?.target.kind === 'projectile' ? (ability.target.gravity ?? 0) : 0
      v.t0 = serverTime
      v.seen = true
    }
    for (const [id, v] of this.projectiles) {
      if (!v.seen) {
        this.group.remove(v.mesh)
        v.mesh.traverse((o) => ((o as Mesh).material as ShaderMaterial | undefined)?.dispose?.())
        this.projectiles.delete(id)
      }
    }

    const liveHazards = new Set<number>()
    for (const h of snap.hazards) {
      liveHazards.add(h.id)
      let v = this.hazards.get(h.id)
      if (!v) {
        const p = palette(h.ability)
        const mat = hazardMaterial(p.glow)
        const mesh = new Mesh(new CircleGeometry(h.radius, 48), mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set(h.x, h.y + 0.06, h.z)
        this.group.add(mesh)
        v = { mesh, mat, rem: h.rem, total: Math.max(h.rem, 0.1), ability: h.ability, p }
        this.hazards.set(h.id, v)
      }
      v.rem = h.rem
    }
    for (const [id, v] of this.hazards) {
      if (!liveHazards.has(id)) {
        this.group.remove(v.mesh)
        v.mesh.geometry.dispose()
        v.mat.dispose()
        this.hazards.delete(id)
      }
    }

    const liveDelayed = new Set<number>()
    for (const d of snap.delayed) {
      liveDelayed.add(d.id)
      let v = this.delayed.get(d.id)
      if (!v) {
        const p = palette(d.ability)
        const mat = hazardMaterial(p.glow)
        const mesh = new Mesh(new CircleGeometry(d.radius, 48), mat)
        mesh.rotation.x = -Math.PI / 2
        this.group.add(mesh)
        v = { mesh, mat, rem: d.rem, total: Math.max(d.rem, 0.1), ability: d.ability, target: d.target }
        this.delayed.set(d.id, v)
        if (d.ability === 'eruption') this.fx.meteor(d.x, d.y, d.z, d.rem, p)
      }
      v.rem = d.rem
      v.mesh.position.set(d.x, d.y + 0.08, d.z)
    }
    for (const [id, v] of this.delayed) {
      if (!liveDelayed.has(id)) {
        this.group.remove(v.mesh)
        v.mesh.geometry.dispose()
        v.mat.dispose()
        this.delayed.delete(id)
      }
    }
  }

  private makeProjectile(
    id: string,
    a: AbilityDef | undefined,
    x: number,
    y: number,
    z: number,
    t0: number,
  ): ProjectileView {
    const p = palette(id)
    const mesh = new Group()
    const radius = a?.target.kind === 'projectile' ? a.target.radius : 0.25
    const core = new Mesh(this.sphereGeo, orbMaterial(p.core, p.glow))
    core.scale.setScalar(radius * 1.1)
    mesh.add(core)
    const halo = new Mesh(
      this.sphereGeo,
      new MeshBasicMaterial({
        color: new Color(p.glow).multiplyScalar(1.6),
        transparent: true,
        opacity: 0.25,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    )
    halo.scale.setScalar(radius * 2.2)
    mesh.add(halo)
    let spin: Mesh | null = null
    if (id === 'confuse-ray' || id === 'dummy-confuse' || id === 'fire-spin' || id === 'thunder-wave') {
      spin = new Mesh(new TorusGeometry(radius * 1.8, radius * 0.18, 6, 24), orbMaterial(p.core, p.spark))
      mesh.add(spin)
    }
    if (id === 'water-gun') core.scale.set(radius * 0.9, radius * 0.9, radius * 1.8)
    mesh.position.set(x, y, z)
    this.group.add(mesh)
    return { mesh, x, y, z, vx: 0, vy: 0, vz: 0, gravity: 0, t0, seen: true, p, ability: id, spin }
  }

  private beam(
    srcId: number,
    x: number,
    y: number,
    z: number,
    tx: number,
    ty: number,
    tz: number,
    p: Palette,
    width: number,
    ttl: number,
  ): void {
    let b = this.beams.get(srcId)
    if (!b) {
      const made = this.fx.beamMesh(p)
      b = { mesh: made.mesh, mat: made.mat, ttl }
      this.beams.set(srcId, b)
    }
    b.ttl = ttl
    const len = Math.hypot(tx - x, ty - y, tz - z)
    b.mesh.position.set((x + tx) / 2, (y + ty) / 2, (z + tz) / 2)
    tmp.set(tx - x, ty - y, tz - z).normalize()
    b.mesh.quaternion.setFromUnitVectors(up, tmp)
    b.mesh.scale.set(width, len, width)
  }

  // ---- event recipes -----------------------------------------------------

  onEvent(e: SimEvent, fighterPos: (id: number) => FighterView | undefined): void {
    const P = this.particles
    const fx = this.fx
    switch (e.t) {
      case 'use': {
        const a = getAbility(e.ability)
        if (!a) return
        const p = palette(a.id)
        const t = a.target
        const src = fighterPos(e.src)
        switch (t.kind) {
          case 'beam':
            this.beam(e.src, e.x, e.y, e.z, e.tx, e.ty, e.tz, p, a.id === 'hydro-pump' ? 0.7 : 0.34, 0.22)
            if (e.target >= 0) P.burst(e.tx, e.ty, e.tz, p.spark, 3, 3, 0.3, 0.25)
            break
          case 'hitscan':
            fx.beamOnce(e.x, e.y, e.z, e.tx, e.ty, e.tz, a.id === 'vine-whip' ? 0.12 : 0.2, p, 0.2)
            fx.flash(e.tx, e.ty, e.tz, 0.5, p, 0.22)
            P.burst(e.tx, e.ty, e.tz, p.spark, 16, 6, 0.35, 0.4)
            if (a.id === 'extrasensory') fx.shockwave(e.tx, e.ty, e.tz, 1.6, p.glow, 0.35, true)
            break
          case 'melee':
          case 'cone': {
            if (!src) return
            const big = a.slot === 'rmb'
            if (t.kind === 'melee') {
              const tilt = (Math.random() < 0.5 ? -1 : 1) * (0.65 + Math.random() * 0.4)
              fx.slash(
                src.x,
                src.y + 1.05,
                src.z,
                src.yaw,
                t.range * (big ? 1.15 : 0.95),
                t.angle,
                p.glow,
                tilt,
                big ? 0.3 : 0.18,
              )
              if (big)
                fx.slash(
                  src.x,
                  src.y + 1.1,
                  src.z,
                  src.yaw,
                  t.range * 1.25,
                  t.angle * 0.9,
                  p.spark,
                  -tilt,
                  0.35,
                )
              if (a.id === 'venoshock') {
                const hx = src.x + Math.cos(src.yaw) * 1.6
                const hz = src.z + Math.sin(src.yaw) * 1.6
                fx.flash(hx, src.y + 1.1, hz, 0.9, p, 0.3)
                fx.shockwave(hx, src.y + 1.1, hz, 2.2, p.glow, 0.35, true)
                P.burst(hx, src.y + 1.1, hz, p.spark, 40, 7, 0.45, 0.6, 6)
              }
            } else if (a.id === 'surf') {
              fx.wave(src.x, src.y, src.z, src.yaw, t.range, 7, p.glow, 0.45)
            } else if (a.element === 'fire') {
              fx.wave(src.x, src.y, src.z, src.yaw, t.range, 8, '#ff7a1a', 0.4)
              for (let i = 0; i < 70; i++) {
                const ang = src.yaw + (Math.random() - 0.5) * t.angle
                const sp = t.range * (1.1 + Math.random() * 0.9)
                P.emit(
                  src.x + Math.cos(src.yaw) * 0.6,
                  src.y + 0.6 + Math.random() * 0.8,
                  src.z + Math.sin(src.yaw) * 0.6,
                  Math.cos(ang) * sp,
                  1 + Math.random() * 2,
                  Math.sin(ang) * sp,
                  i % 3 === 0 ? '#ffd166' : i % 3 === 1 ? '#ff7a1a' : '#7a2e12',
                  0.6,
                  0.45,
                  2.2,
                )
              }
            } else {
              // Glare: an eye flash then a stunning cone
              fx.flash(
                src.x + Math.cos(src.yaw) * 0.6,
                src.y + 1.5,
                src.z + Math.sin(src.yaw) * 0.6,
                0.5,
                { core: '#fffbeb', glow: '#facc15', spark: '#fde047' },
                0.3,
              )
              for (let i = 0; i < 50; i++) {
                const ang = src.yaw + (Math.random() - 0.5) * t.angle
                const sp = t.range * (1.2 + Math.random())
                P.emit(
                  src.x,
                  src.y + 1.2,
                  src.z,
                  Math.cos(ang) * sp,
                  (Math.random() - 0.3) * 2,
                  Math.sin(ang) * sp,
                  '#fde047',
                  0.4,
                  0.4,
                  2.5,
                )
              }
            }
            break
          }
          case 'dash':
            if (!src) return
            fx.shockwave(src.x, src.y + 0.1, src.z, 1.6, p.glow, 0.35)
            P.burst(src.x, src.y + 0.8, src.z, p.spark, 18, 5, 0.4, 0.4)
            if (a.id === 'teleport') {
              fx.flash(src.x, src.y + 1, src.z, 0.9, p, 0.3)
              fx.flash(e.tx, e.ty + 1, e.tz, 0.9, p, 0.35)
              fx.shockwave(e.tx, e.ty + 0.1, e.tz, 2, p.glow, 0.4)
            }
            break
          case 'nova':
            fx.shockwave(e.x, e.y + 0.1, e.z, 14, p.glow, 0.9)
            fx.shockwave(e.x, e.y + 0.15, e.z, 8, p.spark, 0.7)
            for (let i = 0; i < 90; i++) {
              const ang = Math.random() * Math.PI * 2
              const sp = 4 + Math.random() * 10
              P.emit(
                e.x,
                e.y + 0.5,
                e.z,
                Math.cos(ang) * sp,
                1 + Math.random() * 3,
                Math.sin(ang) * sp,
                i % 3 ? p.glow : p.spark,
                0.5,
                1.2,
                1.2,
                -0.5,
              )
            }
            break
          case 'self':
            if (a.id === 'withdraw') {
              fx.flash(e.x, e.y + 1, e.z, 1.2, p, 0.3)
              fx.shockwave(e.x, e.y + 0.1, e.z, 3, p.glow, 0.5)
              P.burst(e.x, e.y + 1, e.z, '#e0f2fe', 40, 5, 0.4, 0.6, 6)
            } else if (a.id === 'magic-coat') {
              for (let k = 0; k < 3; k++)
                fx.shockwave(e.x, e.y + 1, e.z, 1.6 + k * 0.6, p.glow, 0.4 + k * 0.1, true)
              P.burst(e.x, e.y + 1, e.z, p.spark, 30, 3, 0.4, 0.7)
            } else if (a.id === 'ingrain') {
              fx.shockwave(e.x, e.y + 0.05, e.z, 2.6, p.glow, 0.7)
              fx.decal(e.x, e.y, e.z, 1.4, '#1a2e05', true, 6)
              for (let i = 0; i < 36; i++) {
                const ang = Math.random() * Math.PI * 2
                P.emit(e.x, e.y + 0.1, e.z, Math.cos(ang) * 3, 0.4, Math.sin(ang) * 3, p.spark, 0.4, 0.8, 3)
              }
            } else if (a.slot === 'c') {
              fx.flash(e.x, e.y + 1, e.z, 0.8, p, 0.3)
              fx.shockwave(e.x, e.y + 0.1, e.z, 2.4, '#ffffff', 0.4)
              P.burst(e.x, e.y + 1, e.z, '#fde047', 30, 6, 0.4, 0.6)
            } else {
              fx.shockwave(e.x, e.y + 0.1, e.z, 1.8, p.glow, 0.4)
              P.burst(e.x, e.y + 1, e.z, p.spark, 24, 4, 0.4, 0.6)
            }
            break
          case 'targeted': {
            if (a.blinkBehind) {
              if (src) {
                P.burst(src.x, src.y + 1, src.z, p.glow, 30, 3, 0.7, 0.6)
                fx.shockwave(src.x, src.y + 0.1, src.z, 1.6, p.glow, 0.35)
              }
              fx.flash(e.x, e.y, e.z, 0.8, p, 0.25)
              P.burst(e.x, e.y, e.z, p.spark, 30, 4, 0.6, 0.5)
              this.arrive(a, e.tx, e.ty, e.tz)
              break
            }
            const target = e.target
            const size = a.slot === 'r' ? 0.45 : a.slot === 'rmb' ? 0.38 : 0.28
            fx.travel(
              e.x,
              e.y,
              e.z,
              () => this.chest(target),
              a.id === 'fire-blast' ? 0.16 : 0.24,
              size,
              p,
              (at) => this.arrive(a, at.x, at.y, at.z),
            )
            break
          }
          case 'projectile':
            fx.flash(e.x, e.y, e.z, 0.25, p, 0.12)
            P.burst(e.x, e.y, e.z, p.spark, 5, 2.5, 0.25, 0.2)
            break
          case 'ground':
            break
        }
        break
      }
      case 'impact': {
        const a = getAbility(e.ability)
        const p = palette(e.ability)
        const big = a ? a.slot !== 'lmb' : false
        const el = a?.element ?? 'normal'
        fx.flash(e.x, e.y, e.z, big ? 1.0 : 0.55, p, big ? 0.3 : 0.18)
        if (el === 'water') {
          for (let i = 0; i < (big ? 30 : 14); i++) {
            P.emit(
              e.x,
              e.y,
              e.z,
              (Math.random() - 0.5) * 6,
              2 + Math.random() * 4,
              (Math.random() - 0.5) * 6,
              i % 2 ? '#e0f7ff' : p.glow,
              0.3,
              0.6,
              0.8,
              14,
            )
          }
        } else if (el === 'grass') {
          P.burst(e.x, e.y, e.z, '#fde68a', big ? 30 : 14, 3, 0.45, 0.9, -0.5)
        } else if (el === 'poison') {
          for (let i = 0; i < (big ? 24 : 12); i++) {
            P.emit(
              e.x,
              e.y,
              e.z,
              (Math.random() - 0.5) * 5,
              Math.random() * 3,
              (Math.random() - 0.5) * 5,
              i % 2 ? '#a3e635' : '#7c3aed',
              0.4,
              0.6,
              1.5,
              9,
            )
          }
        } else {
          P.burst(e.x, e.y, e.z, p.spark, big ? 30 : 12, big ? 7 : 4.5, big ? 0.45 : 0.3, 0.45, 4)
        }
        if (e.ny > 0.7) {
          fx.shockwave(e.x, e.y + 0.05, e.z, big ? 3.2 : 1.5, p.glow, 0.4)
          if (el === 'fire') fx.decal(e.x, e.y, e.z, big ? 1.6 : 0.6, '#1a0c06', true, 3)
        } else if (big) {
          fx.shockwave(e.x, e.y, e.z, 2.4, p.glow, 0.35, true)
        }
        break
      }
      case 'detonate': {
        const p = palette(e.ability)
        if (e.ability === 'eruption') {
          fx.flash(e.x, e.y + 1, e.z, e.radius * 0.5, p, 0.4)
          fx.firePillar(e.x, e.y, e.z, e.radius * 0.55, 9, '#ffcf5a', '#d93a06', 1.0)
          fx.shockwave(e.x, e.y + 0.1, e.z, e.radius * 1.6, '#ffb347', 0.6)
          fx.decal(e.x, e.y, e.z, e.radius * 1.1, '#120804', true, 6)
          for (let i = 0; i < 120; i++) {
            const ang = Math.random() * Math.PI * 2
            const sp = 3 + Math.random() * 11
            P.emit(
              e.x,
              e.y + 0.5,
              e.z,
              Math.cos(ang) * sp,
              4 + Math.random() * 9,
              Math.sin(ang) * sp,
              i % 3 ? '#ff7a1a' : '#3f2a20',
              0.7,
              1.2,
              1,
              14,
            )
          }
        } else {
          // Future Sight: the vision collapses into the target
          fx.flash(e.x, e.y + 1.2, e.z, 1.4, p, 0.35)
          fx.shockwave(e.x, e.y + 1.2, e.z, e.radius * 2, p.glow, 0.5, true)
          fx.shockwave(e.x, e.y + 0.1, e.z, e.radius * 1.4, p.spark, 0.5)
          P.burst(e.x, e.y + 1.2, e.z, p.spark, 70, 10, 0.5, 0.8)
        }
        break
      }
      case 'interrupt': {
        const f = fighterPos(e.dst)
        if (!f) return
        const y = f.y + f.height * 0.75
        fx.flash(f.x, y, f.z, 0.8, { core: '#ffffff', glow: '#7dd3fc', spark: '#e0f2fe' }, 0.25)
        fx.shockwave(f.x, y, f.z, 2.2, '#bae6fd', 0.35, true)
        for (let i = 0; i < 40; i++) {
          P.emit(
            f.x,
            y,
            f.z,
            (Math.random() - 0.5) * 12,
            (Math.random() - 0.2) * 10,
            (Math.random() - 0.5) * 12,
            i % 2 ? '#ffffff' : '#7dd3fc',
            0.3,
            0.45,
            2,
            12,
          )
        }
        break
      }
      case 'heal': {
        if (e.tick) return
        const f = fighterPos(e.dst)
        if (!f) return
        const p = palette(e.ability)
        for (let i = 0; i < 30; i++) {
          const a2 = Math.random() * Math.PI * 2
          const r = 0.3 + Math.random() * 0.5
          P.emit(
            f.x + Math.cos(a2) * r,
            f.y + 0.2 + Math.random() * 0.4,
            f.z + Math.sin(a2) * r,
            0,
            2.5 + Math.random() * 2.5,
            0,
            i % 2 ? p.spark : p.glow,
            0.35,
            1.1,
            1,
          )
        }
        fx.shockwave(f.x, f.y + 0.1, f.z, 1.4, p.glow, 0.6)
        break
      }
      case 'aura': {
        if (e.action !== 'apply') return
        const f = fighterPos(e.dst)
        if (!f) return
        if (e.aura === 'paralysis') fx.shockwave(f.x, f.y + 1, f.z, 1.4, '#fde047', 0.3, true)
        if (e.aura === 'hypnosis' || e.aura === 'sleep-powder')
          fx.shockwave(f.x, f.y + 2, f.z, 1.2, '#c4b5fd', 0.5)
        break
      }
      case 'death': {
        const f = fighterPos(e.dst)
        if (!f) return
        fx.flash(f.x, f.y + 1, f.z, 1.1, { core: '#ffffff', glow: '#fda4af', spark: '#ffffff' }, 0.4)
        fx.shockwave(f.x, f.y + 0.1, f.z, 3.5, '#ffffff', 0.7)
        P.burst(f.x, f.y + 1, f.z, '#ffffff', 60, 8, 0.5, 1.0, 3)
        break
      }
      default:
        break
    }
  }

  // Effects at the target when a targeted spell lands.
  private arrive(a: AbilityDef, x: number, y: number, z: number): void {
    const P = this.particles
    const fx = this.fx
    const p = palette(a.id)
    switch (a.id) {
      case 'fire-blast':
        fx.flash(x, y, z, 1.6, p, 0.34)
        fx.shockwave(x, y - 1, z, 4.5, '#ffb347', 0.5)
        fx.shockwave(x, y, z, 2.6, '#ff7a1a', 0.35, true)
        fx.firePillar(x, y - 1.1, z, 1.4, 4.6, '#ffcf5a', '#e2450a', 0.7)
        fx.decal(x, y - 1.1, z, 1.8, '#1a0c06', true, 4)
        P.burst(x, y, z, '#ffb347', 70, 10, 0.55, 0.7, 5)
        break
      case 'hypnosis':
        for (let k = 0; k < 4; k++)
          fx.shockwave(x, y + 0.6, z, 1.4 + k * 0.9, k % 2 ? p.spark : p.glow, 0.45 + k * 0.15, true)
        fx.flash(x, y + 0.6, z, 0.9, p, 0.3)
        P.burst(x, y + 0.6, z, p.spark, 40, 3.5, 0.45, 1.1)
        break
      case 'toxic':
        fx.flash(x, y, z, 0.9, p, 0.3)
        for (let i = 0; i < 40; i++)
          P.emit(
            x,
            y,
            z,
            (Math.random() - 0.5) * 5,
            Math.random() * 4,
            (Math.random() - 0.5) * 5,
            i % 2 ? '#a855f7' : '#84cc16',
            0.5,
            1,
            1.5,
            3,
          )
        break
      case 'future-sight':
        fx.shockwave(x, y + 1.5, z, 2.4, p.glow, 0.7)
        fx.shockwave(x, y + 0.1, z, 2.6, p.spark, 0.8)
        P.burst(x, y + 1.5, z, p.spark, 36, 2.5, 0.45, 0.9)
        break
      case 'overheat':
        fx.flash(x, y, z, 2.2, p, 0.4)
        fx.shockwave(x, y - 1, z, 6, '#ffb347', 0.6)
        fx.shockwave(x, y, z, 3.4, p.glow, 0.4, true)
        fx.firePillar(x, y - 1.1, z, 2, 7, '#fff1c2', '#ff4d00', 0.9)
        fx.decal(x, y - 1.1, z, 2.4, '#1a0c06', true, 5)
        P.burst(x, y, z, '#ffd166', 110, 13, 0.6, 0.8, 5)
        break
      case 'will-o-wisp':
      case 'nightmare':
        fx.flash(x, y, z, 0.8, p, 0.3)
        fx.shockwave(x, y, z, 1.8, p.glow, 0.4, true)
        P.burst(x, y, z, p.spark, 34, 3, 0.5, 0.9, -1)
        break
      case 'dream-eater':
        fx.flash(x, y, z, 1.2, p, 0.35)
        for (let k = 0; k < 3; k++) fx.shockwave(x, y, z, 1.2 + k * 0.8, k % 2 ? p.spark : p.glow, 0.4, true)
        P.burst(x, y, z, p.spark, 50, 5, 0.5, 0.8)
        break
      case 'leech-seed':
        fx.flash(x, y, z, 0.6, p, 0.3)
        P.burst(x, y, z, p.spark, 30, 3, 0.45, 0.9, 3)
        break
      case 'shadow-sneak':
        fx.slash(x, y, z, Math.random() * Math.PI * 2, 2.2, 2.4, p.glow, 0.8, 0.25)
        P.burst(x, y, z, p.spark, 26, 5, 0.45, 0.5, 4)
        break
      case 'spiky-shield':
        fx.shockwave(x, y - 1, z, 2.2, p.glow, 0.5)
        P.burst(x, y, z, p.spark, 30, 6, 0.35, 0.5)
        break
      default:
        // heals and buffs on allies
        fx.flash(x, y, z, 0.6, p, 0.3)
        P.burst(x, y, z, p.spark, 24, 3, 0.4, 0.8, -0.5)
        break
    }
  }

  // ---- per-frame ---------------------------------------------------------

  update(dt: number, serverTime: number, fighters: readonly FighterView[]): void {
    this.time += dt
    fxTime.value = this.time
    this.fighters = fighters
    const P = this.particles
    for (const v of this.projectiles.values()) {
      const t = Math.max(0, Math.min(0.2, serverTime - v.t0))
      const x = v.x + v.vx * t
      const y = v.y + v.vy * t - 0.5 * v.gravity * t * t
      const z = v.z + v.vz * t
      v.mesh.position.set(x, y, z)
      tmp.set(v.vx, v.vy - v.gravity * t, v.vz)
      if (tmp.lengthSq() > 0.01) v.mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), tmp.normalize())
      if (v.spin) {
        v.spin.rotation.x += dt * 9
        v.spin.rotation.y += dt * 5
      }
      const el = getAbility(v.ability)?.element
      if (el === 'fire') {
        for (let i = 0; i < 3; i++)
          P.emit(
            x,
            y,
            z,
            (Math.random() - 0.5) * 1.2,
            0.6 + Math.random(),
            (Math.random() - 0.5) * 1.2,
            i === 0 ? '#ffd166' : i === 1 ? v.p.glow : '#7a2e12',
            0.45,
            0.32,
            3,
          )
      } else if (el === 'water') {
        P.emit(
          x,
          y,
          z,
          (Math.random() - 0.5) * 0.6,
          (Math.random() - 0.5) * 0.6,
          (Math.random() - 0.5) * 0.6,
          i2(v.p),
          0.22,
          0.3,
          4,
          6,
        )
      } else if (el === 'grass') {
        P.emit(
          x,
          y,
          z,
          (Math.random() - 0.5) * 1.5,
          (Math.random() - 0.5) * 1.5,
          (Math.random() - 0.5) * 1.5,
          Math.random() < 0.5 ? '#fde68a' : v.p.glow,
          0.3,
          0.6,
          2,
          -0.3,
        )
      } else {
        P.emit(
          x,
          y,
          z,
          (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5) * 0.8,
          v.p.glow,
          0.32,
          0.3,
          4,
        )
      }
    }
    for (const h of this.hazards.values()) {
      h.mat.uniforms.uLife!.value = Math.min(1, h.rem * 3, (h.total - h.rem) * 6 + 0.2)
      const r = (h.mesh.geometry as CircleGeometry).parameters.radius
      const smoke = h.ability === 'smokescreen'
      for (let i = 0; i < (smoke ? 7 : 3); i++) {
        const a = Math.random() * Math.PI * 2
        const d = Math.sqrt(Math.random()) * r
        P.emit(
          h.mesh.position.x + Math.cos(a) * d,
          h.mesh.position.y + Math.random() * (smoke ? 3 : 1.5),
          h.mesh.position.z + Math.sin(a) * d,
          (Math.random() - 0.5) * 0.6,
          smoke ? 0.25 : 0.5,
          (Math.random() - 0.5) * 0.6,
          smoke ? (i % 2 ? '#52525b' : '#a1a1aa') : h.p.spark,
          smoke ? 1.6 : 0.5,
          smoke ? 1.8 : 0.9,
          1,
        )
      }
    }
    for (const d of this.delayed.values()) {
      d.mat.uniforms.uFill!.value = 1 - Math.max(0, d.rem) / d.total
      d.mat.uniforms.uLife!.value = 1
    }
    for (const [id, b] of this.beams) {
      b.ttl -= dt
      b.mat.uniforms.uLife!.value = Math.min(1, b.ttl * 7)
      if (b.ttl <= 0) {
        this.fx.dispose(b)
        this.beams.delete(id)
      }
    }

    this.updateRunes(fighters)
    this.updateAuraMeshes(fighters)

    for (const f of fighters) {
      if (!f.alive) continue
      if (f.dashing) {
        for (let i = 0; i < 5; i++)
          P.emit(
            f.x + (Math.random() - 0.5) * 0.4,
            f.y + 0.4 + Math.random() * 1.2,
            f.z + (Math.random() - 0.5) * 0.4,
            0,
            0.3,
            0,
            f.dashColor,
            0.55,
            0.4,
            3,
          )
      }
      for (const id of f.auras) this.auraParticles(id, f)
    }
    this.fx.update(dt)
    this.particles.update(dt)
  }

  // Rotating rune circle under anyone with a cast bar.
  private updateRunes(fighters: readonly FighterView[]): void {
    for (const r of this.runes.values()) r.seen = false
    for (const f of fighters) {
      if (!f.alive || !f.cast) continue
      const a = getAbility(f.cast)
      if (!a || !(a.castTime && a.castTime > 0)) continue
      let r = this.runes.get(f.id)
      if (!r) {
        const made = this.fx.rune(palette(a.id).glow, 1.25)
        r = { mesh: made.mesh, mat: made.mat, seen: true }
        this.runes.set(f.id, r)
      }
      r.seen = true
      const frac = f.castFrac ?? 0
      r.mesh.position.set(f.x, f.y + 0.05, f.z)
      r.mesh.scale.setScalar(1.0 + frac * 0.4)
      r.mat.uniforms.uLife!.value = Math.min(1, 0.4 + frac)
      // particles drawn in toward the hands
      const hx = f.x + Math.cos(f.yaw) * 0.5
      const hz = f.z + Math.sin(f.yaw) * 0.5
      const hy = f.y + 1.2
      const ang = Math.random() * Math.PI * 2
      const d = 1.2 + Math.random() * 0.6
      const sx = hx + Math.cos(ang) * d
      const sz = hz + Math.sin(ang) * d
      const sy = hy + (Math.random() - 0.5) * 1.2
      this.particles.emit(
        sx,
        sy,
        sz,
        (hx - sx) * 3,
        (hy - sy) * 3,
        (hz - sz) * 3,
        palette(a.id).spark,
        0.3,
        0.32,
        0,
      )
    }
    for (const [id, r] of this.runes) {
      if (!r.seen) {
        this.fx.dispose(r)
        this.runes.delete(id)
      }
    }
  }

  // Mesh-based status effects that read better than particles alone.
  private updateAuraMeshes(fighters: readonly FighterView[]): void {
    for (const v of this.auraFx.values()) v.seen = false
    for (const f of fighters) {
      if (!f.alive) continue
      for (const aura of f.auras) {
        const key = `${f.id}:${aura}`
        let v = this.auraFx.get(key)
        if (!v) {
          const made =
            aura === 'fire-spin'
              ? this.fx.flameRing('#ffcf5a', '#d93a06', 0.95, 2.2)
              : aura === 'aqua-ring'
                ? this.fx.waterRing('#67e8f9', 0.85)
                : aura === 'acid-armor'
                  ? this.fx.shield('#a3e635', 1.25, true)
                  : aura === 'hypnosis' || aura === 'sleep-powder'
                    ? this.fx.shield('#a78bfa', 1.15, false)
                    : aura === 'withdraw'
                      ? this.fx.shield('#7dd3fc', 1.2, true)
                      : aura === 'magic-coat'
                        ? this.fx.shield('#a78bfa', 1.35, false)
                        : aura === 'spiky-shield'
                          ? this.fx.shield('#22c55e', 1.25, true)
                          : aura === 'ingrain'
                            ? this.fx.waterRing('#84cc16', 0.95)
                            : null
          if (!made) continue
          v = { mesh: made.mesh, mat: made.mat, seen: true }
          this.auraFx.set(key, v)
        }
        v.seen = true
        if (aura === 'fire-spin') {
          v.mesh.position.set(f.x, f.y + 1.1, f.z)
          v.mesh.rotation.y += 0.15
        } else if (aura === 'aqua-ring') {
          v.mesh.position.set(f.x, f.y + 0.6 + Math.sin(this.time * 2) * 0.35, f.z)
          v.mesh.rotation.z = this.time * 2
        } else if (aura === 'ingrain') {
          v.mesh.position.set(f.x, f.y + 0.15, f.z)
          v.mesh.rotation.z = this.time * 0.8
        } else {
          v.mesh.position.set(f.x, f.y + f.height * 0.55, f.z)
          const strong = aura === 'acid-armor' || aura === 'withdraw' || aura === 'spiky-shield'
          v.mat.uniforms.uLife!.value = strong
            ? 0.9
            : aura === 'magic-coat'
              ? 0.55 + Math.sin(this.time * 8) * 0.15
              : 0.35
        }
      }
    }
    for (const [key, v] of this.auraFx) {
      if (!v.seen) {
        this.fx.dispose(v)
        this.auraFx.delete(key)
      }
    }
  }

  private auraParticles(id: string, f: FighterView): void {
    const r = Math.random
    const P = this.particles
    const head = f.y + f.height + 0.25
    switch (id) {
      case 'burn':
        if (r() < 0.7)
          P.emit(
            f.x + (r() - 0.5) * 0.7,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.7,
            0,
            2.4,
            0,
            r() < 0.5 ? '#ff7a1a' : '#ffd166',
            0.4,
            0.5,
            1,
          )
        break
      case 'fire-spin': {
        const a = this.time * 9 + r() * 6
        P.emit(
          f.x + Math.cos(a) * 0.9,
          f.y + r() * 1.8,
          f.z + Math.sin(a) * 0.9,
          -Math.sin(a) * 3,
          1.5,
          Math.cos(a) * 3,
          '#ff5a14',
          0.45,
          0.35,
          1,
        )
        break
      }
      case 'poison':
      case 'badly-poisoned':
        if (r() < 0.4)
          P.emit(
            f.x + (r() - 0.5) * 0.6,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.6,
            0,
            0.9,
            0,
            id === 'poison' ? '#a3e635' : '#a855f7',
            0.32,
            0.8,
            0.5,
          )
        break
      case 'bleed':
        if (r() < 0.3)
          P.emit(
            f.x + (r() - 0.5) * 0.4,
            f.y + 1 + r() * 0.5,
            f.z + (r() - 0.5) * 0.4,
            0,
            -0.5,
            0,
            '#dc2626',
            0.28,
            0.6,
            0.5,
            6,
          )
        break
      case 'hypnosis':
      case 'sleep-powder':
        if (r() < 0.07) P.emit(f.x + 0.2, head, f.z, 0.3, 0.6, 0, '#e9d5ff', 0.6, 1.4, 0.3)
        break
      case 'confusion': {
        const a = this.time * 5
        for (let k = 0; k < 3; k++) {
          const b = a + (k * Math.PI * 2) / 3
          P.emit(
            f.x + Math.cos(b) * 0.5,
            head,
            f.z + Math.sin(b) * 0.5,
            0,
            0,
            0,
            k === 0 ? '#fde047' : '#f0abfc',
            0.4,
            0.06,
            0,
          )
        }
        break
      }
      case 'paralysis':
        if (r() < 0.6)
          P.emit(
            f.x + (r() - 0.5) * 0.9,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.9,
            (r() - 0.5) * 6,
            (r() - 0.5) * 6,
            (r() - 0.5) * 6,
            '#fde047',
            0.3,
            0.12,
            8,
          )
        break
      case 'psychic-silence':
        if (r() < 0.25) P.emit(f.x, head, f.z, r() - 0.5, 0.2, r() - 0.5, '#f5d0fe', 0.45, 0.5, 1)
        break
      case 'aqua-ring':
      case 'aromatherapy': {
        const a = this.time * 3 + r() * 0.3
        P.emit(
          f.x + Math.cos(a) * 0.8,
          f.y + 0.3 + r() * 1.2,
          f.z + Math.sin(a) * 0.8,
          0,
          0.6,
          0,
          id === 'aqua-ring' ? '#67e8f9' : '#f9a8d4',
          0.3,
          0.6,
          1,
        )
        break
      }
      case 'acid-armor':
        if (r() < 0.4)
          P.emit(
            f.x + (r() - 0.5) * 1.1,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 1.1,
            0,
            -0.6,
            0,
            '#bef264',
            0.35,
            0.5,
            1,
            4,
          )
        break
      case 'flame-charge':
        if (r() < 0.6) P.emit(f.x, f.y + 0.2, f.z, r() - 0.5, 0.8, r() - 0.5, '#ff9a3a', 0.45, 0.4, 1)
        break
      case 'surf-slow':
        if (r() < 0.35)
          P.emit(
            f.x + (r() - 0.5) * 0.6,
            f.y + 1.4,
            f.z + (r() - 0.5) * 0.6,
            0,
            -2,
            0,
            '#7dd3fc',
            0.22,
            0.4,
            0.5,
            4,
          )
        break
      case 'heal-block':
        if (r() < 0.15) P.emit(f.x, f.y + 0.2, f.z, 0, 0.5, 0, '#991b1b', 0.6, 1, 1)
        break
      case 'will-o-wisp':
        if (r() < 0.7)
          P.emit(
            f.x + (r() - 0.5) * 0.7,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.7,
            0,
            2,
            0,
            r() < 0.5 ? '#3b82f6' : '#a5b4fc',
            0.42,
            0.55,
            1,
          )
        break
      case 'heat': {
        // Embers circling the hands, one per stack's worth of heat.
        const a = this.time * 6 + r() * 0.4
        P.emit(
          f.x + Math.cos(a) * 0.55,
          f.y + 1.1,
          f.z + Math.sin(a) * 0.55,
          0,
          0.6,
          0,
          '#ffb347',
          0.3,
          0.3,
          1,
        )
        break
      }
      case 'overheated':
        if (r() < 0.4)
          P.emit(
            f.x + (r() - 0.5) * 0.5,
            head - 0.3,
            f.z + (r() - 0.5) * 0.5,
            0,
            1.2,
            0,
            '#57534e',
            0.7,
            1,
            1,
          )
        break
      case 'tide':
        if (r() < 0.3)
          P.emit(
            f.x + (r() - 0.5) * 0.8,
            f.y + 1.3,
            f.z + (r() - 0.5) * 0.8,
            0,
            0.4,
            0,
            '#7dd3fc',
            0.25,
            0.5,
            1,
          )
        break
      case 'rain-dance':
        if (r() < 0.8)
          P.emit(
            f.x + (r() - 0.5) * 1.4,
            head + 0.8,
            f.z + (r() - 0.5) * 1.4,
            0,
            -7,
            0,
            r() < 0.5 ? '#bae6fd' : '#38bdf8',
            0.18,
            0.35,
            0,
          )
        break
      case 'nightmare':
        if (r() < 0.5)
          P.emit(
            f.x + (r() - 0.5) * 0.8,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.8,
            (r() - 0.5) * 0.6,
            0.7,
            (r() - 0.5) * 0.6,
            r() < 0.6 ? '#7c3aed' : '#1e1b4b',
            0.5,
            0.8,
            1,
          )
        break
      case 'leech-seed':
        if (r() < 0.35)
          P.emit(
            f.x + (r() - 0.5) * 0.6,
            f.y + 0.3 + r() * 1.2,
            f.z + (r() - 0.5) * 0.6,
            0,
            1.1,
            0,
            '#4ade80',
            0.32,
            0.7,
            1,
          )
        break
      case 'exposed':
        if (r() < 0.25)
          P.emit(
            f.x + (r() - 0.5) * 0.7,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.7,
            0,
            0,
            0,
            '#a855f7',
            0.3,
            0.35,
            1,
          )
        break
      case 'smokescreen':
        if (r() < 0.4)
          P.emit(
            f.x + (r() - 0.5) * 0.6,
            head - 0.2,
            f.z + (r() - 0.5) * 0.6,
            0,
            0.2,
            0,
            '#a1a1aa',
            0.8,
            0.6,
            1,
          )
        break
      case 'ingrain': {
        const a = r() * Math.PI * 2
        if (r() < 0.4)
          P.emit(
            f.x + Math.cos(a) * 0.9,
            f.y + 0.1,
            f.z + Math.sin(a) * 0.9,
            0,
            1.4,
            0,
            '#bef264',
            0.3,
            0.6,
            1,
          )
        break
      }
      default:
        break
    }
  }
}

function i2(p: Palette): string {
  return Math.random() < 0.5 ? p.spark : '#ffffff'
}
