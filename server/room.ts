import type { Action, GameState, Piece } from '../src/game/types'
import { agreeDraw, applyAction, validateAction } from '../src/game/actions'
import { createGame, opponentIndex } from '../src/game/game-state'
import { createAllPieces } from '../src/game/pieces'
import { fisherYatesShuffle, secureRandomInt } from '../src/game/shuffle'
import { computeCommitmentHash, generateNonce } from '../src/game/fairness'
import { cannedText } from '../src/shared/canned'
import type {
  ChatMessage,
  ClientMessage,
  FairnessReveal,
  GameOverReason,
  PieceReveal,
  PresenceInfo,
  RoomStatus,
  Seat,
  SeatOrSpectator,
  ServerMessage,
  SpectatorPresence,
  TurnDeadline,
} from '../src/shared/protocol'
import {
  CHAT_BURST,
  CHAT_MAX_LENGTH,
  CHAT_MIN_GAP_MS,
  CHAT_TAIL_LENGTH,
  CHAT_WINDOW_MS,
  FINISHED_ROOM_TTL_MS,
  GRACE_MS,
  IDLE_ROOM_TTL_MS,
  TURN_MS,
} from './config'
import { newChatId, newPlayerToken } from './ids'
import { redactState } from './redact'
import { parseChat, type RoomDoc, type RoomStore } from './store'

/** Minimal socket surface so tests can drive rooms without real WebSockets. */
export interface ClientSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface RoomDeps {
  store: RoomStore
  now(): number
  onActivity?: () => void
}

interface SeatState {
  token: string
  name: string
  socket: ClientSocket | null
}

interface ChatLimiter {
  recent: number[]
  lastAt: number
}

/**
 * One live game room. Owns the authoritative GameState (opaque piece ids),
 * seat assignment, the turn clock, chat, and persistence write-through.
 *
 * Timing is deadline-timestamp based: setTimeout is only a best-effort
 * nudge (Cloud Run throttles CPU with no open requests), and every inbound
 * message, connection, or room load re-runs evaluate() so expired deadlines
 * are applied lazily and restarts recover for free.
 */
export class Room {
  readonly roomId: string
  status: RoomStatus
  state: GameState
  fairness: { identityLayout: string[]; nonce: string; hash: string }
  seats: [SeatState, SeatState | null]
  result: { reason: GameOverReason; winnerIndex: 0 | 1 | null } | null = null
  /** When the game finished; null until then, reset by a rematch. */
  finishedAt: number | null = null

  /** Turn clock. Exactly one of deadlineAt / pausedRemainingMs is set while playing. */
  private deadlineAt: number | null = null
  private pausedRemainingMs: number | null = null
  private graceDeadlineAt: number | null = null

  private chat: ChatMessage[] = []
  /** Connected spectators and their display names. */
  private readonly spectators = new Map<ClientSocket, string>()
  private readonly limiters = new Map<ClientSocket, ChatLimiter>()
  private drawOfferBy: Seat | null = null
  private abortOfferBy: Seat | null = null
  private rematchOfferBy: Seat | null = null
  private timerHandle: ReturnType<typeof setTimeout> | null = null
  readonly createdAt: number
  private persistChain: Promise<void> = Promise.resolve()

  private constructor(
    roomId: string,
    state: GameState,
    fairness: { identityLayout: string[]; nonce: string; hash: string },
    seats: [SeatState, SeatState | null],
    status: RoomStatus,
    createdAt: number,
    private readonly deps: RoomDeps,
  ) {
    this.roomId = roomId
    this.state = state
    this.fairness = fairness
    this.seats = seats
    this.status = status
    this.createdAt = createdAt
  }

  /** Shuffles a fresh board, relabels ids to opaque c00–c31, commits to the layout. */
  static async create(roomId: string, creatorName: string, deps: RoomDeps): Promise<Room> {
    const { state, fairness } = await Room.newGame(creatorName, '對手', secureRandomInt(2) as 0 | 1)
    const seats: [SeatState, SeatState | null] = [
      { token: newPlayerToken(), name: creatorName, socket: null },
      null,
    ]
    return new Room(roomId, state, fairness, seats, 'waiting', deps.now(), deps)
  }

