import type { Action, Position } from '../src/game/types'
import type { ClientMessage } from '../src/shared/protocol'

/**
 * Runtime narrowing of untrusted inbound JSON. Returns a well-typed message
 * or null; the engine's validateAction does the game-legality checks after.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  let data: unknown
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>

  switch (msg.t) {
    case 'join': {
      if (typeof msg.roomId !== 'string') return null
      const playerToken = typeof msg.playerToken === 'string' ? msg.playerToken.slice(0, 64) : undefined
      const name = typeof msg.name === 'string' ? msg.name.slice(0, 24) : undefined
      return { t: 'join', roomId: msg.roomId.slice(0, 24), playerToken, name, spectate: msg.spectate === true }
    }
    case 'action': {
      if (typeof msg.seq !== 'number' || !Number.isFinite(msg.seq)) return null
      const action = parseAction(msg.action)
      if (!action) return null
      return { t: 'action', seq: msg.seq, action }
    }
    case 'chat':
      if (typeof msg.text !== 'string') return null
      return { t: 'chat', text: msg.text.slice(0, 500) }
    case 'canned':
      if (typeof msg.id !== 'string') return null
      return { t: 'canned', id: msg.id.slice(0, 32) }
    case 'drawOffer':
      return { t: 'drawOffer' }
    case 'drawResponse':
      return { t: 'drawResponse', accept: msg.accept === true }
    case 'abortRequest':
      return { t: 'abortRequest' }
    case 'abortResponse':
      return { t: 'abortResponse', accept: msg.accept === true }
    case 'resign':
      return { t: 'resign' }
    case 'rematch':
      return { t: 'rematch' }
    case 'rematchResponse':
      return { t: 'rematchResponse', accept: msg.accept === true }
    default:
      return null
  }
}

function parseAction(raw: unknown): Action | null {
  if (typeof raw !== 'object' || raw === null) return null
  const a = raw as Record<string, unknown>
  switch (a.kind) {
    case 'flip':
      return isPieceId(a.pieceId) ? { kind: 'flip', pieceId: a.pieceId } : null
    case 'move': {
      const to = parsePosition(a.to)
      return isPieceId(a.pieceId) && to ? { kind: 'move', pieceId: a.pieceId, to } : null
    }
    case 'capture':
      return isPieceId(a.attackerId) && isPieceId(a.targetId)
        ? { kind: 'capture', attackerId: a.attackerId, targetId: a.targetId }
        : null
    default:
      return null
  }
}

function isPieceId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 24
}

function parsePosition(raw: unknown): Position | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.row !== 'number' || typeof p.col !== 'number') return null
  if (!Number.isInteger(p.row) || !Number.isInteger(p.col)) return null
  return { row: p.row, col: p.col }
}
