/**
 * 正式設定檔的結構驗證
 *
 * 演算法測試使用 helpers.mjs 的固定 fixture，與正式設定解耦。
 * 本檔則直接檢查 data/config.json，確保營運上的設定變更（新增庭、改股名、
 * 調整每輪籤數）不會產生會讓抽籤引擎當掉或行為異常的資料。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../state.mjs';
import { createAllBins, activeUnits, normalizeBin } from '../lottery.mjs';
import { validateConfig } from '../validate-config.mjs';

const config = loadConfig();

/** 取得一份可安全修改的設定副本 */
const clone = () => structuredClone(config);

describe('data/config.json 結構驗證', () => {
  test('正式設定通過全部結構驗證', () => {
    const problems = validateConfig(config);
    assert.deepEqual(problems, [], '正式設定有問題：\n  ' + problems.join('\n  '));
  });

  test('驗證器抓得出各種會使系統失效的設定錯誤', () => {
    const cases = [
      ['庭別 ID 重複', (c) => { c.courts.push({ ...c.courts[0], order: 99 }); }, /ID 重複/],
      ['股別 order 重複', (c) => { c.units[1].order = c.units[0].order; }, /order 重複/],
      ['股別所屬庭不存在', (c) => { c.units[0].courtId = 'ct-xx'; }, /不存在/],
      ['在職股名稱重複', (c) => { c.units[1].name = c.units[0].name; }, /名稱重複/],
      ['顏色不在樣式表支援範圍', (c) => { c.courts[0].color = 'pink'; }, /顏色/],
      ['每輪籤數為 0', (c) => { c.units[0].ticketsPerCycle = 0; }, /每輪籤數/],
      ['在職股不足 2 個', (c) => { c.units.forEach((u, i) => { u.active = i === 0; }); }, /少於 2 個/],
      ['所有在職股同屬一庭', (c) => {
        c.units.forEach((u, i) => { u.active = i < 2; });
        c.units[1].courtId = c.units[0].courtId;
      }, /同一庭/],
      ['沒有啟用的案類', (c) => { c.caseTypes.forEach((t) => { t.active = false; }); }, /沒有任何啟用的案類/],
      ['補籤門檻不小於總籤數', (c) => { c.rules.refillWhenRemainingAtMost = 99; }, /無限補籤/],
      ['drand roundOffset 為 0', (c) => { c.drand.roundOffset = 0; }, /承諾階段/],
      ['要求一致的端點數超過端點總數', (c) => { c.drand.minAgreeingEndpoints = 99; }, /永遠無法進行/],
      ['在職股所屬的庭已停用', (c) => { c.courts[0].active = false; }, /已停用/],
    ];

    for (const [name, mutate, pattern] of cases) {
      const c = clone();
      mutate(c);
      const problems = validateConfig(c);
      assert.ok(problems.length > 0, `未偵測到問題：${name}`);
      assert.ok(
        problems.some((p) => pattern.test(p)),
        `「${name}」的錯誤訊息不符預期：${problems.join('；')}`
      );
    }
  });

  test('可用正式設定建立籤筒，且籤數與排序正確', () => {
    const bins = createAllBins(config);
    const expected = activeUnits(config).reduce((s, u) => s + (u.ticketsPerCycle ?? 1), 0);

    for (const ct of config.caseTypes.filter((c) => c.active)) {
      const bin = bins[ct.id];
      assert.ok(bin, `案類 ${ct.id} 沒有對應的籤筒`);
      assert.equal(bin.tickets.length, expected, `${ct.name} 籤筒初始籤數應為 ${expected}`);
      assert.deepEqual(
        bin.tickets,
        normalizeBin(bin.tickets, config),
        `${ct.name} 籤筒未依 SPEC §3.2 正規化排序`
      );
      assert.deepEqual(bin.carryOverSkips, {});
    }
  });

  test('drand 設定在 P2 上線前必須填入（目前允許為空）', () => {
    const d = config.drand;
    assert.ok(Array.isArray(d.endpoints) && d.endpoints.length >= 2, 'drand 端點應至少設定 2 個以供備援');
    assert.ok(Number.isInteger(d.roundOffset) && d.roundOffset >= 1,
      'roundOffset 必須 >= 1，否則目標輪次在請求當下已存在，承諾階段失去意義');
    // chainHash / publicKey 於 P2 填入，此處僅提醒而不使測試失敗
    if (!d.chainHash || !d.publicKey) {
      console.log('    ⚠ 提醒：config.drand.chainHash 與 publicKey 尚未填入，P2 上線前必須補上');
    }
  });
});
