# 案件分案抽籤系統

以電腦抽籤取代人工抽籤，處理金訴案與金重訴案的分案。

設計前提是「**任何人都不必信任本系統的任何一方**」：抽籤結果由公共亂數決定，
抽籤標的在亂數產生之前就已公開固定，歷史紀錄以雜湊鏈相連且只增不刪。
被質疑時機關無須自證清白——質疑者可以自己驗證。

完整規格見 [SPEC.md](SPEC.md)。

---

## 現況

| 階段 | 內容 | 狀態 |
|---|---|---|
| P1 | 資料模型、抽籤引擎、單元測試 | **已完成** |
| P3 | 公開看板、歷史查詢、驗證頁 | **已完成** |
| P2 | drand 公共亂數、兩階段承諾—開籤、GitHub Actions | **程式已完成**，待完成 repo 設定 |
| P4 | 抽籤台、列印紀錄表 | **已完成並實機驗證** |
| P5 | QR code、本機同步腳本 | **已完成** |
| P5b | LINE 群組推播 | 程式已完成，待你申請帳號並設定 Secret |
| P4b | 組織管理頁與設定變更流程 | **已完成** |
| P6 | 平行試辦、教育訓練、正式上線 | 未開始 |

**目前尚未可用於正式分案**：抽籤工作流程的程式已完成，但需先完成下列 repo 設定
（這些必須由帳號擁有者本人操作）。本機 CLI 刻意不提供正式抽籤指令，以免產生
繞過 Actions 流程的途徑。

### 上線前必須完成的 repo 設定

1. **保護 main 分支**
   Settings → Rules → Rulesets → New ruleset → New branch ruleset
   - Enforcement status：`Active`
   - Target branches：`Include default branch`
   - Bypass list：**留空**
   - Rules 只勾：☑ `Block force pushes`　☑ `Restrict deletions`
   - **不要勾** `Restrict updates` 與 `Require a pull request before merging`

   ⚠ `github-actions[bot]` / `GITHUB_TOKEN` **無法加入 bypass list**
   （官方文件列出的可 bypass 對象只有 repository admin、maintain/write 角色、
   team、GitHub App、Dependabot）。若啟用 `Restrict updates`，被擋住的會是
   抽籤工作流程本身，抽籤將直接失敗。

   ⚠ **在單人持有的個人帳號 repo 上，分支保護綁不住擁有者。**
   擁有者同時是 ruleset 的管理者，隨時可自行 bypass 或停用規則。
   詳見 SPEC §8.2 的限制說明。

2. **允許 Actions 推送**
   Settings → Actions → General → Workflow permissions → Read and write permissions。

3. **抽籤操作者的個人權杖**（每位操作者各自申請，不共用）
   Settings → Developer settings → Personal access tokens → Fine-grained tokens：
   - Repository access：僅此 repo
   - Permissions：**只勾 `Actions: Read and write`**
   - 有效期限建議 90 天

   關鍵在於**不給 `Contents: write`** —— 持有該權杖的人只能發動抽籤，
   在技術上無法修改任何一筆資料。撤銷某人只需在 `data/operators.json`
   填入 `validTo`，不必更換任何共用密碼，也不影響其他人。

4. **GitHub Pages**（公開看板）
   ⚠ 免費個人帳號的 Pages **只支援公開 repo**。目前 repo 為私有，
   看板無法對外發布，只能在本機以 `node tools/serve.mjs` 檢視。
   轉為公開前須先確認 SPEC §15 的 A-04（案號是否適合完整公開）。

---

## 快速開始

需要 Node.js 20 以上。本專案**不使用任何第三方套件**。

```bash
npm test
```

```bash
node engine/cli.mjs init
```

```bash
node engine/cli.mjs status
```

```bash
node engine/cli.mjs simulate --n 30 --seed demo
```

```bash
node engine/cli.mjs verify
```

### 檢視網頁

網頁必須以 `http://` 開啟才能讀取資料檔（`file://` 會被瀏覽器的同源政策擋下）。

```bash
node tools/serve.mjs
```

開啟 <http://localhost:8080/public/index.html>。

正式資料目前是空的，若要看有內容的版面，先產生示範資料：

```bash
node tools/seed-demo.mjs
```

再開啟 <http://localhost:8080/public/index.html?src=../demo/>。
示範資料寫在獨立的 `demo/` 目錄，不會碰到 `data/` 底下的正式資料，
且頁面上會有明顯的紅色警示標明是模擬內容。

---

## 抽籤規則摘要

