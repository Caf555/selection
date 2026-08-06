#!/usr/bin/env node
/**
 * 迴避重抽的 GitHub Actions 執行腳本
 * SPEC.md §7.5、§4.2
 *
 * 適用於「抽出後才發現支援股應迴避」。與作廢不同：作廢是這件案子不該
 * 被抽，重抽是這件案子仍要分案，只是不能分給該股。
 *
 * ── 為什麼重抽也要走兩階段承諾—開籤 ─────────────────────────
 *
 * 重抽是一次全新的抽籤，同樣必須證明結果無人能預知。若省略承諾階段，
 * 就會出現「不滿意結果 → 宣稱要迴避 → 重抽」的操作空間，而迴避事由
 * 是人填的，無法從外部查核。承諾階段讓重抽的標的與亂數輪次同樣在
 * 結果出現前就固定，把這條路堵死。
 *
 * ── 兩階段各做什麼 ───────────────────────────────────────────
 *
 * commit  在記憶體中把籤筒回復到原次抽籤前，依設定決定原籤是否放回，
 *         將「回復後的籤筒」與目標輪次寫入 pending 並推送。
 *         **此階段不改動 state.json** —— 若流程在此中斷，籤筒維持
 *         原次抽籤後的狀態，不會留下無對應紀錄的半套回復。
 *
 * reveal  先確認 state.json 自承諾以來未被更動，才套用回復並抽籤。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadConfig, loadState, loadHistory, loadOperators,
  saveState, appendHistory, verifyIntegrity, checkOperator, checkPrivacy, DATA_DIR,
} from './state.mjs';
import { latestRound, targetRoundFor, waitForRound } from './drand.mjs';
import { buildCommitPayload, commitPayloadHash, executeReveal, binsHash } from './commit.mjs';
import { buildDrawRecord, sealRecord, makeBatchId } from './records.mjs';
import { voidMode, applyRedrawCompensation } from './operations.mjs';
import { refillLoop } from './lottery.mjs';
import { terms } from './terms.mjs';
import { LotteryError } from './errors.mjs';

const PENDING_DIR = join(DATA_DIR, 'pending');
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
  batchId: (process.env.BATCH_ID ?? '').trim(),
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

/* ── commit ──────────────────────────────────────────────── */

