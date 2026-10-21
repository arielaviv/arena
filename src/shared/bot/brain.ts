import { findAuraDef } from '../combat/registry'
import { type AbilityDef, abilityAt, type Slot } from '../combat/types'
import { aimAtPoint } from '../sim/aim'
import { makeRayHit } from '../sim/collision'
import { CAMERA, MOVE } from '../sim/constants'
import {
  type Aura,
  type CastState,
  chestY,
  type Fighter,
  isIncapacitated,
  isRooted,
  speedMultiplier,
} from '../sim/fighter'
import { Block } from '../sim/geometry'
import { Btn, type InputCmd, SLOT_BUTTON } from '../sim/input'
import type { MatchSim } from '../sim/match'
import { Rng } from '../sim/rng'
import { type NavInfo, navInfo, type Point, waypoint } from './nav'
import {
  appliedAuras,
  type CcInfo,
  ccLeft,
  ccOf,
  cleansesMagic,
  drMult,
  EXTRA_SLOTS,
  flatDist,
  fragileCc,
  hostile,
  inRange,
  isMelee,
  isTimed,
  pct,
  pinnedFor,
  primarySpeed,
  ready,
  slotWith,
  slowed,
  standsToCast,
} from './sense'

const hit = makeRayHit()
const CC_SLOTS: readonly Slot[] = ['q', 'rmb', 'f', 'e', 'a1', 'a2', 'a3']
const EYE = 1.5
const CHEST = MOVE.height * 0.62
const RING_SAFE = 25
const PEEK_RINGS: readonly number[] = [2.5, 5, 8, 12]

interface Reaction {
  cast: CastState
  at: number // earliest time this bot acts on it
  progress: number // cast fraction to wait for before kicking
  go: boolean // whether this bot reacts at all (easier bots miss more)
}

// What the legs are doing this tick. Running intents never stand still to cast.
type Intent = 'fight' | 'support' | 'escape' | 'juke' | 'hide' | 'kite'

// Role-aware utility AI. Reads the sim, writes an InputCmd: exactly what a
// human client would send, so bots and humans share every code path.
// Difficulty (0..1) scales reaction time, aim error and how reliably the bot
// makes the good play (juking casts, trinketing, dispelling, kicking late).
export class Brain {
  private readonly rng: Rng
  private readonly skill: number
  private readonly reaction: number
  private readonly aimError: number
  private readonly lead: number
  private seq = 0
  private time = 0

  // This tick's view of the match (arrays reused between ticks)
  private nav!: NavInfo
  private readonly enemies: Fighter[] = []
  private readonly allies: Fighter[] = []
  private partner: Fighter | null = null
  private enemyHealer: Fighter | null = null

  // This tick's decision
  private press: Slot | null = null
  private intent: Intent = 'fight'

  // Read through a method so control-flow narrowing from the reset above doesn't stick.
  private currentIntent(): Intent {
    return this.intent
  }
  private readonly goal: Point = { x: 0, z: 0 }
  private readonly wp: Point = { x: 0, z: 0 }

  // Memory
  private targetId = -1
  private retarget = 0
  private strafeDir = 1
  private strafeTimer = 0
  private kick: Reaction | null = null
  private juke: Reaction | null = null
  private jukeSpot: Point | null = null
  private ccAura: Aura | null = null
  private ccSeen = 0
  private ccRoll = 0
  private dispelAura: Aura | null = null
  private dispelSeen = 0
  private dispelRoll = 0
  private readonly seen = new Map<number, number>()
  private spot: Point | null = null
  private spotTimer = 0
  private hiding = false
  private hideSince = 0
  private ownCast: CastState | null = null
  private fakeAt = -1
  private fakeCooldown = 0
  private ultSince = -1
  private readonly dodgeMemo = { id: -1, until: 0, value: false }
  private readonly peekMemo = { id: -1, until: 0, found: false, x: 0, z: 0 }
  private lastHp = -1
  private hurt = 0 // share of max health lost over roughly the last two seconds
  private readonly aim = { yaw: 0, pitch: 0 }

  constructor(
    readonly id: number,
    readonly difficulty: number,
    seed: number,
  ) {
    this.rng = new Rng(seed)
    const d = Math.max(0, Math.min(1, difficulty))
    this.skill = d
    this.reaction = 0.65 - 0.4 * d
    this.aimError = 0.07 - 0.055 * d
    this.lead = 0.4 + 0.6 * d
  }

  think(sim: MatchSim, f: Fighter, dt: number): InputCmd {
    this.time += dt
    this.seq++
    const cmd: InputCmd = { seq: this.seq, moveX: 0, moveZ: 0, yaw: f.yaw, pitch: f.pitch, buttons: 0 }
    if (!f.alive || sim.phase === 'ended') return cmd
    this.collect(sim, f)
    this.trackDamage(f, dt)
    if (sim.phase === 'countdown') {
      // Walk to the gate and wait.
      this.steerDir(sim, f, cmd, -Math.sign(f.pos.x), 0, 0.6)
      return cmd
    }
    if (this.enemies.length === 0) return cmd
    const target = this.pickTarget(sim, f, dt)
    if (!target) return cmd

    this.press = null
    this.intent = 'fight'
    this.fakeCooldown -= dt
    this.aimAt(f, target, primarySpeed(f), cmd)

    if (!f.dash) {
      this.avoidHazards(sim, f)
      if (this.intent === 'fight') this.dodgeCast(f)
      if (this.intent === 'fight') this.planMove(f, dt)
      this.decide(sim, f, target, cmd)
    }
    if (this.press) cmd.buttons |= SLOT_BUTTON[this.press]

    const intent = this.currentIntent()
    const urgent = intent === 'escape' || intent === 'juke'
    const feint = this.feint(f)
    const pressed = this.press !== null ? abilityAt(f.cls, this.press) : undefined
    const pressCast = pressed !== undefined && standsToCast(pressed)
    const casting = f.cast !== null && !f.cast.ability.mobile
    if (feint) {
      cmd.moveX = this.strafeDir
    } else if (!isIncapacitated(f) && (urgent || !(pressCast || casting))) {
      this.move(sim, f, target, cmd, dt)
    }
    return cmd
  }

  // ---------------------------------------------------------------- view

  private collect(sim: MatchSim, f: Fighter): void {
    this.nav = navInfo(sim.world)
    this.enemies.length = 0
    this.allies.length = 0
    this.partner = null
    this.enemyHealer = null
    for (const g of sim.fighters) {
      if (!g.alive) continue
      if (g.team !== f.team) {
        this.enemies.push(g)
        if (g.cls.role === 'healer' && !this.enemyHealer) this.enemyHealer = g
        continue
      }
      this.allies.push(g)
      if (g !== f && !this.partner) this.partner = g
    }
  }

  private trackDamage(f: Fighter, dt: number): void {
    if (this.lastHp >= 0 && f.hp < this.lastHp) this.hurt += (this.lastHp - f.hp) / f.maxHp
    this.hurt *= Math.exp(-dt / 2)
    this.lastHp = f.hp
  }

  private sees(a: Fighter, b: Fighter): boolean {
    if (a === b) return true
    return this.nav.sight.lineOfSight(a.pos.x, a.pos.y + EYE, a.pos.z, b.pos.x, chestY(b), b.pos.z)
  }

  // Can `a` see someone standing at (x, z)?
  private seesSpot(a: Fighter, x: number, z: number): boolean {
    return this.nav.sight.lineOfSight(a.pos.x, a.pos.y + EYE, a.pos.z, x, CHEST, z)
  }

