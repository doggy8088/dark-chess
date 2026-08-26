import type * as RAPIER_NS from '@dimforge/rapier3d'
import {
  BOARD_DEPTH,
  BOARD_THICKNESS,
  BOARD_TOP,
  BOARD_WIDTH,
  PIECE_HEIGHT,
  PIECE_RADIUS,
  TABLE_TOP,
} from '../rendering/layout'

type RapierModule = typeof RAPIER_NS

export interface Pose {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
}

const FIXED_TIMESTEP = 1 / 60
const MAX_SUBSTEPS = 5

/**
 * Physics is presentation only: bodies mirror the authoritative game state
 * and are switched to dynamic solely while an animation plays. Idle pieces
 * are kinematic so they act as stable colliders (e.g. for a flipping
 * neighbor) but can never drift.
 */
export class PhysicsWorld {
  private accumulator = 0
  private readonly bodies = new Map<string, RAPIER_NS.RigidBody>()
  private readonly dynamicIds = new Set<string>()

  private constructor(
    private readonly rapier: RapierModule,
    private readonly world: RAPIER_NS.World,
  ) {}

  static async create(): Promise<PhysicsWorld> {
    const rapier = await import('@dimforge/rapier3d')
    const world = new rapier.World({ x: 0, y: -22, z: 0 })
    world.timestep = FIXED_TIMESTEP

    // Board slab.
    const boardBody = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(0, BOARD_TOP - BOARD_THICKNESS / 2, 0),
    )
    world.createCollider(
      rapier.ColliderDesc.cuboid(BOARD_WIDTH / 2, BOARD_THICKNESS / 2, BOARD_DEPTH / 2)
        .setFriction(0.75)
        .setRestitution(0.32),
      boardBody,
    )

    // Surrounding tabletop, slightly below the board surface.
    const tableBody = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(0, TABLE_TOP - 0.25, 0),
    )
    world.createCollider(
      rapier.ColliderDesc.cuboid(23, 0.25, 23).setFriction(0.8).setRestitution(0.2),
      tableBody,
    )

    return new PhysicsWorld(rapier, world)
  }

  addPiece(pieceId: string, pose: Pose): void {
    const body = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pose.position.x, pose.position.y, pose.position.z)
        .setRotation(pose.rotation),
    )
    this.world.createCollider(
      this.rapier.ColliderDesc.cylinder(PIECE_HEIGHT / 2, PIECE_RADIUS)
        .setFriction(0.6)
        .setRestitution(0.42)
        .setDensity(1.6),
      body,
    )
    this.bodies.set(pieceId, body)
  }

  removePiece(pieceId: string): void {
    const body = this.bodies.get(pieceId)
    if (body) {
      this.world.removeRigidBody(body)
      this.bodies.delete(pieceId)
      this.dynamicIds.delete(pieceId)
    }
  }

  /** Moves an idle (kinematic) piece instantly — used for snapping. */
  setPose(pieceId: string, pose: Pose): void {
    const body = this.bodies.get(pieceId)
    if (!body) return
    if (body.isKinematic()) {
      body.setNextKinematicTranslation(pose.position)
      body.setNextKinematicRotation(pose.rotation)
    }
    body.setTranslation(pose.position, false)
    body.setRotation(pose.rotation, false)
  }

  getPose(pieceId: string): Pose | null {
    const body = this.bodies.get(pieceId)
    if (!body) return null
    const t = body.translation()
    const r = body.rotation()
    return { position: { x: t.x, y: t.y, z: t.z }, rotation: { x: r.x, y: r.y, z: r.z, w: r.w } }
  }

  /** Switches a piece to dynamic and launches it with the given velocities. */
  launch(
    pieceId: string,
    linearVelocity: { x: number; y: number; z: number },
    angularVelocity: { x: number; y: number; z: number },
  ): void {
    const body = this.bodies.get(pieceId)
    if (!body) return
    body.setBodyType(this.rapier.RigidBodyType.Dynamic, true)
    body.setLinvel(linearVelocity, true)
    body.setAngvel(angularVelocity, true)
    this.dynamicIds.add(pieceId)
  }

  /** Returns a dynamic piece to kinematic control, zeroing all velocities. */
  settle(pieceId: string): void {
    const body = this.bodies.get(pieceId)
    if (!body) return
    body.setLinvel({ x: 0, y: 0, z: 0 }, false)
    body.setAngvel({ x: 0, y: 0, z: 0 }, false)
    body.setBodyType(this.rapier.RigidBodyType.KinematicPositionBased, true)
    this.dynamicIds.delete(pieceId)
  }

  isDynamic(pieceId: string): boolean {
    return this.dynamicIds.has(pieceId)
  }

  /** Fixed-timestep stepping with an accumulator and a substep cap. */
  step(dt: number): void {
    this.accumulator = Math.min(this.accumulator + dt, FIXED_TIMESTEP * MAX_SUBSTEPS)
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.world.step()
      this.accumulator -= FIXED_TIMESTEP
    }
  }

  /** Poses of pieces currently under dynamic (physics) control. */
  dynamicPoses(): Map<string, Pose> {
    const poses = new Map<string, Pose>()
    for (const pieceId of this.dynamicIds) {
      const pose = this.getPose(pieceId)
      if (pose) poses.set(pieceId, pose)
    }
    return poses
  }

  clearPieces(): void {
    for (const pieceId of [...this.bodies.keys()]) this.removePiece(pieceId)
  }
}