  private static async newGame(
    name0: string,
    name1: string,
    firstPlayerIndex: 0 | 1,
  ): Promise<{ state: GameState; fairness: { identityLayout: string[]; nonce: string; hash: string } }> {
    const shuffled = fisherYatesShuffle(createAllPieces())
    const identityLayout = shuffled.map((p) => `${p.color}-${p.type}`)
    const layout: Piece[] = shuffled.map((p, i) => ({ ...p, id: `c${String(i).padStart(2, '0')}` }))
    const nonce = generateNonce()
    const hash = await computeCommitmentHash(identityLayout, nonce)
    const state = createGame({ playerNames: [name0, name1], firstPlayerIndex, layout })
    return { state, fairness: { identityLayout, nonce, hash } }
  }

  static fromDoc(doc: RoomDoc, deps: RoomDeps): Room {
    const state = JSON.parse(doc.stateJson) as GameState
    const seats: [SeatState, SeatState | null] = [
      { token: doc.seats[0].token, name: doc.seats[0].name, socket: null },
      doc.seats[1] ? { token: doc.seats[1].token, name: doc.seats[1].name, socket: null } : null,
    ]
    const room = new Room(doc.roomId, state, doc.fairness, seats, doc.status, doc.createdAt, deps)
    room.chat = parseChat(doc)
    room.result = doc.result
    room.finishedAt = doc.finishedAt ?? null
    room.deadlineAt = doc.turn.deadlineAt
    room.pausedRemainingMs = doc.turn.pausedRemainingMs
    room.graceDeadlineAt = doc.turn.graceDeadlineAt
    // Nobody is connected right after a restart, and the outage is not the
    // player's fault: a running turn clock pauses into a fresh grace window
    // (with at least a few seconds left to move), and a pending grace window
    // restarts from now. Deadlines expired during the outage never forfeit
    // anyone at load — only a full grace period with no rejoin does.
    if (room.status === 'playing') {
      const now = room.deps.now()
      if (room.deadlineAt !== null) {
        room.pausedRemainingMs = Math.max(room.deadlineAt - now, 10_000)
        room.deadlineAt = null
        room.graceDeadlineAt = now + GRACE_MS
      } else if (room.graceDeadlineAt !== null) {
        room.graceDeadlineAt = now + GRACE_MS
      }
    }
    room.evaluate()
    return room
  }

  toDoc(): RoomDoc {
    const now = this.deps.now()
    return {
      version: 1,
      roomId: this.roomId,
      status: this.status,
      stateJson: JSON.stringify(this.state),
      fairness: this.fairness,
      seats: [
        { token: this.seats[0].token, name: this.seats[0].name },
        this.seats[1] ? { token: this.seats[1].token, name: this.seats[1].name } : null,
      ],
      turn: {
        deadlineAt: this.deadlineAt,
        pausedRemainingMs: this.pausedRemainingMs,
        graceDeadlineAt: this.graceDeadlineAt,
      },
      chatJson: JSON.stringify(this.chat.slice(-CHAT_TAIL_LENGTH)),
      result: this.result,
      finishedAt: this.finishedAt,
      createdAt: this.createdAt,
      updatedAt: now,
      expireAt: this.status === 'finished' ? now + FINISHED_ROOM_TTL_MS : now + IDLE_ROOM_TTL_MS,
    }
  }

  get hasConnections(): boolean {
    return this.spectators.size > 0 || this.seats.some((s) => s?.socket)
  }

  get spectatorCount(): number {
    return this.spectators.size
  }

  // ------------------------------------------------------------------ join