  // Can someone standing at (x, z) see `b`?
  private spotSees(x: number, z: number, b: Fighter): boolean {
    return this.nav.sight.lineOfSight(x, EYE, z, b.pos.x, chestY(b), b.pos.z)
  }

  private noticed(id: number): boolean {
    let at = this.seen.get(id)
    if (at === undefined) {
      if (this.seen.size > 48) {
        for (const [k, t] of this.seen) if (this.time - t > 10) this.seen.delete(k)
      }
      at = this.time
      this.seen.set(id, at)
    }
    return this.time - at >= this.reaction
  }

  // Enemies attacking g: aiming at it, casting at it, or in melee reach.
  private pressureOn(g: Fighter): number {
    let n = 0
    for (const e of this.enemies) {
      if (e.target === g.id || e.cast?.targetId === g.id) n++
      else if (isMelee(e) && flatDist(e, g) < 4.5) n++
    }
    return n
  }

  private meleeFoe(f: Fighter, within: number): Fighter | null {
    let best: Fighter | null = null
    let bestD = within
    for (const e of this.enemies) {
      if (!isMelee(e)) continue
      const d = flatDist(f, e)
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return best
  }

  // An enemy that could interrupt us right now.
  private kickThreat(f: Fighter): boolean {
    for (const e of this.enemies) {
      const slot = slotWith(e, 'interrupt')
      const a = slot ? abilityAt(e.cls, slot) : undefined
      if (!slot || !a || e.cooldowns[slot] > 0 || isIncapacitated(e)) continue
      if (inRange(e, f, a) && this.sees(e, f)) return true
    }
    return false
  }

  private mostHurt(f: Fighter, includeSelf: boolean, range: number): Fighter | null {
    let best: Fighter | null = null
    let bestPct = 1
    for (const a of this.allies) {
      if (a === f && !includeSelf) continue
      const p = pct(a)
      if (p >= bestPct) continue
      if (a !== f && (flatDist(a, f) > range || !this.sees(f, a))) continue
      best = a
      bestPct = p
    }
    return best
  }

  // ---------------------------------------------------------------- targets

  private pickTarget(sim: MatchSim, f: Fighter, dt: number): Fighter | null {
    this.retarget -= dt
    // Follow a human teammate's target when there is one.
    for (const g of sim.fighters) {
      if (g.team !== f.team || g.control !== 'human' || !g.alive) continue
      const id = g.target >= 0 ? g.target : (sim.aimOf(g.id)?.fighter ?? -1)
      const t = this.enemies.find((e) => e.id === id)
      if (t) {
        this.targetId = t.id
        return t
      }
    }
    const current = this.enemies.find((e) => e.id === this.targetId)
    if (current && this.retarget > 0 && !fragileCc(current)) return current
    this.retarget = 1.2 + this.rng.range(0, 1.2)
    const melee = isMelee(f)
    const eh = this.enemyHealer
    let best: Fighter | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const e of this.enemies) {
      let score = pct(e) * 40 + flatDist(f, e) * (melee ? 0.9 : 0.3)
      if (!this.sees(f, e)) score += 14
      // Kill the damage dealer and lock the healer down, unless the healer is easier.
      if (e.cls.role === 'healer') score += 10
      // A target its own healer cannot see is a free kill.
      if (eh && eh !== e && !this.sees(eh, e)) score -= 12
      if (fragileCc(e)) score += 60
      if (e.id === this.targetId) score -= 6
      if (score < bestScore) {
        bestScore = score
        best = e
      }
    }
    this.targetId = best ? best.id : -1
    return best
  }

  // ---------------------------------------------------------------- decisions

  private decide(sim: MatchSim, f: Fighter, target: Fighter, cmd: InputCmd): void {
    if (this.trinket(f)) return
    if (this.reflect(sim, f)) return
    if (this.interrupt(sim, f, cmd)) return
    if (f.cls.role === 'healer' && this.support(f, cmd)) return
    if (this.defend(f, target, cmd)) return
    if (this.ultimate(f, target, cmd)) return
    if (this.control(f, target, cmd)) return
    if (this.closeGap(f, target, cmd)) return
    if (this.rotation(f, target, cmd)) return
    if (this.signature(f, target, cmd)) return
    this.primary(f, target)
  }

  private running(): boolean {
    return (
      this.intent === 'escape' || this.intent === 'juke' || this.intent === 'hide' || this.intent === 'kite'
    )
  }

  // Lum Berry out of crowd control when it matters.
  private trinket(f: Fighter): boolean {
    const healer = f.cls.role === 'healer'
    let cc: Aura | null = null
    for (const a of f.auras) {
      const k = a.def.cc
      if (!k || !a.def.harmful) continue
      const counts =
        k === 'stun' || k === 'sleep' || k === 'confuse' || (k === 'silence' && healer) || k === 'root'
      if (counts && (!cc || a.remaining > cc.remaining)) cc = a
    }
    if (!cc) {
      this.ccAura = null
      return false
    }
    if (cc !== this.ccAura) {
      this.ccAura = cc
      this.ccSeen = this.time
      this.ccRoll = this.rng.next()
    }
    const c = f.cls.abilities.c
    if (!c.tags.includes('trinket') || !ready(f, c)) return false
    if (this.time - this.ccSeen < this.reaction) return false
    const hp = pct(f)
    const partnerLow = this.partner !== null && pct(this.partner) < 0.4
    const kind = cc.def.cc
    let want: boolean
    if (kind === 'sleep') {
      // Damage wakes us anyway; trinket when the team cannot wait.
      want =
        partnerLow ||
        hp < 0.3 ||
        (cc.remaining > 2 && healer && this.partner !== null && pct(this.partner) < 0.65)
    } else if (kind === 'stun' || kind === 'confuse') {
      want = hp < 0.45 || partnerLow || (cc.remaining > 2 && (hp < 0.75 || this.pressureOn(f) > 0))
    } else if (kind === 'silence') {
      want = partnerLow || hp < 0.35
    } else {
      want = hp < 0.3 && this.pressureOn(f) > 0
    }
    if (!want || this.ccRoll > 0.5 + 0.5 * this.skill) return false
    this.press = 'c'
    return true
  }

  // Kick the most valuable enemy cast: heals on a hurt target, crowd control
  // on our side, nukes on us. Better bots wait for the cast to commit.
  private interrupt(sim: MatchSim, f: Fighter, cmd: InputCmd): boolean {
    const slot = slotWith(f, 'interrupt')
    let best: Fighter | null = null
    let bestValue = 0
    for (const e of this.enemies) {
      const c = e.cast
      if (c?.ability.school !== 'spell') continue
      if (c.channel ? !c.ability.tags.includes('nuke') : !isTimed(c.ability)) continue
      const v = this.castValue(sim, f, c)
      if (v > bestValue) {
        bestValue = v
        best = e
      }
    }
    const c = best?.cast
    if (!best || !c) {
      this.kick = null
      return false
    }
    if (this.kick?.cast !== c) {
      const patient = this.skill >= 0.5
      this.kick = {
        cast: c,
        at: this.time + this.reaction + this.rng.range(0, 0.15),
        progress: c.channel ? 0 : patient ? this.rng.range(0.35, 0.7) : this.rng.range(0.05, 0.35),
        go: this.rng.chance(0.55 + 0.45 * this.skill),
      }
    }
    if (!slot || !this.kick.go || bestValue < 0.8 || this.time < this.kick.at) return false
    const a = abilityAt(f.cls, slot)
    if (!a || !ready(f, a)) return false
    const left = c.duration - c.elapsed
    if (c.elapsed / c.duration < this.kick.progress && left > 0.45) return false
    // Let our own cast land first when it finishes in time.
    const own = f.cast
    if (own && !own.channel && own.duration - own.elapsed < left - 0.1) return false
    if (!inRange(f, best, a) || !this.sees(f, best)) return false
    this.aimAt(f, best, 0, cmd)
    this.press = slot
    return true
  }

