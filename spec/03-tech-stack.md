# 03 · 技術採用（Tech Stack）

> 台灣暗棋（Taiwan Dark Chess）3D 網頁遊戲 — 軟體開發規格書
> 文件版本：v1.0（對應產品版號 v1.1.33）· 最後更新：2026-08-29
> 本章所有版本號取自 `package.json` 與 `package-lock.json` 實際安裝版本；所有描述皆以原始碼為準。

---

## 1. 語言與工具鏈

### 1.1 TypeScript（strict）

- **版本**：`typescript@^7.0.2`（鎖定安裝 7.0.2）。型別檢查同時涵蓋 client 與 server 兩個 tsconfig：`npm run typecheck` = `tsc && tsc -p server`（`package.json` scripts）。
- **為什麼全程 TS**：規則引擎（`src/game/`）要在 client 與 server 雙端共用同一份程式碼，型別即契約——`Action`/`GameState`（`src/game/types.ts`）與 `ClientMessage`/`ServerMessage`（`src/shared/protocol.ts`）的聯集型別讓「訊息欄位寫錯」直接變編譯錯誤。

**`tsconfig.json`（client）重點設定**：

| 設定 | 值 | 理由（對應實際程式碼行為） |
| --- | --- | --- |
| `target` / `lib` | `ES2022` / `["ES2022","DOM","DOM.Iterable"]` | 使用 `structuredClone`（`game-state.ts` 的 `cloneState`）、`Array.prototype.at` 等新 API；Vite build target 也是 `es2022` |
| `module` / `moduleResolution` | `ESNext` / `bundler` | 純 ESM（`"type":"module"`），解析行為與 Vite 一致 |
| `strict` | `true` | 全域嚴格模式 |
| `noUncheckedIndexedAccess` | `true` | 強制處理 `state.pieces[pieceId]` 可能為 `undefined`（`actions.ts` 全程 `!piece \|\| piece.captured` 檢查的型別基礎） |
| `noUnusedLocals` / `noUnusedParameters` | `true` | 死碼清零 |
| `noFallthroughCasesInSwitch` | `true` | `validateAction`/`route` 這類大型 switch 的保險絲 |
| `verbatimModuleSyntax` / `isolatedModules` | `true` | `import type` 與值匯入涇渭分明，符合 Vite esbuild 單檔轉譯模型（`controller.ts`、`app.ts` 大量使用 `import type`） |
| `noEmit` | `true` | 型別檢查歸型別檢查，產物一律交給 Vite/esbuild |
| `resolveJsonModule` | `true` | `vite.config.ts` 讀 `package.json` 版號（`define.__APP_VERSION__`） |
| `types` | `["vite/client"]` | 讓 `import.meta.env`、資產 import 有型別；`__APP_VERSION__` 由 `src/vite-env.d.ts` 自行宣告 |
| `include` | `["src", "vite.config.ts"]` | client 範圍不含 `server/` |

**`server/tsconfig.json`（server）**：繼承根設定，改 `lib: ["ES2022"]`（去掉 DOM）、`types: ["node"]`，並 **include `"../src/game/**/*.ts"` 與 `"../src/shared/**/*.ts"`**——這一行是「client/server 共用規則引擎與協定型別」在專案設定層的落實；同時 server 端的 `__APP_VERSION__` 由 `server/globals.d.ts` 宣告為 `string | undefined`（tsx 本機開發時未注入）。

### 1.2 Vite 8

- **版本**：`vite@^8.2.2`（安裝 8.2.2）；外掛 `vite-plugin-wasm@^3.6.0`。
- **角色**：開發伺服器（`npm run dev`）+ 前端生產打包（`npm run build` = `tsc && vite build`）。

**`vite.config.ts` 逐項**：

