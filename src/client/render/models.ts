import {
  type AnimationClip,
  BackSide,
  Box3,
  type Group,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type MeshToonMaterial,
  type Object3D,
  SkinnedMesh,
  type Texture,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { ClassId } from '../../shared/combat/types'
import { toon } from './toon'

// Creature models: "Ultimate Monsters" by Quaternius (CC0).
interface ModelSpec {
  file: string
  height: number
  hueShift: number // turns (0..1), applied to saturated colours only
  minSat: number
  boost?: number // saturation/brightness lift for shifted colours
}

const SPECS: Partial<Record<ClassId, ModelSpec>> = {
  cindrake: { file: 'cindrake.glb', height: 1.9, hueShift: 0.075, minSat: 0.25, boost: 1.45 },
  tidehorn: { file: 'tidehorn.glb', height: 2.0, hueShift: 0, minSat: 1 },
  venomaw: { file: 'venomaw.glb', height: 1.75, hueShift: 0.12, minSat: 0.3 },
  lumora: { file: 'lumora.glb', height: 1.95, hueShift: 0.02, minSat: 0.3 },
  petalyn: { file: 'petalyn.glb', height: 1.95, hueShift: 0.38, minSat: 0.45 },
}

export interface ModelEntry {
  scene: Group
  clips: AnimationClip[]
  scale: number
  map: Texture | null
  spec: ModelSpec
}

export interface ModelInstance {
  root: Object3D
  clips: AnimationClip[]
  materials: MeshToonMaterial[]
}

const HUE_GLSL = /* glsl */ `
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`

function makeMaterial(id: ClassId, spec: ModelSpec, map: Texture | null): MeshToonMaterial {
  const m = toon('#ffffff')
  m.map = map
  m.side = 2
  if (spec.hueShift !== 0) {
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${HUE_GLSL}`)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          {
            vec3 hsv = rgb2hsv(diffuseColor.rgb);
            float k = smoothstep(${spec.minSat.toFixed(3)}, ${(spec.minSat + 0.12).toFixed(3)}, hsv.y);
            hsv.x = fract(hsv.x + ${spec.hueShift.toFixed(3)} * k);
            hsv.y = min(1.0, hsv.y * mix(1.0, ${(spec.boost ?? 1).toFixed(3)}, k));
            hsv.z = min(1.0, hsv.z * mix(1.0, ${(spec.boost ?? 1).toFixed(3)}, k));
            diffuseColor.rgb = hsv2rgb(hsv);
          }`,
        )
    }
    m.customProgramCacheKey = () => `creature-${id}`
  }
  return m
}

// Back-face hull pushed out along skinned normals: outlines that follow the animation.
function outlineMaterial(thickness: number): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color: '#0c0c0f', side: BackSide })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <skinning_vertex>',
      `#include <skinning_vertex>\ntransformed += normalize(objectNormal) * ${thickness.toFixed(4)};`,
    )
  }
  m.customProgramCacheKey = () => `outline-${thickness.toFixed(4)}`
  return m
}

class ModelLibrary {
  private readonly entries = new Map<ClassId, ModelEntry>()
  private readonly pending = new Map<ClassId, Promise<void>>()
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  onLoaded: ((id: ClassId) => void) | null = null

  has(id: ClassId): boolean {
    return this.entries.has(id)
  }

  load(id: ClassId): Promise<void> {
    const spec = SPECS[id]
    if (!spec) return Promise.resolve()
    const existing = this.pending.get(id)
    if (existing) return existing
    const p = this.loader
      .loadAsync(`${import.meta.env.BASE_URL}models/${spec.file}`)
      .then((gltf) => {
        const scene = gltf.scene
        const box = new Box3().setFromObject(scene)
        const size = box.getSize(new Vector3())
        let map: Texture | null = null
        scene.traverse((o) => {
          const mesh = o as Mesh
          if (!mesh.isMesh) return
          const mat = mesh.material as Material & { map?: Texture | null }
          if (mat.map) map = mat.map
        })
        this.entries.set(id, { scene, clips: gltf.animations, scale: spec.height / size.y, map, spec })
        this.onLoaded?.(id)
      })
      .catch((err: unknown) => {
        console.warn(`model ${id} failed to load`, err)
      })
    this.pending.set(id, p)
    return p
  }

  loadAll(): Promise<void> {
    return Promise.all((Object.keys(SPECS) as ClassId[]).map((id) => this.load(id))).then(() => undefined)
  }

  instance(id: ClassId): ModelInstance | null {
    const e = this.entries.get(id)
    if (!e) return null
    const root = cloneSkinned(e.scene)
    root.scale.setScalar(e.scale)
    // glTF faces +Z; our creatures face +X.
    root.rotation.y = Math.PI / 2
    const materials: MeshToonMaterial[] = []
    const outline = outlineMaterial(0.022 / e.scale)
    const extra: Array<{ parent: Object3D; mesh: SkinnedMesh }> = []
    root.traverse((o) => {
      const mesh = o as SkinnedMesh
      if (!mesh.isMesh) return
      const mat = makeMaterial(id, e.spec, e.map)
      materials.push(mat)
      mesh.material = mat
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.frustumCulled = false
      if (mesh.isSkinnedMesh && mesh.parent) {
        const hull = new SkinnedMesh(mesh.geometry, outline)
        hull.position.copy(mesh.position)
        hull.quaternion.copy(mesh.quaternion)
        hull.scale.copy(mesh.scale)
        hull.bind(mesh.skeleton, mesh.bindMatrix)
        hull.frustumCulled = false
        extra.push({ parent: mesh.parent, mesh: hull })
      }
    })
    for (const x of extra) x.parent.add(x.mesh)
    return { root, clips: e.clips, materials }
  }
}

export const models = new ModelLibrary()
