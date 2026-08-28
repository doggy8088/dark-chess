import { el } from './dom'
import { loadSettings } from '../persistence/storage'
import { resolveNickname } from '../shared/fun-names'

export interface OnlineLobbyCallbacks {
  onCreate(name: string): void
  onBack(): void
}

/** Wires the online setup screen (nickname → create invite). */
export function setupOnlineLobby(callbacks: OnlineLobbyCallbacks): {
  setCreating(busy: boolean): void
  prefillName(): void
} {
  const nameInput = el<HTMLInputElement>('input-online-name')
  const createButton = el<HTMLButtonElement>('btn-online-create')
  const form = el<HTMLFormElement>('online-setup-form')

  el('btn-online-back').addEventListener('click', callbacks.onBack)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    callbacks.onCreate(nameInput.value.trim() || resolveNickname(nameInput.value))
  })

  return {
    setCreating(busy: boolean) {
      createButton.disabled = busy
      createButton.textContent = busy ? '建立中…' : '建立對戰邀請'
    },
    prefillName() {
      nameInput.value = resolveNickname(loadSettings().playerNames[0])
    },
  }
}

/** Fills the waiting screen: link, copy button, QR code. */
export function showInvite(url: string): void {
  el('invite-url').textContent = url
  const copyButton = el<HTMLButtonElement>('btn-copy-invite')
  copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url)
      copyButton.textContent = '已複製！'
    } catch {
      copyButton.textContent = '複製失敗，請長按連結'
    }
    window.setTimeout(() => {
      copyButton.textContent = '複製連結'
    }, 1800)
  }
  void renderQr(url)
}

async function renderQr(url: string): Promise<void> {
  const canvas = el<HTMLCanvasElement>('invite-qr')
  try {
    const QRCode = (await import('qrcode')).default
    await QRCode.toCanvas(canvas, url, {
      width: 168,
      margin: 1,
      color: { dark: '#201709', light: '#efe6d8' },
    })
    canvas.hidden = false
  } catch {
    canvas.hidden = true
  }
}
