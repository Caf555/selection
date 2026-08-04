#!/usr/bin/env node
/**
 * 本機歷史同步
 * SPEC.md §10.4
 *
 *   node tools/sync-local.mjs [--out 資料夾] [--source 網址或 local]
 *
 * 自線上取得抽籤紀錄，**先驗證雜湊鏈完整性**，通過後才輸出：
 *   抽籤紀錄_YYYYMMDD.csv    UTF-8 with BOM，Excel 可直接開啟
 *   抽籤紀錄_YYYYMMDD.jsonl  原始備份
 *   抽籤紀錄_YYYYMMDD.html   大字可列印版
 *
 * 每次同步保留獨立檔案，形成本機多重備份。
 *
 * ⚠ 驗證失敗時**不輸出任何檔案**並以非零狀態結束。
 *   若把驗證不通過的資料也寫成 CSV，本機備份就會混入可能遭竄改的內容，
 *   日後無從分辨哪一份可信。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { verifyChain } from '../engine/records.mjs';
import { hashObject } from '../engine/hash.mjs';
import { DATA_DIR } from '../engine/state.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};

const outDir = resolve(flag('out', '本機歷史'));
const source = flag('source', null);

function fail(msg) {
  console.error('');
  console.error('  ✗ ' + msg);
  console.error('');
  console.error('  未輸出任何檔案。驗證不通過的資料不應混入本機備份，');
  console.error('  否則日後無從分辨哪一份可信。');
  console.error('');
  process.exit(1);
}

/* ── 取得資料 ─────────────────────────────────────────────── */

