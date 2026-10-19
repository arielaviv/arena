import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import {
  Color,
  HalfFloatType,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'

export type Quality = 'high' | 'medium' | 'low'

export interface PostSettings {
  bloomStrength: number
  bloomThreshold: number
  exposure: number
}

// WebGL renderer + a single merged post pass (bloom, ACES tone mapping, vignette).
export class Renderer {
  readonly gl: WebGLRenderer
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(78, 1, 0.08, 900)
  quality: Quality = 'high'
  baseFov = 78
  // Fine-grained switches behind the presets (also used by auto-quality).
  options = { msaa: 0, smaa: true, bloom: true, bloomScale: 1, shadows: true, dpr: 1.5 }
  private composer: EffectComposer | null = null
  private bloom: BloomEffect | null = null
  private exposure = 1

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    })
    this.gl.outputColorSpace = SRGBColorSpace
    this.gl.toneMapping = NoToneMapping
    this.gl.shadowMap.enabled = true
    this.gl.shadowMap.type = PCFShadowMap
    this.scene.background = new Color('#0c0c0f')
    this.setQuality('high')
    window.addEventListener('resize', () => this.resize())
    this.resize()
  }

  private buildComposer(): void {
    this.composer?.dispose()
    const composer = new EffectComposer(this.gl, {
      frameBufferType: HalfFloatType,
      multisampling: this.options.msaa,
    })
    composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: 0.6,
      luminanceThreshold: 0.82,
      luminanceSmoothing: 0.2,
      radius: 0.7,
      resolutionScale: this.options.bloomScale,
    })
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
    const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.45 })
    const effects = this.options.bloom ? [this.bloom, tone, vignette] : [tone, vignette]
    composer.addPass(new EffectPass(this.camera, ...effects))
    if (this.options.smaa)
      composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM })))
    this.composer = composer
    this.gl.toneMappingExposure = this.exposure
  }

  setPost(p: PostSettings): void {
    if (this.bloom) {
      this.bloom.intensity = p.bloomStrength
      this.bloom.luminanceMaterial.threshold = p.bloomThreshold
    }
    this.exposure = p.exposure
    this.gl.toneMappingExposure = p.exposure
  }

  setQuality(q: Quality): void {
    this.quality = q
    this.options =
      q === 'high'
        ? { msaa: 0, smaa: true, bloom: true, bloomScale: 1, shadows: true, dpr: 1.5 }
        : q === 'medium'
          ? { msaa: 0, smaa: true, bloom: true, bloomScale: 0.5, shadows: true, dpr: 1.25 }
          : { msaa: 0, smaa: false, bloom: false, bloomScale: 0.5, shadows: false, dpr: 1 }
    this.configure(this.options)
  }

  configure(o: Renderer['options']): void {
    this.options = o
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.dpr))
    this.gl.shadowMap.enabled = o.shadows
    this.buildComposer()
    this.resize()
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.gl.setSize(w, h, false)
    this.composer?.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  render(dt = 0.016): void {
    if (this.composer) this.composer.render(dt)
    else this.gl.render(this.scene, this.camera)
  }
}
