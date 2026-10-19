import { CLASSES, PLAYABLE } from '../../shared/combat/registry'
import type { ClassId } from '../../shared/combat/types'
import type { FighterSnap } from '../../shared/net/protocol'
import { ACTION_LABEL, type Action, type Keybinds, keyLabel } from '../core/keybinds'
import { el, show } from './dom'
import { abilityIcon, iconSvg } from './icons'

export class TitleScreen {
  readonly root: HTMLDivElement
  readonly play: HTMLButtonElement
  readonly training: HTMLButtonElement
  readonly change: HTMLButtonElement
  private readonly chip: HTMLDivElement

  constructor(parent: HTMLElement) {
    this.root = el('div', 'absolute inset-0 flex flex-col items-center justify-center', parent)
    el('div', 'pointer-events-none absolute inset-0', this.root).style.background =
      'radial-gradient(ellipse at 50% 55%, rgba(12,12,15,0) 30%, rgba(12,12,15,0.55) 100%)'
    const word = el('h1', 'banner relative leading-[0.82] text-zinc-50', this.root, 'ARENA')
    word.style.fontSize = 'clamp(96px, 21vw, 340px)'
    word.style.textShadow = '0 12px 60px rgba(0,0,0,0.45)'
    const row = el('div', 'interactive relative mt-10 flex flex-col items-center gap-3', this.root)
    this.play = el(
      'button',
      'rounded-2xl bg-zinc-50 px-16 py-5 font-display text-3xl font-black tracking-tight text-zinc-950 shadow-2xl transition hover:scale-[1.04] active:scale-95',
      row,
      'PLAY',
    )
    this.chip = el('div', 'text-sm font-semibold text-zinc-200 drop-shadow', row)
    const links = el('div', 'flex gap-5 text-sm font-semibold text-zinc-300', row)
    this.change = el('button', 'hover:text-white transition', links, 'Change class')
    this.training = el('button', 'hover:text-white transition', links, 'Training')
    const touchOnly =
      window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches
    if (touchOnly)
      el('div', 'mt-2 text-xs font-semibold text-amber-200/90', row, 'Keyboard and mouse required')
  }

  setClass(id: ClassId | null): void {
    if (!id) {
      this.chip.textContent = ''
      show(this.change, false)
      return
    }
    const c = CLASSES[id]
    this.chip.innerHTML = `as <span style="color:${c.colors.glow}">${c.name}</span>`
    show(this.change, true)
  }

  setVisible(v: boolean): void {
    show(this.root, v)
  }
}

export class ClassPickScreen {
  readonly root: HTMLDivElement
  private readonly cards = new Map<ClassId, HTMLButtonElement>()
  private readonly thumbs = new Map<ClassId, HTMLImageElement>()
  onPick: ((id: ClassId) => void) | null = null
  readonly trainingLink: HTMLButtonElement
  readonly back: HTMLButtonElement

