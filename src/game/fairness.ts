import type { Piece } from './types'

/**
 * Commit-and-reveal fairness scheme.
 *
 * At game start the full initial layout plus a random nonce is hashed with
 * SHA-256 and the digest is shown to both players. After the game ends the
 * layout and nonce are revealed so anyone can recompute the hash and confirm
 * the hidden pieces were never rearranged mid-game.
 */

export interface FairnessData {
  /** Piece ids in board-index order (row-major), fixed at shuffle time. */
  layout: string[]
  nonce: string
  commitmentHash: string
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export function serializeLayout(layout: readonly Piece[]): string[] {
  return layout.map((p) => p.id)
}

export async function computeCommitmentHash(layout: readonly string[], nonce: string): Promise<string> {
  const payload = `taiwan-dark-chess-v1|${layout.join(',')}|${nonce}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return bytesToHex(new Uint8Array(digest))
}

export async function createCommitment(layout: readonly Piece[]): Promise<FairnessData> {
  const ids = serializeLayout(layout)
  const nonce = generateNonce()
  const commitmentHash = await computeCommitmentHash(ids, nonce)
  return { layout: ids, nonce, commitmentHash }
}

export async function verifyCommitment(data: FairnessData): Promise<boolean> {
  const recomputed = await computeCommitmentHash(data.layout, data.nonce)
  return recomputed === data.commitmentHash
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}