async function load() {
  const localConfig = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
  const g = localConfig.github ?? {};

  if (source === 'local') {
    console.log('  來源：本機 data/ 目錄');
    return {
      config: localConfig,
      state: JSON.parse(readFileSync(join(DATA_DIR, 'state.json'), 'utf8')),
      historyText: readFileSync(join(DATA_DIR, 'history.jsonl'), 'utf8'),
    };
  }

  const base = source ?? `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${g.branch}/data`;
  console.log(`  來源：${base}`);

  const get = async (name) => {
    const res = await fetch(`${base}/${name}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`讀取 ${name} 失敗（HTTP ${res.status}）`);
    return res.text();
  };

  const [cfg, st, hist] = await Promise.all([get('config.json'), get('state.json'), get('history.jsonl')]);
  return { config: JSON.parse(cfg), state: JSON.parse(st), historyText: hist };
}

/* ── 輸出 ─────────────────────────────────────────────────── */

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function toCsv(records, config) {
  const head = ['紀錄編號', '類型', '抽籤時間', '案類', '案號', '承辦股', '庭別',
                '抵分件數', '狀態', 'drand輪次', '執行者', '紀錄雜湊'];
  const voided = new Set(records.filter((r) => r.type === 'VOID').map((r) => r.targetRecordId));
  const superseded = new Set(records.filter((r) => r.type === 'REDRAW' && r.originalRecordId).map((r) => r.originalRecordId));

  const rows = records
    .filter((r) => ['DRAW', 'REDRAW', 'OFFLINE_BACKFILL'].includes(r.type))
    .map((r) => [
      r.recordId, r.type, r.at,
      config.caseTypes.find((c) => c.id === r.caseTypeId)?.name ?? r.caseTypeId,
      r.caseNo, r.resultUnitName, r.resultCourtName, r.offsetCount ?? 1,
      voided.has(r.recordId) ? '已作廢' : superseded.has(r.recordId) ? '已重抽，不生效'
        : r.type === 'REDRAW' ? '迴避重抽' : '有效',
      r.drand?.round ?? '', r.operator ?? '', r.recordHash,
    ]);

  return [head, ...rows].map((cols) => cols.map(csvCell).join(',')).join('\r\n');
}

function toHtml(records, config, state, stamp) {
  const voided = new Set(records.filter((r) => r.type === 'VOID').map((r) => r.targetRecordId));
  const superseded = new Set(records.filter((r) => r.type === 'REDRAW' && r.originalRecordId).map((r) => r.originalRecordId));
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const draws = records.filter((r) => ['DRAW', 'REDRAW', 'OFFLINE_BACKFILL'].includes(r.type));

  const tally = {};
  for (const r of draws) {
    if (voided.has(r.recordId) || superseded.has(r.recordId)) continue;
    tally[r.resultUnitName] = (tally[r.resultUnitName] ?? 0) + (r.offsetCount ?? 1);
  }

  return `<!DOCTYPE html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8">
<title>抽籤紀錄 ${stamp}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  html { font-size: 22px; }
  body { font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif; font-weight:500;
         line-height:1.6; color:#14171c; background:#fff; margin:0; padding:1.2rem; }
  h1 { font-size:1.5rem; margin:0 0 .2rem; }
  .meta { font-size:.85rem; color:#40464f; margin-bottom:1rem; }
  table { border-collapse:collapse; width:100%; font-size:.8rem; }
  th,td { border:1px solid #9aa4b2; padding:.35rem .5rem; text-align:left; }
  th { background:#14171c; color:#fff; }
  tr:nth-child(even) td { background:#f4f6f9; }
  .void { text-decoration:line-through; color:#40464f; }
  h2 { font-size:1.1rem; margin:1.4rem 0 .4rem; }
  .ok { color:#17541c; font-weight:700; }
</style></head><body>
<h1>案件分案抽籤紀錄</h1>
<div class="meta">
  同步時間 ${stamp}　｜　共 ${records.length} 筆紀錄（抽籤 ${draws.length} 筆）　｜
  <span class="ok">✓ 雜湊鏈完整性驗證通過</span>
</div>

<h2>籤筒現況</h2>
<table><tr><th>案類</th><th>輪次</th><th>籤筒內籤數</th><th>抵分欠籤</th></tr>
${config.caseTypes.filter((c) => c.active).map((c) => {
  const b = state.bins[c.id];
  if (!b) return '';
  const owed = Object.entries(b.carryOverSkips)
    .map(([u, n]) => `${config.units.find((x) => x.id === u)?.name ?? u} 欠 ${n}`).join('、') || '無';
  return `<tr><td>${esc(c.name)}</td><td>第 ${b.cycle} 輪</td><td>${b.tickets.length} 支</td><td>${esc(owed)}</td></tr>`;
}).join('')}
</table>

<h2>受分統計（折算件數，已計入抵分）</h2>
<table><tr><th>股別</th><th>庭別</th><th>折算件數</th></tr>
${config.units.filter((u) => u.active).map((u) =>
  `<tr><td>${esc(u.name)}</td><td>${esc(config.courts.find((c) => c.id === u.courtId)?.name ?? '')}</td><td>${tally[u.name] ?? 0}</td></tr>`
).join('')}
</table>

<h2>抽籤紀錄</h2>
<table>
<tr><th>紀錄編號</th><th>時間</th><th>案類</th><th>案號</th><th>承辦股</th><th>庭別</th><th>抵分</th><th>狀態</th><th>drand 輪次</th></tr>
${draws.slice().reverse().map((r) => {
  const bad = voided.has(r.recordId) || superseded.has(r.recordId);
  const st = voided.has(r.recordId) ? '已作廢' : superseded.has(r.recordId) ? '已重抽，不生效'
    : r.type === 'REDRAW' ? '迴避重抽' : '有效';
  return `<tr class="${bad ? 'void' : ''}"><td>${esc(r.recordId)}</td><td>${esc(r.at)}</td>` +
    `<td>${esc(config.caseTypes.find((c) => c.id === r.caseTypeId)?.name ?? '')}</td>` +
    `<td>${esc(r.caseNo)}</td><td><b>${esc(r.resultUnitName)}</b></td><td>${esc(r.resultCourtName)}</td>` +
    `<td>${r.offsetCount > 1 ? r.offsetCount + ' 件' : '—'}</td><td>${st}</td>` +
    `<td>${r.drand?.round ?? '—'}</td></tr>`;
}).join('')}
</table>
</body></html>`;
}

/* ── 主流程 ───────────────────────────────────────────────── */

console.log('\n案件分案抽籤系統　本機歷史同步\n');

let data;
try {
  data = await load();
} catch (e) {
  fail('無法取得資料：' + e.message);
}

const { config, state, historyText } = data;

let records;
try {
  records = historyText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
} catch (e) {
  fail('history.jsonl 內容不是合法的 JSON：' + e.message);
}

console.log(`  取得 ${records.length} 筆紀錄\n`);

// ── 完整性驗證（不通過即中止）──────────────────────────
const chain = verifyChain(records);
if (!chain.ok) fail('雜湊鏈驗證失敗：' + chain.reason);
console.log('  ✓ 雜湊鏈完整，' + records.length + ' 筆連續無斷點');

const expectedStateHash = hashObject(state, ['stateHash']);
if (state.stateHash !== expectedStateHash) {
  fail(`state.json 的雜湊不符\n     紀錄值：${state.stateHash}\n     重算值：${expectedStateHash}`);
}
console.log('  ✓ state.json 雜湊相符');

if (records.length > 0 && records[records.length - 1].seq !== state.seq) {
  fail(`state.json 序號 ${state.seq} 與歷史最後一筆 ${records[records.length - 1].seq} 不一致`);
}
console.log('  ✓ 序號與歷史一致');

// ── 輸出 ────────────────────────────────────────────────
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
const full = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

const files = [
  [`抽籤紀錄_${stamp}.csv`, '﻿' + toCsv(records, config)],   // BOM 讓 Excel 正確辨識 UTF-8
  [`抽籤紀錄_${stamp}.jsonl`, records.map((r) => JSON.stringify(r)).join('\n') + '\n'],
  [`抽籤紀錄_${stamp}.html`, toHtml(records, config, state, full)],
];

console.log('');
for (const [name, content] of files) {
  writeFileSync(join(outDir, name), content, 'utf8');
  console.log(`  已輸出　${name}`);
}

console.log(`\n  儲存位置：${outDir}\n`);