  join(socket: ClientSocket, playerToken: string | undefined, name: string | undefined, spectate = false): void {
    this.evaluate()
    const statusBefore = this.status
    const seat = this.assignSeat(socket, playerToken, name, spectate)

    if (seat === 0 || seat === 1) {
      // Rejoining player-to-move resumes their paused clock.
      if (this.status === 'playing' && this.state.currentPlayerIndex === seat && this.pausedRemainingMs !== null) {
        this.deadlineAt = this.deps.now() + this.pausedRemainingMs
        this.pausedRemainingMs = null
        this.graceDeadlineAt = null
      }
    }

    this.send(socket, {
      t: 'joined',
      roomId: this.roomId,
      seat,
      playerToken: seat === 0 || seat === 1 ? this.seats[seat]!.token : undefined,
      roomStatus: this.status,
      state: redactState(this.state),
      deadline: this.currentDeadline(),
      chat: this.chat.slice(-CHAT_TAIL_LENGTH),
      presence: this.presence(),
      fairnessHash: this.fairness.hash,
      gameOver:
        this.status === 'finished' && this.result
          ? { reason: this.result.reason, winnerIndex: this.result.winnerIndex, fairnessReveal: this.fairnessReveal() }
          : null,
    })
    this.broadcast({ t: 'presence', presence: this.presence() }, socket)
    // The opponent just filled seat 1: tell the waiting creator to start.
    if (statusBefore === 'waiting' && this.status === 'playing') {
      this.broadcast({ t: 'state', state: redactState(this.state), deadline: this.currentDeadline() }, socket)
    } else if (this.deadlineAt !== null) {
      this.broadcast({ t: 'deadline', deadline: this.currentDeadline()! }, socket)
    }
    this.armTimer()
    this.persist()
  }

  private assignSeat(
    socket: ClientSocket,
    playerToken: string | undefined,
    name: string | undefined,
    spectate: boolean,
  ): SeatOrSpectator {
    // A returning player always reclaims their seat, spectate intent or not.
    for (const seat of [0, 1] as const) {
      const s = this.seats[seat]
      if (s && playerToken && s.token === playerToken) {
        if (s.socket && s.socket !== socket) {
          this.send(s.socket, { t: 'error', code: 'connected-elsewhere', message: '你已在其他視窗加入，此連線將中斷' })
          s.socket.close(4000, 'connected-elsewhere')
        }
        s.socket = socket
        return seat
      }
    }
    if (!this.seats[1] && !spectate) {
      const trimmed = (name ?? '').trim().slice(0, 12)
      const seatName = trimmed || '玩家二'
      this.seats[1] = { token: newPlayerToken(), name: seatName, socket }
      this.state.players[1].name = seatName
      if (this.status === 'waiting') {
        this.status = 'playing'
        this.startTurnClock()
      }
      return 1
    }
    this.spectators.set(socket, (name ?? '').trim().slice(0, 12) || '觀眾')
    return 'spectator'
  }

  disconnect(socket: ClientSocket): void {
    this.spectators.delete(socket)
    this.limiters.delete(socket)
    for (const seat of [0, 1] as const) {
      const s = this.seats[seat]
      if (s?.socket === socket) {
        s.socket = null
        // Pause the move clock when the player-to-move drops; the grace
        // window governs until they rejoin. Otherwise the 60s move clock
        // would always beat the 90s grace and the grace would be dead letter.
        if (this.status === 'playing' && this.seats[1] && this.state.currentPlayerIndex === seat && this.deadlineAt !== null) {
          this.pausedRemainingMs = Math.max(0, this.deadlineAt - this.deps.now())
          this.deadlineAt = null
          this.graceDeadlineAt = this.deps.now() + GRACE_MS
        }
      }
    }
    this.broadcast({ t: 'presence', presence: this.presence() })
    this.armTimer()
    this.persist()
  }

  // -------------------------------------------------------------- messages

