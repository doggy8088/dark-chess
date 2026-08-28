# 01 · 專案總覽（Overview）

> 台灣暗棋（Banqi / Half-Blind Chess）3D 網頁遊戲 — 軟體開發規格書 總覽
> 文件版本：v1.0（對應產品版號 v1.1.33）· 最後更新：2026-08-29

---

## 1. 專案定位

**台灣暗棋（Taiwan Dark Chess）**是一款以傳統桌上棋戲「暗棋／半 blind 象棋」為基礎的 **3D 網頁遊戲**。

- **免安裝、跨裝置**：以現代瀏覽器為執行平臺，手機與桌機皆可遊玩（Mobile First + RWD）。
- **雙軌對戰模式**：雙人同機對戰（Hotseat）與線上對戰（Online，server-authoritative）。
- **高品質 3D 呈現**：Three.js 即時渲染 + Rapier 物理引擎驅動翻棋與吃子動畫。
- **公平性可驗證**：開局以 SHA-256 承諾雜湊（commit-and-reveal）證明洗牌未被動手腳。

## 2. 目標與非目標

### 2.1 目標
1. 提供規則正確、體驗流暢的台灣暗棋對戰（規則以 Taiwan Dark Chess Rules v1 為準）。
2. 線上對戰採 server-authoritative 架構，蓋牌資訊絕不離開伺服器，防作弊且可公平驗證。
3. 行動裝置與桌機皆有完整體驗（RWD、觸控、鍵鼠）。
4. 提供營運後台：全服公告、流量與資源監控、異常告警、IP 封鎖。
5. 全自動化部署：Cloud Run（線上對戰主站）與 GitHub Pages（單機版靜態站）雙軌。

### 2.2 非目標（本版不做）
- 多人（>2）房間與競賽積分制。
- 帳號系統（玩家以身分識別 token 與暱稱識別）。
- 行動 App（Native App）封裝。

## 3. 名詞定義

| 名詞 | 說明 |
| --- | --- |
| 蓋牌（Covered piece） | 未翻開的棋子，其身分（顏色/兵種）對所有人隱藏，翻開才揭曉 |
| 交戰中（Playing） | 房間狀態：兩位玩家都已入座且對局進行中 |
| 戰情中心 | 首頁的即時戰況面板：交戰中／等待加入／已結束房間列表與統計 |
| 殘局接手 | 玩家逾時或離線時，座位開放給觀戰者接手繼續對局 |
| 再來一局 | 對局結束後的再賽邀請，先後手自動交換 |
| 罐頭訊息 | 快速聊天預設語句（76 句，每 15 秒隨機子集輪播） |
| 趣味暱稱 | 加入時自動指派的 36 個台味暱稱（可自行修改） |
| 管理後台 | 營運管理介面（`/admin`）：公告、報表、監控、封鎖 |

## 4. 主要功能總覽

| 領域 | 功能 | 詳細規格 |
| --- | --- | --- |
| 遊戲規則 | 32 子台灣暗棋、翻牌/移動/吃子、無吃子 25 回合和局 | [08-game-rules.md](./08-game-rules.md) |
| 公平性 | 拒絕取樣洗牌 + SHA-256 commit-and-reveal | [08-game-rules.md](./08-game-rules.md) |
| 線上對戰 | 房間、邀請連結+QR、回合時鐘、斷線寬限、殘局接手、再來一局 | [06-backend.md](./06-backend.md) |
| 聊天與社交 | 聊天室（文字/罐頭/emoji）、人員名單、觀戰 | [05-frontend.md](./05-frontend.md) |
| 前台體驗 | 3D 場景、物理動畫、RWD、全螢幕、音效、歷史導覽 | [05-frontend.md](./05-frontend.md) |
| 後台管理 | Google 登入、全服公告（已讀追蹤）、流量報表、CPU/負載監控、IP 封鎖 | [07-admin.md](./07-admin.md) |
| 部署運維 | Cloud Run + GitHub Pages、Docker 多階段建置、版號自動遞增 | [09-testing-deployment.md](./09-testing-deployment.md) |
| 測試 | Vitest 17 檔 152 測試 + agent-browser 實機驗證 | [09-testing-deployment.md](./09-testing-deployment.md) |

