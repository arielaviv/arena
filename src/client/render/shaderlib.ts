import type { Material, WebGLProgramParametersWithUniforms } from 'three'

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}
`

export interface MaterialPatch {
  uniforms?: Record<string, { value: unknown }>
  header?: string
  // GLSL run after the base colour is known; may modify diffuseColor.rgb.
  color?: string
  // GLSL run after emissive is known; may add to totalEmissiveRadiance.
  emissive?: string
}

// Inject world-space procedural patterns into a built-in three material while
// keeping its lighting and shadows.
export function patchMaterial<T extends Material>(material: T, patch: MaterialPatch, key: string): T {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    if (patch.uniforms) Object.assign(shader.uniforms, patch.uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    const uniformDecl = Object.keys(patch.uniforms ?? {})
      .map((name) => {
        const v = patch.uniforms?.[name]?.value
        const type =
          typeof v === 'number' ? 'float' : v && typeof v === 'object' && 'isColor' in v ? 'vec3' : 'vec3'
        return `uniform ${type} ${name};`
      })
      .join('\n')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWorldPos;\n${uniformDecl}\n${NOISE_GLSL}\n${patch.header ?? ''}`,
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${patch.color ?? ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${patch.emissive ?? ''}`)
  }
  material.customProgramCacheKey = () => key
  return material
}
