import * as THREE from 'three'
import type { Action, GameState, Position } from './game/types'
import { applyAction, validateAction } from './game/actions'
import { currentPlayer, findPiecePosition } from './game/game-state'
import { getLegalCaptures, getLegalMoves } from './game/rules'
import type { SceneContext } from './rendering/scene'
import { BoardView } from './rendering/board'
import { MaterialLibrary } from './rendering/materials'
import { PieceMeshFactory, pieceQuaternion } from './rendering/piece-mesh'
import { BoardPicker } from './rendering/raycaster'
import { cellToWorld, PIECE_REST_Y } from './rendering/layout'
import { PhysicsWorld, type Pose } from './physics/world'
import { AnimationQueue, easeInQuad, easeOutCubic, Ticker } from './physics/animations'
import type { SoundPlayer } from './audio/sounds'
import { vibrate } from './audio/haptics'

export interface ControllerCallbacks {
  onStateChanged(state: GameState): void
  onGameOver(state: GameState): void
  onHint(message: string): void
}

interface PointerTracking {
  x: number
  y: number
  time: number
  id: number
}

/**
 * Bridges the pure rule engine to the 3D presentation.
 *
 * Flow for every user action:
 *   pointer tap → validate via rule engine → update authoritative state →
 *   notify app (HUD/save) → enqueue presentation animation → unlock input.
 * Physics can never change the game state; pieces always snap back to their
 * logical grid pose when an animation finishes.
 */
export class GameController {
  state!: GameState

  private readonly materials = new MaterialLibrary()
  private readonly factory = new PieceMeshFactory(this.materials)
  private readonly boardView: BoardView
  private readonly picker: BoardPicker
  private readonly ticker = new Ticker()
  private readonly queue = new AnimationQueue()
  private readonly meshes = new Map<string, THREE.Group>()
  private selectedPieceId: string | null = null
  private legalMoves: Position[] = []
  private legalCaptureTargets: string[] = []
  private pointerDown: PointerTracking | null = null
  private readonly reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly onPointerDown = (event: PointerEvent) => this.handlePointerDown(event)
  private readonly onPointerUp = (event: PointerEvent) => this.handlePointerUp(event)

  constructor(
    private readonly sceneContext: SceneContext,
    private readonly physics: PhysicsWorld,
    private readonly sounds: SoundPlayer,
    private readonly callbacks: ControllerCallbacks,
  ) {
    this.boardView = new BoardView(this.materials, this.reducedMotionQuery.matches)
    this.sceneContext.scene.add(this.boardView.group)
    this.picker = new BoardPicker(this.sceneContext.camera, this.sceneContext.piecesGroup, this.sceneContext.canvas)
    this.sceneContext.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.sceneContext.canvas.addEventListener('pointerup', this.onPointerUp)
  }

  private get reducedMotion(): boolean {
    return this.reducedMotionQuery.matches
  }

  private get pieceYaw(): number {
    return this.sceneContext.layout.pieceYaw
  }

  /** Starts presenting a game state (new game or restored save). */
  startSession(state: GameState, options: { intro: boolean }): void {
    this.state = state
    this.clearSelection()
    this.ticker.clear()
    for (const mesh of this.meshes.values()) this.sceneContext.piecesGroup.remove(mesh)
    this.meshes.clear()
    this.physics.clearPieces()

    for (const piece of Object.values(state.pieces)) {
      if (piece.captured) continue
      const position = findPiecePosition(state, piece.id)
      if (!position) continue
      const mesh = this.factory.create(piece)
      const pose = this.logicalPose(piece.id)
      mesh.position.set(pose.position.x, pose.position.y, pose.position.z)
      mesh.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
      this.sceneContext.piecesGroup.add(mesh)
      this.meshes.set(piece.id, mesh)
      this.physics.addPiece(piece.id, pose)
    }

    if (options.intro && !this.reducedMotion) {
      void this.queue.enqueue(() => this.playIntro())
    }
  }

  /** Authoritative grid pose for a living piece. */
  private logicalPose(pieceId: string): Pose {
    const piece = this.state.pieces[pieceId]
    const position = piece ? findPiecePosition(this.state, pieceId) : null
    const { x, z } = position ? cellToWorld(position) : { x: 0, z: 0 }
    const quaternion = pieceQuaternion(piece?.faceUp ?? false, this.pieceYaw)
    return {
      position: { x, y: PIECE_REST_Y, z },
      rotation: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
    }
  }

