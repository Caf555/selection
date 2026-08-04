#!/usr/bin/env node
/**
 * 本機命令列工具（離線可用）
 * SPEC.md §17
 *
 * 可用指令：
 *   init       建立初始 state.json
 *   status     顯示兩個籤筒的現況
 *   verify     驗證雜湊鏈與 state.json 完整性
 *   simulate   模擬抽籤（開發測試用，不寫入歷史）
 *
 * ⚠ 正式抽籤只能經由 GitHub Actions 執行（P2 實作），
 *   因為正式抽籤必須使用 drand 公共亂數並經兩階段承諾—開籤流程。
 *   本 CLI 刻意不提供正式抽籤指令，以免產生繞過該流程的途徑（SPEC §4.5）。
 */

import { existsSync, writeFileSync } from 'node:fs';

import { loadConfig, loadState, loadHistory, initState, saveState, verifyIntegrity, paths, DATA_DIR } from './state.mjs';
import { drawOnce, courtName } from './lottery.mjs';
import { makeSeededPicker } from './random.mjs';
import { LotteryError } from './errors.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : argv[i + 1];
}
function has(name) {
  return argv.includes('--' + name);
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

function printBin(config, binId, bin) {
  const ct = config.caseTypes.find((c) => c.id === binId);
  console.log(`\n  ${ct ? ct.name : binId}　第 ${bin.cycle} 輪　共 ${bin.tickets.length} 支籤`);
  console.log('  ' + '─'.repeat(52));

  for (const u of config.units.filter((x) => x.active)) {
    const n = bin.tickets.filter((t) => t === u.id).length;
    const owed = bin.carryOverSkips[u.id] ?? 0;
    const bar = n > 0 ? '▍'.repeat(n) : '（本輪已輪畢）';
    const tags = [];
    if (owed > 0) tags.push(`欠 ${owed} 支`);
    if ((u.ticketsPerCycle ?? 1) !== 1) tags.push(`每輪 ${u.ticketsPerCycle} 支`);
    console.log(
      `  ${u.name.padEnd(4, '　')} ${courtName(config, u.courtId).padEnd(7, '　')} ` +
        `${String(n).padStart(2)} 支  ${bar}${tags.length ? '  ⚠ ' + tags.join('、') : ''}`
    );
  }
}

function main() {
  const config = loadConfig();

  switch (cmd) {
    case 'init': {
      if (existsSync(paths().state) && !has('force')) {
        console.error('state.json 已存在。若確定要覆蓋，請加上 --force');
        process.exit(1);
      }
      const state = initState(config);
      saveState(state);
      if (!existsSync(paths().history)) writeFileSync(paths().history, '', 'utf8');
      console.log('已建立初始狀態：');
      for (const k of Object.keys(state.bins)) printBin(config, k, state.bins[k]);
      console.log(`\n資料目錄：${DATA_DIR}`);
      break;
    }

    case 'status': {
      const state = loadState();
      const history = loadHistory();
      console.log(`\n序號：${state.seq}　歷史紀錄：${history.length} 筆　更新於 ${state.updatedAt}`);
      for (const k of Object.keys(state.bins)) printBin(config, k, state.bins[k]);

      const drawn = history.filter((r) => r.type === 'DRAW' && !r.voided);
      if (drawn.length > 0) {
        console.log('\n  最近 5 筆抽籤');
        console.log('  ' + '─'.repeat(52));
        for (const r of drawn.slice(-5)) {
          console.log(`  ${r.recordId}  ${r.caseNo}  →  ${r.resultCourtName} ${r.resultUnitName}`);
        }
      }
      console.log('');
      break;
    }

    case 'verify': {
      const v = verifyIntegrity();
      if (v.ok) {
        console.log(`\n  ✓ 完整性驗證通過（歷史紀錄 ${v.recordCount} 筆）\n`);
      } else {
        console.error('\n  ✗ 完整性驗證失敗：');
        for (const p of v.problems) console.error('    - ' + p);
        console.error('');
        process.exit(1);
      }
      break;
    }

    case 'simulate': {
      const n = Number(flag('n', '20'));
      const caseTypeId = flag('type', 'jinsu');
      const offset = Number(flag('offset', '1'));
      const seed = flag('seed', 'simulate-' + Date.now());

      const state = loadState();
      const bins = binsFromState(state);
      const pick = makeSeededPicker(seed);

      console.log(`\n  ⚠ 模擬模式：使用本機確定性亂數（種子 ${seed}），不寫入歷史。`);
      console.log('  ⚠ 正式抽籤必須經 GitHub Actions 使用 drand 公共亂數（SPEC §4）。\n');

      const tally = {};
      for (let i = 0; i < n; i++) {
        const r = drawOnce({ config, bins, caseTypeId, offsetCount: offset, pick, itemSeq: i });
        tally[r.resultUnitName] = (tally[r.resultUnitName] ?? 0) + 1;
        if (n <= 30) {
          const rf = r.refills.length > 0 ? `　（補籤 ${r.refills.length} 次）` : '';
          console.log(`  第 ${String(i + 1).padStart(3)} 件  →  ${r.resultCourtName} ${r.resultUnitName}${rf}`);
        }
      }

      console.log('\n  受分統計');
      console.log('  ' + '─'.repeat(52));
      for (const k of Object.keys(tally).sort()) {
        console.log(`  ${k.padEnd(4, '　')} ${String(tally[k]).padStart(4)} 件`);
      }
      printBin(config, caseTypeId, bins[caseTypeId]);
      console.log('');
      break;
    }

    default:
      console.log(`
案件分案抽籤系統 — 本機工具

  node engine/cli.mjs init [--force]      建立初始 state.json
  node engine/cli.mjs status              顯示籤筒現況
  node engine/cli.mjs verify              驗證雜湊鏈與狀態完整性
  node engine/cli.mjs simulate [選項]     模擬抽籤（不寫入歷史）
      --n 20            模擬件數
      --type jinsu      案類（jinsu / jinzhongsu）
      --offset 1        每件抵分件數
      --seed abc        亂數種子（可重現）

  正式抽籤只能經由 GitHub Actions 執行（SPEC §4、§11）。
`);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof LotteryError) {
    console.error(`\n  ✗ [${e.code}] ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
