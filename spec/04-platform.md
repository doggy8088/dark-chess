# 04 · 平臺選擇（Platform）

> 台灣暗棋 3D 網頁遊戲 — 軟體開發規格書
> 文件版本：v1.0（對應產品版號 v1.1.33）· 最後更新：2026-08-29
> 本文以實際原始碼與設定檔為準：`AGENTS.md`、`Makefile`、`Dockerfile`、`vite.config.ts`、`server/config.ts`、`server/auth.ts`、`server/ip-monitor.ts`、`.github/workflows/deploy.yml`。

---

## 1. 平臺決策：為什麼是「網頁遊戲」

### 1.1 決策理由

| 考量 | 網頁遊戲（本專案採用） | Native App（不採用） |
| --- | --- | --- |
| 取得成本 | 免安裝，開連結即玩（邀請連結 + QR code，見 `index.html` 與依賴 `qrcode`） | 需下載安裝、過審核 |
| 跨裝置 | 手機／桌機同一份程式碼（Mobile First + RWD，見 `src/ui/`、`index.html`） | iOS／Android 須各自開發 |
| 分享傳播 | 邀請網址 `/r/<roomId>`、OpenGraph 分享預覽（og:image 1200×630） | 需 deep link 基礎建設 |
| 更新即時性 | 部署即全量生效（版號經 `__APP_VERSION__` 注入，玩家重新整理即可） | 需經商店審核排程 |
| 技術可行性 | Three.js（WebGL）+ Rapier（WASM）在現代瀏覽器已可支撐 3D + 物理動畫 | 優勢僅在系統級整合，本遊戲不需要 |

**結論**：本產品的對戰情境是「兩人、隨時、分享連結即開打」，網頁平臺的零摩擦特性與傳播路徑完全吻合；Native App 的額外成本（雙平臺開發、上架審核）換不到對應價值，故明定為非目標（見 `spec/01-overview.md` §2.2）。

### 1.2 Mobile First + RWD

- 版面以手機直持為基準設計，桌機為增強（聊天室可縮放、對局紀錄可收合、全螢幕按鈕，見 `src/ui/`）。
- 輸入以觸控優先（raycasting 點選棋子，`src/rendering/raycaster.ts`），鍵鼠亦可操作。
- 震動回饋使用 `navigator.vibrate`（`src/audio/haptics.ts:13`），不支援時靜默略過。

---

## 2. 瀏覽器能力需求

本遊戲依賴下列瀏覽器 API，**支援目標為 2021 年後的現代瀏覽器**（Chrome / Edge / Safari / Firefox 桌機與行動版皆可；ES2022 為 Vite build target，見 `vite.config.ts:14`）：

| 能力 | 用途 | 程式碼位置 | 不支援時的行為 |
| --- | --- | --- | --- |
| WebGL 2（或 WebGL 1） | Three.js 3D 場景、棋盤與棋子渲染 | `src/rendering/scene.ts:19`（`webgl2` → `webgl` 依序偵測） | 顯示「不支援 3D」提示，無法進入對局 |
| WebAssembly | Rapier 3D 物理引擎（翻棋／吃子動畫） | `vite-plugin-wasm`（`vite.config.ts:6`）、`src/physics/` | 頁面載入失敗；屬硬性需求 |
| Web Audio | 合成音效（無音檔資源，全由 `AudioContext` 合成） | `src/audio/sounds.ts:12`（含 `webkitAudioContext` 備援） | 靜音遊玩，功能不受影響 |
| WebSocket | 線上對戰即時通道（單一端點 `/ws`） | `src/online/socket.ts:43` | 無法線上對戰；單機模式不受影響 |
| Fullscreen API | 全螢幕對局模式 | `src/app.ts:507`（`requestFullscreen`）、`src/app.ts:499`（`webkitFullscreenElement` 備援） | 全螢幕按鈕隱藏／無效 |
| Web Crypto | `crypto.getRandomValues` 無偏洗牌 + `crypto.subtle.digest('SHA-256')` 開局承諾 | `src/game/fairness.ts:21`、`src/game/fairness.ts:31` | 無法開局（公平性驗證屬硬性需求） |
| localStorage | 設定、棋局自動存檔、線上身分 token | `src/persistence/storage.ts`、`src/online/tokens.ts` | 設定不保留、無法續局 |
| Vibration API | 對局關鍵事件震動回饋 | `src/audio/haptics.ts:13` | 靜默略過 |

