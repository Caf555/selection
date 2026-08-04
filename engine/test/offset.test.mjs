/**
 * 抵分與執行順序測試
 * SPEC.md §14 測試項目 5～12、§3.6
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { drawOnce } from '../lottery.mjs';
import { makeSequencePicker, makeSeededPicker } from '../random.mjs';
import { LotteryError, ERR } from '../errors.mjs';
import { freshConfig, makeBin, makeBins, U, ALL8, count, assertRefillInvariant } from './helpers.mjs';

describe('抵分基本行為（SPEC §14 測試 5～8）', () => {
  test('#5 抵 3 件，籤筒內該股尚有 >= 2 支 → 全數自籤筒扣除，欠籤為 0', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.忠, U.信]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      offsetCount: 3,
      pick: makeSequencePicker([0]), // 抽中忠股
    });

    assert.equal(r.resultUnitId, U.忠);
    assert.equal(r.offsetConsumedFromBin.jinsu, 2);
    assert.equal(r.offsetCarriedOver.jinsu, 0);
    assert.deepEqual(bins.jinsu.carryOverSkips, {});
  });

  test('#6 抵 3 件，籤筒內該股僅剩 1 支 → 扣 1 支，欠籤 = 1', () => {
    const config = freshConfig();
    // 抽出 1 支忠後籤筒剩 [忠, 信, 和]，信=刑三、和=刑四，不同庭，不會干擾補籤判斷
    const bins = { jinsu: makeBin([U.忠, U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      offsetCount: 3,
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.offsetConsumedFromBin.jinsu, 1);
    assert.equal(r.offsetCarriedOver.jinsu, 1);
    assert.equal(bins.jinsu.carryOverSkips[U.忠], 1);
    assert.deepEqual(bins.jinsu.tickets, [U.信, U.和]);
    assert.equal(r.refills.length, 0, '剩 2 支且不同庭，不應補籤');
  });

  test('#7 抵 3 件，籤筒內已無該股的籤 → 欠籤 = 2', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      offsetCount: 3,
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.offsetConsumedFromBin.jinsu, 0);
    assert.equal(r.offsetCarriedOver.jinsu, 2);
    assert.equal(bins.jinsu.carryOverSkips[U.忠], 2);
  });

  test('#8 欠籤於下次補籤後被優先扣除', () => {
    const config = freshConfig();
    const bins = {
      jinsu: makeBin([U.信, U.和], { carryOverSkips: { [U.忠]: 2 } }),
      jinzhongsu: makeBin(ALL8),
    };

    // 抽出信股 → 剩 [和] 1 支 → 觸發補籤
    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.resultUnitId, U.信);
    assert.equal(r.refills.length, 1);
    // 補籤放入 8 支（忠僅 1 支），欠籤 2 支只能先扣 1 支
    assert.deepEqual(r.refills[0].carryOverApplied, { [U.忠]: 1 });
    assert.equal(bins.jinsu.carryOverSkips[U.忠], 1, '未扣完的 1 支應續留為欠籤');
    assert.equal(bins.jinsu.tickets.length, 8);
    assert.equal(count(bins.jinsu.tickets)[U.忠], undefined, '忠股的籤已被欠籤扣光');
  });
});

// ════════════════════════════════════════════════════════════════════
//  SPEC-3.6　抵分與補籤的執行順序（最高優先級）
//
//  下列四項共同釘住 R-02 / R-05。任一項失敗即代表演算法有
//  「該補而未補」的瑕疵，不得上線。禁止在重構時停用。
// ════════════════════════════════════════════════════════════════════

describe('SPEC-3.6 抵分與補籤的執行順序（最高優先級，不得停用）', () => {
  test('#9 [SPEC-3.6 情境 B] 抵分扣減後籤筒降至 1 支 → 必須觸發補籤', () => {
    const config = freshConfig();
    // 籤筒 [忠, 忠, 信]，抽中忠股、抵 2 件
    // 順序甲（正確）：抽出 → [忠,信] → 抵分扣 1 支忠 → [信] 1 支 → 補籤 → 9 支
    // 順序乙（錯誤）：抽出 → [忠,信] → 補籤檢查（2 支不同庭，不補）→ 抵分 → [信] 停在 1 支
    const bins = { jinsu: makeBin([U.忠, U.忠, U.信]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      offsetCount: 2,
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.resultUnitId, U.忠);
    assert.equal(r.offsetConsumedFromBin.jinsu, 1);
    assert.equal(r.refills.length, 1, '抵分扣減使籤筒剩 1 支，必須補籤');
    assert.equal(bins.jinsu.tickets.length, 9);

    assert.notEqual(
      bins.jinsu.tickets.length, 1,
      '順序錯置：籤筒停在 1 支，下一件案件的承辦股將是 100% 確定（SPEC §3.6 情境 B）'
    );
    assertRefillInvariant(bins.jinsu, config, '#9');
  });

  test('#9b [SPEC-3.6 情境 C] 不得繞過「剩 2 支同庭」規則', () => {
    const config = freshConfig();
    // 籤筒 [忠, 忠, 孝, 孝]（忠孝同屬刑一庭），抽中忠股、抵 3 件
    // 順序甲（正確）：抽出 → [忠,孝,孝] → 抵分扣 1 支忠 → [孝,孝] 同庭 → 補籤 → 9 支
    // 順序乙（錯誤）：抽出 → [忠,孝,孝] → 補籤檢查（3 支，不補）→ 抵分 → 停在 [孝,孝]
    const bins = { jinsu: makeBin([U.忠, U.忠, U.孝, U.孝]), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      offsetCount: 3,
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.resultUnitId, U.忠);
    assert.equal(r.offsetConsumedFromBin.jinsu, 1);
    assert.equal(r.offsetCarriedOver.jinsu, 1);

    assert.notDeepEqual(
      bins.jinsu.tickets, [U.孝, U.孝],
      '順序錯置：籤筒停在 [孝,孝]，接下來連續兩件必然皆為孝股，' +
      '且「剩 2 支同庭即補籤」的防護規則被完全繞過（SPEC §3.6 情境 C）'
    );

    assert.equal(r.refills.length, 1);
    assert.equal(bins.jinsu.tickets.length, 9);
    assert.deepEqual(bins.jinsu.carryOverSkips, {}, '欠籤 1 支應於補籤時扣清');
    assertRefillInvariant(bins.jinsu, config, '#9b');
  });

  test('#9c [SPEC-3.6 情境 A] 籤筒狀態相同時，仍須以紀錄語意區辨執行順序', () => {
    const config = freshConfig();
    // 籤筒 [忠, 信]，抽中忠股、抵 3 件
    // 兩種順序的籤筒最終狀態皆為 8 支、忠欠 1，故「只斷言籤筒」抓不到錯誤。
    const bins = { jinsu: makeBin([U.忠, U.信], { cycle: 5 }), jinzhongsu: makeBin(ALL8) };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      offsetCount: 3,
      pick: makeSequencePicker([0]),
    });

    // 關鍵斷言：抵分發生在補籤之前，故當時籤筒內已無忠籤 → 全額記為欠籤
    assert.equal(
      r.offsetConsumedFromBin.jinsu, 0,
      '順序錯置：補籤先執行，抵分吃到了新投入的籤，consumed 會變成 1'
    );
    assert.equal(
      r.offsetCarriedOver.jinsu, 2,
      '順序錯置：carriedOver 會變成 1'
    );

    // 抵分歸屬於補籤前的輪次
    assert.equal(r.cycleBefore, 5, '抵分應歸屬於補籤前的舊輪次');
    assert.equal(r.refills[0].cycleAfter, 6);

    // 籤筒最終狀態（兩種順序相同，僅作佐證）
    assert.equal(bins.jinsu.tickets.length, 8);
    assert.equal(bins.jinsu.carryOverSkips[U.忠], 1);
    assertRefillInvariant(bins.jinsu, config, '#9c');
  });

  test('#10 補籤後扣除欠籤使籤筒再度低於門檻 → 連鎖補籤', () => {
    const config = freshConfig();
    // 籤筒 [忠, 平]，欠籤合計 7 支。抽出忠股後剩 1 支 → 補籤 → 9 支
    // → 扣欠籤 7 支 → 剩 [忠, 孝]（皆刑一庭）→ 必須再補一次
    const bins = {
      jinsu: makeBin([U.忠, U.平], {
        carryOverSkips: {
          [U.仁]: 1, [U.愛]: 1, [U.信]: 1, [U.義]: 1, [U.和]: 1, [U.平]: 2,
        },
      }),
      jinzhongsu: makeBin(ALL8),
    };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinsu',
      pick: makeSequencePicker([0]), // 抽中忠股
    });

    assert.equal(r.resultUnitId, U.忠);
    assert.equal(r.refills.length, 2, '應發生連鎖補籤');
    assert.equal(r.refills[0].reason, 'threshold');
    assert.equal(r.refills[1].reason, 'chained');
    assert.deepEqual(bins.jinsu.carryOverSkips, {});
    assertRefillInvariant(bins.jinsu, config, '#10');
  });

  test('#10b [性質測試] 一萬次隨機抽籤，補籤不變量恆成立', () => {
    const config = freshConfig();
    const pick = makeSeededPicker('invariant-property-test');
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };

    let itemSeq = 0;
    for (let i = 0; i < 10000; i++) {
      const caseTypeId = i % 3 === 0 ? 'jinzhongsu' : 'jinsu';

      // 隨機抵分 1～4 件
      const offsetCount = 1 + (pick(4, itemSeq++) | 0);

      // 有 15% 機率隨機迴避 1～2 個股
      const excluded = [];
      if (pick(100, itemSeq++) < 15) {
        excluded.push(ALL8[pick(8, itemSeq++)]);
        if (pick(2, itemSeq++) === 0) excluded.push(ALL8[pick(8, itemSeq++)]);
      }

      drawOnce({
        config, bins, caseTypeId,
        offsetCount,
        excludedUnitIds: [...new Set(excluded)],
        pick,
        itemSeq: itemSeq++,
      });

      assertRefillInvariant(bins.jinsu, config, `#10b 第 ${i} 次（金訴）`);
      assertRefillInvariant(bins.jinzhongsu, config, `#10b 第 ${i} 次（金重訴）`);
    }
  });
});

describe('抵分範圍與上限（SPEC §14 測試 11～12）', () => {
  test('#11 抵分範圍指定跨案類 → 另一案類籤筒亦正確扣減並各自跑補籤檢查', () => {
    const config = freshConfig();
    const bins = {
      jinzhongsu: makeBin([U.忠, U.忠, U.信, U.和]),
      jinsu: makeBin([U.忠, U.忠, U.忠, U.仁, U.信, U.和]),
    };

    const r = drawOnce({
      config, bins, caseTypeId: 'jinzhongsu',
      offsetCount: 3,
      offsetMap: { jinzhongsu: 2, jinsu: 2 }, // 同時扣減兩個籤筒
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.resultUnitId, U.忠);
    // 金重訴：抽出 1 支後剩 [忠,信,和]，扣 1 支忠 → 欠 1
    assert.equal(r.offsetConsumedFromBin.jinzhongsu, 1);
    assert.equal(r.offsetCarriedOver.jinzhongsu, 1);
    // 金訴：籤筒內有 3 支忠，扣 2 支，欠 0
    assert.equal(r.offsetConsumedFromBin.jinsu, 2);
    assert.equal(r.offsetCarriedOver.jinsu, 0);
    assert.equal(count(bins.jinsu.tickets)[U.忠], 1);

    assertRefillInvariant(bins.jinsu, config, '#11 金訴');
    assertRefillInvariant(bins.jinzhongsu, config, '#11 金重訴');
  });

  test('#11b 未指定 offsetMap 時，預設僅作用於本案類', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };

    drawOnce({ config, bins, caseTypeId: 'jinsu', offsetCount: 3, pick: makeSequencePicker([0]) });

    assert.deepEqual(bins.jinzhongsu.tickets, ALL8, '金重訴籤筒不應受影響');
    assert.deepEqual(bins.jinzhongsu.carryOverSkips, {});
  });

  test('#12 抵分數超過 maxOffsetPerCase → 拒絕', () => {
    const config = freshConfig();
    const bins = makeBins({});

    assert.throws(
      () => drawOnce({ config, bins, caseTypeId: 'jinsu', offsetCount: 11, pick: makeSequencePicker([0]) }),
      (e) => e instanceof LotteryError && e.code === ERR.OFFSET_TOO_LARGE
    );
    assert.deepEqual(bins.jinsu.tickets, ALL8, '拒絕時籤筒不得被異動');
  });

  test('#12b 抵分數非正整數 → 拒絕', () => {
    const config = freshConfig();
    const bins = makeBins({});
    for (const bad of [0, -1, 1.5]) {
      assert.throws(
        () => drawOnce({ config, bins, caseTypeId: 'jinsu', offsetCount: bad, pick: makeSequencePicker([0]) }),
        (e) => e instanceof LotteryError
      );
    }
  });
});
