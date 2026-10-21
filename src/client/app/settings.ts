import type { ClassId } from '../../shared/combat/types'
import { type ControlScheme, defaultKeybinds, type Keybinds, sanitizeKeybinds } from '../core/keybinds'
import type { Quality } from '../core/renderer'

export interface Settings {
  sensitivity: number
  quality: Quality
  qualityChosen: boolean
  lastClass: ClassId | null
  streak: number // positive = wins in a row, negative = losses
  matches: number
  controls: ControlScheme
  keybinds: Keybinds
  playerName: string
}

const KEY = 'arena.settings.v1'
const DEFAULTS: Settings = {
  sensitivity: 0.0022,
  quality: 'high',
  qualityChosen: false,
  lastClass: null,
  streak: 0,
  matches: 0,
  controls: 'classic',
  keybinds: defaultKeybinds('classic'),
  playerName: '',
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    const merged = { ...DEFAULTS, ...(parsed as Partial<Settings>) }
    // Saves from before the classic controls were mouselook bindings: start
    // those players on the new defaults.
    const saved = (parsed as { controls?: unknown }).controls
    merged.controls = saved === 'action' ? 'action' : 'classic'
    merged.keybinds =
      saved === undefined
        ? defaultKeybinds('classic')
        : sanitizeKeybinds((parsed as { keybinds?: unknown }).keybinds, merged.controls)
    if (typeof merged.playerName !== 'string') merged.playerName = ''
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

const HANDLES = [
  'Ember',
  'Rift',
  'Sable',
  'Nova',
  'Kite',
  'Onyx',
  'Vale',
  'Echo',
  'Flint',
  'Moss',
  'Rune',
  'Zest',
]

// A stable online handle so other players see a name, not "You".
export function ensurePlayerName(s: Settings): string {
  if (!s.playerName) {
    const h = HANDLES[Math.floor(Math.random() * HANDLES.length)] ?? 'Player'
    s.playerName = `${h}${Math.floor(100 + Math.random() * 900)}`
    saveSettings(s)
  }
  return s.playerName
}
