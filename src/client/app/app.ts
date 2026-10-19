import { PLAYABLE } from '../../shared/combat/registry'
import type { ClassId } from '../../shared/combat/types'
import { buildArena } from '../../shared/sim/layout'
import { Audio } from '../core/audio'
import { Input } from '../core/input'
import { type Quality, Renderer } from '../core/renderer'
import { models } from '../render/models'
import { renderThumbnails } from '../render/thumbs'
import { type ThemeId, WorldView } from '../render/world'
import { Session } from '../session'
import { Hud } from '../ui/hud'
import { ClassPickScreen, PauseScreen, ResultsScreen, TitleScreen } from '../ui/screens'
import { buildArenaMatch, buildTrainingMatch } from './matchmaker'
import { difficultyFor, loadSettings, type Settings, saveSettings } from './settings'
import { TrainingControls } from './training'

type State = 'title' | 'pick' | 'match' | 'results'

export class App {
  readonly renderer: Renderer
  readonly input: Input
  readonly audio = new Audio()
  readonly hud: Hud
  private readonly title: TitleScreen
  private readonly pick: ClassPickScreen
  private readonly results: ResultsScreen
  private readonly pause: PauseScreen
  private readonly training: TrainingControls
  private state: State = 'title'
  session: Session | null = null
  private menu: WorldView | null = null
  private menuTime = 0
  private settings: Settings
  private theme: ThemeId = 'sky'
  private pickMode: 'arena' | 'training' = 'arena'
  private endTimer = 0
  private resultShown = false
  private readonly lag: { lagMs: number; jitterMs: number }

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.settings = loadSettings()
    this.renderer = new Renderer(canvas)
    this.renderer.setQuality(this.settings.quality)
    this.input = new Input(canvas)
    this.input.sensitivity = this.settings.sensitivity
    this.hud = new Hud(ui)
    this.hud.setVisible(false)
    this.title = new TitleScreen(ui)
    this.pick = new ClassPickScreen(ui)
    this.pick.setVisible(false)
    this.results = new ResultsScreen(ui)
    this.results.setVisible(false)
    this.pause = new PauseScreen(ui)
    this.pause.setVisible(false)
    this.training = new TrainingControls(this.hud.trainingPanel, this)

    const params = new URLSearchParams(location.search)
    this.lag = { lagMs: Number(params.get('lag') ?? 0), jitterMs: Number(params.get('jitter') ?? 0) }

    this.title.setClass(this.settings.lastClass)
    this.title.play.addEventListener('click', () => this.onPlay())
    this.title.change.addEventListener('click', () => this.openPick('arena'))
    this.title.training.addEventListener('click', () => {
      this.audio.unlock()
      if (this.settings.lastClass) this.startTraining(this.settings.lastClass)
      else this.openPick('training')
    })
    this.pick.onPick = (id) => this.choose(id)
    this.pick.back.addEventListener('click', () => this.goTitle())
    this.pick.trainingLink.addEventListener('click', () => this.openPick('training'))
    this.pause.resume.addEventListener('click', () => this.input.lock())
    this.pause.leave.addEventListener('click', () => this.goTitle())
    this.pause.sens.value = String(this.settings.sensitivity)
    this.pause.sens.addEventListener('input', () => {
      this.input.sensitivity = Number(this.pause.sens.value)
      this.settings.sensitivity = this.input.sensitivity
      saveSettings(this.settings)
    })
    this.pause.quality.value = this.settings.quality
    this.pause.quality.addEventListener('change', () => {
      const q = this.pause.quality.value as Quality
      this.renderer.setQuality(q)
      this.settings.quality = q
      saveSettings(this.settings)
    })
    canvas.addEventListener('click', () => {
      if (this.state === 'match' && !this.input.locked) this.input.lock()
    })
    this.input.onLockChange = (locked) => {
      if (this.state === 'match') this.pause.setVisible(!locked)
    }
    this.input.onKey = (code) => this.onKey(code)

