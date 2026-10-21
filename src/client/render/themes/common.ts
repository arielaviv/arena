import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  type ColorRepresentation,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  type Group,
  type Material,
  Mesh,
  MeshToonMaterial,
  NormalBlending,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
  type Vector3,
} from 'three'
import type { FlatSurface, Prism, RampSurface, WorldGeometry } from '../../../shared/sim/geometry'
import { NOISE_GLSL } from '../shaderlib'
import { withOutline } from '../toon'

export interface ThemeInstance {
  update(dt: number, time: number): void
  setGates(closed: boolean): void
}

export interface WorldTheme {
  id: 'sky' | 'caldera'
  name: string
  exposure: number
  bloom: { strength: number; threshold: number; radius: number }
  fog: { color: string; near: number; far: number }
  sun: { color: string; intensity: number; dir: [number, number, number] }
  hemi: { sky: string; ground: string; intensity: number }
  background: string
  build(group: Group, geo: WorldGeometry): ThemeInstance
}

export function prismMesh(p: Prism, material: Material, inset = 0, outline = false): Mesh {
  const h = p.y1 - p.y0
  const geo = new BoxGeometry(Math.max(0.05, p.hx * 2 - inset), h, Math.max(0.05, p.hz * 2 - inset))
  const m = new Mesh(geo, material)
  m.position.set(p.cx, p.y0 + h / 2, p.cz)
  m.rotation.y = -p.yaw
  m.castShadow = true
  m.receiveShadow = true
  if (outline) m.add(withOutline(geo, 1.02))
  return m
}

export function boxAt(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  material: Material,
): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), material)
  m.position.set(x, y, z)
  m.rotation.y = -yaw
  m.castShadow = true
  m.receiveShadow = true
  return m
}

// Place a child in a prism's local frame (local x/z, world y).
export function localToWorld(p: Prism, lx: number, lz: number, out: Vector3, y = 0): Vector3 {
  return out.set(p.cx + lx * p.cos - lz * p.sin, y, p.cz + lx * p.sin + lz * p.cos)
}

export function rampMesh(s: RampSurface, material: Material): Mesh {
  const len = s.hx * 2
  const rise = s.yHigh - s.yLow
  const slopeLen = Math.hypot(len, rise)
  const geo = new BoxGeometry(slopeLen, 0.3, s.hz * 2)
  const m = new Mesh(geo, material)
  m.position.set(s.cx, (s.yLow + s.yHigh) / 2 - 0.15, s.cz)
  m.rotation.order = 'YZX'
  m.rotation.y = -s.yaw
  m.rotation.z = Math.atan2(rise, len)
  m.receiveShadow = true
  return m
}

export function flatMesh(s: FlatSurface, material: Material, thickness = 0.4): Mesh {
  const m = new Mesh(new BoxGeometry(s.hx * 2, thickness, s.hz * 2), material)
  m.position.set(s.cx, s.y - thickness / 2, s.cz)
  m.rotation.y = -s.yaw
  m.receiveShadow = true
  return m
}

export function skyDome(
  top: ColorRepresentation,
  mid: ColorRepresentation,
  horizon: ColorRepresentation,
  sunDir: Vector3,
  sunColor: ColorRepresentation,
  sunSize = 0.03,
): Mesh {
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new Color(top) },
      uMid: { value: new Color(mid) },
      uHorizon: { value: new Color(horizon) },
      uSunDir: { value: sunDir.clone().normalize() },
      uSun: { value: new Color(sunColor) },
      uSunSize: { value: sunSize },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSun; uniform float uSunSize;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 col = mix(uHorizon, uMid, smoothstep(-0.05, 0.25, h));
        col = mix(col, uTop, smoothstep(0.25, 0.9, h));
        float s = max(dot(normalize(vDir), uSunDir), 0.0);
        col += uSun * (pow(s, 8.0) * 0.35 + pow(s, 64.0) * 0.6);
        col += uSun * smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.6, s) * 1.3;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const m = new Mesh(new SphereGeometry(600, 32, 16), mat)
  m.frustumCulled = false
  m.renderOrder = -10
  return m
}

