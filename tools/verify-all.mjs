#!/usr/bin/env node
/**
 * 全量稽核
 * SPEC.md §4.0 第二層、§10.4、§11.2
 *
 *   node tools/verify-all.mjs
 *
 * 逐項檢查：
 *   1. 雜湊鏈連續、每筆內容未遭竄改
 *   2. state.json 與歷史最後一筆一致
 *   3. 每筆抽籤的 pickIndex 確實對應到紀錄的承辦股
 *   4. 每筆的 drand randomness 等於 SHA256(signature)
 *   5. 每筆的 drand 簽章通過鏈公鑰的 BLS 驗證（第二層）
 *   6. 承諾檔案沒有殘留（有殘留代表某批抽籤中斷未完成）
 *
 * 任何一項失敗即以非零狀態結束，供每日自動稽核工作流程據以告警。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { loadConfig, loadState, loadHistory, DATA_DIR } from '../engine/state.mjs';
import { verifyChain } from '../engine/records.mjs';
import { verifyRecordDrand, blsAvailable } from '../engine/bls.mjs';
import { hashObject } from '../engine/hash.mjs';

const problems = [];
const notes = [];
let checked = 0;

function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { problems.push(msg); console.log(`  ✗ ${msg}`); }
function skip(msg) { notes.push(msg); console.log(`  — ${msg}`); }

console.log('\n案件分案抽籤系統　全量稽核\n');

const config = loadConfig();
const history = loadHistory();

/* 1. 雜湊鏈 */
console.log('雜湊鏈');
const chain = verifyChain(history);
if (chain.ok) ok(`${history.length} 筆紀錄連續無斷點`);
else bad(chain.reason);

/* 2. state 與歷史一致 */
console.log('\n狀態檔');
try {
  const state = loadState();
  ok('state.json 的雜湊相符');
  if (history.length > 0 && history[history.length - 1].seq !== state.seq) {
    bad(`state.json 序號 ${state.seq} 與歷史最後一筆 ${history[history.length - 1].seq} 不一致`);
  } else {
    ok('序號與歷史一致');
  }
} catch (e) {
  bad(e.message);
}

/* 3~5. 逐筆抽籤紀錄 */
console.log('\n抽籤紀錄');
const drawTypes = ['DRAW', 'REDRAW', 'OFFLINE_BACKFILL'];
const draws = history.filter((r) => drawTypes.includes(r.type));

// 第二層（BLS 驗簽）需要 @noble/curves。未安裝時降級為「未驗證」而非「失敗」——
// SPEC §4.0 明訂第二層不可用時不應影響作業，且第一層的多端點交叉比對
// 與 randomness = SHA256(signature) 檢查仍照常執行。
const hasBls = await blsAvailable();

let drandChecked = 0;
let drandMissing = 0;

for (const r of draws) {
  checked += 1;

  // 抽籤位置對應的股別
  const at = r.drawable?.[r.pickIndex];
  if (at !== r.resultUnitId) {
    bad(`${r.recordId}：可抽集合第 ${r.pickIndex + 1} 個位置為 ${at ?? '(超出範圍)'}，紀錄為 ${r.resultUnitId}`);
  }

  // 籤筒快照雜湊
  if (r.binBeforeHash !== hashObject({ tickets: r.binBefore })) {
    bad(`${r.recordId}：抽籤前籤筒快照的雜湊不符`);
  }
  if (r.binAfterHash !== hashObject({ tickets: r.binAfter })) {
    bad(`${r.recordId}：抽籤後籤筒快照的雜湊不符`);
  }

  if (!r.drand) {
    drandMissing += 1;
    continue;
  }

  // randomness == SHA256(signature)
  const expected = createHash('sha256').update(Buffer.from(r.drand.signature, 'hex')).digest('hex');
  if (expected !== r.drand.randomness) {
    bad(`${r.recordId}：drand randomness 與 SHA256(signature) 不符`);
    continue;
  }

  // 第二層 BLS 驗簽
  if (!hasBls) continue;
  const v = await verifyRecordDrand(config, r);
  if (v.ok) drandChecked += 1;
  else if (v.skipped) drandMissing += 1;
  else bad(`${r.recordId}：BLS 驗簽失敗 — ${v.reason}`);
}

ok(`已檢查 ${checked} 筆抽籤紀錄的抽籤位置與籤筒快照`);
if (!hasBls) {
  skip('未安裝 @noble/curves，本次略過 BLS 密碼學驗簽（第一層檢查已完成）。' +
       '執行 npm ci 後重跑即可完整驗證');
} else if (drandChecked > 0) {
  ok(`${drandChecked} 筆通過 BLS 密碼學驗簽`);
}
if (drandMissing > 0) {
  skip(`${drandMissing} 筆沒有 drand 資料（P2 上線前產生的紀錄，或離線備援補登），無法驗證其不可預知性`);
}

/* 6. 殘留的承諾檔 */
console.log('\n承諾檔案');
const pendingDir = join(DATA_DIR, 'pending');
const pending = existsSync(pendingDir)
  ? readdirSync(pendingDir).filter((f) => f.endsWith('.json'))
  : [];
if (pending.length === 0) ok('無殘留');
else bad(`有 ${pending.length} 個承諾未完成開籤：${pending.join('、')}（請以 resume 流程續行或由 ADMIN 公開說明放棄原因）`);

/* 結論 */
console.log('');
if (problems.length === 0) {
  console.log(`✓ 全量稽核通過（${history.length} 筆紀錄）`);
  if (notes.length) console.log(`  另有 ${notes.length} 項未能驗證，說明如上。`);
  console.log('');
  process.exit(0);
} else {
  console.log(`✗ 全量稽核失敗，共 ${problems.length} 項問題：`);
  for (const p of problems) console.log(`    - ${p}`);
  console.log('');
  process.exit(1);
}