  private castValue(sim: MatchSim, f: Fighter, c: CastState): number {
    const a = c.ability
    const t = c.targetId >= 0 ? sim.byId(c.targetId) : undefined
    const tp = t ? pct(t) : 1
    if (a.tags.includes('heal')) return tp < 0.85 ? 1 + (1 - tp) * 2 : 0.4
    const onUs = t !== undefined && t.team === f.team
    if (a.tags.includes('cc')) {
      if (!onUs || !t) return 0.5
      return t.cls.role === 'healer' || (this.partner !== null && pct(this.partner) < 0.5) ? 1.6 : 1.1
    }
    if (a.tags.includes('nuke')) return onUs ? 1 + (1 - tp) : 0.9
    return 0.3
  }

  // Break line of sight behind a pillar before a targeted cast on us lands.
  private dodgeCast(f: Fighter): void {
    let threat: Fighter | null = null
    let left = Number.POSITIVE_INFINITY
    for (const e of this.enemies) {
      const c = e.cast
      if (!c || c.channel || c.targetId !== f.id || c.ability.target.kind !== 'targeted') continue
      const l = c.duration - c.elapsed
      if (l < left) {
        left = l
        threat = e
      }
    }
    const c = threat?.cast
    if (!threat || !c) {
      this.juke = null
      this.jukeSpot = null
      return
    }
    if (this.juke?.cast !== c) {
      this.juke = {
        cast: c,
        at: this.time + this.reaction * this.rng.range(0.8, 1.2),
        progress: 0,
        go: this.rng.chance(0.3 + 0.65 * this.skill),
      }
      this.jukeSpot = null
    }
    if (!this.juke.go || this.time < this.juke.at || isRooted(f)) return
    // Finish a cast of our own that lands first if there is still time to hide
    // afterwards, or if it is a heal someone is about to die without.
    const own = f.cast
    if (own && !own.channel) {
      const ownLeft = own.duration - own.elapsed
      if (ownLeft < left - 0.05) {
        const saving = own.ability.tags.includes('heal') && this.partner !== null && pct(this.partner) < 0.4
        if (saving || this.coverFrom(f, threat, left - ownLeft) !== null) return
      }
    }
    if (!this.jukeSpot || this.seesSpot(threat, this.jukeSpot.x, this.jukeSpot.z)) {
      this.jukeSpot = this.coverFrom(f, threat, left)
    }
    if (!this.jukeSpot) return
    this.intent = 'juke'
    this.goal.x = this.jukeSpot.x
    this.goal.z = this.jukeSpot.z
  }

  private runSpeed(f: Fighter): number {
    return MOVE.runSpeed * (f.cls.speedMult ?? 1) * speedMultiplier(f)
  }

  // Nearest pillar spot the threat cannot see that we can reach in time.
  private coverFrom(f: Fighter, threat: Fighter, timeLeft: number): Point | null {
    const speed = this.runSpeed(f)
    let best: Point | null = null
    let bestCost = Number.POSITIVE_INFINITY
    for (const s of this.nav.spots) {
      if (Math.hypot(s.x, s.z) > RING_SAFE || this.seesSpot(threat, s.x, s.z)) continue
      const len = waypoint(this.nav, f.pos.x, f.pos.z, s.x, s.z, this.wp)
      if (len / speed + 0.1 > timeLeft) continue
      let cost = len
      for (const e of this.enemies) if (e !== threat && this.seesSpot(e, s.x, s.z)) cost += 4
      if (cost < bestCost) {
        bestCost = cost
        best = s
      }
    }
    return best
  }

  // Could g duck behind a pillar before a cast from `from` lands? Mirrors the
  // juke a dodging bot makes, so casters save long casts for targets caught in
  // the open or pinned down, and keep up instant pressure otherwise.
  private canDodge(g: Fighter, from: Fighter, castTime: number): boolean {
    const free = castTime - 0.35 - pinnedFor(g)
    if (free <= 0) return false
    const memo = this.dodgeMemo
    if (memo.id === g.id && this.time < memo.until) return memo.value
    const budget = free * this.runSpeed(g)
    let value = false
    for (const s of this.nav.spots) {
      if (Math.hypot(s.x - g.pos.x, s.z - g.pos.z) > budget || this.seesSpot(from, s.x, s.z)) continue
      if (waypoint(this.nav, g.pos.x, g.pos.z, s.x, s.z, this.wp) <= budget) {
        value = true
        break
      }
    }
    // Weaker bots misjudge it now and then.
    if (value && this.rng.chance(0.25 * (1 - this.skill))) value = false
    memo.id = g.id
    memo.until = this.time + 0.3
    memo.value = value
    return value
  }

  // Step out of enemy ground effects (Sleep Powder clouds, Eruption telegraphs).
  private avoidHazards(sim: MatchSim, f: Fighter): void {
    let ax = 0
    let az = 0
    let worst = 0
    const consider = (id: number, x: number, z: number, reach: number) => {
      if (!this.noticed(id)) return
      const dx = f.pos.x - x
      const dz = f.pos.z - z
      const d = Math.hypot(dx, dz)
      if (d >= reach) return
      const w = (reach - d) / reach
      ax += (d > 1e-3 ? dx / d : -f.pos.x) * w
      az += (d > 1e-3 ? dz / d : -f.pos.z) * w
      worst = Math.max(worst, reach - d)
    }
    for (const h of sim.hazards) {
      if (!hostile(f, h.team, h.def.side) || (h.def.oncePerTarget && h.hit.includes(f.id))) continue
      consider(h.id, h.x, h.z, h.def.radius + MOVE.radius + 0.6)
    }
    for (const d of sim.delayed) {
      if (d.follow || !hostile(f, d.team, d.side)) continue
      consider(d.id, d.x, d.z, d.radius + MOVE.radius + 0.8)
    }
    if (worst <= 0) return
    const l = Math.hypot(ax, az) || 1
    this.intent = 'escape'
    this.goal.x = f.pos.x + (ax / l) * (worst + 1.5)
    this.goal.z = f.pos.z + (az / l) * (worst + 1.5)
  }

  private dangerAt(sim: MatchSim, f: Fighter, x: number, z: number): boolean {
    for (const h of sim.hazards) {
      if (!hostile(f, h.team, h.def.side) || (h.def.oncePerTarget && h.hit.includes(f.id))) continue
      if (Math.hypot(x - h.x, z - h.z) < h.def.radius + MOVE.radius + 0.6) return true
    }
    for (const d of sim.delayed) {
      if (d.follow || !hostile(f, d.team, d.side)) continue
      if (Math.hypot(x - d.x, z - d.z) < d.radius + MOVE.radius + 0.8) return true
    }
    return false
  }