- 金訴、金重訴**各有獨立籤筒**，互不影響。
- 初始每個籤筒放入 8 支籤（每股 1 支），自籤筒內**剩餘的籤**等機率抽出。
- 籤筒剩 1 支，或剩 2 支且同屬一庭時，**自動補入全部股的籤**。
- 重大案件可設定抵分。抵 M 件 = 本案算 1 件 + 另扣該股 M−1 支籤，
  **優先扣籤筒內現有的籤**，不足額記為欠籤，於下次補籤後優先扣除。
- 迴避股的籤留在籤筒內，僅本次不可被抽中。
- 股別變動立即生效；新股可設定每輪多支籤以追分。

### ⚠ 執行順序

**抵分扣減必須在補籤檢查之前完成。** 兩者對調在多數情況下結果相同，
但會在特定情況下使籤筒停在低於門檻的狀態而未補籤，極端時下一件案件的
承辦股會變成 100% 確定，且不會被任何驗證機制攔下。

詳見 [SPEC.md §3.6](SPEC.md) 的完整推演，以及
`engine/test/offset.test.mjs` 中標註 `SPEC-3.6` 的測試。**這些測試不得停用。**

---

## 目錄結構

```
data/          資料檔（唯一真實來源）
  config.json    組織與規則設定
  state.json     籤筒即時狀態
  history.jsonl  抽籤與稽核紀錄（只增不刪，雜湊鏈保護）
  operators.json 抽籤授權清單
engine/        抽籤引擎（純 Node.js，離線可執行）
  lottery.mjs    核心演算法 ← 修改前請先讀 SPEC §3.6
  random.mjs     拒絕採樣，避免模數偏差
  canonical.mjs  RFC 8785 正規化（瀏覽器與 Node 共用同一份）
  hash.mjs       SHA-256 / HMAC
  records.mjs    紀錄產生與雜湊鏈
  operations.mjs 更正、作廢、重抽
  state.mjs      資料檔讀寫與完整性驗證
  cli.mjs        本機命令列工具
  test/          單元測試（對應 SPEC §14）
public/        公開網頁（原生 HTML/CSS/JS，無建置流程）
  index.html     公開看板
  history.html   歷史查詢、受分統計、CSV 匯出
  verify.html    結果驗證
  draw.html      抽籤台（操作者專用，需個人權杖）
  admin.html     組織管理（庭、股、案類、授權清單、規則參數）
  print.html     抽籤紀錄表（A4 直式，供附卷）
  css/large-type.css  大字體與無障礙樣式
tools/
  serve.mjs      本機預覽伺服器
  seed-demo.mjs  產生示範資料至 demo/
```

### 驗證頁為什麼可信

`public/js/hashweb.mjs` 直接引用 `engine/canonical.mjs` —— 驗證頁與抽籤引擎
執行的是**同一份**正規化程式碼。若驗證頁自行重寫一份，驗證通過與否就不再具有意義。

瀏覽器端以 WebCrypto 計算 SHA-256，Node 端以 `node:crypto` 計算，兩者結果一致。

---

## 測試

```bash
npm test
```

只跑執行順序的關鍵測試：

```bash
npm run test:spec36
```

測試項目編號對應 SPEC §14。P1 涵蓋演算法、更正作廢、亂數分布與雜湊鏈；
drand 相關（#28、#29）與權限相關（#32～#34）屬 P2。

---

## 組織設定變更

**請勿直接編輯 `data/` 底下的檔案。** 那條路繞過授權檢查、繞過結構驗證，
也不會產生稽核紀錄——分支保護與稽核都會形同虛設。

改用「組織管理」頁（`public/admin.html`）或 Actions 的「組織設定變更」流程：

| 動作 | 對籤筒的影響 |
|---|---|
| 新增股 | **立即**投入其籤並執行補籤檢查 |
| 停用股 | **立即**撤出其全部籤並執行補籤檢查 |
| 修改每輪籤數 | 不動現有籤筒，自下次補籤起生效 |
| 復職 | 自下次補籤起參與，本輪不投籤（避免受分機率異常偏高） |
| 更名、改隸、庭別、案類、規則 | 視動作而定，皆有稽核紀錄 |

寫入前會執行結構驗證，**未通過時不寫入任何檔案**。驗證項目包括
ID 與 order 唯一、所屬庭存在、在職股至少 2 個且分屬 2 庭以上、
補籤門檻小於總籤數等——這些若出錯會使抽籤引擎當掉或無限補籤，
而問題通常要等到下次抽籤才會浮現。

---

## 本機歷史同步

把線上紀錄拉回本機備份，**先驗證雜湊鏈完整性，通過後才輸出**：

```bash
node tools/sync-local.mjs
```

