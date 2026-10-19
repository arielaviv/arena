import {
  ACESFilmicToneMapping,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'
import { PLAYABLE } from '../../shared/combat/registry'
import type { ClassId } from '../../shared/combat/types'
import { Avatar } from './avatar'

// Render each creature once into a transparent PNG for the class cards.
export function renderThumbnails(size = 360): Map<ClassId, string> {
  const out = new Map<ClassId, string>()
  const canvas = document.createElement('canvas')
  const gl = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
  gl.setSize(size, size, false)
  gl.outputColorSpace = SRGBColorSpace
  gl.toneMapping = ACESFilmicToneMapping
  const scene = new Scene()
  scene.add(new HemisphereLight('#fff4e6', '#3b2a4a', 1.6))
  const key = new DirectionalLight('#ffe2c0', 2.6)
  key.position.set(3, 4, 4)
  scene.add(key)
  const rim = new DirectionalLight('#9ad6ff', 1.6)
  rim.position.set(-4, 2, -3)
  scene.add(rim)
  const cam = new PerspectiveCamera(30, 1, 0.1, 50)
  cam.position.set(2.7, 1.55, 3.4)
  cam.lookAt(0, 0.95, 0)
  for (const id of PLAYABLE) {
    const av = new Avatar(id, 0, 1)
    av.update(
      0,
      {
        x: 0,
        y: 0,
        z: 0,
        yaw: -0.9,
        speed: 0,
        move: 'idle',
        casting: false,
        channel: false,
        alive: true,
        stunned: false,
        asleep: false,
      },
      0.5,
    )
    av.root.children.forEach((c) => {
      if (c.type === 'Mesh') c.visible = false
    })
    scene.add(av.root)
    gl.render(scene, cam)
    out.set(id, canvas.toDataURL('image/png'))
    scene.remove(av.root)
    av.dispose()
  }
  gl.dispose()
  return out
}