// Drifting particles (motes, embers, ash) in a box around the arena.
export function driftParticles(
  count: number,
  radius: number,
  height: number,
  color: ColorRepresentation,
  size: number,
  rise: number,
  additive: boolean,
): { points: Points; material: ShaderMaterial } {
  const pos = new Float32Array(count * 3)
  const seed = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * radius
    pos[i * 3] = Math.cos(a) * r
    pos[i * 3 + 1] = Math.random() * height
    pos[i * 3 + 2] = Math.sin(a) * r
    seed[i] = Math.random()
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new BufferAttribute(seed, 1))
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? AdditiveBlending : NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(color) },
      uSize: { value: size },
      uHeight: { value: height },
      uRise: { value: rise },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime; uniform float uSize; uniform float uHeight; uniform float uRise;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float t = uTime * (0.6 + aSeed * 0.8);
        p.y = mod(p.y + t * uRise, uHeight);
        p.x += sin(t * 0.7 + aSeed * 40.0) * 1.5;
        p.z += cos(t * 0.5 + aSeed * 23.0) * 1.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(uSize * (0.5 + aSeed) * (120.0 / -mv.z), 9.0);
        float edge = smoothstep(0.0, 0.1, p.y / uHeight) * smoothstep(1.0, 0.85, p.y / uHeight);
        vAlpha = edge * (0.5 + 0.5 * sin(t * 3.0 + aSeed * 10.0));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = smoothstep(0.5, 0.0, d) * vAlpha;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  const points = new Points(geo, material)
  points.frustumCulled = false
  return { points, material }
}

export function gateMaterial(color: ColorRepresentation): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: 2,
    uniforms: { uTime: { value: 0 }, uColor: { value: new Color(color) }, uOpen: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uOpen;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        float n = fbm(vUv * vec2(6.0, 10.0) + vec2(0.0, -uTime * 0.8));
        float hex = abs(sin(vUv.x * 40.0) * sin(vUv.y * 40.0 + uTime));
        float edge = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
        float a = (0.08 + n * 0.22 + hex * 0.06) * edge * (1.0 - uOpen);
        gl_FragColor = vec4(uColor * (0.8 + n * 0.6), a);
      }
    `,
  })
}

export function columnGeometry(radius: number, height: number, sides = 10): CylinderGeometry {
  return new CylinderGeometry(radius, radius, height, sides)
}

// Team banners and gate braziers for both start rooms (first thing a player
// sees after MATCH FOUND).
export function dressStartRooms(
  group: Group,
  geo: WorldGeometry,
  trim: Material,
  stone: Material,
  flame: Material,
): void {
  if (geo.id !== 'arena') return
  const teamColor = ['#2b7fd8', '#d63a4f']
  for (const team of [0, 1] as const) {
    const s = team === 0 ? -1 : 1
    const backX = s * 44.0
    const cloth = new MeshToonClothMaterial(teamColor[team] ?? '#888')
    for (const z of [-3.2, 0, 3.2]) {
      const banner = new Mesh(new PlaneGeometry(1.5, 3.6), cloth)
      banner.position.set(backX - s * 0.05, 4.1, z)
      banner.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2
      group.add(banner)
      const rod = new Mesh(new BoxGeometry(0.1, 0.1, 1.8), trim)
      rod.position.set(backX - s * 0.08, 5.95, z)
      group.add(rod)
      const emblem = new Mesh(new CircleGeometry(0.42, 24), trim)
      emblem.position.set(backX - s * 0.07, 4.5, z)
      emblem.rotation.y = banner.rotation.y
      group.add(emblem)
    }
    // braziers either side of the gate, inside the room
    for (const z of [-5.5, 5.5]) {
      const x = s * 39.6
      const base = new Mesh(new CylinderGeometry(0.35, 0.5, 1.1, 8), stone)
      base.position.set(x, 1.5 + 0.55, z)
      base.castShadow = true
      group.add(base)
      const bowl = new Mesh(new CylinderGeometry(0.6, 0.35, 0.4, 10), trim)
      bowl.position.set(x, 1.5 + 1.3, z)
      group.add(bowl)
      const fire = new Mesh(new ConeGeometry(0.45, 1.3, 12, 1, true), flame)
      fire.position.set(x, 1.5 + 2.1, z)
      fire.userData.dynamic = true
      group.add(fire)
    }
  }
}

class MeshToonClothMaterial extends MeshToonMaterial {
  constructor(color: string) {
    super({ color, side: DoubleSide })
  }
}