> 設計原則：**3D／物理／音效／震動皆為表現層**，任何一項缺席都不影響規則正確性；唯 WebGL、WASM、Web Crypto、WebSocket 四項為核心路徑的硬性需求。

---

## 3. 部署平臺：Cloud Run × GitHub Pages 雙軌策略

本專案採**單一程式庫、兩種部署目標**的雙軌策略：同一份前端 build 產物，分別交付「有伺服器」與「純靜態」兩種營運形態。

### 3.1 Google Cloud Run（線上對戰主站）

| 項目 | 值 | 依據 |
| --- | --- | --- |
| GCP 專案 | `vertex-ai-sprint` | `Makefile`（`GCP_PROJECT`） |
| 區域 | `asia-east1`（彰濱） | `Makefile`（`GCP_REGION`），貼近主要市場 |
| 服務名稱 | `dark-chess` | `Makefile`（`RUN_SERVICE`） |
| 原始網址 | https://dark-chess-327655012190.asia-east1.run.app | `AGENTS.md` |
| 自訂網址 | https://dark-chess.game.miniasp.com（見 §4） | `spec/01-overview.md` §5 |
| 部署方式 | `gcloud run deploy --source .`（Cloud Build 讀取根目錄 `Dockerfile` 建置） | `Makefile` `deploy-run` 目標 |
| 容器埠 | `--port 8080`（Cloud Run 注入 `PORT` 環境變數，`server/config.ts:1` 讀取） | `Dockerfile` `EXPOSE 8080` |
| 認證 | `--allow-unauthenticated`（玩家免登入） | `Makefile` |
| 工作負載 | Node.js 22 + Express（HTTP）+ ws（WebSocket `/ws`） | `Dockerfile`、`server/index.ts` |
| 持久化 | Firestore（房間、公告、指標、IP 封鎖資料） | `server/firestore-store.ts`、`server/firestore-admin.ts` |

### 3.2 GitHub Pages（單機版靜態站）

| 項目 | 值 | 依據 |
| --- | --- | --- |
| 網址 | https://dark-chess.gh.miniasp.com | `Makefile`（`SITE_URL`）、`public/CNAME` |
| 部署方式 | push 至 `main` 觸發 GitHub Actions（`deploy.yml`），上傳 `dist/` 至 Pages | `.github/workflows/deploy.yml` |
| 能力範圍 | 僅雙人同機對戰（Hotseat）：規則引擎、3D、物理、音效皆可完整運作 | `README.md` |
| 明確不做 | 線上對戰、戰情中心、後台管理（無伺服器） | `spec/01-overview.md` |

### 3.3 雙軌分工

| 面向 | Cloud Run 主站 | GitHub Pages 單機版 |
| --- | --- | --- |
| 對戰模式 | Hotseat + 線上對戰 | 僅 Hotseat |
| 後台 `/admin` | ✅（Google 登入 + 公告/報表/IP 監控） | ❌ |
| 健康檢查 `/api/health` | ✅（回傳版號，供部署驗證） | ❌（靜態站無 API） |
| 主要用途 | 對外營運、正式對戰 | 展示、備援、規則體驗 |
| 觸發 | 手動 `make deploy-run` | push `main` 全自動 |
| 建置內容 | 前端 `dist/` + 伺服器 `dist-server/`（Docker 多階段） | 僅前端 `dist/` |

> 選擇雙軌的原因：GitHub Pages 零成本、零維運，確保「規則體驗」永遠有可分享的入口；Cloud Run 承載需要 server-authoritative 的線上對戰（蓋牌資訊絕不離開伺服器，見 `server/redact.ts`）。

---

## 4. 自訂網域

| 環境 | 網域 | DNS 設定 | 綁定時間 |
| --- | --- | --- | --- |
| Cloud Run 主站 | `dark-chess.game.miniasp.com` | CNAME → `ghs.googlehosted.com`（Google 統一管理的服務前端位址） | 2026-08-27 |
| GitHub Pages | `dark-chess.gh.miniasp.com` | CNAME 記錄（內容寫在 `public/CNAME`，隨 `dist/` 部署） | 早於 2026-08-27 |

