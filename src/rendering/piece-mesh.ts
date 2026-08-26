import * as THREE from 'three'
import type { Piece } from '../game/types'
import type { MaterialLibrary } from './materials'
import { PIECE_BEVEL, PIECE_HEIGHT, PIECE_RADIUS } from './layout'

/**
 * Builds beveled coin-shaped piece meshes. Geometry is shared across all 32
 * pieces; only the face material differs per (color, type).
 */
export class PieceMeshFactory {
  private readonly bodyGeometry: THREE.LatheGeometry
  private readonly faceGeometry: THREE.CircleGeometry
  private readonly backGeometry: THREE.CircleGeometry

  constructor(private readonly materials: MaterialLibrary) {
    const h = PIECE_HEIGHT / 2
    const r = PIECE_RADIUS
    const b = PIECE_BEVEL
    const profile = [
      new THREE.Vector2(0, -h),
      new THREE.Vector2(r - b, -h),
      new THREE.Vector2(r - b * 0.28, -h + b * 0.28),
      new THREE.Vector2(r, -h + b),
      new THREE.Vector2(r, h - b),
      new THREE.Vector2(r - b * 0.28, h - b * 0.28),
      new THREE.Vector2(r - b, h),
      new THREE.Vector2(0, h),
    ]
    this.bodyGeometry = new THREE.LatheGeometry(profile, 48)

    this.faceGeometry = new THREE.CircleGeometry(r - b * 0.7, 48)
    this.faceGeometry.rotateX(-Math.PI / 2)
    this.faceGeometry.translate(0, h + 0.0015, 0)

    this.backGeometry = new THREE.CircleGeometry(r - b * 0.7, 48)
    this.backGeometry.rotateX(Math.PI / 2)
    this.backGeometry.translate(0, -h - 0.0015, 0)
  }

  create(piece: Piece): THREE.Group {
    const group = new THREE.Group()
    group.name = `piece:${piece.id}`

    const body = new THREE.Mesh(this.bodyGeometry, this.materials.pieceBody)
    body.castShadow = true
    body.receiveShadow = true

    const face = new THREE.Mesh(this.faceGeometry, this.materials.face(piece.color, piece.type))
    const back = new THREE.Mesh(this.backGeometry, this.materials.pieceBack)

    for (const mesh of [body, face, back]) {
      mesh.userData.pieceId = piece.id
      group.add(mesh)
    }
    group.userData.pieceId = piece.id
    return group
  }

  dispose(): void {
    this.bodyGeometry.dispose()
    this.faceGeometry.dispose()
    this.backGeometry.dispose()
  }
}

/**
 * Piece orientation helpers. A face-down piece is rotated PI around Z so its
 * character faces the board; `yaw` keeps text upright for the current camera.
 */
export function pieceQuaternion(faceUp: boolean, yaw: number): THREE.Quaternion {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  if (!faceUp) {
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)
    q.multiply(flip)
  }
  return q
}
