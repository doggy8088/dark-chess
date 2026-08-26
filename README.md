# 台灣暗棋 · Taiwan Dark Chess

高品質 3D 台灣暗棋網頁遊戲。Mobile First、雙人同機對戰，採用明確固定的 **Taiwan Dark Chess Rules v1**。

## 執行

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # Rule Engine 單元測試（Vitest）
npm run build    # 型別檢查 + Production build
npm run preview  # 預覽 production build
```

或使用 Makefile（`make help` 列出全部指令）：

```bash
make install     # npm ci
make dev         # 開發伺服器
make test        # 單元測試（make watch 為 watch 模式）
make build       # 型別檢查 + production build
make preview     # 本機預覽 production build
make deploy      # 測試 + build 後推上 main，並等待 GitHub Pages 部署完成
make status      # 查看最近的部署 workflow
make open        # 開啟正式站 https://dark-chess.gh.miniasp.com
```

## 技術架構

- **Vite + TypeScript（strict）**
- **Three.js**：場景、攝影機、棋盤與棋子渲染、Raycasting
- **Rapier 3D**（`@dimforge/rapier3d`）：翻棋、吃子的物理動畫
- **純 TypeScript Rule Engine**（`src/game/`）：不依賴 Three.js / Rapier / DOM，可獨立測試；物理只是表現層，絕不影響棋局狀態
- **Web Crypto**：`crypto.getRandomValues` 無偏 Fisher–Yates 洗牌 + SHA-256 開局承諾（commit-and-reveal 公平性驗證）
- **localStorage**：設定與棋局自動存檔，Refresh 後可「繼續上一局」

## 目錄結構

```
src/
  game/         # Rule Engine（types / rules / actions / shuffle / fairness）
  rendering/    # Three.js（scene / camera / board / piece-mesh / textures / raycaster）
  physics/      # Rapier world 包裝 + tween / AnimationQueue
  ui/           # HUD / dialogs / history / setup 畫面
  audio/        # Web Audio 合成音效 + 震動回饋
  persistence/  # localStorage 存檔
  tests/        # Vitest 單元測試（含完整炮規則與將/兵剋制案例）
  controller.ts # 規則 ↔ 3D ↔ 物理 ↔ 輸入 的橋接
  app.ts        # App 狀態機（LOADING → HOME → SETUP → PLAYING → GAME_OVER）
```
