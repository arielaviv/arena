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
  // Online rooms hold the clock until every player's client has loaded.
  private gate: { waiting: Set<number>; timeout: number } | null = null

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

  // A player dropped: stop sending to them and let the AI take over their fighter.
  leave(client: ServerClient): void {
    const i = this.clients.indexOf(client)
    if (i >= 0) this.clients.splice(i, 1)
    this.sim.takeOver(client.fighterId)
  }

  get playerCount(): number {
    return this.clients.length
  }

  holdUntilReady(fighterIds: readonly number[], timeout: number): void {
    this.gate = { waiting: new Set(fighterIds), timeout }
  }

  get holding(): boolean {
    return this.gate !== null
  }

  receive(client: ServerClient, data: string): void {
    const msg = decodeClient(data)
    if (!msg) return
    if (msg.type === 'ready') {
      this.gate?.waiting.delete(client.fighterId)
      return
    }
    if (msg.type === 'input') {
      this.sim.setInput(client.fighterId, msg.cmd)
      return
    }
    if (msg.type === 'inputs') {
      for (const cmd of msg.cmds) this.sim.setInput(client.fighterId, cmd)
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
    if (this.gate) {
      this.gate.timeout -= dt
      if (this.gate.waiting.size > 0 && this.gate.timeout > 0) return
      this.gate = null
    }
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
