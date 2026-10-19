import {
  AdditiveBlending,
  Color,
  type ColorRepresentation,
  DoubleSide,
  NormalBlending,
  ShaderMaterial,
} from 'three'
import { NOISE_GLSL } from '../shaderlib'

// Shared clock for every effect shader.
export const fxTime = { value: 0 }

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vDist;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`

function base(
  fragment: string,
  uniforms: Record<string, { value: unknown }>,
  additive = true,
): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: additive ? AdditiveBlending : NormalBlending,
    uniforms: { uTime: fxTime, uLife: { value: 1 }, ...uniforms },
    vertexShader: VERT,
    fragmentShader: `${NOISE_GLSL}\n${fragment}`,
  })
}

// Licking flames on any mesh whose uv.y runs bottom (0) to top (1).
export function flameMaterial(
  hot: ColorRepresentation,
  cool: ColorRepresentation,
  speed = 2.2,
): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uTime; uniform float uLife; uniform vec3 uHot; uniform vec3 uCool; uniform float uSpeed;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      float n = fbm(vec2(uv.x * 6.0, uv.y * 3.0 - uTime * uSpeed));
      float n2 = fbm(vec2(uv.x * 11.0 + 3.0, uv.y * 5.0 - uTime * uSpeed * 1.6));
      float shape = smoothstep(1.0, 0.1, uv.y + (n - 0.5) * 0.8);
      float a = shape * smoothstep(0.38, 0.66, n * 0.7 + n2 * 0.5 + (1.0 - uv.y) * 0.22);
      float heat = smoothstep(0.4, 0.95, n2 + (1.0 - uv.y) * 0.45);
      vec3 col = mix(uCool, uHot, heat) * (1.0 + heat * 0.6);
      gl_FragColor = vec4(col, a * uLife);
    }`,
    { uHot: { value: new Color(hot) }, uCool: { value: new Color(cool) }, uSpeed: { value: speed } },
    false,
  )
}

// Expanding ring with soft inner gradient; drive uLife (fade) and scale from code.
export function shockwaveMaterial(color: ColorRepresentation, thickness = 0.18): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uLife; uniform vec3 uColor; uniform float uThick;
    varying vec2 vUv;
    void main() {
      float r = length(vUv - 0.5) * 2.0;
      float ring = smoothstep(1.0 - uThick, 1.0 - uThick * 0.35, r) * smoothstep(1.0, 0.94, r);
      float inner = smoothstep(1.0 - uThick * 3.0, 1.0, r) * 0.25 * step(r, 1.0);
      gl_FragColor = vec4(uColor * 1.25, (ring + inner) * uLife);
    }`,
    { uColor: { value: new Color(color) }, uThick: { value: thickness } },
  )
}

// Fresnel bubble with drifting hex cells (shields, water rings).
export function shieldMaterial(color: ColorRepresentation, hex = true): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uTime; uniform float uLife; uniform vec3 uColor; uniform float uHex;
    varying vec2 vUv; varying vec3 vNormalV; varying vec3 vViewDir;
    void main() {
      float fres = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), 2.2);
      vec2 g = vUv * vec2(24.0, 12.0);
      vec2 cell = abs(fract(g + vec2(0.0, uTime * 0.3)) - 0.5);
      float lines = smoothstep(0.42, 0.5, max(cell.x, cell.y)) * uHex;
      float wave = 0.5 + 0.5 * sin(vUv.y * 30.0 - uTime * 5.0);
      float a = (fres * 0.9 + lines * 0.35 * (0.5 + wave * 0.5) + 0.04) * uLife;
      gl_FragColor = vec4(uColor * (1.2 + fres), a);
    }`,
    { uColor: { value: new Color(color) }, uHex: { value: hex ? 1 : 0 } },
  )
}

