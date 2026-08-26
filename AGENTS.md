# 台灣暗棋 — Agent 指引

3D 網頁暗棋（Vite + Three.js + Rapier + 純 TS 規則引擎 `src/game/`），含線上對戰（`server/`：Node + WebSocket，部署於 Cloud Run + Firestore）。常用指令見 `Makefile`（`make help`）。

## 版號規則（每次更版必做）

- 版號唯一來源是 `package.json` 的 `version`；前端經 Vite `define`、伺服器經 esbuild `--define` 注入 `__APP_VERSION__`，顯示於首頁頁腳、對局畫面版權列與 `/api/health`。
- **每一次部署或發佈都必須遞增版號**：`make deploy-run`（Cloud Run）與 `make deploy`（GitHub Pages）已內建 `make bump`（patch +1 並自動 commit），走 Makefile 即不會漏。
- 繞過 Makefile 手動部署時，先 `make bump` 再部署；功能較大的版本改用 `npm version minor|major --no-git-tag-version` 後自行 commit。

## 架構鐵則

- 線上對戰為 server-authoritative：規則引擎 `src/game/` 是純函式、零 DOM 依賴，client 與 server 共用；WS 協定型別在 `src/shared/protocol.ts`。
- 蓋牌棋子的身分絕不可離開伺服器：任何下行狀態一律先經 `server/redact.ts`，棋子 id 為不透明代號（`c00`–`c31`）。新增任何下行訊息時，先確認不含蓋牌棋子的 color/type。
- 計時一律以 deadline 時間戳惰性判定（`evaluate()`），setTimeout 只是輔助——Cloud Run CPU throttling 下計時器不可靠。
- 驗證：`npm test`（規則引擎 `src/tests/`、伺服器 `server/tests/`）+ `npm run typecheck`（同時檢查 client 與 server 兩個 tsconfig）。
