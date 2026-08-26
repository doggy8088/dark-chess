import type { GameState } from '../game/types'
import type { FairnessData } from '../game/fairness'

const SETTINGS_KEY = 'taiwan-dark-chess:settings:v1'
const GAME_KEY = 'taiwan-dark-chess:game:v1'

export interface Settings {
  playerNames: [string, string]
  firstPlayer: 'p1' | 'random'
  soundEnabled: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  playerNames: ['玩家一', '玩家二'],
  firstPlayer: 'p1',
  soundEnabled: true,
}

export interface SavedGame {
  version: 1
  state: GameState
  fairness: FairnessData
  elapsedMs: number
  savedAt: number
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or unavailable (private mode) — persistence is optional.
  }
}

export function loadSettings(): Settings {
  const stored = read<Partial<Settings>>(SETTINGS_KEY)
  if (!stored) return { ...DEFAULT_SETTINGS }
  return {
    playerNames: Array.isArray(stored.playerNames) && stored.playerNames.length === 2
      ? [String(stored.playerNames[0] ?? '玩家一'), String(stored.playerNames[1] ?? '玩家二')]
      : [...DEFAULT_SETTINGS.playerNames],
    firstPlayer: stored.firstPlayer === 'random' ? 'random' : 'p1',
    soundEnabled: stored.soundEnabled !== false,
  }
}

export function saveSettings(settings: Settings): void {
  write(SETTINGS_KEY, settings)
}

export function loadSavedGame(): SavedGame | null {
  const saved = read<SavedGame>(GAME_KEY)
  if (!saved || saved.version !== 1) return null
  if (!saved.state || saved.state.status !== 'playing') return null
  if (!Array.isArray(saved.state.board) || saved.state.board.length !== 32) return null
  if (!saved.fairness?.commitmentHash) return null
  return saved
}

export function saveGame(state: GameState, fairness: FairnessData, elapsedMs: number): void {
  if (state.status !== 'playing') {
    clearSavedGame()
    return
  }
  const saved: SavedGame = { version: 1, state, fairness, elapsedMs, savedAt: Date.now() }
  write(GAME_KEY, saved)
}

export function clearSavedGame(): void {
  try {
    localStorage.removeItem(GAME_KEY)
  } catch {
    // Ignore.
  }
}