  // Healer: dispel, team ultimate, heal over time, big heal, free heals.
  private support(f: Fighter, cmd: InputCmd): boolean {
    const ab = f.cls.abilities
    const p = this.partner
    if (p && this.dispelPartner(f, p, cmd)) return true

    const low = this.mostHurt(f, true, 40)
    const lowPct = low ? pct(low) : 1
    if (this.teamUlt(f, lowPct)) return true
    if (!low) return false

    const pressure = this.pressureOn(low)
    const e = ab.e
    if (e.tags.includes('heal') && ready(f, e) && !this.hasOwnHot(low, f)) {
      // Save a cleanse for crowd control unless the ally needs it now.
      const saveForCc = cleansesMagic(e) && p !== null && this.enemyCcReady() && lowPct > 0.55
      const dot = this.harmfulDots(low) >= 2
      if (!saveForCc && (lowPct < 0.5 || (pressure > 0 && lowPct < 0.9) || (dot && lowPct < 0.95))) {
        this.aimAtAlly(f, low, cmd)
        this.press = 'e'
        return true
      }
    }

    if (this.supportExtras(f, low, lowPct, cmd)) return true

    const rmb = ab.rmb
    if (rmb.tags.includes('heal') && ready(f, rmb) && !this.running()) {
      const threshold = pressure > 0 ? 0.8 : 0.68
      if (lowPct < threshold) {
        this.aimAtAlly(f, low, cmd)
        this.press = 'rmb'
        return true
      }
    }

    // Free heals from a primary that heals allies (Pollen Puff).
    const lmb = ab.lmb
    if (lmb.tags.includes('heal') && ready(f, lmb)) {
      const other = this.mostHurt(f, false, lmb.target.kind === 'projectile' ? lmb.target.range * 0.8 : 20)
      if (other && pct(other) < 0.92) {
        this.aimAt(f, other, primarySpeed(f), cmd)
        this.press = 'lmb'
        return true
      }
    }
    return false
  }

  private dispelPartner(f: Fighter, p: Fighter, cmd: InputCmd): boolean {
    let cc: Aura | null = null
    for (const a of p.auras) {
      if (a.def.harmful && a.def.cc && a.def.dispel === 'magic' && (!cc || a.remaining > cc.remaining)) cc = a
    }
    if (!cc) {
      this.dispelAura = null
      return false
    }
    if (cc !== this.dispelAura) {
      this.dispelAura = cc
      this.dispelSeen = this.time
      this.dispelRoll = this.rng.next()
    }
    if (this.time - this.dispelSeen < this.reaction * 0.8 || cc.remaining < 0.5) return false
    if (this.dispelRoll > 0.55 + 0.45 * this.skill) return false
    // A rooted caster can still fight; free melee partners and anyone in trouble.
    if (cc.def.cc === 'root' && !isMelee(p) && pct(p) > 0.5) return false
    if (flatDist(f, p) > 39 || !this.sees(f, p)) return false
    const e = f.cls.abilities.e
    if (cleansesMagic(e) && ready(f, e)) {
      this.aimAtAlly(f, p, cmd)
      this.press = 'e'
      return true
    }
    const r = f.cls.abilities.r
    if (cleansesMagic(r) && ready(f, r) && r.target.kind === 'nova' && pct(p) < 0.75) {
      if (flatDist(f, p) > r.target.radius) return false
      this.press = 'r'
      return true
    }
    return false
  }

  private teamUlt(f: Fighter, lowPct: number): boolean {
    const r = f.cls.abilities.r
    if (!r.tags.includes('heal') || !ready(f, r) || r.target.kind !== 'nova') return false
    const radius = r.target.radius
    let reach = 0
    let hurt = 0
    for (const a of this.allies) {
      if (a !== f && (flatDist(a, f) > radius || !this.sees(f, a))) continue
      reach++
      if (pct(a) < 0.6) hurt++
    }
    if (lowPct < 0.38 || (hurt >= 2 && reach >= 2)) {
      this.press = 'r'
      return true
    }
    return false
  }

  private hasOwnHot(g: Fighter, f: Fighter): boolean {
    return g.auras.some((a) => !a.def.harmful && a.def.tick?.heal !== undefined && a.source === f.id)
  }

  private harmfulDots(g: Fighter): number {
    let n = 0
    for (const a of g.auras) {
      if (a.def.harmful && a.def.tick?.damage && (a.def.dispel === 'magic' || a.def.dispel === 'poison')) {
        n += a.stacks
      }
    }
    return n
  }

  private enemyCcReady(): boolean {
    for (const e of this.enemies) {
      for (const slot of CC_SLOTS) {
        const a = abilityAt(e.cls, slot)
        if (!a?.tags.includes('cc') || e.cooldowns[slot] > 0) continue
        const info = ccOf(a)
        if (info && info.kind !== 'stun') return true
      }
    }
    return false
  }

  // Self-casts aim away from the partner so the ally-targeting cone misses it.
  private aimAtAlly(f: Fighter, g: Fighter, cmd: InputCmd): void {
    if (g !== f) {
      this.aimAt(f, g, 0, cmd)
      return
    }
    cmd.ally = f.id
    const p = this.partner
    cmd.yaw = p ? Math.atan2(f.pos.z - p.pos.z, f.pos.x - p.pos.x) : f.yaw
    cmd.pitch = 0
  }

  // Defensive cooldowns: soak bursts, dash away from melee, knock melee off.
  private defend(f: Fighter, target: Fighter, cmd: InputCmd): boolean {
    const hp = pct(f)
    const melee = this.meleeFoe(f, 7)
    const loose = melee !== null && !isIncapacitated(melee) && !isRooted(melee)
    for (const slot of ['e', 'q', 'f', 'a1', 'a2', 'a3'] as const) {
      const a = abilityAt(f.cls, slot)
      if (!a?.tags.includes('defensive') || a.tags.includes('heal') || !ready(f, a)) continue
      const t = a.target
      if (t.kind === 'self') {
        // Helpless shells are a last resort.
        const helpless = a.selfEffects?.some((e) => e.kind === 'aura' && findAuraDef(e.aura)?.noCast) ?? false
        const stuck = (isRooted(f) || slowed(f)) && isMelee(f) && flatDist(f, target) > 4
        if ((hp < (helpless ? 0.3 : 0.5) && this.hurt > 0.12) || (stuck && !helpless)) {
          this.press = slot
          return true
        }
      } else if (t.kind === 'dash') {
        if (isMelee(f)) continue
        const chased = loose && hp < 0.8 && melee !== null && flatDist(f, melee) < 4
        if ((hp < 0.4 && this.hurt > 0.1) || chased || (isRooted(f) && loose)) {
          this.dashAway(f, melee ?? target, cmd)
          this.press = slot
          return true
        }
      } else if (t.kind === 'cone') {
        // Knock a melee off us, or off a struggling partner.
        const p = this.partner
        const peel =
          p !== null && pct(p) < 0.6
            ? this.enemies.find((e) => isMelee(e) && flatDist(e, p) < 4.5)
            : undefined
        const victim = melee && loose && flatDist(f, melee) < t.range * 0.75 ? melee : peel
        if (
          victim &&
          !isIncapacitated(victim) &&
          flatDist(f, victim) < t.range * 0.85 &&
          this.sees(f, victim)
        ) {
          this.aimAt(f, victim, 0, cmd)
          this.press = slot
          return true
        }
      }
    }
    return false
  }

  private dashAway(f: Fighter, from: Fighter, cmd: InputCmd): void {
    let dx = f.pos.x - from.pos.x
    let dz = f.pos.z - from.pos.z
    const l = Math.hypot(dx, dz) || 1
    dx /= l
    dz /= l
    // Keep the dash inside the ring.
    const r = Math.hypot(f.pos.x + dx * 9, f.pos.z + dz * 9)
    if (r > RING_SAFE - 2) {
      const pr = Math.hypot(f.pos.x, f.pos.z) || 1
      dx -= (f.pos.x / pr) * 1.2
      dz -= (f.pos.z / pr) * 1.2
    }
    cmd.yaw = Math.atan2(dz, dx)
    cmd.pitch = 0
  }

