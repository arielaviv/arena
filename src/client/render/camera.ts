import { type PerspectiveCamera, Vector3 } from 'three'
import { makeRayHit, type World } from '../../shared/sim/collision'
import { CAMERA } from '../../shared/sim/constants'
import { Block } from '../../shared/sim/geometry'

const hit = makeRayHit()

// Over-the-shoulder camera. Action controls use the same numbers as the
// sim's canonical aim camera (so the crosshair is honest); classic controls
// zoom with the wheel and sit closer to centre. Smooths height, pulls in
// against walls and adds juice.
export class CameraRig {
  distance: number = CAMERA.distance
  shoulder: number = CAMERA.shoulder
  private pivotY = 0
  private fovKick = 0
  private trauma = 0
  private shakeTime = 0
  private pull: number = CAMERA.distance
  readonly dir = new Vector3()
  readonly position = new Vector3()
  private readonly look = new Vector3()

  constructor(private readonly camera: PerspectiveCamera) {}

  addShake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount)
  }

  kickFov(amount: number): void {
    this.fovKick = Math.max(this.fovKick, amount)
  }

  update(
    dt: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    sliding: boolean,
    speed: number,
    world: World | null,
    baseFov: number,
  ): void {
    const targetPivot = y + CAMERA.height - (sliding ? CAMERA.slideDrop : 0)
    if (Math.abs(targetPivot - this.pivotY) > 4) this.pivotY = targetPivot
    this.pivotY += (targetPivot - this.pivotY) * (1 - Math.exp(-dt * 14))

    const cp = Math.cos(pitch)
    this.dir.set(cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw))
    const rx = -Math.sin(yaw)
    const rz = Math.cos(yaw)

    // Pull in when a wall sits between the head and the camera.
    let want = this.distance
    if (world) {
      const sx = x + rx * this.shoulder
      const sz = z + rz * this.shoulder
      if (
        world.raycastPrisms(
          sx,
          this.pivotY,
          sz,
          -this.dir.x,
          -this.dir.y,
          -this.dir.z,
          this.distance + 0.3,
          Block.Los,
          hit,
        )
      ) {
        want = Math.max(0.6, hit.t - 0.3)
      }
      const ground = world.groundHeight(sx - this.dir.x * want, sz - this.dir.z * want, this.pivotY + 2)
      if (Number.isFinite(ground)) {
        const camY = this.pivotY - this.dir.y * want
        if (camY < ground + 0.25 && this.dir.y > 0.05)
          want = Math.max(0.6, (this.pivotY - ground - 0.25) / this.dir.y)
      }
    }
    this.pull = want < this.pull ? want : this.pull + (want - this.pull) * (1 - Math.exp(-dt * 5))

    this.position.set(
      x - this.dir.x * this.pull + rx * this.shoulder,
      this.pivotY - this.dir.y * this.pull,
      z - this.dir.z * this.pull + rz * this.shoulder,
    )

    // Shake
    this.trauma = Math.max(0, this.trauma - dt * 1.8)
    this.shakeTime += dt * 38
    const s = this.trauma * this.trauma
    const ox = (Math.sin(this.shakeTime * 1.3) + Math.sin(this.shakeTime * 2.9) * 0.5) * 0.12 * s
    const oy = (Math.sin(this.shakeTime * 1.7 + 1) + Math.sin(this.shakeTime * 3.3) * 0.5) * 0.12 * s

    this.camera.position.copy(this.position)
    this.camera.position.x += rx * ox
    this.camera.position.z += rz * ox
    this.camera.position.y += oy
    this.look.copy(this.camera.position).add(this.dir)
    this.camera.lookAt(this.look)

    const speedFov = Math.max(0, speed - 8) * 0.9
    this.fovKick = Math.max(0, this.fovKick - dt * 30)
    const fov = baseFov + (sliding ? 8 : 0) + speedFov + this.fovKick
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 10))
      this.camera.updateProjectionMatrix()
    }
  }
}
