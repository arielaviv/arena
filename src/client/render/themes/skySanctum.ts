import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  type IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  type MeshToonMaterial,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { WorldGeometry } from '../../../shared/sim/geometry'
import { ARENA } from '../../../shared/sim/layout'
import { NOISE_GLSL, patchMaterial } from '../shaderlib'
import { toon, withOutline } from '../toon'
import {
  boxAt,
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

const SUN_DIR = new Vector3(-0.55, 0.32, 0.78).normalize()

const C = {
  marble: '#f1e8da',
  marbleDark: '#cbb9a2',
  vein: '#b39d86',
  grout: '#bfae98',
  gold: '#e7b65c',
  goldGlow: '#7a5214',
  rock: '#b98260',
  rockDark: '#7c4f3d',
  grass: '#a7c66a',
}

function floorMaterial(occluders: Array<[number, number, number]>): MeshToonMaterial {
  const occ = occluders.slice(0, 6)
  while (occ.length < 6) occ.push([999, 999, 0])
  const m = toon(C.marble)
  return patchMaterial(
    m,
    {
      uniforms: {
        uMarbleDark: { value: new Color(C.marbleDark) },
        uVein: { value: new Color(C.vein) },
        uGrout: { value: new Color(C.grout) },
        uGold: { value: new Color(C.gold) },
        uGoldGlow: { value: new Color(C.goldGlow) },
      },
      header: /* glsl */ `
        const vec3 OCC[6] = vec3[6](${occ.map(([x, z, r]) => `vec3(${x.toFixed(2)}, ${z.toFixed(2)}, ${r.toFixed(2)})`).join(',')});
        float goldMaskAt(vec2 p) {
          float r = length(p);
          float a = atan(p.y, p.x);
          float m = 0.0;
          m = max(m, smoothstep(0.2, 0.08, abs(r - 4.6)));
          m = max(m, smoothstep(0.16, 0.05, abs(r - 18.0)));
          m = max(m, smoothstep(0.24, 0.1, abs(r - 29.2)));
          // central sun mosaic
          float rays = smoothstep(0.82, 0.9, cos(a * 12.0)) * step(r, 3.8) * step(1.4, r);
          m = max(m, rays);
          m = max(m, smoothstep(1.25, 1.1, r));
          return m;
        }
      `,
      color: /* glsl */ `
        {
          vec2 p = vWorldPos.xz;
          float r = length(p);
          float a = atan(p.y, p.x);
          float n = fbm(p * 0.16);
          float vein = smoothstep(0.035, 0.0, abs(fbm(p * 0.33 + n * 2.3) - 0.5));
          vec3 col = mix(diffuseColor.rgb, uMarbleDark, n * 0.55);
          col = mix(col, uVein, vein * 0.55);
          // polar tiles
          float ringW = 3.0;
          float ri = floor(r / ringW);
          float segs = max(8.0, ri * 6.0);
          float fr = fract(r / ringW);
          float fa = fract((a / 6.28318) * segs);
          float grout = max(smoothstep(0.025, 0.0, fr), smoothstep(0.012 * segs / max(r, 1.0) * 6.0, 0.0, min(fa, 1.0 - fa)) * step(4.8, r));
          col = mix(col, uGrout, grout * 0.7);
          float tileTint = hash12(vec2(ri, floor(fa + (a / 6.28318) * segs))) * 0.06;
          col *= 1.0 - tileTint;
          float g = goldMaskAt(p);
          col = mix(col, uGold, g);
          // contact shadow around pillars
          for (int i = 0; i < 6; i++) {
            float d = length(p - OCC[i].xy) - OCC[i].z;
            col *= mix(0.72, 1.0, smoothstep(0.0, 2.2, d));
          }
          diffuseColor.rgb = col;
        }
      `,
      emissive: /* glsl */ `
        totalEmissiveRadiance += uGoldGlow * goldMaskAt(vWorldPos.xz) * 0.6;
      `,
    },
    'sky-floor',
  )
}

function rockMaterial(): MeshToonMaterial {
  return patchMaterial(
    toon(C.rock),
    {
      uniforms: { uDark: { value: new Color(C.rockDark) } },
      color: /* glsl */ `
        {
          float n = fbm(vWorldPos.xz * 0.08 + vWorldPos.y * 0.15);
          float strata = smoothstep(0.4, 0.6, fract(vWorldPos.y * 0.35 + n));
          diffuseColor.rgb = mix(diffuseColor.rgb, uDark, strata * 0.45 + (1.0 - smoothstep(-30.0, 0.0, vWorldPos.y)) * 0.35);
        }
      `,
    },
    'sky-rock',
  )
}

function jagged(geo: IcosahedronGeometry | ConeGeometry, amount: number): void {
  const pos = geo.attributes.position
  if (!pos) return
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const k = 1 + (Math.sin(v.x * 3.1 + v.z * 1.7) * 0.5 + Math.sin(v.y * 2.3 + v.x) * 0.5) * amount
    pos.setXYZ(i, v.x * k, v.y, v.z * k)
  }
  geo.computeVertexNormals()
}

