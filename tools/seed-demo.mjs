#!/usr/bin/env node
/**
 * 產生示範資料，供版面檢視使用
 *
 *   node tools/seed-demo.mjs
 *   → demo/config.json、demo/state.json、demo/history.jsonl
 *
 * ⚠ 產出內容為隨機模擬，案號與抽籤結果均非真實紀錄。
 *   刻意寫入獨立的 demo/ 目錄，絕不碰觸 data/ 底下的正式資料。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadConfig } from '../engine/state.mjs';
import { createAllBins, drawOnce } from '../engine/lottery.mjs';
import { makeSeededPicker } from '../engine/random.mjs';
import { buildDrawRecord, buildAuditRecord, sealRecord, makeBatchId } from '../engine/records.mjs';
import { applyRedraw, applyVoid, buildAmend } from '../engine/operations.mjs';
import { hashObject } from '../engine/hash.mjs';

const OUT = fileURLToPath(new URL('../demo/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const config = loadConfig();

// 示範用的承辦股。正式資料的承辦股請於「組織管理」頁登錄。
if ((config.requesters ?? []).length === 0) {
  config.requesters = [
    { id: 'rq-01', name: '範例甲股', order: 1, active: true, note: '示範資料' },
    { id: 'rq-02', name: '範例乙股', order: 2, active: true, note: '示範資料' },
  ];
}
const REQ = config.requesters.filter((r) => r.active);

const bins = createAllBins(config);
const pick = makeSeededPicker('demo-seed-2026');

const history = [];
let seq = 0;
let prevHash = null;
let caseSerial = { jinsu: 0, jinzhongsu: 0 };

// 起始時間：約六週前，每件間隔數小時
let clock = new Date('2026-06-22T09:10:00+08:00').getTime();
function nextTime(hours = 5) {
  clock += Math.round(hours * 3600 * 1000);
  const d = new Date(clock);
  // 週末往後推到週一
  if (d.getDay() === 6) clock += 2 * 86400000;
  if (d.getDay() === 0) clock += 86400000;
  return new Date(clock).toISOString().replace('Z', '+00:00');
}

const OPERATORS = ['github:clerk-wang', 'github:clerk-lee'];
function operator(i) { return OPERATORS[i % OPERATORS.length]; }

function caseNo(caseTypeId) {
  caseSerial[caseTypeId] += 1;
  const n = String(caseSerial[caseTypeId]).padStart(3, '0');
  return caseTypeId === 'jinsu'
    ? `115年度金訴字第${n}號`
    : `115年度金重訴字第${n}號`;
}

function push(record) {
  const sealed = sealRecord(record, prevHash);
  history.push(sealed);
  prevHash = sealed.recordHash;
  return sealed;
}

function doDraw({ caseTypeId, offsetCount = 1, offsetMap = null, excludedUnitIds = [], excludeReason = '', note = '' }) {
  const result = drawOnce({
    config, bins, caseTypeId, offsetCount, offsetMap, excludedUnitIds, pick, itemSeq: seq,
  });
  seq += 1;
  const req = REQ[seq % REQ.length];
  return push(
    buildDrawRecord({
      seq,
      at: nextTime(4 + (seq % 7)),
      operator: operator(seq),
      batchId: makeBatchId(Math.ceil(seq / 3)),
      caseNo: caseNo(caseTypeId),
      caseTypeName: config.caseTypes.find((c) => c.id === caseTypeId).name,
      note,
      requesterUnitId: req.id,
      requesterUnitName: req.name,
      result: { ...result, excludeReason },
    })
  );
}

/* ── 1. 一般抽籤 ─────────────────────────────────────────── */
for (let i = 0; i < 34; i++) {
  const caseTypeId = i % 4 === 3 ? 'jinzhongsu' : 'jinsu';
  // 每 8 件出現一件重大案件
  const big = i > 0 && i % 8 === 0;
  doDraw({
    caseTypeId,
    offsetCount: big ? 3 : 1,
    note: big ? '重大金融案件，經核定抵 3 件' : '',
  });
}

