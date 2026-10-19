import { CLASSES, findAuraDef, getAbility } from '../../shared/combat/registry'
import { DR_CATEGORIES } from '../../shared/combat/types'
import type { FighterSnap } from '../../shared/net/protocol'
import { type Bar, bar, el, fmtTime, setBar, setStyle, setText, show } from './dom'
import { iconSvg } from './icons'

const RESOURCE_COLOR = {
  mana: 'linear-gradient(90deg,#2563eb,#60a5fa)',
  energy: 'linear-gradient(90deg,#ca8a04,#facc15)',
}

export function hpColor(team: 0 | 1, myTeam: 0 | 1): string {
  return team === myTeam ? 'linear-gradient(90deg,#16a34a,#4ade80)' : 'linear-gradient(90deg,#be123c,#fb7185)'
}

// A row of aura icons with radial timers and stack counts.
export class AuraRow {
  readonly root: HTMLDivElement
  private icons: Array<{
    root: HTMLDivElement
    sweep: HTMLDivElement
    stacks: HTMLDivElement
    time: HTMLDivElement
    key: string
  }> = []

  constructor(
    parent: HTMLElement,
    private readonly max: number,
    private readonly size = 22,
  ) {
    this.root = el('div', 'flex flex-wrap gap-[3px]', parent)
  }

  update(f: FighterSnap | null, filter?: (harmful: boolean) => boolean): void {
    const auras = f
      ? f.auras.filter((a) => (filter ? filter(findAuraDef(a.id)?.harmful ?? false) : true))
      : []
    // Crowd control first, then harmful, then helpful.
    auras.sort((a, b) => score(b.id) - score(a.id))
    const n = Math.min(this.max, auras.length)
    while (this.icons.length < n) {
      const root = el('div', 'aura', this.root)
      root.style.width = `${this.size}px`
      root.style.height = `${this.size}px`
      const sweep = el('div', 'sweep', root)
      const time = el('div', 'time', root)
      const stacks = el('div', 'stacks', root)
      this.icons.push({ root, sweep, stacks, time, key: '' })
    }
    this.icons.forEach((icon, i) => {
      const a = auras[i]
      if (!a || i >= n) {
        show(icon.root, false)
        return
      }
      show(icon.root, true)
      const def = findAuraDef(a.id)
      if (!def) return
      if (icon.key !== a.id) {
        icon.key = a.id
        icon.root.style.background = `linear-gradient(160deg, ${def.color}, #18181b 130%)`
        icon.root.classList.toggle('harmful', def.harmful)
        icon.root.querySelector('svg')?.remove()
        icon.root.insertAdjacentHTML('afterbegin', iconSvg(def.glyph, '#fafafa', this.size - 8))
        icon.root.title = def.name
      }
      setStyle(icon.sweep, '--cd', (1 - a.rem / Math.max(0.01, a.dur)).toFixed(3))
      setText(icon.time, a.rem < 10 ? fmtTime(a.rem) : '')
      setText(icon.stacks, a.stacks > 1 ? String(a.stacks) : '')
    })
  }
}

function score(id: string): number {
  const d = findAuraDef(id)
  if (!d) return 0
  return (d.cc ? 4 : 0) + (d.harmful ? 2 : 0)
}

export class CastBar {
  readonly root: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly name: HTMLDivElement
  private readonly time: HTMLDivElement
  private fadeTimer = 0
  private lastText = ''

  constructor(parent: HTMLElement, height: number, wide = false) {
    this.root = el('div', 'relative overflow-hidden rounded-md border border-zinc-700 bg-zinc-900/90', parent)
    this.root.style.height = `${height}px`
    this.fill = el('div', 'absolute inset-y-0 left-0', this.root)
    this.name = el(
      'div',
      `absolute inset-0 flex items-center px-2 font-semibold ${wide ? 'text-sm' : 'text-[10px]'} text-zinc-50`,
      this.root,
    )
    this.time = el(
      'div',
      `absolute inset-y-0 right-2 flex items-center ${wide ? 'text-xs' : 'text-[10px]'} text-zinc-300`,
      this.root,
    )
    show(this.root, false)
  }

  // Flash "Interrupted" / "Success" briefly after a cast ends.
  flash(text: string, color: string): void {
    this.fadeTimer = 0.7
    this.lastText = text
    show(this.root, true)
    setStyle(this.fill, 'width', '100%')
    setStyle(this.fill, 'background', color)
    setText(this.name, text)
    setText(this.time, '')
  }