| 設定 | 內容 | 對應需求 |
| --- | --- | --- |
| `plugins: [wasm()]` | 讓 `@dimforge/rapier3d` 的 `.wasm` 模組可直接 `import` | Rapier 3D 物理引擎（WASM 版） |
| `define.__APP_VERSION__` | `JSON.stringify(pkg.version)` | 版號注入前端（`src/app.ts` boot 顯示於 `#app-version`、`#app-version-game`） |
| `build.target: 'es2022'` | 與 tsconfig target 對齊 | 現代瀏覽器直出，減少轉譯負擔 |
| `rollupOptions.input` | `main: index.html`、`admin: admin.html` | **多頁面**：遊戲本體與管理後台分開兩個 bundle，後台 JS（chart.js 等）不會進到玩家端載入路徑 |
| `optimizeDeps.exclude: ['@dimforge/rapier3d']` | 避開 pre-bundle | Rapier 需要真正的 WASM import，預先打包會破壞其載入方式；同時 `PhysicsWorld.create()` 用 `await import('@dimforge/rapier3d')` 動態載入，讓 LOADING 進度條可分階段（先引擎後棋盤） |
| `server.proxy` | `'/api' → http://localhost:8787`、`'/ws' → ws://localhost:8787 (ws: true)` | 本機開發時前端(5173)與遊戲伺服器(8787，`make dev-server`)同源共存；`/api/health` 探測也因此同一條規則就能通 |

### 1.3 esbuild / tsx（伺服器工具鏈）

- **`npm run build:server`**：`esbuild server/index.ts --bundle --platform=node --format=esm --packages=external --define:__APP_VERSION__="'$npm_package_version'" --outfile=dist-server/index.mjs`
  - `--packages=external`：`express`、`ws`、`@google-cloud/firestore` 等維持外部依賴（runtime image 以 `npm ci --omit=dev` 安裝，見 `Dockerfile` 註解），bundle 只含專案程式碼（含共用的 `src/game/`、`src/shared/`）。
  - `--define`：與前端同一版號來源 `package.json`，`/api/health` 回傳的版號（`server/index.ts` 的 `APP_VERSION`）因此與首頁頁腳一致。
- **`tsx`（`tsx@^4.19.2`，安裝 4.23.12）**：`npm run dev:server` = `FIRESTORE_ENABLED=0 tsx watch server/index.ts`——本機開發直接跑 TS 原始碼 + 熱重載，且預設關閉 Firestore（用 `InMemoryStore`）。

### 1.4 Node.js

- **執行環境**：`node:22-slim`（`Dockerfile` 建置與 runtime 兩階段）、CI `node-version: 22`（`.github/workflows/deploy.yml`）；本機開發目前為 Node 24（向下相容 22 LTS）。
- **使用到的標準庫**：`node:http`（`createServer` 供 ws noServer 升級）、`node:crypto`（見 §3.4）、`node:path`、`node:url`、`node:perf_hooks`（`monitorEventLoopDelay`，`server/metrics.ts`）。

---

## 2. 版本清單（以 `package.json` + 實際安裝為準）

| 套件 | package.json | 安裝版本 | 區分 | 用途 |
| --- | --- | --- | --- | --- |
| typescript | `^7.0.2` | 7.0.2 | dev | 型別檢查（client + server） |
| vite | `^8.2.2` | 8.2.2 | dev | 前端建置與 dev server |
| vite-plugin-wasm | `^3.6.0` | 3.6.0 | dev | Rapier WASM 載入 |
| vitest | `^4.1.11` | 4.1.11 | dev | 單元測試 |
| esbuild | `^0.28.0` | 0.28.2 | dev | 伺服器打包 |
| tsx | `^4.19.2` | 4.23.12 | dev | 伺服器開發執行 |
| three | `^0.185.1` | 0.185.1 | dev* | 3D 渲染 |
| @types/three | `^0.185.4` | — | dev | three 型別 |
| @dimforge/rapier3d | `^0.20.0` | 0.20.0 | dev* | WASM 物理引擎 |
| qrcode | `^1.5.4` | 1.5.4 | dev* | 邀請 QR Code 生成 |
| @types/qrcode | `^1.5.5` | — | dev | qrcode 型別 |
| chart.js | `^4.5.1` | 4.5.1 | dependencies | 後台圖表 |
| express | `^4.21.2` | 4.22.2 | dependencies | HTTP 伺服器 |
| @types/express | `^4.17.21` | — | dev | express 型別 |
| ws | `^8.18.0` | 8.21.3 | dependencies | WebSocket |
| @types/ws | `^8.5.13` | — | dev | ws 型別 |
| @google-cloud/firestore | `^7.11.0` | 7.11.6 | dependencies | 房間/後台持久化 |
| @types/node | `^22.10.0` | 22.20.1 | dev | Node 型別 |

