import type { Action, GameState, Piece } from '../game/types'
import type {
  AnnouncementInfo,
  ChatMessage,
  FairnessReveal,
  GameOverReason,
  PresenceInfo,
  RedactedStateDTO,
  SeatOrSpectator,
  ServerMessage,
  TurnDeadline,
} from '../shared/protocol'
import { ReconnectingSocket } from './socket'
import { loadRoomToken, saveRoomToken } from './tokens'

export interface GameOverInfo {
  reason: GameOverReason
  winnerIndex: 0 | 1 | null
  fairnessReveal: FairnessReveal
}

export interface OnlineSessionCallbacks {
  /** Room is waiting for the opponent — show the invite/waiting panel. */
  onWaiting(inviteUrl: string): void
  /** Both seats filled (first time or after rejoin): present this state. */
  onGameReady(state: GameState, hidden: Set<string>, options: { resumed: boolean }): void
  /** A confirmed action (mine or the opponent's) to animate. */
  onServerAction(action: Action, state: GameState, hidden: Set<string>, reveal?: { pieceId: string; color: Piece['color']; type: Piece['type'] }): void
  /** My pending action was rejected. */
  onActionRejected(message: string): void
  /** Game ended without a closing action (resign/timeout/forfeit/agreed draw). */
  onGameOverNow(state: GameState, hidden: Set<string>, info: GameOverInfo): void
  /** Countdown display; null clears it. */
  onCountdown(remainingMs: number | null): void
  onChat(msg: ChatMessage): void
  onChatHistory(msgs: ChatMessage[]): void
  onPresence(presence: PresenceInfo): void
  onDrawOffered(): void
  onDrawRejected(): void
  onAbortOffered(): void
  onAbortRejected(): void
  onRematchOffered(): void
  onRematchRejected(): void
  onRematchStart(state: GameState, hidden: Set<string>): void
  /** Admin announcement requiring acknowledgement. */
  onAnnouncement(announcement: AnnouncementInfo): void
  /** Transport status for the reconnect overlay. */
  onConnectionChanged(connected: boolean): void
  onError(code: string, message: string): void
  /** It became my turn while the tab is hidden — nudge the player. */
  onYourTurnWhileHidden(): void
}

/** Converts the server's redacted DTO into an engine GameState. Hidden pieces
 * get a sentinel identity (rules never read the identity of face-down pieces)
 * and are listed in `hidden` so the renderer masks their faces. */
export function toClientState(dto: RedactedStateDTO): { state: GameState; hidden: Set<string> } {
  const pieces: Record<string, Piece> = {}
  const hidden = new Set<string>()
  for (const p of Object.values(dto.pieces)) {
    if (p.color !== undefined && p.type !== undefined) {
      pieces[p.id] = { id: p.id, color: p.color, type: p.type, faceUp: p.faceUp, captured: p.captured }
    } else {
      hidden.add(p.id)
      pieces[p.id] = { id: p.id, color: 'red', type: 'pawn', faceUp: false, captured: false }
    }
  }
  return {
    state: {
      board: [...dto.board],
      pieces,
      players: [{ ...dto.players[0] }, { ...dto.players[1] }],
      currentPlayerIndex: dto.currentPlayerIndex,
      status: dto.status,
      winnerIndex: dto.winnerIndex,
      turnNumber: dto.turnNumber,
      noCaptureTurnCount: dto.noCaptureTurnCount,
      history: dto.history,
    },
    hidden,
  }
}

/**
 * One online game, bound to a room URL. Owns the WebSocket, the seat token,
 * the countdown (server-clock corrected), and the message routing. Rendering
 * and screens stay in App/GameController — this class only translates
 * protocol events into the callbacks above.
 */
export class OnlineSession {
  seat: SeatOrSpectator = 'spectator'
  fairnessHash = ''
  gameOverInfo: GameOverInfo | null = null

  private readonly socket: ReconnectingSocket
  private roomStatus: 'waiting' | 'playing' | 'finished' = 'waiting'
  private started = false
  private seq = 1
  private deadline: TurnDeadline | null = null
  private clockOffset = 0
  private countdownTimer = 0
  private myName: string
  private everConnected = false

  constructor(
    readonly roomId: string,
    myName: string,
    private readonly callbacks: OnlineSessionCallbacks,
    /** Watch intent: never claim an empty seat, always enter as spectator. */
    private readonly spectate = false,
  ) {
    this.myName = myName.trim().slice(0, 12) || '玩家'
    this.socket = new ReconnectingSocket({
      onOpen: () => this.sendJoin(),
      onDisconnected: () => this.callbacks.onConnectionChanged(false),
      onMessage: (msg) => this.route(msg),
    })
  }

  get inviteUrl(): string {
    return `${location.origin}/r/${this.roomId}`
  }

  connect(): void {
    this.socket.connect()
    this.countdownTimer = window.setInterval(() => this.tickCountdown(), 250)
  }

  private sendJoin(): void {
    const token = loadRoomToken(this.roomId) ?? undefined
    this.socket.send({ t: 'join', roomId: this.roomId, playerToken: token, name: this.myName, spectate: this.spectate })
  }

  // -------------------------------------------------------------- outbound

  sendAction(action: Action): void {
    this.socket.send({ t: 'action', seq: this.seq++, action })
  }

  sendChat(text: string): void {
    this.socket.send({ t: 'chat', text })
  }

  sendCanned(id: string): void {
    this.socket.send({ t: 'canned', id })
  }

  offerDraw(): void {
    this.socket.send({ t: 'drawOffer' })
  }

  respondDraw(accept: boolean): void {
    this.socket.send({ t: 'drawResponse', accept })
  }

  requestAbort(): void {
    this.socket.send({ t: 'abortRequest' })
  }

