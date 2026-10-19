import type { DrCategory } from './types'

export type CastAction = 'start' | 'success' | 'interrupted' | 'cancel' | 'fail'
export type FailReason =
  | 'los'
  | 'range'
  | 'target'
  | 'moved'
  | 'cc'
  | 'cooldown'
  | 'resource'
  | 'lockout'
  | 'silenced'
export type AuraAction = 'apply' | 'refresh' | 'remove' | 'expire' | 'break' | 'dispel'

// Everything the client needs to draw effects, feed the HUD and the combat log.
export type SimEvent =
  | {
      t: 'damage'
      src: number
      dst: number
      amount: number
      absorbed: number
      ability: string
      tick: boolean
      x: number
      y: number
      z: number
    }
  | { t: 'heal'; src: number; dst: number; amount: number; ability: string; tick: boolean }
  | {
      t: 'aura'
      src: number
      dst: number
      aura: string
      action: AuraAction
      stacks: number
      duration: number
    }
  | { t: 'cast'; src: number; ability: string; action: CastAction; reason?: FailReason; target: number }
  | { t: 'interrupt'; src: number; dst: number; ability: string; lockout: number }
  | { t: 'immune'; src: number; dst: number; aura: string }
  | { t: 'dr'; dst: number; cat: DrCategory; level: number }
  | {
      t: 'use'
      src: number
      ability: string
      x: number
      y: number
      z: number
      tx: number
      ty: number
      tz: number
      target: number
    }
  | {
      t: 'impact'
      ability: string
      src: number
      x: number
      y: number
      z: number
      nx: number
      ny: number
      nz: number
    }
  | {
      t: 'hazard'
      id: number
      ability: string
      src: number
      x: number
      y: number
      z: number
      radius: number
      duration: number
    }
  | { t: 'delayed'; id: number; ability: string; src: number; target: number; delay: number; radius: number }
  | {
      t: 'detonate'
      id: number
      ability: string
      src: number
      x: number
      y: number
      z: number
      radius: number
    }
  | { t: 'death'; dst: number; src: number }
  | { t: 'phase'; phase: string; timer: number }
