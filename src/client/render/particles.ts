import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from 'three'

const MAX = 4096

// One pooled, additive particle system for every burst in the game.
export class Particles {
  readonly points: Points
  private readonly pos = new Float32Array(MAX * 3)
  private readonly vel = new Float32Array(MAX * 3)
  private readonly col = new Float32Array(MAX * 3)
  private readonly size = new Float32Array(MAX)
  private readonly life = new Float32Array(MAX)
  private readonly maxLife = new Float32Array(MAX)
  private readonly drag = new Float32Array(MAX)
  private readonly grav = new Float32Array(MAX)
  private readonly alpha = new Float32Array(MAX)
  private next = 0
  private readonly geo = new BufferGeometry()
  private readonly c = new Color()

  constructor() {
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3))
    this.geo.setAttribute('aColor', new BufferAttribute(this.col, 3))
    this.geo.setAttribute('aSize', new BufferAttribute(this.size, 1))
    this.geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1))
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          float core = smoothstep(0.18, 0.0, d);
          gl_FragColor = vec4(vColor * (1.0 + core * 0.5), a * vAlpha);
        }
      `,
    })
    this.points = new Points(this.geo, mat)
    this.points.frustumCulled = false
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: string,
    size: number,
    life: number,
    drag = 2,
    gravity = 0,
  ): void {
    const i = this.next
    this.next = (this.next + 1) % MAX
    this.pos[i * 3] = x
    this.pos[i * 3 + 1] = y
    this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx
    this.vel[i * 3 + 1] = vy
    this.vel[i * 3 + 2] = vz
    this.c.set(color)
    this.col[i * 3] = this.c.r
    this.col[i * 3 + 1] = this.c.g
    this.col[i * 3 + 2] = this.c.b
    this.size[i] = size
    this.life[i] = life
    this.maxLife[i] = life
    this.drag[i] = drag
    this.grav[i] = gravity
  }

  burst(
    x: number,
    y: number,
    z: number,
    color: string,
    count: number,
    speed: number,
    size: number,
    life: number,
    gravity = 0,
  ): void {
    for (let k = 0; k < count; k++) {
      const u = Math.random() * 2 - 1
      const a = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      const sp = speed * (0.35 + Math.random() * 0.65)
      this.emit(
        x,
        y,
        z,
        Math.cos(a) * s * sp,
        u * sp,
        Math.sin(a) * s * sp,
        color,
        size * (0.6 + Math.random() * 0.8),
        life * (0.6 + Math.random() * 0.6),
        3,
        gravity,
      )
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i]! <= 0) {
        this.alpha[i] = 0
        continue
      }
      const l = (this.life[i] as number) - dt
      this.life[i] = l
      const k = Math.exp(-(this.drag[i] as number) * dt)
      this.vel[i * 3] = (this.vel[i * 3] as number) * k
      this.vel[i * 3 + 1] = (this.vel[i * 3 + 1] as number) * k - (this.grav[i] as number) * dt
      this.vel[i * 3 + 2] = (this.vel[i * 3 + 2] as number) * k
      this.pos[i * 3] = (this.pos[i * 3] as number) + (this.vel[i * 3] as number) * dt
      this.pos[i * 3 + 1] = (this.pos[i * 3 + 1] as number) + (this.vel[i * 3 + 1] as number) * dt
      this.pos[i * 3 + 2] = (this.pos[i * 3 + 2] as number) + (this.vel[i * 3 + 2] as number) * dt
      const t = Math.max(0, l / (this.maxLife[i] as number))
      this.alpha[i] = t < 0.3 ? t / 0.3 : 1
    }
    for (const name of ['position', 'aAlpha', 'aColor', 'aSize']) {
      const attr = this.geo.getAttribute(name)
      if (attr) attr.needsUpdate = true
    }
  }
}
