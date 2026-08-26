import type { GameState } from './game/types'
import { agreeDraw } from './game/actions'
import { createGame } from './game/game-state'
import { createAllPieces } from './game/pieces'
import { fisherYatesShuffle, secureRandomInt } from './game/shuffle'
import { createCommitment, type FairnessData } from './game/fairness'
import { createSceneContext, isWebGLAvailable, type SceneContext } from './rendering/scene'
import { PhysicsWorld } from './physics/world'
import { GameController } from './controller'
import { SoundPlayer } from './audio/sounds'
import { Hud } from './ui/hud'
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

export class App {
  private phase: AppPhase = 'LOADING'
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

  async boot(): Promise<void> {
    const loadingBar = el('loading-bar-fill')
    const loadingText = el('loading-text')

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
    this.wireGameUi()
    this.homeControls = setupHomeAndSetupScreens({
      onStart: (settings) => {
        this.settings = settings
        this.sounds.enabled = settings.soundEnabled
        void this.startNewGame()
      },
      onResume: () => this.resumeGame(),
      onShowRules: () => openDialog('dialog-rules'),
    })
    el('btn-error-reload').addEventListener('click', () => window.location.reload())

    window.addEventListener('resize', () => this.handleResize())
    window.addEventListener('orientationchange', () => this.handleResize())
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange())
    window.addEventListener('beforeunload', () => this.persist())
    window.setInterval(() => {
      if (this.phase === 'PLAYING') this.hud.setTimer(this.currentElapsedMs())
    }, 500)

    loadingBar.style.width = '100%'
    this.goHome()
    requestAnimationFrame((time) => this.loop(time))
  }

  // ------------------------------------------------------------- lifecycle

  private goHome(): void {
    this.phase = 'HOME'
    this.pauseClock()
    this.homeControls.setResumeAvailable(loadSavedGame() !== null)
    showScreen('screen-home')
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
      this.controller = new GameController(scene, this.physics, this.sounds, {
        onStateChanged: (state) => this.handleStateChanged(state),
        onGameOver: (state) => this.handleGameOver(state),
        onHint: (message) => this.hud.showHint(message),
      })
    }
    return this.controller
  }

  private async startNewGame(): Promise<void> {
    this.phase = 'INITIALIZING'
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
    this.fairness = saved.fairness
    this.elapsedBaseMs = saved.elapsedMs
    this.beginSession(saved.state, { intro: false })
    this.hud.showHint('已還原上一局')
  }

  private beginSession(state: GameState, options: { intro: boolean }): void {
    showScreen('screen-game')
    const controller = this.ensureController()
    this.sceneContext?.resize()
    controller.startSession(state, options)
    controller.onViewChanged()
    this.hud.reset()
    this.hud.update(state)
    this.hud.setTimer(this.currentElapsedMs())
    this.closeDrawer()
    this.phase = 'PLAYING'
    this.playingSince = performance.now()
    this.lastFrame = performance.now()
  }

  // ------------------------------------------------------------ game flow

  private handleStateChanged(state: GameState): void {
    this.hud.update(state)
    if (this.fairness) saveGame(state, this.fairness, this.currentElapsedMs())
  }

  private handleGameOver(state: GameState): void {
    this.phase = 'GAME_OVER'
    this.pauseClock()
    clearSavedGame()
    showGameOverDialog(state, this.elapsedBaseMs)
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
        this.hud.update(drawn)
        this.handleGameOver(drawn)
      }
    })

    for (const id of ['btn-menu-restart', 'btn-side-restart']) {
      el(id).addEventListener('click', async () => {
        el<HTMLDialogElement>('dialog-menu').close()
        const playing = this.controller?.state.status === 'playing'
        const confirmed = !playing || (await confirmDialog('重新開始', '目前棋局將被清除，確定要重新開始一局嗎？'))
        if (confirmed) {
          clearSavedGame()
          void this.startNewGame()
        }
      })
    }

    el('btn-menu-home').addEventListener('click', () => {
      el<HTMLDialogElement>('dialog-menu').close()
      this.persist()
      this.goHome()
    })

    el('btn-again').addEventListener('click', () => {
      el<HTMLDialogElement>('dialog-gameover').close()
      void this.startNewGame()
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

  private closeDrawer(): void {
    el('history-drawer').hidden = true
    el('btn-history').setAttribute('aria-expanded', 'false')
  }

  private updateSoundLabel(): void {
    el('btn-menu-sound').textContent = `音效：${this.sounds.enabled ? '開' : '關'}`
  }

  // ------------------------------------------------------------- plumbing

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
      this.pauseClock()
    } else if (this.phase === 'PLAYING') {
      this.playingSince = performance.now()
      this.lastFrame = performance.now()
    }
  }

  private persist(): void {
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