  private ultimate(f: Fighter, target: Fighter, cmd: InputCmd): boolean {
    const r = f.cls.abilities.r
    if (f.ult < 100) {
      this.ultSince = -1
      return false
    }
    if (this.ultSince < 0) this.ultSince = this.time
    if (r.tags.includes('heal') || !ready(f, r) || this.running()) return false
    const held = this.time - this.ultSince
    const tp = pct(target)
    const t = r.target
    switch (t.kind) {
      case 'ground': {
        // Drop it on someone who cannot step out of it.
        let victim: Fighter | null = null
        let bestScore = 0
        for (const e of this.enemies) {
          if (Math.hypot(e.pos.x - f.pos.x, e.pos.z - f.pos.z) > t.range - 1 || !this.sees(f, e)) continue
          let score = 0
          if (isIncapacitated(e) || isRooted(e)) score = 3
          else if (e.cast && !e.cast.ability.mobile && e.cast.duration - e.cast.elapsed > 0.6) score = 2
          else if (Math.hypot(e.vel.x, e.vel.z) < 2) score = 1
          if (pct(e) < 0.45) score += 1
          for (const o of this.enemies) if (o !== e && flatDist(o, e) < t.radius) score += 1
          if (score > bestScore) {
            bestScore = score
            victim = e
          }
        }
        if (!victim || (bestScore < 2 && held < 10)) return false
        const pinned = isIncapacitated(victim) || isRooted(victim)
        const ahead = pinned ? 0 : 0.9 * this.lead
        this.aimAtGround(f, victim.pos.x + victim.vel.x * ahead, victim.pos.z + victim.vel.z * ahead, cmd)
        this.press = 'r'
        return true
      }
      case 'targeted': {
        const dot = r.tags.includes('dot')
        let victim: Fighter | null = null
        if (dot) {
          if (tp < 0.55 || (tp < 0.8 && this.enemyHealer !== null) || held > 10) victim = target
        } else {
          const eh = this.enemyHealer
          // A delayed blast that silences: on the kill target, or on its healer to stop the save.
          if (eh && eh !== target && tp < 0.4 && !isIncapacitated(eh)) victim = eh
          else if (tp < 0.65 || held > 8) victim = target
        }
        if (!victim || !inRange(f, victim, r) || !this.sees(f, victim) || fragileCc(victim)) return false
        this.aimAt(f, victim, 0, cmd)
        this.press = 'r'
        return true
      }
      case 'beam': {
        // Channelled beam with pushback: peel a melee off a hurt partner, or finish a target.
        const p = this.partner
        const peel =
          p !== null && pct(p) < 0.5 ? this.enemies.find((e) => isMelee(e) && flatDist(e, p) < 5) : undefined
        const victim = peel ?? (tp < 0.45 || held > 10 ? target : undefined)
        if (!victim || !inRange(f, victim, r) || !this.sees(f, victim) || fragileCc(victim)) return false
        if (this.meleeFoe(f, 5) && !peel) return false
        this.aimAt(f, victim, 0, cmd)
        this.press = 'r'
        return true
      }
      default:
        return false
    }
  }

  // Crowd control: lock the enemy healer down for a kill, peel for a hurt
  // ally, or stop a melee on a caster. Respects diminishing returns.
  private control(f: Fighter, target: Fighter, cmd: InputCmd): boolean {
    if (this.intent === 'escape' || this.intent === 'juke') return false
    for (const slot of CC_SLOTS) {
      const a = abilityAt(f.cls, slot)
      if (!a?.tags.includes('cc')) continue
      const info = ccOf(a)
      if (!info || !ready(f, a)) continue
      if (isTimed(a) && (this.running() || this.meleeFoe(f, 6) !== null)) continue
      const victim = this.ccVictim(f, target, a, info)
      if (!victim) continue
      this.aimAt(f, victim, a.target.kind === 'projectile' ? a.target.speed : 0, cmd)
      this.press = slot
      return true
    }
    return false
  }

  private ccVictim(f: Fighter, target: Fighter, a: AbilityDef, info: CcInfo): Fighter | null {
    const healer = f.cls.role === 'healer'
    const tp = pct(target)
    const p = this.partner
    const allyLow = Math.min(pct(f), p ? pct(p) : 1)
    const desperate = tp < 0.3 || allyLow < 0.3
    const usable = (v: Fighter | null | undefined): v is Fighter => {
      if (!v || !inRange(f, v, a) || !this.sees(f, v)) return false
      if (ccLeft(v, info.kind !== 'root') > 0.5) return false
      const m = drMult(v, info.cat)
      return m >= 1 || (m >= 0.5 && desperate)
    }
    // 1. Lock the enemy healer down while its partner is in the kill zone. A
    //    controller whose signature is the CC opens the window earlier.
    const eh = this.enemyHealer
    const opening = a.slot === 'rmb' ? 0.7 : 0.5
    if (eh && eh !== target && info.kind !== 'root' && tp < opening && usable(eh)) return eh
    // 2. Peel the enemy hurting a struggling ally. Damage-breaking CC only on
    //    someone we are not hitting.
    if (allyLow < 0.45) {
      for (const e of this.enemies) {
        if (e.cls.role === 'healer') continue
        const onAlly = (p !== null && e.target === p.id) || e.target === f.id
        if (!onAlly || (info.breaksOnDamage && e === target && !healer)) continue
        if (info.kind === 'root' && !isMelee(e)) continue
        if (usable(e)) return e
      }
    }
    // 3. Casters stop a melee that is on them (then run, so fragile CC holds).
    if (!isMelee(f)) {
      const m = this.meleeFoe(f, 8)
      if (m && (m.target === f.id || flatDist(f, m) < 5.5) && usable(m)) return m
    }
    // 4. Pin the kill target down for a long nuke it would otherwise dodge.
    const nuke = f.cls.abilities.rmb
    if (
      info.kind === 'root' &&
      a !== nuke &&
      nuke.tags.includes('nuke') &&
      isTimed(nuke) &&
      ready(f, nuke) &&
      f.resource >= nuke.cost + a.cost &&
      info.duration * drMult(target, info.cat) >= (nuke.castTime ?? 0) &&
      this.canDodge(target, f, nuke.castTime ?? 0) &&
      usable(target)
    ) {
      return target
    }
    // 5. Instant stuns stop a heal when the kick is down.
    if (eh && !isTimed(a) && !info.breaksOnDamage && eh.cast?.ability.tags.includes('heal')) {
      const kick = slotWith(f, 'interrupt')
      if ((!kick || f.cooldowns[kick] > 0) && usable(eh)) return eh
    }
    return null
  }

  // Melee: shadowstep in, unless the strike is needed to kick a heal.
  private closeGap(f: Fighter, target: Fighter, cmd: InputCmd): boolean {
    if (!isMelee(f) || this.running()) return false
    const pure = slotWith(f, 'gapCloser', 'interrupt')
    const pureA = pure ? abilityAt(f.cls, pure) : undefined
    const slot = pure && pureA && ready(f, pureA) ? pure : slotWith(f, 'gapCloser')
    const a = slot ? abilityAt(f.cls, slot) : undefined
    if (!slot || !a || !ready(f, a) || fragileCc(target)) return false
    const d = flatDist(f, target)
    if (d < 5 || !inRange(f, target, a) || !this.sees(f, target)) return false
    if (a.tags.includes('interrupt')) {
      const eh = this.enemyHealer
      if (eh && eh !== target && flatDist(f, eh) < 26 && pct(target) > 0.35) return false
    }
    this.aimAt(f, target, 0, cmd)
    this.press = slot
    return true
  }