async function doCommit() {
  const config = loadConfig();
  const operators = loadOperators();
  const history = loadHistory();
  const state = loadState();

  say('## 授權與前置檢查');
  say('');

  const auth = checkOperator(operators, IN.actor, 'DRAW_OPERATOR');
  if (!auth.allowed) die(`拒絕執行：${auth.reason}`);
  say(`- 執行者：\`${IN.actor}\`（${auth.operator.displayName}，${auth.operator.role}）`);

  const v = verifyIntegrity();
  if (!v.ok) die('資料完整性驗證失敗，重抽中止：\n  ' + v.problems.join('\n  '));
  say(`- 資料完整性：通過（歷史 ${v.recordCount} 筆）`);

  if (!IN.reason) die('必須填寫迴避事由');
  checkPrivacy(config, IN.reason);

  const original = history.find((r) => r.recordId === IN.recordId);
  if (!original) die(`找不到紀錄 ${IN.recordId}`);
  if (!['DRAW', 'REDRAW'].includes(original.type)) die(`${IN.recordId} 不是抽籤紀錄（type=${original.type}）`);
  if (history.some((r) => r.type === 'VOID' && r.targetRecordId === original.recordId)) {
    die(`${IN.recordId} 已作廢，不能重抽`);
  }
  if (history.some((r) => r.type === 'REDRAW' && r.originalRecordId === original.recordId)) {
    die(`${IN.recordId} 已經重抽過了`);
  }

  // 判斷可否回溯。中間某筆的重抽改採補償式，不回溯籤筒（SPEC §7.4）。
  const redrawMode = voidMode(binsFromState(state), original);

  say(`- 原抽籤：\`${original.recordId}\`　${original.caseNo}　→　**${original.resultUnitName}**`);
  say(`- 迴避事由：${IN.reason}`);
  say('');

  // ── 在記憶體中算出重抽的起始籤筒，不寫入 state.json ──────
  const bins = binsFromState(state);
  const currentHash = binsHash(bins, Object.keys(original.binsBefore));
  const returnsTicket = config.rules.redrawReturnsTicket !== false;
  const preRefills = [];

  if (redrawMode === 'rewind') {
    for (const binId of Object.keys(original.binsBefore)) {
      const snap = original.binsBefore[binId];
      bins[binId] = {
        tickets: snap.tickets.slice(),
        cycle: snap.cycle,
        carryOverSkips: { ...snap.carryOverSkips },
      };
    }
    if (!returnsTicket) {
      const bin = bins[original.caseTypeId];
      const idx = bin.tickets.indexOf(original.resultUnitId);
      if (idx !== -1) bin.tickets.splice(idx, 1);
      preRefills.push(...refillLoop(bin, config, original.caseTypeId, 'redraw-no-return'));
    }
  } else {
    // 其後已有仍生效的抽籤，無法回溯——回溯會使那些抽籤當初面對的籤筒
    // 不復存在，其結果將失去依據。改採補償（SPEC §7.4）。
    applyRedrawCompensation({ config, bins, record: original, returnDrawnTicket: returnsTicket });
  }

  say(`- 籤筒處理方式：**${redrawMode === 'rewind' ? '回溯回復' : '補償退還'}**`);
  say(redrawMode === 'rewind'
    ? '  > 本筆是該籤筒最近一筆，可完整回溯至原次抽籤之前。'
    : '  > 本筆之後已有其他仍生效的抽籤，改以補償方式沖銷原次效果，後續抽籤不受影響。');
  say(`- 原籤是否放回：**${returnsTicket ? '放回' : '不放回'}**`
    + `（config.rules.redrawReturnsTicket）`);
  say(returnsTicket
    ? '  > 迴避者並未實際受分案，故回復其受分機會。'
    : '  > 該股本輪視為已輪畢。');
  say('');

  const excluded = [...new Set([...(original.excludedUnitIds ?? []), original.resultUnitId])];

  const current = await latestRound(config);
  const targetRound = targetRoundFor(config, current);
  say('## 承諾階段');
  say('');
  say(`- 目前 drand 輪次：**${current}**`);
  say(`- 目標輪次：**${targetRound}**（此刻尚未產生，無人能預知重抽結果）`);

  const batchId = makeBatchId(state.seq + 1);
  const payload = buildCommitPayload({
    config, bins,
    caseTypeId: original.caseTypeId,
    items: [{
      caseNo: original.caseNo,
      offsetCount: original.offsetCount,
      offsetMap: original.offsetMap,
      excludedUnitIds: excluded,
      excludeReason: IN.reason,
      note: '因支援股迴避而重新抽籤',
    }],
    operator: `github:${IN.actor}`,
    targetRound, batchId, at: nowIso(),
    extra: {
      redraw: {
        originalRecordId: original.recordId,
        recusedUnitId: original.resultUnitId,
        recuseReason: IN.reason,
        ticketReturned: returnsTicket,
        preRefills,
        // 開籤前用它確認 state.json 自承諾以來未被更動
        expectedCurrentBinsHash: currentHash,
      },
    },
  });

  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(join(PENDING_DIR, `${batchId}.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');

  say(`- 批次編號：\`${batchId}\``);
  say(`- 承諾雜湊：\`${commitPayloadHash(payload)}\``);
  say(`- 排除的股：${excluded.join('、')}`);
  say('');

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `batch_id=${batchId}\ntarget_round=${targetRound}\n`, 'utf8');
  }
}

/* ── reveal ──────────────────────────────────────────────── */