> \* **依賴區分的刻意安排**：`three`、`@dimforge/rapier3d`、`qrcode` 放在 **devDependencies**——Vite 會把它們打包進 `dist/`，runtime image（`Dockerfile` 第二階段 `npm ci --omit=dev`）完全不需要它們；Dockerfile 註解明言「three.js / Rapier are devDependencies — Vite bakes them into dist/」。真正會在 Node runtime 載入的只有 `express`、`ws`、`@google-cloud/firestore`（chart.js 雖列於 dependencies，實際只被 `src/admin/admin.ts` 引用、由 Vite 打包進 admin bundle）。

---

## 3. 前端依賴

### 3.1 Three.js（three@0.185.1）— 3D 場景

**為何選 Three.js**：
1. 宣告式程度恰好的場景圖 API，團隊不需自寫 WebGL boilerplate；
2. `Raycaster` + `Group.userData` 天然支援「點擊棋子」互動（`src/rendering/raycaster.ts`）；
3. 程序化紋理友善：`CanvasTexture` 直接吃 Canvas 2D 畫布，本專案所有木紋、棋盤格、棋子字面都是執行期以 Canvas 繪製（`src/rendering/textures.ts`），**零圖檔資源**；
4. TypeScript 型別完整（搭配 `@types/three`）。

**實際使用面**（皆可在 `src/rendering/` 查證）：
- `scene.ts`：`WebGLRenderer`（antialias、`powerPreference:'high-performance'`、pixelRatio 上限 2、ACESFilmicToneMapping、PCFShadowMap）；半球光 + 主光（`castShadow`，依 `navigator.hardwareConcurrency ≤ 4` 降級 shadowmap 1024）+ 輔光；`isWebGLAvailable()` 開機探測。
- `camera.ts` `layoutCamera()`：**固定、不可環繞**的桌面視角；以 14 次迭代把 8 個棋盤角落投影點收斂進安全邊界（保留 HUD 佔位），直向（aspect<0.95）旋轉 90° 並回傳 `pieceYaw = π/2` 讓棋子字面保持朝上。
- `piece-mesh.ts`：`LatheGeometry` 斜切輪廓做出圓片棋子，32 顆共用一份 body geometry，只有牌面材質依 `(color,type)` 快取（`materials.ts` 的 `face()` Map）。
- `board.ts` `BoardView`：選中金環、可移動綠環、可吃紅菱形（**形狀+顏色雙重編碼**，類別註解明言為色覺障礙可及性）、非法格閃紅。
- `raycaster.ts` `BoardPicker.pick()`：先射棋子（沿 parent chain 找 `userData.pieceId`），落空再對棋盤平面求交換算格位。

**替代方案比較**：

| 方案 | 未採用理由 |
| --- | --- |
| Babylon.js | 功能更全但體積與 API 面更大；本專案只需要固定視角 + 光影 + 拾取 |
| 純 WebGL / regl | 需自建場景圖、材質管理、陰影、raycasting——開發成本遠超收益 |
| CSS 3D transform | 無法做出棋子斜切造型、投射陰影與物理翻滾的品質 |

### 3.2 @dimforge/rapier3d（rapier3d@0.20.0）— WASM 物理

**為何選 Rapier**：
1. **Rust → WASM**，效能與確定性遠勝純 JS 物理庫，手機也能跑固定 60Hz 步長；
2. **kinematic ↔ dynamic 可即時切換**（`RigidBody.setBodyType`）——本專案的關鍵需求：閒置棋子是 kinematic（不漂移、可當碰撞體），動畫瞬間轉 dynamic，結束 `settle()` 轉回（`src/physics/world.ts`）；
3. WASM 體積可控：動態 `import()` + `optimizeDeps.exclude`，放在 boot 流程的第二階段（進度條 30%→70%）。

**實際使用面**：
- `PhysicsWorld.create()`：重力 `y=-22`、棋盤 slab（摩擦 0.75／彈性 0.32）+ 23×23 桌面；`step()` 以 1/60 固定步長 + 累加器（上限 5 子步）消化不穩定幀距。
- 棋子碰撞體：圓柱（`ColliderDesc.cylinder`），密度 1.6、彈性 0.42。
- **只做表現**：翻棋的拋射翻滾（`GameController.animateFlip` 的 `launch()`）與吃子的擊飛（`animateCapture`）由物理積分，結束一律 `settle()` + `blendToPose()`/`snap()` 對齊 `logicalPose()`（由權威 `GameState` 推導）。