  /** Re-orients pieces after a viewport/orientation change (no scene rebuild). */
  onViewChanged(): void {
    for (const [pieceId, mesh] of this.meshes) {
      if (this.physics.isDynamic(pieceId)) continue
      const pose = this.logicalPose(pieceId)
      mesh.position.set(pose.position.x, pose.position.y, pose.position.z)
      mesh.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
      this.physics.setPose(pieceId, pose)
    }
  }

  /** Per-frame update driven by the app's render loop. */
  frame(dt: number): void {
    this.physics.step(dt)
    for (const [pieceId, pose] of this.physics.dynamicPoses()) {
      const mesh = this.meshes.get(pieceId)
      if (mesh) {
        mesh.position.set(pose.position.x, pose.position.y, pose.position.z)
        mesh.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
      }
    }
    this.ticker.update(dt)
    this.boardView.update(dt)
    this.sceneContext.render()
  }

  // ---------------------------------------------------------------- input

  private handlePointerDown(event: PointerEvent): void {
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId }
  }

  private handlePointerUp(event: PointerEvent): void {
    const start = this.pointerDown
    this.pointerDown = null
    if (!start || start.id !== event.pointerId) return
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    if (distance > 14 || performance.now() - start.time > 700) return
    this.handleTap(event.clientX, event.clientY)
  }

  private handleTap(clientX: number, clientY: number): void {
    if (!this.state || this.state.status !== 'playing' || this.queue.busy) return
    const picked = this.picker.pick(clientX, clientY)

    if (picked.pieceId) {
      this.handlePieceTap(picked.pieceId)
    } else if (picked.cell) {
      this.handleCellTap(picked.cell)
    } else {
      this.clearSelection()
    }
  }

  private handlePieceTap(pieceId: string): void {
    const piece = this.state.pieces[pieceId]
    if (!piece || piece.captured) return
    const player = currentPlayer(this.state)

    if (!piece.faceUp) {
      this.tryAction({ kind: 'flip', pieceId })
      return
    }
    if (player.color !== null && piece.color === player.color) {
      if (this.selectedPieceId === pieceId) this.clearSelection()
      else this.select(pieceId)
      return
    }
    // Enemy face-up piece.
    if (this.selectedPieceId && this.legalCaptureTargets.includes(pieceId)) {
      this.tryAction({ kind: 'capture', attackerId: this.selectedPieceId, targetId: pieceId })
      return
    }
    this.invalidFeedback(pieceId, this.selectedPieceId ? '不能吃這顆棋' : '這不是你的棋子')
  }

  private handleCellTap(cell: Position): void {
    if (this.selectedPieceId && this.legalMoves.some((p) => p.row === cell.row && p.col === cell.col)) {
      this.tryAction({ kind: 'move', pieceId: this.selectedPieceId, to: cell })
      return
    }
    if (this.selectedPieceId) {
      this.boardView.flashCell(cell)
      this.sounds.play('invalid')
      this.clearSelection()
    }
  }

  private select(pieceId: string): void {
    this.clearSelection()
    this.selectedPieceId = pieceId
    this.legalMoves = getLegalMoves(this.state, pieceId)
    this.legalCaptureTargets = getLegalCaptures(this.state, pieceId)
    const position = findPiecePosition(this.state, pieceId)
    this.boardView.showSelection(position)
    this.boardView.showMoveHints(this.legalMoves)
    this.boardView.showCaptureHints(
      this.legalCaptureTargets
        .map((targetId) => findPiecePosition(this.state, targetId))
        .filter((p): p is Position => p !== null),
    )
    const mesh = this.meshes.get(pieceId)
    if (mesh && !this.reducedMotion) {
      void this.ticker.tween(0.09, (t) => {
        mesh.position.y = PIECE_REST_Y + 0.07 * t
      }, easeOutCubic)
    }
    if (this.legalMoves.length === 0 && this.legalCaptureTargets.length === 0) {
      this.callbacks.onHint('這顆棋目前沒有合法動作')
    }
  }

  private clearSelection(): void {
    if (this.selectedPieceId) {
      const mesh = this.meshes.get(this.selectedPieceId)
      const pieceId = this.selectedPieceId
      if (mesh && !this.physics.isDynamic(pieceId)) {
        mesh.position.y = PIECE_REST_Y
      }
    }
    this.selectedPieceId = null
    this.legalMoves = []
    this.legalCaptureTargets = []
    this.boardView.clearHints()
  }

  private invalidFeedback(pieceId: string | null, message: string): void {
    this.sounds.play('invalid')
    this.callbacks.onHint(message)
    if (!pieceId) return
    const position = pieceId ? findPiecePosition(this.state, pieceId) : null
    if (position) this.boardView.flashCell(position)
    const mesh = this.meshes.get(pieceId)
    if (mesh && !this.reducedMotion && !this.physics.isDynamic(pieceId)) {
      const baseX = mesh.position.x
      void this.ticker.tween(0.24, (t) => {
        mesh.position.x = baseX + Math.sin(t * Math.PI * 4) * 0.045 * (1 - t)
      })
    }
  }

  // -------------------------------------------------------------- actions

  private tryAction(action: Action): void {
    const error = validateAction(this.state, action)
    if (error) {
      const pieceId = action.kind === 'flip' ? action.pieceId : action.kind === 'move' ? action.pieceId : action.targetId
      this.invalidFeedback(pieceId, error)
      return
    }

    const previous = this.state
    this.state = applyAction(this.state, action)
    this.clearSelection()
    this.callbacks.onStateChanged(this.state)

    void this.queue
      .enqueue(() => {
        switch (action.kind) {
          case 'flip':
            return this.animateFlip(action.pieceId)
          case 'move':
            return this.animateMove(action.pieceId)
          case 'capture':
            return this.animateCapture(action.attackerId, action.targetId, previous)
        }
      })
      .then(() => {
        if (this.state.status !== 'playing') this.callbacks.onGameOver(this.state)
      })
  }

  // ----------------------------------------------------------- animations

  private async playIntro(): Promise<void> {
    const entries = [...this.meshes.entries()]
    const tweens = entries.map(([pieceId, mesh], index) => {
      const pose = this.logicalPose(pieceId)
      const startY = pose.position.y + 0.85
      mesh.position.y = startY
      return this.ticker
        .delay(index * 0.012)
        .then(() =>
          this.ticker.tween(0.3, (t) => {
            mesh.position.y = startY + (pose.position.y - startY) * t
          }, easeInQuad),
        )
    })
    await Promise.all(tweens)
    this.sounds.play('place')
  }

  private async animateFlip(pieceId: string): Promise<void> {
    const mesh = this.meshes.get(pieceId)
    if (!mesh) return
    const finalPose = this.logicalPose(pieceId)
    this.sounds.play('flip')
    vibrate('flip')

    if (this.reducedMotion) {
      await this.blendToPose(mesh, pieceId, finalPose, 0.24)
      this.sounds.play('place')
      return
    }

    // Physical flip: launch upward with spin around a horizontal axis, let
    // Rapier integrate the arc, then blend precisely back onto the grid.
    const upwardSpeed = 3.0
    const gravity = 22
    const flightTime = (2 * upwardSpeed) / gravity
    const spin = Math.PI / flightTime
    const yaw = this.pieceYaw
    const axis = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) }
    this.physics.launch(
      pieceId,
      { x: (Math.random() - 0.5) * 0.25, y: upwardSpeed, z: (Math.random() - 0.5) * 0.25 },
      { x: axis.x * spin, y: (Math.random() - 0.5) * 1.2, z: axis.z * spin },
    )
    await this.ticker.delay(flightTime + 0.1)
    this.physics.settle(pieceId)
    await this.blendToPose(mesh, pieceId, finalPose, 0.16)
    this.sounds.play('place')
  }

  private async animateMove(pieceId: string): Promise<void> {
    const mesh = this.meshes.get(pieceId)
    if (!mesh) return
    const finalPose = this.logicalPose(pieceId)
    const start = mesh.position.clone()
    const startQuat = mesh.quaternion.clone()
    const endQuat = new THREE.Quaternion(
      finalPose.rotation.x,
      finalPose.rotation.y,
      finalPose.rotation.z,
      finalPose.rotation.w,
    )
    this.sounds.play('move')
    vibrate('move')

    const duration = this.reducedMotion ? 0.18 : 0.24
    const lift = this.reducedMotion ? 0 : 0.2
    const scratch = new THREE.Quaternion()
    await this.ticker.tween(duration, (t) => {
      mesh.position.x = start.x + (finalPose.position.x - start.x) * t
      mesh.position.z = start.z + (finalPose.position.z - start.z) * t
      mesh.position.y = PIECE_REST_Y + Math.sin(t * Math.PI) * lift
      scratch.slerpQuaternions(startQuat, endQuat, t)
      mesh.quaternion.copy(scratch)
      this.physics.setPose(pieceId, this.meshPose(mesh))
    })
    this.snap(mesh, pieceId, finalPose)
    this.sounds.play('place')
  }

  private async animateCapture(attackerId: string, targetId: string, previous: GameState): Promise<void> {
    const attackerMesh = this.meshes.get(attackerId)
    const targetMesh = this.meshes.get(targetId)
    if (!attackerMesh) return
    const finalPose = this.logicalPose(attackerId)
    const targetPosition = findPiecePosition(previous, targetId)
    const start = attackerMesh.position.clone()
    const end = new THREE.Vector3(finalPose.position.x, PIECE_REST_Y, finalPose.position.z)

    // Rush toward the target.
    this.sounds.play('move')
    const rushTime = this.reducedMotion ? 0.16 : 0.15
    await this.ticker.tween(rushTime, (t) => {
      attackerMesh.position.lerpVectors(start, end, t)
      attackerMesh.position.y = PIECE_REST_Y + Math.sin(t * Math.PI) * (this.reducedMotion ? 0 : 0.14)
      this.physics.setPose(attackerId, this.meshPose(attackerMesh))
    }, easeInQuad)

    this.sounds.play('capture')
    vibrate('capture')

    if (targetMesh && targetPosition) {
      if (this.reducedMotion) {
        await this.ticker.tween(0.16, (t) => {
          const s = 1 - t * 0.99
          targetMesh.scale.setScalar(s)
        })
      } else {
        // Knock the victim flying with spin; physics handles the tumble.
        const impactDirection = new THREE.Vector3().subVectors(end, start).setY(0)
        if (impactDirection.lengthSq() < 1e-6) impactDirection.set(0, 0, 1)
        impactDirection.normalize()
        const sideBias = end.z >= 0 ? 1 : -1
        this.physics.launch(
          targetId,
          {
            x: impactDirection.x * 3.4,
            y: 3.1,
            z: impactDirection.z * 3.4 + sideBias * 1.6,
          },
          {
            x: (Math.random() - 0.5) * 14,
            y: (Math.random() - 0.5) * 6,
            z: (Math.random() - 0.5) * 14,
          },
        )
        await this.ticker.delay(0.8)
        this.physics.settle(targetId)
        await this.ticker.tween(0.2, (t) => {
          targetMesh.scale.setScalar(Math.max(0.01, 1 - t))
        }, easeInQuad)
      }
      this.sceneContext.piecesGroup.remove(targetMesh)
      this.meshes.delete(targetId)
    }
    this.physics.removePiece(targetId)

    this.snap(attackerMesh, attackerId, finalPose)
    if (this.state.status === 'won') this.sounds.play('win')
  }

  /** Smoothly blends a mesh from its current pose to an exact target pose. */
  private async blendToPose(mesh: THREE.Group, pieceId: string, pose: Pose, duration: number): Promise<void> {
    const startPosition = mesh.position.clone()
    const startQuat = mesh.quaternion.clone()
    const endPosition = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z)
    const endQuat = new THREE.Quaternion(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
    const scratch = new THREE.Quaternion()
    await this.ticker.tween(duration, (t) => {
      mesh.position.lerpVectors(startPosition, endPosition, t)
      scratch.slerpQuaternions(startQuat, endQuat, t)
      mesh.quaternion.copy(scratch)
    }, easeOutCubic)
    this.snap(mesh, pieceId, pose)
  }

  /** Hard-snaps mesh and body to the authoritative grid pose. */
  private snap(mesh: THREE.Group, pieceId: string, pose: Pose): void {
    mesh.position.set(pose.position.x, pose.position.y, pose.position.z)
    mesh.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
    this.physics.setPose(pieceId, pose)
  }

  private meshPose(mesh: THREE.Group): Pose {
    return {
      position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      rotation: { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
    }
  }

  get animating(): boolean {
    return this.queue.busy
  }

  dispose(): void {
    this.sceneContext.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.sceneContext.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.ticker.clear()
    this.physics.clearPieces()
    for (const mesh of this.meshes.values()) this.sceneContext.piecesGroup.remove(mesh)
    this.meshes.clear()
    this.sceneContext.scene.remove(this.boardView.group)
    this.boardView.dispose()
    this.factory.dispose()
    this.materials.dispose()
  }
}
