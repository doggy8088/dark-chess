import type { ClientMessage, ServerMessage } from '../shared/protocol'

export interface SocketCallbacks {
  onMessage(msg: ServerMessage): void
  /** Fired on every (re)connect — the session re-sends its join here. */
  onOpen(): void
  /** Fired when the connection drops and a reconnect attempt is scheduled. */
  onDisconnected(): void
}

/**
 * WebSocket with automatic reconnection (exponential backoff 1s → 10s).
 * Cloud Run severs even active connections at its request timeout, so
 * reconnecting transparently is part of normal operation, not just failure
 * handling. Returning to a hidden tab kicks an immediate retry.
 */
export class ReconnectingSocket {
  private ws: WebSocket | null = null
  private retryDelay = 1000
  private retryTimer = 0
  private closed = false
  private readonly onVisibility = () => {
    if (!document.hidden && !this.isOpen && !this.closed) this.connectNow()
  }

  constructor(private readonly callbacks: SocketCallbacks) {
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): void {
    this.closed = false
    this.connectNow()
  }

  private connectNow(): void {
    window.clearTimeout(this.retryTimer)
    if (this.closed || this.isOpen || this.ws?.readyState === WebSocket.CONNECTING) return
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${location.host}/ws`)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.retryDelay = 1000
      this.callbacks.onOpen()
    })
    ws.addEventListener('message', (event) => {
      try {
        this.callbacks.onMessage(JSON.parse(String(event.data)) as ServerMessage)
      } catch {
        // Malformed frame — ignore.
      }
    })
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null
      if (this.closed) return
      this.callbacks.onDisconnected()
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      ws.close()
    })
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => this.connectNow(), this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 1.7, 10_000)
  }

  send(msg: ClientMessage): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg))
  }

  close(): void {
    this.closed = true
    window.clearTimeout(this.retryTimer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.ws?.close()
    this.ws = null
  }
}
