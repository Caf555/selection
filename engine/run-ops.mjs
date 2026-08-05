#!/usr/bin/env node
/**
 * 更正與作廢的 GitHub Actions 執行腳本
 * SPEC.md §7、§11.2
 *
 *   void          作廢整筆抽籤並完整回復籤筒（ADMIN）
 *   amend         更正不影響籤筒的欄位（案號、備註）
 *   offset-amend  更正抵分數，支援股不變，只調整籤筒與欠籤
 *
 * 這三者界線分明，不可混用（SPEC §7.1）：
 *   案號打錯          → amend
 *   抵分數填錯        → offset-amend（支援股是對的，不該連結果一起推翻）
 *   整筆不應存在      → void
 *
 * 原紀錄一律保留、絕不修改。修改原紀錄會破壞其雜湊，使雜湊鏈斷裂——
 * 那正是本系統用來偵測竄改的機制，不能自己去踩。
 */

import { appendFileSync } from 'node:fs';

import {
  loadConfig, loadState, loadHistory, loadOperators,
  saveState, appendHistory, verifyIntegrity, checkOperator, checkPrivacy,
} from './state.mjs';
import { buildAuditRecord, sealRecord } from './records.mjs';
import { buildAmend, applyOffsetAmend, applyVoid } from './operations.mjs';
import { terms } from './terms.mjs';
import { LotteryError } from './errors.mjs';

const cmd = process.argv[2];

function say(line = '') {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n', 'utf8');
  }
}

function die(msg) {
  say('');
  say('### ✗ 中止');
  say('');
  say('```');
  say(msg);
  say('```');
  process.exit(1);
}

const IN = {
  actor: process.env.ACTOR ?? '',
  recordId: (process.env.RECORD_ID ?? '').trim(),
  reason: (process.env.REASON ?? '').trim(),
  newCaseNo: (process.env.NEW_CASE_NO ?? '').trim(),
  newNote: process.env.NEW_NOTE ?? '',
  newOffsetCount: process.env.NEW_OFFSET_COUNT ? Number(process.env.NEW_OFFSET_COUNT) : null,
  runUrl: process.env.RUN_URL ?? null,
};

function nowIso() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
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

function writeBinsToState(state, bins) {
  for (const binId of Object.keys(bins)) {
    state.bins[binId] = {
      ...state.bins[binId],
      tickets: bins[binId].tickets,
      cycle: bins[binId].cycle,
      carryOverSkips: bins[binId].carryOverSkips,
    };
  }
}

function preflight(requiredRole) {
  const config = loadConfig();
  const operators = loadOperators();

  say('## 授權檢查');
  say('');
  const auth = checkOperator(operators, IN.actor, requiredRole);
  if (!auth.allowed) die(`拒絕執行：${auth.reason}（本作業需要 ${requiredRole}）`);
  say(`- 執行者：\`${IN.actor}\`（${auth.operator.displayName}，${auth.operator.role}）`);

  const v = verifyIntegrity();
  if (!v.ok) die('資料完整性驗證失敗，作業中止：\n  ' + v.problems.join('\n  '));
  say(`- 資料完整性：通過（歷史 ${v.recordCount} 筆）`);

  if (!IN.reason) die('必須填寫理由');
  checkPrivacy(config, IN.reason);
  say(`- 理由：${IN.reason}`);
  say('');

  const history = loadHistory();
  const target = history.find((r) => r.recordId === IN.recordId);
  if (!target) die(`找不到紀錄 ${IN.recordId}`);

  return { config, history, target, state: loadState() };
}

function commitRecord(state, type, payload) {
  const history = loadHistory();
  const prev = history.length ? history[history.length - 1].recordHash : null;
  const seq = state.seq + 1;
  const rec = sealRecord(
    buildAuditRecord({ seq, type, at: nowIso(), operator: `github:${IN.actor}`, workflowRunUrl: IN.runUrl, payload }),
    prev
  );
  appendHistory(rec);
  state.seq = seq;
  state.updatedAt = nowIso();
  saveState(state);
  return rec;
}

/* ── void ────────────────────────────────────────────────── */

