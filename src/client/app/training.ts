import { CLASSES, PLAYABLE } from '../../shared/combat/registry'
import type { App } from './app'

interface Toggle {
  key: string
  label: string
  on: boolean
}

// Training Grounds hotkeys: swap class, reset cooldowns, aggressor dummy,
// infinite resource, slow motion and world switch.
export class TrainingControls {
  private toggles: Record<'aggressor' | 'infinite' | 'slowmo', Toggle> = {
    aggressor: { key: '7', label: 'Aggressor dummy', on: false },
    infinite: { key: '8', label: 'Infinite resource', on: false },
    slowmo: { key: '9', label: 'Slow motion', on: false },
  }

  constructor(
    private readonly panel: HTMLElement,
    private readonly app: App,
  ) {
    this.render()
  }

  reset(): void {
    for (const t of Object.values(this.toggles)) t.on = false
    this.render()
  }

  // Shift + 1-5 swaps class (the number row casts spells); 6-0 are toggles.
  onKey(code: string, shift: boolean): void {
    const s = this.app.session
    if (!s) return
    const n = Number(code.replace('Digit', ''))
    if (shift && code.startsWith('Digit') && n >= 1 && n <= PLAYABLE.length) {
      const id = PLAYABLE[n - 1]
      if (id) s.swapClass(id)
    } else if (code === 'Digit6') s.sendTraining({ kind: 'resetCooldowns' })
    else if (code === 'Digit7') {
      this.toggles.aggressor.on = !this.toggles.aggressor.on
      s.sendTraining({ kind: 'aggressor', on: this.toggles.aggressor.on })
    } else if (code === 'Digit8') {
      this.toggles.infinite.on = !this.toggles.infinite.on
      s.sendTraining({ kind: 'infinite', on: this.toggles.infinite.on })
    } else if (code === 'Digit9') {
      this.toggles.slowmo.on = !this.toggles.slowmo.on
      s.timeScale = this.toggles.slowmo.on ? 0.25 : 1
    } else if (code === 'Digit0') {
      this.app.toggleWorld()
      return
    } else return
    this.render()
  }

  private render(): void {
    const classes = PLAYABLE.map(
      (id, i) => `<span class="text-zinc-100">⇧${i + 1}</span> ${CLASSES[id].name}`,
    ).join('<br>')
    const toggles = Object.values(this.toggles)
      .map(
        (t) =>
          `<div class="flex justify-between"><span><span class="text-zinc-100">${t.key}</span> ${t.label}</span><span class="${t.on ? 'text-emerald-300' : 'text-zinc-600'}">${t.on ? 'ON' : 'OFF'}</span></div>`,
      )
      .join('')
    this.panel.innerHTML = `
      <div class="mb-2 font-display text-sm font-black text-zinc-50">Training Grounds</div>
      <div class="mb-2 leading-relaxed">${classes}</div>
      <div class="flex flex-col gap-1">
        <div><span class="text-zinc-100">6</span> Reset cooldowns</div>
        ${toggles}
        <div><span class="text-zinc-100">0</span> Switch world</div>
      </div>`
  }
}
