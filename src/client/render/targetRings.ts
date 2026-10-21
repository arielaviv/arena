import { DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, type Scene } from 'three'

interface At {
  x: number
  y: number
  z: number
}

// Selection circles on the ground: red under your target, green under your
// heal target, a faint one under whatever the cursor is over. Normal
// blending, so they read on bright marble as well as dark basalt.
export class TargetRings {
  readonly group = new Group()
  private readonly geo = new RingGeometry(0.72, 0.98, 56)
  private readonly target = this.ring('#e11d48', 0.9)
  private readonly ally = this.ring('#16a34a', 0.85)
  private readonly hover = this.ring('#fafafa', 0.4)
  private time = 0

  constructor(private readonly scene: Scene) {
    scene.add(this.group)
  }

  private ring(color: string, opacity: number): Mesh {
    const mat = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: DoubleSide,
    })
    const m = new Mesh(this.geo, mat)
    m.rotation.x = -Math.PI / 2
    m.renderOrder = 2
    m.visible = false
    this.group.add(m)
    return m
  }

  update(dt: number, target: At | null, ally: At | null, hover: At | null): void {
    this.time += dt
    const pulse = 1 + Math.sin(this.time * 5) * 0.04
    place(this.target, target, pulse)
    place(this.ally, ally, pulse)
    place(this.hover, hover, 1)
  }

  dispose(): void {
    this.scene.remove(this.group)
    this.geo.dispose()
    for (const m of [this.target, this.ally, this.hover]) (m.material as MeshBasicMaterial).dispose()
  }
}

function place(m: Mesh, at: At | null, scale: number): void {
  m.visible = at !== null
  if (!at) return
  m.position.set(at.x, at.y + 0.04, at.z)
  m.scale.setScalar(scale)
}