- 網域綁定過程記錄於開發 session log：先以 `host -t cname dark-chess.game.miniasp.com` 驗證 CNAME 指向 `ghs.googlehosted.com`，再於 Cloud Run 主控台完成網域對應與自動 TLS 憑證簽發。
- Cloud Run 在 Google Front End 終結 TLS，真實客端 IP 透過 `X-Forwarded-For` 傳遞；伺服器以 `app.set('trust proxy', true)`（`server/index.ts`）解析 `req.ip`，IP 監控（§6）才能正確歸因。

---

## 5. 環境變數清單

以下為伺服器讀取的**全部**環境變數。本機開發時全部可省略（走預設值）；Cloud Run 上只需設定 `GOOGLE_CLIENT_ID`、`ADMIN_SESSION_SECRET`、`ADMIN_EMAILS`（其餘用預設）。

### 5.1 環境變數

| 變數 | 預設值 | 讀取位置 | 說明 |
| --- | --- | --- | --- |
| `PORT` | `8787` | `server/config.ts:1` | HTTP 監聽埠。本機與 `make start-local` 用 8787；Cloud Run 部署時注入 8080（`--port 8080`） |
| `TURN_MS` | `60000` | `server/config.ts:4` | 每步思考時限（毫秒），逾期直接判負（`gameOver.reason = 'timeout'`） |
| `GRACE_MS` | `90000` | `server/config.ts:11` | 輪到行動的玩家斷線後的重連寬限；期間回合時鐘暫停，逾時判負（`'forfeit'`） |
| `FIRESTORE_ENABLED` | 開啟（只要不等於 `'0'`） | `server/config.ts:14` | 設為 `0` 時改用 `InMemoryStore`（遊戲資料不跨重啟）。本機開發與測試必設 `0` |
| `GOOGLE_CLIENT_ID` | 未設定 → 後台登入回 `503 google-not-configured` | `server/index.ts`（`/api/admin/config`、`/api/admin/google`） | Google Identity Services 的 OAuth client id（屬公開值，經 `/api/admin/config` 下發給登入按鈕）。伺服器以此為 `aud` 驗證 Google ID token（RS256 + JWKS） |
| `ADMIN_SESSION_SECRET` | 未設定 → 每次啟動以 `randomSecret()`（32-byte 隨機 hex）產生 | `server/index.ts`、`server/auth.ts` | 後台 session cookie 的 HMAC-SHA256 簽章密鑰。**隨機預設代表重啟即全體管理員登出**；正式環境應設固定值 |
| `ADMIN_EMAILS` | `doggy.huang@gmail.com` | `server/auth.ts`（`adminEmailsFromEnv`） | 管理員 email 白名單（逗號分隔、比對時轉小寫）。不在名單內的 Google 帳號登入回 `401 not-admin` |
| `IP_ALERT_HTTP_PER_MIN` | `120` | `server/ip-monitor.ts` | 單一 IP 每分鐘 HTTP 請求數告警閥值（型別 `http-flood`） |
| `IP_ALERT_WS_PER_MIN` | `600` | `server/ip-monitor.ts` | 單一 IP 每分鐘 WebSocket 訊息數告警閥值（型別 `ws-flood`） |
| `IP_ALERT_CONN_PER_MIN` | `10` | `server/ip-monitor.ts` | 單一 IP 每分鐘 WebSocket 連線事件數告警閥值（型別 `conn-storm`） |
| `IP_ALERT_HTTP_PER_HOUR` | `2,000` | `server/ip-monitor.ts` | 單一 IP 每小時 HTTP 累計請求數告警閥值（型別 `http-hourly`） |

### 5.2 相關的程式碼常數（不可用環境變數覆寫）

這些值寫死在 `server/config.ts` / `server/auth.ts`，調整需改碼重新部署：

| 常數 | 值 | 說明 |
| --- | --- | --- |
| `TAKEOVER_WINDOW_MS` | 5 分鐘 | 座位棄置（斷線／逾時）後，觀戰者可接手的時間窗 |
| `LOBBY_WAIT_VISIBILITY_MS` | 30 秒 | 等待對手的房間曝光於首頁戰情中心前的最短等待 |
| `FINISHED_ROOM_TTL_MS` | 24 小時 | 已結束房間的存活時間（Firestore `expireAt` TTL，見 `server/firestore-store.ts`） |
| `IDLE_ROOM_TTL_MS` | 7 天 | 未完成房間自最後活動起的過期時間 |
| `LOBBY_ENDED_RETENTION_MS` | 5 分鐘 | 已結束對局在戰情中心保留的時間 |
| `CHAT_BURST` / `CHAT_WINDOW_MS` / `CHAT_MIN_GAP_MS` / `CHAT_MAX_LENGTH` / `CHAT_TAIL_LENGTH` | 5 則 / 10 秒 / 600 ms / 120 字 / 50 則 | 聊天頻率限制與訊息尾窗 |
| `ADMIN_SESSION_TTL_MS` | 12 小時 | 後台 session cookie 有效期（`server/auth.ts`） |
| `IP_RETENTION_MS` | 7 天 | IP 流量小時桶與警示的保留期（`server/ip-monitor.ts`） |
| `IP_BLOCK_DURATIONS` | 5m/30m/1h/6h/24h/7d/permanent | 後台封鎖時長選項 |

