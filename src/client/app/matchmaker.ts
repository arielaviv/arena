import { CLASSES, DPS, HEALERS } from '../../shared/combat/registry'
import type { ClassId } from '../../shared/combat/types'
import type { MatchConfig } from '../../shared/sim/match'

const NAMES = [
  'Kestrel',
  'Vex',
  'Morrow',
  'Ashby',
  'Quill',
  'Juno',
  'Sable',
  'Rook',
  'Wren',
  'Nyx',
  'Orrin',
  'Tamsin',
  'Bram',
  'Lyra',
  'Cato',
  'Ember',
  'Halcyon',
  'Isolde',
  'Pike',
  'Zephyr',
]

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T
}

// Healer + DPS on both sides. You fill your slot; AI fills the rest.
export function buildArenaMatch(myClass: ClassId, difficulty: number): MatchConfig {
  const myRole = CLASSES[myClass].role
  const partner = myRole === 'healer' ? pick(DPS) : pick(HEALERS)
  const names = [...NAMES].sort(() => Math.random() - 0.5)
  return {
    mode: 'arena',
    seed: Math.floor(Math.random() * 1e9),
    countdown: 3,
    difficulty,
    teams: [
      [
        { classId: myClass, name: 'You', control: 'human' },
        { classId: partner, name: names[0] ?? 'Ally', control: 'bot' },
      ],
      [
        { classId: pick(HEALERS), name: names[1] ?? 'Foe', control: 'bot' },
        { classId: pick(DPS), name: names[2] ?? 'Foe', control: 'bot' },
      ],
    ],
  }
}

export function buildTrainingMatch(myClass: ClassId): MatchConfig {
  return {
    mode: 'training',
    seed: Math.floor(Math.random() * 1e9),
    teams: [[{ classId: myClass, name: 'You', control: 'human' }], []],
  }
}