  handleMessage(socket: ClientSocket, msg: ClientMessage): void {
    this.evaluate()
    const seat = this.seatOf(socket)
    if (seat === null) return

    // Chat is open to everyone in the room, spectators included.
    if (msg.t === 'chat') {
      this.handleChat(socket, seat, 'text', msg.text, undefined)
      return
    }
    if (msg.t === 'canned') {
      const text = cannedText(msg.id)
      if (text) this.handleChat(socket, seat, 'canned', text, msg.id)
      return
    }

    // Everything else influences the game — players only.
    if (!isSeated(seat)) return

    switch (msg.t) {
      case 'action':
        this.handleAction(socket, seat, msg.seq, msg.action)
        break
      case 'drawOffer':
        if (this.status !== 'playing') return
        if (this.drawOfferBy === this.other(seat)) {
          this.finishDrawAgreed()
        } else {
          this.drawOfferBy = seat
          this.broadcast({ t: 'drawOffered', by: seat })
        }
        break
      case 'drawResponse':
        if (this.status !== 'playing' || this.drawOfferBy !== this.other(seat)) return
        if (msg.accept) {
          this.finishDrawAgreed()
        } else {
          this.drawOfferBy = null
          this.broadcast({ t: 'drawRejected', by: seat })
        }
        break
      case 'resign':
        if (this.status !== 'playing') return
        this.finish('resign', this.other(seat))
        break
      case 'abortRequest':
        if (this.status !== 'playing') return
        // A disconnected opponent cannot consent — end the match directly.
        if (!this.seats[this.other(seat)]?.socket || this.abortOfferBy === this.other(seat)) {
          this.finish('aborted', null)
        } else {
          this.abortOfferBy = seat
          this.broadcast({ t: 'abortOffered', by: seat })
        }
        break
      case 'abortResponse':
        if (this.status !== 'playing' || this.abortOfferBy !== this.other(seat)) return
        if (msg.accept) {
          this.finish('aborted', null)
        } else {
          this.abortOfferBy = null
          this.broadcast({ t: 'abortRejected', by: seat })
        }
        break
      case 'rematch':
        if (this.status !== 'finished') return
        if (this.rematchOfferBy === this.other(seat)) {
          void this.startRematch()
        } else {
          this.rematchOfferBy = seat
          this.broadcast({ t: 'rematchOffered', by: seat })
        }
        break
      case 'rematchResponse':
        if (this.status !== 'finished' || this.rematchOfferBy !== this.other(seat)) return
        if (msg.accept) {
          void this.startRematch()
        } else {
          this.rematchOfferBy = null
          this.broadcast({ t: 'rematchRejected', by: seat })
        }
        break
      case 'join':
        // join is handled at the connection layer.
        break
    }
  }

  private handleAction(socket: ClientSocket, seat: Seat, seq: number, action: Action): void {
    if (this.status !== 'playing' || !this.seats[1]) {
      this.send(socket, { t: 'invalid', seq, message: this.status === 'waiting' ? '對手尚未加入' : '對局已結束' })
      return
    }
    if (this.state.currentPlayerIndex !== seat) {
      this.send(socket, { t: 'invalid', seq, message: '還沒輪到你' })
      return
    }
    const error = validateAction(this.state, action)
    if (error) {
      this.send(socket, { t: 'invalid', seq, message: error })
      return
    }

    let reveal: PieceReveal | undefined
    if (action.kind === 'flip') {
      const piece = this.state.pieces[action.pieceId]!
      reveal = { pieceId: piece.id, color: piece.color, type: piece.type }
    }
    this.state = applyAction(this.state, action)
    this.drawOfferBy = null
    this.abortOfferBy = null

    if (this.state.status !== 'playing') {
      this.status = 'finished'
      this.result = {
        reason: this.state.status === 'won' ? 'capture' : 'draw',
        winnerIndex: this.state.winnerIndex,
      }
      this.clearTurnClock()
    } else {
      this.startTurnClock()
    }

    const applied: ServerMessage = {
      t: 'actionApplied',
      by: seat,
      action,
      reveal,
      state: redactState(this.state),
      deadline: this.currentDeadline(),
    }
    for (const s of [0, 1] as const) {
      const target = this.seats[s]?.socket
      if (target) this.send(target, s === seat ? { ...applied, seq } : applied)
    }
    for (const spectator of this.spectators.keys()) this.send(spectator, applied)

    if (this.status === 'finished' && this.result) {
      this.broadcast({
        t: 'gameOver',
        state: redactState(this.state),
        reason: this.result.reason,
        winnerIndex: this.result.winnerIndex,
        fairnessReveal: this.fairnessReveal(),
      })
    }
    this.armTimer()
    this.persist()
  }