// Beam along a cylinder (uv.y = along length): bright core, scrolling energy.
export function beamMaterial(
  core: ColorRepresentation,
  glow: ColorRepresentation,
  speed = 6,
): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uTime; uniform float uLife; uniform vec3 uCore; uniform vec3 uGlow; uniform float uSpeed;
    varying vec2 vUv; varying vec3 vNormalV; varying vec3 vViewDir; varying float vDist;
    void main() {
      float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
      float n = fbm(vec2(vUv.x * 4.0, vUv.y * 10.0 - uTime * uSpeed));
      float coreMask = smoothstep(0.55, 1.0, facing);
      float bands = 0.6 + 0.4 * sin(vUv.y * 60.0 - uTime * uSpeed * 6.0);
      vec3 col = mix(uGlow, uCore, coreMask) * (1.0 + n * 0.8) * bands;
      float a = (0.35 + coreMask * 0.65) * (0.6 + n * 0.6) * uLife * smoothstep(0.8, 3.0, vDist);
      gl_FragColor = vec4(col, a);
    }`,
    { uCore: { value: new Color(core) }, uGlow: { value: new Color(glow) }, uSpeed: { value: speed } },
  )
}

// Crescent slash on a partial RingGeometry (uv.x around, uv.y across).
export function slashMaterial(color: ColorRepresentation): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uLife; uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      float across = smoothstep(0.0, 0.5, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
      float sweep = smoothstep(1.0 - uLife * 1.4, 1.0 - uLife * 1.4 + 0.35, vUv.x);
      float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
      gl_FragColor = vec4(uColor * 1.5, across * edge * sweep * uLife);
    }`,
    { uColor: { value: new Color(color) } },
  )
}

// Rotating rune circle under casters (on a CircleGeometry).
export function runeMaterial(color: ColorRepresentation): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uTime; uniform float uLife; uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      vec2 p = vUv - 0.5;
      float r = length(p) * 2.0;
      float a = atan(p.y, p.x);
      float ring1 = smoothstep(0.03, 0.0, abs(r - 0.92));
      float ring2 = smoothstep(0.02, 0.0, abs(r - 0.7));
      float ticks = step(0.86, fract((a / 6.28318) * 24.0 + uTime * 0.4)) * step(0.72, r) * step(r, 0.9);
      float star = smoothstep(0.03, 0.0, abs(r - (0.45 + 0.12 * cos(a * 5.0 - uTime * 1.5)))) ;
      float glyph = step(0.5, fract((a / 6.28318) * 8.0 - uTime * 0.25)) * smoothstep(0.02, 0.0, abs(r - 0.81));
      float alpha = (ring1 + ring2 + ticks * 0.8 + star * 0.9 + glyph) * smoothstep(1.0, 0.95, r);
      gl_FragColor = vec4(uColor * 1.4, alpha * uLife);
    }`,
    { uColor: { value: new Color(color) } },
  )
}

// Ground scorch / splash decal that fades out (normal blending, darkens).
export function decalMaterial(color: ColorRepresentation, darken: boolean): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uLife; uniform vec3 uColor; uniform float uDark;
    varying vec2 vUv;
    void main() {
      vec2 p = vUv - 0.5;
      float r = length(p) * 2.0;
      float n = fbm(p * 6.0 + 3.0);
      float shape = smoothstep(1.0, 0.55, r + (n - 0.5) * 0.5);
      float glow = smoothstep(0.6, 0.0, r) * (1.0 - uDark);
      vec3 col = mix(uColor, vec3(0.05, 0.03, 0.02), uDark);
      gl_FragColor = vec4(col + uColor * glow, shape * uLife * (uDark > 0.5 ? 0.6 : 0.8));
    }`,
    { uColor: { value: new Color(color) }, uDark: { value: darken ? 1 : 0 } },
    !darken,
  )
}

// Soft glowing core for orbs (sphere): bright centre, fresnel rim.
export function orbMaterial(core: ColorRepresentation, rim: ColorRepresentation): ShaderMaterial {
  return base(
    /* glsl */ `
    uniform float uTime; uniform float uLife; uniform vec3 uCore; uniform vec3 uRim;
    varying vec2 vUv; varying vec3 vNormalV; varying vec3 vViewDir; varying float vDist;
    void main() {
      float f = abs(dot(normalize(vNormalV), normalize(vViewDir)));
      float n = fbm(vUv * 8.0 + uTime * 2.0);
      float near = smoothstep(2.0, 5.0, vDist);
      vec3 col = mix(uRim, uCore, smoothstep(0.2, 0.95, f)) * (1.1 + n * 0.6);
      float a = (0.25 + f * 0.75) * uLife * near;
      gl_FragColor = vec4(col, a);
    }`,
    { uCore: { value: new Color(core) }, uRim: { value: new Color(rim) } },
  )
}
