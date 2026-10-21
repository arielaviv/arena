import { Vector3 } from 'three'
import type { World } from './collision'
import { MOVE } from './constants'
import { type Fighter, hurtHeight, isIncapacitated, isRooted, speedMultiplier } from './fighter'
import { Btn, held, type InputCmd, pressed } from './input'

const before = new Vector3()

// Advance one fighter's movement by dt. Shared by the authoritative sim and
// client prediction, so it must only depend on (fighter, cmd, world, dt).
export function stepMovement(f: Fighter, cmd: InputCmd, world: World, dt: number): void {
  stepMovementInner(f, cmd, world, dt)
  recoverIfLost(f, world)
}

function stepMovementInner(f: Fighter, cmd: InputCmd, world: World, dt: number): void {
  f.yaw = cmd.yaw
  f.pitch = cmd.pitch
  if (!f.alive) {
    f.vel.x = 0
    f.vel.z = 0
    applyGravityAndGround(f, world, dt)
    return
  }

  f.slideCooldown = Math.max(0, f.slideCooldown - dt)

  if (f.dash) {
    stepDash(f, world, dt)
    return
  }

  const incap = isIncapacitated(f)
  const confused = f.auras.some((a) => a.def.cc === 'confuse')
  const rooted = isRooted(f)
  let mx = cmd.moveX
  let mz = cmd.moveZ
  let moveYaw = f.yaw
  if (confused) {
    moveYaw = f.confuseYaw
    mx = 0
    mz = 1
  } else if (incap || rooted) {
    mx = 0
    mz = 0
  }

  const len = Math.hypot(mx, mz)
  if (len > 1) {
    mx /= len
    mz /= len
  }
  const cos = Math.cos(moveYaw)
  const sin = Math.sin(moveYaw)
  // forward = (cos, sin), right = (-sin, cos)
  let wishX = cos * mz - sin * mx
  let wishZ = sin * mz + cos * mx
  const wishLen = Math.hypot(wishX, wishZ)
  if (wishLen > 1e-6) {
    wishX /= wishLen
    wishZ /= wishLen
  }

  const firing = held(cmd.buttons, Btn.Lmb) || held(cmd.buttons, Btn.Rmb) || f.cast !== null
  if (mz > 0.5 && Math.abs(mx) < 0.5 && !firing && f.grounded && f.move !== 'slide') {
    f.sprintTimer += dt
  } else if (f.grounded) {
    f.sprintTimer = 0
  }

  const mult = speedMultiplier(f) * (f.cls.speedMult ?? 1)
  let target = MOVE.runSpeed
  if (mz < -0.1) target *= MOVE.backpedalMult
  else if (Math.abs(mx) > 0.1 && mz < 0.1) target *= MOVE.strafeMult
  if (f.sprintTimer > MOVE.sprintDelay) {
    const k = Math.min(1, (f.sprintTimer - MOVE.sprintDelay) / MOVE.sprintRamp)
    target += (MOVE.sprintSpeed - MOVE.runSpeed) * k
  }
  target *= mult

  const slideDown = held(cmd.buttons, Btn.Slide) && !incap && !rooted
  const slidePressed = slideDown && !f.slideHeld
  f.slideHeld = slideDown
  const speedH = Math.hypot(f.vel.x, f.vel.z)

  // Enter slide
  if (slidePressed && f.grounded && f.move !== 'slide' && (speedH > 3 || wishLen > 0)) {
    f.move = 'slide'
    f.slideTimer = 0
    let dirX = speedH > 0.5 ? f.vel.x / speedH : wishX
    let dirZ = speedH > 0.5 ? f.vel.z / speedH : wishZ
    if (wishLen > 1e-6 && speedH < 3) {
      dirX = wishX
      dirZ = wishZ
    }
    const boosted = f.slideCooldown <= 0
    const newSpeed = boosted ? Math.max(speedH, MOVE.slideBoost * Math.min(1, mult + 0.15)) : speedH
    f.vel.x = dirX * newSpeed
    f.vel.z = dirZ * newSpeed
    if (boosted) f.slideCooldown = MOVE.slideBoostCooldown
  }

  const jump = pressed(cmd.buttons, f.prevButtons, Btn.Jump) && !incap && !rooted

  if (f.grounded) {
    if (jump) {
      f.vel.y = MOVE.jumpVelocity
      f.grounded = false
      f.move = 'air'
      f.sprintTimer = Math.min(f.sprintTimer, MOVE.sprintDelay + MOVE.sprintRamp)
    } else if (f.move === 'slide') {
      f.slideTimer += dt
      const s = Math.hypot(f.vel.x, f.vel.z)
      // Downhill gains speed, uphill bleeds it.
      const aheadX = f.pos.x + (s > 0.1 ? f.vel.x / s : 0) * 0.6
      const aheadZ = f.pos.z + (s > 0.1 ? f.vel.z / s : 0) * 0.6
      const hAhead = world.groundHeight(aheadX, aheadZ, f.pos.y + MOVE.step)
      const slope = Number.isFinite(hAhead) ? (f.pos.y - hAhead) / 0.6 : 0
      let ns = s - MOVE.slideFriction * dt * (1 + s * 0.08) + slope * MOVE.slideRampGain * dt
      ns = Math.max(0, ns)
      if (s > 0.1) {
        // Slight steering toward the wish direction
        let dx = f.vel.x / s
        let dz = f.vel.z / s
        if (wishLen > 1e-6) {
          dx += wishX * 2.2 * dt
          dz += wishZ * 2.2 * dt
          const l = Math.hypot(dx, dz)
          dx /= l
          dz /= l
        }
        f.vel.x = dx * ns
        f.vel.z = dz * ns
      }
      if (!slideDown || ns < MOVE.slideMinSpeed || f.slideTimer > MOVE.slideMaxTime) {
        f.move = wishLen > 0 ? 'run' : 'idle'
      }
    } else {
      accelerate(
        f,
        wishX * target,
        wishZ * target,
        wishLen > 0 ? MOVE.groundAccel : MOVE.groundFriction * 8,
        dt,
      )
      f.move = wishLen > 0 ? (f.sprintTimer > MOVE.sprintDelay ? 'sprint' : 'run') : 'idle'
    }
  } else {
    // Air control: limited, cannot push past your current or run speed.
    const cap = Math.max(Math.hypot(f.vel.x, f.vel.z), target)
    f.vel.x += wishX * MOVE.airAccel * MOVE.airControl * 3 * dt
    f.vel.z += wishZ * MOVE.airAccel * MOVE.airControl * 3 * dt
    const s = Math.hypot(f.vel.x, f.vel.z)
    if (s > cap) {
      f.vel.x *= cap / s
      f.vel.z *= cap / s
    }
    f.move = 'air'
  }

  integrate(f, world, dt)
}

