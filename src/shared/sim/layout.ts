import {
  Block,
  makeFlat,
  makePrism,
  makeRamp,
  type Prism,
  type Spawn,
  type Surface,
  type WorldGeometry,
} from './geometry'

// Nagrand Arena pillar structure: a circular ring, four big pillars evenly spaced
// around an open centre, start rooms facing each other on the X axis.
export const ARENA = {
  radius: 30,
  wallHeight: 1.2,
  wallThickness: 0.6,
  barrierHeight: 12,
  wallSegments: 56,
  pillarHalf: 2.5,
  pillarHeight: 9,
  pillarRing: 11,
  corridorHalf: 3,
  corridorWallHeight: 5,
  rampStart: 30.2,
  rampLength: 6,
  roomDepth: 8,
  roomHalfWidth: 6,
  roomY: 1.5,
  roomWallHeight: 5,
  coverHalfLength: 2,
  coverHalfThickness: 0.5,
  coverHeight: 1,
  coverZ: 19,
} as const

export const PILLAR_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4] as const

export function buildArena(): WorldGeometry {
  const prisms: Prism[] = []
  const surfaces: Surface[] = []
  const add = (p: Prism) => {
    prisms.push(p)
  }
  let id = 0
  const A = ARENA

  // Floor
  surfaces.push({ kind: 'disc', cx: 0, cz: 0, r: A.radius + 0.4, y: 0 })

  // Pillars
  for (const angle of PILLAR_ANGLES) {
    add(
      makePrism(
        id++,
        'pillar',
        Math.cos(angle) * A.pillarRing,
        Math.sin(angle) * A.pillarRing,
        A.pillarHalf,
        A.pillarHalf,
        angle,
        0,
        A.pillarHeight,
        Block.Solid,
      ),
    )
  }

  // Low cover on +-Z: slide-height, jumpable
  for (const side of [-1, 1]) {
    add(
      makePrism(
        id++,
        'cover',
        0,
        side * A.coverZ,
        A.coverHalfLength,
        A.coverHalfThickness,
        0,
        0,
        A.coverHeight,
        Block.Solid,
      ),
    )
  }

  // Ring balustrade + invisible barrier, with openings at the two gates
  const segAngle = (Math.PI * 2) / A.wallSegments
  const segHalf = Math.tan(segAngle / 2) * (A.radius + A.wallThickness / 2) * 1.04
  for (let i = 0; i < A.wallSegments; i++) {
    const angle = (i + 0.5) * segAngle
    const cx = Math.cos(angle) * (A.radius + A.wallThickness / 2)
    const cz = Math.sin(angle) * (A.radius + A.wallThickness / 2)
    if (Math.abs(cz) < A.corridorHalf + 0.5) continue
    // Local x is radial for prisms, so the long side runs along local z.
    add(makePrism(id++, 'wall', cx, cz, A.wallThickness / 2, segHalf, angle, 0, A.wallHeight, Block.Solid))
    add(
      makePrism(
        id++,
        'barrier',
        cx,
        cz,
        A.wallThickness / 2,
        segHalf,
        angle,
        A.wallHeight,
        A.barrierHeight,
        Block.Move,
      ),
    )
  }

  // Start rooms, ramps, corridors, gates (team 0 west / -X, team 1 east / +X)
  const spawns: [Spawn[], Spawn[]] = [[], []]
  for (const team of [0, 1] as const) {
    const s = team === 0 ? -1 : 1
    const rampMid = A.rampStart + A.rampLength / 2
    const roomStart = A.rampStart + A.rampLength
    const roomMid = roomStart + A.roomDepth / 2
    const roomEnd = roomStart + A.roomDepth
    const corridorStart = Math.sqrt(A.radius * A.radius - A.corridorHalf * A.corridorHalf) - 1.2
    const corridorMid = (corridorStart + roomStart) / 2
    const corridorHalfLen = (roomStart - corridorStart) / 2
    const ramp = makeRamp(
      s * rampMid,
      0,
      A.rampLength / 2,
      A.corridorHalf,
      team === 0 ? Math.PI : 0,
      0,
      A.roomY,
    )
    surfaces.push(ramp)
    surfaces.push(makeFlat(s * roomMid, 0, A.roomDepth / 2 + 0.3, A.roomHalfWidth, 0, A.roomY))

    // Corridor walls
    for (const side of [-1, 1]) {
      add(
        makePrism(
          id++,
          'room',
          s * corridorMid,
          side * (A.corridorHalf + 0.3),
          corridorHalfLen,
          0.3,
          0,
          0,
          A.corridorWallHeight,
          Block.Solid,
        ),
      )
    }
    // Room side walls, back wall, and the front wall either side of the opening
    for (const side of [-1, 1]) {
      add(
        makePrism(
          id++,
          'room',
          s * (roomMid + 0.3),
          side * (A.roomHalfWidth + 0.3),
          A.roomDepth / 2 + 0.3,
          0.3,
          0,
          0,
          A.roomY + A.roomWallHeight,
          Block.Solid,
        ),
      )
      const frontHalf = (A.roomHalfWidth - A.corridorHalf) / 2
      add(
        makePrism(
          id++,
          'room',
          s * (roomStart - 0.3),
          side * (A.corridorHalf + frontHalf),
          0.3,
          frontHalf,
          0,
          0,
          A.roomY + A.roomWallHeight,
          Block.Solid,
        ),
      )
    }
    add(
      makePrism(
        id++,
        'room',
        s * (roomEnd + 0.3),
        0,
        0.3,
        A.roomHalfWidth + 0.6,
        0,
        0,
        A.roomY + A.roomWallHeight,
        Block.Solid,
      ),
    )
    // Lid over the room so nobody climbs out (movement only)
    add(
      makePrism(
        id++,
        'barrier',
        s * (roomMid - 3),
        0,
        A.roomDepth / 2 + 3,
        A.roomHalfWidth + 0.6,
        0,
        A.roomY + A.roomWallHeight,
        A.barrierHeight,
        Block.Move,
      ),
    )
    // Gate at the top of the ramp
    add(
      makePrism(
        id++,
        'gate',
        s * (roomStart + 0.2),
        0,
        0.2,
        A.corridorHalf,
        0,
        A.roomY - 0.5,
        A.roomY + 4,
        Block.Solid,
        team,
      ),
    )

    const facing = team === 0 ? 0 : Math.PI
    spawns[team].push({ x: s * (roomMid + 1), y: A.roomY, z: -2.2, yaw: facing })
    spawns[team].push({ x: s * (roomMid + 1), y: A.roomY, z: 2.2, yaw: facing })
  }

  return {
    id: 'arena',
    prisms,
    surfaces,
    spawns,
    dummies: [],
    bounds: A.radius + A.rampLength + A.roomDepth + 2,
  }
}
