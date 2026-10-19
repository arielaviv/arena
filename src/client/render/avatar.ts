import {
  AdditiveBlending,
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type MeshToonMaterial,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three'
import { CLASSES } from '../../shared/combat/registry'
import type { ClassId } from '../../shared/combat/types'
import type { MoveState } from '../../shared/sim/fighter'
import { toon, withOutline } from './toon'

export interface AvatarState {
  x: number
  y: number
  z: number
  yaw: number
  speed: number
  move: MoveState
  casting: boolean
  channel: boolean
  alive: boolean
  stunned: boolean
  asleep: boolean
}

interface Rig {
  body: Group
  legL?: Group
  legR?: Group
  armL?: Group
  armR?: Group
  tail?: Group
  head?: Group
  glow: Material[]
  flame?: Mesh
}

const OUTLINE = '#0c0c0f'

function part(
  parent: Group,
  geo: BufferGeometry,
  mat: Material,
  x: number,
  y: number,
  z: number,
  outline = true,
): Mesh {
  const m = new Mesh(geo, mat)
  m.position.set(x, y, z)
  m.castShadow = true
  if (outline) m.add(withOutline(geo, 1.06, OUTLINE))
  parent.add(m)
  return m
}

function limb(parent: Group, x: number, y: number, z: number): Group {
  const g = new Group()
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

// Procedural low-poly creatures, one silhouette per class. Models face +X.
function buildCreature(id: ClassId): Rig {
  const cls = CLASSES[id]
  const body = new Group()
  const main = toon(cls.colors.primary)
  const dark = toon(cls.colors.secondary)
  const glowMat = toon(cls.colors.glow, cls.colors.glow, 2.2)
  const eye = toon('#ffffff', cls.colors.glow, 3)
  const glow: Material[] = [glowMat, eye]
  const rig: Rig = { body, glow }

  switch (id) {
    case 'cindrake': {
      const belly = toon('#ffd08a')
      part(body, new CapsuleGeometry(0.42, 0.55, 4, 10), main, 0, 0.95, 0)
      part(body, new SphereGeometry(0.3, 10, 8), belly, 0.18, 0.9, 0, false).scale.set(0.8, 1.3, 1)
      const head = limb(body, 0.15, 1.6, 0)
      part(head, new SphereGeometry(0.34, 12, 10), main, 0, 0, 0)
      part(head, new BoxGeometry(0.36, 0.2, 0.3), main, 0.3, -0.06, 0)
      for (const s of [-1, 1]) part(head, new SphereGeometry(0.07, 8, 6), eye, 0.22, 0.08, s * 0.16, false)
      rig.head = head
      for (const s of [-1, 1]) {
        const leg = limb(body, 0, 0.55, s * 0.24)
        part(leg, new CapsuleGeometry(0.13, 0.35, 3, 8), main, 0, -0.3, 0)
        part(leg, new BoxGeometry(0.32, 0.12, 0.2), dark, 0.08, -0.55, 0)
        if (s < 0) rig.legL = leg
        else rig.legR = leg
        const arm = limb(body, 0.15, 1.2, s * 0.42)
        part(arm, new CapsuleGeometry(0.08, 0.28, 3, 6), main, 0.05, -0.18, 0)
        if (s < 0) rig.armL = arm
        else rig.armR = arm
      }
      const tail = limb(body, -0.35, 0.75, 0)
      part(tail, new ConeGeometry(0.18, 0.9, 8), main, -0.4, -0.05, 0).rotation.z = Math.PI / 2 + 0.3
      const flame = part(tail, new ConeGeometry(0.16, 0.45, 6), glowMat, -0.9, 0.12, 0, false)
      rig.flame = flame
      rig.tail = tail
      for (let i = 0; i < 3; i++) {
        part(body, new ConeGeometry(0.1, 0.32, 4), glowMat, -0.3, 1.25 - i * 0.22, 0, false).rotation.z = 0.9
      }
      break
    }
    case 'tidehorn': {
      part(body, new SphereGeometry(0.55, 14, 10), main, 0, 0.85, 0).scale.set(1, 0.95, 1.05)
      const shell = part(
        body,
        new SphereGeometry(0.6, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        dark,
        -0.18,
        0.95,
        0,
      )
      shell.rotation.z = Math.PI / 2.4
      for (let i = 0; i < 3; i++) {
        const ring = new Mesh(new TorusGeometry(0.42 - i * 0.12, 0.03, 6, 20), glowMat)
        ring.position.set(-0.52 + i * 0.05, 1.05, 0)
        ring.rotation.y = Math.PI / 2
        ring.rotation.x = 0.4
        body.add(ring)
      }
      const head = limb(body, 0.45, 1.35, 0)
      part(head, new SphereGeometry(0.3, 12, 10), main, 0, 0, 0)
      part(head, new ConeGeometry(0.09, 0.55, 6), glowMat, 0.08, 0.35, 0, false).rotation.z = -0.35
      for (const s of [-1, 1]) part(head, new SphereGeometry(0.07, 8, 6), eye, 0.22, 0.06, s * 0.14, false)
      rig.head = head
      for (const s of [-1, 1]) {
        const leg = limb(body, 0.05, 0.42, s * 0.33)
        part(leg, new CylinderGeometry(0.16, 0.19, 0.42, 8), main, 0, -0.2, 0)
        if (s < 0) rig.legL = leg
        else rig.legR = leg
        const arm = limb(body, 0.25, 1.0, s * 0.55)
        part(arm, new CapsuleGeometry(0.1, 0.25, 3, 6), main, 0.05, -0.15, 0)
        part(arm, new ConeGeometry(0.12, 0.3, 4), dark, -0.05, -0.35, s * 0.05, false).rotation.x = s * 0.6
        if (s < 0) rig.armL = arm
        else rig.armR = arm
      }
      break
    }
    case 'venomaw': {
      const coil = limb(body, 0, 0, 0)
      for (let i = 0; i < 3; i++) {
        const t = new Mesh(new TorusGeometry(0.42 - i * 0.08, 0.15 - i * 0.02, 8, 18), i % 2 ? dark : main)
        t.rotation.x = Math.PI / 2
        t.position.set(-0.1, 0.16 + i * 0.22, 0)
        t.castShadow = true
        t.add(withOutline(t.geometry, 1.05, OUTLINE))
        coil.add(t)
      }
      rig.tail = coil
      part(body, new CylinderGeometry(0.17, 0.26, 0.9, 10), main, 0.05, 1.0, 0).rotation.z = -0.15
      const head = limb(body, 0.22, 1.55, 0)
      const hood = part(head, new SphereGeometry(0.42, 12, 8), dark, -0.08, 0, 0)
      hood.scale.set(0.35, 1.0, 1.15)
      part(head, new SphereGeometry(0.22, 10, 8), main, 0.12, 0.02, 0).scale.set(1.3, 0.85, 1)
      for (const s of [-1, 1]) {
        part(head, new SphereGeometry(0.06, 8, 6), eye, 0.3, 0.08, s * 0.1, false)
        part(head, new ConeGeometry(0.03, 0.14, 4), toon('#ffffff'), 0.36, -0.1, s * 0.06, false).rotation.z =
          Math.PI
      }
      for (let i = 0; i < 3; i++)
        part(head, new SphereGeometry(0.05, 6, 4), glowMat, -0.1, 0.25 - i * 0.2, 0.36, false)
      rig.head = head
      break
    }
    case 'lumora': {
      part(body, new CapsuleGeometry(0.28, 0.5, 4, 10), main, 0, 1.05, 0).rotation.z = -0.2
      const head = limb(body, 0.22, 1.62, 0)
      part(head, new SphereGeometry(0.26, 12, 10), main, 0, 0, 0)
      part(head, new ConeGeometry(0.12, 0.3, 6), main, 0.26, -0.05, 0).rotation.z = -Math.PI / 2
      for (const s of [-1, 1]) {
        part(head, new ConeGeometry(0.12, 0.45, 4), main, -0.05, 0.32, s * 0.15).rotation.x = s * -0.25
        part(head, new SphereGeometry(0.055, 8, 6), eye, 0.2, 0.06, s * 0.11, false)
      }
      part(head, new SphereGeometry(0.06, 8, 6), glowMat, 0.2, 0.18, 0, false)
      rig.head = head
      for (const s of [-1, 1]) {
        const leg = limb(body, -0.02, 0.62, s * 0.16)
        part(leg, new CapsuleGeometry(0.07, 0.45, 3, 6), main, 0, -0.3, 0)
        if (s < 0) rig.legL = leg
        else rig.legR = leg
        const arm = limb(body, 0.12, 1.28, s * 0.3)
        part(arm, new CapsuleGeometry(0.06, 0.3, 3, 6), main, 0.05, -0.18, 0)
        if (s < 0) rig.armL = arm
        else rig.armR = arm
      }
      const tail = limb(body, -0.3, 0.85, 0)
      for (const s of [-1, 1]) {
        const t = part(tail, new ConeGeometry(0.12, 0.9, 6), main, -0.35, 0.2, s * 0.12)
        t.rotation.z = Math.PI / 2 + 0.6
        t.rotation.x = s * 0.4
        part(tail, new SphereGeometry(0.09, 8, 6), glowMat, -0.72, 0.5, s * 0.25, false)
      }
      rig.tail = tail
      break
    }
    case 'petalyn': {
      part(body, new SphereGeometry(0.48, 14, 10), main, 0, 0.8, 0)
      const head = limb(body, 0.05, 1.42, 0)
      part(head, new SphereGeometry(0.3, 12, 10), main, 0, 0, 0)
      for (const s of [-1, 1]) part(head, new SphereGeometry(0.06, 8, 6), eye, 0.24, 0.05, s * 0.12, false)
      const petal = toon('#ff9fd2')
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const p = part(
          head,
          new SphereGeometry(0.2, 8, 6),
          petal,
          Math.cos(a) * 0.28 - 0.05,
          0.32,
          Math.sin(a) * 0.28,
        )
        p.scale.set(1, 0.35, 0.7)
        p.rotation.y = -a
      }
      part(head, new SphereGeometry(0.11, 8, 6), toon('#ffe066', '#ffcc33', 1.6), -0.05, 0.36, 0, false)
      rig.head = head
      for (const s of [-1, 1]) {
        const leg = limb(body, 0, 0.4, s * 0.22)
        part(leg, new ConeGeometry(0.14, 0.4, 6), dark, 0, -0.2, 0).rotation.x = Math.PI
        if (s < 0) rig.legL = leg
        else rig.legR = leg
        const arm = limb(body, 0.1, 0.95, s * 0.48)
        const leaf = part(arm, new SphereGeometry(0.18, 8, 6), toon('#2fbf6a'), 0.05, -0.12, s * 0.05)
        leaf.scale.set(0.6, 0.25, 1.2)
        if (s < 0) rig.armL = arm
        else rig.armR = arm
      }
      break
    }
    case 'dummy': {
      const wood = toon('#8b6a4a')
      const sack = toon('#d8c7a0')
      part(body, new CylinderGeometry(0.08, 0.1, 1.8, 6), wood, 0, 0.9, 0)
      part(body, new CapsuleGeometry(0.34, 0.6, 4, 10), sack, 0, 1.15, 0)
      part(body, new SphereGeometry(0.26, 10, 8), sack, 0, 1.78, 0)
      part(body, new BoxGeometry(0.1, 0.1, 1.2), wood, 0, 1.4, 0)
      const target = new Mesh(new RingGeometry(0.12, 0.24, 20), toon('#e11d48'))
      target.position.set(0.35, 1.2, 0)
      target.rotation.y = Math.PI / 2
      body.add(target)
      break
    }
  }
  return rig
}

export class Avatar {
  readonly root = new Group()
  private rig: Rig
  private classId: ClassId
  private phase = 0
  private flash = 0
  private deathT = 0
  private readonly ring: Mesh
  private readonly flashMats: MeshToonMaterial[] = []

  constructor(
    classId: ClassId,
    team: 0 | 1,
    localTeam: 0 | 1,
    private readonly isLocal = false,
  ) {
    this.classId = classId
    this.rig = buildCreature(classId)
    this.root.add(this.rig.body)
    const ally = team === localTeam
    this.ring = new Mesh(
      new RingGeometry(0.55, 0.68, 32),
      new MeshBasicMaterial({
        color: new Color(ally ? '#38bdf8' : '#f43f5e'),
        transparent: true,
        opacity: 0.85,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.04
    this.root.add(this.ring)
    this.collectFlash()
  }

  private collectFlash(): void {
    this.flashMats.length = 0
    this.rig.body.traverse((o) => {
      const m = (o as Mesh).material as MeshToonMaterial | undefined
      if (m && 'isMeshToonMaterial' in m && !this.rig.glow.includes(m) && !this.flashMats.includes(m))
        this.flashMats.push(m)
    })
  }

  setClass(classId: ClassId): void {
    if (classId === this.classId) return
    this.root.remove(this.rig.body)
    this.classId = classId
    this.rig = buildCreature(classId)
    this.root.add(this.rig.body)
    this.collectFlash()
  }

  hit(): void {
    this.flash = 1
  }

  update(dt: number, s: AvatarState, time: number): void {
    this.root.position.set(s.x, s.y, s.z)
    this.root.rotation.y = -s.yaw
    const r = this.rig
    const moving = s.speed > 0.6 && s.move !== 'slide'
    this.phase += dt * (moving ? 3 + s.speed * 0.9 : 1.5)

    // death: topple over and sink
    this.deathT = s.alive ? 0 : Math.min(1, this.deathT + dt * 2.5)
    r.body.rotation.z = -this.deathT * (Math.PI / 2)
    r.body.position.y = this.classId === 'lumora' && s.alive ? 0.15 + Math.sin(time * 2) * 0.06 : 0

    const swing = moving ? Math.sin(this.phase) * Math.min(1, s.speed / 8) * 0.9 : 0
    if (r.legL) r.legL.rotation.z = swing
    if (r.legR) r.legR.rotation.z = -swing
    const castUp = s.casting || s.channel ? 1 : 0
    if (r.armL) r.armL.rotation.z = -swing * 0.8 + castUp * 1.9
    if (r.armR) r.armR.rotation.z = swing * 0.8 + castUp * 1.9
    if (r.tail)
      r.tail.rotation.y = Math.sin(time * 3 + this.phase * 0.5) * (this.classId === 'venomaw' ? 0.15 : 0.35)
    if (r.head) r.head.rotation.z = s.asleep ? -0.5 : moving ? Math.sin(this.phase * 2) * 0.05 : 0

    // lean into movement, crouch when sliding
    const lean = s.move === 'slide' ? 0.55 : moving ? Math.min(0.25, s.speed * 0.02) : 0
    r.body.rotation.z += -lean * (s.alive ? 1 : 0)
    const bob = moving ? Math.abs(Math.sin(this.phase)) * 0.06 : Math.sin(time * 1.8) * 0.015
    r.body.position.y += bob
    if (s.move === 'slide') r.body.position.y -= 0.35
    if (s.stunned) r.body.rotation.x = Math.sin(time * 18) * 0.06

    if (r.flame) {
      const k = 0.8 + Math.sin(time * 22) * 0.15 + Math.sin(time * 37) * 0.1
      r.flame.scale.set(k, k * 1.2, k)
    }
    const glowPulse = castUp ? 3.5 + Math.sin(time * 14) * 1.2 : 2.2
    for (const m of r.glow) (m as MeshToonMaterial).emissiveIntensity = glowPulse

    this.flash = Math.max(0, this.flash - dt * 6)
    for (const m of this.flashMats) {
      m.emissive.setRGB(this.flash, this.flash, this.flash)
    }
    this.ring.visible = s.alive && !this.isLocal
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as Mesh
      mesh.geometry?.dispose()
    })
  }
}
