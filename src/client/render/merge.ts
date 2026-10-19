import { type BufferGeometry, type Group, type Material, Mesh, type Object3D } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

function isDynamic(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (p.userData.dynamic) return true
  return false
}

// Bake every static mesh in a level into one mesh per material: hundreds of
// boxes become a handful of draw calls.
export function mergeStatic(group: Group): number {
  group.updateMatrixWorld(true)
  const buckets = new Map<
    string,
    { material: Material; cast: boolean; receive: boolean; geos: BufferGeometry[] }
  >()
  const remove: Mesh[] = []
  group.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh || (mesh as { isInstancedMesh?: boolean }).isInstancedMesh) return
    if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh || Array.isArray(mesh.material)) return
    if (!mesh.frustumCulled || isDynamic(mesh)) return
    const geo = mesh.geometry
    if (!geo.index || !geo.attributes.normal || !geo.attributes.uv) return
    const material = mesh.material
    const key = `${material.uuid}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`
    let b = buckets.get(key)
    if (!b) {
      b = { material, cast: mesh.castShadow, receive: mesh.receiveShadow, geos: [] }
      buckets.set(key, b)
    }
    const g = geo.clone()
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
    }
    g.applyMatrix4(mesh.matrixWorld)
    b.geos.push(g)
    remove.push(mesh)
  })
  for (const mesh of remove) {
    // Children (outline hulls) were collected on their own; detach everything.
    mesh.parent?.remove(mesh)
  }
  let merged = 0
  for (const b of buckets.values()) {
    if (b.geos.length === 0) continue
    const geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false)
    if (!geo) continue
    const m = new Mesh(geo, b.material)
    m.castShadow = b.cast
    m.receiveShadow = b.receive
    group.add(m)
    merged++
    for (const g of b.geos) if (g !== geo) g.dispose()
  }
  return merged
}