**替代方案比較**：

| 方案 | 未採用理由 |
| --- | --- |
| cannon-es（純 JS） | 效能不足、kinematic 切換語意弱、維護停滯 |
| ammo.js（Emscripten Bullet） | 體積大、API 老、型別差 |
| 不用物理（純 tween） | 翻棋翻滾與吃子擊飛的隨機感/重量感會大幅失真——這是遊戲的招牌演出 |

### 3.3 chart.js（4.5.1）— 後台圖表

- **用在哪**：`src/admin/admin.ts` 註冊 `Chart.register(...registerables)`，在 `admin.html` 的三個 `<canvas id="chart-minute|hour|day">` 上繪製分鐘/小時/日報表（`/api/admin/metrics/series`）。
- **為何選它**：宣告式、開箱即用的折線圖；後台資料維度固定（HTTP 數、WS 訊息數、連線峰值、CPU、RSS/Heap），不需要 D3 級別的客製；體積經由獨立 admin bundle 不影響玩家端。

### 3.4 qrcode（1.5.4）— 邀請 QR Code

- **用在哪**：`src/ui/online-lobby.ts` 的 `renderQr()` —— **動態 `import('qrcode')`**，只在等待房間畫面（`showInvite()`）才載入，主 bundle 不含它；以 `QRCode.toCanvas` 畫進 `<canvas id="invite-qr">`（168px、自訂深淺色）。
- **為何選它**：純前端生成（無外部 API、無網路依賴、無隱私外洩），邀請連結 `https://…/r/{roomId}` 掃碼即開。

---

## 4. 伺服器依賴

### 4.1 Express（4.22.2）

- **職責**（`server/index.ts`）：靜態檔（`express.static(distDir)`）、REST API（`/api/health`、`/api/rooms`、`/api/games`、`/api/admin/*`）、SPA 路由 fallback（`/r/{10碼}`、`/online`、`/setup` 回 `index.html`）、`/admin` 回 `admin.html`、IP 封鎖中介層。
- **`app.set('trust proxy', true)`**：Cloud Run 在 Google Front End 終結 TLS，真實 client IP 在 `X-Forwarded-For`；程式註解與 `clientIp()`（取 XFF 第一段，fallback `req.ip`、`socket.remoteAddress`）都圍繞這件事。這是 IP 監控/封鎖（`server/ip-monitor.ts`）正確歸因的前提。
- **安全細節**：`express.json({limit:'4kb'})` 限請求體；公告與聊天文字皆以 codepoint 過濾控制字元後截長（500/120 字）。
- **替代方案**：fastify/hono 更快，但此服務的瓶頸在 WS 房間邏輯而非 HTTP；Express 生態與 Cloud Run 範例成熟、`trust proxy` 行為明確。

### 4.2 ws（8.21.3）

- **職責**：對戰協定通道。`new WebSocketServer({ noServer: true })` + `server.on('upgrade')` 手動分流——只有 `pathname === '/ws'` 放行，其餘 `socket.destroy()`；升級時記錄 IP（`wsIps` WeakMap）並擋掉封鎖名單（回 403 後銷毀）。
- **心跳**：30 秒 `ws.ping()` + `pong` 檢查 WeakSet `alive`，未回應者 `terminate()`——註解明言「Cloud Run (and some proxies) drop silent connections」。
- **為何選裸 ws 而非 socket.io**：協定完全自訂（`src/shared/protocol.ts` 的 tagged union），不需要 socket.io 的房間/廣播抽象（`Room.broadcast()` 自己寫更透明）、不需要其 fallback 通道（現代瀏覽器全支援 WS）、體積小且無額外依賴；重連語意（token 重認、grace 恢復）本來就必須在應用層做，socket.io 的自動重連幫不上忙。

### 4.3 @google-cloud/firestore（7.11.6）