function accelerate(f: Fighter, tx: number, tz: number, accel: number, dt: number): void {
  const dx = tx - f.vel.x
  const dz = tz - f.vel.z
  const d = Math.hypot(dx, dz)
  const maxStep = accel * dt
  if (d <= maxStep) {
    f.vel.x = tx
    f.vel.z = tz
  } else {
    f.vel.x += (dx / d) * maxStep
    f.vel.z += (dz / d) * maxStep
  }
}

// Longest distance moved between collision checks. Walls are 0.6 m thick, so
// anything faster (Teleport covers 2 m a tick) is split into sub-steps.
const MAX_STEP = 0.25

function stepDash(f: Fighter, world: World, dt: number): void {
  const d = f.dash
  if (!d) return
  const total = Math.min(d.remaining, d.speed * dt)
  f.vel.set(d.dirX * d.speed, 0, d.dirZ * d.speed)
  f.move = 'dash'
  const steps = Math.max(1, Math.ceil(total / MAX_STEP))
  const stepLen = total / steps
  let stopped = false
  for (let i = 0; i < steps; i++) {
    before.copy(f.pos)
    f.pos.x += d.dirX * stepLen
    f.pos.z += d.dirZ * stepLen
    const blocked = world.resolveCapsule(f.pos, MOVE.radius, MOVE.height, MOVE.step)
    d.remaining -= stepLen
    // Ran into something: stop where we are.
    if (blocked && f.pos.distanceToSquared(before) < stepLen * stepLen * 0.25) {
      stopped = true
      break
    }
  }
  const ground = world.groundHeight(f.pos.x, f.pos.z, f.pos.y + MOVE.step)
  if (Number.isFinite(ground)) f.pos.y = Math.max(ground, f.pos.y - 9 * dt)
  if (stopped || d.remaining <= 1e-4) endDash(f)
}

