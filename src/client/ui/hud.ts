import type { SimEvent } from '../../shared/combat/events'
import { CLASSES, findAuraDef, getAbility } from '../../shared/combat/registry'
import { SLOTS, type Slot } from '../../shared/combat/types'
import type { FighterSnap } from '../../shared/net/protocol'
import { type Bar, bar, el, setBar, setStyle, setText, show } from './dom'
import { ArenaFrame, AuraRow, CastBar, hpColor, PartyFrame, TargetFrame } from './frames'
import { abilityIcon, iconSvg } from './icons'

export interface HudView {
  me: FighterSnap | null
  fighters: FighterSnap[]
  mode: 'arena' | 'training'
  phase: 'countdown' | 'live' | 'ended'
  phaseTimer: number
  project: (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }
  hasLos: (a: FighterSnap, b: FighterSnap) => boolean
}

const FAIL_TEXT: Record<string, string> = {
  los: 'Target not in line of sight',
  range: 'Out of range',
  target: 'No target',
  cooldown: 'Not ready yet',
  resource: 'Not enough resource',
  cc: "Can't do that right now",
  lockout: 'Locked out',
  silenced: 'Silenced',
  moved: 'Stand still to cast',
}

interface FloatItem {
  node: HTMLDivElement
  x: number
  y: number
  z: number
  age: number
  life: number
  rise: number
  dx: number
  scale: number
}

interface SlotView {
  root: HTMLDivElement
  sweep: HTMLDivElement
  cd: HTMLDivElement
  name: HTMLDivElement
  key: HTMLDivElement
  abilityId: string
  wasOnCd: boolean
}

export class Hud {
  readonly root: HTMLDivElement
  private readonly hitmarker: HTMLDivElement
  private readonly error: HTMLDivElement
  private errorTimer = 0
  private readonly banner: HTMLDivElement
  private readonly vs: HTMLDivElement
  private vsKey = ''
  private readonly subBanner: HTMLDivElement
  private readonly party: PartyFrame[] = []
  private readonly partyWrap: HTMLDivElement
  private readonly arena: ArenaFrame[] = []
  private readonly arenaWrap: HTMLDivElement
  private readonly target: TargetFrame
  private readonly myCast: CastBar
  private readonly myHp: Bar
  private readonly myRes: Bar
  private readonly myBuffs: AuraRow
  private readonly myDebuffs: AuraRow
  private readonly slots = new Map<Slot, SlotView>()
  private readonly ult: HTMLDivElement
  private readonly floatLayer: HTMLDivElement
  private floats: FloatItem[] = []
  private readonly plateLayer: HTMLDivElement
  private readonly plates = new Map<
    number,
    { root: HTMLDivElement; hp: Bar; name: HTMLDivElement; cast: CastBar; auras: AuraRow }
  >()
  private readonly log: HTMLDivElement
  readonly trainingPanel: HTMLDivElement
  private classKey = ''
  private lastView: HudView | null = null

