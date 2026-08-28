import type { Action, Color, GameState, Piece, PieceType } from './game/types'
import { agreeDraw } from './game/actions'
import { createGame } from './game/game-state'
import { createAllPieces } from './game/pieces'
import { fisherYatesShuffle, secureRandomInt } from './game/shuffle'
import { createCommitment, type FairnessData } from './game/fairness'
import { GAME_OVER_REASON_TEXT, type GameSummary, type PresenceInfo } from './shared/protocol'
import { resolveNickname } from './shared/fun-names'
import { createSceneContext, isWebGLAvailable, type SceneContext } from './rendering/scene'
import { PhysicsWorld } from './physics/world'
import { GameController, type ControllerCallbacks } from './controller'
import { OnlineSession, type GameOverInfo } from './online/session'
import { ReconnectingSocket } from './online/socket'
import { loadRoomToken, saveRoomToken } from './online/tokens'
import { SoundPlayer } from './audio/sounds'
import { Hud } from './ui/hud'
import { ChatPanel } from './ui/chat'
import { setupOnlineLobby, showInvite } from './ui/online-lobby'
import { confirmDialog, openDialog, setupDialogs, showFairnessDialog, showGameOverDialog } from './ui/dialogs'
import { setupHomeAndSetupScreens, showError, showScreen } from './ui/setup'
import { el } from './ui/dom'
import {
  clearSavedGame,
  loadSavedGame,
  loadSettings,
  saveGame,
  saveSettings,
  type Settings,
} from './persistence/storage'

type AppPhase = 'LOADING' | 'HOME' | 'SETUP' | 'INITIALIZING' | 'PLAYING' | 'GAME_OVER'
type GameMode = 'hotseat' | 'online'

export interface BootOptions {
  /** Set when the page was opened via an invite URL (/r/:roomId). */
  joinRoomId?: string
}

export class App {
  private phase: AppPhase = 'LOADING'
  private mode: GameMode = 'hotseat'
  private physics!: PhysicsWorld
  private sceneContext: SceneContext | null = null
  private controller: GameController | null = null
  private readonly sounds = new SoundPlayer()
  private readonly hud = new Hud()
  private settings: Settings = loadSettings()
  private fairness: FairnessData | null = null
  private elapsedBaseMs = 0
  private playingSince: number | null = null
  private lastFrame = performance.now()
  private homeControls!: { setResumeAvailable(available: boolean): void }
  private lobbyControls!: { setCreating(busy: boolean): void; prefillName(): void }

  // Online state
  private online: OnlineSession | null = null
  private lobbySocket: ReconnectingSocket | null = null
  private prevLiveGames = new Map<string, { turnNumber: number; capturedRed: number; capturedBlack: number }>()
  private pendingJoinRoomId: string | null = null
  private pendingJoinIntent: 'play' | 'watch' = 'play'
  private myOnlineName = ''
  private onlineAvailable = false
  private chat!: ChatPanel
  private lastPresence: PresenceInfo | null = null
  private titleFlashTimer = 0
  private originalTitle = document.title

  async boot(options: BootOptions = {}): Promise<void> {
    const loadingBar = el('loading-bar-fill')
    const loadingText = el('loading-text')

    const versionLabel = `v${__APP_VERSION__}`
    el('app-version').textContent = versionLabel
    el('app-version-game').textContent = versionLabel

    if (!isWebGLAvailable()) {
      showError('無法啟動 3D 畫面', '你的瀏覽器不支援 WebGL。請改用支援 WebGL 的現代瀏覽器（Chrome、Safari、Edge、Firefox）。')
      return
    }

    loadingBar.style.width = '30%'
    loadingText.textContent = '正在載入物理引擎…'
    try {
      this.physics = await PhysicsWorld.create()
    } catch (error) {
      console.warn('Rapier 初始化失敗', error)
      showError('物理引擎初始化失敗', '無法載入物理引擎（WASM）。請確認網路連線後重新載入。')
      el('btn-error-reload').addEventListener('click', () => window.location.reload())
      return
    }

    loadingBar.style.width = '70%'
    loadingText.textContent = '正在準備棋盤…'

    this.sounds.enabled = this.settings.soundEnabled
    setupDialogs()
    this.chat = new ChatPanel({
      onSend: (text) => this.online?.sendChat(text),
      onCanned: (id) => this.online?.sendCanned(id),
      nameFor: (seat) => this.controller?.state?.players[seat]?.name ?? (seat === 0 ? '玩家一' : '玩家二'),
    })
    this.wireGameUi()
    this.wireOnlineUi()
    this.homeControls = setupHomeAndSetupScreens({
      onStart: (settings) => {
        this.settings = settings
        this.sounds.enabled = settings.soundEnabled
        void this.startNewGame()
      },
      onResume: () => this.resumeGame(),
      onShowRules: () => openDialog('dialog-rules'),
    })
    this.lobbyControls = setupOnlineLobby({
      onCreate: (name) => void this.createOnlineRoom(name),
      onBack: () => this.goHome(),
    })
    el('btn-error-reload').addEventListener('click', () => window.location.reload())
    this.detectOnlineAvailability()

    window.addEventListener('resize', () => this.handleResize())
    window.addEventListener('orientationchange', () => this.handleResize())
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange())
    window.addEventListener('beforeunload', () => this.persist())
    window.setInterval(() => {
      if (this.phase === 'PLAYING' && this.mode === 'hotseat') this.hud.setTimer(this.currentElapsedMs())
    }, 500)
    window.setInterval(() => {
      if (this.phase === 'HOME' && this.onlineAvailable && !document.hidden) void this.refreshLiveGames()
    }, 10_000)

