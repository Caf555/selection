/**
 * 股別變動測試（立即生效，SPEC R-07 / R-08）
 * SPEC.md §14 測試項目 16～18
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { drawOnce, addUnit, deactivateUnit, setTicketsPerCycle, refillOnce } from '../lottery.mjs';
import { makeSequencePicker } from '../random.mjs';
import { freshConfig, makeBin, U, ALL8, count, assertRefillInvariant } from './helpers.mjs';

describe('股別變動（SPEC §14 測試 16～18）', () => {
  test('#16 新增股且每輪籤數 N = 3 → 立即投入 3 支籤，並執行補籤檢查', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };

    const adj = addUnit(config, bins, {
      id: 'un-09', name: '新股', courtId: 'ct-04', order: 9, ticketsPerCycle: 3,
    });

    assert.equal(adj.length, 2, '兩個籤筒都應調整');
    assert.equal(count(bins.jinsu.tickets)['un-09'], 3);
    assert.equal(count(bins.jinzhongsu.tickets)['un-09'], 3);
    assert.equal(bins.jinsu.tickets.length, 11);

    // 下次補籤時，新股仍放入 3 支
    const bin = makeBin([U.忠, U.信]);
    const r = refillOnce(bin, config, 'jinsu', 'test');
    assert.equal(r.added, 11, '8 個原有股各 1 支 + 新股 3 支');
    assert.equal(count(bin.tickets)['un-09'], 3);
  });

  test('#16b 新增股後立即抽籤，新股可被抽中', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.信]), jinzhongsu: makeBin(ALL8) };

    addUnit(config, bins, {
      id: 'un-09', name: '新股', courtId: 'ct-04', order: 9, ticketsPerCycle: 3,
    });

    // 籤筒為 [忠, 信, 新, 新, 新]，索引 2 為新股
    const r = drawOnce({ config, bins, caseTypeId: 'jinsu', pick: makeSequencePicker([2]) });
    assert.equal(r.resultUnitId, 'un-09');
  });

  test('#17 停用股 → 其籤立即自籤筒撤出；若因此使籤筒 <= 1 支 → 觸發補籤', () => {
    const config = freshConfig();
    const bins = {
      jinsu: makeBin([U.忠, U.忠, U.信]),
      jinzhongsu: makeBin(ALL8),
    };

    const adj = deactivateUnit(config, bins, U.忠);
    const jinsuAdj = adj.find((a) => a.binId === 'jinsu');

    assert.equal(jinsuAdj.ticketsRemoved, 2);
    assert.ok(jinsuAdj.refills.length >= 1, '撤籤後剩 1 支，必須補籤');
    assert.ok(!bins.jinsu.tickets.includes(U.忠), '停用股不應留有任何籤');
    // 補籤只放入在職的 7 個股
    assert.equal(bins.jinsu.tickets.length, 8, '原剩 1 支信 + 補入 7 支');
    assertRefillInvariant(bins.jinsu, config, '#17');
  });

  test('#17b 停用股後，該股不再被抽中', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };

    deactivateUnit(config, bins, U.忠);

    for (let i = 0; i < 50; i++) {
      const r = drawOnce({ config, bins, caseTypeId: 'jinsu', pick: makeSequencePicker([0]), itemSeq: i });
      assert.notEqual(r.resultUnitId, U.忠);
    }
  });

  test('#18 修改既有股的 N 值 → 不影響現有籤筒，自下次補籤起生效', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const before = bins.jinsu.tickets.slice();

    const chg = setTicketsPerCycle(config, U.忠, 3);
    assert.equal(chg.before, 1);
    assert.equal(chg.after, 3);
    assert.deepEqual(bins.jinsu.tickets, before, '修改 N 值不得異動現有籤筒');

    // 下次補籤才生效
    const bin = makeBin([U.信, U.和]);
    const r = refillOnce(bin, config, 'jinsu', 'test');
    assert.equal(r.added, 10, '忠股 3 支 + 其餘 7 股各 1 支');
    assert.equal(count(bin.tickets)[U.忠], 3);
  });

  test('#18b N 值必須為 1 以上的整數', () => {
    const config = freshConfig();
    for (const bad of [0, -1, 2.5]) {
      assert.throws(() => setTicketsPerCycle(config, U.忠, bad));
    }
  });
});