  // Signature damage move: melee finisher or a big cast.
  private signature(f: Fighter, target: Fighter, cmd: InputCmd): boolean {
    const a = f.cls.abilities.rmb
    if (!a.tags.includes('nuke') || !ready(f, a) || fragileCc(target) || this.running()) return false
    if (!inRange(f, target, a) || !this.sees(f, target)) return false
    if (isTimed(a)) {
      // Casters do not stand still with a melee on them.
      const m = this.meleeFoe(f, 7)
      if (m && !isIncapacitated(m) && !isRooted(m)) return false
      // Spend mana freely, otherwise wait for the bonus the nuke cares about.
      let bonus = false
      for (const e of a.effects) {
        if (e.kind === 'damage' && e.bonus) {
          const aura = e.bonus.aura
          bonus = target.auras.some((x) => x.def.id === aura)
        }
      }
      if (!bonus && f.resource < f.maxResource * 0.6) return false
      if (this.canDodge(target, f, a.castTime ?? 0)) return false
      this.aimAt(f, target, 0, cmd)
    }
    this.press = 'rmb'
    return true
  }

  // Extra-bar support: instant heals over time, shields on whoever is hit.
  private supportExtras(f: Fighter, low: Fighter, lowPct: number, cmd: InputCmd): boolean {
    for (const slot of EXTRA_SLOTS) {
      const a = abilityAt(f.cls, slot)
      if (!a || !ready(f, a) || a.target.kind !== 'targeted' || a.target.side !== 'ally') continue
      if (a.tags.includes('heal')) {
        if (lowPct < 0.85 && !this.hasOwnHot(low, f)) {
          this.aimAtAlly(f, low, cmd)
          this.press = slot
          return true
        }
        continue
      }
      if (!a.tags.includes('defensive')) continue
      const shields = appliedAuras(a)
      for (const g of this.allies) {
        if (!g.alive || pct(g) > 0.8 || this.pressureOn(g) <= 0) continue
        if (g.auras.some((x) => shields.includes(x.def.id))) continue
        if (g !== f && (flatDist(f, g) > a.target.range || !this.sees(f, g))) continue
        this.aimAtAlly(f, g, cmd)
        this.press = slot
        return true
      }
    }
    return false
  }

  // Magic Coat: raise it when a spell is about to land on us.
  private reflect(sim: MatchSim, f: Fighter): boolean {
    const slot = slotWith(f, 'reflect')
    const a = slot ? abilityAt(f.cls, slot) : undefined
    if (!slot || !a || !ready(f, a)) return false
    let threat = false
    for (const e of this.enemies) {
      const c = e.cast
      if (!c || c.channel || c.targetId !== f.id || c.ability.school !== 'spell') continue
      const left = c.duration - c.elapsed
      if (left < 0.4 && c.elapsed > this.reaction) threat = true
    }
    for (const p of sim.projectiles) {
      if (p.homing !== f.id || p.ability.school !== 'spell' || p.ability.tags.includes('primary')) continue
      if (Math.hypot(p.x - f.pos.x, p.z - f.pos.z) < 9) threat = true
    }
    if (!threat || !this.rng.chance(0.35 + 0.6 * this.skill)) return false
    this.press = slot
    return true
  }

  // The extra bar in a fight: keep DoTs up, spend stacks, nuke, smoke the healer.
  private rotation(f: Fighter, target: Fighter, cmd: InputCmd): boolean {
    if (this.running()) return false
    for (const slot of EXTRA_SLOTS) {
      const a = abilityAt(f.cls, slot)
      if (!a || !ready(f, a)) continue
      const t = a.target
      if (a.tags.includes('zone') && t.kind === 'ground') {
        const eh = this.enemyHealer
        if (!eh || eh === target || pct(target) > 0.55) continue
        if (flatDist(f, eh) > t.range - 1 || !this.sees(f, eh)) continue
        this.aimAtGround(f, eh.pos.x, eh.pos.z, cmd)
        this.press = slot
        return true
      }
      if (a.tags.includes('dot')) {
        if (fragileCc(target) || !inRange(f, target, a) || !this.sees(f, target)) continue
        const ids = appliedAuras(a)
        const up = target.auras.some((x) => ids.includes(x.def.id) && x.source === f.id && x.remaining > 2)
        if (up) continue
        this.aimAt(f, target, 0, cmd)
        this.press = slot
        return true
      }
      if (a.tags.includes('finisher')) {
        if (!inRange(f, target, a) || !this.sees(f, target)) continue
        let stacks = 0
        for (const e of a.effects) {
          const aura = e.kind === 'damage' ? e.bonus?.aura : undefined
          if (aura) stacks = target.auras.find((x) => x.def.id === aura)?.stacks ?? 0
        }
        if (stacks < 3 && !(stacks >= 1 && pct(target) < 0.3)) continue
        this.aimAt(f, target, 0, cmd)
        this.press = slot
        return true
      }
      if (!a.tags.includes('nuke')) continue
      // A bonus against crowd control (Dream Eater) goes on whoever is held.
      const ccBonus = a.effects.find((e) => e.kind === 'damage' && e.bonus?.cc)
      if (ccBonus && ccBonus.kind === 'damage' && ccBonus.bonus?.cc) {
        const cc = ccBonus.bonus.cc
        const held = this.enemies.find(
          (e) => e.auras.some((x) => x.def.cc === cc) && inRange(f, e, a) && this.sees(f, e),
        )
        // Only cash in a sleep on the kill target, or when the sleep is ending.
        const sleepLeft = held ? ccLeft(held, true) : 0
        if (!held || (held !== target && sleepLeft > 1.2)) continue
        this.aimAt(f, held, 0, cmd)
        this.press = slot
        return true
      }
      if (fragileCc(target) || !inRange(f, target, a) || !this.sees(f, target)) continue
      if (t.kind === 'cone' && flatDist(f, target) > t.range * 0.8) continue
      if (isTimed(a)) {
        const m = this.meleeFoe(f, 7)
        if (m && !isIncapacitated(m) && !isRooted(m)) continue
        if (pct(target) > 0.75 && f.resource < f.maxResource * 0.6) continue
        if (this.canDodge(target, f, a.castTime ?? 0)) continue
      }
      this.aimAt(f, target, t.kind === 'projectile' ? t.speed : 0, cmd)
      this.press = slot
      return true
    }
    return false
  }

  private primary(f: Fighter, target: Fighter): void {
    const a = f.cls.abilities.lmb
    if (!ready(f, a) || fragileCc(target)) return
    if (this.running()) return
    if (!inRange(f, target, a) || !this.sees(f, target)) return
    this.press = 'lmb'
  }

  // Bait an interrupt: start a cast while a kick is ready, then step out of it.
  private feint(f: Fighter): boolean {
    const c = f.cast
    if (!c || c.channel || !isTimed(c.ability)) {
      this.ownCast = null
      return false
    }
    if (c !== this.ownCast) {
      this.ownCast = c
      this.fakeAt = -1
      const desperate = c.ability.tags.includes('heal') && this.partner !== null && pct(this.partner) < 0.35
      if (
        this.skill >= 0.5 &&
        this.fakeCooldown <= 0 &&
        !desperate &&
        this.kickThreat(f) &&
        this.rng.chance(0.1 + 0.3 * this.skill)
      ) {
        this.fakeAt = c.duration * this.rng.range(0.3, 0.5)
      }
    }
    if (this.fakeAt < 0 || c.elapsed < this.fakeAt) return false
    this.fakeAt = -1
    this.fakeCooldown = 5 + this.rng.range(0, 3)
    return true
  }