    loadingBar.style.width = '100%'
    if (options.joinRoomId) {
      this.joinOnlineRoom(options.joinRoomId)
    } else {
      this.goHome()
    }
    requestAnimationFrame((time) => this.loop(time))
  }

  // ------------------------------------------------------------- lifecycle

  private goHome(): void {
    this.phase = 'HOME'
    this.leaveOnlineMode()
    this.pauseClock()
    this.homeControls.setResumeAvailable(loadSavedGame() !== null)
    showScreen('screen-home')
    if (this.onlineAvailable) {
      this.ensureLobbySocket()
      void this.refreshLiveGames()
    }
  }

  private ensureScene(): SceneContext {
    if (!this.sceneContext) {
      this.sceneContext = createSceneContext(el('board-container'))
    }
    return this.sceneContext
  }

  private ensureController(): GameController {
    const scene = this.ensureScene()
    if (!this.controller) {
      const app = this
      const callbacks: ControllerCallbacks = {
        onStateChanged: (state) => this.handleStateChanged(state),
        onGameOver: (state) => this.handleGameOver(state),
        onHint: (message) => this.hud.showHint(message),
        get actionSink() {
          // Online games send intents to the server; hotseat applies locally.
          return app.mode === 'online' && app.online
            ? (action: Action) => app.online?.sendAction(action)
            : undefined
        },
      }
      this.controller = new GameController(scene, this.physics, this.sounds, callbacks)
    }
    return this.controller
  }

  private async startNewGame(): Promise<void> {
    this.phase = 'INITIALIZING'
    this.setMode('hotseat')
    const layout = fisherYatesShuffle(createAllPieces())
    this.fairness = await createCommitment(layout)
    const firstPlayerIndex: 0 | 1 = this.settings.firstPlayer === 'random' ? (secureRandomInt(2) as 0 | 1) : 0
    const state = createGame({
      playerNames: this.settings.playerNames,
      firstPlayerIndex,
      layout,
    })
    this.elapsedBaseMs = 0
    this.beginSession(state, { intro: true })
    saveGame(state, this.fairness, 0)
    this.hud.showHint(`本局公平性承諾 SHA-256：${this.fairness.commitmentHash.slice(0, 18)}…（選單可驗證）`)
  }

  private resumeGame(): void {
    const saved = loadSavedGame()
    if (!saved) {
      this.homeControls.setResumeAvailable(false)
      return
    }
    this.setMode('hotseat')
    this.fairness = saved.fairness
    this.elapsedBaseMs = saved.elapsedMs
    this.beginSession(saved.state, { intro: false })
    this.hud.showHint('已還原上一局')
  }

  private beginSession(state: GameState, options: { intro: boolean }): void {
    this.closeLobbySocket()
    showScreen('screen-game')
    const controller = this.ensureController()
    if (this.mode === 'hotseat') {
      controller.localPlayerIndex = null
      controller.hiddenPieceIds = null
      controller.inputEnabled = true
    }
    this.sceneContext?.resize()
    controller.startSession(state, options)
    controller.onViewChanged()
    this.hud.reset()
    this.hud.update(state)
    if (this.mode === 'hotseat') this.hud.setTimer(this.currentElapsedMs())
    this.closeDrawer()
    this.phase = 'PLAYING'
    this.playingSince = performance.now()
    this.lastFrame = performance.now()
  }

  // ------------------------------------------------------------ game flow

  private handleStateChanged(state: GameState): void {
    this.hud.update(state)
    if (this.mode === 'hotseat' && this.fairness) saveGame(state, this.fairness, this.currentElapsedMs())
  }

  private handleGameOver(state: GameState, reasonOverride?: string): void {
    this.phase = 'GAME_OVER'
    this.pauseClock()
    if (this.mode === 'online') {
      this.showOnlineGameOver(state)
      return
    }
    clearSavedGame()
    const reason =
      reasonOverride ||
      (state.status === 'won'
        ? '吃光對方所有棋子'
        : state.noCaptureTurnCount >= 25
          ? '連續 25 步無吃子，判定和棋'
          : '雙方同意和棋')
    this.hud.update(state, reason)
    showGameOverDialog(state, this.elapsedBaseMs, reason)
  }

  private wireGameUi(): void {
    el('btn-menu').addEventListener('click', () => {
      this.updateSoundLabel()
      openDialog('dialog-menu')
    })

    el('btn-menu-sound').addEventListener('click', () => {
      this.sounds.enabled = !this.sounds.enabled
      this.settings.soundEnabled = this.sounds.enabled
      saveSettings(this.settings)
      this.updateSoundLabel()
    })

    for (const id of ['btn-menu-rules', 'btn-side-rules']) {
      el(id).addEventListener('click', () => openDialog('dialog-rules'))
    }
    for (const id of ['btn-menu-fairness', 'btn-side-fairness', 'btn-gameover-fairness']) {
      el(id).addEventListener('click', () => {
        if (this.mode === 'online') {
          this.showOnlineFairness()
          return
        }
        const state = this.controller?.state
        if (this.fairness && state) {
          showFairnessDialog(this.fairness, state.status !== 'playing', state.pieces)
        }
      })
    }

    el('btn-menu-draw').addEventListener('click', async () => {
      el<HTMLDialogElement>('dialog-menu').close()
      const state = this.controller?.state
      if (!state || state.status !== 'playing') return
      const agreed = await confirmDialog('雙方同意和棋', '兩位玩家都同意以和局結束本局嗎？')
      if (agreed && this.controller && this.controller.state.status === 'playing') {
        const drawn = agreeDraw(this.controller.state)
        this.controller.state = drawn
        this.handleGameOver(drawn, '雙方同意和棋')
      }
    })

    for (const id of ['btn-menu-restart', 'btn-side-restart']) {
      el(id).addEventListener('click', async () => {
        el<HTMLDialogElement>('dialog-menu').close()
        if (this.mode === 'online') return
        const playing = this.controller?.state.status === 'playing'
        const confirmed = !playing || (await confirmDialog('重新開始', '目前棋局將被清除，確定要重新開始一局嗎？'))
        if (confirmed) {
          clearSavedGame()
          void this.startNewGame()
        }
      })
    }

    for (const id of ['btn-menu-leave', 'btn-side-leave']) {
      el(id).addEventListener('click', async () => {
        el<HTMLDialogElement>('dialog-menu').close()
        await this.confirmLeaveGame()
      })
    }

    el('btn-again').addEventListener('click', () => {
      if (this.mode === 'online') {
        this.online?.requestRematch()
        this.setGameOverStatus('已送出「再來一局」邀請，等待對方同意…')
        return
      }
      el<HTMLDialogElement>('dialog-gameover').close()
      void this.startNewGame()
    })
    el('btn-gameover-stay').addEventListener('click', () => {
      el<HTMLDialogElement>('dialog-gameover').close()
      this.chat.show()
    })
    el('btn-gameover-home').addEventListener('click', () => {
      el<HTMLDialogElement>('dialog-gameover').close()
      this.goHome()
    })

    const drawer = el('history-drawer')
    const historyButton = el<HTMLButtonElement>('btn-history')
    historyButton.addEventListener('click', () => {
      drawer.hidden = !drawer.hidden
      historyButton.setAttribute('aria-expanded', String(!drawer.hidden))
    })
    el('btn-history-close').addEventListener('click', () => this.closeDrawer())
  }

  // -------------------------------------------------------------- online UI

  private wireOnlineUi(): void {
    el('btn-home-online').addEventListener('click', () => {
      this.lobbyControls.prefillName()
      showScreen('screen-online-setup')
    })
    el('btn-wait-cancel').addEventListener('click', () => this.goHome())
    el('btn-join-home').addEventListener('click', () => this.goHome())
    el<HTMLFormElement>('online-join-form').addEventListener('submit', (event) => {
      event.preventDefault()
      const roomId = this.pendingJoinRoomId
      if (!roomId) return
      const name = el<HTMLInputElement>('input-join-name').value.trim() || resolveNickname()
      this.settings.playerNames[0] = name
      saveSettings(this.settings)
      this.pendingJoinRoomId = null
      this.openOnlineSession(roomId, name, this.pendingJoinIntent === 'watch')
    })

    el('btn-menu-copylink').addEventListener('click', async () => {
      const url = this.online?.inviteUrl
      if (!url) return
      try {
        await navigator.clipboard.writeText(url)
        this.hud.showHint('已複製邀請連結')
      } catch {
        this.hud.showHint(url)
      }
      el<HTMLDialogElement>('dialog-menu').close()
    })

    el('btn-menu-offer-draw').addEventListener('click', () => {
      el<HTMLDialogElement>('dialog-menu').close()
      if (!this.isSeatedPlayer()) return
      if (this.online && this.controller?.state.status === 'playing') {
        this.online.offerDraw()
        this.hud.showHint('已向對手提出和棋，等待回應')
        this.chat.addNotice('你提出了和棋')
      }
    })

    el('btn-menu-resign').addEventListener('click', async () => {
      el<HTMLDialogElement>('dialog-menu').close()
      if (!this.isSeatedPlayer()) return
      if (!this.online || this.controller?.state.status !== 'playing') return
      const sure = await confirmDialog('認輸', '確定要認輸嗎？對手將獲得本局勝利。')
      if (sure) this.online.resign()
    })

    el('btn-menu-abort').addEventListener('click', async () => {
      el<HTMLDialogElement>('dialog-menu').close()
      if (!this.isSeatedPlayer()) return
      if (!this.online || this.controller?.state.status !== 'playing') return
      const opponentOnline = this.isOpponentConnected()
      const sure = await confirmDialog(
        '結束對戰',
        opponentOnline
          ? '將徵詢對方同意後結束本局（不計勝負）。確定要提出嗎？'
          : '對手目前離線，對戰將直接結束（不計勝負）。確定嗎？',
      )
      if (!sure) return
      this.online.requestAbort()
      if (opponentOnline) {
        this.hud.showHint('已徵詢對方是否同意結束對戰')
        this.chat.addNotice('你提出了結束對戰')
      }
    })
  }

  private async confirmLeaveGame(): Promise<void> {
    const isOnline = Boolean(this.online)
    const isPlaying = this.controller?.state.status === 'playing'
    const isSeated = this.isSeatedPlayer()

    let msg = '確定要離開目前對局並返回主選單嗎？'
    if (isOnline && isPlaying && isSeated) {
      msg = '離開後隨時可用同一個網址回到對局（若輪到你走棋，請注意限時）。確定要離開嗎？'
    } else if (isOnline) {
      msg = '確定要離開本房間並返回主選單嗎？'
    }

    const sure = await confirmDialog('離開遊戲', msg)
    if (sure) {
      if (!isOnline) this.persist()
      this.goHome()
    }
  }

  /** The online button appears only when a game server answers (not on the static GitHub Pages build). */
  private detectOnlineAvailability(): void {
    void fetch('/api/health', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
      .then(() => {
        this.onlineAvailable = true
        el('btn-home-online').hidden = false
        if (this.phase === 'HOME') {
          this.ensureLobbySocket()
          void this.refreshLiveGames()
        }
      })
      .catch(() => {
        this.onlineAvailable = false
        el('btn-home-online').hidden = true
        this.closeLobbySocket()
      })
  }

  private ensureLobbySocket(): void {
    if (this.lobbySocket || !this.onlineAvailable) return
    this.lobbySocket = new ReconnectingSocket({
      onOpen: () => {
        this.updateWarRoomBadge(true)
        this.lobbySocket?.send({ t: 'subscribeLobby' })
      },
      onDisconnected: () => {
        this.updateWarRoomBadge(false)
      },
      onMessage: (msg) => {
        if (msg.t === 'lobby') {
          this.renderLiveGames(msg.games)
        }
      },
    })
    this.lobbySocket.connect()
  }

  private closeLobbySocket(): void {
    this.lobbySocket?.close()
    this.lobbySocket = null
  }

  private updateWarRoomBadge(connected: boolean): void {
    const badge = document.getElementById('war-room-live-badge')
    if (badge) {
      badge.textContent = connected ? '即時連線中' : '重新連線中…'
      badge.classList.toggle('disconnected', !connected)
    }
  }

  /** Home-screen live-games board: fetch and render current matches. */
  private async refreshLiveGames(): Promise<void> {
    try {
      const res = await fetch('/api/games', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { games: GameSummary[] }
      this.renderLiveGames(data.games)
    } catch {
      // Offline or server hiccup — keep whatever is shown.
    }
  }

  private renderLiveGames(games: GameSummary[]): void {
    const block = el('live-games')
    const list = el<HTMLUListElement>('live-games-list')
    const statGames = document.getElementById('war-stat-games')
    const statPlayers = document.getElementById('war-stat-players')
    const statSpectators = document.getElementById('war-stat-spectators')

    if (games.length === 0) {
      block.hidden = true
      list.textContent = ''
      this.prevLiveGames.clear()
      return
    }

    block.hidden = false

    // Ended games linger on the board for a few minutes; live stats count battles only.
    const playingCount = games.filter((g) => g.status !== 'finished').length
    const totalSpectators = games.reduce((acc, g) => acc + g.spectators, 0)
    const totalPlayers = playingCount * 2
    if (statGames) statGames.textContent = String(playingCount)
    if (statPlayers) statPlayers.textContent = String(totalPlayers)
    if (statSpectators) statSpectators.textContent = String(totalSpectators)

    list.textContent = ''

    for (const game of games) {
      const remainingRed = 16 - game.capturedRed
      const remainingBlack = 16 - game.capturedBlack
      const totalCaptures = game.capturedRed + game.capturedBlack
      const isEnded = game.status === 'finished'
      const isTight = !isEnded && game.turnNumber >= 10 && Math.abs(remainingRed - remainingBlack) <= 1
      const isFierce = !isEnded && totalCaptures >= 12

      // Check if updated since last snapshot
      const prev = this.prevLiveGames.get(game.roomId)
      const hasUpdated =
        prev !== undefined &&
        (prev.turnNumber !== game.turnNumber ||
          prev.capturedRed !== game.capturedRed ||
          prev.capturedBlack !== game.capturedBlack)

      const card = document.createElement('li')
      card.className = 'war-card'
      if (isEnded) {
        card.classList.add('war-card-ended')
      }
      if (hasUpdated) {
        card.classList.add('war-card-updated')
      }

      // Card Header
      const header = document.createElement('div')
      header.className = 'war-card-header'

      const roomTag = document.createElement('span')
      roomTag.className = 'war-room-code'
      roomTag.textContent = `#${game.roomId.slice(-4).toUpperCase()}`

      const tags = document.createElement('div')
      tags.className = 'war-card-tags'

      const liveTag = document.createElement('span')
      if (isEnded) {
        liveTag.className = 'war-tag war-tag-ended'
        liveTag.textContent = '🏁 已結束'
      } else {
        liveTag.className = 'war-tag war-tag-live'
        liveTag.innerHTML = '<span class="war-dot" aria-hidden="true"></span>交戰中'
      }
      tags.append(liveTag)

      if (isTight) {
        const tightTag = document.createElement('span')
        tightTag.className = 'war-tag war-tag-tight'
        tightTag.textContent = '🔥 膠著'
        tags.append(tightTag)
      } else if (isFierce) {
        const fierceTag = document.createElement('span')
        fierceTag.className = 'war-tag war-tag-fierce'
        fierceTag.textContent = '⚔️ 激戰'
        tags.append(fierceTag)
      }

      if (game.spectators > 0) {
        const specTag = document.createElement('span')
        specTag.className = 'war-tag war-tag-spec'
        specTag.textContent = `👁️ ${game.spectators}`
        tags.append(specTag)
      }

      header.append(roomTag, tags)

      // Commanders Row
      const commanders = document.createElement('div')
      commanders.className = 'war-commanders'

      const p0 = game.players[0]
      const p1 = game.players[1]

      // Left Commander (Player 0)
      const cmdLeft = document.createElement('div')
      cmdLeft.className = `war-cmd-box ${p0.color ? (p0.color === 'red' ? 'is-red' : 'is-black') : 'is-neutral'}`
      const p0Name = document.createElement('div')
      p0Name.className = 'war-cmd-name'
      p0Name.textContent = p0.name
      const p0Role = document.createElement('div')
      p0Role.className = 'war-cmd-forces'
      if (p0.color === 'red') {
        p0Role.textContent = `紅方 · 剩 ${remainingRed} 兵`
      } else if (p0.color === 'black') {
        p0Role.textContent = `黑方 · 剩 ${remainingBlack} 兵`
      } else {
        p0Role.textContent = '陣營待定'
      }
      cmdLeft.append(p0Name, p0Role)

      // Center VS & Turn
      const centerVs = document.createElement('div')
      centerVs.className = 'war-vs-badge'
      const vsText = document.createElement('span')
      vsText.className = 'war-vs-text'
      vsText.textContent = 'VS'
      const turnText = document.createElement('span')
      turnText.className = 'war-turn-text'
      turnText.textContent = `第 ${game.turnNumber} 手`
      centerVs.append(vsText, turnText)

      // Right Commander (Player 1)
      const cmdRight = document.createElement('div')
      cmdRight.className = `war-cmd-box ${p1.color ? (p1.color === 'red' ? 'is-red' : 'is-black') : 'is-neutral'}`
      const p1Name = document.createElement('div')
      p1Name.className = 'war-cmd-name'
      p1Name.textContent = p1.name
      const p1Role = document.createElement('div')
      p1Role.className = 'war-cmd-forces'
      if (p1.color === 'red') {
        p1Role.textContent = `紅方 · 剩 ${remainingRed} 兵`
      } else if (p1.color === 'black') {
        p1Role.textContent = `黑方 · 剩 ${remainingBlack} 兵`
      } else {
        p1Role.textContent = '陣營待定'
      }
      cmdRight.append(p1Name, p1Role)

      commanders.append(cmdLeft, centerVs, cmdRight)

      // Force Balance Gauge
      const gaugeWrap = document.createElement('div')
      gaugeWrap.className = 'war-gauge-wrap'

      const gaugeBar = document.createElement('div')
      gaugeBar.className = 'war-gauge-bar'
      const totalRemaining = remainingRed + remainingBlack || 1
      const redPercent = Math.round((remainingRed / totalRemaining) * 100)
      const redFill = document.createElement('div')
      redFill.className = 'war-gauge-red'
      redFill.style.width = `${redPercent}%`
      const blackFill = document.createElement('div')
      blackFill.className = 'war-gauge-black'
      blackFill.style.width = `${100 - redPercent}%`
      gaugeBar.append(redFill, blackFill)

      const gaugeLabel = document.createElement('div')
      gaugeLabel.className = 'war-gauge-label'
      let advantageText = '雙方勢均力敵'
      if (remainingRed > remainingBlack) {
        advantageText = `紅方兵力領先 (+${remainingRed - remainingBlack})`
      } else if (remainingBlack > remainingRed) {
        advantageText = `黑方兵力領先 (+${remainingBlack - remainingRed})`
      }
      gaugeLabel.innerHTML = `<span>戰力天平</span><span class="war-advantage">${advantageText}</span>`

      gaugeWrap.append(gaugeBar, gaugeLabel)

      // Card Footer
      const footer = document.createElement('div')
      footer.className = 'war-card-footer'

      const statsInfo = document.createElement('div')
      statsInfo.className = 'war-card-stats'
      statsInfo.textContent = `已吃 ${totalCaptures} 子 · 紅損 ${game.capturedRed} / 黑損 ${game.capturedBlack}`

      const watch = document.createElement('button')
      watch.type = 'button'
      watch.className = 'btn btn-ghost btn-small war-btn-watch'
      watch.innerHTML = isEnded
        ? '觀看棋局 <span class="war-btn-arrow" aria-hidden="true">↗</span>'
        : '進入觀戰 <span class="war-btn-arrow" aria-hidden="true">↗</span>'
      watch.setAttribute('aria-label', `進入觀戰 ${p0.name} 對 ${p1.name}${isEnded ? '（已結束）' : ''}`)
      watch.addEventListener('click', () => {
        history.replaceState(null, '', `/r/${game.roomId}`)
        this.joinOnlineRoom(game.roomId, 'watch')
      })

      footer.append(statsInfo, watch)

      card.append(header, commanders, gaugeWrap, footer)
      list.append(card)
    }

    // Save snapshot for delta animation on next tick
    this.prevLiveGames.clear()
    for (const g of games) {
      this.prevLiveGames.set(g.roomId, {
        turnNumber: g.turnNumber,
        capturedRed: g.capturedRed,
        capturedBlack: g.capturedBlack,
      })
    }
  }

  private async createOnlineRoom(name: string): Promise<void> {
    this.lobbyControls.setCreating(true)
    // Remember the nickname so the next online game (and rejoin) reuses it.
    this.settings.playerNames[0] = name
    saveSettings(this.settings)
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { roomId: string; playerToken: string }
      saveRoomToken(data.roomId, data.playerToken)
      history.replaceState(null, '', `/r/${data.roomId}`)
      this.openOnlineSession(data.roomId, name)
    } catch (error) {
      console.warn('建立房間失敗', error)
      this.hud.showHint('建立房間失敗，請稍後再試')
      showError('建立房間失敗', '無法連線到對戰伺服器，請稍後再試。')
    } finally {
      this.lobbyControls.setCreating(false)
    }
  }

  /** Entry from an invite URL ('play') or a watch button ('watch').
   * Returning players (with a seat token) rejoin silently; everyone else
   * picks their nickname first — with wording that matches their intent. */
  private joinOnlineRoom(roomId: string, intent: 'play' | 'watch' = 'play'): void {
    if (loadRoomToken(roomId)) {
      this.openOnlineSession(roomId, this.settings.playerNames[0], intent === 'watch')
      return
    }
    this.pendingJoinRoomId = roomId
    this.pendingJoinIntent = intent
    this.setMode('online')
    el<HTMLInputElement>('input-join-name').value = resolveNickname(this.settings.playerNames[0])
    if (intent === 'watch') {
      el('join-title').textContent = '進入觀戰'
      el('join-desc').textContent = '輸入你的暱稱後進場觀戰——可以在聊天室裡幫喊加油，但不能下棋。'
      el('btn-join-go').textContent = '進入觀戰'
      el('join-rules-note').hidden = true
    } else {
      el('join-title').textContent = '加入對戰'
      el('join-desc').textContent = '輸入你的暱稱後加入對戰；若座位已滿，將以觀眾身分進場（可聊天，不能下棋）。'
      el('btn-join-go').textContent = '加入對戰'
      el('join-rules-note').hidden = false
    }
    showScreen('screen-online-join')
  }

  private openOnlineSession(roomId: string, myName: string, spectate = false): void {
    this.closeLobbySocket()
    this.online?.dispose()
    this.myOnlineName = myName
    this.setMode('online')
    el('invite-url').textContent = '連線中…'
    el<HTMLCanvasElement>('invite-qr').hidden = true
    showScreen('screen-online-wait')

    this.online = new OnlineSession(roomId, myName, {
      onWaiting: (inviteUrl) => {
        showScreen('screen-online-wait')
        showInvite(inviteUrl)
      },
      onGameReady: (state, hidden, { resumed }) => this.beginOnlineGame(state, hidden, { intro: !resumed }),
      onServerAction: (action, state, hidden, reveal) => {
        const controller = this.controller
        if (!controller || this.phase === 'HOME') return
        controller.hiddenPieceIds = hidden
        controller.applyServerAction(action, state, reveal)
        this.chat.updateState(state)
      },
      onActionRejected: (message) => this.controller?.rejectPendingAction(message),
      onGameOverNow: (state, hidden, info) => {
        const controller = this.ensureController()
        controller.hiddenPieceIds = hidden
        controller.state = state
        this.hud.update(state)
        this.chat.updateState(state)
        this.phase = 'GAME_OVER'
        this.pauseClock()
        this.showOnlineGameOver(state, info)
      },
      onCountdown: (remainingMs) => {
        if (this.mode === 'online') this.hud.setMoveCountdown(remainingMs)
      },
      onChat: (msg) => this.chat.addMessage(msg),
      onChatHistory: (msgs) => this.chat.setHistory(msgs),
      onPresence: (presence) => this.handlePresence(presence),
      onDrawOffered: () => void this.handleDrawOffered(),
      onDrawRejected: () => this.hud.showHint('對手婉拒了和棋'),
      onAbortOffered: () => void this.handleAbortOffered(),
      onAbortRejected: () => {
        this.hud.showHint('對方不同意結束對戰，繼續加油！')
        this.chat.addNotice('對方不同意結束對戰')
      },
      onRematchOffered: () => void this.handleRematchOffered(),
      onRematchRejected: () => this.setGameOverStatus('對方婉拒了再來一局'),
      onRematchStart: (state, hidden) => {
        el<HTMLDialogElement>('dialog-gameover').close()
        this.chat.addNotice('新的一局開始！')
        this.beginOnlineGame(state, hidden, { intro: true })
      },
      onConnectionChanged: (connected) => this.setConnectionOverlay(!connected),
      onError: (code, message) => this.handleOnlineError(code, message),
      onYourTurnWhileHidden: () => this.notifyYourTurn(),
    }, spectate)
    this.online.connect()
  }

  private beginOnlineGame(state: GameState, hidden: Set<string>, options: { intro: boolean }): void {
    const controller = this.ensureController()
    const seat = this.online?.seat
    controller.localPlayerIndex = seat === 0 || seat === 1 ? seat : null
    controller.inputEnabled = seat === 0 || seat === 1
    controller.hiddenPieceIds = hidden
    this.elapsedBaseMs = 0
    this.beginSession(state, options)
    this.chat.setSelf(seat === 0 || seat === 1 ? seat : null, this.myOnlineName)
    this.chat.updateState(state)
    // 桌面版進入對局時聊天抽屜預設開啟（左下角）
    if (window.matchMedia('(min-width: 1024px)').matches) this.chat.show()
    if (options.intro) {
      const mySeatName = seat === 0 || seat === 1 ? state.players[seat].name : null
      this.hud.showHint(mySeatName ? `${mySeatName}，對局開始！第一手翻出的顏色就是你的陣營` : '對局開始（觀戰中）')
    } else {
      this.hud.showHint('已重新連上對局')
    }
  }

  private handlePresence(presence: PresenceInfo): void {
    const previous = this.lastPresence
    this.lastPresence = presence
    this.chat.updatePresence(presence, this.controller?.state)
    const status = el('opponent-status')
    const mySeat = this.online?.seat
    if (mySeat !== 0 && mySeat !== 1) {
      status.hidden = true
      return
    }
    const opponent = presence.seats[mySeat === 0 ? 1 : 0]
    const opponentWasConnected = previous?.seats[mySeat === 0 ? 1 : 0]?.connected

    if (!opponent.connected && opponent.name !== '等待中') {
      status.hidden = false
      status.textContent = '對手已斷線'
      if (opponentWasConnected) this.chat.addNotice(`${opponent.name} 已斷線，等待重連…`)
    } else {
      status.hidden = true
      if (previous && opponentWasConnected === false && opponent.connected) {
        this.chat.addNotice(`${opponent.name} 已重新連線`)
      }
    }
  }

  private async handleDrawOffered(): Promise<void> {
    this.chat.addNotice('對手提出和棋')
    const accept = await confirmDialog('對手提出和棋', '接受以和局結束本局嗎？')
    this.online?.respondDraw(accept)
  }

  private async handleAbortOffered(): Promise<void> {
    this.chat.addNotice('對手想結束對戰')
    const accept = await confirmDialog('對手想結束對戰', '同意提前結束本局嗎？（不計勝負）')
    this.online?.respondAbort(accept)
  }

  /** Spectators can chat but never influence the game. */
  private isSeatedPlayer(): boolean {
    const seat = this.online?.seat
    if (seat === 0 || seat === 1) return true
    this.hud.showHint('觀戰模式無法進行此操作')
    return false
  }

  /** Live view of the opponent's connection, from the latest presence. */
  private isOpponentConnected(): boolean {
    const mySeat = this.online?.seat
    if (mySeat !== 0 && mySeat !== 1 || !this.lastPresence) return true
    return this.lastPresence.seats[mySeat === 0 ? 1 : 0].connected
  }

  private async handleRematchOffered(): Promise<void> {
    this.setGameOverStatus('對方想再來一局！')
    const accept = await confirmDialog('再來一局', '對手邀請你再來一局（換對方先手）。接受嗎？')
    this.online?.respondRematch(accept)
    if (!accept) this.setGameOverStatus('')
  }

  private showOnlineGameOver(state: GameState, infoOverride?: GameOverInfo): void {
    const info = infoOverride ?? this.online?.gameOverInfo ?? null
    const reasonText = info
      ? GAME_OVER_REASON_TEXT[info.reason]
      : state.status === 'won'
        ? '吃光對方所有棋子'
        : state.status === 'draw'
          ? '和局'
          : ''

    this.hud.update(state, reasonText)
    showGameOverDialog(state, this.currentElapsedMs(), reasonText)

    if (info) {
      if (info.winnerIndex !== null) {
        el('gameover-title').textContent = `${state.players[info.winnerIndex].name} 獲勝`
      } else if (info.reason === 'aborted') {
        el('gameover-title').textContent = '對戰結束'
      }
    }
    this.setGameOverStatus('')
    const isSeated = this.online?.seat === 0 || this.online?.seat === 1
    el<HTMLButtonElement>('btn-again').hidden = !isSeated

    // Post outcome notice in chat and hint
    let outcomeNotice = ''
    if (info) {
      if (info.winnerIndex !== null) {
        const winner = state.players[info.winnerIndex]
        outcomeNotice = `🏁 對局結束：${winner.name} 獲勝（${GAME_OVER_REASON_TEXT[info.reason]}）`
      } else if (info.reason === 'aborted') {
        outcomeNotice = `🏁 對局結束：對戰提前結束，不計勝負`
      } else {
        outcomeNotice = `🏁 對局結束：和局（${GAME_OVER_REASON_TEXT[info.reason]}）`
      }
    } else if (state.status === 'won' && state.winnerIndex !== null) {
      outcomeNotice = `🏁 對局結束：${state.players[state.winnerIndex].name} 獲勝`
    } else if (state.status === 'draw') {
      outcomeNotice = `🏁 對局結束：和局`
    }

    if (outcomeNotice) {
      this.chat.addNotice(outcomeNotice)
      this.hud.showHint(outcomeNotice)
    }
    this.chat.addNotice('歡迎留在聊天室繼續聊聊剛剛的戰局！')
  }

  private setGameOverStatus(text: string): void {
    const status = el('gameover-online-status')
    status.textContent = text
    status.hidden = !text
  }

  private showOnlineFairness(): void {
    const session = this.online
    if (!session) return
    const reveal = session.gameOverInfo?.fairnessReveal ?? null
    const data: FairnessData = {
      layout: reveal?.layout ?? [],
      nonce: reveal?.nonce ?? '',
      commitmentHash: session.fairnessHash,
    }
    const pieces: Record<string, Piece> = {}
    if (reveal) {
      for (const identity of reveal.layout) {
        const dash = identity.indexOf('-')
        const color = identity.slice(0, dash) as Color
        const type = identity.slice(dash + 1) as PieceType
        pieces[identity] = { id: identity, color, type, faceUp: true, captured: false }
      }
    }
    showFairnessDialog(data, reveal !== null, pieces)
  }

  private handleOnlineError(code: string, message: string): void {
    if (code === 'room-not-found') {
      this.online?.dispose()
      this.online = null
      history.replaceState(null, '', '/')
      showError('找不到對局', `${message}。房間可能已結束或連結有誤，請建立新的對戰邀請。`)
      return
    }
    if (code === 'connected-elsewhere') {
      this.online?.dispose()
      el('online-overlay-text').textContent = '你已在其他視窗加入這場對局，此分頁已停用。'
      el('online-overlay').hidden = false
      return
    }
    if (code === 'rate-limited') {
      this.chat.addNotice(message)
      return
    }
    this.hud.showHint(message)
  }

  private setConnectionOverlay(disconnected: boolean): void {
    if (this.mode !== 'online') return
    // Never cover the waiting/lobby screens — only an active game.
    const gameVisible = !el('screen-game').hidden
    el('online-overlay-text').textContent = '連線中斷，重新連線中…'
    el('online-overlay').hidden = !disconnected || !gameVisible || !this.online?.hasConnectedOnce
  }

  private notifyYourTurn(): void {
    this.sounds.play('flip')
    if (this.titleFlashTimer) return
    let on = false
    this.titleFlashTimer = window.setInterval(() => {
      on = !on
      document.title = on ? '🔔 輪到你了！' : this.originalTitle
    }, 1000)
  }

  private stopTitleFlash(): void {
    if (this.titleFlashTimer) {
      window.clearInterval(this.titleFlashTimer)
      this.titleFlashTimer = 0
      document.title = this.originalTitle
    }
  }

  private setMode(mode: GameMode): void {
    this.mode = mode
    document.body.classList.toggle('mode-online', mode === 'online')
  }

  private leaveOnlineMode(): void {
    if (this.online) {
      this.online.dispose()
      this.online = null
    }
    this.stopTitleFlash()
    this.lastPresence = null
    this.chat?.reset()
    el('online-overlay').hidden = true
    this.hud.setMoveCountdown(null)
    if (location.pathname.startsWith('/r/')) history.replaceState(null, '', '/')
    this.setMode('hotseat')
  }

  // ------------------------------------------------------------- plumbing

  private closeDrawer(): void {
    el('history-drawer').hidden = true
    el('btn-history').setAttribute('aria-expanded', 'false')
  }

  private updateSoundLabel(): void {
    el('btn-menu-sound').textContent = `音效：${this.sounds.enabled ? '開' : '關'}`
  }

  private currentElapsedMs(): number {
    const active = this.playingSince !== null ? performance.now() - this.playingSince : 0
    return Math.floor(this.elapsedBaseMs + active)
  }

  private pauseClock(): void {
    this.elapsedBaseMs = this.currentElapsedMs()
    this.playingSince = null
  }

  private handleVisibilityChange(): void {
    if (document.hidden) {
      this.persist()
      if (this.mode === 'hotseat') this.pauseClock()
    } else {
      this.stopTitleFlash()
      if (this.phase === 'PLAYING') {
        if (this.mode === 'hotseat' && this.playingSince === null) this.playingSince = performance.now()
        this.lastFrame = performance.now()
      }
    }
  }

  private persist(): void {
    if (this.mode !== 'hotseat') return
    const state = this.controller?.state
    if (state && this.fairness && state.status === 'playing') {
      saveGame(state, this.fairness, this.currentElapsedMs())
    }
  }

  private handleResize(): void {
    if (!this.sceneContext) return
    this.sceneContext.resize()
    this.controller?.onViewChanged()
  }

  private loop(time: number): void {
    requestAnimationFrame((next) => this.loop(next))
    const dt = Math.min((time - this.lastFrame) / 1000, 0.1)
    this.lastFrame = time
    if ((this.phase === 'PLAYING' || this.phase === 'GAME_OVER') && this.controller) {
      this.controller.frame(dt)
    }
  }
}