## 5. 正式環境

| 環境 | 網址 | 用途 |
| --- | --- | --- |
| Cloud Run（主站） | https://dark-chess.game.miniasp.com | 線上對戰完整功能（含後台 `/admin`） |
| Cloud Run（原始網址） | https://dark-chess-327655012190.asia-east1.run.app | 同上（GCP 直連） |
| GitHub Pages | https://dark-chess.gh.miniasp.com | 單機版靜態站（無伺服器功能） |

健康檢查：`GET /api/health` 回傳 `{"ok":true,"version":"<版號>"}`，部署後以此驗證新版生效。

## 6. 開發脈絡與關鍵決策

以下決策取自專案的開發紀錄（AGENTS.md、Git 歷史與 Copilot CLI session log）：

| 時間 | 決策 / 事件 | 影響 |
| --- | --- | --- |
| 早期 | 規則引擎與表現層分離；物理只是表現層，絕不影響棋局狀態 | `src/game/` 純函式、可獨立測試 |
| 2026-08-27 | 整理「線上對戰、聊天室、人員」功能提示詞，規劃移植到其他遊戲 | 線上功能的模組化設計（`src/online/`、`src/shared/protocol.ts`） |
| 2026-08-27 | 綁定自訂網域 `dark-chess.game.miniasp.com` 至 Cloud Run | 正式機網址定案，DNS CNAME → ghs.googlehosted.com |
| 2026-08-27 | 以 imagegen-aoai 生成首頁背景（`/img/home-bg.webp`） | AI 生成素材進入產品 |
| 2026-08-27 | 正式環境網址寫入 AGENTS.md；`make deploy-run` 完成後自動顯示正式機網址；版號顯示於首頁 Copyright 下方 | 部署驗證流程標準化 |
| 2026-08-28 | SEO/OpenGraph 中繼資料 + og:image（1200×630） | 分享預覽優化 |
| 2026-08-28 | 戰情中心穩定化：以建立時間排序、終局保留 5 分鐘 | 解決面板跳動問題 |
| 2026-08-28 | 罐頭訊息擴充至 76 句、每 15 秒隨機子集輪播 | 社交趣味 |
| 2026-08-28 | 桌面版強化：聊天室可縮放、對局紀錄可收合、全螢幕按鈕 | 桌機體驗 |
| 2026-08-28 | 殘局接手機制：逾時/離線座位開放觀戰者接手 | 對局不再因棄賽強制結束 |
| 2026-08-28 | 管理後台上線（Google 登入、公告已讀、流量報表、IP 封鎖、CPU 監控） | 營運能力 |
| 2026-08-29 | 等待房間 30 秒曝光於戰情中心；對手加入提示音；加入/觀戰 3 秒倒數自動進場；SPA 歷史導覽 | 快速配對與導覽體驗 |

## 7. 文件地圖

| 章節 | 檔案 | 內容 |
| --- | --- | --- |
| 01 | 本文件 | 總覽、目標、名詞、脈絡 |
| 02 | [02-architecture.md](./02-architecture.md) | 系統架構設計 |
| 03 | [03-tech-stack.md](./03-tech-stack.md) | 技術採用 |
| 04 | [04-platform.md](./04-platform.md) | 平臺選擇 |
| 05 | [05-frontend.md](./05-frontend.md) | 前台規劃 |
| 06 | [06-backend.md](./06-backend.md) | 伺服器與線上對戰 |
| 07 | [07-admin.md](./07-admin.md) | 管理後台 |
| 08 | [08-game-rules.md](./08-game-rules.md) | 遊戲規則與公平性 |
| 09 | [09-testing-deployment.md](./09-testing-deployment.md) | 測試、部署與運維 |

## 8. 閱讀對象

- **產品／企劃**：第 1、5 章（功能總覽與前台規劃）
- **前端工程**：第 2、3、5 章
- **後端工程**：第 2、3、6、7 章
- **測試／運維**：第 4、9 章
- **新進成員**：依序閱讀全部章節