  constructor(parent: HTMLElement) {
    this.root = el('div', 'absolute inset-0 select-none', parent)

    this.plateLayer = el('div', 'absolute inset-0 overflow-hidden', this.root)
    this.floatLayer = el('div', 'absolute inset-0 overflow-hidden', this.root)

    el(
      'div',
      'crosshair',
      this.root,
      '<i style="left:-1px;top:-9px;width:2px;height:6px"></i><i style="left:-1px;top:3px;width:2px;height:6px"></i><i style="left:-9px;top:-1px;width:6px;height:2px"></i><i style="left:3px;top:-1px;width:6px;height:2px"></i><i style="left:-1px;top:-1px;width:2px;height:2px"></i>',
    )
    this.hitmarker = el(
      'div',
      'hitmarker',
      this.root,
      '<svg width="26" height="26" viewBox="0 0 26 26" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M4 4 L9 9 M22 4 L17 9 M4 22 L9 17 M22 22 L17 17"/></svg>',
    )
    this.error = el(
      'div',
      'absolute left-1/2 top-[58%] -translate-x-1/2 text-[15px] font-semibold text-rose-300 drop-shadow',
      this.root,
    )

    this.vs = el('div', 'absolute left-1/2 top-[11%] flex -translate-x-1/2 items-center gap-6', this.root)
    const bannerWrap = el('div', 'absolute left-1/2 top-[24%] -translate-x-1/2 text-center', this.root)
    this.banner = el('div', 'banner text-7xl text-zinc-50', bannerWrap)
    this.subBanner = el(
      'div',
      'mt-2 text-sm font-semibold uppercase tracking-[0.3em] text-zinc-300',
      bannerWrap,
    )

    const top = el('div', 'absolute left-1/2 top-4 -translate-x-1/2', this.root)
    this.target = new TargetFrame(top)

    this.partyWrap = el('div', 'absolute left-4 top-1/2 flex -translate-y-1/2 flex-col gap-2', this.root)
    this.arenaWrap = el('div', 'absolute right-4 top-1/2 flex -translate-y-1/2 flex-col gap-2', this.root)

    // Bottom centre: auras, cast bar, HP/resource, ability bar
    const bottom = el(
      'div',
      'absolute bottom-5 left-1/2 flex w-[520px] -translate-x-1/2 flex-col items-center gap-2',
      this.root,
    )
    const auraLine = el('div', 'flex w-full justify-between', bottom)
    this.myBuffs = new AuraRow(auraLine, 10, 26)
    this.myDebuffs = new AuraRow(auraLine, 10, 26)
    this.myDebuffs.root.classList.add('justify-end')
    const castWrap = el('div', 'w-[320px]', bottom)
    this.myCast = new CastBar(castWrap, 20, true)
    const bars = el('div', 'flex w-full flex-col gap-1', bottom)
    this.myHp = bar(bars, '#22c55e', 18)
    this.myRes = bar(bars, '#3b82f6', 8, false)
    const slotRow = el('div', 'flex gap-2', bottom)
    for (const s of SLOTS) {
      const wrap = el('div', 'flex flex-col items-center gap-1', slotRow)
      const root = el('div', 'slot', wrap)
      const sweep = el('div', 'sweep', root)
      const cd = el('div', 'cdtext', root)
      const key = el('div', 'key', root, s.toUpperCase())
      const name = el('div', 'w-[64px] truncate text-center text-[10px] font-semibold text-zinc-400', wrap)
      this.slots.set(s, { root, sweep, cd, name, key, abilityId: '', wasOnCd: false })
    }
    this.ult = el(
      'div',
      'absolute inset-x-0 bottom-0 h-[3px] bg-amber-300 origin-left',
      this.slots.get('r')?.root ?? bottom,
    )

    this.log = el(
      'div',
      'hud-panel absolute bottom-5 left-4 flex h-[200px] w-[330px] flex-col justify-end overflow-hidden px-3 py-2 font-hud text-[11px] leading-[1.45] text-zinc-300',
      this.root,
    )
    this.trainingPanel = el(
      'div',
      'hud-panel absolute right-4 top-4 w-[230px] p-3 text-[11px] text-zinc-300',
      this.root,
    )
  }

  setVisible(v: boolean): void {
    show(this.root, v)
  }

  setKeyLabels(labels: Record<Slot, string>): void {
    for (const [slot, v] of this.slots) v.key.textContent = labels[slot]
  }

  private ensureLayout(view: HudView): void {
    const me = view.me
    if (!me) return
    const allies = view.fighters.filter(
      (f) => f.team === me.team && (view.mode === 'arena' || f.control !== 'dummy' || f.dummyRole === 'ally'),
    )
    const enemies = view.fighters.filter(
      (f) => f.team !== me.team && (view.mode === 'arena' || f.control !== 'dummy'),
    )
    while (this.party.length < allies.length) this.party.push(new PartyFrame(this.partyWrap))
    while (this.arena.length < enemies.length) this.arena.push(new ArenaFrame(this.arenaWrap))
    this.party.forEach((p, i) => {
      show(p.root, i < allies.length)
    })
    this.arena.forEach((a, i) => {
      show(a.root, i < enemies.length)
    })
    show(this.log, view.mode === 'training')
    show(this.trainingPanel, view.mode === 'training')
  }