function doVoid() {
  const { config, history, target, state } = preflight('ADMIN');

  say('## 作廢');
  say('');
  say(`- 目標紀錄：\`${target.recordId}\``);
  say(`- 案號：${target.caseNo}`);
  say(`- 原${terms(config).drawee}：**${target.resultUnitName}**（${target.resultCourtName}）`);
  say('');

  const bins = binsFromState(state);
  const before = Object.fromEntries(Object.keys(bins).map((k) => [k, bins[k].tickets.length]));

  const payload = applyVoid({ bins, history, targetRecord: target, reason: IN.reason });
  writeBinsToState(state, bins);
  const rec = commitRecord(state, 'VOID', payload);

  say('### 籤筒已回復');
  say('');
  say('| 籤筒 | 作廢前 | 作廢後 | 輪次 |');
  say('|---|---|---|---|');
  for (const binId of payload.restoredBins) {
    const ct = config.caseTypes.find((c) => c.id === binId);
    say(`| ${ct?.name ?? binId} | ${before[binId]} 支 | ${bins[binId].tickets.length} 支 | 第 ${bins[binId].cycle} 輪 |`);
  }
  say('');
  say(`作廢紀錄：\`${rec.recordId}\``);
  say('');
  say('> 原抽籤紀錄完整保留並標示為已作廢。籤筒的籤數、輪次與抵分欠籤');
  say('> 均已回復至該次抽籤之前的狀態，不影響後續分案的公平性。');
}

/* ── amend ───────────────────────────────────────────────── */

function doAmend() {
  const { config, target, state } = preflight('DRAW_OPERATOR');

  const changes = {};
  if (IN.newCaseNo) { checkPrivacy(config, IN.newCaseNo); changes.caseNo = IN.newCaseNo; }
  if (process.env.NEW_NOTE !== undefined && IN.newNote !== '') {
    checkPrivacy(config, IN.newNote);
    changes.note = IN.newNote;
  }
  if (Object.keys(changes).length === 0) die('未指定要更正的內容');

  const payload = buildAmend({ targetRecord: target, changes, reason: IN.reason });
  const rec = commitRecord(state, 'AMEND', payload);

  say('## 更正');
  say('');
  say('| 欄位 | 原值 | 更正為 |');
  say('|---|---|---|');
  for (const k of Object.keys(payload.changes)) {
    say(`| ${k} | ${payload.changes[k].from ?? '（空）'} | ${payload.changes[k].to} |`);
  }
  say('');
  say(`更正紀錄：\`${rec.recordId}\`　籤筒未受影響。`);
  say('');
  say('> 原紀錄完整保留。公開看板與歷史頁會同時顯示原紀錄與本次更正。');
}

/* ── offset-amend ────────────────────────────────────────── */

function doOffsetAmend() {
  const { config, target, state } = preflight('DRAW_OPERATOR');

  if (!Number.isInteger(IN.newOffsetCount)) die('必須指定更正後的抵分件數');

  const bins = binsFromState(state);
  const payload = applyOffsetAmend({
    config, bins, targetRecord: target,
    newOffsetCount: IN.newOffsetCount,
    reason: IN.reason,
  });
  writeBinsToState(state, bins);
  const rec = commitRecord(state, 'OFFSET_AMEND', payload);

  say('## 抵分更正');
  say('');
  say(`- 目標紀錄：\`${target.recordId}\`（${target.caseNo}）`);
  say(`- ${terms(config).drawee}：**${target.resultUnitName}**　← 不變`);
  say(`- 抵分件數：${payload.offsetCountFrom} → **${payload.offsetCountTo}**`);
  say('');
  for (const c of payload.changes) {
    const ct = config.caseTypes.find((x) => x.id === c.binId);
    if (c.delta > 0) {
      say(`- ${ct?.name ?? c.binId}：加扣 ${c.delta} 支（自籤筒扣 ${c.consumed}、記為欠籤 ${c.carriedOver}）`);
    } else {
      say(`- ${ct?.name ?? c.binId}：退還 ${-c.delta} 支（沖銷欠籤 ${c.cancelledCarryOver}、放回籤筒 ${c.ticketsReturned}）`);
    }
  }
  if (payload.refills.length) say(`- 因此觸發補籤 ${payload.refills.length} 次`);
  say('');
  say(`更正紀錄：\`${rec.recordId}\``);
}

/* ── 進入點 ──────────────────────────────────────────────── */

try {
  if (cmd === 'void') doVoid();
  else if (cmd === 'amend') doAmend();
  else if (cmd === 'offset-amend') doOffsetAmend();
  else {
    console.error('用法：node engine/run-ops.mjs <void|amend|offset-amend>');
    process.exit(2);
  }
} catch (e) {
  if (e instanceof LotteryError) die(`[${e.code}] ${e.message}`);
  die(e.stack ?? String(e));
}
