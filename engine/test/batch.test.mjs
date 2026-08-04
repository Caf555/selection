/**
 * 批次抽籤測試
 * SPEC.md §14 測試項目 19～20、§3.7
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { drawBatch } from '../lottery.mjs';
import { makeSequencePicker, makeSeededPicker } from '../random.mjs';
import { LotteryError, ERR } from '../errors.mjs';
import { freshConfig, makeBin, U, ALL8, assertRefillInvariant } from './helpers.mjs';

describe('批次抽籤（SPEC §14 測試 19～20）', () => {
  test('#19 批次 5 件，中途觸發補籤 → 後續件正確使用補籤後的籤筒', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.孝, U.信]), jinzhongsu: makeBin(ALL8) };

    const results = drawBatch({
      config, bins, caseTypeId: 'jinsu',
      items: [
        { caseNo: '115年度金訴字第001號' },
        { caseNo: '115年度金訴字第002號' },
        { caseNo: '115年度金訴字第003號' },
        { caseNo: '115年度金訴字第004號' },
        { caseNo: '115年度金訴字第005號' },
      ],
      pick: makeSequencePicker([2, 0, 0, 0, 0]),
    });

    assert.equal(results.length, 5);
    assert.deepEqual(results.map((r) => r.caseNo), [
      '115年度金訴字第001號', '115年度金訴字第002號', '115年度金訴字第003號',
      '115年度金訴字第004號', '115年度金訴字第005號',
    ]);
    assert.deepEqual(results.map((r) => r.itemSeq), [0, 1, 2, 3, 4]);

    // 第 1 件抽走信股 → 剩 [忠, 孝] 同屬刑一庭 → 補籤至 10 支
    assert.equal(results[0].resultUnitId, U.信);
    assert.equal(results[0].refills.length, 1);
    assert.equal(results[0].binAfter.length, 10);

    // 第 2 件的起始籤筒必須等於第 1 件的結束籤筒
    for (let i = 1; i < results.length; i++) {
      assert.deepEqual(
        results[i].binBefore, results[i - 1].binAfter,
        `第 ${i + 1} 件的起始籤筒應等於第 ${i} 件的結束籤筒`
      );
    }
    assertRefillInvariant(bins.jinsu, config, '#19');
  });

  test('#19b 批次中每件的抵分與迴避可逐件指定', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };

    const results = drawBatch({
      config, bins, caseTypeId: 'jinsu',
      items: [
        { caseNo: 'A', offsetCount: 3 },
        { caseNo: 'B', excludedUnitIds: [U.忠, U.孝] },
        { caseNo: 'C' },
      ],
      pick: makeSeededPicker('batch-per-item'),
    });

    assert.equal(results[0].offsetCount, 3);
    assert.notEqual(results[1].resultUnitId, U.忠);
    assert.notEqual(results[1].resultUnitId, U.孝);
    assert.equal(results[2].offsetCount, 1);
  });

  test('#20 批次第 3 件失敗 → 前 2 件保留，明確回報中止位置', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };

    let err;
    try {
      drawBatch({
        config, bins, caseTypeId: 'jinsu',
        items: [
          { caseNo: 'A' },
          { caseNo: 'B' },
          { caseNo: 'C', offsetCount: 99 }, // 超過 maxOffsetPerCase
          { caseNo: 'D' },
        ],
        pick: makeSeededPicker('batch-fail'),
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof LotteryError);
    assert.equal(err.code, ERR.OFFSET_TOO_LARGE);
    assert.equal(err.details.completedCount, 2, '應回報已完成 2 件');
    assert.equal(err.details.failedAtIndex, 2);
    assert.equal(err.details.failedCaseNo, 'C');
    assert.equal(err.partialResults.length, 2, '已完成的件應保留');
    assert.equal(bins.jinsu.tickets.length, 6, '前 2 件的籤筒異動不回復');
  });
});
