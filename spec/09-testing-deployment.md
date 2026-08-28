# 09 · 測試策略、部署與運維（Testing / Deployment / Ops）

> 台灣暗棋 3D 網頁遊戲 — 軟體開發規格書
> 文件版本：v1.0（對應產品版號 v1.1.33）· 最後更新：2026-08-29
> 本文以實際原始碼為準：`package.json`、`vite.config.ts`、`tsconfig.json`、`server/tsconfig.json`、`Dockerfile`、`.github/workflows/deploy.yml`、`Makefile`、`src/tests/`、`server/tests/`、`server/index.ts`。

---

## 1. 測試策略總覽

本專案的品質防線由四層組成，**全部以既有工具執行，不引入新框架**：

| 層 | 工具 | 執行指令 | 涵蓋 |
| --- | --- | --- | --- |
| 1. 型別檢查 | TypeScript strict（兩份 tsconfig） | `npm run typecheck` | client（`tsconfig.json`）+ server（`server/tsconfig.json`） |
| 2. 單元測試 | Vitest（`vitest run`） | `npm test`（watch 用 `npx vitest`） | 規則引擎 + 伺服器邏輯，共 17 檔 152 測試 |
| 3. 生產建置 | `tsc && vite build` + esbuild | `npm run build` | 型別錯誤會直接擋下建置 |
| 4. 實機 E2E | agent-browser 瀏覽器自動化 | 人工／Agent 於 dev 或正式環境操作 | 真實瀏覽器中的 3D、WS、音效、後台流程 |

> 鐵則：每次程式碼變更都必須通過 `npm test` + `npm run typecheck` 才能提交（`AGENTS.md`）；GitHub Actions 亦在部署前重跑 `npm test` + `npm run build`（內含 `tsc`）。

## 2. Vitest 測試分布（17 檔 · 152 測試）

### 2.1 規則引擎與共用（`src/tests/` — 7 檔 71 測試）

| 測試檔 | 案例數 | 涵蓋內容 |
| --- | --- | --- |
| `rules.test.ts` | 32 | 開局盤面、首翻定陣營、回合輪轉、移動與吃子（階級剋制）、將帥對兵特殊剋制、蓋牌狀態、棋盤簿記 |
| `cannon.test.ts` | 16 | 炮的完整規則（隔子吃子、移動路徑） |
| `victory.test.ts` | 8 | 勝負判定：全殲、無子可動、無吃子 25 回合和局（台灣比賽規則）、開局承諾雜湊 |
| `history.test.ts` | 5 | 歷史紀錄格式化：對局結論、座標標籤（positionLabel）、每步描述 |
| `canned.test.ts` | 4 | 罐頭訊息資料集（76 句）與 15 秒隨機子集輪播 |
| `fun-names.test.ts` | 4 | 36 個趣味暱稱隨機指派 |
| `members.test.ts` | 2 | 房間人員名單的中文筆畫排序 |

### 2.2 伺服器（`server/tests/` — 10 檔 81 測試）

| 測試檔 | 案例數 | 涵蓋內容 |
| --- | --- | --- |
| `room.test.ts` | 22 | 入座與身分 token、動作驗證（翻牌／吃子、認輸、和局協議、再來一局換先手）、觀戰者限制、戰情中心公開資訊、持久化往返、訊息解析 |
| `auth.test.ts` | 11 | Google ID token 驗證（RS256/JWKS/aud/iss/exp）、HMAC session cookie、allowlist |
| `ip-monitor.test.ts` | 10 | IP 計數、四類閥值告警、封鎖到期、資料保留清理 |
| `timers.test.ts` | 8 | 回合時鐘逾期判負、斷線時鐘暫停、寬限判負、重連恢復剩餘時間 |
| `chat.test.ts` | 6 | 聊天頻率限制（burst/window/min-gap）、長度上限、尾窗數量 |
| `takeover.test.ts` | 6 | 殘局接手：棄置座位開放觀戰者、token 發放、時鐘交接 |
| `announcements.test.ts` | 5 | 公告發布、廣播、已讀回執（ack）彙整 |
| `metrics.test.ts` | 5 | 指標分鐘桶、小時 rollup、保留期清理 |
| `redact.test.ts` | 5 | **蓋牌遮蔽鐵則**：下行狀態絕不含未翻開棋子的 color/type |
| `lobby.test.ts` | 3 | 戰情中心列表：排序、終局 5 分鐘保留、僅公開資訊 |