// Safety net: anyone who ends up below the world or outside it goes back to
// the last ground they stood on.
export function recoverIfLost(f: Fighter, world: World): boolean {
  const out = Math.hypot(f.pos.x, f.pos.z) > world.geo.bounds + 4
  if (f.pos.y > -6 && !out && Number.isFinite(f.pos.x + f.pos.y + f.pos.z)) {
    if (f.grounded) f.safe.copy(f.pos)
    return false
  }
  f.pos.copy(f.safe)
  f.vel.set(0, 0, 0)
  f.dash = null
  f.grounded = true
  f.move = 'idle'
  return true
}

export function endDash(f: Fighter): void {
  if (!f.dash) return
  const keep = 0.45
  f.vel.x = f.dash.dirX * f.dash.speed * keep
  f.vel.z = f.dash.dirZ * f.dash.speed * keep
  f.dash = null
  f.move = 'run'
}

function integrate(f: Fighter, world: World, dt: number): void {
  const speed = Math.hypot(f.vel.x, f.vel.z)
  if (speed > MOVE.maxSpeed) {
    f.vel.x *= MOVE.maxSpeed / speed
    f.vel.z *= MOVE.maxSpeed / speed
  }
  // Fast slides and knockbacks move in collision-checked pieces so they can't
  // tunnel through a wall in one tick.
  const travel = Math.hypot(f.vel.x, f.vel.z) * dt
  const pieces = Math.max(1, Math.ceil(travel / MAX_STEP))
  const sx = (f.vel.x * dt) / pieces
  const sz = (f.vel.z * dt) / pieces
  for (let i = 0; i < pieces - 1; i++) {
    f.pos.x += sx
    f.pos.z += sz
    world.resolveCapsule(f.pos, MOVE.radius, hurtHeight(f), MOVE.step)
  }
  before.copy(f.pos)
  f.pos.x += sx
  f.pos.z += sz
  if (world.resolveCapsule(f.pos, MOVE.radius, hurtHeight(f), MOVE.step)) {
    // Remove the velocity component pointing into whatever pushed us.
    const px = f.pos.x - (before.x + sx)
    const pz = f.pos.z - (before.z + sz)
    const pl = Math.hypot(px, pz)
    if (pl > 1e-6) {
      const nx = px / pl
      const nz = pz / pl
      const vn = f.vel.x * nx + f.vel.z * nz
      if (vn < 0) {
        f.vel.x -= nx * vn
        f.vel.z -= nz * vn
      }
    }
  }
  applyGravityAndGround(f, world, dt)
  f.moving = Math.hypot(f.vel.x, f.vel.z) > 1.5
}

function applyGravityAndGround(f: Fighter, world: World, dt: number): void {
  const wasGrounded = f.grounded
  if (!f.grounded) f.vel.y -= MOVE.gravity * dt
  f.pos.y += f.vel.y * dt
  const ground = world.groundHeight(f.pos.x, f.pos.z, f.pos.y + MOVE.step)
  if (!Number.isFinite(ground)) {
    f.grounded = false
    return
  }
  if (f.vel.y <= 0 && f.pos.y <= ground + 1e-3) {
    f.pos.y = ground
    f.vel.y = 0
    if (!f.grounded && f.move === 'air') f.move = 'run'
    f.grounded = true
  } else if (wasGrounded && f.vel.y <= 0 && f.pos.y - ground < MOVE.step) {
    // Stick to ramps and small steps going down.
    f.pos.y = ground
    f.vel.y = 0
    f.grounded = true
  } else {
    f.grounded = false
  }
}

export function knockback(f: Fighter, dirX: number, dirZ: number, force: number, lift: number): void {
  f.dash = null
  f.vel.x = dirX * force
  f.vel.z = dirZ * force
  f.vel.y = lift
  f.grounded = false
  f.move = 'air'
}
