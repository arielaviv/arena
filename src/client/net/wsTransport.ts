import { decodeServer, encodeClient } from '../../shared/net/codec'
import type { ClientMessage, ServerMessage } from '../../shared/net/protocol'
import type { InputCmd } from '../../shared/sim/input'
import type { Transport } from './transport'

// Online transport: one WebSocket to a match room. Inputs are batched two
// ticks at a time (30 sends a second) to stay well inside server limits.
export class WebSocketTransport implements Transport {
  readonly online = true
  timeScale = 1
  closed = false
  private readonly ws: WebSocket
  private listener: ((msg: ServerMessage) => void) | null = null
  private pending: InputCmd[] = []
  private outbox: string[] = []
  private sinceFlush = 0

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.addEventListener('open', () => {
      for (const data of this.outbox) this.ws.send(data)
      this.outbox = []
    })
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return
      try {
        this.listener?.(decodeServer(ev.data))
      } catch {
        // ignore malformed frames
      }
    })
    const done = () => {
      this.closed = true
    }
    this.ws.addEventListener('close', done)
    this.ws.addEventListener('error', done)
  }

  send(msg: ClientMessage): void {
    if (msg.type === 'input') {
      this.pending.push(msg.cmd)
      return
    }
    this.raw(encodeClient(msg))
  }

  onMessage(cb: (msg: ServerMessage) => void): void {
    this.listener = cb
  }

  update(dt: number): void {
    this.sinceFlush += dt
    if (this.pending.length >= 2 || (this.pending.length > 0 && this.sinceFlush >= 1 / 30)) {
      this.raw(encodeClient({ type: 'inputs', cmds: this.pending }))
      this.pending = []
      this.sinceFlush = 0
    }
  }

  private raw(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
    else if (this.ws.readyState === WebSocket.CONNECTING) this.outbox.push(data)
  }

  close(): void {
    this.listener = null
    try {
      this.ws.close(1000, 'left')
    } catch {
      // already closed
    }
  }
}
