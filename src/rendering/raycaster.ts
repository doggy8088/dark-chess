import * as THREE from 'three'
import type { Position } from '../game/types'
import { BOARD_TOP, worldToCell } from './layout'

export interface PickResult {
  pieceId?: string
  cell?: Position
}

const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_TOP)

/** Converts pointer positions into picked pieces or board cells. */
export class BoardPicker {
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly planeHit = new THREE.Vector3()

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly piecesGroup: THREE.Group,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  pick(clientX: number, clientY: number): PickResult {
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const hits = this.raycaster.intersectObjects(this.piecesGroup.children, true)
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object
      while (object) {
        const pieceId = object.userData.pieceId as string | undefined
        if (pieceId) return { pieceId }
        object = object.parent
      }
    }

    if (this.raycaster.ray.intersectPlane(boardPlane, this.planeHit)) {
      const cell = worldToCell(this.planeHit.x, this.planeHit.z)
      if (cell) return { cell }
    }
    return {}
  }
}
