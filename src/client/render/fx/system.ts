import {
  type BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type Object3D,
  PlaneGeometry,
  RingGeometry,
  type ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { Particles } from '../particles'
import {
  beamMaterial,
  decalMaterial,
  flameMaterial,
  orbMaterial,
  runeMaterial,
  shieldMaterial,
  shockwaveMaterial,
  slashMaterial,
} from './materials'

export interface Palette {
  core: string
  glow: string
  spark: string
}

interface Item {
  obj: Object3D
  age: number
  life: number
  mats: ShaderMaterial[]
  geos: BufferGeometry[]
  update: (t: number, dt: number, item: Item) => void
  done?: () => void
}

const up = new Vector3(0, 1, 0)
const tmp = new Vector3()

const SPHERE = new SphereGeometry(1, 20, 14)
const CIRCLE = new CircleGeometry(1, 48)
const CYL_OPEN = new CylinderGeometry(1, 1, 1, 24, 1, true)
const CONE_OPEN = new ConeGeometry(1, 1, 24, 1, true)

// Short-lived shader effects. Every item owns its materials and fades itself.
export class FxSystem {
  readonly group = new Group()
  private items: Item[] = []

  constructor(readonly particles: Particles) {}

  private add(
    obj: Object3D,
    life: number,
    mats: ShaderMaterial[],
    update: Item['update'],
    geos: BufferGeometry[] = [],
    done?: () => void,
  ): Item {
    this.group.add(obj)
    const item: Item = { obj, age: 0, life, mats, geos, update }
    if (done) item.done = done
    this.items.push(item)
    return item
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (!it) continue
      it.age += dt
      const t = Math.min(1, it.age / it.life)
      it.update(t, dt, it)
      if (it.age >= it.life) {
        it.done?.()
        this.group.remove(it.obj)
        for (const m of it.mats) m.dispose()
        for (const g of it.geos) g.dispose()
        this.items.splice(i, 1)
      }
    }
  }

  // ---- building blocks -------------------------------------------------

  shockwave(
    x: number,
    y: number,
    z: number,
    radius: number,
    color: string,
    life = 0.5,
    vertical = false,
  ): void {
    const mat = shockwaveMaterial(color)
    const m = new Mesh(CIRCLE, mat)
    m.position.set(x, y, z)
    if (!vertical) m.rotation.x = -Math.PI / 2
    this.add(m, life, [mat], (t) => {
      const e = 1 - (1 - t) * (1 - t)
      m.scale.setScalar(Math.max(0.01, radius * (0.2 + e * 0.8)))
      mat.uniforms.uLife!.value = 1 - t
    })
  }

  flash(x: number, y: number, z: number, size: number, p: Palette, life = 0.25): void {
    const mat = orbMaterial(p.core, p.glow)
    const m = new Mesh(SPHERE, mat)
    m.position.set(x, y, z)
    this.add(m, life, [mat], (t) => {
      m.scale.setScalar(size * (0.6 + t * 0.9))
      mat.uniforms.uLife!.value = (1 - t) * (1 - t)
    })
  }

  firePillar(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    hot: string,
    cool: string,
    life = 0.9,
  ): void {
    const mat = flameMaterial(hot, cool, 3)
    const m = new Mesh(CONE_OPEN, mat)
    m.position.set(x, y + height / 2, z)
    this.add(m, life, [mat], (t) => {
      const grow = Math.min(1, t * 5)
      m.scale.set(radius * (0.6 + grow * 0.4), height * grow, radius * (0.6 + grow * 0.4))
      m.position.y = y + (height * grow) / 2
      m.rotation.y += 0.1
      mat.uniforms.uLife!.value = t < 0.6 ? 1 : (1 - t) / 0.4
    })
  }

  slash(
    x: number,
    y: number,
    z: number,
    yaw: number,
    radius: number,
    arc: number,
    color: string,
    tilt = 0,
    life = 0.22,
  ): void {
    const geo = new RingGeometry(radius * 0.55, radius, 32, 1, -arc / 2, arc)
    const mat = slashMaterial(color)
    const m = new Mesh(geo, mat)
    m.position.set(x, y, z)
    m.rotation.order = 'YXZ'
    m.rotation.y = -yaw
    m.rotation.x = -Math.PI / 2 + tilt
    this.add(
      m,
      life,
      [mat],
      (t) => {
        mat.uniforms.uLife!.value = 1 - t
        m.scale.setScalar(0.85 + t * 0.25)
      },
      [geo],
    )
  }

  decal(x: number, y: number, z: number, radius: number, color: string, darken: boolean, life = 4): void {
    const mat = decalMaterial(color, darken)
    const m = new Mesh(CIRCLE, mat)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, y + 0.03, z)
    m.scale.setScalar(radius)
    m.renderOrder = 1
    this.add(m, life, [mat], (t) => {
      mat.uniforms.uLife!.value = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9
    })
  }

  beamOnce(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    width: number,
    p: Palette,
    life = 0.18,
  ): void {
    const mat = beamMaterial(p.core, p.glow, 10)
    const m = new Mesh(CYL_OPEN, mat)
    const len = Math.hypot(bx - ax, by - ay, bz - az)
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
    tmp.set(bx - ax, by - ay, bz - az).normalize()
    m.quaternion.setFromUnitVectors(up, tmp)
    this.add(m, life, [mat], (t) => {
      m.scale.set(width * (1 - t * 0.6), len, width * (1 - t * 0.6))
      mat.uniforms.uLife!.value = 1 - t
    })
  }

  // Cosmetic travel for targeted spells: an orb flies from caster to target.
  travel(
    ax: number,
    ay: number,
    az: number,
    target: () => Vector3 | undefined,
    duration: number,
    size: number,
    p: Palette,
    onArrive: (at: Vector3) => void,
    trail = 3,
  ): void {
    const mat = orbMaterial(p.core, p.glow)
    const m = new Mesh(SPHERE, mat)
    m.scale.setScalar(size)
    const start = new Vector3(ax, ay, az)
    const last = new Vector3(ax, ay, az)
    this.add(
      m,
      duration,
      [mat],
      (t) => {
        const to = target()
        if (to) last.copy(to)
        m.position.lerpVectors(start, last, t)
        m.position.y += Math.sin(t * Math.PI) * 0.6
        for (let i = 0; i < trail; i++) {
          this.particles.emit(
            m.position.x,
            m.position.y,
            m.position.z,
            (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 1.5,
            i % 2 ? p.spark : p.glow,
            size * 1.4,
            0.35,
            3,
          )
        }
      },
      [],
      () => onArrive(last),
    )
  }

  meteor(x: number, y: number, z: number, delay: number, p: Palette): void {
    const mat = orbMaterial('#fff4c2', p.glow)
    const m = new Mesh(SPHERE, mat)
    m.scale.setScalar(1.1)
    const trailMat = flameMaterial('#ffcf5a', '#d93a06', 5)
    const trail = new Mesh(CONE_OPEN, trailMat)
    const g = new Group()
    g.add(m, trail)
    trail.scale.set(1.1, 6, 1.1)
    trail.position.y = 3
    const from = new Vector3(x - 14, y + 30, z - 6)
    const to = new Vector3(x, y + 0.5, z)
    tmp.copy(from).sub(to).normalize()
    g.quaternion.setFromUnitVectors(up, tmp)
    this.add(g, delay, [mat, trailMat], (t) => {
      g.position.lerpVectors(from, to, t * t)
      for (let i = 0; i < 4; i++) {
        this.particles.emit(
          g.position.x,
          g.position.y,
          g.position.z,
          (Math.random() - 0.5) * 3,
          Math.random() * 2,
          (Math.random() - 0.5) * 3,
          i % 2 ? '#ffb347' : '#5a3a2a',
          1.2,
          0.8,
          1.5,
        )
      }
    })
  }

  // ---- persistent-ish meshes driven by callers ---------------------------

  rune(color: string, radius: number): { mesh: Mesh; mat: ShaderMaterial } {
    const mat = runeMaterial(color)
    const mesh = new Mesh(CIRCLE, mat)
    mesh.rotation.x = -Math.PI / 2
    mesh.scale.setScalar(radius)
    this.group.add(mesh)
    return { mesh, mat }
  }

  shield(color: string, radius: number, hex = true): { mesh: Mesh; mat: ShaderMaterial } {
    const mat = shieldMaterial(color, hex)
    const mesh = new Mesh(SPHERE, mat)
    mesh.scale.setScalar(radius)
    this.group.add(mesh)
    return { mesh, mat }
  }

  flameRing(hot: string, cool: string, radius: number, height: number): { mesh: Mesh; mat: ShaderMaterial } {
    const mat = flameMaterial(hot, cool, 2.6)
    const mesh = new Mesh(CYL_OPEN, mat)
    mesh.scale.set(radius, height, radius)
    this.group.add(mesh)
    return { mesh, mat }
  }

  waterRing(color: string, radius: number): { mesh: Mesh; mat: ShaderMaterial } {
    const mat = shieldMaterial(color, false)
    const mesh = new Mesh(new TorusGeometry(radius, 0.08, 8, 40), mat)
    mesh.rotation.x = Math.PI / 2
    this.group.add(mesh)
    return { mesh, mat }
  }

  beamMesh(p: Palette): { mesh: Mesh; mat: ShaderMaterial } {
    const mat = beamMaterial(p.core, p.glow, 8)
    const mesh = new Mesh(CYL_OPEN, mat)
    this.group.add(mesh)
    return { mesh, mat }
  }

  wave(
    x: number,
    y: number,
    z: number,
    yaw: number,
    range: number,
    width: number,
    color: string,
    life = 0.45,
  ): void {
    const mat = beamMaterial('#e0f7ff', color, 4)
    const geo = new PlaneGeometry(width, 1.6, 12, 1)
    const pos = geo.attributes.position
    if (pos) {
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i)
        pos.setZ(i, -(px * px) * 0.12)
      }
      geo.computeVertexNormals()
    }
    const m = new Mesh(geo, mat)
    m.rotation.order = 'YXZ'
    m.rotation.y = -yaw + Math.PI / 2
    this.add(
      m,
      life,
      [mat],
      (t) => {
        const d = range * t
        m.position.set(x + Math.cos(yaw) * d, y + 0.8, z + Math.sin(yaw) * d)
        m.scale.set(0.6 + t * 0.8, 1 - t * 0.3, 1)
        mat.uniforms.uLife!.value = 1 - t
        for (let i = 0; i < 6; i++) {
          const s = (Math.random() - 0.5) * width * (0.6 + t)
          this.particles.emit(
            m.position.x - Math.sin(yaw) * s,
            y + 1.4,
            m.position.z + Math.cos(yaw) * s,
            Math.cos(yaw) * 6,
            2 + Math.random() * 2,
            Math.sin(yaw) * 6,
            '#e0f7ff',
            0.5,
            0.5,
            2,
            9,
          )
        }
      },
      [geo],
    )
  }

  dispose(obj: { mesh: Mesh; mat: ShaderMaterial }): void {
    this.group.remove(obj.mesh)
    obj.mat.dispose()
    const g = obj.mesh.geometry
    if (g !== SPHERE && g !== CIRCLE && g !== CYL_OPEN && g !== CONE_OPEN) g.dispose()
  }
}
