import * as THREE from 'three'
import type { Position } from '../game/types'
import type { MaterialLibrary } from './materials'
import { BOARD_DEPTH, BOARD_THICKNESS, BOARD_TOP, BOARD_WIDTH, CELL, TABLE_TOP, cellToWorld } from './layout'

const HINT_Y = BOARD_TOP + 0.006

/**
 * Board, table, and the cell-hint overlays (selection ring, legal-move rings,
 * legal-capture diamonds, invalid-cell flash). Hints differ by shape as well
 * as color for color-vision accessibility.
 */
export class BoardView {
  readonly group = new THREE.Group()

  private readonly selectionRing: THREE.Mesh
  private readonly moveRings: THREE.Mesh[] = []
  private readonly captureDiamonds: THREE.Mesh[] = []
  private readonly flashPlane: THREE.Mesh
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly hintMaterials: THREE.MeshBasicMaterial[] = []
  private flashRemaining = 0
  private pulseTime = 0
  private readonly reducedMotion: boolean

  constructor(materials: MaterialLibrary, reducedMotion: boolean) {
    this.reducedMotion = reducedMotion

    const boardGeometry = this.track(new THREE.BoxGeometry(BOARD_WIDTH, BOARD_THICKNESS, BOARD_DEPTH))
    const sideMaterials: THREE.Material[] = [
      materials.boardSide,
      materials.boardSide,
      materials.board,
      materials.boardSide,
      materials.boardSide,
      materials.boardSide,
    ]
    const board = new THREE.Mesh(boardGeometry, sideMaterials)
    board.position.y = BOARD_TOP - BOARD_THICKNESS / 2
    board.receiveShadow = true
    board.castShadow = true
    this.group.add(board)

    const tableGeometry = this.track(new THREE.PlaneGeometry(46, 46))
    const table = new THREE.Mesh(tableGeometry, materials.table)
    table.rotation.x = -Math.PI / 2
    table.position.y = TABLE_TOP
    table.receiveShadow = true
    this.group.add(table)

    const makeHintMaterial = (color: string) => {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      this.hintMaterials.push(material)
      return material
    }

    // Selection: wide golden ring.
    const selectionGeometry = this.track(new THREE.RingGeometry(0.44, 0.52, 48))
    this.selectionRing = new THREE.Mesh(selectionGeometry, makeHintMaterial('#e9c25f'))
    this.setupHint(this.selectionRing)

    // Legal moves: small soft rings (circle shape).
    const moveGeometry = this.track(new THREE.RingGeometry(0.13, 0.22, 40))
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(moveGeometry, makeHintMaterial('#8fd6a0'))
      this.setupHint(ring)
      this.moveRings.push(ring)
    }

    // Legal captures: diamond outlines (distinct shape, not only color).
    const captureGeometry = this.track(new THREE.RingGeometry(0.42, 0.52, 4))
    for (let i = 0; i < 4; i++) {
      const diamond = new THREE.Mesh(captureGeometry, makeHintMaterial('#e4694b'))
      this.setupHint(diamond)
      this.captureDiamonds.push(diamond)
    }

    // Invalid-action cell flash.
    const flashGeometry = this.track(new THREE.PlaneGeometry(CELL * 0.92, CELL * 0.92))
    this.flashPlane = new THREE.Mesh(flashGeometry, makeHintMaterial('#d4543c'))
    this.setupHint(this.flashPlane)
  }

  private setupHint(mesh: THREE.Mesh): void {
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = HINT_Y
    mesh.visible = false
    mesh.renderOrder = 5
    this.group.add(mesh)
  }

  private placeHint(mesh: THREE.Mesh, pos: Position): void {
    const { x, z } = cellToWorld(pos)
    mesh.position.set(x, HINT_Y, z)
    mesh.visible = true
  }

  showSelection(pos: Position | null): void {
    if (pos) this.placeHint(this.selectionRing, pos)
    else this.selectionRing.visible = false
  }

  showMoveHints(positions: Position[]): void {
    this.moveRings.forEach((ring, i) => {
      const pos = positions[i]
      if (pos) this.placeHint(ring, pos)
      else ring.visible = false
    })
  }

  showCaptureHints(positions: Position[]): void {
    this.captureDiamonds.forEach((diamond, i) => {
      const pos = positions[i]
      if (pos) this.placeHint(diamond, pos)
      else diamond.visible = false
    })
  }

  clearHints(): void {
    this.showSelection(null)
    this.showMoveHints([])
    this.showCaptureHints([])
  }

  flashCell(pos: Position): void {
    this.placeHint(this.flashPlane, pos)
    this.flashRemaining = 0.36
  }

  update(dt: number): void {
    if (this.flashRemaining > 0) {
      this.flashRemaining -= dt
      const material = this.flashPlane.material as THREE.MeshBasicMaterial
      material.opacity = Math.max(0, this.flashRemaining / 0.36) * 0.55
      if (this.flashRemaining <= 0) this.flashPlane.visible = false
    }
    if (!this.reducedMotion) {
      this.pulseTime += dt
      const pulse = 0.72 + 0.2 * Math.sin(this.pulseTime * 4.2)
      for (const mesh of [...this.moveRings, ...this.captureDiamonds]) {
        ;(mesh.material as THREE.MeshBasicMaterial).opacity = pulse
      }
      ;(this.selectionRing.material as THREE.MeshBasicMaterial).opacity = 0.8 + 0.15 * Math.sin(this.pulseTime * 3)
    }
  }

  private track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry)
    return geometry
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.hintMaterials) material.dispose()
  }
}
