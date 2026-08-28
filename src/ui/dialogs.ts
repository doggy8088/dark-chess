import type { GameState, Piece } from '../game/types'
import type { FairnessData } from '../game/fairness'
import { verifyCommitment } from '../game/fairness'
import { COLOR_NAME, PIECE_CHAR } from '../game/constants'
import { el, formatDuration } from './dom'

/** Wires shared dismissal behavior: .dialog-close buttons and backdrop clicks.
 *  Dialogs marked data-persistent ignore Esc/backdrop and close only via code. */
export function setupDialogs(): void {
  for (const dialog of document.querySelectorAll('dialog')) {
    if (dialog.dataset.persistent === 'true') {
      dialog.addEventListener('cancel', (event) => event.preventDefault())
      continue
    }
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
      button.addEventListener('click', () => dialog.close())
    }
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close()
    })
  }
}

/** Opens the admin announcement dialog. Dismissal is click-only (no Esc or
 *  backdrop) and `onAck` fires when the reader confirms. */
export function showAnnouncementDialog(text: string, at: number, onAck: () => void): void {
  const dialog = el<HTMLDialogElement>('dialog-announcement')
  el('announcement-text').textContent = text
  el('announcement-time').textContent = `發送於 ${new Date(at).toLocaleString('zh-TW', { hour12: false })}`
  el<HTMLButtonElement>('btn-announcement-ack').onclick = () => {
    if (dialog.open) dialog.close()
    onAck()
  }
  if (!dialog.open) dialog.showModal()
}

export function openDialog(id: string): HTMLDialogElement {
  const dialog = el<HTMLDialogElement>(id)
  if (!dialog.open) dialog.showModal()
  return dialog
}

/** Custom confirmation dialog (never window.confirm). */
export function confirmDialog(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el<HTMLDialogElement>('dialog-confirm')
    el('confirm-title').textContent = title
    el('confirm-message').textContent = message
    const ok = el<HTMLButtonElement>('btn-confirm-ok')
    const cancel = el<HTMLButtonElement>('btn-confirm-cancel')

    const finish = (result: boolean) => {
      ok.removeEventListener('click', onOk)
      cancel.removeEventListener('click', onCancel)
      dialog.removeEventListener('close', onClose)
      if (dialog.open) dialog.close()
      resolve(result)
    }
    const onOk = () => finish(true)
    const onCancel = () => finish(false)
    const onClose = () => finish(false)

    ok.addEventListener('click', onOk)
    cancel.addEventListener('click', onCancel)
    dialog.addEventListener('close', onClose)
    dialog.showModal()
    ok.focus()
  })
}

/** Fills and opens the fairness dialog. The layout/nonce are revealed only after the game ends. */
export function showFairnessDialog(
  fairness: FairnessData,
  finished: boolean,
  pieces: Record<string, Piece>,
): void {
  el('fairness-hash').textContent = fairness.commitmentHash
  el('fairness-playing').hidden = finished
  const finishedBlock = el('fairness-finished')
  finishedBlock.hidden = !finished

  if (finished) {
    el('fairness-nonce').textContent = fairness.nonce
    const grid = el('fairness-layout')
    grid.textContent = ''
    for (const pieceId of fairness.layout) {
      const piece = pieces[pieceId]
      const cell = document.createElement('span')
      if (piece) {
        cell.className = `layout-cell ${piece.color}`
        cell.textContent = PIECE_CHAR[piece.color][piece.type]
        cell.title = pieceId
      } else {
        cell.className = 'layout-cell'
        cell.textContent = '?'
      }
      grid.append(cell)
    }
    const result = el('fairness-result')
    result.textContent = ''
    result.className = ''
    const verifyButton = el<HTMLButtonElement>('btn-verify-fairness')
    verifyButton.onclick = async () => {
      verifyButton.disabled = true
      const valid = await verifyCommitment(fairness)
      result.textContent = valid
        ? '驗證成功：初始排列與開局承諾一致，本局未被更動。'
        : '驗證失敗：雜湊值不一致！'
      result.className = valid ? 'ok' : 'bad'
      verifyButton.disabled = false
    }
  }
  openDialog('dialog-fairness')
}

/** Fills and opens the game-over dialog. */
export function showGameOverDialog(state: GameState, elapsedMs: number, reasonOverride?: string): void {
  const title = el('gameover-title')
  const subtitle = el('gameover-subtitle')
  if (state.status === 'won' && state.winnerIndex !== null) {
    const winner = state.players[state.winnerIndex]
    title.textContent = `${winner.name} 獲勝`
    subtitle.textContent = reasonOverride || (winner.color ? `${COLOR_NAME[winner.color]}吃光對方所有棋子` : '吃光對方所有棋子')
  } else {
    title.textContent = '和局'
    subtitle.textContent = reasonOverride || '雙方連續 25 回合無吃子，或協議和棋'
  }

  const redCaptures = state.history.filter((h) => h.kind === 'capture' && h.pieceColor === 'red').length
  const blackCaptures = state.history.filter((h) => h.kind === 'capture' && h.pieceColor === 'black').length
  el('stat-turns').textContent = String(state.turnNumber)
  el('stat-red-captures').textContent = String(redCaptures)
  el('stat-black-captures').textContent = String(blackCaptures)
  el('stat-time').textContent = formatDuration(elapsedMs)
  openDialog('dialog-gameover')
}
