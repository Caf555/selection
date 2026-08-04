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
| P5 | LINE 推播、QR code、本機同步腳本 | 未開始 |
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

## 待確認事項

上線前需確認 [SPEC.md §15](SPEC.md) 的 A-01～A-10，其中影響最大的兩項：

- **A-04** 案號是否適合完整公開於網際網路，或應部分遮蔽
- **A-01** 4 庭 8 股的正式名稱（目前 `data/config.json` 為範例值）