Windows 使用者可改用 PowerShell 版（供「工作排程器」每日自動執行）：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sync-local.ps1
```

輸出至 `本機歷史/`：CSV（UTF-8 BOM，Excel 可直接開）、JSONL 原始備份、
可列印的 HTML。每次同步保留獨立檔案，形成多重備份。

⚠ 驗證不通過時**不輸出任何檔案**。若把可能遭竄改的資料也寫成備份，
日後將無從分辨哪一份可信。

---

## LINE 群組推播（尚未啟用）

程式已完成，但需要你先完成下列外部設定。**LINE Notify 已於 2025-03-31
終止服務**，本系統改用 LINE Messaging API。

### ⚠ Channel Secret 不是 Channel Access Token

這兩個是不同的東西，最容易搞混：

| | 用途 | 本系統需要嗎 |
|---|---|---|
| **Channel Secret** | 驗證 webhook 請求是否真的來自 LINE | 送訊息不需要；取 groupId 時可用來驗簽 |
| **Channel Access Token** | 呼叫 Messaging API 時的 `Authorization` | **需要，`LINE_CHANNEL_TOKEN` 填這個** |

### 兩種推播模式

`config.notify.line.mode` 決定訊息怎麼送：

| 模式 | 送給誰 | 需要 groupId？ | 需要 webhook？ |
|---|---|---|---|
| **`broadcast`（預設）** | 所有把官方帳號加為好友的人 | **不需要** | **不需要** |
| `push` | 指定的群組 | 需要 | 需要（取 ID 時） |

**建議先用 `broadcast`。** 取得群組 ID 必須架設 webhook 接收器並讓它可從網際網路
連入，對只有一位管理者的系統而言負擔偏高。改用 broadcast 後，同仁只要把官方帳號
加為好友就會收到通知，設定步驟少一大半。

### 設定步驟（broadcast 模式）

1. 申請 **LINE 官方帳號**（LINE Official Account Manager）
2. 至 **LINE Developers** 建立 Messaging API channel
3. 在該 channel 的 **Messaging API** 分頁最下方，
   **Channel access token** → **Issue**，簽發權杖
4. 於本 repo 設定 Actions Secret（Settings → Secrets and variables → Actions）：
   - `LINE_CHANNEL_TOKEN`：上一步簽發的權杖
5. 請需要收通知的同仁掃描官方帳號的 QR code 加為好友
6. 把 `notify.line.enabled` 改為 `true`
   （請走「組織設定變更」流程，不要直接編輯檔案）

### 設定步驟（push 模式，需要群組 ID）

除上述第 1～4 步外，另需：

- 把官方帳號加入目標群組
- 取得群組 ID（見下），填入 Actions Secret `LINE_GROUP_IDS`，多個以逗號分隔
- 把 `notify.line.mode` 改為 `push`

### 取得群組 ID

LINE 沒有提供「列出 bot 所在群組」的 API，群組 ID **只能從 webhook 事件取得**。
本專案提供一支本機接收器，資料不經任何第三方服務：

```bash
node tools/get-group-id.mjs
```

依畫面指示操作：用 `cloudflared tunnel --url http://localhost:3000` 或
`ngrok http 3000` 讓連接埠可從外部連入，把取得的網址加上 `/webhook` 填進
LINE Developers 的 Webhook URL 並開啟「Use webhook」，然後在群組裡隨便說一句話。

若先設定環境變數 `LINE_CHANNEL_SECRET`，接收器會驗證每個請求的簽章，
確認確實來自 LINE 而非他人偽造。

取得 ID 後，請把 Webhook URL 清空或關閉「Use webhook」——本系統只送訊息、
不接收訊息，不需要長期開著 webhook。

### 訊息形式

**一批抽籤合併為一則訊息**，不是一件一則。LINE 免費方案按訊息則數計費，
所以真正消耗額度的是群組數量，不是案件數量：

| 情境 | 消耗則數 |
|---|---|
| 一次抽 10 件，推到 1 個群組 | 1 則 |
| 一次抽 10 件，推到 3 個群組 | 3 則 |

訊息超過約 4,900 字元會截斷並附註請至看板查閱，避免超過 LINE 的長度上限
而導致整批推播失敗（約 120 件才會觸發）。

若不宜於通知中揭露案號，將 `notify.line.includeCaseNo` 設為 `false`，
系統只會推播「金訴 3 件」這類摘要與看板網址。

**推播失敗不會影響抽籤。** 結果在推播之前就已寫入並推送完成——若因為
LINE 額度用盡或網路不通就讓工作流程失敗，操作者會以為抽籤沒成功而重抽，
那會再消耗一支籤。

---

## 待確認事項

上線前需確認 [SPEC.md §15](SPEC.md) 的 A-01～A-10，其中影響最大的兩項：

- **A-04** 案號是否適合完整公開於網際網路，或應部分遮蔽
- **A-01** 4 庭 8 股的正式名稱（目前 `data/config.json` 為範例值）
