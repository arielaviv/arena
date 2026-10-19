import { CLASSES, DPS, HEALERS } from '../combat/registry'
import type { ClassId, Role } from '../combat/types'
import type { MatchConfig, SlotConfig } from '../sim/match'
import type { Rng } from '../sim/rng'

// Online queue → 2v2 healer + DPS rooms. Humans fill their role's slot,
// spread across teams; AI fills whatever is still empty once the oldest
// player has waited long enough.

export const BACKFILL_SECONDS = 2.5

export interface QueuedPlayer {
  id: string
  classId: ClassId
  name: string
  difficulty: number
  joinedAt: number // seconds
}

export interface PlannedSlot {
  team: 0 | 1
  index: number // 0 = healer slot, 1 = dps slot
  classId: ClassId
  name: string
  playerId: string | null // null = bot
}

export interface PlannedMatch {
  slots: PlannedSlot[]
  players: string[]
  difficulty: number
}

const BOT_NAMES = [
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
  'Halcyon',
  'Isolde',
  'Pike',
  'Zephyr',
]

function slotIndex(role: Role): number {
  return role === 'healer' ? 0 : 1
}

// Returns a match to start now, or null to keep waiting.
export function planMatch(queue: readonly QueuedPlayer[], now: number, rng: Rng): PlannedMatch | null {
  if (queue.length === 0) return null
  const taken: Array<Array<QueuedPlayer | null>> = [
    [null, null],
    [null, null],
  ]
  const humansOnTeam = [0, 0]
  const used: QueuedPlayer[] = []
  for (const p of queue) {
    const idx = slotIndex(CLASSES[p.classId].role)
    // Prefer the team with fewer humans that still has this role open.
    const order: Array<0 | 1> = humansOnTeam[0]! <= humansOnTeam[1]! ? [0, 1] : [1, 0]
    for (const team of order) {
      const row = taken[team]
      if (row && row[idx] === null) {
        row[idx] = p
        humansOnTeam[team] = (humansOnTeam[team] ?? 0) + 1
        used.push(p)
        break
      }
    }
    if (used.length === 4) break
  }
  const full = used.length === 4
  const oldest = Math.min(...queue.map((p) => p.joinedAt))
  if (!full && now - oldest < BACKFILL_SECONDS) return null
  if (used.length === 0) return null

  const names = [...BOT_NAMES]
  const slots: PlannedSlot[] = []
  for (const team of [0, 1] as const) {
    for (const index of [0, 1]) {
      const human = taken[team]?.[index] ?? null
      if (human) {
        slots.push({ team, index, classId: human.classId, name: human.name, playerId: human.id })
      } else {
        const pool = index === 0 ? HEALERS : DPS
        const classId = rng.pick(pool)
        const at = rng.int(names.length)
        const name = names.splice(at, 1)[0] ?? 'Bot'
        slots.push({ team, index, classId, name, playerId: null })
      }
    }
  }
  const difficulty = Math.min(...used.map((p) => p.difficulty))
  return { slots, players: used.map((p) => p.id), difficulty }
}

// MatchSim assigns fighter ids in team order (team 0 first), slot by slot.
export function toMatchConfig(
  plan: PlannedMatch,
  seed: number,
  countdown: number,
): {
  config: MatchConfig
  fighterOf: Map<string, number>
} {
  const teams: [SlotConfig[], SlotConfig[]] = [[], []]
  const fighterOf = new Map<string, number>()
  let id = 1
  for (const team of [0, 1] as const) {
    const row = plan.slots.filter((s) => s.team === team).sort((a, b) => a.index - b.index)
    for (const s of row) {
      teams[team].push({ classId: s.classId, name: s.name, control: s.playerId ? 'human' : 'bot' })
      if (s.playerId) fighterOf.set(s.playerId, id)
      id++
    }
  }
  return { config: { mode: 'arena', seed, countdown, difficulty: plan.difficulty, teams }, fighterOf }
}
