import type { ClassId } from '../../shared/combat/types'
import type { QueueMessage } from '../../shared/net/protocol'

export interface MatchTicket {
  room: string
  token: string
  you: number
  theme: 'sky' | 'caldera'
}

const DEFAULT_SERVER = 'https://arena-server.arena-game.workers.dev'

// Server base URL: ?server= override, build-time env, then the default.
export function serverBase(): string | null {
  const params = new URLSearchParams(location.search)
  if (params.has('offline')) return null
  const fromQuery = params.get('server')
  if (fromQuery) return fromQuery.replace(/\/$/, '')
  const fromEnv: unknown = import.meta.env.VITE_ARENA_SERVER
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv.replace(/\/$/, '')
  return DEFAULT_SERVER
}

function wsBase(base: string): string {
  return base.replace(/^http/, 'ws')
}

export function roomUrl(base: string, t: MatchTicket): string {
  return `${wsBase(base)}/room/${t.room}?token=${encodeURIComponent(t.token)}`
}

// Join the matchmaking queue. Rejects quickly if the server can't be reached
// so the caller can fall back to an offline match.
export function findMatch(
  base: string,
  classId: ClassId,
  name: string,
  difficulty: number,
): { promise: Promise<MatchTicket>; cancel: () => void } {
  const url = `${wsBase(base)}/queue?class=${classId}&name=${encodeURIComponent(name)}&difficulty=${difficulty.toFixed(2)}`
  let ws: WebSocket | null = null
  let settled = false
  const promise = new Promise<MatchTicket>((resolve, reject) => {
    const fail = (why: string) => {
      if (settled) return
      settled = true
      ws?.close()
      reject(new Error(why))
    }
    const connectTimer = window.setTimeout(() => fail('server timeout'), 3500)
    const matchTimer = window.setTimeout(() => fail('no match'), 20000)
    try {
      ws = new WebSocket(url)
    } catch {
      fail('bad server url')
      return
    }
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return
      let msg: QueueMessage
      try {
        msg = JSON.parse(ev.data) as QueueMessage
      } catch {
        return
      }
      if (msg.type === 'queued') window.clearTimeout(connectTimer)
      if (msg.type === 'match' && !settled) {
        settled = true
        window.clearTimeout(connectTimer)
        window.clearTimeout(matchTimer)
        resolve({ room: msg.room, token: msg.token, you: msg.you, theme: msg.theme })
      }
    })
    ws.addEventListener('error', () => fail('queue error'))
    ws.addEventListener('close', () => fail('queue closed'))
  })
  return {
    promise,
    cancel: () => {
      settled = true
      ws?.close()
    },
  }
}
