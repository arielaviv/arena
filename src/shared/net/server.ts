import type { SimEvent } from '../combat/events'
import { DT, SNAPSHOT_EVERY } from '../sim/constants'
import { type MatchConfig, MatchSim } from '../sim/match'
import { decodeClient, encodeServer } from './codec'
import { buildSnapshot } from './snapshot'

export interface ServerClient {
  fighterId: number
  send(data: string): void
}

// Authoritative match host. Runs the sim at a fixed tick and broadcasts
// snapshots. The same class runs in the page (single-player) and, in Phase 2,
// in Node behind WebSockets.
export class GameServer {
  readonly sim: MatchSim
  private readonly clients: ServerClient[] = []
  private acc = 0
  private pending: SimEvent[] = []

  constructor(
    cfg: MatchConfig,
    readonly seed: number,
  ) {
    this.sim = new MatchSim(cfg)
  }

  join(client: ServerClient): void {
    this.clients.push(client)
    client.send(
      encodeServer({ type: 'welcome', you: client.fighterId, mode: this.sim.mode, seed: this.seed }),
    )
    client.send(encodeServer({ type: 'snap', snap: buildSnapshot(this.sim, []) }))
  }

  receive(client: ServerClient, data: string): void {
    const msg = decodeClient(data)
    if (!msg) return
    if (msg.type === 'input') {
      this.sim.setInput(client.fighterId, msg.cmd)
      return
    }
    if (!this.sim.training) return
    const cmd = msg.cmd
    switch (cmd.kind) {
      case 'swapClass':
        this.sim.swapClass(client.fighterId, cmd.classId)
        break
      case 'resetCooldowns':
        this.sim.resetCooldowns(client.fighterId)
        break
      case 'aggressor':
        this.sim.aggressorOn = cmd.on
        break
      case 'infinite':
        this.sim.infiniteResource = cmd.on
        break
    }
  }

  // Advance by real time; steps the sim in fixed ticks.
  update(dt: number, timeScale = 1): void {
    this.acc += Math.min(dt, 0.25) * timeScale
    while (this.acc >= DT) {
      this.acc -= DT
      this.tickOnce()
    }
  }

  tickOnce(): void {
    this.sim.step()
    const events = this.sim.drainEvents()
    if (events.length > 0) this.pending.push(...events)
    if (this.sim.tick % SNAPSHOT_EVERY === 0) {
      const data = encodeServer({ type: 'snap', snap: buildSnapshot(this.sim, this.pending) })
      this.pending = []
      for (const c of this.clients) c.send(data)
    }
  }
}
