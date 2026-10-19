import { ZZFX } from 'zzfx'

type Param = number | undefined
const u = undefined

// Every sound is synthesized: no audio files to download.
const SOUNDS: Record<string, Param[]> = {
  'shoot-fire': [0.35, 0.05, 320, 0.01, 0.02, 0.14, 3, 1.4, -9, u, u, u, u, 0.7],
  'shoot-water': [0.3, 0.05, 760, 0.005, 0.02, 0.09, 0, 1, -14],
  'shoot-poison': [0.3, 0.1, 240, 0.005, 0.02, 0.07, 4, 1, 3, u, u, u, u, 0.4],
  'shoot-psychic': [0.08, 0.05, 980, u, 0.02, 0.04, 1, 0, 6],
  'shoot-grass': [0.28, 0.05, 520, 0.01, 0.02, 0.12, 0, 1.5, -6, u, u, u, u, 0.2],
  'shoot-normal': [0.25, 0.05, 400, 0.01, 0.02, 0.1, 1, 1, -5],
  hit: [0.45, 0.05, 210, u, 0.01, 0.07, 4, 2, -4, u, u, u, u, 1.1],
  'hit-big': [0.8, 0.05, 95, 0.01, 0.06, 0.35, 4, 2.4, -2, u, u, u, u, 1.4, u, 0.2],
  interrupt: [0.9, 0, 1250, 0.004, 0.03, 0.25, 1, 2, u, u, -620, 0.04, u, u, u, u, 0.08],
  heal: [0.4, 0, 523, 0.02, 0.1, 0.3, 0, 1, u, u, 262, 0.08],
  cc: [0.5, 0, 160, 0.02, 0.18, 0.3, 2, 1, u, u, u, u, 0.1, 0.4, 5],
  death: [0.9, 0.1, 62, 0.02, 0.3, 0.6, 4, 1.5, -1, u, u, u, u, 1],
  kill: [0.7, 0, 880, 0.01, 0.05, 0.3, 1, 1, u, u, 440, 0.06],
  tick: [0.35, 0, 660, u, 0.04, 0.08, 1],
  fight: [0.7, 0, 440, 0.01, 0.2, 0.45, 1, 1, u, u, 220, 0.1],
  victory: [0.7, 0, 523, 0.05, 0.3, 0.5, 0, 1, u, u, 262, 0.12, 0.15],
  defeat: [0.7, 0, 220, 0.05, 0.3, 0.6, 0, 1, -1, u, u, u, 0.2],
  click: [0.25, 0, 1000, u, 0.01, 0.03, 1],
  dash: [0.35, 0.1, 420, 0.01, 0.05, 0.12, 3, 1, 6, u, u, u, u, 1],
  'cast-start': [0.18, 0, 330, 0.08, 0.1, 0.15, 0, 1, 2],
  'cast-done': [0.35, 0, 700, 0.01, 0.05, 0.15, 0, 1, u, u, 350, 0.05],
  error: [0.2, 0, 150, u, 0.03, 0.05, 2],
  'match-found': [0.7, 0, 523, 0.01, 0.16, 0.45, 0, 1, u, u, 261, 0.08, u, u, u, u, 0.12],
}

const cache = new Map<string, number[]>()

export class Audio {
  enabled = true
  private last = new Map<string, number>()

  constructor() {
    ZZFX.volume = 0.28
  }

  unlock(): void {
    if (ZZFX.audioContext.state !== 'running') void ZZFX.audioContext.resume()
  }

  play(name: string, volume = 1, minGap = 0.03): void {
    if (!this.enabled) return
    const now = performance.now() / 1000
    if (now - (this.last.get(name) ?? 0) < minGap) return
    this.last.set(name, now)
    let samples = cache.get(name)
    if (!samples) {
      const params = SOUNDS[name]
      if (!params) return
      samples = ZZFX.buildSamples(...params)
      cache.set(name, samples)
    }
    ZZFX.playSamples([samples], volume, 1 + (Math.random() - 0.5) * 0.06)
  }
}
