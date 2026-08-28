import type { ChatMessage, PresenceInfo, RedactedStateDTO, SpectatorPresence } from '../shared/protocol'
import type { GameState } from '../game/types'
import { CANNED_MESSAGES, type CannedMessage } from '../shared/canned'
import { fisherYatesShuffle } from '../game/shuffle'
import { el } from './dom'

/** Canned quick-chat chips reshuffle on this cadence so the same few
 *  sentences don't always sit first for everyone. */
const CANNED_SHUFFLE_INTERVAL_MS = 15_000

export interface ChatPanelCallbacks {
  onSend(text: string): void
  onCanned(id: string): void
  /** Seat name lookup for message attribution. */
  nameFor(seat: 0 | 1): string
}

const strokeCollator = new Intl.Collator('zh-Hant-TW-u-co-stroke', { numeric: true, sensitivity: 'base' })

/**
 * In-game drawer with tabbed views:
 * 1. 聊天室 (Chat messages + canned quick-chat chips + input form)
 * 2. 人員 (Room participants: Red/Black players at the top, spectators sorted by Chinese stroke order)
 *
 * All text content is rendered via textContent / createTextNode — never innerHTML.
 */
export class ChatPanel {
  private readonly drawer = el('chat-drawer')
  private readonly list = el('chat-list')
  private readonly input = el<HTMLInputElement>('chat-input')
  private readonly badge = el('chat-unread')
  private readonly tabBadge = el('chat-tab-unread')
  private readonly toggleButton = el<HTMLButtonElement>('btn-chat')

  private readonly tabChat = el<HTMLButtonElement>('tab-chat')
  private readonly tabMembers = el<HTMLButtonElement>('tab-members')
  private readonly panelChat = el('tabpanel-chat')
  private readonly panelMembers = el('tabpanel-members')
  private readonly membersCount = el('members-count')
  private readonly spectatorsCountSub = el('spectators-count-sub')
  private readonly playersList = el('members-players-list')
  private readonly spectatorsList = el('members-spectators-list')

  private unread = 0
  private mySeat: 0 | 1 | null = null
  private myName = ''
  private activeTab: 'chat' | 'members' = 'chat'
  private lastPresence: PresenceInfo | null = null
  private lastState: GameState | RedactedStateDTO | null = null

