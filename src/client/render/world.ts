import { Color, DirectionalLight, Fog, Group, HemisphereLight, type Scene } from 'three'
import type { WorldGeometry } from '../../shared/sim/geometry'
import type { ThemeInstance, WorldTheme } from './themes/common'
import { OBSIDIAN_CALDERA } from './themes/obsidianCaldera'
import { SKY_SANCTUM } from './themes/skySanctum'

export type ThemeId = WorldTheme['id']
export const THEMES: Record<ThemeId, WorldTheme> = { sky: SKY_SANCTUM, caldera: OBSIDIAN_CALDERA }

// Builds the dressed level for a geometry + theme and owns the lights.
export class WorldView {
  readonly group = new Group()
  readonly theme: WorldTheme
  private readonly instance: ThemeInstance
  private readonly sun: DirectionalLight
  private readonly hemi: HemisphereLight

  constructor(
    private readonly scene: Scene,
    geo: WorldGeometry,
    themeId: ThemeId,
    shadowSize: number,
  ) {
    this.theme = THEMES[themeId]
    const t = this.theme
    scene.background = new Color(t.background)
    scene.fog = new Fog(t.fog.color, t.fog.near, t.fog.far)

    this.hemi = new HemisphereLight(t.hemi.sky, t.hemi.ground, t.hemi.intensity)
    this.group.add(this.hemi)

    this.sun = new DirectionalLight(t.sun.color, t.sun.intensity)
    const [dx, dy, dz] = t.sun.dir
    this.sun.position.set(dx * 80, dy * 80, dz * 80)
    this.sun.target.position.set(0, 0, 0)
    this.sun.castShadow = shadowSize > 0
    if (shadowSize > 0) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize)
      const b = geo.bounds
      const cam = this.sun.shadow.camera
      cam.left = -b
      cam.right = b
      cam.top = b
      cam.bottom = -b
      cam.near = 10
      cam.far = 200
      this.sun.shadow.bias = -0.0004
      this.sun.shadow.normalBias = 0.04
    }
    this.group.add(this.sun)
    this.group.add(this.sun.target)

    this.instance = t.build(this.group, geo)
    scene.add(this.group)
  }

  update(dt: number, time: number): void {
    this.instance.update(dt, time)
  }

  setGates(closed: boolean): void {
    this.instance.setGates(closed)
  }

  dispose(): void {
    this.scene.remove(this.group)
    this.group.traverse((o) => {
      const mesh = o as {
        geometry?: { dispose(): void }
        material?: { dispose(): void } | Array<{ dispose(): void }>
      }
      mesh.geometry?.dispose()
      const m = mesh.material
      if (Array.isArray(m)) for (const x of m) x.dispose()
      else m?.dispose()
    })
  }
}