> 測試案例數以 `grep -c '^\s*(it|test)('` 逐檔實測，合計 152；檔案數 17（不含兩個工具檔）。

## 3. 測試工具與手法

### 3.1 規則引擎測試工具（`src/tests/test-utils.ts`）

- `buildState(specs, options)`：依棋子規格（id/color/type/row/col/faceUp）組出**最小但完全合法**的 `GameState`（空棋盤 + 指定棋子 + 玩家輪轉設定），避免測試需要完整洗牌開局。
- `at(row, col)`：座標常數縮寫。
- 規則引擎本身為純函式（`src/game/`，零 DOM／零 Three.js 依賴），可直接在 Node 環境被 Vitest 執行——這是「規則與表現分離」架構的直接紅利。

### 3.2 伺服器測試工具（`server/tests/server-test-utils.ts`）

| 工具 | 說明 |
| --- | --- |
| `FakeSocket` | 實作 `ClientSocket` 介面的假連線：`send()` 把每則下行訊息 JSON 解析後存入 `sent` 陣列；`ofType(t)` 以訊息型別過濾、`last()` 取最後一則，測試直接斷言訊息內容而非 mock 細節 |
| `TestClock` / `makeClock(start)` | 可手撥的手錶：`now()` 回傳當前時間、`advance(ms)` 手動推進。**不依賴 fake timers**，與生產碼的時間模型一致 |
| `makeDeps(clock)` | 組出 `RoomDeps`：`{ store: new InMemoryStore(), now: () => clock.now(), clock }`——把時間與儲存同時注入 |

### 3.3 時間注入與 deadline 惰性判定

- `Room` 接受 `deps.now()`（`server/room.ts:46` `RoomDeps`），所有時限（回合 `TURN_MS`、斷線寬限 `GRACE_MS`）都換算為**絕對 deadline 時間戳**，由 `evaluate()` 惰性比對判定——`setTimeout` 只是輔助喚醒（Cloud Run CPU throttling 下不可靠，見 `spec/04-platform.md` §6.3）。
- 測試模式：`deps.clock.advance(TURN_MS + 1)` → `room.evaluate()` → 斷言 `gameOver.reason === 'timeout'`（`server/tests/timers.test.ts`）。斷線暫停、寬限、重連恢復皆以同法驗證。
- `server/auth.ts` 的 `verifyGoogleIdToken` 同樣接受 `deps: { fetchCerts?, now? }` 注入，`auth.test.ts` 以假 JWKS 與假時鐘完整測試 RS256 驗證路徑，不需打真實 Google 端點。
- 儲存注入：測試一律用 `InMemoryStore`（`server/store.ts`），並以 `FIRESTORE_ENABLED=0` 隔離 Firestore。

## 4. 實機 E2E（agent-browser 瀏覽器自動化）

單元測試無法覆蓋 3D 渲染、物理動畫、WebSocket 端到端與音效，這些以 **agent-browser**（瀏覽器自動化 CLI skill：可導頁、點擊、填表、截圖、擷取資料）做實機驗證：

| 情境 | 操作方式 |
| --- | --- |
| 本機驗證 | 終端機 A：`make dev`（Vite 5173，proxy `/api`、`/ws` → 8787）；終端機 B：`make dev-server`（`FIRESTORE_ENABLED=0` 的遊戲伺服器）。再以 agent-browser 開 `http://localhost:5173` 走完整流程 |
| 全量本機模擬 | `make start-local`（build + build:server 後以 `FIRESTORE_ENABLED=0 PORT=8787 npm start` 提供 production bundle 本機伺服） |
| 典型腳本 | 建立房間 → 複製邀請連結／QR → 第二個分頁加入 → 翻牌對局 → 聊天罐頭訊息 → 結算「再來一局」→ 戰情中心觀戰 |
| 後台驗證 | `/admin` Google 登入 → 發公告（前台應彈出強制對話框）→ 查看報表圖表與 IP 監控表格 |
| 正式機抽檢 | 部署後以同一套腳本對 `https://dark-chess.game.miniasp.com` 做煙霧測試，並核對頁腳版號 |

> E2E 屬人工觸發的抽檢（不做常駐 CI），用於單元測試覆蓋不到的視覺、互動與跨程序整合；每次大功能上線（如後台、接手機制）至少執行一輪。

## 5. 建置流程

