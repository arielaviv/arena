import {
  ACESFilmicToneMapping,
  Color,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'

export type Quality = 'high' | 'medium' | 'low'

export class Renderer {
  readonly gl: WebGLRenderer
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(78, 1, 0.08, 900)
  quality: Quality = 'high'
  baseFov = 78

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.gl.outputColorSpace = SRGBColorSpace
    this.gl.toneMapping = ACESFilmicToneMapping
    this.gl.toneMappingExposure = 1.05
    this.gl.shadowMap.enabled = true
    this.gl.shadowMap.type = PCFShadowMap
    this.scene.background = new Color('#0c0c0f')
    this.setQuality('high')
    window.addEventListener('resize', () => this.resize())
    this.resize()
  }

  setQuality(q: Quality): void {
    this.quality = q
    const dpr = Math.min(window.devicePixelRatio || 1, q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1)
    this.gl.setPixelRatio(dpr)
    this.gl.shadowMap.enabled = q !== 'low'
    this.resize()
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.gl.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  render(): void {
    this.gl.render(this.scene, this.camera)
  }
}
