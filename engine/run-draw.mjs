#!/usr/bin/env node
/**
 * GitHub Actions 抽籤執行腳本
 * SPEC.md §4.2、§11.1
 *
 * 三個子指令對應工作流程的三個階段，中間各夾一次 git commit + push：
 *
 *   authorize   比對授權清單與個資樣式；不通過即寫入公開的 DENIED 紀錄並失敗
 *   commit      建立承諾酬載 → data/pending/{batchId}.json     ← 推送後標的即固定
 *   reveal      等待目標輪次 → 推導結果 → 寫入 history 與 state
 *
 * 為什麼一定要分成兩次推送：
 *   承諾必須在目標輪次的亂數產生**之前**進入 git 歷史。若兩階段合併成
 *   一次推送，就無法證明「標的是在亂數出現前就固定的」，承諾階段失去意義。
 *   因此承諾推送失敗時**絕不可略過而直接開籤**。
 *
 * 全部輸出寫入 GITHUB_STEP_SUMMARY，使每次執行的過程公開可查。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadConfig, loadState, loadHistory, loadOperators, saveState, appendHistory,
  verifyIntegrity, checkPrivacy, checkOperator, paths, DATA_DIR,
} from './state.mjs';
import { latestRound, targetRoundFor, fetchRound, waitForRound } from './drand.mjs';
import { buildCommitPayload, commitPayloadHash, executeReveal } from './commit.mjs';
import { buildDrawRecord, buildAuditRecord, sealRecord, makeBatchId } from './records.mjs';
import { buildMessage, sendLine, lineCredentialsFromEnv } from './notify.mjs';
import { LotteryError } from './errors.mjs';

const PENDING_DIR = join(DATA_DIR, 'pending');
const cmd = process.argv[2];

/* ── 輸出 ────────────────────────────────────────────────── */

function say(line = '') {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n', 'utf8');
  }
}

function die(msg, code = 1) {
  say('');
  say('### ✗ 中止');
  say('');
  say('```');
  say(msg);
  say('```');
  process.exit(code);
}

/* ── 輸入 ────────────────────────────────────────────────── */

