import { decodeServer, encodeClient } from '../../shared/net/codec'
import type { ClientMessage, ServerMessage } from '../../shared/net/protocol'
import { GameServer, type ServerClient } from '../../shared/net/server'
import type { MatchConfig } from '../../shared/sim/match'

export interface Transport {
  send(msg: ClientMessage): void
  onMessage(cb: (msg: ServerMessage) => void): void
  update(dt: number): void
  close(): void
}

export interface LagSettings {
  lagMs: number // round trip
  jitterMs: number
}

interface Packet {
  at: number
  data: string
}

// Single-player transport: runs the authoritative server in the page and
// still serialises every message, optionally with fake latency.
export class LocalTransport implements Transport {
  readonly server: GameServer
  private readonly client: ServerClient
  private listener: ((msg: ServerMessage) => void) | null = null
  private toServer: Packet[] = []
  private toClient: Packet[] = []
  private clock = 0
  timeScale = 1

  constructor(
    cfg: MatchConfig,
    fighterId: number,
    private readonly lag: LagSettings,
  ) {
    this.server = new GameServer(cfg, cfg.seed)
    this.client = {
      fighterId,
      send: (data) => this.toClient.push({ at: this.clock + this.delay(), data }),
    }
    this.server.join(this.client)
  }

  private delay(): number {
    if (this.lag.lagMs <= 0 && this.lag.jitterMs <= 0) return 0
    return (this.lag.lagMs / 2 + Math.random() * this.lag.jitterMs) / 1000
  }

  send(msg: ClientMessage): void {
    this.toServer.push({ at: this.clock + this.delay(), data: encodeClient(msg) })
  }

  onMessage(cb: (msg: ServerMessage) => void): void {
    this.listener = cb
  }

  update(dt: number): void {
    this.clock += dt
    this.flush(this.toServer, (data) => this.server.receive(this.client, data))
    this.server.update(dt, this.timeScale)
    this.flush(this.toClient, (data) => this.listener?.(decodeServer(data)))
  }

  private flush(queue: Packet[], deliver: (data: string) => void): void {
    let n = 0
    // Keep order even with jitter: deliver the prefix that is due.
    while (n < queue.length && (queue[n]?.at ?? Number.POSITIVE_INFINITY) <= this.clock) n++
    if (n === 0) return
    const due = queue.splice(0, n)
    for (const p of due) deliver(p.data)
  }

  close(): void {
    this.listener = null
  }
}
