import type { GameState } from '../game/types'
import { COLOR_NAME, NO_CAPTURE_DRAW_LIMIT, PIECE_CHAR } from '../game/constants'
import { capturedPieces, currentPlayer } from '../game/game-state'
import { el, formatDuration } from './dom'
import { renderHistory } from './history'

/** In-game HUD: turn indicator, captured pieces, counters, timer, history. */
export class Hud {
  private readonly turnText = el('turn-text')
  private readonly turnChip = el('turn-color-chip')
  private readonly turnIndicator = el('turn-indicator')
  private readonly timer = el('hud-timer')
  private readonly noCapture = el('hud-nocapture')
  private readonly capturedRed = el('captured-red')
  private readonly capturedBlack = el('captured-black')
  private readonly remainingRed = el('remaining-red')
  private readonly remainingBlack = el('remaining-black')
  private readonly hint = el('hud-hint')
  private readonly historyDesktop = el<HTMLOListElement>('history-list')
  private readonly historyMobile = el<HTMLOListElement>('history-list-mobile')
  private hintTimeout = 0
  private lastPlayerIndex: number | null = null

  update(state: GameState): void {
    const player = currentPlayer(state)
    if (state.status === 'playing') {
      const camp = player.color ? COLOR_NAME[player.color] : '陣營未定'
      this.turnText.textContent = `${player.name} · ${camp}`
      this.turnChip.className = `color-chip${player.color ? ` ${player.color}` : ''}`
      if (this.lastPlayerIndex !== null && this.lastPlayerIndex !== state.currentPlayerIndex) {
        this.turnIndicator.classList.remove('pulse')
        // Force reflow so the pulse restarts on consecutive turn changes.
        void this.turnIndicator.offsetWidth
        this.turnIndicator.classList.add('pulse')
        window.setTimeout(() => this.turnIndicator.classList.remove('pulse'), 900)
      }
      this.lastPlayerIndex = state.currentPlayerIndex
    } else if (state.status === 'won' && state.winnerIndex !== null) {
      const winner = state.players[state.winnerIndex]
      this.turnText.textContent = `${winner.name} 獲勝`
    } else if (state.status === 'draw') {
      this.turnText.textContent = '和局'
    }

    this.noCapture.textContent = `無吃子 ${state.noCaptureTurnCount}/${NO_CAPTURE_DRAW_LIMIT}`
    this.noCapture.classList.toggle('warn', state.noCaptureTurnCount >= NO_CAPTURE_DRAW_LIMIT - 5)

    this.renderCaptured(state)
    renderHistory(this.historyDesktop, state)
    renderHistory(this.historyMobile, state)
  }

  private renderCaptured(state: GameState): void {
    for (const color of ['red', 'black'] as const) {
      const container = color === 'red' ? this.capturedRed : this.capturedBlack
      container.textContent = ''
      for (const piece of capturedPieces(state, color)) {
        const chip = document.createElement('span')
        chip.className = `captured-piece ${color}`
        chip.textContent = PIECE_CHAR[color][piece.type]
        container.append(chip)
      }
      // Derived from captures only: face-down identities may be redacted
      // (online mode), and 16 minus captured is the same number anyway.
      const remaining = 16 - capturedPieces(state, color).length
      const label = color === 'red' ? this.remainingRed : this.remainingBlack
      label.textContent = `剩 ${remaining}`
    }
  }

  setTimer(elapsedMs: number): void {
    this.timer.textContent = formatDuration(elapsedMs)
    this.timer.classList.remove('countdown', 'countdown-urgent')
  }

  /** Online mode: per-move countdown in the timer slot; red pulse under 10s. */
  setMoveCountdown(remainingMs: number | null): void {
    if (remainingMs === null) {
      this.timer.textContent = '－'
      this.timer.classList.remove('countdown', 'countdown-urgent')
      return
    }
    const clamped = Math.max(0, remainingMs)
    this.timer.textContent = formatDuration(clamped)
    this.timer.classList.add('countdown')
    this.timer.classList.toggle('countdown-urgent', clamped < 10_000)
  }

  showHint(message: string): void {
    this.hint.textContent = message
    window.clearTimeout(this.hintTimeout)
    if (message) {
      this.hintTimeout = window.setTimeout(() => {
        this.hint.textContent = ''
      }, 2600)
    }
  }

  reset(): void {
    this.lastPlayerIndex = null
    this.showHint('')
  }
}
