import { DurableObject } from 'cloudflare:workers'
import { PLAYABLE } from '../shared/combat/registry'
import type { ClassId } from '../shared/combat/types'
import { planMatch, type QueuedPlayer, toMatchConfig } from '../shared/net/matchmaking'
import type { QueueMessage } from '../shared/net/protocol'
import { GameServer, type ServerClient } from '../shared/net/server'
import type { MatchConfig } from '../shared/sim/match'
import { Rng } from '../shared/sim/rng'

// ARENA online server: a global matchmaker and one Durable Object per match
// room, each running the same authoritative GameServer as single-player.

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
  MATCHMAKER: DurableObjectNamespace<Matchmaker>
}

interface RoomInit {
  config: MatchConfig
  tokens: Array<[string, number]>
}

// Starts once every player has loaded (ready handshake).
const COUNTDOWN = 3.4
const ROOM_ID = /^\/room\/([a-f0-9-]{36})$/

function upgradeRequired(): Response {
  return new Response('expected websocket', { status: 426 })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/queue') {
      return env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global')).fetch(req)
    }
    const m = ROOM_ID.exec(url.pathname)
    if (m?.[1]) return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req)
    if (url.pathname === '/') return new Response('arena server ok')
    return new Response('not found', { status: 404 })
  },
}

export class Matchmaker extends DurableObject<Env> {
  private queue = new Map<string, { player: QueuedPlayer; ws: WebSocket }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly rng = new Rng(Date.now() >>> 0)
  private theme: 'sky' | 'caldera' = 'sky'
  private forming = false

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return upgradeRequired()
    const url = new URL(req.url)
    const cls = url.searchParams.get('class') ?? ''
    if (!PLAYABLE.includes(cls as ClassId)) return new Response('bad class', { status: 400 })
    const name =
      (url.searchParams.get('name') ?? 'Player').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 16) || 'Player'
    const difficulty = Math.max(0, Math.min(1, Number(url.searchParams.get('difficulty') ?? 0.4) || 0.4))

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    server.accept()
    const id = crypto.randomUUID()
    this.queue.set(id, {
      player: { id, classId: cls as ClassId, name, difficulty, joinedAt: Date.now() / 1000 },
      ws: server,
    })
    server.addEventListener('close', () => this.queue.delete(id))
    server.addEventListener('error', () => this.queue.delete(id))
    this.send(server, { type: 'queued', players: this.queue.size })
    if (!this.timer) this.timer = setInterval(() => void this.tryForm(), 200)
    return new Response(null, { status: 101, webSocket: client })
  }

  private send(ws: WebSocket, msg: QueueMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // socket already gone
    }
  }

  private async tryForm(): Promise<void> {
    if (this.queue.size === 0) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    if (this.forming) return
    const players = [...this.queue.values()].map((e) => e.player).sort((a, b) => a.joinedAt - b.joinedAt)
    const plan = planMatch(players, Date.now() / 1000, this.rng)
    if (!plan) return
    this.forming = true
    try {
      const roomId = crypto.randomUUID()
      const { config, fighterOf } = toMatchConfig(plan, this.rng.int(2 ** 31), COUNTDOWN)
      const tokens: Array<[string, number]> = []
      const tokenOf = new Map<string, string>()
      for (const [playerId, fighter] of fighterOf) {
        const token = crypto.randomUUID()
        tokens.push([token, fighter])
        tokenOf.set(playerId, token)
      }
      const init: RoomInit = { config, tokens }
      const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId))
      await room.fetch(`https://room/room/${roomId}/init`, { method: 'POST', body: JSON.stringify(init) })
      const theme = this.theme
      this.theme = this.theme === 'sky' ? 'caldera' : 'sky'
      for (const playerId of plan.players) {
        const entry = this.queue.get(playerId)
        const token = tokenOf.get(playerId)
        const you = fighterOf.get(playerId)
        if (!entry || !token || you === undefined) continue
        this.send(entry.ws, { type: 'match', room: roomId, token, you, theme })
        this.queue.delete(playerId)
        try {
          entry.ws.close(1000, 'matched')
        } catch {
          // already closed
        }
      }
    } finally {
      this.forming = false
    }
  }
}

export class Room extends DurableObject<Env> {
  private game: GameServer | null = null
  private tokens = new Map<string, number>()
  private sockets = new Set<WebSocket>()
  private timer: ReturnType<typeof setInterval> | null = null
  private last = 0
  private endedFor = 0
  private emptyFor = 0
  private everJoined = false

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/init') && req.method === 'POST') {
      if (this.game) return new Response('room already running', { status: 409 })
      const init = (await req.json()) as RoomInit
      this.game = new GameServer(init.config, init.config.seed)
      for (const [token, fighter] of init.tokens) this.tokens.set(token, fighter)
      this.game.holdUntilReady(
        init.tokens.map(([, fighter]) => fighter),
        6,
      )
      this.last = Date.now()
      this.timer = setInterval(() => this.tick(), 1000 / 60)
      return new Response('ok')
    }
    if (req.headers.get('Upgrade') !== 'websocket') return upgradeRequired()
    const token = url.searchParams.get('token') ?? ''
    const fighterId = this.tokens.get(token)
    if (!this.game || fighterId === undefined) return new Response('unknown room or token', { status: 403 })
    // One socket per seat: a rejoin replaces the old one.
    this.tokens.delete(token)

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    server.accept()
    const seat: ServerClient = {
      fighterId,
      send: (data) => {
        try {
          server.send(data)
        } catch {
          // closed
        }
      },
    }
    this.game.join(seat)
    this.sockets.add(server)
    this.everJoined = true
    server.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string' && ev.data.length < 8192) this.game?.receive(seat, ev.data)
    })
    const drop = () => {
      if (!this.sockets.delete(server)) return
      this.game?.leave(seat)
    }
    server.addEventListener('close', drop)
    server.addEventListener('error', drop)
    return new Response(null, { status: 101, webSocket: client })
  }

  private tick(): void {
    const game = this.game
    if (!game) return
    const now = Date.now()
    const dt = Math.min(0.25, (now - this.last) / 1000)
    this.last = now
    game.update(dt)
    if (game.sim.phase === 'ended') this.endedFor += dt
    this.emptyFor = this.sockets.size === 0 ? this.emptyFor + dt : 0
    // Wrap up after the results, or if nobody (re)joins.
    if (this.endedFor > 10 || this.emptyFor > (this.everJoined ? 6 : 20)) this.stop()
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const ws of this.sockets) {
      try {
        ws.close(1000, 'match over')
      } catch {
        // already closed
      }
    }
    this.sockets.clear()
    this.game = null
  }
}