  // ---------------------------------------------------------------- movement

  // Decide where the legs go when nothing urgent is happening.
  private planMove(f: Fighter, dt: number): void {
    this.spotTimer -= dt
    const p = this.partner
    if (f.cls.role === 'healer') {
      if (!this.spot || this.spotTimer <= 0) {
        this.spot = this.supportSpot(f, p)
        this.spotTimer = 0.45 + this.rng.range(0, 0.2)
      }
      this.intent = 'support'
      this.goal.x = this.spot.x
      this.goal.z = this.spot.z
      return
    }
    // Low health: get out of every enemy's sight, staying where our healer can reach us.
    const healer = p && p.cls.role === 'healer' ? p : null
    const hp = pct(f)
    const underFire = this.hurt > 0.08
    if (
      !this.hiding &&
      healer &&
      underFire &&
      hp < (isMelee(f) ? 0.2 : 0.27) &&
      this.rng.chance(0.05 + 0.2 * this.skill)
    ) {
      this.hiding = true
      this.hideSince = this.time
      this.spotTimer = 0
    }
    if (this.hiding && (hp > 0.45 || !healer || this.time - this.hideSince > 5)) this.hiding = false
    if (this.hiding) {
      if (!this.spot || this.spotTimer <= 0) {
        this.spot = this.coverSpot(f, healer)
        this.spotTimer = 0.4
      }
      this.intent = 'hide'
      this.goal.x = this.spot.x
      this.goal.z = this.spot.z
      return
    }
    // Casters run from a melee they have pinned down.
    if (!isMelee(f)) {
      const m = this.meleeFoe(f, 9)
      if (m && (isRooted(m) || ccLeft(m, true) > 0.4)) {
        let dx = f.pos.x - m.pos.x
        let dz = f.pos.z - m.pos.z
        const l = Math.hypot(dx, dz) || 1
        dx /= l
        dz /= l
        const r = Math.hypot(f.pos.x, f.pos.z) || 1
        if (r > RING_SAFE - 4) {
          dx -= (f.pos.x / r) * 0.8
          dz -= (f.pos.z / r) * 0.8
        }
        this.intent = 'kite'
        this.goal.x = f.pos.x + dx * 6
        this.goal.z = f.pos.z + dz * 6
      }
    }
  }

