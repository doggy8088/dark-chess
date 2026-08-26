import * as THREE from 'three'
import type { Color, PieceType } from '../game/types'
import {
  createBoardTexture,
  createPieceBackTexture,
  createPieceFaceTexture,
  createPieceWoodTexture,
  createTableTexture,
} from './textures'

/** Owns every shared material and texture so they are created once and disposed together. */
export class MaterialLibrary {
  readonly board: THREE.MeshStandardMaterial
  readonly boardSide: THREE.MeshStandardMaterial
  readonly table: THREE.MeshStandardMaterial
  readonly pieceBody: THREE.MeshStandardMaterial
  readonly pieceBack: THREE.MeshStandardMaterial
  private readonly faces = new Map<string, THREE.MeshStandardMaterial>()
  private readonly textures: THREE.Texture[] = []

  constructor() {
    const boardTexture = this.track(createBoardTexture())
    this.board = new THREE.MeshStandardMaterial({
      map: boardTexture,
      roughness: 0.62,
      metalness: 0.04,
    })
    this.boardSide = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#6d4a29'),
      roughness: 0.7,
      metalness: 0.03,
    })

    const tableTexture = this.track(createTableTexture())
    tableTexture.wrapS = THREE.RepeatWrapping
    tableTexture.wrapT = THREE.RepeatWrapping
    tableTexture.repeat.set(3, 3)
    this.table = new THREE.MeshStandardMaterial({
      map: tableTexture,
      roughness: 0.86,
      metalness: 0.02,
    })

    const woodTexture = this.track(createPieceWoodTexture())
    this.pieceBody = new THREE.MeshStandardMaterial({
      map: woodTexture,
      roughness: 0.42,
      metalness: 0.05,
    })

    const backTexture = this.track(createPieceBackTexture())
    this.pieceBack = new THREE.MeshStandardMaterial({
      map: backTexture,
      roughness: 0.5,
      metalness: 0.04,
    })
  }

  face(color: Color, type: PieceType): THREE.MeshStandardMaterial {
    const key = `${color}-${type}`
    let material = this.faces.get(key)
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        map: this.track(createPieceFaceTexture(color, type)),
        roughness: 0.5,
        metalness: 0.04,
      })
      this.faces.set(key, material)
    }
    return material
  }

  private track<T extends THREE.Texture>(texture: T): T {
    this.textures.push(texture)
    return texture
  }

  dispose(): void {
    for (const texture of this.textures) texture.dispose()
    this.board.dispose()
    this.boardSide.dispose()
    this.table.dispose()
    this.pieceBody.dispose()
    this.pieceBack.dispose()
    for (const material of this.faces.values()) material.dispose()
    this.faces.clear()
  }
}