  private handleChat(
    socket: ClientSocket,
    from: Seat | 'spectator',
    kind: 'text' | 'canned',
    text: string,
    cannedId?: string,
  ): void {
    const stripped = Array.from(text).filter((ch) => { const code = ch.codePointAt(0) ?? 0; return code >= 32 && code !== 127 }).join("")
    const cleaned = stripped.trim().slice(0, CHAT_MAX_LENGTH)
    if (!cleaned) return
    const now = this.deps.now()
    let limiter = this.limiters.get(socket)
    if (!limiter) {
      limiter = { recent: [], lastAt: 0 }
      this.limiters.set(socket, limiter)
    }
    limiter.recent = limiter.recent.filter((t) => now - t < CHAT_WINDOW_MS)
    if (limiter.recent.length >= CHAT_BURST || now - limiter.lastAt < CHAT_MIN_GAP_MS) {
      this.send(socket, { t: 'error', code: 'rate-limited', message: '訊息太頻繁了，休息一下再聊' })
      return
    }
    limiter.recent.push(now)
    limiter.lastAt = now

    const name = from === 'spectator' ? (this.spectators.get(socket) ?? '觀眾') : undefined
    const msg: ChatMessage = { id: newChatId(), from, name, kind, text: cleaned, cannedId, at: now }
    this.chat.push(msg)
    if (this.chat.length > CHAT_TAIL_LENGTH * 2) this.chat = this.chat.slice(-CHAT_TAIL_LENGTH)
    this.broadcast({ t: 'chat', msg })
    this.persist()
  }

  // ------------------------------------------------------------ turn clock

  /** Fresh clock for the player to move; pauses immediately if they're offline. */
  private startTurnClock(): void {
    const seat = this.state.currentPlayerIndex
    if (this.seats[seat]?.socket) {
      this.deadlineAt = this.deps.now() + TURN_MS
      this.pausedRemainingMs = null
      this.graceDeadlineAt = null
    } else {
      this.deadlineAt = null
      this.pausedRemainingMs = TURN_MS
      this.graceDeadlineAt = this.deps.now() + GRACE_MS
    }
  }

  private clearTurnClock(): void {
    this.deadlineAt = null
    this.pausedRemainingMs = null
    this.graceDeadlineAt = null
  }

  private currentDeadline(): TurnDeadline | null {
    if (this.deadlineAt === null || this.status !== 'playing') return null
    return { seat: this.state.currentPlayerIndex, at: this.deadlineAt, serverNow: this.deps.now() }
  }

  /** Applies any expired deadline. Safe to call anytime, from anywhere. */
  evaluate(): void {
    if (this.status !== 'playing' || !this.seats[1]) return
    const now = this.deps.now()
    if (this.graceDeadlineAt !== null && now >= this.graceDeadlineAt) {
      this.finish('forfeit', this.other(this.state.currentPlayerIndex))
    } else if (this.deadlineAt !== null && now >= this.deadlineAt) {
      this.finish('timeout', this.other(this.state.currentPlayerIndex))
    }
  }

  private armTimer(): void {
    if (this.timerHandle) {
      clearTimeout(this.timerHandle)
      this.timerHandle = null
    }
    if (this.status !== 'playing') return
    const next = this.graceDeadlineAt ?? this.deadlineAt
    if (next === null) return
    const delay = Math.max(0, next - this.deps.now()) + 20
    this.timerHandle = setTimeout(() => {
      this.evaluate()
      this.armTimer()
      this.persist()
    }, delay)
    // Never keep the process alive just for a room timer.
    if (typeof this.timerHandle === 'object' && 'unref' in this.timerHandle) this.timerHandle.unref()
  }

  // --------------------------------------------------------------- endings

  private finishDrawAgreed(): void {
    this.state = agreeDraw(this.state)
    this.drawOfferBy = null
    this.finish('draw-agreed', null)
  }

