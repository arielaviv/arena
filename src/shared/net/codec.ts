import type { ClientMessage, ServerMessage } from './protocol'

// Every message crosses this boundary, even in single-player, so client and
// sim never share object references. JSON for now; the wire format can turn
// binary behind the same functions when the real server lands.
export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg, roundNumbers)
}

export function decodeServer(data: string): ServerMessage {
  const parsed: unknown = JSON.parse(data)
  if (!isRecord(parsed) || (parsed.type !== 'welcome' && parsed.type !== 'snap')) {
    throw new Error('bad server message')
  }
  return parsed as unknown as ServerMessage
}

export function encodeClient(msg: ClientMessage): string {
  return JSON.stringify(msg)
}

export function decodeClient(data: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (!isRecord(parsed)) return null
    if (parsed.type === 'input' && isRecord(parsed.cmd)) return parsed as unknown as ClientMessage
    if (parsed.type === 'training' && isRecord(parsed.cmd)) return parsed as unknown as ClientMessage
    return null
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// Trim float noise so snapshots stay small.
function roundNumbers(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) return Math.round(value * 10000) / 10000
  return value
}
