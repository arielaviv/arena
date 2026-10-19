import type { ClassId } from '../../shared/combat/types'
import type { Quality } from '../core/renderer'

export interface Settings {
  sensitivity: number
  quality: Quality
  lastClass: ClassId | null
  streak: number // positive = wins in a row, negative = losses
  matches: number
}

const KEY = 'arena.settings.v1'
const DEFAULTS: Settings = { sensitivity: 0.0022, quality: 'high', lastClass: null, streak: 0, matches: 0 }

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(parsed as Partial<Settings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // storage blocked: settings just won't persist
  }
}

// 0 easy .. 1 hard. First match is easy; wins push it up, losses pull it down.
export function difficultyFor(s: Settings): number {
  const base = s.matches === 0 ? 0.15 : 0.35
  return Math.max(0.05, Math.min(1, base + s.streak * 0.12))
}