- **資料面**（`firestore-store.ts`）：每房一份文件於 `rooms/{roomId}`；`stateJson`/`chatJson` 以字串儲存（註解：Firestore 拒收 `undefined` 欄位，HistoryEntry/ChatMessage 的 optional 欄位會產生）；`expireAt` 為 Timestamp，配合 TTL policy 自動清房（檔頭附 `gcloud firestore fields ttls update` 指令）。`listActive` 只用單一欄位 filter（`status in ['playing','finished']` + limit 200），避免複合索引，排序在記憶體做。
- **後台資料面**（`firestore-admin.ts`）：`announcements`、`metrics_hours`、`ip_hours`、`ip_blocks`、`ip_alerts` 五個 collection；公告/小時指標/IP 封鎖跨部署存活。
- **可插拔設計**：`RoomStore` 介面 + `FIRESTORE_ENABLED`（`server/config.ts`，`npm run dev:server` 與測試設 `0`）→ `InMemoryStore`（`server/store.ts`）；測試因此不需要 GCP 憑證。
- **為何選 Firestore**：Cloud Run 是 serverless、單實例（`--max-instances 1`）多餘狀態會隨實例回收——房間文件必須活過部署與實例重啟；TTL 免自建 GC；與 GCP 部署鏈零設定（ADC）。Redis/自建 DB 都要多維運維。
- **寫入節奏**：`Room.persist()` 是 **write-through + 每房 Promise 序列化鏈**（`persistChain`），慢寫不會被後寫超越；聊天尾窗（`CHAT_TAIL_LENGTH=50`）控制文件大小。

### 4.4 node:crypto — 無外部認證依賴的設計決策

`server/auth.ts` **只用 Node 內建模組**完成整套後台認證：

1. **Google ID token 驗證（手寫 RS256 JWT 驗證）**：`verifyGoogleIdToken()` 解 base64url 三段 → 檢查 `alg==='RS256'` + `kid` → 向 `https://www.googleapis.com/oauth2/v3/certs` 抓 JWKS（**1 小時快取**，`jwksCache`）→ `createPublicKey({key:{kty:'RSA',n,e},format:'jwk'})` + `createVerify('RSA-SHA256')` 驗章 → 再驗 `exp`、`iss`（兩種 Google 值都接受）、`aud === GOOGLE_CLIENT_ID`、`email_verified === true`，最後比對 `ADMIN_EMAILS` allowlist（預設單一管理員信箱）。
2. **Session cookie（HMAC）**：`signAdminSession()` = `base64url({email, exp}) + '.' + HMAC-SHA256(ADMIN_SESSION_SECRET)`；`verifyAdminSession()` 用 `timingSafeEqual` 恆時比對；cookie 屬性 `HttpOnly; Secure; SameSite=Lax; Max-Age=12h`（`adminCookieHeader`）。secret 預設每次啟動隨機（`randomSecret()`）——重啟即全員登出，對一個小後台是可接受的取捨（程式註解明言）。
3. **其他**：`randomBytes` 生成房間 id（10 碼、排除 0/1/o/l 的 base32 字母表，`server/ids.ts`）、座位 token（16 bytes hex）、chat id。

**為何手寫而不引 `jose`/`passport`/`google-auth-library`**：
- 需求面極小：只有「驗一種 RS256 Google ID token + 簽一種 HMAC cookie」兩件事，`jose` 的通用性（多演算法、JWE、key rotation 策略）用不到；
- 避免多一條 supply chain 依賴與審計面（runtime 依賴刻意維持 express/ws/firestore 三件套）；
- 驗證邏輯全部落在單一檔案（`server/auth.ts`，173 行）且可測——`server/tests/auth.test.ts` 以注入 `deps.fetchCerts`/`deps.now` 的方式直接測 JWKS 失敗、過期、issuer/audience 不符等 11 個案例；
- client 端登入由 Google Identity Services 前端 SDK（`admin.ts` 動態載入 `gsi` script）取得 credential，伺服器只當驗證者，不需要 SDK 的伺服器端元件。

---

## 5. 品質工具

### 5.1 Vitest（vitest@4.1.11）

- **現況（本次實測 `npm test`）**：**17 個測試檔、152 個測試，全數通過，總耗時約 0.3 秒**。
- **分布**：

| 目錄 | 檔案 | 測試數 | 涵蓋 |
| --- | --- | --- | --- |
| `src/tests/`（7 檔） | rules(32) / cannon(16) / victory(8) / history(5) / canned(4) / fun-names(4) / members(2) | **71** | 規則引擎（翻/移/吃、炮翻山、將士象馬車兵剋制、25 步無吃子和局）、行棋紀錄格式、罐頭訊息、趣味暱稱、人員名單渲染邏輯 |
| `server/tests/`（10 檔） | room(22) / auth(11) / ip-monitor(10) / timers(8) / chat(6) / takeover(6) / announcements(5) / metrics(5) / redact(5) / lobby(3) | **81** | 房間生命週期、座位/token、回合時鐘（注入假時鐘）、斷線接手、聊天限流、**redact 遮蔽正確性**、戰情中心列表規則、公告、IP 監控、指標 |