  respondAbort(accept: boolean): void {
    this.socket.send({ t: 'abortResponse', accept })
  }

  resign(): void {
    this.socket.send({ t: 'resign' })
  }

  requestRematch(): void {
    this.socket.send({ t: 'rematch' })
  }

  respondRematch(accept: boolean): void {
    this.socket.send({ t: 'rematchResponse', accept })
  }

  sendAnnouncementAck(id: string): void {
    this.socket.send({ t: 'announcementAck', id })
  }

  // --------------------------------------------------------------- inbound

  private route(msg: ServerMessage): void {
    switch (msg.t) {
      case 'joined': {
        this.everConnected = true
        this.callbacks.onConnectionChanged(true)
        this.seat = msg.seat
        this.roomStatus = msg.roomStatus
        this.fairnessHash = msg.fairnessHash
        if (msg.playerToken && (msg.seat === 0 || msg.seat === 1)) {
          saveRoomToken(this.roomId, msg.playerToken)
        }
        this.setDeadline(msg.deadline)
        this.callbacks.onChatHistory(msg.chat)
        this.callbacks.onPresence(msg.presence)
        if (msg.announcement) {
          this.callbacks.onAnnouncement(msg.announcement)
        }
        if (msg.gameOver) {
          this.gameOverInfo = msg.gameOver
        }
        if (msg.roomStatus === 'waiting') {
          this.callbacks.onWaiting(this.inviteUrl)
        } else {
          const { state, hidden } = toClientState(msg.state)
          const resumed = this.started
          this.started = true
          this.callbacks.onGameReady(state, hidden, { resumed })
          if (msg.gameOver) {
            this.callbacks.onGameOverNow(state, hidden, msg.gameOver)
          }
        }
        break
      }
      case 'state': {
        const { state, hidden } = toClientState(msg.state)
        this.setDeadline(msg.deadline)
        if (this.roomStatus === 'waiting') {
          // The opponent just joined: the room is live now.
          this.roomStatus = 'playing'
          this.started = true
          this.callbacks.onGameReady(state, hidden, { resumed: false })
        } else {
          this.callbacks.onGameReady(state, hidden, { resumed: true })
        }
        break
      }
      case 'actionApplied': {
        const { state, hidden } = toClientState(msg.state)
        this.setDeadline(msg.deadline)
        this.callbacks.onServerAction(msg.action, state, hidden, msg.reveal)
        if (
          state.status === 'playing' &&
          document.hidden &&
          (this.seat === 0 || this.seat === 1) &&
          state.currentPlayerIndex === this.seat
        ) {
          this.callbacks.onYourTurnWhileHidden()
        }
        break
      }
      case 'invalid':
        this.callbacks.onActionRejected(msg.message)
        break
      case 'chat':
        this.callbacks.onChat(msg.msg)
        break
      case 'presence':
        this.callbacks.onPresence(msg.presence)
        break
      case 'announcement':
        this.callbacks.onAnnouncement({ id: msg.id, text: msg.text, at: msg.at })
        break
      case 'deadline':
        this.setDeadline(msg.deadline)
        break
      case 'drawOffered':
        if (this.isOpponent(msg.by)) this.callbacks.onDrawOffered()
        break
      case 'drawRejected':
        if (this.isOpponent(msg.by)) this.callbacks.onDrawRejected()
        break
      case 'abortOffered':
        if (this.isOpponent(msg.by)) this.callbacks.onAbortOffered()
        break
      case 'abortRejected':
        if (this.isOpponent(msg.by)) this.callbacks.onAbortRejected()
        break
      case 'rematchOffered':
        if (this.isOpponent(msg.by)) this.callbacks.onRematchOffered()
        break
      case 'rematchRejected':
        if (this.isOpponent(msg.by)) this.callbacks.onRematchRejected()
        break
      case 'rematchStart': {
        this.roomStatus = 'playing'
        this.gameOverInfo = null
        this.fairnessHash = msg.fairnessHash
        this.setDeadline(msg.deadline)
        const { state, hidden } = toClientState(msg.state)
        this.callbacks.onRematchStart(state, hidden)
        break
      }
      case 'gameOver': {
        this.roomStatus = 'finished'
        this.setDeadline(null)
        const info: GameOverInfo = {
          reason: msg.reason,
          winnerIndex: msg.winnerIndex,
          fairnessReveal: msg.fairnessReveal,
        }
        this.gameOverInfo = info
        // Endings driven by an action (capture win / 25-move draw) surface via
        // the controller's animation completion; everything else is immediate.
        if (msg.reason !== 'capture' && msg.reason !== 'draw') {
          const { state, hidden } = toClientState(msg.state)
          this.callbacks.onGameOverNow(state, hidden, info)
        }
        break
      }
      case 'error':
        this.callbacks.onError(msg.code, msg.message)
        break
    }
  }

  private isOpponent(by: 0 | 1): boolean {
    return this.seat === 0 || this.seat === 1 ? by !== this.seat : true
  }

  // -------------------------------------------------------------- countdown

  private setDeadline(deadline: TurnDeadline | null): void {
    this.deadline = deadline
    if (deadline) this.clockOffset = deadline.serverNow - Date.now()
    this.tickCountdown()
  }

  private tickCountdown(): void {
    if (!this.deadline || this.roomStatus !== 'playing') {
      this.callbacks.onCountdown(null)
      return
    }
    const serverNow = Date.now() + this.clockOffset
    this.callbacks.onCountdown(Math.max(0, this.deadline.at - serverNow))
  }

  get hasConnectedOnce(): boolean {
    return this.everConnected
  }

  dispose(): void {
    window.clearInterval(this.countdownTimer)
    this.socket.close()
  }
}
