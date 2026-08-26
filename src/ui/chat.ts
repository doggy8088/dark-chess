import type { ChatMessage } from '../shared/protocol'
import { CANNED_MESSAGES } from '../shared/canned'
import { el } from './dom'

export interface ChatPanelCallbacks {
  onSend(text: string): void
  onCanned(id: string): void
  /** Seat name lookup for message attribution. */
  nameFor(seat: 0 | 1): string
}

/**
 * In-game chat drawer: text messages plus canned quick-chat chips.
 * All message content is rendered via textContent — never innerHTML.
 */
export class ChatPanel {
  private readonly drawer = el('chat-drawer')
  private readonly list = el('chat-list')
  private readonly input = el<HTMLInputElement>('chat-input')
  private readonly badge = el('chat-unread')
  private readonly toggleButton = el<HTMLButtonElement>('btn-chat')
  private unread = 0
  private mySeat: 0 | 1 | null = null
  private myName = ''

  constructor(private readonly callbacks: ChatPanelCallbacks) {
    this.toggleButton.addEventListener('click', () => this.toggle())
    el('btn-chat-close').addEventListener('click', () => this.hide())

    const form = el<HTMLFormElement>('chat-form')
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = this.input.value.trim()
      if (!text) return
      this.callbacks.onSend(text)
      this.input.value = ''
    })

    const cannedRow = el('chat-canned')
    cannedRow.textContent = ''
    for (const canned of CANNED_MESSAGES) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'canned-chip'
      chip.textContent = canned.text
      chip.addEventListener('click', () => this.callbacks.onCanned(canned.id))
      cannedRow.append(chip)
    }
  }

  /** Who am I in this room — a seat, or a named spectator (seat null). */
  setSelf(seat: 0 | 1 | null, myName: string): void {
    this.mySeat = seat
    this.myName = myName
  }

  setHistory(messages: ChatMessage[]): void {
    this.list.textContent = ''
    for (const msg of messages) this.append(msg)
    this.scrollToEnd()
  }

  addMessage(msg: ChatMessage): void {
    this.append(msg)
    this.scrollToEnd()
    if (this.drawer.hidden && !this.isMine(msg)) {
      this.unread += 1
      this.badge.textContent = String(Math.min(this.unread, 99))
      this.badge.hidden = false
    }
  }

  private isMine(msg: ChatMessage): boolean {
    if (msg.from === 'spectator') return this.mySeat === null && msg.name === this.myName
    return msg.from === this.mySeat
  }

  /** System line (grey, centered): presence changes, rate-limit notices… */
  addNotice(text: string): void {
    const item = document.createElement('li')
    item.className = 'chat-notice'
    item.textContent = text
    this.list.append(item)
    this.scrollToEnd()
  }

  private append(msg: ChatMessage): void {
    const item = document.createElement('li')
    const mine = this.isMine(msg)
    item.className = `chat-msg ${mine ? 'mine' : 'theirs'}${msg.kind === 'canned' ? ' canned' : ''}`

    const who = document.createElement('span')
    who.className = 'chat-who'
    who.textContent = msg.from === 'spectator' ? `${msg.name ?? '觀眾'}（觀眾）` : this.callbacks.nameFor(msg.from)

    const bubble = document.createElement('span')
    bubble.className = 'chat-bubble'
    bubble.textContent = msg.text

    item.append(who, bubble)
    this.list.append(item)
  }

  private scrollToEnd(): void {
    this.list.scrollTop = this.list.scrollHeight
  }

  toggle(): void {
    if (this.drawer.hidden) this.show()
    else this.hide()
  }

  show(): void {
    this.drawer.hidden = false
    this.unread = 0
    this.badge.hidden = true
    this.toggleButton.setAttribute('aria-expanded', 'true')
  }

  hide(): void {
    this.drawer.hidden = true
    this.toggleButton.setAttribute('aria-expanded', 'false')
  }

  reset(): void {
    this.list.textContent = ''
    this.input.value = ''
    this.unread = 0
    this.badge.hidden = true
    this.hide()
  }
}