function cloudSea(): { mesh: Mesh; material: ShaderMaterial } {
  const material = new ShaderMaterial({
    transparent: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uTop: { value: new Color('#ffd9b0') },
      uShade: { value: new Color('#c97a7a') },
      uDeep: { value: new Color('#6d4a7a') },
      uHorizon: { value: new Color('#ffc48a') },
      uSunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uTop; uniform vec3 uShade; uniform vec3 uDeep; uniform vec3 uHorizon; uniform vec3 uSunDir;
      varying vec3 vW;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vW.xz * 0.012 + vec2(uTime * 0.004, uTime * 0.0025);
        float n = fbm(p * 2.0);
        float n2 = fbm(p * 5.0 + n * 1.5 - uTime * 0.01);
        float puff = smoothstep(0.35, 0.8, n * 0.7 + n2 * 0.5);
        vec3 col = mix(uDeep, uShade, smoothstep(0.2, 0.6, n));
        col = mix(col, uTop, puff);
        // light from the low sun on the cloud tops
        float lit = pow(max(0.0, dot(normalize(vec3(uSunDir.x, 0.0, uSunDir.z)), normalize(vec3(vW.x, 0.0, vW.z)))), 3.0);
        col += uTop * lit * puff * 0.35;
        float dist = length(vW.xz);
        col = mix(col, uHorizon, smoothstep(120.0, 520.0, dist));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const mesh = new Mesh(new PlaneGeometry(1400, 1400, 1, 1), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = -34
  return { mesh, material }
}

function waterfall(
  material: ShaderMaterial,
  angle: number,
  radius: number,
  width: number,
  drop: number,
): Mesh {
  const m = new Mesh(new PlaneGeometry(width, drop, 1, 1), material)
  m.position.set(Math.cos(angle) * radius, -drop / 2 - 0.3, Math.sin(angle) * radius)
  m.rotation.y = -angle + Math.PI / 2
  return m
}

function waterfallMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        float streak = fbm(vec2(vUv.x * 9.0, vUv.y * 2.0 + uTime * 1.6));
        float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
        float fade = smoothstep(0.0, 0.5, vUv.y);
        float a = (0.25 + streak * 0.6) * edge * fade;
        vec3 col = mix(vec3(0.55, 0.85, 1.0), vec3(1.0), streak);
        gl_FragColor = vec4(col * 0.9, a * 0.8);
      }
    `,
  })
}

export const SKY_SANCTUM: WorldTheme = {
  id: 'sky',
  name: 'Sky Sanctum',
  exposure: 1.0,
  bloom: { strength: 0.55, threshold: 0.82, radius: 0.6 },
  fog: { color: '#f2b08a', near: 70, far: 420 },
  sun: { color: '#ffd7a8', intensity: 2.7, dir: [SUN_DIR.x, SUN_DIR.y, SUN_DIR.z] },
  hemi: { sky: '#ffe6cc', ground: '#7a5a7c', intensity: 1.05 },
  background: '#ffc48a',

  build(group: Group, geo: WorldGeometry): ThemeInstance {
    const arena = geo.id === 'arena'
    const pillars = geo.prisms.filter((p) => p.tag === 'pillar')
    const occluders: Array<[number, number, number]> = pillars.map((p) => [p.cx, p.cz, p.hx * 1.15])

    const marble = toon(C.marble)
    const marbleDark = toon(C.marbleDark)
    const gold = toon(C.gold, C.goldGlow, 0.5)
    const floorMat = floorMaterial(occluders)
    const rockMat = rockMaterial()

    group.add(skyDome('#38498f', '#d98a7a', '#ffc48a', SUN_DIR, '#fff0c8', 0.025))
    const clouds = cloudSea()
    group.add(clouds.mesh)

    // Platform and floating rock beneath it
    if (arena) {
      const floor = new Mesh(new CylinderGeometry(ARENA.radius + 1.2, ARENA.radius + 1.2, 0.8, 128), floorMat)
      floor.position.y = -0.4
      floor.receiveShadow = true
      group.add(floor)
      const rim = new Mesh(
        new CylinderGeometry(ARENA.radius + 1.25, ARENA.radius + 1.0, 0.5, 128, 1, true),
        gold,
      )
      rim.position.y = -0.5
      group.add(rim)
      const rockGeo = new ConeGeometry(ARENA.radius + 1.6, 30, 20, 4)
      jagged(rockGeo, 0.12)
      const rock = new Mesh(rockGeo, rockMat)
      rock.rotation.x = Math.PI
      rock.position.y = -15.8
      group.add(rock)
    } else {
      const floor = new Mesh(new BoxGeometry(56, 0.8, 40), floorMat)
      floor.position.y = -0.4
      floor.receiveShadow = true
      group.add(floor)
      const rockGeo = new ConeGeometry(30, 22, 16, 3)
      jagged(rockGeo, 0.15)
      const rock = new Mesh(rockGeo, rockMat)
      rock.rotation.x = Math.PI
      rock.position.y = -11.6
      rock.scale.set(1, 1, 0.75)
      group.add(rock)
    }

    for (const s of geo.surfaces) {
      if (s.kind === 'ramp') group.add(rampMesh(s, marble))
      else if (s.kind === 'flat') group.add(flatMesh(s, floorMat, 0.6))
    }

    // Pillars: carved monoliths with gold bands, broken tops and floating chunks.
    const floaters: Array<{ mesh: Mesh; baseY: number; phase: number; spin: number }> = []
    const tmp = new Vector3()
    for (const p of pillars) {
      const h = p.y1 - p.y0
      group.add(boxAt(p.hx * 2 + 0.8, 0.7, p.hz * 2 + 0.8, p.cx, 0.35, p.cz, p.yaw, marbleDark))
      group.add(boxAt(p.hx * 2 + 0.4, 0.35, p.hz * 2 + 0.4, p.cx, 0.85, p.cz, p.yaw, gold))
      const shaftH = h - 2.2
      const shaft = boxAt(p.hx * 2, shaftH, p.hz * 2, p.cx, 1.0 + shaftH / 2, p.cz, p.yaw, marble)
      shaft.add(withOutline(shaft.geometry, 1.015))
      group.add(shaft)
      // vertical gold inlays on each face
      for (const [lx, lz, w, d] of [
        [p.hx + 0.02, 0, 0.06, 0.25],
        [-p.hx - 0.02, 0, 0.06, 0.25],
        [0, p.hz + 0.02, 0.25, 0.06],
        [0, -p.hz - 0.02, 0.25, 0.06],
      ] as const) {
        for (const off of [-1.3, 1.3]) {
          const ox = lz === 0 ? 0 : off
          const oz = lx === 0 ? 0 : off
          localToWorld(p, lx + ox, lz + oz, tmp)
          group.add(boxAt(w, shaftH - 1.2, d, tmp.x, 1.0 + shaftH / 2, tmp.z, p.yaw, gold))
        }
      }
      group.add(boxAt(p.hx * 2 + 0.25, 0.4, p.hz * 2 + 0.25, p.cx, 5.4, p.cz, p.yaw, gold))
      // broken capital
      const cap = boxAt(p.hx * 2 + 0.6, 0.7, p.hz * 2 + 0.6, p.cx, h - 0.85, p.cz, p.yaw, marbleDark)
      cap.rotation.z = 0.04
      group.add(cap)
      localToWorld(p, -0.6, 0.4, tmp)
      const chunk = boxAt(2.6, 1.0, 2.2, tmp.x, h + 0.0, tmp.z, p.yaw + 0.3, marble)
      chunk.rotation.x = 0.12
      group.add(chunk)
      for (let i = 0; i < 3; i++) {
        const s = 0.9 + i * 0.35
        const m = new Mesh(new BoxGeometry(s, s * 0.8, s * 1.1), i === 1 ? gold : marble)
        m.castShadow = true
        localToWorld(p, (i - 1) * 1.6, (i % 2) * 1.2 - 0.6, tmp)
        m.position.set(tmp.x, h + 2 + i * 0.9, tmp.z)
        m.add(withOutline(m.geometry, 1.04))
        group.add(m)
        floaters.push({ mesh: m, baseY: m.position.y, phase: i * 2.1 + p.cx, spin: 0.2 + i * 0.12 })
      }
    }

    // Low cover: fallen column segments
    for (const p of geo.prisms.filter((x) => x.tag === 'cover')) {
      const col = new Mesh(new CylinderGeometry(0.5, 0.5, p.hx * 2, 12), marble)
      col.rotation.z = Math.PI / 2
      col.rotation.y = -p.yaw
      col.position.set(p.cx, 0.5, p.cz)
      col.castShadow = true
      col.receiveShadow = true
      col.add(withOutline(col.geometry, 1.04))
      group.add(col)
      const band = new Mesh(new CylinderGeometry(0.53, 0.53, 0.25, 12), gold)
      band.rotation.copy(col.rotation)
      band.position.copy(col.position)
      group.add(band)
    }

    // Balustrade: marble base, gold rail, instanced balusters
    const walls = geo.prisms.filter((p) => p.tag === 'wall')
    const balGeo = new CylinderGeometry(0.11, 0.14, 0.75, 6)
    const perSeg = 5
    const balusters = new InstancedMesh(balGeo, marble, walls.length * perSeg)
    const mtx = new Matrix4()
    const dummy = new Object3D()
    let bi = 0
    for (const p of walls) {
      if (arena) {
        group.add(boxAt(p.hx * 2, 0.25, p.hz * 2, p.cx, 0.125, p.cz, p.yaw, marbleDark))
        group.add(boxAt(p.hx * 2 + 0.1, 0.18, p.hz * 2 + 0.04, p.cx, p.y1 - 0.09, p.cz, p.yaw, gold))
        for (let k = 0; k < perSeg; k++) {
          const lz = -p.hz + ((k + 0.5) / perSeg) * p.hz * 2
          localToWorld(p, 0, lz, tmp)
          dummy.position.set(tmp.x, 0.25 + 0.375, tmp.z)
          dummy.updateMatrix()
          mtx.copy(dummy.matrix)
          balusters.setMatrixAt(bi++, mtx)
        }
      } else {
        group.add(prismMesh(p, marbleDark, 0, false))
        group.add(boxAt(p.hx * 2 + 0.2, 0.3, p.hz * 2 + 0.2, p.cx, p.y1, p.cz, p.yaw, gold))
      }
    }
    balusters.count = bi
    balusters.castShadow = true
    if (bi > 0) group.add(balusters)

    // Start rooms
    for (const p of geo.prisms.filter((x) => x.tag === 'room')) {
      group.add(prismMesh(p, marbleDark, 0, false))
      group.add(boxAt(p.hx * 2 + 0.15, 0.3, p.hz * 2 + 0.15, p.cx, p.y1 - 0.15, p.cz, p.yaw, gold))
    }

    // Gates: golden barrier inside an arch
    const gateMat = gateMaterial('#ffcf6a')
    for (const p of geo.prisms.filter((x) => x.tag === 'gate')) {
      const plane = new Mesh(new PlaneGeometry(p.hz * 2, p.y1 - p.y0), gateMat)
      plane.position.set(p.cx, (p.y0 + p.y1) / 2, p.cz)
      plane.rotation.y = Math.PI / 2
      group.add(plane)
      for (const side of [-1, 1]) {
        group.add(boxAt(0.8, 5.4, 0.8, p.cx, ARENA.roomY + 2.7, side * (p.hz + 0.4), 0, gold))
      }
      group.add(boxAt(1.0, 0.9, p.hz * 2 + 1.6, p.cx, ARENA.roomY + 5.6, 0, 0, gold))
    }

    // Waterfalls pouring off the edge
    const fallMat = waterfallMaterial()
    if (arena) {
      for (const a of [0.9, 2.25, 4.05, 5.4]) group.add(waterfall(fallMat, a, ARENA.radius + 1.3, 5, 46))
    }

    // Floating islands
    const islands: Array<{ g: Group; baseY: number; phase: number }> = []
    const islandRock = rockMat
    const grass = toon(C.grass)
    const tree = toon('#5f9c5a')
    const rand = mulberry(7)
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + rand() * 0.4
      const r = 85 + rand() * 120
      const s = 3 + rand() * 9
      const g = new Group()
      const rockGeo = new ConeGeometry(s, s * 2.2, 9, 2)
      jagged(rockGeo, 0.18)
      const rk = new Mesh(rockGeo, islandRock)
      rk.rotation.x = Math.PI
      rk.position.y = -s * 1.1
      g.add(rk)
      const top = new Mesh(new CylinderGeometry(s, s * 0.95, s * 0.25, 9), grass)
      g.add(top)
      const trees = 1 + Math.floor(rand() * 4)
      for (let k = 0; k < trees; k++) {
        const t = new Mesh(new ConeGeometry(s * 0.18, s * 0.7, 6), tree)
        t.position.set((rand() - 0.5) * s, s * 0.45, (rand() - 0.5) * s)
        g.add(t)
      }
      if (rand() > 0.5) {
        const ruin = new Mesh(new BoxGeometry(s * 0.2, s * 0.9, s * 0.2), marble)
        ruin.position.set((rand() - 0.5) * s * 0.6, s * 0.5, (rand() - 0.5) * s * 0.6)
        g.add(ruin)
      }
      const baseY = -18 + rand() * 40
      g.position.set(Math.cos(a) * r, baseY, Math.sin(a) * r)
      group.add(g)
      islands.push({ g, baseY, phase: rand() * 10 })
    }

    const motes = driftParticles(arena ? 420 : 220, arena ? 34 : 28, 14, '#ffd27a', 2.2, 0.35, true)
    group.add(motes.points)

    return {
      update(dt, time) {
        clouds.material.uniforms.uTime!.value = time
        fallMat.uniforms.uTime!.value = time
        gateMat.uniforms.uTime!.value = time
        motes.material.uniforms.uTime!.value = time
        for (const f of floaters) {
          f.mesh.position.y = f.baseY + Math.sin(time * 0.8 + f.phase) * 0.35
          f.mesh.rotation.y += f.spin * dt
          f.mesh.rotation.x = Math.sin(time * 0.5 + f.phase) * 0.15
        }
        for (const isl of islands) isl.g.position.y = isl.baseY + Math.sin(time * 0.25 + isl.phase) * 1.2
      },
      setGates(closed) {
        gateMat.uniforms.uOpen!.value = closed ? 0 : 1
      },
    }
  },
}

export function mulberry(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
