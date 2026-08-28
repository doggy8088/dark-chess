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
  cpuPct: number
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
  cpuAvg?: number
  cpuPeak?: number
  cpuSum?: number
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
    refreshIpPanel(),
  ])
}

async function refreshLive(): Promise<void> {
  const live = await request<LiveSnapshot>('/api/admin/metrics/live')
  el('admin-version').textContent = `伺服器版本 v${live.version} · 運行 ${formatUptime(live.uptimeSec)}`

  const cards: AdminLiveCard[] = [
    {
      emoji: '🧑‍🤝‍🧑',
      label: '連線玩家',
      value: String(live.players),
      status: crowdStatus(live.players).text,
      tone: crowdStatus(live.players).tone,
      delta: deltaOf(live.players, prevLive?.players),
    },
    {
      emoji: '👀',
      label: '觀戰人數',
      value: String(live.spectators),
      status: live.spectators === 0 ? '還沒有觀眾進場' : `有 ${live.spectators} 人在圍觀 🍿`,
      tone: live.spectators === 0 ? 'muted' : 'ok',
      delta: deltaOf(live.spectators, prevLive?.spectators),
    },
    {
      emoji: '🛋️',
      label: '大廳連線',
      value: String(live.lobby),
      status: live.lobby === 0 ? '大廳空空的' : `${live.lobby} 人在逛大廳找對手`,
      tone: live.lobby === 0 ? 'muted' : 'ok',
      delta: deltaOf(live.lobby, prevLive?.lobby),
    },
    {
      emoji: '⚔️',
      label: '進行戰局',
      value: String(live.roomsPlaying),
      status: live.roomsPlaying === 0 ? '棋盤們在打瞌睡 💤' : `${live.roomsPlaying} 場激戰中 🔥`,
      tone: live.roomsPlaying === 0 ? 'muted' : 'ok',
      delta: deltaOf(live.roomsPlaying, prevLive?.roomsPlaying),
    },
    {
      emoji: '🚪',
      label: '等待房間',
      value: String(live.roomsWaiting),
      status: live.roomsWaiting === 0 ? '沒有人在等腳友' : `${live.roomsWaiting} 間房虛位以待`,
      tone: live.roomsWaiting === 0 ? 'muted' : 'warn',
      delta: deltaOf(live.roomsWaiting, prevLive?.roomsWaiting),
    },
    {
      emoji: '🖥️',
      label: 'CPU 使用率',
      value: `${live.cpuPct}%`,
      status: cpuStatus(live.cpuPct).text,
      tone: cpuStatus(live.cpuPct).tone,
    },
    {
      emoji: '⚡',
      label: 'Event-loop 延遲',
      value: `${live.lagMs} ms`,
      status: lagStatus(live.lagMs).text,
      tone: lagStatus(live.lagMs).tone,
    },
    {
      emoji: '🧠',
      label: '記憶體 RSS',
      value: `${live.rssMb} MB`,
      status: `Heap ${live.heapMb} MB · ${memStatus(live.rssMb).text}`,
      tone: memStatus(live.rssMb).tone,
    },
  ]
  prevLive = live
  renderLiveCards(cards)
}

function cpuStatus(pct: number): { text: string; tone: AdminLiveCard['tone'] } {
  if (pct < 20) return { text: '閒得很，隨時能戰', tone: 'ok' }
  if (pct < 60) return { text: '正常運作中', tone: 'ok' }
  if (pct < 85) return { text: '有點忙碌 🔥', tone: 'warn' }
  return { text: '滿載中，注意！', tone: 'bad' }
}

/** 指標卡上一次的快照，用於畫 ▲▼ 趨勢。 */
let prevLive: LiveSnapshot | null = null

interface AdminLiveCard {
  emoji: string
  label: string
  value: string
  status: string
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  delta?: number
}

function deltaOf(current: number, previous: number | undefined): number | undefined {
  if (previous === undefined || previous === current) return undefined
  return current - previous
}

function crowdStatus(n: number): { text: string; tone: AdminLiveCard['tone'] } {
  if (n === 0) return { text: '現在很冷清…快來開一局！', tone: 'muted' }
  if (n <= 2) return { text: '正好開打', tone: 'ok' }
  if (n <= 6) return { text: '很熱鬧 🔥', tone: 'ok' }
  return { text: '鑼鼓喧天，全場沸騰 🎉', tone: 'warn' }
}

function lagStatus(lagMs: number): { text: string; tone: AdminLiveCard['tone'] } {
  if (lagMs < 20) return { text: '順得很 ✨', tone: 'ok' }
  if (lagMs < 60) return { text: '還算順', tone: 'warn' }
  return { text: '有點喘 😮‍💨', tone: 'bad' }
}

function memStatus(mb: number): { text: string; tone: AdminLiveCard['tone'] } {
  if (mb < 250) return { text: '身體健康', tone: 'ok' }
  if (mb < 450) return { text: '吃得剛剛好', tone: 'warn' }
  return { text: '有點吃太飽了', tone: 'bad' }
}