- **為何選 Vitest**：與 Vite 同一轉譯管線（`vite.config.ts` 的 define/WASM 設定可直接共用）、原生 ESM、API 兼容 jest 語法；規則引擎是純函式，Node 環境跑得飛快（無需 jsdom）。`server/tests/server-test-utils.ts` 以假的 `ClientSocket`（僅 `send`/`close` 介面，`server/room.ts` 的 `RoomDeps`/`ClientSocket` 介面即為此設計）驅動房間邏輯，不需真 WebSocket。

### 5.2 tsc strict

- `npm run build` 的第一步就是 `tsc`（`noEmit` 純檢查）；`npm run typecheck` 再補 server tsconfig——兩個 tsconfig 的差異（DOM 有無、types）確保**規則引擎不被意外寫出依賴 DOM 的程式碼**：若有人在 `src/game/` 誤用 `window`，server build 立即報錯。

### 5.3 npm scripts 總表

| Script | 內容 | 說明 |
| --- | --- | --- |
| `dev` | `vite` | 前端開發（5173，proxy → 8787） |
| `dev:server` | `FIRESTORE_ENABLED=0 tsx watch server/index.ts` | 伺服器開發（8787，記憶體 store） |
| `build` | `tsc && vite build` | 型別檢查 + 前端雙入口產物 `dist/` |
| `build:server` | esbuild bundle → `dist-server/index.mjs` | 伺服器產物（依賴外部化） |
| `preview` | `vite preview` | 預覽 production build |
| `start` | `node dist-server/index.mjs` | Cloud Run/Docker 的啟動命令 |
| `test` | `vitest run` | 17 檔 152 測試 |
| `typecheck` | `tsc && tsc -p server` | 雙 tsconfig 嚴格檢查 |

Makefile 將上述包裝為 `make dev / dev-server / build / test / typecheck / start-local / deploy / deploy-run / bump`（詳 09 章）。

---

## 6. 技術決策紀錄（ADR 摘要）

### 6.1 為何純 TS 規則引擎、與 DOM/3D 解耦

- **問題**：暗棋規則（翻/移/吃/剋制/炮翻山/25 步和局）一旦在 client 與 server 各寫一份，必然漂移；且規則若混入 Three.js/DOM，就無法在 Node 端權威執行與測試。
- **決策**：`src/game/` 只依賴 TS 型別與 Web Crypto（`crypto.getRandomValues`、`crypto.subtle`），零 DOM、零渲染；`GameController`（client 預檢 + 表現）與 `Room.handleAction`（server 權威）呼叫**同一個** `validateAction`/`applyAction`。
- **佐證**：`server/tsconfig.json` include `../src/game/**`；`src/tests/` 152 測試在無瀏覽器環境通過；`src/physics/animations.ts` 註解「the authoritative game state has already been updated before any animation is enqueued, so a broken animation can never corrupt the game」。
- **後果**：新增規則只需改一處，client 預檢訊息、server 權威判定、單元測試同步生效。

### 6.2 為何 Server-authoritative

- **問題**：暗棋是半盲棋——蓋牌身分是核心機密；任何「client 互相同步狀態」的架構都會把身分洩給作弊者。
- **決策**：所有下行狀態經 `server/redact.ts` 單點遮蔽；棋子 id 於伺服器端重編為不透明 `c00`–`c31`（`Room.newGame()`）；身分對照（`identityLayout`）+ nonce 的 SHA-256 承諾（`computeCommitmentHash`）只在終局以 `fairnessReveal()` 公布；客戶端動作一律是「意圖」（`{t:'action', seq, action}`），由伺服器驗證後以 `actionApplied`（含 `reveal`）回播；拒絕則 `{t:'invalid', seq, message}`。
- **佐證**：`src/shared/protocol.ts` 檔頭註解「The server never sends hidden piece identities…」；`server/tests/redact.test.ts`。
- **後果**：斷線重連、殘局接手、再賽都因「狀態在伺服器」而自然成立（`Room.fromDoc` 從 Firestore 重建）。