### 5.1 npm scripts 全表（`package.json`）

| 指令 | 實際命令 | 說明 |
| --- | --- | --- |
| `npm run dev` | `vite` | 開發伺服器（5173）；proxy `/api` → `http://localhost:8787`、`/ws` → `ws://localhost:8787`（`vite.config.ts`） |
| `npm run dev:server` | `FIRESTORE_ENABLED=0 tsx watch server/index.ts` | 本機遊戲伺服器（tsx watch 熱重載、關 Firestore） |
| `npm run build` | `tsc && vite build` | **型別檢查 + 前端生產建置**；產出 `dist/`（含 `index.html` 與 `admin.html` 兩個入口） |
| `npm run build:server` | `esbuild server/index.ts --bundle --platform=node --format=esm --packages=external --define:__APP_VERSION__=… --outfile=dist-server/index.mjs` | 伺服器打包成單一 ESM 檔；`--packages=external` 讓 express/ws/Firestore 走 runtime `node_modules` |
| `npm run preview` | `vite preview` | 本機預覽 `dist/` |
| `npm start` | `node dist-server/index.mjs` | 執行打包後的伺服器（同時供 `dist/` 靜態檔與 API/WS） |
| `npm test` | `vitest run` | 單元測試一次跑完 |
| `npm run typecheck` | `tsc && tsc -p server` | 兩份 tsconfig 各自全量型別檢查（client 與 server 的 lib/types 不同） |

### 5.2 Vite 多頁面與 WASM 處理（`vite.config.ts`）

- **多頁面入口**：`rollupOptions.input` 宣告 `main: index.html` 與 `admin: admin.html`——前台與管理後台共用一次建置，各自獨立 bundle。
- **`define.__APP_VERSION__`**：以 `package.json` 的 `version` 編譯期注入，前端於 `src/app.ts:81` 顯示為頁腳版號。
- **`build.target: 'es2022'`**：統一輸出目標（見 `spec/04-platform.md` §2）。
- **WASM**：Rapier 3D 為 WebAssembly 套件，需 `vite-plugin-wasm` 才能在 bundle 中正確載入 `.wasm`；`optimizeDeps.exclude: ['@dimforge/rapier3d']` 避開 dev pre-bundler 對 WASM 的不相容處理。
- **依賴分層**：`three`、`@dimforge/rapier3d`、`qrcode` 列於 `devDependencies`——因為 Vite 會把它們**烤進 `dist/`**，伺服器 runtime 不需要它們（見 Dockerfile 註解）。`chart.js` 雖列在 `dependencies`，實際上只被前端後台頁引用（`src/admin/admin.ts`），同樣由 Vite 打包進前端 bundle。

## 6. Docker 多階段建置（`Dockerfile` 逐行解析）

| # | 指令 | 作用 |
| --- | --- | --- |
| 1 | `FROM node:22-slim AS build` | 建置階段：Node 22 slim 映像 |
| 2 | `WORKDIR /app` | 固定工作目錄 |
| 3 | `COPY package*.json ./` | 先只複製 manifest——**利用 Docker layer cache**，原始碼變動時不必重跑 `npm ci` |
| 4 | `RUN npm ci` | 以 `package-lock.json` 完全重現依賴樹（含 devDependencies：Vite/Three.js/esbuild 等） |
| 5 | `COPY . .` | 複製原始碼（`.dockerignore` 排除 `node_modules`、`dist`、`dist-server`、`.git`、`.github`、`.claude`、`*.log`） |
| 6 | `RUN npm run build && npm run build:server` | 同時產出前端 `dist/` 與伺服器 `dist-server/index.mjs`（`tsc` 型別錯誤會在 image build 階段擋下） |
| 7 | `FROM node:22-slim` | 執行階段：乾淨的新基礎映像，建置工具全部不留 |
| 8 | `ENV NODE_ENV=production` | 生產模式 |
| 9 | `COPY package*.json ./` + `RUN npm ci --omit=dev && npm cache clean --force` | **只裝 runtime 依賴**（`express`、`ws`、`@google-cloud/firestore`、`chart.js`）；three.js／Rapier 是 devDependencies，已被 Vite 烤進 `dist/`，故不進映像 |
| 10 | `COPY --from=build /app/dist ./dist` | 前端靜態檔（index.html + admin.html） |
| 11 | `COPY --from=build /app/dist-server ./dist-server` | 伺服器 bundle |
| 12 | `EXPOSE 8080` + `CMD ["node", "dist-server/index.mjs"]` | Cloud Run 容器埠 8080；啟動即單一 Node 程序（HTTP + WS + 靜態檔同埠） |

