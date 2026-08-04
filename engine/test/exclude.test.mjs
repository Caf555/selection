/**
 * 迴避測試
 * SPEC.md §14 測試項目 13～15
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { drawOnce } from '../lottery.mjs';
import { makeSequencePicker, makeSeededPicker } from '../random.mjs';
import { LotteryError, ERR } from '../errors.mjs';
import { freshConfig, makeBin, U, ALL8, count, assertRefillInvariant } from './helpers.mjs';

describe('迴避（SPEC §14 測試 13～15）', () => {
  test('#13 迴避 1 股 → 該股不被抽中，但其籤仍留在籤筒內、支數不變（SPEC R-09）', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      excludedUnitIds: [U.忠],
      pick: makeSequencePicker([0]), // drawable 的第 0 位是孝股（忠已被排除）
    });

    assert.equal(r.resultUnitId, U.孝, '迴避的忠股不應被抽中');
    assert.equal(r.drawableCount, 7);
    assert.deepEqual(r.drawable, [U.孝, U.仁, U.愛, U.信, U.義, U.和, U.平]);
    assert.ok(bins.jinsu.tickets.includes(U.忠), '迴避股的籤仍應留在籤筒內');
    assert.equal(bins.jinsu.tickets.length, 7, '籤筒僅因抽出而減少 1 支');
  });

  test('#13b 連續多次迴避同一股，該股始終不被抽中', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const pick = makeSeededPicker('exclude-repeat');

    for (let i = 0; i < 500; i++) {
      const r = drawOnce({
        config, bins, caseTypeId: 'jinsu',
        excludedUnitIds: [U.信],
        pick, itemSeq: i,
      });
      assert.notEqual(r.resultUnitId, U.信, `第 ${i} 次抽中了被迴避的信股`);
      assertRefillInvariant(bins.jinsu, config, `#13b 第 ${i} 次`);
    }

    // 信股從未被抽出，其籤會在籤筒內持續累積
    assert.ok(count(bins.jinsu.tickets)[U.信] >= 1);
  });

  test('#14 迴避後可抽集合為空但籤筒非空 → 先補籤再抽', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.忠]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      excludedUnitIds: [U.忠],
      pick: makeSequencePicker([0]),
    });

    assert.ok(r.refills.length >= 1, '應觸發補籤');
    assert.equal(r.refills[0].reason, 'exclusion-exhausted');
    assert.notEqual(r.resultUnitId, U.忠);
    assert.equal(r.drawableCount, 7, '補籤後 8 個股中扣除迴避的忠股');
    assertRefillInvariant(bins.jinsu, config, '#14');
  });

  test('#14b 欠籤導致補籤後仍無可抽籤 → 持續補籤直到有籤可抽', () => {
    const config = freshConfig();
    // 除忠、孝外全部欠籤，且籤筒現有籤全為迴避股
    const bins = {
      jinsu: makeBin([U.仁, U.愛], {
        carryOverSkips: { [U.仁]: 2, [U.愛]: 2, [U.信]: 2, [U.義]: 2, [U.和]: 2, [U.平]: 2 },
      }),
      jinzhongsu: makeBin(ALL8),
    };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      excludedUnitIds: [U.仁, U.愛],
      pick: makeSequencePicker([0]),
    });

    assert.ok([U.忠, U.孝, U.信, U.義, U.和, U.平].includes(r.resultUnitId));
    assert.ok(r.refills.length >= 1);
    assertRefillInvariant(bins.jinsu, config, '#14b');
  });

  test('#15 所有在職股均迴避 → 正確中止並回報錯誤', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const before = bins.jinsu.tickets.slice();

    assert.throws(
      () => drawOnce({
        config, bins, caseTypeId: 'jinsu',
        excludedUnitIds: ALL8,
        pick: makeSequencePicker([0]),
      }),
      (e) => e instanceof LotteryError && e.code === ERR.ALL_EXCLUDED
    );

    assert.deepEqual(bins.jinsu.tickets, before, '中止時籤筒不得被異動');
  });

  test('#15b 迴避不存在的股 → 拒絕', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };

    assert.throws(
      () => drawOnce({
        config, bins, caseTypeId: 'jinsu',
        excludedUnitIds: ['un-99'],
        pick: makeSequencePicker([0]),
      }),
      (e) => e instanceof LotteryError && e.code === ERR.UNKNOWN_UNIT
    );
  });
});