const IN = {
  actor: process.env.ACTOR ?? '',
  caseTypeId: (process.env.CASE_TYPE ?? '').trim(),
  caseNos: (process.env.CASE_NOS ?? '')
    .split('\n').map((s) => s.trim()).filter(Boolean),
  offsetCount: Number(process.env.OFFSET_COUNT ?? '1'),
  offsetMapRaw: (process.env.OFFSET_MAP ?? '').trim(),
  excluded: (process.env.EXCLUDED ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  excludeReason: (process.env.EXCLUDE_REASON ?? '').trim(),
  note: (process.env.NOTE ?? '').trim(),
  batchId: (process.env.BATCH_ID ?? '').trim(),
  runUrl: process.env.RUN_URL ?? null,
};

function nowIso() {
  // 以 +08:00 記錄，與公文書時間一致
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('Z', '+08:00');
}

function binsFromState(state) {
  const out = {};
  for (const k of Object.keys(state.bins)) {
    out[k] = {
      tickets: state.bins[k].tickets.slice(),
      cycle: state.bins[k].cycle,
      carryOverSkips: { ...state.bins[k].carryOverSkips },
    };
  }
  return out;
}

function writeAudit(type, payload) {
  const history = loadHistory();
  const state = loadState();
  const prev = history.length ? history[history.length - 1].recordHash : null;
  const seq = state.seq + 1;
  const rec = sealRecord(
    buildAuditRecord({
      seq, type, at: nowIso(), operator: `github:${IN.actor}`,
      workflowRunUrl: IN.runUrl, payload,
    }),
    prev
  );
  appendHistory(rec);
  state.seq = seq;
  state.updatedAt = nowIso();
  saveState(state);
  return rec;
}

/* ════════════════════════════════════════════════════════════
   authorize
   ════════════════════════════════════════════════════════════ */

function doAuthorize() {
  const config = loadConfig();
  const operators = loadOperators();
  const required = process.env.REQUIRED_ROLE ?? 'DRAW_OPERATOR';

  say('## 授權檢查');
  say('');

  const auth = checkOperator(operators, IN.actor, required);
  if (!auth.allowed) {
    // 未授權的嘗試也必須留下公開紀錄
    try {
      writeAudit('DENIED', {
        attemptedBy: IN.actor,
        requiredRole: required,
        reason: auth.reason,
        requestedCaseType: IN.caseTypeId,
        requestedCaseCount: IN.caseNos.length,
      });
      say(`已寫入 DENIED 紀錄。`);
    } catch (e) {
      say(`（DENIED 紀錄寫入失敗：${e.message}）`);
    }
    die(`拒絕執行：${auth.reason}`);
  }
  say(`- 執行者：\`${IN.actor}\`（${auth.operator.displayName}，${auth.operator.role}）`);

  // 個資樣式檢查（SPEC §8.4）
  for (const c of IN.caseNos) {
    try {
      checkPrivacy(config, c);
    } catch (e) {
      die(e.message);
    }
  }
  checkPrivacy(config, IN.note);
  say(`- 個資樣式檢查：通過（${IN.caseNos.length} 個案號）`);

  // 資料完整性
  const v = verifyIntegrity();
  if (!v.ok) die('資料完整性驗證失敗，抽籤中止：\n  ' + v.problems.join('\n  '));
  say(`- 資料完整性：通過（歷史 ${v.recordCount} 筆，雜湊鏈連續）`);

  // 案號重複檢查
  const history = loadHistory();
  const used = new Set(
    history.filter((r) => r.caseNo && !r.voided).map((r) => `${r.caseTypeId}|${r.caseNo}`)
  );
  const dup = IN.caseNos.filter((c) => used.has(`${IN.caseTypeId}|${c}`));
  if (dup.length) die(`下列案號已抽過籤：${dup.join('、')}\n若確為更正，請改用作廢流程。`);
  say(`- 案號重複檢查：通過`);
  say('');
}

/* ════════════════════════════════════════════════════════════
   commit（承諾階段）
   ════════════════════════════════════════════════════════════ */

async function doCommit() {
  const config = loadConfig();
  const state = loadState();
  const bins = binsFromState(state);

  if (IN.caseNos.length === 0) die('未輸入任何案號');
  if (!config.caseTypes.some((c) => c.id === IN.caseTypeId && c.active)) {
    die(`案類不存在或未啟用：${IN.caseTypeId}`);
  }

  let offsetMap = null;
  if (IN.offsetMapRaw) {
    try {
      offsetMap = JSON.parse(IN.offsetMapRaw);
    } catch {
      die(`抵分範圍不是合法的 JSON：${IN.offsetMapRaw}`);
    }
  }

  say('## 承諾階段');
  say('');

  const current = await latestRound(config);
  const targetRound = targetRoundFor(config, current);
  say(`- 目前 drand 輪次：**${current}**`);
  say(`- 目標輪次：**${targetRound}**（約 ${(targetRound - current) * config.drand.periodSeconds} 秒後產生）`);
  say('');
  say('> 目標輪次的亂數此刻**尚未產生**，任何人都無法預知結果。');
  say('> 本次承諾推送後，抽籤標的與亂數來源即同時固定。');
  say('');

  const batchId = makeBatchId(state.seq + 1);
  const payload = buildCommitPayload({
    config, bins,
    caseTypeId: IN.caseTypeId,
    items: IN.caseNos.map((caseNo) => ({
      caseNo,
      offsetCount: IN.offsetCount,
      offsetMap,
      excludedUnitIds: IN.excluded,
      excludeReason: IN.excludeReason,
      note: IN.note,
    })),
    operator: `github:${IN.actor}`,
    targetRound,
    batchId,
    at: nowIso(),
  });

  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(join(PENDING_DIR, `${batchId}.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');

  say(`- 批次編號：\`${batchId}\``);
  say(`- 案件數：${payload.items.length}`);
  say(`- 承諾雜湊：\`${commitPayloadHash(payload)}\``);
  say('');

  // 交給工作流程後續步驟使用
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `batch_id=${batchId}\ntarget_round=${targetRound}\n`, 'utf8');
  }
  console.log(`::notice::承諾完成，批次 ${batchId}，目標輪次 ${targetRound}`);
}

/* ════════════════════════════════════════════════════════════
   reveal（開籤階段）
   ════════════════════════════════════════════════════════════ */