  private finish(reason: GameOverReason, winnerIndex: 0 | 1 | null): void {
    if (this.status === 'finished') return
    this.status = 'finished'
    this.result = { reason, winnerIndex }
    this.finishedAt = this.deps.now()
    if (reason !== 'draw-agreed' && reason !== 'draw' && winnerIndex !== null) {
      this.state.status = 'won'
      this.state.winnerIndex = winnerIndex
    }
    this.clearTurnClock()
    this.broadcast({
      t: 'gameOver',
      state: redactState(this.state),
      reason,
      winnerIndex,
      fairnessReveal: this.fairnessReveal(),
    })
    this.armTimer()
    this.persist()
  }

  private async startRematch(): Promise<void> {
    if (!this.seats[1]) return
    this.rematchOfferBy = null
    this.drawOfferBy = null
    this.abortOfferBy = null
    // Swap who moves first so the previous first-mover doesn't keep the edge.
    const previousFirst = this.state.history.length > 0 ? this.state.history[0]!.playerIndex : this.state.currentPlayerIndex
    const nextFirst = opponentIndex(previousFirst)
    const { state, fairness } = await Room.newGame(this.seats[0].name, this.seats[1].name, nextFirst)
    this.state = state
    this.fairness = fairness
    this.result = null
    this.finishedAt = null
    this.status = 'playing'
    this.startTurnClock()
    this.broadcast({
      t: 'rematchStart',
      state: redactState(this.state),
      deadline: this.currentDeadline(),
      fairnessHash: this.fairness.hash,
    })
    this.armTimer()
    this.persist()
  }

  private fairnessReveal(): FairnessReveal {
    return { layout: this.fairness.identityLayout, nonce: this.fairness.nonce, hash: this.fairness.hash }
  }

  // -------------------------------------------------------------- plumbing

  private presence(): PresenceInfo {
    const seatInfo = (seat: Seat) => {
      const s = this.seats[seat]
      return {
        name: s?.name ?? '等待中',
        connected: Boolean(s?.socket),
        graceDeadlineAt:
          this.status === 'playing' && this.state.currentPlayerIndex === seat && this.graceDeadlineAt !== null && !s?.socket
            ? this.graceDeadlineAt
            : undefined,
      }
    }
    const spectatorList: SpectatorPresence[] = Array.from(this.spectators.values()).map((name) => ({ name }))
    return {
      seats: [seatInfo(0), seatInfo(1)],
      spectators: this.spectators.size,
      spectatorList,
    }
  }

  private seatOf(socket: ClientSocket): SeatOrSpectator | null {
    if (this.seats[0].socket === socket) return 0
    if (this.seats[1]?.socket === socket) return 1
    if (this.spectators.has(socket)) return 'spectator'
    return null
  }

  private other(seat: 0 | 1): 0 | 1 {
    return opponentIndex(seat)
  }

  private send(socket: ClientSocket, msg: ServerMessage): void {
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // A dying socket will surface via its close event.
    }
  }

  private broadcast(msg: ServerMessage, except?: ClientSocket): void {
    for (const s of [0, 1] as const) {
      const target = this.seats[s]?.socket
      if (target && target !== except) this.send(target, msg)
    }
    for (const spectator of this.spectators.keys()) {
      if (spectator !== except) this.send(spectator, msg)
    }
  }

  /** Write-through, serialized per room so a slow write can't be overtaken. */
  private persist(): void {
    const doc = this.toDoc()
    this.deps.onActivity?.()
    this.persistChain = this.persistChain
      .then(() => this.deps.store.save(doc))
      .catch((error: unknown) => {
        console.error(`room ${this.roomId}: persist failed`, error)
      })
  }

  dispose(): void {
    if (this.timerHandle) clearTimeout(this.timerHandle)
    this.timerHandle = null
  }
}

// A message-only seat check: chat and game control are for seated players.
// Spectators can watch but not speak or act (v1).
export function isSeated(seat: SeatOrSpectator | null): seat is Seat {
  return seat === 0 || seat === 1
}
