import * as THREE from 'three'
import { layoutCamera, type CameraLayout } from './camera'

export interface SceneContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  piecesGroup: THREE.Group
  canvas: HTMLCanvasElement
  layout: CameraLayout
  resize(): void
  render(): void
  dispose(): void
}

export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function createSceneContext(container: HTMLElement): SceneContext {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.06
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#14100d')

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)

  const hemisphere = new THREE.HemisphereLight(0xfff1dc, 0x241a12, 0.65)
  scene.add(hemisphere)

  const lowEndDevice = (navigator.hardwareConcurrency ?? 8) <= 4
  const key = new THREE.DirectionalLight(0xffe7c2, 2.6)
  key.position.set(4.5, 9, 3.5)
  key.castShadow = true
  key.shadow.mapSize.set(lowEndDevice ? 1024 : 2048, lowEndDevice ? 1024 : 2048)
  key.shadow.camera.left = -6.5
  key.shadow.camera.right = 6.5
  key.shadow.camera.top = 6.5
  key.shadow.camera.bottom = -6.5
  key.shadow.camera.near = 2
  key.shadow.camera.far = 22
  key.shadow.bias = -0.0004
  key.shadow.radius = 4
  scene.add(key)

  const fill = new THREE.DirectionalLight(0xbcd0ef, 0.55)
  fill.position.set(-5, 6, -4)
  scene.add(fill)

  const piecesGroup = new THREE.Group()
  piecesGroup.name = 'pieces'
  scene.add(piecesGroup)

  const context: SceneContext = {
    renderer,
    scene,
    camera,
    piecesGroup,
    canvas: renderer.domElement,
    layout: { portrait: false, pieceYaw: 0 },
    resize() {
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === 0 || height === 0) return
      renderer.setSize(width, height)
      context.layout = layoutCamera(camera, width, height)
    },
    render() {
      renderer.render(scene, camera)
    },
    dispose() {
      renderer.dispose()
      renderer.domElement.remove()
    },
  }

  context.resize()
  return context
}