## 7. CI/CD：GitHub Actions（`.github/workflows/deploy.yml`）

| 區塊 | 內容 | 說明 |
| --- | --- | --- |
| 觸發 | `push` 至 `main` + `workflow_dispatch`（手動） | `make deploy`（push main）與主控台手動觸發共用同一 workflow |
| 權限 | `contents: read`、`pages: write`、`id-token: write` | Pages 部署所需最小權限 |
| 併發控制 | `concurrency.group: pages`、`cancel-in-progress: true` | 連續 push 時取消過期部署，只保留最新 |
| Job `build` | `checkout@v4` → `setup-node@v4`（Node 22、`cache: npm`）→ `npm ci` → **`npm test`** → **`npm run build`**（含 `tsc`）→ `upload-pages-artifact@v3`（path: `dist`） | 測試與型別檢查不過即不部署 |
| Job `deploy` | `needs: build` → `environment: github-pages` → `deploy-pages@v4` | 發佈 `dist/` 至 GitHub Pages，URL 回寫至 environment |

> **注意分工**：GitHub Actions 只負責 GitHub Pages（靜態站）。Cloud Run 主站不經 Actions——由 `make deploy-run` 以 `gcloud run deploy --source .` 觸發 Cloud Build 讀取 `Dockerfile` 建置部署（見 §8.1）。

## 8. 部署流程

### 8.1 `make deploy-run`（Cloud Run 主站）

```
make deploy-run
  └─ depends on: make bump            # 版號 patch +1，自動 commit
  └─ gcloud run deploy dark-chess --source . \
       --project vertex-ai-sprint --region asia-east1 \
       --allow-unauthenticated --session-affinity \
       --timeout 3600 --min-instances 0 --max-instances 1 \
       --memory 512Mi --port 8080
  └─ gcloud run services describe … → 取得 status.url
  └─ 終端機輸出正式機網址 + 健康檢查網址
  └─ curl -s --max-time 15 "$url/api/health"   # 版號驗證
```

- `--source .` 讓 Cloud Build 直接以 `Dockerfile` 建置（§6），不需要本地 push image。
- 部署完成**自動列印**正式機網址與 `/api/health` 回應；隨時可再以 `make url-run` 查詢（網址 + 版號驗證）、`make logs-run` 看最近 50 行日誌、`make open-run` 開瀏覽器。

### 8.2 `make deploy`（GitHub Pages 單機版）

```
make deploy
  └─ make test     # vitest run
  └─ make build    # tsc + vite build
  └─ make bump     # 版號 patch +1 + commit
  └─ git push origin main                     # 觸發 §7 workflow
  └─ gh run watch --exit-status <最新 run>     # 等待部署完成，失敗即回傳非零
```

輔助指令：`make status`（最近 5 次 workflow）、`make open`（開啟 https://dark-chess.gh.miniasp.com ）。

### 8.3 版號規則（每次部署必做）

- **唯一來源**：`package.json` 的 `version`（目前 `1.1.33`）。
- **注入路徑**：前端經 Vite `define.__APP_VERSION__`、伺服器經 esbuild `--define:__APP_VERSION__`；顯示於首頁頁腳（`src/app.ts:81`）、對局畫面版權列與 `/api/health` 回應。
- **`make bump`**：`npm version patch --no-git-tag-version` → `git add package.json package-lock.json` → 自動 commit `chore: 更版 vX.Y.Z`。`make deploy` 與 `make deploy-run` 都已內建，**走 Makefile 即不會漏**。
- 繞過 Makefile 手動部署時，**必須先 `make bump` 再部署**；功能級改版改用 `npm version minor|major --no-git-tag-version` 後自行 commit。

## 9. 運維（Operations）

### 9.1 健康檢查

| 端點 | 回應 | 用途 |
| --- | --- | --- |
| `GET /healthz` | `200` 純文字 `ok` | 純存活檢查（無版本邏輯，`server/index.ts`） |
| `GET /api/health` | `200` JSON `{"ok":true,"version":"<版號>"}` | 部署驗證與前端線上模式偵測；**部署後核對版號是否等於 `package.json` 的 version** |

