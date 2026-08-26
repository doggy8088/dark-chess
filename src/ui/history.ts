import type { GameState, HistoryEntry, Position } from '../game/types'
import { PIECE_CHAR } from '../game/constants'

export function positionLabel(pos: Position): string {
  return `${String.fromCharCode(65 + pos.col)}${pos.row + 1}`
}

export function formatHistoryEntry(entry: HistoryEntry, state: GameState): string {
  const player = state.players[entry.playerIndex]
  const who = entry.playerIndex === 0 ? 'P1' : 'P2'
  const name = player?.name ?? who
  const pieceChar = PIECE_CHAR[entry.pieceColor][entry.pieceType]
  switch (entry.kind) {
    case 'flip': {
      const colorName = entry.pieceColor === 'red' ? '紅' : '黑'
      const where = entry.to ? ` ${positionLabel(entry.to)}` : ''
      return `${name} 翻開 ${colorName}${pieceChar}${where}`
    }
    case 'move':
      return `${name} ${pieceChar} ${entry.from ? positionLabel(entry.from) : ''} → ${entry.to ? positionLabel(entry.to) : ''}`
    case 'capture': {
      const targetChar = entry.targetColor && entry.targetType ? PIECE_CHAR[entry.targetColor][entry.targetType] : '?'
      return `${name} ${pieceChar} ${entry.from ? positionLabel(entry.from) : ''} ✕ ${targetChar} ${entry.to ? positionLabel(entry.to) : ''}`
    }
  }
}

/** Renders the move history into a list element and scrolls to the latest entry. */
export function renderHistory(list: HTMLOListElement, state: GameState): void {
  list.textContent = ''
  const fragment = document.createDocumentFragment()
  for (const entry of state.history) {
    const item = document.createElement('li')
    const turn = document.createElement('span')
    turn.className = 'history-turn'
    turn.textContent = String(entry.turn)
    const text = document.createElement('span')
    if (entry.kind === 'capture') text.className = 'history-capture'
    text.textContent = formatHistoryEntry(entry, state)
    item.append(turn, text)
    fragment.append(item)
  }
  list.append(fragment)
  list.scrollTop = list.scrollHeight
}
