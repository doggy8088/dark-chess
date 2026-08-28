import './admin.css'
import { Chart, registerables, type ChartConfiguration } from 'chart.js'
import { el } from '../ui/dom'

Chart.register(...registerables)

interface AnnouncementView {
  id: string
  text: string
  at: number
  reached: number
  acks: number
}

interface LiveSnapshot {
  version: string
  players: number
  spectators: number
  lobby: number
  roomsPlaying: number
  roomsWaiting: number
  lagMs: number
  rssMb: number
  heapMb: number
  uptimeSec: number
}

interface MetricPoint {
  t: number
  day?: string
  samples: number
  http: number
  wsMsg: number
  connPeak: number
  connSum: number
  roomsPlayingPeak: number
  roomsWaitingPeak: number
  lagP95?: number
  lagP95Max?: number
  rssPeak: number
  heapPeak: number
}

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 86_400_000

function taipeiDateKey(offsetDays = 0): string {
  return new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10)
}

function formatClock(t: number, granularity: 'minute' | 'hour' | 'day'): string {
  const date = new Date(t + TAIPEI_OFFSET_MS)
  if (granularity === 'day') return date.toISOString().slice(0, 10)
  return date.toISOString().slice(11, granularity === 'hour' ? 13 : 16)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  const body = (await res.json().catch(() => ({}))) as T & { message?: string }
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`)
  return body
}

// ------------------------------------------------------------------- state

let minuteChart: Chart | null = null
let hourChart: Chart | null = null
let dayChart: Chart | null = null
let refreshTimer = 0

function showLogin(): void {
  el('admin-login').hidden = false
  el('admin-dashboard').hidden = true
  el<HTMLButtonElement>('btn-admin-logout').hidden = true
  el('admin-email').textContent = ''
  void setupGoogleSignIn()
}

function showDashboard(email: string): void {
  el('admin-login').hidden = true
  el('admin-dashboard').hidden = false
  el<HTMLButtonElement>('btn-admin-logout').hidden = false
  el('admin-email').textContent = email
  void refreshAll()
  if (!refreshTimer) refreshTimer = window.setInterval(() => void refreshAll(), 10_000)
}

// ------------------------------------------------------------------- login

async function setupGoogleSignIn(): Promise<void> {
  const hint = el('admin-login-hint')
  const target = el('google-signin')
  try {
    const { clientId } = await request<{ clientId: string | null }>('/api/admin/config')
    if (!clientId) {
      hint.hidden = false
      hint.textContent =
        '伺服器尚未設定 GOOGLE_CLIENT_ID 環境變數。請在 Google Cloud 建立 OAuth 用戶端（網頁應用程式），將此網址加入授權來源，並在 Cloud Run 設定 GOOGLE_CLIENT_ID 後重新部署。'
      return
    }
    hint.hidden = true
    await loadGsiScript()
    window.google!.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => void handleGoogleCredential(response.credential),
    })
    target.textContent = ''
    window.google!.accounts.id.renderButton(target, { theme: 'filled_black', size: 'large', text: 'signin_with', locale: 'zh-TW' })
  } catch (error) {
    hint.hidden = false
    hint.textContent = `無法載入登入設定：${error instanceof Error ? error.message : String(error)}`
  }
}

async function handleGoogleCredential(credential: string): Promise<void> {
  try {
    const { email } = await request<{ ok: true; email: string }>('/api/admin/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    })
    showDashboard(email)
  } catch (error) {
    const hint = el('admin-login-hint')
    hint.hidden = false
    hint.textContent = error instanceof Error ? error.message : String(error)
  }
}

interface GoogleGsi {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback: (response: { credential: string }) => void }): void
      renderButton(parent: HTMLElement, options: Record<string, unknown>): void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleGsi
  }
}

function loadGsiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('無法載入 Google 登入元件'))
    document.head.append(script)
  })
}

// -------------------------------------------------------------- dashboard

async function refreshAll(): Promise<void> {
  await Promise.allSettled([
    refreshLive(),
    refreshAnnouncements(),
    refreshMinuteChart(),
    refreshHourChart(),
    refreshDayChart(),
  ])
}

async function refreshLive(): Promise<void> {
  const live = await request<LiveSnapshot>('/api/admin/metrics/live')
  el('admin-version').textContent = `伺服器版本 v${live.version} · 運行 ${Math.floor(live.uptimeSec / 60)} 分鐘`
  const cards: Array<{ label: string; value: string }> = [
    { label: '連線玩家', value: String(live.players) },
    { label: '觀戰人數', value: String(live.spectators) },
    { label: '大廳連線', value: String(live.lobby) },
    { label: '進行戰局', value: String(live.roomsPlaying) },
    { label: '等待房間', value: String(live.roomsWaiting) },
    { label: 'Event-loop 延遲', value: `${live.lagMs} ms` },
    { label: '記憶體 RSS', value: `${live.rssMb} MB` },
    { label: 'Heap 使用', value: `${live.heapMb} MB` },
  ]
  const grid = el('admin-live-cards')
  grid.textContent = ''
  for (const card of cards) {
    const cardEl = document.createElement('div')
    cardEl.className = 'admin-live-card'
    const num = document.createElement('div')
    num.className = 'admin-live-num'
    num.textContent = card.value
    const label = document.createElement('div')
    label.className = 'admin-live-label'
    label.textContent = card.label
    cardEl.append(num, label)
    grid.append(cardEl)
  }
}

// ----------------------------------------------------------- announcements

async function refreshAnnouncements(): Promise<void> {
  const { announcements } = await request<{ announcements: AnnouncementView[] }>('/api/admin/announcements')
  const list = el('announcement-list')
  list.textContent = ''
  for (const item of announcements) {
    const li = document.createElement('li')
    li.className = 'admin-announcement-item'
    const body = document.createElement('div')
    const text = document.createElement('p')
    text.className = 'admin-announcement-text'
    text.textContent = item.text
    const meta = document.createElement('p')
    meta.className = 'admin-announcement-meta'
    meta.textContent = `${new Date(item.at).toLocaleString('zh-TW', { hour12: false })} · 送達 ${item.reached} 人`
    body.append(text, meta)
    const reads = document.createElement('span')
    reads.className = 'admin-announcement-reads'
    reads.textContent = `已讀 ${item.acks}/${item.reached}`
    li.append(body, reads)
    list.append(li)
  }
}

async function sendAnnouncement(): Promise<void> {
  const input = el<HTMLTextAreaElement>('announcement-input')
  const button = el<HTMLButtonElement>('btn-announce-send')
  const feedback = el('announce-feedback')
  const text = input.value.trim()
  if (!text) {
    feedback.textContent = '請先輸入公告內容'
    return
  }
  button.disabled = true
  try {
    await request('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ text }) })
    input.value = ''
    feedback.textContent = '已發送！'
    await refreshAnnouncements()
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    button.disabled = false
    window.setTimeout(() => {
      feedback.textContent = ''
    }, 4000)
  }
}

// ------------------------------------------------------------------ charts

function chartColor(index: number): string {
  return ['#d4a658', '#7fb069', '#5b9dd9', '#e05c4a', '#b58bd8'][index] ?? '#d4a658'
}

interface DatasetSpec {
  label: string
  data: number[]
  color: string
  axis: 'y' | 'y1'
  fill?: boolean
}

function makeDataset(spec: DatasetSpec) {
  return {
    label: spec.label,
    data: spec.data,
    borderColor: spec.color,
    backgroundColor: `${spec.color}33`,
    yAxisID: spec.axis,
    fill: spec.fill ?? false,
    tension: 0.3,
    pointRadius: 1.5,
    borderWidth: 2,
  }
}

function baseOptions(): ChartConfiguration['options'] {
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ticks: { color: '#9c8f7c', maxTicksLimit: 12 }, grid: { color: 'rgba(212,166,88,0.08)' } },
      y: {
        position: 'left',
        beginAtZero: true,
        ticks: { color: '#9c8f7c' },
        grid: { color: 'rgba(212,166,88,0.08)' },
        title: { display: true, text: '人數 / 次數', color: '#9c8f7c' },
      },
      y1: {
        position: 'right',
        beginAtZero: true,
        ticks: { color: '#b58bd8', callback: (value) => `${value} ms` },
        grid: { drawOnChartArea: false },
      },
    },
    plugins: {
      legend: { labels: { color: '#e8d5b0', boxWidth: 12 } },
      tooltip: { callbacks: { title: (items) => `${items[0]?.label ?? ''}（台北時間）` } },
    },
  }
}

async function fetchSeries(granularity: 'minute' | 'hour' | 'day', from: number, to: number): Promise<MetricPoint[]> {
  const { points } = await request<{ points: MetricPoint[] }>(
    `/api/admin/metrics/series?granularity=${granularity}&from=${Math.round(from)}&to=${Math.round(to)}`,
  )
  return points
}

function renderChart(
  existing: Chart | null,
  canvasId: string,
  labels: string[],
  datasets: ReturnType<typeof makeDataset>[],
): Chart {
  if (existing) {
    existing.data.labels = labels
    existing.data.datasets = datasets as never
    existing.update()
    return existing
  }
  const config: ChartConfiguration = {
    type: 'line',
    data: { labels, datasets: datasets as never },
    options: baseOptions(),
  }
  return new Chart(el<HTMLCanvasElement>(canvasId), config)
}

async function refreshMinuteChart(): Promise<void> {
  const rangeMinutes = Number(el<HTMLSelectElement>('minute-range').value) || 60
  const to = Date.now()
  const from = to - rangeMinutes * 60_000
  const points = await fetchSeries('minute', from, to)
  minuteChart = renderChart(minuteChart, 'chart-minute', points.map((p) => formatClock(p.t, 'minute')), [
    makeDataset({ label: '連線數（峰值）', data: points.map((p) => p.connPeak), color: chartColor(0), axis: 'y', fill: true }),
    makeDataset({ label: '進行戰局', data: points.map((p) => p.roomsPlayingPeak), color: chartColor(1), axis: 'y' }),
    makeDataset({ label: 'WS 訊息/分', data: points.map((p) => p.wsMsg), color: chartColor(2), axis: 'y' }),
    makeDataset({ label: 'HTTP 請求/分', data: points.map((p) => p.http), color: chartColor(3), axis: 'y' }),
    makeDataset({ label: 'Event-loop lag p95', data: points.map((p) => p.lagP95 ?? 0), color: chartColor(4), axis: 'y1' }),
  ])
}

async function refreshHourChart(): Promise<void> {
  const date = el<HTMLInputElement>('hour-date').value || taipeiDateKey()
  const from = Date.parse(`${date}T00:00:00+08:00`)
  const to = from + DAY_MS - 1
  const points = await fetchSeries('hour', from, to)
  hourChart = renderChart(hourChart, 'chart-hour', points.map((p) => `${formatClock(p.t, 'hour')}:00`), [
    makeDataset({ label: '連線數（峰值）', data: points.map((p) => p.connPeak), color: chartColor(0), axis: 'y', fill: true }),
    makeDataset({ label: '平均連線', data: points.map((p) => Math.round((p.connSum / Math.max(1, p.samples)) * 100) / 100), color: chartColor(3), axis: 'y' }),
    makeDataset({ label: '進行戰局（峰值）', data: points.map((p) => p.roomsPlayingPeak), color: chartColor(1), axis: 'y' }),
    makeDataset({ label: 'WS 訊息/時', data: points.map((p) => p.wsMsg), color: chartColor(2), axis: 'y' }),
    makeDataset({ label: 'HTTP 請求/時', data: points.map((p) => p.http), color: chartColor(4), axis: 'y' }),
    makeDataset({ label: 'Event-loop lag p95', data: points.map((p) => p.lagP95Max ?? 0), color: chartColor(4), axis: 'y1' }),
  ])
}

async function refreshDayChart(): Promise<void> {
  const days = Number(el<HTMLSelectElement>('day-range').value) || 7
  const to = Date.now()
  const from = to - days * DAY_MS
  const points = await fetchSeries('day', from, to)
  dayChart = renderChart(dayChart, 'chart-day', points.map((p) => p.day ?? formatClock(p.t, 'day')), [
    makeDataset({ label: '連線數（峰值）', data: points.map((p) => p.connPeak), color: chartColor(0), axis: 'y', fill: true }),
    makeDataset({ label: '平均連線', data: points.map((p) => Math.round((p.connSum / Math.max(1, p.samples)) * 100) / 100), color: chartColor(3), axis: 'y' }),
    makeDataset({ label: '進行戰局（峰值）', data: points.map((p) => p.roomsPlayingPeak), color: chartColor(1), axis: 'y' }),
    makeDataset({ label: 'WS 訊息/天', data: points.map((p) => p.wsMsg), color: chartColor(2), axis: 'y' }),
    makeDataset({ label: 'HTTP 請求/天', data: points.map((p) => p.http), color: chartColor(4), axis: 'y' }),
    makeDataset({ label: 'Event-loop lag p95', data: points.map((p) => p.lagP95Max ?? 0), color: chartColor(4), axis: 'y1' }),
  ])
}

// -------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  el('admin-footer-version').textContent = `v${__APP_VERSION__}`
  el('btn-announce-send').addEventListener('click', () => void sendAnnouncement())
  el('btn-admin-logout').addEventListener('click', async () => {
    await request('/api/admin/logout', { method: 'POST' }).catch(() => undefined)
    if (refreshTimer) {
      window.clearInterval(refreshTimer)
      refreshTimer = 0
    }
    showLogin()
  })
  el('btn-refresh-minute').addEventListener('click', () => void refreshMinuteChart())
  el('minute-range').addEventListener('change', () => void refreshMinuteChart())
  el('day-range').addEventListener('change', () => void refreshDayChart())
  el<HTMLInputElement>('hour-date').value = taipeiDateKey()
  el<HTMLInputElement>('hour-date').addEventListener('change', () => void refreshHourChart())
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-hour-shift]')) {
    button.addEventListener('click', () => {
      const shift = Number(button.dataset.hourShift ?? 0)
      el<HTMLInputElement>('hour-date').value = taipeiDateKey(shift)
      void refreshHourChart()
    })
  }

  const session = await request<{ authenticated: boolean; email?: string }>('/api/admin/session').catch(() => ({
    authenticated: false,
    email: undefined,
  }))
  if (session.authenticated && session.email) {
    showDashboard(session.email)
  } else {
    showLogin()
  }
}

void boot()