async function doReveal() {
  const config = loadConfig();
  const pendingFile = join(PENDING_DIR, `${IN.batchId}.json`);
  if (!existsSync(pendingFile)) die(`找不到承諾檔案：${pendingFile}`);

  const payload = JSON.parse(readFileSync(pendingFile, 'utf8'));
  const rd = payload.redraw;
  if (!rd) die('承諾檔案不是重抽用的');

  say('## 開籤階段');
  say('');
  say(`- 承諾的目標輪次：**${payload.drand.targetRound}**`);

  const state = loadState();
  const bins = binsFromState(state);

  // 確認狀態自承諾以來未被更動
  const nowHash = binsHash(bins, Object.keys(payload.binsBefore));
  if (nowHash !== rd.expectedCurrentBinsHash) {
    die(
      '籤筒在承諾之後遭到變動，重抽中止。\n' +
      '  承諾當下的籤筒雜湊：' + rd.expectedCurrentBinsHash + '\n' +
      '  目前的籤筒雜湊：　　' + nowHash + '\n' +
      '  請確認期間是否有其他抽籤或作廢作業，並重新發動重抽。'
    );
  }

  // 套用回復（承諾階段已算好，此處只是照抄，不重新計算）
  for (const binId of Object.keys(payload.binsBefore)) {
    const snap = payload.binsBefore[binId];
    bins[binId] = {
      tickets: snap.tickets.slice(),
      cycle: snap.cycle,
      carryOverSkips: { ...snap.carryOverSkips },
    };
  }
  say(`- 籤筒已回復至 \`${rd.originalRecordId}\` 抽籤之前`);

  const drandResult = await waitForRound(config, payload.drand.targetRound, {
    maxWaitMs: 180000,
    onWait: (n) => console.log(`  等待第 ${payload.drand.targetRound} 輪產生…（第 ${n + 1} 次）`),
  });
  say(`- 取得亂數：\`${drandResult.randomness}\``);
  say(`- 一致的端點：${drandResult.agreeingEndpoints.length} 個`);
  say('');

  const out = executeReveal({ config, bins, payload, drandResult });
  const r = out.results[0];

  const history = loadHistory();
  const prev = history.length ? history[history.length - 1].recordHash : null;
  const seq = state.seq + 1;

  const rec = sealRecord(
    {
      ...buildDrawRecord({
        seq, at: nowIso(), operator: `github:${IN.actor}`, workflowRunUrl: IN.runUrl,
        batchId: IN.batchId, caseNo: r.caseNo, note: r.note ?? '',
        caseTypeName: config.caseTypes.find((c) => c.id === r.caseTypeId).name,
        result: r, drand: out.drand, commitPayloadHash: out.payloadHash,
      }),
      type: 'REDRAW',
      originalRecordId: rd.originalRecordId,
      recusedUnitId: rd.recusedUnitId,
      recuseReason: rd.recuseReason,
      ticketReturned: rd.ticketReturned,
    },
    prev
  );

  appendHistory(rec);
  state.seq = seq;
  state.updatedAt = nowIso();
  for (const binId of Object.keys(bins)) {
    state.bins[binId] = {
      ...state.bins[binId],
      tickets: bins[binId].tickets,
      cycle: bins[binId].cycle,
      carryOverSkips: bins[binId].carryOverSkips,
    };
  }
  state.bins[r.caseTypeId].lastRecordId = rec.recordId;
  saveState(state);
  rmSync(pendingFile);

  say('### 重抽結果');
  say('');
  say(`| 項目 | 內容 |`);
  say(`|---|---|`);
  say(`| 案號 | ${r.caseNo} |`);
  const T = terms(config);
  say(`| 原${T.drawee}（迴避） | ~~${rd.recusedUnitId}~~ |`);
  say(`| **新${T.drawee}** | **${r.resultUnitName}**（${r.resultCourtName}） |`);
  say(`| 迴避事由 | ${rd.recuseReason} |`);
  say(`| drand 輪次 | ${out.drand.round} |`);
  say(`| 重抽紀錄 | \`${rec.recordId}\` |`);
  say('');
  say(`> 原紀錄 \`${rd.originalRecordId}\` 完整保留，於公開看板標示為「已重抽，不生效」，`);
  say('> 並自受分統計中排除，避免同一件案子被計算兩次。');
}

/* ── 進入點 ──────────────────────────────────────────────── */

try {
  if (cmd === 'commit') await doCommit();
  else if (cmd === 'reveal') await doReveal();
  else {
    console.error('用法：node engine/run-redraw.mjs <commit|reveal>');
    process.exit(2);
  }
} catch (e) {
  if (e instanceof LotteryError) die(`[${e.code}] ${e.message}`);
  die(e.stack ?? String(e));
}
