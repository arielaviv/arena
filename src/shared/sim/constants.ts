export const TICK_RATE = 60
export const DT = 1 / TICK_RATE
export const SNAPSHOT_EVERY = 2 // 30 Hz snapshots

export const MOVE = {
  radius: 0.45,
  height: 1.8,
  slideHeight: 1.0,
  eye: 1.62,
  slideEye: 1.0,
  step: 0.45,
  runSpeed: 8,
  backpedalMult: 0.6,
  strafeMult: 0.92,
  sprintSpeed: 10.5,
  sprintDelay: 0.5,
  sprintRamp: 0.35,
  groundAccel: 70,
  groundFriction: 12,
  airAccel: 18,
  airControl: 0.3,
  gravity: 24,
  jumpVelocity: 7.75, // sqrt(2 * 24 * 1.25)
  slideBoost: 13,
  slideFriction: 2.2,
  slideMinSpeed: 4.5,
  slideMaxTime: 1.1,
  slideBoostCooldown: 0.9,
  slideRampGain: 9,
  maxSpeed: 22,
} as const

// Canonical shoulder camera used for aiming. The client camera starts from the
// same numbers so the crosshair and the server agree on what is being aimed at.
export const CAMERA = {
  distance: 4.2,
  shoulder: 0.85,
  height: 1.75,
  slideDrop: 0.6,
  pitchMin: -1.2,
  pitchMax: 1.1,
} as const

export const COMBAT = {
  gcd: 0.25,
  lockout: 3,
  drReset: 15,
  meleeRange: 3.6,
  aimAssistAngle: 0.1, // radians, cone for targeted spells
  allyAssistAngle: 0.16,
} as const