  update(f: FighterSnap | null, dt: number): void {
    const c = f?.cast
    if (c) {
      this.fadeTimer = 0
      const a = getAbility(c.ability)
      const color = c.channel
        ? 'linear-gradient(90deg,#0891b2,#67e8f9)'
        : 'linear-gradient(90deg,#d97706,#fde047)'
      show(this.root, true)
      setStyle(this.fill, 'background', f && f.lockout > 0 ? '#71717a' : color)
      const frac = c.channel ? 1 - c.elapsed / c.duration : c.elapsed / c.duration
      setStyle(this.fill, 'width', `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%`)
      setText(this.name, a?.name ?? '')
      setText(this.time, c.duration < 20 ? (c.duration - c.elapsed).toFixed(1) : '')
      return
    }
    if (this.fadeTimer > 0) {
      this.fadeTimer -= dt
      setStyle(this.root, 'opacity', String(Math.min(1, this.fadeTimer * 2.5)))
      if (this.fadeTimer <= 0) show(this.root, false)
      void this.lastText
      return
    }
    setStyle(this.root, 'opacity', '1')
    show(this.root, false)
  }
}

function portrait(parent: HTMLElement, size: number): HTMLDivElement {
  const p = el(
    'div',
    'relative shrink-0 rounded-full border-2 border-zinc-700 grid place-items-center overflow-hidden',
    parent,
  )
  p.style.width = `${size}px`
  p.style.height = `${size}px`
  return p
}

function setPortrait(p: HTMLDivElement, f: FighterSnap): void {
  const cls = CLASSES[f.cls]
  const key = `${f.cls}`
  if (p.dataset.cls === key) return
  p.dataset.cls = key
  p.style.background = `radial-gradient(circle at 40% 35%, ${cls.colors.glow}, ${cls.colors.primary} 45%, ${cls.colors.secondary} 100%)`
  p.innerHTML = `<span class="font-display text-[13px] font-black text-white/90 drop-shadow">${cls.name[0] ?? ''}</span>`
}

// Party frame (left side): portrait, HP, resource, cast bar, auras.
export class PartyFrame {
  readonly root: HTMLDivElement
  private readonly pic: HTMLDivElement
  private readonly name: HTMLDivElement
  private readonly hp: Bar
  private readonly res: Bar
  private readonly cast: CastBar
  private readonly auras: AuraRow

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-panel flex w-[250px] gap-2 p-2 transition-opacity', parent)
    this.pic = portrait(this.root, 44)
    const col = el('div', 'flex min-w-0 flex-1 flex-col gap-[3px]', this.root)
    this.name = el('div', 'truncate text-[12px] font-semibold text-zinc-100', col)
    this.hp = bar(col, '#22c55e', 16)
    this.res = bar(col, '#3b82f6', 5, false)
    this.cast = new CastBar(col, 12)
    this.auras = new AuraRow(col, 8, 18)
  }

  update(f: FighterSnap, myTeam: 0 | 1, focused: boolean, visible: boolean, dt: number): void {
    setPortrait(this.pic, f)
    setText(this.name, f.name)
    setBar(this.hp, f.hp / f.maxHp, f.alive ? `${Math.round(f.hp)}` : 'DEAD')
    setStyle(this.hp.fill, 'background', hpColor(f.team, myTeam))
    setBar(this.res, f.res / f.maxRes)
    setStyle(this.res.fill, 'background', RESOURCE_COLOR[CLASSES[f.cls].resource])
    this.cast.update(f, dt)
    this.auras.update(f)
    setStyle(this.root, 'opacity', !f.alive ? '0.45' : visible ? '1' : '0.55')
    setStyle(this.root, 'border-color', focused ? 'rgba(250,250,250,0.55)' : 'rgba(63,63,70,0.9)')
  }
}

const DR_GLYPH: Record<string, string> = {
  stun: 'stun',
  incap: 'sleep',
  disorient: 'confuse',
  root: 'root',
  silence: 'silence',
}