  // Healer spot: in range and sight of the partner, out of enemy sight, away from melee.
  private supportSpot(f: Fighter, p: Fighter | null): Point {
    const care = 0.4 + 0.6 * this.skill
    const hpFear = pct(f) < 0.5 ? 2 : 1
    const speed = Math.max(2, this.runSpeed(f))
    const score = (x: number, z: number): number => {
      if (Math.hypot(x, z) > RING_SAFE) return Number.NEGATIVE_INFINITY
      let s = 0
      if (p) {
        const dp = Math.hypot(x - p.pos.x, z - p.pos.z)
        if (dp > 26) s -= 20 + dp
        if (!this.spotSees(x, z, p)) s -= 14
        s -= Math.abs(dp - 14) * 0.12
      }
      for (const e of this.enemies) {
        if (this.seesSpot(e, x, z)) s -= (e.cls.role === 'healer' ? 2.5 : 6) * care * hpFear
        if (isMelee(e)) {
          const d = Math.hypot(x - e.pos.x, z - e.pos.z)
          if (d < 10) s -= (10 - d) * 0.8
        }
      }
      const len = waypoint(this.nav, f.pos.x, f.pos.z, x, z, this.wp)
      s -= (len / speed) * 2
      return s
    }
    let bestX = f.pos.x
    let bestZ = f.pos.z
    let best = score(f.pos.x, f.pos.z) + 1
    if (this.spot) {
      const keep = score(this.spot.x, this.spot.z) + 1.5
      if (keep > best) {
        best = keep
        bestX = this.spot.x
        bestZ = this.spot.z
      }
    }
    const tryPoint = (x: number, z: number) => {
      const s = score(x, z)
      if (s > best) {
        best = s
        bestX = x
        bestZ = z
      }
    }
    for (const s of this.nav.spots) tryPoint(s.x, s.z)
    if (p) {
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2
        tryPoint(p.pos.x + Math.cos(ang) * 12, p.pos.z + Math.sin(ang) * 12)
      }
    }
    return { x: bestX, z: bestZ }
  }

  // Low-health cover: out of every enemy's sight, preferably still in our healer's.
  private coverSpot(f: Fighter, healer: Fighter | null): Point {
    const speed = Math.max(2, this.runSpeed(f))
    const score = (x: number, z: number): number => {
      let s = 0
      for (const e of this.enemies) if (this.seesSpot(e, x, z)) s -= e.cls.role === 'healer' ? 6 : 10
      if (healer && (!this.spotSees(x, z, healer) || Math.hypot(x - healer.pos.x, z - healer.pos.z) > 36))
        s -= 5
      const len = waypoint(this.nav, f.pos.x, f.pos.z, x, z, this.wp)
      return s - (len / speed) * 2.5
    }
    let bestX = f.pos.x
    let bestZ = f.pos.z
    let best = score(f.pos.x, f.pos.z)
    for (const s of this.nav.spots) {
      if (Math.hypot(s.x, s.z) > RING_SAFE) continue
      const v = score(s.x, s.z)
      if (v > best) {
        best = v
        bestX = s.x
        bestZ = s.z
      }
    }
    return { x: bestX, z: bestZ }
  }

  private move(sim: MatchSim, f: Fighter, target: Fighter, cmd: InputCmd, dt: number): void {
    this.strafeTimer -= dt
    if (this.strafeTimer <= 0) {
      this.strafeDir = this.rng.chance(0.5) ? 1 : -1
      this.strafeTimer = this.rng.range(0.6, 1.8)
    }
    switch (this.intent) {
      case 'escape':
      case 'juke':
      case 'hide':
      case 'kite':
        this.goTo(sim, f, cmd, target, true)
        return
      case 'support':
        this.goTo(sim, f, cmd, target, false)
        return
      case 'fight':
        this.fightMove(sim, f, target, cmd)
    }
  }

  // Walk to this.goal around pillars. Running intents face where they go so
  // they sprint; others keep aiming and strafe once they arrive.
  private goTo(sim: MatchSim, f: Fighter, cmd: InputCmd, threat: Fighter, run: boolean): void {
    const d = Math.hypot(this.goal.x - f.pos.x, this.goal.z - f.pos.z)
    if (d < 0.5) {
      if (!run) {
        const tx = threat.pos.x - f.pos.x
        const tz = threat.pos.z - f.pos.z
        const tl = Math.hypot(tx, tz) || 1
        this.steerDir(sim, f, cmd, (-tz / tl) * this.strafeDir, (tx / tl) * this.strafeDir, 0.5)
      }
      return
    }
    waypoint(this.nav, f.pos.x, f.pos.z, this.goal.x, this.goal.z, this.wp)
    let wx = this.wp.x - f.pos.x
    let wz = this.wp.z - f.pos.z
    const wl = Math.hypot(wx, wz) || 1
    wx /= wl
    wz /= wl
    if (this.intent !== 'escape' && this.dangerAt(sim, f, f.pos.x + wx * 1.5, f.pos.z + wz * 1.5)) {
      const sx = -wz * this.strafeDir
      const sz = wx * this.strafeDir
      wx = sx
      wz = sz
    }
    if (run && this.press === null) {
      cmd.yaw = Math.atan2(wz, wx)
      cmd.pitch = 0
    }
    this.steerDir(sim, f, cmd, wx, wz, d < 1.2 ? 0.6 : 1)
  }

  private fightMove(sim: MatchSim, f: Fighter, target: Fighter, cmd: InputCmd): void {
    const melee = isMelee(f)
    const tx = target.pos.x - f.pos.x
    const tz = target.pos.z - f.pos.z
    const td = Math.max(0.01, Math.hypot(tx, tz))
    const los = this.sees(f, target)
    let wx = 0
    let wz = 0
    let strafe = melee ? 0.35 : 0.8
    if (melee) {
      if (td > 2.4 || !los) {
        waypoint(this.nav, f.pos.x, f.pos.z, target.pos.x, target.pos.z, this.wp)
        const l = Math.hypot(this.wp.x - f.pos.x, this.wp.z - f.pos.z) || 1
        wx = (this.wp.x - f.pos.x) / l
        wz = (this.wp.z - f.pos.z) / l
      }
    } else {
      const a = f.cls.abilities.lmb.target
      const reach = a.kind === 'projectile' ? a.range * 0.8 : 'range' in a ? a.range * 0.9 : 20
      const preferred = Math.min(this.meleeFoe(f, 10) ? 22 : 18, reach - 2)
      const peek = !los || td > reach ? this.peekSpot(f, target, reach) : null
      if (peek) {
        // Walk to the nearest spot with a clear shot, no dancing on the way.
        waypoint(this.nav, f.pos.x, f.pos.z, peek.x, peek.z, this.wp)
        const l = Math.hypot(this.wp.x - f.pos.x, this.wp.z - f.pos.z) || 1
        wx = (this.wp.x - f.pos.x) / l
        wz = (this.wp.z - f.pos.z) / l
        strafe = 0
      } else {
        const err = Math.max(-1, Math.min(1, (td - preferred) / 4))
        wx = (tx / td) * err
        wz = (tz / td) * err
      }
    }
    wx += (-tz / td) * this.strafeDir * strafe
    wz += (tx / td) * this.strafeDir * strafe

    const r = Math.hypot(f.pos.x, f.pos.z)
    if (r > RING_SAFE && sim.mode === 'arena') {
      wx -= (f.pos.x / r) * (r - RING_SAFE) * 0.4
      wz -= (f.pos.z / r) * (r - RING_SAFE) * 0.4
    }
    const wl = Math.hypot(wx, wz)
    if (wl > 0.05 && this.dangerAt(sim, f, f.pos.x + (wx / wl) * 1.5, f.pos.z + (wz / wl) * 1.5)) {
      const sx = (-wz / wl) * this.strafeDir
      const sz = (wx / wl) * this.strafeDir
      wx = sx
      wz = sz
    }
    this.steerDir(sim, f, cmd, wx, wz, 1)

    if (melee && td > 6 && f.grounded && this.rng.chance(0.02)) cmd.buttons |= Btn.Slide
    if (!melee && f.grounded && f.cast === null && this.press === null && this.rng.chance(0.006)) {
      cmd.buttons |= Btn.Jump
    }
  }

  // Nearest spot (by walking distance) with a clear line to the target inside
  // weapon reach. Held briefly so the bot commits to one side of a pillar.
  private peekSpot(f: Fighter, target: Fighter, reach: number): Point | null {
    const memo = this.peekMemo
    if (memo.id === target.id && this.time < memo.until) {
      if (!memo.found) return null
      if (Math.hypot(memo.x - f.pos.x, memo.z - f.pos.z) > 0.6) return memo
    }
    let best = Number.POSITIVE_INFINITY
    for (const r of PEEK_RINGS) {
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2
        const x = f.pos.x + Math.cos(ang) * r
        const z = f.pos.z + Math.sin(ang) * r
        if (Math.hypot(x, z) > RING_SAFE || Math.hypot(x - target.pos.x, z - target.pos.z) > reach - 1)
          continue
        if (!this.spotSees(x, z, target)) continue
        const len = waypoint(this.nav, f.pos.x, f.pos.z, x, z, this.wp)
        if (len < best) {
          best = len
          memo.x = x
          memo.z = z
        }
      }
      if (Number.isFinite(best)) break
    }
    memo.id = target.id
    memo.until = this.time + 0.6
    memo.found = Number.isFinite(best)
    if (!memo.found) {
      // Nothing close: head for the target itself.
      memo.x = target.pos.x
      memo.z = target.pos.z
      memo.found = true
      memo.until = this.time + 0.3
    }
    return memo
  }

  // Turn a desired world direction into strafe/forward input relative to the
  // aim yaw, sidestepping anything the waypoints missed.
  private steerDir(sim: MatchSim, f: Fighter, cmd: InputCmd, wx: number, wz: number, scale: number): void {
    let len = Math.hypot(wx, wz)
    if (len < 0.05) return
    wx /= len
    wz /= len
    const probe = 1.6
    if (sim.world.raycastPrisms(f.pos.x, f.pos.y + 0.9, f.pos.z, wx, 0, wz, probe, Block.Move, hit)) {
      const left = rotate(wx, wz, 1.1)
      const right = rotate(wx, wz, -1.1)
      const leftBlocked = sim.world.raycastPrisms(
        f.pos.x,
        f.pos.y + 0.9,
        f.pos.z,
        left.x,
        0,
        left.z,
        probe,
        Block.Move,
        hit,
      )
      const pick = leftBlocked ? right : left
      wx = pick.x
      wz = pick.z
    }
    len = Math.min(1, scale)
    const c = Math.cos(cmd.yaw)
    const s = Math.sin(cmd.yaw)
    cmd.moveZ = (wx * c + wz * s) * len
    cmd.moveX = (-wx * s + wz * c) * len
  }

  // ---------------------------------------------------------------- aim

  // Selects g (enemy target or heal target) and points the crosshair at it.
  private aimAt(f: Fighter, g: Fighter, projectileSpeed: number, cmd: InputCmd): void {
    if (g.team === f.team) cmd.ally = g.id
    else cmd.target = g.id
    let tx = g.pos.x
    let ty = chestY(g)
    let tz = g.pos.z
    if (projectileSpeed > 0) {
      const d = Math.hypot(tx - f.pos.x, tz - f.pos.z)
      const tof = d / projectileSpeed
      tx += g.vel.x * tof * this.lead
      tz += g.vel.z * tof * this.lead
      ty += Math.max(0, g.vel.y) * tof * 0.3 * this.lead
    }
    aimAtPoint(f, tx, ty, tz, this.aim)
    this.applyAim(cmd)
  }

  private aimAtGround(f: Fighter, x: number, z: number, cmd: InputCmd): void {
    aimAtPoint(f, x, 0.05, z, this.aim)
    this.applyAim(cmd)
    cmd.aimX = x
    cmd.aimY = 0
    cmd.aimZ = z
  }

  private applyAim(cmd: InputCmd): void {
    cmd.yaw = this.aim.yaw + (this.rng.next() - 0.5) * this.aimError
    cmd.pitch = Math.max(
      CAMERA.pitchMin,
      Math.min(CAMERA.pitchMax, this.aim.pitch + (this.rng.next() - 0.5) * this.aimError * 0.6),
    )
  }
}

function rotate(x: number, z: number, a: number): { x: number; z: number } {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: x * c - z * s, z: x * s + z * c }
}
