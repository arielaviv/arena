import { Block, makePrism, type Prism, type WorldGeometry } from './geometry'
import { ARENA } from './layout'

// Training Grounds: a walled courtyard with one Nagrand-size pillar, one low
// cover piece, and a row of dummies.
export const TRAINING = {
  halfX: 26,
  halfZ: 18,
  wallHeight: 4,
} as const

export function buildTraining(): WorldGeometry {
  const prisms: Prism[] = []
  let id = 0
  const T = TRAINING

  prisms.push(
    makePrism(
      id++,
      'pillar',
      2,
      -9,
      ARENA.pillarHalf,
      ARENA.pillarHalf,
      0,
      0,
      ARENA.pillarHeight,
      Block.Solid,
    ),
  )
  prisms.push(
    makePrism(
      id++,
      'cover',
      2,
      7,
      ARENA.coverHalfLength,
      ARENA.coverHalfThickness,
      0,
      0,
      ARENA.coverHeight,
      Block.Solid,
    ),
  )

  const walls: Array<[number, number, number, number]> = [
    [0, -T.halfZ - 0.5, T.halfX + 1, 0.5],
    [0, T.halfZ + 0.5, T.halfX + 1, 0.5],
    [-T.halfX - 0.5, 0, 0.5, T.halfZ + 1],
    [T.halfX + 0.5, 0, 0.5, T.halfZ + 1],
  ]
  for (const [cx, cz, hx, hz] of walls) {
    prisms.push(makePrism(id++, 'wall', cx, cz, hx, hz, 0, 0, T.wallHeight, Block.Solid))
    prisms.push(makePrism(id++, 'barrier', cx, cz, hx, hz, 0, T.wallHeight, ARENA.barrierHeight, Block.Move))
  }

  return {
    id: 'training',
    prisms,
    surfaces: [{ kind: 'disc', cx: 0, cz: 0, r: 40, y: 0 }],
    spawns: [
      [
        { x: -14, y: 0, z: 0, yaw: 0 },
        { x: -14, y: 0, z: 4, yaw: 0 },
      ],
      [
        { x: 14, y: 0, z: 0, yaw: Math.PI },
        { x: 14, y: 0, z: 4, yaw: Math.PI },
      ],
    ],
    dummies: [
      { role: 'standard', x: 10, z: -4, yaw: Math.PI },
      { role: 'caster', x: 10, z: 2, yaw: Math.PI },
      { role: 'mover', x: 17, z: -1, yaw: Math.PI, railHalf: 6 },
      { role: 'aggressor', x: 12, z: 11, yaw: Math.PI },
      { role: 'ally', x: -9, z: 8, yaw: 0 },
    ],
    bounds: 34,
  }
}