async function doReveal() {
  const config = loadConfig();
  const batchId = IN.batchId;
  const pendingFile = join(PENDING_DIR, `${batchId}.json`);

  if (!existsSync(pendingFile)) die(`找不到承諾檔案：${pendingFile}`);
  const payload = JSON.parse(readFileSync(pendingFile, 'utf8'));

  say('## 開籤階段');
  say('');
  say(`- 批次編號：\`${batchId}\``);
  say(`- 承諾的目標輪次：**${payload.drand.targetRound}**`);

  const drandResult = await waitForRound(config, payload.drand.targetRound, {
    maxWaitMs: 180000,
    onWait: (n) => console.log(`  等待第 ${payload.drand.targetRound} 輪產生…（第 ${n + 1} 次）`),
  });

  say(`- 取得亂數：\`${drandResult.randomness}\``);
  say(`- 一致的端點：${drandResult.agreeingEndpoints.length} 個（${drandResult.agreeingEndpoints.join('、')}）`);
  if (drandResult.unavailableEndpoints?.length) {
    say(`- 無回應的端點：${drandResult.unavailableEndpoints.length} 個`);
  }
  say('');

  const state = loadState();
  const bins = binsFromState(state);
  const out = executeReveal({ config, bins, payload, drandResult });

  // 寫入歷史
  const history = loadHistory();
  let prev = history.length ? history[history.length - 1].recordHash : null;
  let seq = state.seq;

  say('### 抽籤結果');
  say('');
  say('| 案號 | 承辦股 | 庭別 | 抵分 |');
  say('|---|---|---|---|');

  for (let i = 0; i < out.results.length; i++) {
    const r = out.results[i];
    seq += 1;
    const rec = sealRecord(
      buildDrawRecord({
        seq,
        at: nowIso(),
        operator: `github:${IN.actor}`,
        workflowRunUrl: IN.runUrl,
        batchId,
        caseNo: r.caseNo,
        note: r.note ?? '',
        caseTypeName: config.caseTypes.find((c) => c.id === r.caseTypeId).name,
        result: r,
        drand: out.drand,
        commitPayloadHash: out.payloadHash,
      }),
      prev
    );
    appendHistory(rec);
    prev = rec.recordHash;
    say(`| ${r.caseNo} | **${r.resultUnitName}** | ${r.resultCourtName} | ${r.offsetCount > 1 ? r.offsetCount + ' 件' : '—'} |`);
  }

  // 更新狀態
  state.seq = seq;
  state.updatedAt = nowIso();
  for (const binId of Object.keys(bins)) {
    state.bins[binId] = {
      tickets: bins[binId].tickets,
      cycle: bins[binId].cycle,
      carryOverSkips: bins[binId].carryOverSkips,
      lastRecordId: state.bins[binId].lastRecordId,
    };
  }
  for (const r of out.results) {
    state.bins[r.caseTypeId].lastRecordId = `R-${String(seq).padStart(6, '0')}`;
  }
  saveState(state);

  rmSync(pendingFile);

  say('');
  say('### 籤筒現況');
  say('');
  for (const ct of config.caseTypes.filter((c) => c.active)) {
    const b = state.bins[ct.id];
    if (!b) continue;
    const owed = Object.entries(b.carryOverSkips)
      .map(([u, n]) => `${config.units.find((x) => x.id === u)?.name ?? u} 欠 ${n}`).join('、');
    say(`- **${ct.name}**：第 ${b.cycle} 輪，籤筒內 ${b.tickets.length} 支${owed ? `（${owed}）` : ''}`);
  }
  say('');
  say('> 完整結果與驗證方式請見公開看板。');

  // ── 通知（失敗不影響已完成的分案）────────────────────────
  const records = loadHistory().filter((r) => r.batchId === batchId && r.type === 'DRAW');
  const dashboardUrl = config.github?.owner
    ? `https://${config.github.owner.toLowerCase()}.github.io/${config.github.repo}/`
    : null;

  const text = buildMessage({
    config, records, dashboardUrl,
    includeCaseNo: config.notify?.line?.includeCaseNo !== false,
  });
  const r = await sendLine({ config, text, ...lineCredentialsFromEnv() });

  say('');
  say('### 通知');
  say('');
  if (r.skipped) {
    say(`- LINE 推播未執行：${r.problems.join('；')}`);
  } else {
    say(`- LINE 推播：成功 ${r.sent} 個群組${r.failed ? `，失敗 ${r.failed} 個` : ''}`);
    for (const p of r.problems) say(`  - ⚠ ${p}`);
    if (r.failed) {
      say('');
      say('> 推播失敗不影響抽籤結果——結果已寫入並推送完成，請至公開看板查閱。');
    }
  }
}

/* ── 進入點 ──────────────────────────────────────────────── */

try {
  if (cmd === 'authorize') doAuthorize();
  else if (cmd === 'commit') await doCommit();
  else if (cmd === 'reveal') await doReveal();
  else {
    console.error('用法：node engine/run-draw.mjs <authorize|commit|reveal>');
    process.exit(2);
  }
} catch (e) {
  if (e instanceof LotteryError) die(`[${e.code}] ${e.message}`);
  die(e.stack ?? String(e));
}
