import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three'
import type { SimEvent } from '../../shared/combat/events'
import { getAbility } from '../../shared/combat/registry'
import type { Element } from '../../shared/combat/types'
import type { Snapshot } from '../../shared/net/protocol'
import { Particles } from './particles'
import { NOISE_GLSL } from './shaderlib'

export const ELEMENT: Record<Element, { core: string; glow: string; spark: string }> = {
  fire: { core: '#fff1c2', glow: '#ff7a1a', spark: '#ffb347' },
  water: { core: '#e6fbff', glow: '#2fb8ff', spark: '#9ae6ff' },
  poison: { core: '#f2ffd0', glow: '#8be02b', spark: '#b26bff' },
  psychic: { core: '#fff0ff', glow: '#e05cff', spark: '#ffa6ff' },
  grass: { core: '#f3ffe8', glow: '#4ade80', spark: '#ffc2e2' },
  normal: { core: '#ffffff', glow: '#d4d4d8', spark: '#fafafa' },
}

export function abilityColors(abilityId: string): { core: string; glow: string; spark: string } {
  const a = getAbility(abilityId)
  return ELEMENT[a?.element ?? 'normal']
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
  color: { core: string; glow: string; spark: string }
}

interface Transient {
  mesh: Mesh
  ttl: number
  total: number
  grow: number
  fade: boolean
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
}

function glowMat(color: string, opacity = 1, mult = 2.2): MeshBasicMaterial {
  const c = new Color(color).multiplyScalar(mult)
  return new MeshBasicMaterial({
    color: c,
    transparent: true,
    opacity,
    blending: AdditiveBlending,
    depthWrite: false,
  })
}

