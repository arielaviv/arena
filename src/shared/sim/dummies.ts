import { applyAura } from '../combat/effects'
import { getAura } from '../combat/registry'
import { aimAtPoint } from './aim'
import { chestY, type Fighter } from './fighter'
import { Btn, type InputCmd } from './input'
import type { MatchSim } from './match'

const AGGRESSOR_ROTATION = [Btn.Q, Btn.F, Btn.E, Btn.Lmb, Btn.R, Btn.Lmb] as const
const ALLY_DEBUFFS = ['burn', 'poison', 'bleed'] as const

// Training dummy behaviour. Produces InputCmds like any other player.
export class DummyBrain {
  private seq = 0
  private timer = 0
  private step = 0
  private dir = 1
  private readonly aim = { yaw: 0, pitch: 0 }

  constructor(
    readonly id: number,
    readonly railHalf: number,
  ) {}

  think(sim: MatchSim, f: Fighter, dt: number): InputCmd {
    this.seq++
    this.timer += dt
    const cmd: InputCmd = { seq: this.seq, moveX: 0, moveZ: 0, yaw: f.spawnYaw, pitch: 0, buttons: 0 }
    const player = sim.fighters.find((g) => g.control === 'human' && g.alive)

    switch (f.dummyRole) {
      case 'caster':
        if (player) {
          this.face(f, player, cmd)
          cmd.buttons = Btn.Rmb
        }
        break
      case 'mover': {
        cmd.yaw = f.spawnYaw
        const off = f.pos.z - f.spawnZ
        if (off > this.railHalf) this.dir = -1
        else if (off < -this.railHalf) this.dir = 1
        // spawn yaw faces -X, so "right" is -Z; flip to walk along +Z when dir > 0
        cmd.moveX = -this.dir
        break
      }
      case 'aggressor':
        if (player && sim.aggressorOn && this.timer > 2.2) {
          this.timer = 0
          this.face(f, player, cmd)
          cmd.buttons = AGGRESSOR_ROTATION[this.step % AGGRESSOR_ROTATION.length] ?? 0
          this.step++
        } else if (player && sim.aggressorOn) {
          this.face(f, player, cmd)
        }
        break
      case 'ally':
        // Takes a hit and a debuff every few seconds so heals and dispels have work to do.
        if (this.timer > 5 && f.alive) {
          this.timer = 0
          if (f.hp > f.maxHp * 0.2) sim.hurtFromEnvironment(f, 110)
          const enemy = sim.fighters.find((g) => g.team !== f.team && g.control === 'dummy')
          const aura = ALLY_DEBUFFS[this.step % ALLY_DEBUFFS.length] ?? 'burn'
          if (enemy) applyAura(sim, enemy, f, getAura(aura), aura === 'poison' ? 3 : 1)
          this.step++
        }
        break
      default:
        break
    }
    return cmd
  }

  private face(f: Fighter, target: Fighter, cmd: InputCmd): void {
    aimAtPoint(f, target.pos.x, chestY(target), target.pos.z, this.aim)
    cmd.yaw = this.aim.yaw
    cmd.pitch = this.aim.pitch
  }
}
