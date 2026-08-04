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
import { createAllBins, activeUnits, courtIdOf, normalizeBin } from '../lottery.mjs';

const config = loadConfig();

describe('data/config.json 結構驗證', () => {
  test('庭別：ID 唯一、order 唯一、必要欄位齊備', () => {
    const ids = new Set();
    const orders = new Set();
    for (const c of config.courts) {
      assert.ok(c.id && typeof c.id === 'string', `庭別缺少 id：${JSON.stringify(c)}`);
      assert.ok(!ids.has(c.id), `庭別 ID 重複：${c.id}`);
      ids.add(c.id);
      assert.ok(c.name, `庭別 ${c.id} 缺少名稱`);
      assert.ok(Number.isInteger(c.order), `庭別 ${c.id} 的 order 必須為整數`);
      assert.ok(!orders.has(c.order), `庭別 order 重複：${c.order}`);
      orders.add(c.order);
      assert.ok(
        ['blue', 'green', 'amber', 'purple'].includes(c.color),
        `庭別 ${c.id} 的顏色 ${c.color} 不在樣式表支援的範圍內（會導致標籤失去顏色與圖示）`
      );
    }
  });

  test('股別：ID 唯一、order 唯一、所屬庭存在、每輪籤數為正整數', () => {
    const courtIds = new Set(config.courts.map((c) => c.id));
    const ids = new Set();
    const orders = new Set();
    for (const u of config.units) {
      assert.ok(u.id && typeof u.id === 'string', `股別缺少 id：${JSON.stringify(u)}`);
      assert.ok(!ids.has(u.id), `股別 ID 重複：${u.id}`);
      ids.add(u.id);
      assert.ok(u.name, `股別 ${u.id} 缺少名稱`);
      assert.ok(courtIds.has(u.courtId), `股別 ${u.id} 所屬的庭 ${u.courtId} 不存在`);
      assert.ok(Number.isInteger(u.order), `股別 ${u.id} 的 order 必須為整數`);
      assert.ok(!orders.has(u.order), `股別 order 重複：${u.order}（會使籤筒排序不確定）`);
      orders.add(u.order);
      const n = u.ticketsPerCycle ?? 1;
      assert.ok(Number.isInteger(n) && n >= 1, `股別 ${u.id} 的每輪籤數必須為 1 以上的整數`);
    }
  });

  test('股別名稱不重複（避免抽籤結果無法辨識是哪一股）', () => {
    const names = config.units.filter((u) => u.active).map((u) => u.name);
    assert.equal(new Set(names).size, names.length, `在職股別有重複名稱：${names.join('、')}`);
  });

  test('至少有 2 個在職股，且至少分屬 2 個庭', () => {
    const active = activeUnits(config);
    assert.ok(active.length >= 2, '在職股少於 2 個，無法進行有意義的抽籤');
    const courts = new Set(active.map((u) => courtIdOf(config, u.id)));
    assert.ok(
      courts.size >= 2,
      '所有在職股都屬於同一庭，「剩 2 支同庭即補籤」的規則會使籤筒無限補籤'
    );
  });

  test('案類：ID 唯一，且至少有一個啟用', () => {
    const ids = new Set();
    for (const c of config.caseTypes) {
      assert.ok(!ids.has(c.id), `案類 ID 重複：${c.id}`);
      ids.add(c.id);
    }
    assert.ok(config.caseTypes.some((c) => c.active), '沒有任何啟用的案類');
  });

  test('規則參數在合理範圍內', () => {
    const r = config.rules;
    assert.ok(Number.isInteger(r.refillWhenRemainingAtMost) && r.refillWhenRemainingAtMost >= 0);
    assert.ok(Number.isInteger(r.maxOffsetPerCase) && r.maxOffsetPerCase >= 1);
    assert.ok(Number.isInteger(r.maxRefillLoops) && r.maxRefillLoops >= 1);
    assert.ok(
      r.refillWhenRemainingAtMost < activeUnits(config).length,
      '補籤門檻不得大於或等於在職股的總籤數，否則會無限補籤'
    );
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
