// Headless AI-vs-AI balance runs on the pure sim.
// Usage: pnpm tsx scripts/balance.ts [matchesPerComp=20] [difficulty=0.6]
import { CLASSES, DPS, getAbility, HEALERS } from '../src/shared/combat/registry'
import type { ClassId } from '../src/shared/combat/types'
import { TICK_RATE } from '../src/shared/sim/constants'
import { MatchSim } from '../src/shared/sim/match'

const perComp = Number(process.argv[2] ?? 20)
const difficulty = Number(process.argv[3] ?? 0.6)
const MAX_SECONDS = 240

interface Result {
  wins: number
  games: number
  seconds: number
  timeouts: number
}

const comps: Array<[ClassId, ClassId]> = []
for (const h of HEALERS) for (const d of DPS) comps.push([h, d])

const results = new Map<string, Result>()
const key = (c: [ClassId, ClassId]) => `${c[0]}+${c[1]}`
for (const c of comps) results.set(key(c), { wins: 0, games: 0, seconds: 0, timeouts: 0 })

// Per ability: uses, damage and healing (ticks credited to their aura).
const tally = new Map<string, { uses: number; damage: number; healing: number }>()
const bump = (id: string) => {
  let t = tally.get(id)
  if (!t) {
    t = { uses: 0, damage: 0, healing: 0 }
    tally.set(id, t)
  }
  return t
}

let seed = 1
for (let i = 0; i < comps.length; i++) {
  for (let j = i + 1; j < comps.length; j++) {
    const a = comps[i]!
    const b = comps[j]!
    for (let n = 0; n < perComp; n++) {
      const swap = n % 2 === 1
      const t0 = swap ? b : a
      const t1 = swap ? a : b
      const sim = new MatchSim({
        mode: 'arena',
        seed: seed++,
        countdown: 1,
        difficulty,
        teams: [
          t0.map((id, k) => ({ classId: id, name: `a${k}`, control: 'bot' as const })),
          t1.map((id, k) => ({ classId: id, name: `b${k}`, control: 'bot' as const })),
        ],
      })
      let ticks = 0
      while (sim.phase !== 'ended' && ticks < MAX_SECONDS * TICK_RATE) {
        sim.step()
        for (const e of sim.drainEvents()) {
          if (e.t === 'use') bump(e.ability).uses++
          else if (e.t === 'damage') bump(e.ability).damage += e.amount
          else if (e.t === 'heal') bump(e.ability).healing += e.amount
        }
        ticks++
      }
      const r0 = results.get(key(t0))!
      const r1 = results.get(key(t1))!
      r0.games++
      r1.games++
      const secs = ticks / TICK_RATE
      r0.seconds += secs
      r1.seconds += secs
      if (sim.phase !== 'ended') {
        r0.timeouts++
        r1.timeouts++
      } else if (sim.winner === 0) r0.wins++
      else if (sim.winner === 1) r1.wins++
    }
  }
}

const rows = [...results.entries()].sort((x, y) => y[1].wins / y[1].games - x[1].wins / x[1].games)
console.log(`comp                     win%   avg s  timeouts`)
for (const [k, r] of rows) {
  const pct = ((100 * r.wins) / Math.max(1, r.games)).toFixed(0).padStart(4)
  const avg = (r.seconds / Math.max(1, r.games)).toFixed(0).padStart(6)
  console.log(`${k.padEnd(24)} ${pct}% ${avg}  ${r.timeouts}`)
}

if (process.argv.includes('--abilities')) {
  for (const id of [...HEALERS, ...DPS]) {
    const cls = CLASSES[id]
    console.log(`
${cls.name}`)
    for (const a of Object.values(cls.abilities)) {
      if (!a) continue
      const t = tally.get(a.id) ?? { uses: 0, damage: 0, healing: 0 }
      const auraIds = a.effects.flatMap((e) => (e.kind === 'aura' ? [e.aura] : []))
      let dot = 0
      let hot = 0
      for (const aid of auraIds) {
        if (aid === a.id || getAbility(aid)) continue
        dot += tally.get(aid)?.damage ?? 0
        hot += tally.get(aid)?.healing ?? 0
      }
      console.log(
        `  ${a.slot.padEnd(4)} ${a.name.padEnd(16)} uses ${String(t.uses).padStart(6)}  dmg ${String(t.damage + dot).padStart(8)}  heal ${String(t.healing + hot).padStart(8)}`,
      )
    }
  }
}
