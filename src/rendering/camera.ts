import * as THREE from 'three'
import { BOARD_DEPTH, BOARD_WIDTH } from './layout'

export interface CameraLayout {
  portrait: boolean
  /** Yaw to keep piece characters upright for the current view. */
  pieceYaw: number
}

const target = new THREE.Vector3(0, 0, 0)

function fitPoints(): THREE.Vector3[] {
  const hx = BOARD_WIDTH / 2 + 0.15
  const hz = BOARD_DEPTH / 2 + 0.15
  const points: THREE.Vector3[] = []
  for (const x of [-hx, hx]) {
    for (const z of [-hz, hz]) {
      points.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 0.5, z))
    }
  }
  return points
}

const FIT_POINTS = fitPoints()

/**
 * Positions the camera for a stable, non-orbitable tabletop view.
 * Landscape looks across the short axis; portrait rotates the view 90 degrees
 * so the long axis of the board runs down the screen. The distance is solved
 * iteratively so the whole board fits inside the given margins.
 */
export function layoutCamera(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): CameraLayout {
  const aspect = width / Math.max(1, height)
  const portrait = aspect < 0.95
  const desktop = width >= 1024

  camera.aspect = aspect
  camera.fov = portrait ? 46 : 40

  const pitch = THREE.MathUtils.degToRad(portrait ? 64 : desktop ? 52 : 58)
  const direction = portrait
    ? new THREE.Vector3(Math.cos(pitch), Math.sin(pitch), 0)
    : new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch))

  // Screen space reserved by HUD overlays.
  const reserveX = desktop ? 315 : 8
  const reserveY = desktop ? 40 : portrait ? 132 : height < 500 ? 56 : 96
  const marginX = Math.max(0.32, 1 - (2 * reserveX) / width) * 0.97
  const marginY = Math.max(0.32, 1 - (2 * reserveY) / height) * 0.97

  let distance = 10
  for (let i = 0; i < 14; i++) {
    camera.position.copy(direction).multiplyScalar(distance).add(target)
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    let maxX = 0
    let maxY = 0
    for (const point of FIT_POINTS) {
      const projected = point.clone().project(camera)
      maxX = Math.max(maxX, Math.abs(projected.x))
      maxY = Math.max(maxY, Math.abs(projected.y))
    }
    const scale = Math.max(maxX / marginX, maxY / marginY)
    distance *= scale
    if (Math.abs(scale - 1) < 0.002) break
  }
  camera.position.copy(direction).multiplyScalar(distance).add(target)
  camera.lookAt(target)
  camera.updateProjectionMatrix()

  return { portrait, pieceYaw: portrait ? Math.PI / 2 : 0 }
}