  constructor(parent: HTMLElement) {
    this.root = el(
      'div',
      'interactive absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/55 backdrop-blur-[2px]',
      parent,
    )
    el('div', 'banner mb-8 text-5xl text-zinc-50', this.root, 'Pick your fighter')
    const row = el('div', 'flex flex-wrap justify-center gap-4 px-4', this.root)
    PLAYABLE.forEach((id, i) => {
      const c = CLASSES[id]
      const card = el(
        'button',
        'class-card group relative flex w-[200px] flex-col items-center overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900/90 pb-4 text-left',
        row,
      )
      card.style.setProperty('--glow', c.colors.primary)
      const art = el('div', 'relative grid h-[190px] w-full place-items-center', card)
      art.style.background = `radial-gradient(circle at 50% 65%, ${c.colors.primary}55, transparent 70%)`
      const img = el('img', 'h-[180px] w-[180px] object-contain drop-shadow-2xl', art)
      img.alt = c.name
      this.thumbs.set(id, img)
      el('div', 'absolute left-3 top-2 font-display text-lg font-black text-white/40', art, String(i + 1))
      el('div', 'font-display text-xl font-black text-zinc-50', card, c.name)
      el(
        'div',
        `mt-1 rounded-full px-2 py-[2px] text-[10px] font-bold uppercase tracking-widest ${c.role === 'healer' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300'}`,
        card,
        c.role === 'healer' ? 'Healer' : 'DPS',
      )
      el('div', 'mt-1 text-xs font-semibold text-zinc-400', card, c.archetype)
      const kit = el('div', 'mt-3 flex gap-1 opacity-70 transition group-hover:opacity-100', card)
      for (const s of ['lmb', 'rmb', 'q', 'e', 'f', 'r'] as const) {
        const a = c.abilities[s]
        const chip = el(
          'div',
          'grid h-7 w-7 place-items-center rounded-md border border-zinc-700 bg-zinc-800',
          kit,
          iconSvg(abilityIcon(a), c.colors.glow, 16),
        )
        chip.title = a.name
      }
      card.addEventListener('click', () => this.onPick?.(id))
      this.cards.set(id, card)
    })
    const links = el('div', 'mt-8 flex gap-6 text-sm font-semibold text-zinc-400', this.root)
    this.back = el('button', 'hover:text-white transition', links, 'Back')
    this.trainingLink = el('button', 'hover:text-white transition', links, 'Training (T)')
  }

  setThumb(id: ClassId, url: string): void {
    const img = this.thumbs.get(id)
    if (img) img.src = url
  }

  setVisible(v: boolean): void {
    show(this.root, v)
  }
}

export class ResultsScreen {
  readonly root: HTMLDivElement
  private readonly title: HTMLDivElement
  private readonly table: HTMLDivElement
  private readonly hint: HTMLDivElement

  constructor(parent: HTMLElement) {
    this.root = el('div', 'absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/40', parent)
    this.title = el('div', 'banner text-[clamp(64px,12vw,180px)] leading-none', this.root)
    this.table = el(
      'div',
      'hud-panel mt-6 grid min-w-[520px] grid-cols-[1fr_repeat(4,80px)] gap-y-2 px-5 py-4 text-sm',
      this.root,
    )
    this.hint = el('div', 'mt-6 text-sm font-semibold text-zinc-300', this.root)
  }

  showResult(win: boolean, fighters: FighterSnap[], myTeam: 0 | 1, myId: number): void {
    this.title.textContent = win ? 'VICTORY' : 'DEFEAT'
    this.title.style.color = win ? '#fde68a' : '#fda4af'
    const head = ['', 'Damage', 'Healing', 'Kicks', 'CC']
    let html = head
      .map(
        (h) =>
          `<div class="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ${h ? 'text-right' : ''}">${h}</div>`,
      )
      .join('')
    const sorted = [...fighters].sort((a, b) => (a.team === myTeam ? 0 : 1) - (b.team === myTeam ? 0 : 1))
    for (const f of sorted) {
      const c = CLASSES[f.cls]
      const me = f.id === myId
      html += `<div class="flex items-center gap-2 font-semibold ${f.team === myTeam ? 'text-sky-200' : 'text-rose-200'}"><span class="inline-block h-2 w-2 rounded-full" style="background:${c.colors.primary}"></span>${f.name}${me && f.name !== 'You' ? ' (you)' : ''}</div>`
      html += `<div class="text-right tabular-nums">${Math.round(f.damage)}</div><div class="text-right tabular-nums">${Math.round(f.healing)}</div><div class="text-right tabular-nums">${f.interrupts}</div><div class="text-right tabular-nums">${f.ccDone}</div>`
    }
    this.table.innerHTML = html
  }

  setHint(text: string): void {
    this.hint.textContent = text
  }

  setVisible(v: boolean): void {
    show(this.root, v)
  }
}

export class PauseScreen {
  readonly root: HTMLDivElement
  readonly resume: HTMLButtonElement
  readonly leave: HTMLButtonElement
  readonly sens: HTMLInputElement
  readonly quality: HTMLSelectElement

