import { Vector3 } from 'three'
import type { FighterSnap } from '../../shared/net/protocol'
import type { World } from '../../shared/sim/collision'
import { DT } from '../../shared/sim/constants'
import type { Fighter } from '../../shared/sim/fighter'
import type { InputCmd } from '../../shared/sim/input'
import { stepMovement } from '../../shared/sim/movement'
import { applySnap, fighterFromSnap } from './state'

// Client-side prediction of the local fighter's movement with server
// reconciliation: replay unacknowledged inputs on top of each snapshot.
export class Predictor {
  fighter: Fighter | null = null
  readonly prev = new Vector3()
  readonly curr = new Vector3()
  readonly offset = new Vector3()
  private pending: InputCmd[] = []
  private readonly before = new Vector3()

  constructor(private readonly world: World) {}

  reset(): void {
    this.fighter = null
    this.pending = []
    this.offset.set(0, 0, 0)
  }

  step(cmd: InputCmd): void {
    const f = this.fighter
    if (!f) return
    this.pending.push(cmd)
    if (this.pending.length > 240) this.pending.shift()
    this.prev.copy(f.pos)
    f.input = cmd
    stepMovement(f, cmd, this.world, DT)
    f.prevButtons = cmd.buttons
    this.curr.copy(f.pos)
  }

  reconcile(s: FighterSnap): void {
    if (!this.fighter) {
      this.fighter = fighterFromSnap(s)
      this.prev.copy(this.fighter.pos)
      this.curr.copy(this.fighter.pos)
      return
    }
    const f = this.fighter
    this.before.copy(f.pos)
    applySnap(f, s)
    this.pending = this.pending.filter((c) => c.seq > s.lastSeq)
    for (const cmd of this.pending) {
      f.input = cmd
      stepMovement(f, cmd, this.world, DT)
      f.prevButtons = cmd.buttons
    }
    // Hide small corrections by blending them out over a few frames.
    const err = this.before.distanceTo(f.pos)
    if (err > 3) {
      this.offset.set(0, 0, 0)
      this.prev.copy(f.pos)
    } else {
      this.offset.add(this.before).sub(f.pos)
    }
    this.curr.copy(f.pos)
  }

  decayOffset(dt: number): void {
    this.offset.multiplyScalar(Math.exp(-dt * 14))
  }
}