  constructor(private readonly callbacks: ChatPanelCallbacks) {
    this.toggleButton.addEventListener('click', () => this.toggle())
    el('btn-chat-close').addEventListener('click', () => this.hide())
    this.wireDrag()

    this.tabChat.addEventListener('click', () => this.switchTab('chat'))
    this.tabMembers.addEventListener('click', () => this.switchTab('members'))

    // Escape closes the drawer — unless a modal dialog is up (Escape is its job).
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.drawer.hidden && !document.querySelector('dialog[open]')) {
        this.hide()
      }
    })

    const form = el<HTMLFormElement>('chat-form')
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = this.input.value.trim()
      if (!text) return
      this.callbacks.onSend(text)
      this.input.value = ''
    })

    this.wireResize()
    this.applySavedSize()

    const cannedRow = el('chat-canned')
    const reshuffleCanned = (): void => this.renderCannedChips(cannedRow, fisherYatesShuffle(CANNED_MESSAGES))
    reshuffleCanned()
    window.setInterval(reshuffleCanned, CANNED_SHUFFLE_INTERVAL_MS)
  }

  /** Rebuilds the quick-chat chips in the given (shuffled) order. */
  private renderCannedChips(row: HTMLElement, order: readonly CannedMessage[]): void {
    row.textContent = ''
    for (const canned of order) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'canned-chip'
      chip.textContent = canned.text
      chip.addEventListener('click', () => this.callbacks.onCanned(canned.id))
      row.append(chip)
    }
  }

  /** Who am I in this room — a seat, or a named spectator (seat null). */
  setSelf(seat: 0 | 1 | null, myName: string): void {
    this.mySeat = seat
    this.myName = myName
    this.renderMembers()
  }

  updatePresence(presence: PresenceInfo, state?: GameState | RedactedStateDTO): void {
    this.lastPresence = presence
    if (state) this.lastState = state
    this.renderMembers()
  }

  updateState(state: GameState | RedactedStateDTO): void {
    this.lastState = state
    this.renderMembers()
  }

  switchTab(tab: 'chat' | 'members'): void {
    this.activeTab = tab
    if (tab === 'chat') {
      this.tabChat.classList.add('active')
      this.tabChat.setAttribute('aria-selected', 'true')
      this.tabMembers.classList.remove('active')
      this.tabMembers.setAttribute('aria-selected', 'false')
      this.panelChat.hidden = false
      this.panelMembers.hidden = true
      this.clearUnread()
      this.scrollToEnd()
    } else {
      this.tabMembers.classList.add('active')
      this.tabMembers.setAttribute('aria-selected', 'true')
      this.tabChat.classList.remove('active')
      this.tabChat.setAttribute('aria-selected', 'false')
      this.panelChat.hidden = true
      this.panelMembers.hidden = false
      this.renderMembers()
    }
  }

  private clearUnread(): void {
    this.unread = 0
    this.badge.hidden = true
    this.tabBadge.hidden = true
  }

  setHistory(messages: ChatMessage[]): void {
    this.list.textContent = ''
    for (const msg of messages) this.append(msg)
    this.scrollToEnd()
  }

  addMessage(msg: ChatMessage): void {
    this.append(msg)
    this.scrollToEnd()
    if (!this.isMine(msg)) {
      if (this.drawer.hidden) {
        this.unread += 1
        this.badge.textContent = String(Math.min(this.unread, 99))
        this.badge.hidden = false
        this.tabBadge.textContent = String(Math.min(this.unread, 99))
        this.tabBadge.hidden = false
      } else if (this.activeTab === 'members') {
        this.unread += 1
        this.tabBadge.textContent = String(Math.min(this.unread, 99))
        this.tabBadge.hidden = false
      }
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

  show(tab?: 'chat' | 'members'): void {
    this.drawer.hidden = false
    this.toggleButton.setAttribute('aria-expanded', 'true')
    if (window.matchMedia('(min-width: 1024px)').matches) {
      this.applySavedSize()
    } else {
      // Mobile uses the CSS bottom sheet — never carry desktop inline sizes over.
      this.drawer.style.removeProperty('width')
      this.drawer.style.removeProperty('height')
    }
    if (tab) {
      this.switchTab(tab)
    } else if (this.activeTab === 'chat') {
      this.clearUnread()
    }
  }

  hide(): void {
    this.drawer.hidden = true
    this.toggleButton.setAttribute('aria-expanded', 'false')
  }

  reset(): void {
    this.list.textContent = ''
    this.input.value = ''
    this.clearUnread()
    this.lastPresence = null
    this.lastState = null
    this.activeTab = 'chat'
    this.switchTab('chat')
    this.playersList.textContent = ''
    this.spectatorsList.textContent = ''
    this.hide()
    // Back to the CSS-anchored position for the next room.
    for (const prop of ['left', 'top', 'right', 'bottom', 'width'] as const) {
      this.drawer.style.removeProperty(prop)
    }
  }

  renderMembers(): void {
    const presence = this.lastPresence
    const state = this.lastState

    this.playersList.textContent = ''
    this.spectatorsList.textContent = ''

    if (!presence) {
      this.membersCount.textContent = '(0)'
      return
    }

    // Determine seat colors if assigned
    const color0 = state?.players[0]?.color ?? null
    const color1 = state?.players[1]?.color ?? null

    const seatItems: {
      seat: 0 | 1
      name: string
      color: 'red' | 'black' | null
      connected: boolean
      graceDeadlineAt?: number
    }[] = [
      {
        seat: 0,
        name: presence.seats[0].name,
        color: color0,
        connected: presence.seats[0].connected,
        graceDeadlineAt: presence.seats[0].graceDeadlineAt,
      },
      {
        seat: 1,
        name: presence.seats[1].name,
        color: color1,
        connected: presence.seats[1].connected,
        graceDeadlineAt: presence.seats[1].graceDeadlineAt,
      },
    ]

    // Red and Black players are pinned at the top.
    // If colors are determined, sort Red first then Black.
    if (color0 && color1) {
      seatItems.sort((a, b) => {
        if (a.color === 'red') return -1
        if (b.color === 'red') return 1
        return 0
      })
    }

    for (const s of seatItems) {
      const li = document.createElement('li')
      li.className = 'member-item'

      const chip = document.createElement('span')
      const isRed = s.color === 'red'
      const isBlack = s.color === 'black'
      chip.className = `member-chip ${isRed ? 'chip-red' : isBlack ? 'chip-black' : 'chip-unassigned'}`
      chip.textContent = isRed ? '紅' : isBlack ? '黑' : s.seat === 0 ? '一' : '二'

      const info = document.createElement('div')
      info.className = 'member-info'

      const name = document.createElement('span')
      name.className = 'member-name'
      name.textContent = s.name
      info.append(name)

      if (s.color) {
        const role = document.createElement('span')
        role.className = 'member-role'
        role.textContent = s.color === 'red' ? '（紅方）' : '（黑方）'
        info.append(role)
      }

      if (this.mySeat === s.seat) {
        const you = document.createElement('span')
        you.className = 'member-you'
        you.textContent = '你'
        info.append(you)
      }

      const status = document.createElement('span')
      const dot = document.createElement('span')
      dot.className = 'status-dot'

      if (s.name === '等待中') {
        status.className = 'member-status waiting'
        status.append(dot, document.createTextNode('等待加入'))
      } else if (s.connected) {
        status.className = 'member-status online'
        status.append(dot, document.createTextNode('連線中'))
      } else if (s.graceDeadlineAt) {
        status.className = 'member-status waiting'
        status.append(dot, document.createTextNode('斷線重連中'))
      } else {
        status.className = 'member-status offline'
        status.append(dot, document.createTextNode('離線'))
      }

      li.append(chip, info, status)
      this.playersList.append(li)
    }

    // Spectators: sort by stroke count (筆畫排序)，但「自己」永遠排在第一位。
    const spectators: SpectatorPresence[] = presence.spectatorList ?? []
    const isMe = (spec: SpectatorPresence): boolean => this.mySeat === null && spec.name === this.myName
    const sortedSpectators = [...spectators].sort((a, b) => {
      if (isMe(a) !== isMe(b)) return isMe(a) ? -1 : 1
      return strokeCollator.compare(a.name, b.name)
    })

    this.spectatorsCountSub.textContent = `(${sortedSpectators.length})`

    if (sortedSpectators.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'members-empty'
      empty.textContent = '目前無觀戰人員'
      this.spectatorsList.append(empty)
    } else {
      for (const spec of sortedSpectators) {
        const li = document.createElement('li')
        li.className = 'member-item'

        const chip = document.createElement('span')
        chip.className = 'member-chip chip-spectator'
        chip.textContent = '觀'

        const info = document.createElement('div')
        info.className = 'member-info'

        const name = document.createElement('span')
        name.className = 'member-name'
        name.textContent = spec.name
        info.append(name)

        if (this.mySeat === null && spec.name === this.myName) {
          const you = document.createElement('span')
          you.className = 'member-you'
          you.textContent = '你'
          info.append(you)
        }

        const status = document.createElement('span')
        status.className = 'member-status online'
        const dot = document.createElement('span')
        dot.className = 'status-dot'
        status.append(dot, document.createTextNode('觀戰中'))

        li.append(chip, info, status)
        this.spectatorsList.append(li)
      }
    }

    const connectedPlayersCount = (presence.seats[0].connected ? 1 : 0) + (presence.seats[1].connected ? 1 : 0)
    const totalCount = connectedPlayersCount + sortedSpectators.length
    this.membersCount.textContent = `(${totalCount})`
  }

  /** Drag the drawer anywhere by its header. First drag detaches it from its
   * CSS anchors (bottom sheet / side panel) into free left/top positioning. */
  private wireDrag(): void {
    const handle = el('chat-drag-handle')
    handle.style.cursor = 'grab'
    handle.style.touchAction = 'none'
    let dragging = false
    let offsetX = 0
    let offsetY = 0

    handle.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('button')) return
      const rect = this.drawer.getBoundingClientRect()
      this.drawer.style.width = `${rect.width}px`
      this.drawer.style.left = `${rect.left}px`
      this.drawer.style.top = `${rect.top}px`
      this.drawer.style.right = 'auto'
      this.drawer.style.bottom = 'auto'
      offsetX = event.clientX - rect.left
      offsetY = event.clientY - rect.top
      dragging = true
      handle.setPointerCapture(event.pointerId)
      handle.style.cursor = 'grabbing'
      event.preventDefault()
    })
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const width = this.drawer.offsetWidth
      // Keep at least a grabbable sliver inside the viewport.
      const left = Math.min(Math.max(event.clientX - offsetX, 72 - width), window.innerWidth - 72)
      const top = Math.min(Math.max(event.clientY - offsetY, 0), window.innerHeight - 48)
      this.drawer.style.left = `${left}px`
      this.drawer.style.top = `${top}px`
    })
    const stop = () => {
      dragging = false
      handle.style.cursor = 'grab'
    }
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  /** Resizable drawer (desktop only): the bottom-right grip adjusts width/height. */
  private wireResize(): void {
    const handle = el('chat-resize-handle')
    handle.style.touchAction = 'none'
    let resizing = false
    let startPointerX = 0
    let startPointerY = 0
    let startWidth = 0
    let startHeight = 0
    let anchorLeft = 0
    let anchorBottom = 0

    handle.addEventListener('pointerdown', (event) => {
      const rect = this.drawer.getBoundingClientRect()
      resizing = true
      startPointerX = event.clientX
      startPointerY = event.clientY
      startWidth = rect.width
      startHeight = rect.height
      anchorLeft = rect.left
      anchorBottom = rect.bottom
      handle.setPointerCapture(event.pointerId)
      event.preventDefault()
    })
    handle.addEventListener('pointermove', (event) => {
      if (!resizing) return
      const maxWidth = Math.max(320, window.innerWidth - anchorLeft - 8)
      const maxHeight = Math.max(260, anchorBottom - 8)
      const width = Math.round(Math.min(Math.max(startWidth + (event.clientX - startPointerX), 320), maxWidth))
      const height = Math.round(Math.min(Math.max(startHeight + (event.clientY - startPointerY), 260), maxHeight))
      this.drawer.style.width = `${width}px`
      this.drawer.style.height = `${height}px`
    })
    const stop = () => {
      if (!resizing) return
      resizing = false
      try {
        localStorage.setItem('chatDrawerSize', JSON.stringify({ width: this.drawer.offsetWidth, height: this.drawer.offsetHeight }))
      } catch {
        // Storage unavailable — size simply won't persist.
      }
    }
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  /** Restores the remembered desktop size, if any. */
  private applySavedSize(): void {
    try {
      const saved = JSON.parse(localStorage.getItem('chatDrawerSize') ?? 'null') as { width?: number; height?: number } | null
      if (saved && typeof saved.width === 'number' && typeof saved.height === 'number' && saved.width >= 320 && saved.height >= 260) {
        this.drawer.style.width = `${Math.round(saved.width)}px`
        this.drawer.style.height = `${Math.round(saved.height)}px`
      }
    } catch {
      // Corrupted storage — keep CSS defaults.
    }
  }
}
