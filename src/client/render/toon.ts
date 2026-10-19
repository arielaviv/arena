import {
  BackSide,
  type BufferGeometry,
  Color,
  type ColorRepresentation,
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
} from 'three'

let ramp: DataTexture | null = null

// Hard three-step light ramp for cel shading.
export function toonRamp(): DataTexture {
  if (ramp) return ramp
  const data = new Uint8Array([70, 150, 255])
  ramp = new DataTexture(data, data.length, 1, RedFormat)
  ramp.minFilter = NearestFilter
  ramp.magFilter = NearestFilter
  ramp.needsUpdate = true
  return ramp
}

export function toon(
  color: ColorRepresentation,
  emissive?: ColorRepresentation,
  emissiveIntensity = 1,
): MeshToonMaterial {
  const m = new MeshToonMaterial({ color, gradientMap: toonRamp() })
  if (emissive !== undefined) {
    m.emissive = new Color(emissive)
    m.emissiveIntensity = emissiveIntensity
  }
  return m
}

const outlineCache = new Map<string, MeshBasicMaterial>()

export function outlineMaterial(color: ColorRepresentation = '#0c0c0f'): MeshBasicMaterial {
  const key = String(color)
  let m = outlineCache.get(key)
  if (!m) {
    m = new MeshBasicMaterial({ color, side: BackSide })
    outlineCache.set(key, m)
  }
  return m
}

// Inverted-hull outline: a slightly larger back-face copy of the mesh.
export function withOutline(geometry: BufferGeometry, scale = 1.04, color?: ColorRepresentation): Mesh {
  const m = new Mesh(geometry, outlineMaterial(color))
  m.scale.setScalar(scale)
  m.castShadow = false
  m.receiveShadow = false
  return m
}