function hazardMaterial(color: string): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
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
        float body = smoothstep(1.0, 0.2, r) * (0.18 + swirl * 0.5);
        float fill = step(r, uFill) * 0.25;
        float alpha = (rim * 1.4 + body + fill) * uLife;
        gl_FragColor = vec4(uColor * (1.3 + swirl), alpha);
      }
    `,
  })
}

const tmp = new Vector3()
const up = new Vector3(0, 1, 0)

export class Vfx {
  readonly group = new Group()
  readonly particles = new Particles()
  private projectiles = new Map<number, ProjectileView>()
  private hazards = new Map<number, { mesh: Mesh; mat: ShaderMaterial; rem: number; total: number }>()
  private delayed = new Map<number, { mesh: Mesh; mat: ShaderMaterial; rem: number; total: number }>()
  private beams = new Map<number, { mesh: Mesh; ttl: number }>()
  private transients: Transient[] = []
  private readonly sphereGeo = new SphereGeometry(1, 12, 10)
  private readonly beamGeo = new CylinderGeometry(1, 1, 1, 10, 1, true)
  private time = 0

  constructor(scene: Scene) {
    this.group.add(this.particles.points)
    scene.add(this.group)
  }

  // Projectiles, hazards and telegraphs from the latest snapshot.
  sync(snap: Snapshot, serverTime: number): void {
    for (const v of this.projectiles.values()) v.seen = false
    for (const p of snap.projectiles) {
      let v = this.projectiles.get(p.id)
      const ability = getAbility(p.ability)
      if (!v) {
        const color = abilityColors(p.ability)
        const mesh = new Group()
        const radius = ability?.target.kind === 'projectile' ? ability.target.radius : 0.25
        const core = new Mesh(this.sphereGeo, glowMat(color.core, 1, 2.6))
        core.scale.setScalar(radius * 0.7)
        const halo = new Mesh(this.sphereGeo, glowMat(color.glow, 0.45, 1.8))
        halo.scale.setScalar(radius * 1.6)
        mesh.add(core, halo)
        this.group.add(mesh)
        v = {
          mesh,
          x: p.x,
          y: p.y,
          z: p.z,
          vx: p.vx,
          vy: p.vy,
          vz: p.vz,
          gravity: 0,
          t0: serverTime,
          seen: true,
          color,
        }
        this.projectiles.set(p.id, v)
      }
      v.x = p.x
      v.y = p.y
      v.z = p.z
      v.vx = p.vx
      v.vy = p.vy
      v.vz = p.vz
      v.gravity = ability?.target.kind === 'projectile' ? (ability.target.gravity ?? 0) : 0
      v.t0 = serverTime
      v.seen = true
    }
    for (const [id, v] of this.projectiles) {
      if (!v.seen) {
        this.group.remove(v.mesh)
        this.projectiles.delete(id)
      }
    }

    const liveHazards = new Set<number>()
    for (const h of snap.hazards) {
      liveHazards.add(h.id)
      let v = this.hazards.get(h.id)
      if (!v) {
        const color = abilityColors(h.ability)
        const mat = hazardMaterial(color.glow)
        const mesh = new Mesh(new CircleGeometry(h.radius, 48), mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set(h.x, h.y + 0.06, h.z)
        this.group.add(mesh)
        v = { mesh, mat, rem: h.rem, total: Math.max(h.rem, 0.1) }
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
        const color = abilityColors(d.ability)
        const mat = hazardMaterial(color.glow)
        const mesh = new Mesh(new CircleGeometry(d.radius, 48), mat)
        mesh.rotation.x = -Math.PI / 2
        this.group.add(mesh)
        v = { mesh, mat, rem: d.rem, total: Math.max(d.rem, 0.1) }
        this.delayed.set(d.id, v)
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

  private transient(mesh: Mesh, ttl: number, grow: number, fade = true): void {
    this.group.add(mesh)
    this.transients.push({ mesh, ttl, total: ttl, grow, fade })
  }

  private ring(
    x: number,
    y: number,
    z: number,
    radius: number,
    color: string,
    ttl: number,
    grow: number,
  ): void {
    const m = new Mesh(new RingGeometry(radius * 0.82, radius, 48), glowMat(color, 0.9))
    m.rotation.x = -Math.PI / 2
    m.position.set(x, y, z)
    this.transient(m, ttl, grow)
  }

  private flash(x: number, y: number, z: number, color: string, size: number, ttl: number): void {
    const m = new Mesh(this.sphereGeo, glowMat(color, 0.9, 2.4))
    m.position.set(x, y, z)
    m.scale.setScalar(size)
    this.transient(m, ttl, 2.5)
  }

  private beam(
    srcId: number,
    x: number,
    y: number,
    z: number,
    tx: number,
    ty: number,
    tz: number,
    color: string,
    width: number,
    ttl: number,
  ): void {
    let b = this.beams.get(srcId)
    if (!b) {
      const mesh = new Mesh(this.beamGeo, glowMat(color, 0.85, 2.4))
      this.group.add(mesh)
      b = { mesh, ttl }
      this.beams.set(srcId, b)
    }
    b.ttl = ttl
    const len = Math.hypot(tx - x, ty - y, tz - z)
    b.mesh.position.set((x + tx) / 2, (y + ty) / 2, (z + tz) / 2)
    tmp.set(tx - x, ty - y, tz - z).normalize()
    b.mesh.quaternion.setFromUnitVectors(up, tmp)
    b.mesh.scale.set(width, len, width)
  }

  onEvent(e: SimEvent, fighterPos: (id: number) => FighterView | undefined): void {
    switch (e.t) {
      case 'use': {
        const a = getAbility(e.ability)
        if (!a) return
        const c = ELEMENT[a.element]
        const t = a.target
        if (t.kind === 'beam') {
          this.beam(e.src, e.x, e.y, e.z, e.tx, e.ty, e.tz, c.glow, t.radius * 0.7, 0.2)
          for (let i = 0; i < 3; i++) {
            const k = Math.random()
            this.particles.emit(
              e.x + (e.tx - e.x) * k,
              e.y + (e.ty - e.y) * k,
              e.z + (e.tz - e.z) * k,
              0,
              0.6,
              0,
              c.spark,
              0.25,
              0.4,
            )
          }
        } else if (t.kind === 'hitscan') {
          this.beam(-e.src - 1, e.x, e.y, e.z, e.tx, e.ty, e.tz, c.spark, 0.06, 0.12)
          this.flash(e.tx, e.ty, e.tz, c.glow, 0.5, 0.25)
        } else if (t.kind === 'melee' || t.kind === 'cone') {
          const f = fighterPos(e.src)
          if (!f) return
          const range = t.range
          const geo = new RingGeometry(range * 0.35, range, 24, 1, -t.angle / 2, t.angle)
          const m = new Mesh(geo, glowMat(c.glow, 0.7))
          m.rotation.x = -Math.PI / 2
          m.rotation.z = -f.yaw
          m.position.set(f.x, f.y + (t.kind === 'melee' ? 1.0 : 0.15), f.z)
          this.transient(m, t.kind === 'melee' ? 0.16 : 0.4, t.kind === 'cone' ? 0.4 : 0.1)
          if (t.kind === 'cone') {
            for (let i = 0; i < 40; i++) {
              const a2 = f.yaw + (Math.random() - 0.5) * t.angle
              const sp = range * (1 + Math.random())
              this.particles.emit(
                f.x,
                f.y + 0.4,
                f.z,
                Math.cos(a2) * sp,
                Math.random() * 2,
                Math.sin(a2) * sp,
                c.spark,
                0.5,
                0.5,
                2.5,
              )
            }
          }
        } else if (t.kind === 'nova') {
          this.ring(e.x, e.y + 0.1, e.z, 2, c.glow, 0.7, 12)
          this.particles.burst(e.x, e.y + 1, e.z, c.spark, 60, 8, 0.5, 0.9, -2)
        } else if (t.kind === 'self' && a.slot === 'c') {
          this.ring(e.x, e.y + 0.1, e.z, 1.2, '#ffffff', 0.5, 3)
          this.particles.burst(e.x, e.y + 1, e.z, '#ffe066', 30, 6, 0.4, 0.6)
        } else if (t.kind === 'self') {
          this.ring(e.x, e.y + 0.1, e.z, 1.1, c.glow, 0.5, 1.5)
        } else if (t.kind === 'projectile' || t.kind === 'targeted' || t.kind === 'ground') {
          this.particles.burst(e.x, e.y, e.z, c.spark, 6, 2.5, 0.25, 0.25)
        }
        break
      }
      case 'impact': {
        const c = abilityColors(e.ability)
        const a = getAbility(e.ability)
        const big = a ? a.slot !== 'lmb' : false
        this.flash(e.x, e.y, e.z, c.glow, big ? 0.6 : 0.35, big ? 0.3 : 0.18)
        this.particles.burst(e.x, e.y, e.z, c.spark, big ? 28 : 12, big ? 7 : 4.5, big ? 0.45 : 0.3, 0.45, 4)
        if (e.ny > 0.7) this.ring(e.x, e.y + 0.05, e.z, big ? 1 : 0.5, c.glow, 0.35, 3)
        break
      }
      case 'detonate': {
        const c = abilityColors(e.ability)
        this.flash(e.x, e.y + 1, e.z, c.core, e.radius * 0.45, 0.45)
        this.ring(e.x, e.y + 0.1, e.z, e.radius, c.glow, 0.6, 1.6)
        this.particles.burst(e.x, e.y + 0.8, e.z, c.glow, 90, 12, 0.7, 0.9, 6)
        this.particles.burst(e.x, e.y + 0.8, e.z, c.spark, 50, 6, 0.5, 1.2, -1)
        break
      }
      case 'interrupt': {
        const f = fighterPos(e.dst)
        if (!f) return
        this.flash(f.x, f.y + f.height * 0.75, f.z, '#ffffff', 0.6, 0.25)
        this.particles.burst(f.x, f.y + f.height * 0.75, f.z, '#e0f2fe', 40, 9, 0.35, 0.5, 6)
        this.ring(f.x, f.y + f.height * 0.75, f.z, 1.2, '#7dd3fc', 0.35, 4)
        break
      }
      case 'heal': {
        if (e.tick) return
        const f = fighterPos(e.dst)
        if (!f) return
        const c = abilityColors(e.ability)
        for (let i = 0; i < 26; i++) {
          const a2 = Math.random() * Math.PI * 2
          const r = Math.random() * 0.6
          this.particles.emit(
            f.x + Math.cos(a2) * r,
            f.y + 0.2,
            f.z + Math.sin(a2) * r,
            0,
            2.5 + Math.random() * 2,
            0,
            c.spark,
            0.35,
            1.0,
            1,
          )
        }
        this.ring(f.x, f.y + 0.1, f.z, 0.9, c.glow, 0.6, 1.5)
        break
      }
      case 'death': {
        const f = fighterPos(e.dst)
        if (!f) return
        this.particles.burst(f.x, f.y + 1, f.z, '#ffffff', 60, 8, 0.5, 1.0, 3)
        this.ring(f.x, f.y + 0.1, f.z, 1.5, '#ffffff', 0.8, 5)
        break
      }
      default:
        break
    }
  }

  update(dt: number, serverTime: number, fighters: readonly FighterView[]): void {
    this.time += dt
    for (const v of this.projectiles.values()) {
      const t = Math.max(0, Math.min(0.2, serverTime - v.t0))
      const x = v.x + v.vx * t
      const y = v.y + v.vy * t - 0.5 * v.gravity * t * t
      const z = v.z + v.vz * t
      v.mesh.position.set(x, y, z)
      const pulse = 1 + Math.sin(this.time * 30) * 0.08
      v.mesh.scale.setScalar(pulse)
      this.particles.emit(
        x,
        y,
        z,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6,
        v.color.glow,
        0.32,
        0.28,
        4,
      )
    }
    for (const h of this.hazards.values()) {
      h.mat.uniforms.uTime!.value = this.time
      h.mat.uniforms.uLife!.value = Math.min(1, h.rem * 3, (h.total - h.rem) * 6 + 0.2)
    }
    for (const d of this.delayed.values()) {
      d.mat.uniforms.uTime!.value = this.time
      d.mat.uniforms.uFill!.value = 1 - Math.max(0, d.rem) / d.total
      d.mat.uniforms.uLife!.value = 1
    }
    for (const [id, b] of this.beams) {
      b.ttl -= dt
      ;(b.mesh.material as MeshBasicMaterial).opacity = Math.min(0.85, b.ttl * 8)
      if (b.ttl <= 0) {
        this.group.remove(b.mesh)
        this.beams.delete(id)
      }
    }
    for (let i = this.transients.length - 1; i >= 0; i--) {
      const t = this.transients[i]
      if (!t) continue
      t.ttl -= dt
      const k = 1 - t.ttl / t.total
      const s = 1 + t.grow * k
      if (t.mesh.geometry.type === 'SphereGeometry') t.mesh.scale.multiplyScalar(1 + t.grow * dt)
      else t.mesh.scale.set(s, s, s)
      if (t.fade) (t.mesh.material as MeshBasicMaterial).opacity = Math.max(0, 1 - k)
      if (t.ttl <= 0) {
        this.group.remove(t.mesh)
        if (t.mesh.geometry !== this.sphereGeo) t.mesh.geometry.dispose()
        ;(t.mesh.material as MeshBasicMaterial).dispose()
        this.transients.splice(i, 1)
      }
    }

    // Status effects drawn on fighters
    for (const f of fighters) {
      if (!f.alive) continue
      if (f.dashing) {
        for (let i = 0; i < 4; i++)
          this.particles.emit(f.x, f.y + 0.4 + Math.random() * 1.2, f.z, 0, 0.3, 0, f.dashColor, 0.5, 0.35, 3)
      }
      for (const id of f.auras) this.auraParticles(id, f)
    }
    this.particles.update(dt)
  }

  private auraParticles(id: string, f: FighterView): void {
    const r = Math.random
    const head = f.y + f.height + 0.25
    switch (id) {
      case 'burn':
      case 'fire-spin':
        if (r() < 0.6)
          this.particles.emit(
            f.x + (r() - 0.5) * 0.7,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.7,
            0,
            2.2,
            0,
            r() < 0.5 ? '#ff7a1a' : '#ffd166',
            0.35,
            0.5,
            1,
          )
        if (id === 'fire-spin' && r() < 0.8) {
          const a = this.time * 9 + r() * 6
          this.particles.emit(
            f.x + Math.cos(a) * 0.9,
            f.y + r() * 1.6,
            f.z + Math.sin(a) * 0.9,
            -Math.sin(a) * 3,
            1.2,
            Math.cos(a) * 3,
            '#ff5a14',
            0.45,
            0.35,
            1,
          )
        }
        break
      case 'poison':
      case 'badly-poisoned':
        if (r() < 0.35)
          this.particles.emit(
            f.x + (r() - 0.5) * 0.6,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 0.6,
            0,
            0.9,
            0,
            id === 'poison' ? '#a3e635' : '#a855f7',
            0.3,
            0.8,
            0.5,
          )
        break
      case 'bleed':
        if (r() < 0.25)
          this.particles.emit(
            f.x + (r() - 0.5) * 0.4,
            f.y + 1 + r() * 0.5,
            f.z + (r() - 0.5) * 0.4,
            0,
            -0.5,
            0,
            '#dc2626',
            0.25,
            0.6,
            0.5,
            6,
          )
        break
      case 'hypnosis':
      case 'sleep-powder':
        if (r() < 0.06) this.particles.emit(f.x + 0.2, head, f.z, 0.3, 0.6, 0, '#e9d5ff', 0.55, 1.4, 0.3)
        break
      case 'confusion': {
        const a = this.time * 5
        for (let k = 0; k < 3; k++) {
          const b = a + (k * Math.PI * 2) / 3
          this.particles.emit(
            f.x + Math.cos(b) * 0.45,
            head,
            f.z + Math.sin(b) * 0.45,
            0,
            0,
            0,
            '#f0abfc',
            0.35,
            0.06,
            0,
          )
        }
        break
      }
      case 'paralysis':
        if (r() < 0.5)
          this.particles.emit(
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
        if (r() < 0.2) this.particles.emit(f.x, head, f.z, r() - 0.5, 0.2, r() - 0.5, '#f5d0fe', 0.4, 0.5, 1)
        break
      case 'aqua-ring':
      case 'aromatherapy': {
        const a = this.time * 3 + r() * 0.3
        this.particles.emit(
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
        if (r() < 0.6)
          this.particles.emit(
            f.x + (r() - 0.5) * 1.1,
            f.y + r() * f.height,
            f.z + (r() - 0.5) * 1.1,
            0,
            0.4,
            0,
            '#bef264',
            0.4,
            0.4,
            1,
          )
        break
      case 'flame-charge':
        if (r() < 0.5)
          this.particles.emit(f.x, f.y + 0.2, f.z, r() - 0.5, 0.8, r() - 0.5, '#ff9a3a', 0.4, 0.4, 1)
        break
      case 'surf-slow':
        if (r() < 0.3)
          this.particles.emit(
            f.x + (r() - 0.5) * 0.6,
            f.y + 1.2,
            f.z + (r() - 0.5) * 0.6,
            0,
            -2,
            0,
            '#7dd3fc',
            0.2,
            0.4,
            0.5,
            4,
          )
        break
      case 'heal-block':
        if (r() < 0.12) this.particles.emit(f.x, f.y + 0.2, f.z, 0, 0.5, 0, '#7f1d1d', 0.6, 1, 1)
        break
      default:
        break
    }
  }
}
