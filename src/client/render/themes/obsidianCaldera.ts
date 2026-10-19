import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  type Group,
  InstancedMesh,
  Mesh,
  type MeshToonMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { WorldGeometry } from '../../../shared/sim/geometry'
import { ARENA } from '../../../shared/sim/layout'
import { flameMaterial } from '../fx/materials'
import { NOISE_GLSL, patchMaterial } from '../shaderlib'
import { toon, withOutline } from '../toon'
import {
  boxAt,
  dressStartRooms,
  driftParticles,
  flatMesh,
  gateMaterial,
  localToWorld,
  prismMesh,
  rampMesh,
  skyDome,
  type ThemeInstance,
  type WorldTheme,
} from './common'
import { mulberry } from './skySanctum'

const GLOW_DIR = new Vector3(0.6, 0.18, -0.75).normalize()

const C = {
  basalt: '#3a3132',
  basaltLight: '#5a4b47',
  obsidian: '#1f1a24',
  lava: '#ff5a14',
  lavaHot: '#ffc04a',
  crust: '#2a1714',
}

const time = { value: 0 }

function hexFloorMaterial(occluders: Array<[number, number, number]>): MeshToonMaterial {
  const occ = occluders.slice(0, 6)
  while (occ.length < 6) occ.push([999, 999, 0])
  return patchMaterial(
    toon(C.basalt),
    {
      uniforms: {
        uLight: { value: new Color(C.basaltLight) },
        uLava: { value: new Color(C.lava) },
        uHot: { value: new Color(C.lavaHot) },
        uTime: time,
      },
      header: /* glsl */ `
        const vec3 OCC[6] = vec3[6](${occ.map(([x, z, r]) => `vec3(${x.toFixed(2)}, ${z.toFixed(2)}, ${r.toFixed(2)})`).join(',')});
        // distance to hex cell edge (0 at edge) and cell id
        vec3 hexInfo(vec2 p) {
          vec2 s = vec2(1.0, 1.7320508);
          vec2 h = s * 0.5;
          vec2 a = mod(p, s) - h;
          vec2 b = mod(p - h, s) - h;
          vec2 g = dot(a, a) < dot(b, b) ? a : b;
          vec2 id = p - g;
          vec2 q = abs(g);
          float edge = 0.5 - max(dot(q, s * 0.5), q.x);
          return vec3(edge, id);
        }
        // Lava shows through a few meandering fault lines and the odd broken
        // tile edge, not every seam.
        float faultDist(vec2 p, float ang, float off) {
          vec2 d = vec2(cos(ang), sin(ang));
          vec2 n = vec2(-d.y, d.x);
          float along = dot(p, d);
          float across = dot(p, n) - off;
          return abs(across - sin(along * 0.16) * 4.5 - sin(along * 0.43 + off) * 1.3);
        }
        float crackMask(vec2 p) {
          vec3 hi = hexInfo(p / 1.6);
          float edge = 1.0 - smoothstep(0.0, 0.05, hi.x);
          float d = min(min(faultDist(p, 0.35, 6.0), faultDist(p, 2.1, -9.0)), faultDist(p, 1.2, 15.0));
          float fault = 1.0 - smoothstep(0.35, 1.5, d);
          float broken = step(0.9, hash12(floor(hi.yz * 3.0 + 0.5)));
          return edge * clamp(max(fault, broken * 0.6), 0.0, 1.0);
        }
      `,
      color: /* glsl */ `
        {
          vec2 p = vWorldPos.xz;
          vec3 hi = hexInfo(p / 1.6);
          float cell = hash12(hi.yz);
          vec3 col = mix(diffuseColor.rgb, uLight, cell * 0.35 + fbm(p * 0.6) * 0.2);
          col *= 0.85 + 0.15 * smoothstep(0.0, 0.12, hi.x);
          float r = length(p);
          col = mix(col, uLight * 0.8, smoothstep(0.12, 0.04, abs(r - 29.2)));
          for (int i = 0; i < 6; i++) {
            float d = length(p - OCC[i].xy) - OCC[i].z;
            col *= mix(0.65, 1.0, smoothstep(0.0, 2.4, d));
          }
          diffuseColor.rgb = col * (1.0 - crackMask(p) * 0.8);
        }
      `,
      emissive: /* glsl */ `
        {
          vec2 p = vWorldPos.xz;
          float c = crackMask(p);
          float pulse = 0.65 + 0.35 * sin(uTime * 1.6 + fbm(p * 0.2) * 12.0);
          totalEmissiveRadiance += mix(uLava, uHot, fbm(p * 0.5 + uTime * 0.1)) * c * pulse * 2.2;
        }
      `,
    },
    'caldera-floor',
  )
}