  constructor(parent: HTMLElement) {
    this.root = el(
      'div',
      'interactive absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/60 backdrop-blur-sm',
      parent,
    )
    this.resume = el(
      'button',
      'rounded-2xl bg-zinc-50 px-12 py-4 font-display text-2xl font-black text-zinc-950 transition hover:scale-[1.04]',
      this.root,
      'RESUME',
    )
    const settings = el(
      'div',
      'hud-panel mt-6 flex w-[320px] flex-col gap-3 p-4 text-sm text-zinc-300',
      this.root,
    )
    const s1 = el('label', 'flex items-center justify-between gap-3', settings, '<span>Sensitivity</span>')
    this.sens = el('input', 'w-40 accent-zinc-100', s1)
    this.sens.type = 'range'
    this.sens.min = '0.0006'
    this.sens.max = '0.006'
    this.sens.step = '0.0001'
    const s2 = el('label', 'flex items-center justify-between gap-3', settings, '<span>Quality</span>')
    this.quality = el('select', 'rounded bg-zinc-800 px-2 py-1 text-zinc-100', s2)
    for (const q of ['high', 'medium', 'low']) {
      const o = el('option', '', this.quality, q[0]?.toUpperCase() + q.slice(1))
      o.value = q
    }
    const kb = el('div', 'hud-panel mt-3 w-[320px] p-4 text-sm text-zinc-300', this.root)
    const head = el('div', 'mb-2 flex items-center justify-between', kb)
    el('span', 'font-semibold text-zinc-100', head, 'Keybinds')
    this.resetKeys = el('button', 'text-xs text-zinc-400 hover:text-white', head, 'Reset')
    this.keyList = el('div', 'grid grid-cols-2 gap-x-3 gap-y-1', kb)
    this.leave = el(
      'button',
      'mt-5 text-sm font-semibold text-zinc-400 hover:text-white',
      this.root,
      'Leave match',
    )
  }

  readonly resetKeys: HTMLButtonElement
  private readonly keyList: HTMLDivElement
  onRebind: ((action: Action) => void) | null = null

  renderKeybinds(binds: Keybinds, waiting: Action | null): void {
    this.keyList.innerHTML = ''
    for (const action of Object.keys(ACTION_LABEL) as Action[]) {
      const row = el('div', 'flex items-center justify-between gap-2', this.keyList)
      el('span', 'truncate text-xs', row, ACTION_LABEL[action])
      const active = waiting === action
      const btn = el(
        'button',
        `min-w-[56px] rounded border px-2 py-[2px] text-xs font-semibold ${active ? 'border-amber-300 text-amber-200' : 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:border-zinc-500'}`,
        row,
        active ? 'Press…' : keyLabel(binds[action]),
      )
      btn.addEventListener('click', () => this.onRebind?.(action))
    }
  }

  setVisible(v: boolean): void {
    show(this.root, v)
  }
}

// "MATCH FOUND" flash shown while the match loads behind it.
export class MatchFoundScreen {
  readonly root: HTMLDivElement
  private timer = 0
  private hideAt = 0

  constructor(parent: HTMLElement) {
    this.root = el('div', 'match-found', parent, '<h1>MATCH FOUND</h1>')
    show(this.root, false)
  }

  play(duration: number): void {
    this.root.classList.remove('leave', 'enter')
    void this.root.offsetWidth
    this.root.classList.add('enter')
    show(this.root, true)
    this.timer = 0
    this.hideAt = duration
  }

  // Returns true on the frame it starts fading out.
  update(dt: number, canFinish = true): boolean {
    if (this.hideAt <= 0) return false
    this.timer += dt
    if (this.timer >= this.hideAt && canFinish) {
      this.hideAt = 0
      this.root.classList.remove('enter')
      this.root.classList.add('leave')
      window.setTimeout(() => show(this.root, false), 280)
      return true
    }
    return false
  }

  get visible(): boolean {
    return this.hideAt > 0
  }
}
