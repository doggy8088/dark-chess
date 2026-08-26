import { el } from './dom'
import { loadSettings, saveSettings, type Settings } from '../persistence/storage'

export interface SetupCallbacks {
  onStart(settings: Settings): void
  onResume(): void
  onShowRules(): void
}

/** Wires the home and setup screens. Returns a function to toggle the resume button. */
export function setupHomeAndSetupScreens(callbacks: SetupCallbacks): {
  setResumeAvailable(available: boolean): void
} {
  const resumeButton = el<HTMLButtonElement>('btn-home-resume')
  const p1Input = el<HTMLInputElement>('input-p1')
  const p2Input = el<HTMLInputElement>('input-p2')
  const soundInput = el<HTMLInputElement>('input-sound')
  const form = el<HTMLFormElement>('setup-form')

  el('btn-home-rules').addEventListener('click', callbacks.onShowRules)
  resumeButton.addEventListener('click', callbacks.onResume)

  el('btn-home-start').addEventListener('click', () => {
    const settings = loadSettings()
    p1Input.value = settings.playerNames[0]
    p2Input.value = settings.playerNames[1]
    soundInput.checked = settings.soundEnabled
    const radio = form.querySelector<HTMLInputElement>(`input[name="first"][value="${settings.firstPlayer}"]`)
    if (radio) radio.checked = true
    showScreen('screen-setup')
  })

  el('btn-setup-back').addEventListener('click', () => showScreen('screen-home'))

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const firstRadio = form.querySelector<HTMLInputElement>('input[name="first"]:checked')
    const settings: Settings = {
      playerNames: [p1Input.value.trim() || '玩家一', p2Input.value.trim() || '玩家二'],
      firstPlayer: firstRadio?.value === 'random' ? 'random' : 'p1',
      soundEnabled: soundInput.checked,
    }
    saveSettings(settings)
    callbacks.onStart(settings)
  })

  return {
    setResumeAvailable(available: boolean) {
      resumeButton.hidden = !available
    },
  }
}

const SCREEN_IDS = ['screen-loading', 'screen-error', 'screen-home', 'screen-setup', 'screen-game'] as const
export type ScreenId = (typeof SCREEN_IDS)[number]

export function showScreen(id: ScreenId): void {
  for (const screenId of SCREEN_IDS) {
    el(screenId).hidden = screenId !== id
  }
}

export function showError(title: string, message: string): void {
  el('error-title').textContent = title
  el('error-message').textContent = message
  showScreen('screen-error')
}