---

## 6. 資源限制與 Scaling 假設

### 6.1 Cloud Run 資源設定（`Makefile` `deploy-run`）

| 參數 | 值 | 推論 |
| --- | --- | --- |
| `--min-instances 0` | 閒置縮到零 | 零成本待機，代價是**冷啟動**（數秒）；首個連入者承擔延遲 |
| `--max-instances 1` | 永遠單一 instance | 見 §6.2 |
| `--memory 512Mi` | 512 MiB | 純 Node 遊戲邏輯足夠；three.js/Rapier 打包進前端靜態檔，不佔伺服器記憶體 |
| `--timeout 3600` | 請求上限 1 小時 | 覆蓋長對局與 WebSocket 連線壽命 |
| `--session-affinity` | 工作階段親和性 | WebSocket 連線必須回到同一 instance；單 instance 下亦保護連線穩定 |

### 6.2 為什麼鎖定單 instance

1. **狀態一致性**：大廳訂閱者（`lobbySockets`）、IP 即時計數、指標分鐘桶都在記憶體中；單 instance 免去跨 instance 同步問題。
2. **流量模型**：雙人小遊戲的併發遠低於單 instance 容量（512Mi Node process 可承載數百條 WS 連線）；擴容前先靠 Firestore 報表（`/api/admin/metrics/*`）取得實際負載數據。
3. **容錯靠持久化**：房間狀態與後台資料皆寫 Firestore，instance 重啟後房間可重建、封鎖名單與公告不遺失（`server/firestore-store.ts`、`server/firestore-admin.ts`）。真正無法恢復的只有「重啟瞬間斷線」——玩家重整即由斷線寬限／接手機制救回。

### 6.3 CPU throttling 對計時器的影響（架構鐵則）

Cloud Run 在請求空檔會**節流 CPU**，`setTimeout`／`setInterval` 不可靠。因此：

- **計時一律以 deadline 時間戳惰性判定**：房間保存絕對時間戳（如回合 deadline），事件到來或 `evaluate()` 被呼叫時以 `deps.now()` 比對判定逾時（`server/room.ts` `RoomDeps.now()`；`server/tests/timers.test.ts` 逐案驗證）。`setTimeout` 僅作為「提前喚醒」的輔助，漏掉也會在下一次 evaluate 補判。
- **WebSocket keepalive**：每 30 秒 ping（`server/index.ts` `HEARTBEAT_MS = 30_000`），連續未回 pong 即 terminate，避免 Cloud Run／代理層切斷閒置連線造成殭屍座位。
- **週期性任務皆 `unref()`**：`rooms.sweep()`（每 60 秒清掃過期房間）、指標取樣、IP 監控 timer 皆不阻止程序退出，讓 instance 順利縮容。

### 6.4 已知風險與對策

| 風險 | 影響 | 對策 |
| --- | --- | --- |
| 冷啟動（min-instances 0） | 首位玩家等待數秒 | 前端 LOADING 畫面；Firestore 資料冷讀延遲可接受 |
| 單 instance 故障 | 全站短暫不可用 | 房間資料在 Firestore，重啟後重連即恢復；斷線寬限 + 接手機制兜底 |
| 惡意流量打滿單 instance | 服務中斷 | IP 監控 + 閥值告警 + 後台一鍵封鎖（5m～永久），封鎖即時踢線（`server/index.ts` HTTP 403 / WS upgrade 拒絕 / close 4003） |
| `ADMIN_SESSION_SECRET` 未設 | 重啟即管理員全數登出 | 正式環境設定固定 secret（見 §5.1） |
| 版本更新踢掉對局 | 進行中對局斷線 | 版號規則 + `/api/health` 驗證（`spec/09-testing-deployment.md`），並依賴斷線寬限／接手 |