### 6.3 為何 Web Audio 合成音效而非音檔

- **現況**：`src/audio/sounds.ts`（116 行）用 OscillatorNode/GainNode/雜訊 Buffer 即時合成 `flip/place/move/capture/win/invalid/opponent-joined` 七種音效；`haptics.ts` 補震動。
- **理由**：
  1. **零資產**：GitHub Pages 單機版與 Cloud Run 共用同一前端，無音檔可 404、無載入延遲、bundle 幾乎不增加體積；
  2. **延遲**：棋類音效需要與動畫幀同步（`place` 落子在 snap 的瞬間），預載 AudioBuffer 也有解碼延遲，合成是 `ctx.currentTime` 即時排程；
  3. **autoplay 政策**：`ensureContext()` 在首次使用者手勢後才建立/resume AudioContext，天然符合規範；
  4. 可及性：`prefers-reduced-motion` 不影響音效，音效與震動可獨立開關（`sounds.enabled` ↔ `settings.soundEnabled` 持久化）。
- **取捨**：音色是「木質感」近似而非錄音品質——對暗棋的敲擊/翻牌聲而言可接受。

### 6.4 為何手寫 JWT 驗證而非引 jose 等函式庫

見 §4.4。核心論點：需求面只有一種 token 一種演算法、runtime 依賴刻意維持三件套、驗證邏輯可全測（`auth.test.ts` 11 案例）、且 `ADMIN_SESSION_SECRET` 未設定時「重啟即登出」的行為是可接受的明示取捨。相對地，**玩家端不需要任何認證依賴**——座位憑證是 `randomBytes(16)` 的 `playerToken`（`server/ids.ts`），由 localStorage 持有，房間 id 本身即不可猜測（10 碼 base32 ≈ 50 bit），「邀請連結即憑證」是刻意的產品決策（`ids.ts` 註解：「the invite URL is the only credential」）。

### 6.5 其他值得記錄的選擇

| 決策 | 理由 |
| --- | --- |
| `structuredClone` 做狀態克隆（`cloneState`） | 規則引擎回傳新狀態、不變異舊狀態；undo/存檔/前後狀態對照（動畫用 `previous`）都因此安全 |
| 聊天/暱稱用 `Intl.Collator('zh-Hant-TW-u-co-stroke')` 筆畫排序 | 人員名單排序符合台灣使用者直覺（`src/ui/chat.ts`） |
| 動態 import qrcode、動態 import rapier | 首屏只載遊戲必要程式；WASM 與 QR 各自延後載入（loading 進度條分階段） |
| 伺服器單實例（`--max-instances 1` + `--session-affinity`） | 房間狀態以記憶體為權威（`rooms.ts` 註解「記憶體中的房間狀態才是權威：store 可能還停留在異步寫入前的舊狀態」），單實例避免多實例分裂；Firestore write-through 負責跨重啟存活 |
| `ws` 心跳 + 客戶端自動重連 + 伺服器 grace/takeover | 三層合起來把「Cloud Run 會砍閒置/逾時連線」從故障變成正常流程 |

---

## 7. 依賴風險與觀察

| 項目 | 觀察 |
| --- | --- |
| TypeScript 7.x | 主版本前進中，`tsc` 產出僅供檢查（`noEmit`），建置不受編譯器行為變動影響 |
| three@0.185 / rapier@0.20 | 均鎖 caret 範圍；Rapier 以 WASM 動態載入，升級時只需驗 `PhysicsWorld.create()` 與 collider 行為 |
| chart.js 列於 dependencies | 實際僅由 Vite 打包進 admin bundle；runtime image 會多裝一份（可移往 devDependencies，屬清理項非缺陷） |
| Firestore `listActive` limit 200 | 戰情中心最多列 20/50 房；超過 200 進行中房間時可能漏列——目前單實例規模下不構成問題 |
| 手寫 JWT 驗證 | 未來若加入更多 IdP/演算法，應改用 `jose`；現況單一 Google RS256 需求下維持輕依賴 |

→ 部署目標（Cloud Run / GitHub Pages）、環境變數與版號流程見 [04-platform.md](./04-platform.md) 與 [09-testing-deployment.md](./09-testing-deployment.md)；伺服器細節見 [06-backend.md](./06-backend.md)。