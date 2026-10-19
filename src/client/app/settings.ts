import type { ClassId } from '../../shared/combat/types'
import { DEFAULT_KEYBINDS, type Keybinds, sanitizeKeybinds } from '../core/keybinds'
import type { Quality } from '../core/renderer'

export interface Settings {
  sensitivity: number
  quality: Quality
  qualityChosen: boolean
  lastClass: ClassId | null
  streak: number // positive = wins in a row, negative = losses
  matches: number
  keybinds: Keybinds
}

const KEY = 'arena.settings.v1'
const DEFAULTS: Settings = {
  sensitivity: 0.0022,
  quality: 'high',
  qualityChosen: false,
  lastClass: null,
  streak: 0,
  matches: 0,
  keybinds: { ...DEFAULT_KEYBINDS },
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    const merged = { ...DEFAULTS, ...(parsed as Partial<Settings>) }
    merged.keybinds = sanitizeKeybinds((parsed as { keybinds?: unknown }).keybinds)
    return merged
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