兩者皆豁免於 IP 封鎖中間層（`server/index.ts` 的路徑白名單），管理員不會把自己鎖在健康檢查之外。

### 9.2 Firestore 資料生命週期（TTL）

| 集合 | 內容 | 生命週期 |
| --- | --- | --- |
| `rooms` | 房間快照（含 `expireAt` Timestamp） | 依 TTL policy 由 Firestore 自動刪除：已結束 24 小時（`FINISHED_ROOM_TTL_MS`）、閒置 7 天（`IDLE_ROOM_TTL_MS`）。啟用方式（`server/firestore-store.ts` 註解）：`gcloud firestore fields ttls update expireAt --collection-group=rooms --enable-ttl` |
| `announcements` | 公告歷史與已讀名單 | 永久保留（後台可查） |
| `metrics_hours` | 指標小時 rollup | 供日／小時報表長期查詢（記憶體端分鐘桶保留 72 小時、小時桶 90 天，`server/metrics.ts`） |
| `ip_hours` / `ip_alerts` | IP 流量小時桶與警示 | 7 天保留期，由 `IpMonitor` 週期呼叫 `deleteIpDataOlderThan(cutoff)` 清理（`server/firestore-admin.ts:86`） |
| `ip_blocks` | 封鎖名單 | 至 `expiresAt`（`null` 為永久），重啟後自動載回 |

### 9.3 日誌與指標

- **日誌**：全走 `console.log/error` 進 Cloud Logging；`make logs-run`＝`gcloud run services logs read dark-chess --region asia-east1 --project vertex-ai-sprint --limit 50`。關鍵錯誤點皆有語意化訊息（如 `admin google auth failed`、`metrics series failed`、`list games failed`、`broadcastLobby failed`）。
- **即時指標**：`Metrics` 每 5 秒取樣、每 60 秒彙整（`server/metrics.ts` `start(60_000, 5_000)`），分鐘桶含 HTTP 數、WS 數、連線/房間/大廳 gauge、lag P95/max、CPU 均值/峰值、RSS 峰值。
- **報表**：後台 `/api/admin/metrics/live`（即時快照）與 `/api/admin/metrics/series?granularity=minute|hour|day`（分鐘走記憶體、小時/日走 Firestore rollup）。
- **IP 告警**：四類閥值可由 `IP_ALERT_*` 環境變數調整（見 `spec/04-platform.md` §5.1）；告警寫入 `ip_alerts`，後台顯示即時警示與 Top 10 流量表。

### 9.4 正式機驗證流程（部署後標準動作）

1. `make deploy-run` 完成後，終端機已印出：正式機網址、健康檢查網址、`/api/health` 版號回應。
2. **核對版號**：`curl -s https://dark-chess.game.miniasp.com/api/health` 的 `version` 必須等於 `package.json` 的 `version`；不等於代表部署失敗或 DNS/快取未收斂。
3. `make open-run` 開啟正式站，抽測：首頁戰情中心 → 建立房間 → 邀請連結加入 → 對局一步 → 聊天。
4. 後台抽測：`/admin` 登入 → 公告發布 → 報表有數據。
5. 異常時 `make logs-run` 查日誌，確認是否為冷啟動、Firestore 連線或版號未生效。
6. 遠端單機版同步確認：`make status` 看 Pages workflow，`https://dark-chess.gh.miniasp.com` 頁腳版號一致。

### 9.5 災難情境速查

| 情境 | 徵兆 | 處置 |
| --- | --- | --- |
| 版號未遞增 | `/api/health` version 與 `package.json` 不符 | 重跑 `make bump` + `make deploy-run`；確認瀏覽器快取 |
| 測試在 CI 失敗 | `deploy.yml` build job 紅 | Pages 不會更新；本地重現修復後再 push |
| WS 大量斷線 | 後台指標 WS 曲線崩落、lag 飆高 | 檢查 Cloud Run 部署／重啟紀錄；玩家靠斷線寬限（`GRACE_MS` 90s）與接手機制恢復 |
| 異常流量 | `ip_alerts` 告警、`/api/admin/ip-stats` Top 10 異常 | 後台封鎖（5m～永久），即時踢線；閥值可用 `IP_ALERT_*` 微調 |
| Firestore 寫入失敗 | 日誌 `list games failed` 等 | 遊戲仍可用記憶體狀態進行；重啟後靠重連恢復，檢查 GCP 狀態頁 |