  update(view: HudView, dt: number): void {
    this.lastView = view
    this.ensureLayout(view)
    const me = view.me
    if (!me) return

    // Ability bar
    if (this.classKey !== me.cls) {
      this.classKey = me.cls
      const cls = CLASSES[me.cls]
      for (const s of SLOTS) {
        const v = this.slots.get(s)
        if (!v) continue
        const a = cls.abilities[s]
        v.abilityId = a.id
        v.root.style.setProperty('--slot-glow', s === 'c' ? '#a16207' : cls.colors.primary)
        v.root.querySelector('svg')?.remove()
        v.root.insertAdjacentHTML('afterbegin', iconSvg(abilityIcon(a), '#fafafa', 26))
        setText(v.name, a.name)
      }
    }
    const cls = CLASSES[me.cls]
    SLOTS.forEach((s, i) => {
      const v = this.slots.get(s)
      if (!v) return
      const a = cls.abilities[s]
      const cd = me.cd[i] ?? 0
      const ultLocked = a.tags.includes('ult') && me.ult < 100
      const frac = cd > 0 ? Math.min(1, cd / Math.max(0.01, a.cooldown)) : 0
      setStyle(v.sweep, '--cd', frac.toFixed(3))
      setText(v.cd, cd > 0.05 && a.cooldown >= 1 ? (cd >= 1 ? String(Math.ceil(cd)) : cd.toFixed(1)) : '')
      const lockedOut =
        me.lockout > 0 && a.school === 'spell' && ((a.castTime ?? 0) > 0 || a.channel !== undefined)
      v.root.classList.toggle('unusable', ultLocked || me.res < a.cost || lockedOut || !me.alive)
      const onCd = cd > 0.05 && a.cooldown >= 1
      if (v.wasOnCd && !onCd) {
        v.root.classList.remove('ready-flash')
        void v.root.offsetWidth
        v.root.classList.add('ready-flash')
      }
      v.wasOnCd = onCd
    })
    setStyle(this.ult, 'transform', `scaleX(${(me.ult / 100).toFixed(3)})`)
    setStyle(this.ult, 'background', me.ult >= 100 ? '#fde047' : '#a16207')

    setBar(this.myHp, me.hp / me.maxHp, `${Math.round(me.hp)} / ${me.maxHp}`)
    setBar(this.myRes, me.res / me.maxRes)
    setStyle(
      this.myRes.fill,
      'background',
      cls.resource === 'mana'
        ? 'linear-gradient(90deg,#2563eb,#60a5fa)'
        : 'linear-gradient(90deg,#ca8a04,#facc15)',
    )
    this.myCast.update(me, dt)
    this.myBuffs.update(me, (h) => !h)
    this.myDebuffs.update(me, (h) => h)

    // Party and arena frames
    const allies = view.fighters.filter(
      (f) => f.team === me.team && (view.mode === 'arena' || f.control !== 'dummy' || f.dummyRole === 'ally'),
    )
    allies.forEach((f, i) => {
      const visible = f.id === me.id || (Math.hypot(f.x - me.x, f.z - me.z) < 40 && view.hasLos(me, f))
      this.party[i]?.update(f, me.team, me.focus === f.id, visible, dt)
    })
    const enemies = view.fighters.filter(
      (f) => f.team !== me.team && (view.mode === 'arena' || f.control !== 'dummy'),
    )
    enemies.forEach((f, i) => {
      this.arena[i]?.update(f, me.team, me.target === f.id, dt)
    })

    const target = view.fighters.find((f) => f.id === me.target) ?? null
    this.target.update(target, me.team, dt)

    // Banners
    const showVs = view.mode === 'arena' && view.phase === 'countdown'
    show(this.vs, showVs)
    if (showVs) this.renderVs(view)
    if (view.mode === 'arena' && view.phase === 'countdown') {
      setText(this.banner, String(Math.max(1, Math.ceil(view.phaseTimer))))
      setText(this.subBanner, 'Gates open in')
    } else if (view.mode === 'arena' && view.phase === 'live' && view.phaseTimer < 1.1) {
      setText(this.banner, 'FIGHT')
      setText(this.subBanner, '')
    } else if (view.phase !== 'ended') {
      setText(this.banner, '')
      setText(this.subBanner, '')
    }

    this.errorTimer -= dt
    setStyle(this.error, 'opacity', this.errorTimer > 0 ? String(Math.min(1, this.errorTimer * 3)) : '0')

    this.updateFloats(view, dt)
    this.updatePlates(view, dt)
  }

  // Your team vs theirs during the gate countdown.
  private renderVs(view: HudView): void {
    const me = view.me
    if (!me) return
    const key = view.fighters.map((f) => `${f.id}${f.cls}`).join(',')
    if (key === this.vsKey) return
    this.vsKey = key
    const side = (team: 0 | 1) =>
      view.fighters
        .filter((f) => f.team === team && f.control !== 'dummy')
        .map((f) => {
          const c = CLASSES[f.cls]
          return `<div class="flex flex-col items-center gap-1"><div class="grid h-12 w-12 place-items-center rounded-full border-2 ${team === me.team ? 'border-sky-400' : 'border-rose-400'}" style="background:radial-gradient(circle at 40% 35%, ${c.colors.glow}, ${c.colors.primary} 45%, ${c.colors.secondary})"><span class="font-display text-sm font-black text-white/90">${c.name[0] ?? ''}</span></div><div class="text-xs font-semibold text-zinc-100 drop-shadow">${f.name}</div><div class="text-[10px] font-bold uppercase tracking-widest ${c.role === 'healer' ? 'text-emerald-300' : 'text-rose-300'}">${c.name}</div></div>`
        })
        .join('')
    const enemy: 0 | 1 = me.team === 0 ? 1 : 0
    this.vs.innerHTML = `<div class="flex gap-4">${side(me.team)}</div><div class="banner text-4xl text-zinc-50">VS</div><div class="flex gap-4">${side(enemy)}</div>`
  }