    this.showMenu()
    // Creature models stream in behind the title; thumbnails follow them.
    models.onLoaded = () => this.session?.refreshModels()
    void models.loadAll().then(() => {
      const thumbs = renderThumbnails()
      for (const [id, url] of thumbs) this.pick.setThumb(id, url)
    })
  }

  private showMenu(): void {
    if (this.menu) return
    this.menu = new WorldView(
      this.renderer.scene,
      buildArena(),
      this.theme,
      this.renderer.quality === 'low' ? 0 : 1024,
    )
    const t = this.menu.theme
    this.renderer.setPost({
      bloomStrength: t.bloom.strength,
      bloomThreshold: t.bloom.threshold,
      exposure: t.exposure,
    })
    this.menu.setGates(true)
  }

  private hideMenu(): void {
    this.menu?.dispose()
    this.menu = null
  }

  private onKey(code: string): void {
    if (this.state === 'title' && (code === 'Enter' || code === 'Space')) this.onPlay()
    else if (this.state === 'pick') {
      const n = Number(code.replace('Digit', ''))
      if (n >= 1 && n <= PLAYABLE.length) {
        const id = PLAYABLE[n - 1]
        if (id) this.choose(id)
      }
      if (code === 'KeyT') this.openPick('training')
      if (code === 'Escape') this.goTitle()
    } else if (this.state === 'results' && code === 'Space') this.nextMatch()
    else if (this.state === 'results' && code === 'Escape') this.goTitle()
    else if (this.state === 'match' && this.session?.mode === 'training') this.training.onKey(code)
  }

  private onPlay(): void {
    this.audio.unlock()
    this.audio.play('click')
    if (this.settings.lastClass) this.startArena(this.settings.lastClass)
    else this.openPick('arena')
  }

  private openPick(mode: 'arena' | 'training'): void {
    this.audio.unlock()
    this.pickMode = mode
    this.state = 'pick'
    this.title.setVisible(false)
    this.pick.setVisible(true)
  }

  private choose(id: ClassId): void {
    this.audio.play('click')
    this.settings.lastClass = id
    saveSettings(this.settings)
    this.title.setClass(id)
    if (this.pickMode === 'training') this.startTraining(id)
    else this.startArena(id)
  }

  private beginSession(session: Session): void {
    this.session?.dispose()
    this.hideMenu()
    this.session = session
    this.state = 'match'
    this.resultShown = false
    this.endTimer = 0
    this.title.setVisible(false)
    this.pick.setVisible(false)
    this.results.setVisible(false)
    this.pause.setVisible(false)
    this.hud.setVisible(true)
    this.hud.setBanner('', '')
    this.input.lock()
  }

  startArena(id: ClassId): void {
    const cfg = buildArenaMatch(id, difficultyFor(this.settings))
    this.beginSession(
      new Session(this.renderer, this.input, this.hud, this.audio, {
        config: cfg,
        myId: 1,
        theme: this.theme,
        ...this.lag,
      }),
    )
  }

  startTraining(id: ClassId): void {
    this.beginSession(
      new Session(this.renderer, this.input, this.hud, this.audio, {
        config: buildTrainingMatch(id),
        myId: 1,
        theme: this.theme,
        ...this.lag,
      }),
    )
    this.training.reset()
  }

  toggleWorld(): void {
    this.theme = this.theme === 'sky' ? 'caldera' : 'sky'
    const cls = this.session?.me()?.cls ?? this.settings.lastClass ?? 'cindrake'
    if (this.session?.mode === 'training') this.startTraining(cls === 'dummy' ? 'cindrake' : cls)
  }

  private nextMatch(): void {
    this.theme = this.theme === 'sky' ? 'caldera' : 'sky'
    this.startArena(this.settings.lastClass ?? 'cindrake')
  }

  private goTitle(): void {
    this.session?.dispose()
    this.session = null
    this.input.unlock()
    this.state = 'title'
    this.hud.setVisible(false)
    this.pick.setVisible(false)
    this.results.setVisible(false)
    this.pause.setVisible(false)
    this.title.setVisible(true)
    this.showMenu()
  }

  frame(dt: number): void {
    const s = this.session
    if (s) {
      s.update(dt)
      const snap = s.latest
      if (snap && s.mode === 'arena' && snap.phase === 'ended') {
        this.endTimer += dt
        s.timeScale = this.endTimer < 1.2 ? 0.3 : 1
        if (!this.resultShown && this.endTimer > 1.2) this.showResults()
        if (this.resultShown) {
          const left = Math.max(0, 6 - this.endTimer)
          this.results.setHint(`Space: next match ${left > 0 ? `(${Math.ceil(left)})` : ''}   ·   Esc: menu`)
          if (left <= 0) this.nextMatch()
        }
      }
    } else if (this.menu) {
      this.menuTime += dt
      const t = this.menuTime * 0.06
      const cam = this.renderer.camera
      cam.position.set(Math.cos(t) * 34, 13 + Math.sin(t * 0.7) * 2, Math.sin(t) * 34)
      cam.lookAt(0, 2, 0)
      if (cam.fov !== 60) {
        cam.fov = 60
        cam.updateProjectionMatrix()
      }
      this.menu.update(dt, this.menuTime)
    }
    this.renderer.render(dt)
  }

  private showResults(): void {
    const s = this.session
    const snap = s?.latest
    if (!s || !snap) return
    this.resultShown = true
    const me = s.me()
    const myTeam = me?.team ?? 0
    const win = snap.winner === myTeam
    this.settings.matches++
    this.settings.streak = win
      ? Math.max(1, this.settings.streak + 1)
      : Math.min(-1, this.settings.streak - 1)
    saveSettings(this.settings)
    this.audio.play(win ? 'victory' : 'defeat')
    this.results.showResult(win, snap.fighters, myTeam, s.myId)
    this.results.setVisible(true)
    this.state = 'results'
    this.input.unlock()
    this.pause.setVisible(false)
  }
}