/* ── 2. 抵分跨案類的重大案件 ─────────────────────────────── */
doDraw({
  caseTypeId: 'jinzhongsu',
  offsetCount: 4,
  offsetMap: { jinzhongsu: 2, jinsu: 1 },
  note: '重大案件，抵分同時作用於金訴與金重訴籤筒',
});

/* ── 3. 案號誤繕後更正 ───────────────────────────────────── */
const toAmend = doDraw({ caseTypeId: 'jinsu' });
seq += 1;
push(
  buildAuditRecord({
    seq,
    type: 'AMEND',
    at: nextTime(1),
    operator: operator(seq),
    payload: buildAmend({
      targetRecord: toAmend,
      changes: { caseNo: toAmend.caseNo.replace(/第(\d+)號/, (_, n) => `第${String(Number(n) + 400).padStart(3, '0')}號`) },
      reason: '收案時案號誤繕，依卷面更正',
    }),
  })
);

/* ── 4. 抽中後始發現應迴避，重新抽籤 ─────────────────────── */
const toRedraw = doDraw({ caseTypeId: 'jinsu' });
const rd = applyRedraw({
  config, bins, history, originalRecord: toRedraw,
  recusedUnitId: toRedraw.resultUnitId,
  recuseReason: '承辦法官為被告之前審裁判法官，依法自行迴避',
  pick, itemSeq: seq,
});
seq += 1;
push({
  ...buildDrawRecord({
    seq,
    at: nextTime(1),
    operator: operator(seq),
    caseNo: toRedraw.caseNo,
    caseTypeName: '金訴',
    note: '因承辦股迴避而重新抽籤',
    result: rd.result,
  }),
  type: 'REDRAW',
  originalRecordId: rd.originalRecordId,
  recusedUnitId: rd.recusedUnitId,
  recuseReason: rd.recuseReason,
  ticketReturned: rd.ticketReturned,
});

/* ── 5. 抽錯案類，整筆作廢並回復籤筒 ─────────────────────── */
const toVoid = doDraw({ caseTypeId: 'jinzhongsu', note: '（示範：登錄時誤選案類）' });
const vd = applyVoid({
  bins, history, targetRecord: toVoid,
  reason: '登錄時誤選案類，本件應為金訴案，整筆作廢後重新登錄',
});
seq += 1;
push(
  buildAuditRecord({
    seq, type: 'VOID', at: nextTime(1), operator: operator(seq),
    payload: { ...vd, caseTypeId: toVoid.caseTypeId },
  })
);

/* ── 6. 最近幾件 ─────────────────────────────────────────── */
for (let i = 0; i < 4; i++) {
  doDraw({ caseTypeId: i % 3 === 2 ? 'jinzhongsu' : 'jinsu' });
}

/* ── 輸出 ────────────────────────────────────────────────── */
const lastByBin = {};
for (const r of history) {
  if (r.caseTypeId) lastByBin[r.caseTypeId] = r.recordId;
}

const state = {
  schemaVersion: 1,
  seq,
  updatedAt: new Date(clock).toISOString().replace('Z', '+00:00'),
  bins: Object.fromEntries(
    Object.keys(bins).map((k) => [
      k,
      {
        tickets: bins[k].tickets,
        cycle: bins[k].cycle,
        carryOverSkips: bins[k].carryOverSkips,
        lastRecordId: lastByBin[k] ?? null,
      },
    ])
  ),
  prevStateHash: null,
};
state.stateHash = hashObject(state);

const demoConfig = {
  ...config,
  _note: '示範資料。案號與抽籤結果均為隨機模擬，非真實紀錄。',
};

writeFileSync(join(OUT, 'config.json'), JSON.stringify(demoConfig, null, 2) + '\n', 'utf8');
writeFileSync(join(OUT, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
writeFileSync(join(OUT, 'history.jsonl'), history.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

console.log(`\n  已產生示範資料（${history.length} 筆紀錄）→ ${OUT}\n`);
for (const k of Object.keys(bins)) {
  const ct = config.caseTypes.find((c) => c.id === k);
  console.log(`    ${ct.name}：第 ${bins[k].cycle} 輪，籤筒內 ${bins[k].tickets.length} 支`);
}
console.log(`\n  檢視：http://localhost:8080/public/index.html?src=../demo/\n`);