function obsidianMaterial(): MeshToonMaterial {
  return patchMaterial(
    toon(C.obsidian),
    {
      uniforms: { uLava: { value: new Color(C.lava) }, uTime: time },
      emissive: /* glsl */ `
        {
          vec3 w = vWorldPos;
          float n = fbm(vec2(w.x + w.z, w.y * 0.7) * 0.45);
          float vein = smoothstep(0.016, 0.0, abs(n - 0.5)) * smoothstep(8.0, 0.5, w.y);
          float pulse = 0.7 + 0.3 * sin(uTime * 2.0 + w.y);
          totalEmissiveRadiance += uLava * vein * pulse * 1.7;
        }
      `,
    },
    'caldera-obsidian',
  )
}

function lavaSea(): Mesh {
  const material = new ShaderMaterial({
    fog: false,
    uniforms: {
      uTime: time,
      uLava: { value: new Color(C.lava) },
      uHot: { value: new Color(C.lavaHot) },
      uCrust: { value: new Color(C.crust) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uLava; uniform vec3 uHot; uniform vec3 uCrust;
      varying vec3 vW;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vW.xz * 0.05;
        float flow = fbm(p + vec2(uTime * 0.02, uTime * 0.013));
        float crust = smoothstep(0.45, 0.62, fbm(p * 2.2 + flow * 1.8 - uTime * 0.015));
        vec3 hot = mix(uLava, uHot, smoothstep(0.5, 0.85, flow));
        vec3 col = mix(hot * 1.8, uCrust, crust);
        float dist = length(vW.xz);
        col = mix(col, vec3(0.25, 0.08, 0.05), smoothstep(150.0, 420.0, dist));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const m = new Mesh(new PlaneGeometry(1200, 1200), material)
  m.rotation.x = -Math.PI / 2
  m.position.y = -7
  return m
}

function craterWall(rockMat: MeshToonMaterial): Mesh {
  const geo = new CylinderGeometry(150, 175, 110, 72, 6, true)
  const pos = geo.attributes.position
  if (pos) {
    const v = new Vector3()
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      const a = Math.atan2(v.z, v.x)
      const k = 1 + Math.sin(a * 9) * 0.04 + Math.sin(a * 23 + v.y * 0.1) * 0.03
      const top = v.y > 40 ? Math.sin(a * 13) * 14 + Math.sin(a * 5) * 10 : 0
      pos.setXYZ(i, v.x * k, v.y + top, v.z * k)
    }
    geo.computeVertexNormals()
  }
  const m = new Mesh(geo, rockMat)
  m.material.side = 2
  m.position.y = 40
  return m
}

export const OBSIDIAN_CALDERA: WorldTheme = {
  id: 'caldera',
  name: 'Obsidian Caldera',
  exposure: 1.1,
  bloom: { strength: 0.85, threshold: 0.9, radius: 0.7 },
  fog: { color: '#3a1610', near: 55, far: 260 },
  sun: { color: '#ffb08a', intensity: 1.7, dir: [-0.35, 0.9, 0.25] },
  hemi: { sky: '#4a2c30', ground: '#ff6a2a', intensity: 1.15 },
  background: '#2a0f0c',

  build(group: Group, geo: WorldGeometry): ThemeInstance {
    const arena = geo.id === 'arena'
    const pillars = geo.prisms.filter((p) => p.tag === 'pillar')
    const floorMat = hexFloorMaterial(pillars.map((p) => [p.cx, p.cz, p.hx * 1.15]))
    const basalt = toon(C.basalt)
    const basaltLight = toon(C.basaltLight)
    const obsidian = obsidianMaterial()
    const lavaGlow = toon(C.lava, C.lava, 2.4)

    group.add(skyDome('#0d0709', '#3a1410', '#b8401a', GLOW_DIR, '#ff7a2a', 0.08))
    group.add(lavaSea())
    group.add(craterWall(toon('#2a2020')))

    if (arena) {
      const floor = new Mesh(new CylinderGeometry(ARENA.radius + 1.2, ARENA.radius + 1.2, 0.8, 128), floorMat)
      floor.position.y = -0.4
      floor.receiveShadow = true
      group.add(floor)
      // Basalt column cluster holding the platform out of the lava
      const colGeo = new CylinderGeometry(1, 1, 1, 6)
      const cols = new InstancedMesh(colGeo, basalt, 180)
      const d = new Object3D()
      const rand = mulberry(11)
      let n = 0
      for (let ring = 0; ring < 4; ring++) {
        const r = ARENA.radius + 1 - ring * 2.2
        const count = Math.floor((r * Math.PI * 2) / 2.1)
        for (let i = 0; i < count && n < 180; i++) {
          const a = (i / count) * Math.PI * 2 + ring * 0.3
          const h = 7 + rand() * 3 - ring * 0.5
          d.position.set(Math.cos(a) * r, -h / 2 - 0.5, Math.sin(a) * r)
          d.scale.set(1.1, h, 1.1)
          d.rotation.y = rand()
          d.updateMatrix()
          cols.setMatrixAt(n++, d.matrix)
        }
      }
      cols.count = n
      group.add(cols)
    } else {
      const floor = new Mesh(new BoxGeometry(56, 0.8, 40), floorMat)
      floor.position.y = -0.4
      floor.receiveShadow = true
      group.add(floor)
      const base = new Mesh(new BoxGeometry(56, 7, 40), basalt)
      base.position.y = -4.3
      group.add(base)
    }

    for (const s of geo.surfaces) {
      if (s.kind === 'ramp') group.add(rampMesh(s, basaltLight))
      else if (s.kind === 'flat') group.add(flatMesh(s, floorMat, 0.6))
    }

    // Obsidian monoliths with magma veins and jagged crowns
    const embersAbove: Array<{ mesh: Mesh; baseY: number; phase: number }> = []
    const tmp = new Vector3()
    for (const p of pillars) {
      const h = p.y1 - p.y0
      group.add(boxAt(p.hx * 2 + 0.9, 0.8, p.hz * 2 + 0.9, p.cx, 0.4, p.cz, p.yaw, basalt))
      const shaft = boxAt(p.hx * 2, h - 1.2, p.hz * 2, p.cx, 0.8 + (h - 1.2) / 2, p.cz, p.yaw, obsidian)
      shaft.add(withOutline(shaft.geometry, 1.015, '#000000'))
      group.add(shaft)
      for (let i = 0; i < 4; i++) {
        localToWorld(p, (i % 2 ? 1 : -1) * (p.hx - 0.7), (i < 2 ? 1 : -1) * (p.hz - 0.7), tmp)
        const spike = new Mesh(new ConeGeometry(0.9, 2.4 + (i % 3) * 0.9, 5), obsidian)
        spike.position.set(tmp.x, h + 0.9, tmp.z)
        spike.rotation.set((i - 1.5) * 0.12, i, (i % 2) * 0.15)
        spike.castShadow = true
        group.add(spike)
      }
      const core = new Mesh(new BoxGeometry(1.2, 1.2, 1.2), lavaGlow)
      core.position.set(p.cx, h + 2.4, p.cz)
      core.userData.dynamic = true
      group.add(core)
      embersAbove.push({ mesh: core, baseY: core.position.y, phase: p.cx })
    }

    for (const p of geo.prisms.filter((x) => x.tag === 'cover')) {
      group.add(prismMesh(p, basaltLight, 0, true))
      group.add(boxAt(p.hx * 2 - 0.3, 0.08, 0.12, p.cx, p.y1 + 0.01, p.cz, p.yaw, lavaGlow))
    }

    for (const p of geo.prisms.filter((x) => x.tag === 'wall')) {
      group.add(prismMesh(p, basalt, 0, false))
      group.add(boxAt(p.hx * 2 * 0.4, 0.1, p.hz * 2 + 0.02, p.cx, p.y1 + 0.02, p.cz, p.yaw, lavaGlow))
    }
    for (const p of geo.prisms.filter((x) => x.tag === 'room')) {
      group.add(prismMesh(p, basalt, 0, false))
    }

    const gateMat = gateMaterial('#ff6a1f')
    for (const p of geo.prisms.filter((x) => x.tag === 'gate')) {
      const plane = new Mesh(new PlaneGeometry(p.hz * 2, p.y1 - p.y0), gateMat)
      plane.position.set(p.cx, (p.y0 + p.y1) / 2, p.cz)
      plane.rotation.y = Math.PI / 2
      group.add(plane)
      for (const side of [-1, 1]) {
        const post = new Mesh(new CylinderGeometry(0.55, 0.75, 6, 6), obsidian)
        post.position.set(p.cx, ARENA.roomY + 3, side * (p.hz + 0.5))
        group.add(post)
      }
    }

    dressStartRooms(group, geo, basaltLight, obsidian, flameMaterial('#ffcf5a', '#d93a06'))

    const embers = driftParticles(arena ? 520 : 260, arena ? 36 : 28, 18, '#ff8a3a', 2.4, 1.6, true)
    group.add(embers.points)
    const ash = driftParticles(arena ? 380 : 200, arena ? 40 : 30, 18, '#9a8f8a', 1.6, -0.6, false)
    ash.material.blending = NormalBlending
    group.add(ash.points)

    return {
      update(_dt, t) {
        time.value = t
        gateMat.uniforms.uTime!.value = t
        embers.material.uniforms.uTime!.value = t
        ash.material.uniforms.uTime!.value = t
        for (const e of embersAbove) {
          e.mesh.position.y = e.baseY + Math.sin(t * 1.3 + e.phase) * 0.3
          e.mesh.rotation.y = t * 0.6
          e.mesh.rotation.x = t * 0.4
        }
      },
      setGates(closed) {
        gateMat.uniforms.uOpen!.value = closed ? 0 : 1
      },
    }
  },
}