  setBanner(text: string, sub: string): void {
    setText(this.banner, text)
    setText(this.subBanner, sub)
  }

  hitMarker(kill: boolean): void {
    this.hitmarker.classList.remove('show')
    void this.hitmarker.offsetWidth
    this.hitmarker.querySelector('svg')?.setAttribute('stroke', kill ? '#fb7185' : 'white')
    this.hitmarker.classList.add('show')
  }

  private float(
    text: string,
    x: number,
    y: number,
    z: number,
    color: string,
    size: number,
    life = 0.9,
  ): void {
    const node = el('div', 'float-text', this.floatLayer, text)
    node.style.color = color
    node.style.fontSize = `${size}px`
    this.floats.push({ node, x, y, z, age: 0, life, rise: 1.4, dx: (Math.random() - 0.5) * 50, scale: 1 })
    if (this.floats.length > 60) {
      const old = this.floats.shift()
      old?.node.remove()
    }
  }

  private updateFloats(view: HudView, dt: number): void {
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]
      if (!f) continue
      f.age += dt
      if (f.age >= f.life) {
        f.node.remove()
        this.floats.splice(i, 1)
        continue
      }
      const p = view.project(f.x, f.y + f.age * f.rise, f.z)
      if (!p.visible) {
        f.node.style.opacity = '0'
        continue
      }
      const k = f.age / f.life
      const pop = f.age < 0.08 ? 1.4 - f.age * 5 : 1
      f.node.style.opacity = String(k > 0.7 ? (1 - k) / 0.3 : 1)
      f.node.style.transform = `translate(${(p.x + f.dx * k).toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%) scale(${pop.toFixed(2)})`
    }
  }

  private updatePlates(view: HudView, dt: number): void {
    const me = view.me
    const seen = new Set<number>()
    for (const f of view.fighters) {
      if (me && f.id === me.id) continue
      let plate = this.plates.get(f.id)
      if (!plate) {
        const root = el('div', 'nameplate', this.plateLayer)
        const name = el(
          'div',
          'mb-[2px] truncate text-center text-[11px] font-semibold text-zinc-100 drop-shadow',
          root,
        )
        const hp = bar(root, '#ef4444', 7)
        const cast = new CastBar(root, 10)
        const auras = new AuraRow(root, 6, 16)
        auras.root.classList.add('mt-[2px]', 'justify-center')
        plate = { root, hp, name, cast, auras }
        this.plates.set(f.id, plate)
      }
      seen.add(f.id)
      const p = view.project(f.x, f.y + 2.35, f.z)
      const dist = me ? Math.hypot(f.x - me.x, f.z - me.z) : 0
      const visible = p.visible && f.alive && dist < 70
      show(plate.root, visible)
      if (!visible) continue
      setStyle(plate.root, 'transform', `translate(${p.x.toFixed(1)}px, ${(p.y - 30).toFixed(1)}px)`)
      setText(plate.name, f.name)
      setBar(plate.hp, f.hp / f.maxHp)
      setStyle(plate.hp.fill, 'background', hpColor(f.team, me ? me.team : 0))
      plate.cast.update(f, dt)
      plate.auras.update(f)
      const los = me ? view.hasLos(me, f) : true
      setStyle(plate.root, 'opacity', los ? '1' : '0.45')
    }
    for (const [id, plate] of this.plates) {
      if (!seen.has(id)) {
        plate.root.remove()
        this.plates.delete(id)
      }
    }
  }

  private name(id: number): string {
    return this.lastView?.fighters.find((f) => f.id === id)?.name ?? '?'
  }

  private logLine(html: string): void {
    const line = el('div', 'truncate', this.log, html)
    void line
    while (this.log.childElementCount > 14) this.log.firstElementChild?.remove()
  }

  onEvent(e: SimEvent, myId: number): void {
    const v = this.lastView
    const training = v?.mode === 'training'
    switch (e.t) {
      case 'damage': {
        if (e.src === myId && e.dst !== myId) {
          this.float(
            String(e.amount),
            e.x,
            e.y,
            e.z,
            e.tick ? '#fde68a' : '#ffffff',
            e.tick ? 15 : e.amount >= 150 ? 28 : 20,
          )
          if (!e.tick) this.hitMarker(false)
        } else if (e.dst === myId) {
          this.float(`-${e.amount}`, e.x, e.y - 0.6, e.z, '#fb7185', 15, 0.7)
        }
        if (training) {
          const a = getAbility(e.ability)?.name ?? findAuraDef(e.ability)?.name ?? e.ability
          this.logLine(
            `<span class="text-zinc-100">${a}</span> hit ${this.name(e.dst)} <span class="text-amber-200">${e.amount}</span>${e.tick ? ' (tick)' : ''}`,
          )
        }
        break
      }
      case 'heal': {
        if (e.src === myId || e.dst === myId) {
          const target = v?.fighters.find((f) => f.id === e.dst)
          if (target)
            this.float(`+${e.amount}`, target.x, target.y + 2, target.z, '#4ade80', e.tick ? 14 : 20)
        }
        if (training) {
          const a = getAbility(e.ability)?.name ?? findAuraDef(e.ability)?.name ?? e.ability
          this.logLine(
            `<span class="text-zinc-100">${a}</span> healed ${this.name(e.dst)} <span class="text-green-300">${e.amount}</span>`,
          )
        }
        break
      }
      case 'aura': {
        if (!training) break
        const def = findAuraDef(e.aura)
        if (!def) break
        if (e.action === 'apply' || e.action === 'refresh') {
          this.logLine(
            `<span style="color:${def.color}">${def.name}</span> ${e.action === 'apply' ? 'applied to' : 'refreshed on'} ${this.name(e.dst)} ${e.duration.toFixed(1)}s${e.stacks > 1 ? ` x${e.stacks}` : ''}`,
          )
        } else if (e.action === 'break' || e.action === 'dispel') {
          this.logLine(
            `<span style="color:${def.color}">${def.name}</span> ${e.action === 'break' ? 'broken on' : 'removed from'} ${this.name(e.dst)}`,
          )
        }
        break
      }
      case 'interrupt': {
        const target = v?.fighters.find((f) => f.id === e.dst)
        if (target && (e.src === myId || e.dst === myId)) {
          this.float('INTERRUPTED!', target.x, target.y + 2.2, target.z, '#7dd3fc', 26, 1.2)
        }
        if (e.src === myId) this.hitMarker(true)
        this.target.flashCast('Interrupted', '#be123c')
        if (training)
          this.logLine(
            `<span class="text-sky-300">${this.name(e.src)} interrupted ${this.name(e.dst)}</span> (${getAbility(e.ability)?.name ?? ''})`,
          )
        break
      }
      case 'immune': {
        const target = v?.fighters.find((f) => f.id === e.dst)
        if (target && e.src === myId) this.float('IMMUNE', target.x, target.y + 2.2, target.z, '#e4e4e7', 18)
        if (training)
          this.logLine(
            `${findAuraDef(e.aura)?.name ?? e.aura}: ${this.name(e.dst)} is immune (diminishing returns)`,
          )
        break
      }
      case 'dr': {
        if (training && e.level > 0) {
          const pct = ['100%', '50%', '25%', 'immune'][Math.min(3, e.level)] ?? ''
          this.logLine(`<span class="text-zinc-400">${e.cat} DR on ${this.name(e.dst)}: next ${pct}</span>`)
        }
        break
      }
      case 'cast': {
        if (e.src === myId && e.action === 'fail' && e.reason) {
          setText(this.error, FAIL_TEXT[e.reason] ?? '')
          this.errorTimer = 1.2
        }
        if (training && e.action === 'fail' && e.reason) {
          this.logLine(
            `<span class="text-rose-300">${getAbility(e.ability)?.name ?? ''} failed: ${FAIL_TEXT[e.reason] ?? e.reason}</span>`,
          )
        }
        break
      }
      case 'death': {
        const dead = v?.fighters.find((f) => f.id === e.dst)
        if (e.src === myId && dead) {
          this.hitMarker(true)
          this.float('K.O.', dead.x, dead.y + 2.4, dead.z, '#fb7185', 34, 1.4)
        }
        if (training) this.logLine(`<span class="text-rose-400">${this.name(e.dst)} defeated</span>`)
        break
      }
      default:
        break
    }
  }
}