// Gladius-style arena frame (right side) for one enemy.
export class ArenaFrame {
  readonly root: HTMLDivElement
  private readonly pic: HTMLDivElement
  private readonly name: HTMLDivElement
  private readonly hp: Bar
  private readonly res: Bar
  private readonly cast: CastBar
  private readonly cc: HTMLDivElement
  private readonly ccTime: HTMLDivElement
  private readonly trinket: HTMLDivElement
  private readonly trinketSweep: HTMLDivElement
  private readonly dr: Array<{ root: HTMLDivElement; time: HTMLDivElement }> = []

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-panel flex w-[290px] items-stretch gap-2 p-2', parent)
    const trinketWrap = el('div', 'flex flex-col gap-1', this.root)
    this.trinket = el('div', 'aura', trinketWrap)
    this.trinket.style.width = '26px'
    this.trinket.style.height = '26px'
    this.trinket.style.background = 'linear-gradient(160deg,#facc15,#18181b 130%)'
    this.trinket.insertAdjacentHTML('afterbegin', iconSvg('berry', '#fafafa', 18))
    this.trinketSweep = el('div', 'sweep', this.trinket)
    this.cc = el('div', 'aura', trinketWrap)
    this.cc.style.width = '26px'
    this.cc.style.height = '26px'
    this.ccTime = el('div', 'time', this.cc)
    const col = el('div', 'flex min-w-0 flex-1 flex-col gap-[3px]', this.root)
    const top = el('div', 'flex items-center justify-between', col)
    this.name = el('div', 'truncate text-[12px] font-semibold text-zinc-100', top)
    const drRow = el('div', 'flex gap-[2px]', top)
    for (const cat of DR_CATEGORIES) {
      const d = el('div', 'aura', drRow)
      d.style.width = '16px'
      d.style.height = '16px'
      d.insertAdjacentHTML('afterbegin', iconSvg(DR_GLYPH[cat] ?? 'orb', '#fafafa', 11))
      const time = el('div', 'time', d)
      this.dr.push({ root: d, time })
    }
    this.hp = bar(col, '#ef4444', 16)
    this.res = bar(col, '#3b82f6', 5, false)
    this.cast = new CastBar(col, 13)
    this.pic = portrait(this.root, 48)
  }

  update(f: FighterSnap, myTeam: 0 | 1, isTarget: boolean, dt: number): void {
    setPortrait(this.pic, f)
    const cls = CLASSES[f.cls]
    setText(this.name, `${f.name} · ${cls.role === 'healer' ? 'Healer' : 'DPS'}`)
    setBar(this.hp, f.hp / f.maxHp, f.alive ? `${Math.round((100 * f.hp) / f.maxHp)}%` : 'DEAD')
    setStyle(this.hp.fill, 'background', hpColor(f.team, myTeam))
    setBar(this.res, f.res / f.maxRes)
    setStyle(this.res.fill, 'background', RESOURCE_COLOR[cls.resource])
    this.cast.update(f, dt)
    const trinketCd = f.cd[6] ?? 0
    setStyle(this.trinketSweep, '--cd', trinketCd > 0 ? (trinketCd / 45).toFixed(3) : '0')
    setStyle(this.trinket, 'filter', trinketCd > 0 ? 'grayscale(0.6) brightness(0.7)' : 'none')

    const ccAura = f.auras.find((a) => findAuraDef(a.id)?.cc)
    if (ccAura) {
      const def = findAuraDef(ccAura.id)
      show(this.cc, true)
      if (def && this.cc.dataset.key !== def.id) {
        this.cc.dataset.key = def.id
        this.cc.style.background = `linear-gradient(160deg, ${def.color}, #18181b 130%)`
        this.cc.querySelector('svg')?.remove()
        this.cc.insertAdjacentHTML('afterbegin', iconSvg(def.glyph, '#fafafa', 18))
      }
      setText(this.ccTime, ccAura.rem.toFixed(1))
    } else {
      setStyle(this.cc, 'visibility', 'hidden')
    }
    if (ccAura) setStyle(this.cc, 'visibility', 'visible')

    DR_CATEGORIES.forEach((_, i) => {
      const d = this.dr[i]
      if (!d) return
      const level = f.dr[i] ?? 0
      const t = f.drTimers[i] ?? 0
      setStyle(d.root, 'opacity', level > 0 ? '1' : '0.18')
      setStyle(
        d.root,
        'background',
        level >= 3 ? '#dc2626' : level === 2 ? '#f97316' : level === 1 ? '#eab308' : '#3f3f46',
      )
      setText(d.time, level > 0 ? fmtTime(t) : '')
    })
    setStyle(this.root, 'opacity', f.alive ? '1' : '0.45')
    setStyle(this.root, 'border-color', isTarget ? 'rgba(251,113,133,0.9)' : 'rgba(63,63,70,0.9)')
  }
}

// Target frame (top centre): the enemy you last aimed at.
export class TargetFrame {
  readonly root: HTMLDivElement
  private readonly pic: HTMLDivElement
  private readonly name: HTMLDivElement
  private readonly hp: Bar
  private readonly cast: CastBar
  private readonly auras: AuraRow

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-panel flex w-[340px] gap-2 p-2', parent)
    this.pic = portrait(this.root, 46)
    const col = el('div', 'flex min-w-0 flex-1 flex-col gap-[3px]', this.root)
    this.name = el('div', 'truncate text-[13px] font-semibold text-zinc-100', col)
    this.hp = bar(col, '#ef4444', 16)
    this.cast = new CastBar(col, 16, true)
    this.auras = new AuraRow(col, 12, 20)
  }

  update(f: FighterSnap | null, myTeam: 0 | 1, dt: number): void {
    show(this.root, f !== null)
    if (!f) return
    setPortrait(this.pic, f)
    setText(this.name, f.name)
    setBar(this.hp, f.hp / f.maxHp, `${Math.round(f.hp)} / ${f.maxHp}`)
    setStyle(this.hp.fill, 'background', hpColor(f.team, myTeam))
    this.cast.update(f, dt)
    this.auras.update(f)
  }

  flashCast(text: string, color: string): void {
    this.cast.flash(text, color)
  }
}
