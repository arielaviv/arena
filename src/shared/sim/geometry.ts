// Static world description shared by collision (sim) and mesh building (client).
// Everything solid is a vertical prism: an oriented rectangle extruded from y0 to y1.

export const Block = {
  Move: 1,
  Los: 2,
  Shot: 4,
  Solid: 1 | 2 | 4,
} as const

export type PrismTag = 'pillar' | 'cover' | 'wall' | 'barrier' | 'gate' | 'room'

export interface Prism {
  id: number
  tag: PrismTag
  cx: number
  cz: number
  hx: number
  hz: number
  yaw: number
  cos: number
  sin: number
  y0: number
  y1: number
  mask: number
  enabled: boolean
  team?: 0 | 1
}

interface SurfaceBase {
  cx: number
  cz: number
  hx: number
  hz: number
  yaw: number
  cos: number
  sin: number
}

export interface FlatSurface extends SurfaceBase {
  kind: 'flat'
  y: number
}

// Rises along local +x: yLow at -hx, yHigh at +hx.
export interface RampSurface extends SurfaceBase {
  kind: 'ramp'
  yLow: number
  yHigh: number
}

export interface DiscSurface {
  kind: 'disc'
  cx: number
  cz: number
  r: number
  y: number
}

export type Surface = FlatSurface | RampSurface | DiscSurface

export interface Spawn {
  x: number
  y: number
  z: number
  yaw: number
}

export interface DummySpot {
  role: 'standard' | 'caster' | 'mover' | 'aggressor' | 'ally'
  x: number
  z: number
  yaw: number
  railHalf?: number
}

export interface WorldGeometry {
  id: 'arena' | 'training'
  prisms: Prism[]
  surfaces: Surface[]
  spawns: [Spawn[], Spawn[]]
  dummies: DummySpot[]
  bounds: number // radius that contains everything playable
}

export function makePrism(
  id: number,
  tag: PrismTag,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  yaw: number,
  y0: number,
  y1: number,
  mask: number,
  team?: 0 | 1,
): Prism {
  const prism: Prism = {
    id,
    tag,
    cx,
    cz,
    hx,
    hz,
    yaw,
    cos: Math.cos(yaw),
    sin: Math.sin(yaw),
    y0,
    y1,
    mask,
    enabled: true,
  }
  if (team !== undefined) prism.team = team
  return prism
}

export function makeFlat(
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  yaw: number,
  y: number,
): FlatSurface {
  return { kind: 'flat', cx, cz, hx, hz, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw), y }
}

export function makeRamp(
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  yaw: number,
  yLow: number,
  yHigh: number,
): RampSurface {
  return { kind: 'ramp', cx, cz, hx, hz, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw), yLow, yHigh }
}

// World (x, z) into the local frame of an oriented rectangle.
export function toLocalX(s: SurfaceBase | Prism, x: number, z: number): number {
  return (x - s.cx) * s.cos + (z - s.cz) * s.sin
}

export function toLocalZ(s: SurfaceBase | Prism, x: number, z: number): number {
  return -(x - s.cx) * s.sin + (z - s.cz) * s.cos
}