function formatUptime(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘`
  return `${Math.floor(sec / 3600)} 小時 ${Math.floor((sec % 3600) / 60)} 分`
}

function renderLiveCards(cards: AdminLiveCard[]): void {
  const grid = el('admin-live-cards')
  grid.textContent = ''
  for (const card of cards) {
    const cardEl = document.createElement('div')
    cardEl.className = `admin-live-card tone-${card.tone}`

    const top = document.createElement('div')
    top.className = 'admin-live-top'
    const emoji = document.createElement('span')
    emoji.className = 'admin-live-emoji'
    emoji.textContent = card.emoji
    const num = document.createElement('div')
    num.className = 'admin-live-num'
    num.textContent = card.value
    top.append(emoji, num)
    if (card.delta !== undefined) {
      const delta = document.createElement('span')
      delta.className = `admin-live-delta ${card.delta > 0 ? 'up' : 'down'}`
      delta.textContent = card.delta > 0 ? `▲${card.delta}` : `▼${Math.abs(card.delta)}`
      delta.title = '與 10 秒前比較'
      top.append(delta)
    }

    const label = document.createElement('div')
    label.className = 'admin-live-label'
    label.textContent = card.label

    const status = document.createElement('div')
    status.className = 'admin-live-status'
    status.textContent = card.status

    cardEl.append(top, label, status)
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
  axis: 'y' | 'y1' | 'y2'
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
      y2: {
        position: 'right',
        beginAtZero: true,
        max: 100,
        ticks: { color: '#34d399', callback: (value) => `${value}%` },
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
    makeDataset({ label: 'CPU %', data: points.map((p) => p.cpuPeak ?? 0), color: '#34d399', axis: 'y2' }),
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
    makeDataset({ label: 'CPU 峰值 %', data: points.map((p) => p.cpuPeak ?? 0), color: '#34d399', axis: 'y2' }),
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
    makeDataset({ label: 'CPU 峰值 %', data: points.map((p) => p.cpuPeak ?? 0), color: '#34d399', axis: 'y2' }),
    makeDataset({ label: 'Event-loop lag p95', data: points.map((p) => p.lagP95Max ?? 0), color: chartColor(4), axis: 'y1' }),
  ])
}

// ---------------------------------------------------------------- IP 監控

interface IpTopRow {
  ip: string
  http: number
  wsMsg: number
  connEvents: number
  concurrent: number
  firstSeen: number
  lastSeen: number
  blocked: boolean
  blockExpiresAt: number | null
}

interface IpAlertView {
  id: string
  ip: string
  type: string
  detail: string
  at: number
}

interface IpBlockView {
  ip: string
  blockedAt: number
  expiresAt: number | null
  blockedBy: string
}

const IP_ALERT_TYPE_TEXT: Record<string, string> = {
  'http-flood': 'HTTP 洪水',
  'ws-flood': 'WS 訊息洪水',
  'conn-storm': '連線風暴',
  'http-hourly': 'HTTP 時流量異常',
}

function formatAgo(at: number): string {
  const diff = Math.max(0, Date.now() - at)
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function formatRemaining(expiresAt: number | null): string {
  if (expiresAt === null) return '永久'
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return '即將解除'
  if (remaining < 3_600_000) return `${Math.ceil(remaining / 60_000)} 分鐘後解除`
  if (remaining < 86_400_000) return `${Math.ceil(remaining / 3_600_000)} 小時後解除`
  return `${Math.ceil(remaining / 86_400_000)} 天後解除`
}

function selectedBlockDuration(): string {
  return el<HTMLSelectElement>('ip-block-duration').value
}

async function blockIp(ip: string): Promise<void> {
  const duration = selectedBlockDuration()
  await request('/api/admin/ip-blocks', { method: 'POST', body: JSON.stringify({ ip, duration }) })
  ipFeedback(`已封鎖 ${ip}（${duration === 'permanent' ? '永久' : duration}）`)
  await refreshIpPanel()
}

async function unblockIp(ip: string): Promise<void> {
  await request(`/api/admin/ip-blocks/${encodeURIComponent(ip)}`, { method: 'DELETE' })
  ipFeedback(`已解除封鎖：${ip}`)
  await refreshIpPanel()
}

function ipFeedback(text: string): void {
  const feedback = el('ip-feedback')
  feedback.textContent = text
  window.setTimeout(() => {
    feedback.textContent = ''
  }, 4000)
}

async function refreshIpPanel(): Promise<void> {
  const [stats, alerts, blocks] = await Promise.all([
    request<{ points: IpTopRow[]; range: string }>('/api/admin/ip-stats?range=' + encodeURIComponent(el<HTMLSelectElement>('ip-range').value)),
    request<{ alerts: IpAlertView[]; thresholds: Record<string, number> }>('/api/admin/ip-alerts'),
    request<{ blocks: IpBlockView[] }>('/api/admin/ip-blocks'),
  ])

  el('ip-thresholds').textContent =
    `異常閥值：單一 IP HTTP > ${alerts.thresholds.httpPerMin} 次/分、WS 訊息 > ${alerts.thresholds.wsPerMin} 則/分、` +
    `WS 連線 > ${alerts.thresholds.connPerMin} 條/分、HTTP > ${alerts.thresholds.httpPerHour} 次/時 · 流量歷史保留 ${alerts.thresholds.retentionDays} 天`

  const body = el<HTMLTableSectionElement>('ip-top-body')
  body.textContent = ''
  if (stats.points.length === 0) {
    const row = body.insertRow()
    const cell = row.insertCell()
    cell.colSpan = 9
    cell.textContent = '這段時間內沒有流量紀錄'
    cell.className = 'admin-empty'
  }
  stats.points.forEach((row, index) => {
    const tr = body.insertRow()
    if (row.blocked) tr.className = 'blocked-row'
    const cells = [
      String(index + 1),
      row.ip,
      String(row.http),
      String(row.wsMsg),
      String(row.connEvents),
      String(row.concurrent),
      formatAgo(row.lastSeen),
    ]
    for (const value of cells) {
      const cell = tr.insertCell()
      cell.textContent = value
      if (value === row.ip) cell.className = 'mono'
    }
    const statusCell = tr.insertCell()
    const pill = document.createElement('span')
    pill.className = `ip-status-pill ${row.blocked ? 'blocked' : 'ok'}`
    pill.textContent = row.blocked ? `封鎖中（${formatRemaining(row.blockExpiresAt)}）` : '正常'
    statusCell.append(pill)

    const actionCell = tr.insertCell()
    const action = document.createElement('button')
    action.type = 'button'
    action.className = `admin-btn ${row.blocked ? 'ghost' : 'primary'}`
    action.style.padding = '3px 10px'
    action.style.fontSize = '12px'
    action.textContent = row.blocked ? '解封' : '封鎖'
    action.addEventListener('click', () => {
      action.disabled = true
      void (row.blocked ? unblockIp(row.ip) : blockIp(row.ip)).finally(() => {
        action.disabled = false
      })
    })
    actionCell.append(action)
  })

  const alertsList = el('ip-alerts-list')
  alertsList.textContent = ''
  if (alerts.alerts.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'admin-empty'
    empty.textContent = '目前沒有異常警示 — 一切平靜 ✨'
    alertsList.append(empty)
  }
  for (const alert of alerts.alerts.slice(0, 20)) {
    const li = document.createElement('li')
    li.className = 'admin-announcement-item ip-alert-item'
    const body = document.createElement('div')
    const text = document.createElement('p')
    text.className = 'admin-announcement-text'
    const type = document.createElement('span')
    type.className = 'ip-alert-type'
    type.textContent = IP_ALERT_TYPE_TEXT[alert.type] ?? alert.type
    text.append(type, document.createTextNode(alert.detail))
    const meta = document.createElement('p')
    meta.className = 'admin-announcement-meta'
    meta.textContent = `${alert.ip} · ${new Date(alert.at).toLocaleString('zh-TW', { hour12: false })}`
    body.append(text, meta)
    li.append(body)
    alertsList.append(li)
  }

  const blocksList = el('ip-blocks-list')
  blocksList.textContent = ''
  if (blocks.blocks.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'admin-empty'
    empty.textContent = '目前沒有封鎖任何 IP'
    blocksList.append(empty)
  }
  for (const block of blocks.blocks) {
    const li = document.createElement('li')
    li.className = 'admin-announcement-item ip-block-item'
    const body = document.createElement('div')
    const text = document.createElement('p')
    text.className = 'admin-announcement-text'
    text.textContent = block.ip
    const meta = document.createElement('p')
    meta.className = 'admin-announcement-meta'
    meta.textContent = `封鎖於 ${new Date(block.blockedAt).toLocaleString('zh-TW', { hour12: false })} · ${formatRemaining(block.expiresAt)} · 由 ${block.blockedBy || '管理員'} 設定`
    body.append(text, meta)
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'admin-btn ghost'
    action.style.fontSize = '12px'
    action.textContent = '解封'
    action.addEventListener('click', () => {
      action.disabled = true
      void unblockIp(block.ip).finally(() => {
        action.disabled = false
      })
    })
    li.append(body, action)
    blocksList.append(li)
  }
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
  el('btn-ip-refresh').addEventListener('click', () => void refreshIpPanel())
  el('ip-range').addEventListener('change', () => void refreshIpPanel())
  el('btn-ip-block-manual').addEventListener('click', () => {
    const input = el<HTMLInputElement>('ip-manual-input')
    const ip = input.value.trim()
    if (!ip) {
      ipFeedback('請先輸入 IP 位址')
      return
    }
    input.value = ''
    void blockIp(ip).catch((error: unknown) => {
      ipFeedback(error instanceof Error ? error.message : String(error))
    })
  })
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