import type { Action, GameState, HistoryEntry, Position } from './types'
import { NO_CAPTURE_DRAW_LIMIT } from './constants'
import {
  cloneState,
  currentPlayer,
  findPiecePosition,
  opponentIndex,
  positionToIndex,
  remainingPieces,
} from './game-state'
import { canCapture, canMove } from './rules'

/**
 * Validates an action against the authoritative game state.
 * Returns null when legal, otherwise a human-readable (zh-TW) reason.
 */
export function validateAction(state: GameState, action: Action): string | null {
  if (state.status !== 'playing') return '對局已結束'
  const player = currentPlayer(state)

  switch (action.kind) {
    case 'flip': {
      const piece = state.pieces[action.pieceId]
      if (!piece || piece.captured) return '棋子不存在'
      if (piece.faceUp) return '這顆棋已經翻開'
      return null
    }
    case 'move': {
      const piece = state.pieces[action.pieceId]
      if (!piece || piece.captured) return '棋子不存在'
      if (!piece.faceUp) return '不能移動暗棋'
      if (player.color === null || piece.color !== player.color) return '這不是你的棋子'
      if (!canMove(state, action.pieceId, action.to)) return '不合法的移動'
      return null
    }
    case 'capture': {
      const attacker = state.pieces[action.attackerId]
      const target = state.pieces[action.targetId]
      if (!attacker || attacker.captured) return '棋子不存在'
      if (!target || target.captured) return '目標不存在'
      if (!attacker.faceUp) return '不能使用暗棋吃子'
      if (player.color === null || attacker.color !== player.color) return '這不是你的棋子'
      if (!target.faceUp) return '不能吃暗棋'
      if (target.color === attacker.color) return '不能吃自己的棋'
      if (!canCapture(state, action.attackerId, action.targetId)) return '不合法的吃子'
      return null
    }
  }
}

export function switchTurn(state: GameState): GameState {
  const next = cloneState(state)
  next.currentPlayerIndex = opponentIndex(next.currentPlayerIndex)
  return next
}

/** Winner player index when one side has lost every piece, otherwise null. */
export function checkVictory(state: GameState): 0 | 1 | null {
  for (const color of ['red', 'black'] as const) {
    if (remainingPieces(state, color).length === 0) {
      const winner = state.players.findIndex((p) => p.color !== null && p.color !== color)
      if (winner === 0 || winner === 1) return winner
    }
  }
  return null
}

export function checkDraw(state: GameState): boolean {
  return state.noCaptureTurnCount >= NO_CAPTURE_DRAW_LIMIT
}

/**
 * Applies a validated action and returns the next authoritative state.
 * Exactly one action per turn; the turn passes to the opponent afterwards.
 * Throws if the action is illegal — call validateAction first for UI feedback.
 */
export function applyAction(state: GameState, action: Action): GameState {
  const error = validateAction(state, action)
  if (error) throw new Error(error)

  const next = cloneState(state)
  const playerIndex = next.currentPlayerIndex
  let capturedSomething = false
  let entry: HistoryEntry

  switch (action.kind) {
    case 'flip': {
      const piece = next.pieces[action.pieceId]!
      piece.faceUp = true
      // First flip of the game assigns camps: the flipping player takes the
      // revealed color; the opponent takes the other color. Fixed thereafter.
      if (next.players[0].color === null && next.players[1].color === null) {
        next.players[playerIndex].color = piece.color
        next.players[opponentIndex(playerIndex)].color = piece.color === 'red' ? 'black' : 'red'
      }
      entry = {
        turn: next.turnNumber + 1,
        playerIndex,
        kind: 'flip',
        pieceColor: piece.color,
        pieceType: piece.type,
        to: findPiecePosition(next, piece.id) ?? undefined,
      }
      break
    }
    case 'move': {
      const piece = next.pieces[action.pieceId]!
      const from = findPiecePosition(next, piece.id)!
      next.board[positionToIndex(from)] = null
      next.board[positionToIndex(action.to)] = piece.id
      entry = {
        turn: next.turnNumber + 1,
        playerIndex,
        kind: 'move',
        pieceColor: piece.color,
        pieceType: piece.type,
        from,
        to: action.to,
      }
      break
    }
    case 'capture': {
      const attacker = next.pieces[action.attackerId]!
      const target = next.pieces[action.targetId]!
      const from = findPiecePosition(next, attacker.id)!
      const to = findPiecePosition(next, target.id)!
      target.captured = true
      next.board[positionToIndex(to)] = attacker.id
      next.board[positionToIndex(from)] = null
      capturedSomething = true
      entry = {
        turn: next.turnNumber + 1,
        playerIndex,
        kind: 'capture',
        pieceColor: attacker.color,
        pieceType: attacker.type,
        from,
        to,
        targetColor: target.color,
        targetType: target.type,
      }
      break
    }
  }

  next.turnNumber += 1
  next.noCaptureTurnCount = capturedSomething ? 0 : next.noCaptureTurnCount + 1
  next.history.push(entry)

  const winner = capturedSomething ? checkVictory(next) : null
  if (winner !== null) {
    next.status = 'won'
    next.winnerIndex = winner
  } else if (checkDraw(next)) {
    next.status = 'draw'
    next.winnerIndex = null
  } else {
    next.currentPlayerIndex = opponentIndex(playerIndex)
  }
  return next
}

/** Ends the game as a draw by mutual agreement. */
export function agreeDraw(state: GameState): GameState {
  const next = cloneState(state)
  next.status = 'draw'
  next.winnerIndex = null
  return next
}

/** Convenience wrappers matching the required rule-engine API surface. */
export function flipPiece(state: GameState, pieceId: string): GameState {
  return applyAction(state, { kind: 'flip', pieceId })
}

export function movePiece(state: GameState, pieceId: string, to: Position): GameState {
  return applyAction(state, { kind: 'move', pieceId, to })
}

export function capturePiece(state: GameState, attackerId: string, targetId: string): GameState {
  return applyAction(state, { kind: 'capture', attackerId, targetId })
}
