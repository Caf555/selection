/**
 * 補籤門檻測試
 * SPEC.md §14 測試項目 1～4
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { drawOnce, createBin } from '../lottery.mjs';
import { makeSequencePicker } from '../random.mjs';
import { freshConfig, makeBin, U, ALL8, count, assertRefillInvariant } from './helpers.mjs';

describe('補籤門檻（SPEC §14 測試 1～4）', () => {
  test('#1 初始 8 支，連續抽 7 次後剩 1 支 → 補籤 → 9 支，原剩餘股有 2 支', () => {
    const config = freshConfig();
    const bins = { jinsu: createBin(config), jinzhongsu: createBin(config) };

    assert.equal(bins.jinsu.tickets.length, 8, '初始應為 8 支');
    assert.deepEqual(bins.jinsu.tickets, ALL8);

    // 刻意留下 忠(刑一) 與 信(刑三)，兩者不同庭，避免提前觸發補籤
    const picks = [1, 1, 1, 2, 2, 2, 0];
    let last;
    for (let i = 0; i < 7; i++) {
      last = drawOnce({
        config, bins, caseTypeId: 'jinsu',
        pick: makeSequencePicker([picks[i]]),
      });
      if (i < 5) assert.equal(last.refills.length, 0, `第 ${i + 1} 次不應補籤`);
    }

    // 第 6 次抽完剩 [忠, 信]，第 7 次抽走忠 → 剩 1 支 → 補籤
    assert.equal(last.resultUnitId, U.忠);
    assert.equal(last.refills.length, 1);
    assert.equal(last.refills[0].added, 8);
    assert.equal(bins.jinsu.tickets.length, 9, '補籤後應為 9 支');
    assert.equal(count(bins.jinsu.tickets)[U.信], 2, '原先剩餘的信股應有 2 支籤');
    assert.equal(bins.jinsu.cycle, 2);
  });

  test('#2 剩 2 支且分屬不同庭 → 不補籤', () => {
    const config = freshConfig();
    // 忠=刑一、信=刑三
    const bins = { jinsu: makeBin([U.忠, U.信, U.平]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      pick: makeSequencePicker([2]), // 抽走平股
    });

    assert.equal(r.resultUnitId, U.平);
    assert.equal(r.refills.length, 0, '2 支不同庭，不應補籤');
    assert.deepEqual(bins.jinsu.tickets, [U.忠, U.信]);
  });

  test('#3 剩 2 支且同屬一庭 → 補籤 → 10 支', () => {
    const config = freshConfig();
    // 忠、孝同屬刑一庭
    const bins = { jinsu: makeBin([U.忠, U.孝, U.信]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      pick: makeSequencePicker([2]), // 抽走信股
    });

    assert.equal(r.resultUnitId, U.信);
    assert.equal(r.refills.length, 1, '2 支同屬刑一庭，必須補籤');
    assert.equal(bins.jinsu.tickets.length, 10);
    assert.equal(count(bins.jinsu.tickets)[U.忠], 2);
    assert.equal(count(bins.jinsu.tickets)[U.孝], 2);
    assertRefillInvariant(bins.jinsu, config, '#3');
  });

  test('#4 剩 2 支且為同一股的兩支籤 → 補籤（SPEC R-04）', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.信]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      pick: makeSequencePicker([2]), // 抽走信股，剩 [忠, 忠]
    });

    assert.equal(r.refills.length, 1, '同一股的兩支籤必然同庭，應補籤');
    assert.equal(bins.jinsu.tickets.length, 10);
    assert.equal(count(bins.jinsu.tickets)[U.忠], 3);
  });

  test('#4b 剩 3 支 → 不補籤（門檻為絕對值，SPEC R-03）', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.孝, U.仁, U.愛]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({ config, bins, caseTypeId: 'jinsu', pick: makeSequencePicker([0]) });

    assert.equal(r.refills.length, 0, '剩 3 支即使全部同庭也不補籤');
    assert.equal(bins.jinsu.tickets.length, 3);
  });

  test('#4c 每支籤等機率：某股有 2 支籤時，其可抽位置亦為 2 個', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };

    // drawable 為正規化後的 [忠, 忠, 信, 和]，索引 0 與 1 皆為忠股
    const r0 = drawOnce({ config, bins: structuredClone(bins), caseTypeId: 'jinsu', pick: makeSequencePicker([0]) });
    const r1 = drawOnce({ config, bins: structuredClone(bins), caseTypeId: 'jinsu', pick: makeSequencePicker([1]) });

    assert.equal(r0.resultUnitId, U.忠);
    assert.equal(r1.resultUnitId, U.忠);
    assert.deepEqual(r0.drawable, [U.忠, U.忠, U.信, U.和]);
  });
});
