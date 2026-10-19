import type { FighterSnap, Snapshot } from '../../shared/net/protocol'
import { TICK_RATE } from '../../shared/sim/constants'

export interface InterpState {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  vx: number
  vz: number
}

interface Sample {
  t: number
  snap: FighterSnap
}

// Remote fighters are drawn slightly in the past, between two snapshots.
export class Interpolator {
  private samples = new Map<number, Sample[]>()
  delay = 2 / 30

  push(snap: Snapshot): void {
    const t = snap.tick / TICK_RATE
    for (const f of snap.fighters) {
      let list = this.samples.get(f.id)
      if (!list) {
        list = []
        this.samples.set(f.id, list)
      }
      list.push({ t, snap: f })
      if (list.length > 20) list.shift()
    }
  }

  clear(): void {
    this.samples.clear()
  }

  sample(id: number, serverTime: number, out: InterpState): boolean {
    const list = this.samples.get(id)
    if (!list || list.length === 0) return false
    const rt = serverTime - this.delay
    let a = list[0] as Sample
    let b = a
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i] as Sample
      if (s.t <= rt) {
        a = s
        b = list[i + 1] ?? s
        break
      }
    }
    const span = b.t - a.t
    const k = span > 1e-6 ? Math.min(1, Math.max(0, (rt - a.t) / span)) : 1
    const sa = a.snap
    const sb = b.snap
    // Teleports (respawn, blink) snap instead of sliding across the map.
    const jump = Math.hypot(sb.x - sa.x, sb.z - sa.z) > 6
    const t = jump ? 1 : k
    out.x = sa.x + (sb.x - sa.x) * t
    out.y = sa.y + (sb.y - sa.y) * t
    out.z = sa.z + (sb.z - sa.z) * t
    out.yaw = lerpAngle(sa.yaw, sb.yaw, t)
    out.pitch = sa.pitch + (sb.pitch - sa.pitch) * t
    out.vx = sb.vx
    out.vz = sb.vz
    return true
  }
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
