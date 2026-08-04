/**
 * 更正、作廢、重抽與雜湊鏈測試
 * SPEC.md §14 測試項目 21～25、30～31、§7
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { drawOnce } from '../lottery.mjs';
import { makeSequencePicker } from '../random.mjs';
import { buildDrawRecord, sealRecord, verifyChain, makeRecordId } from '../records.mjs';
import { buildAmend, applyOffsetAmend, applyVoid, applyRedraw } from '../operations.mjs';
import { LotteryError, ERR } from '../errors.mjs';
import { freshConfig, makeBin, U, ALL8, count, assertRefillInvariant } from './helpers.mjs';

/** 建立一筆已封緘的 DRAW 紀錄 */
function draw(config, bins, opts = {}, seq = 1, prevHash = null) {
  const result = drawOnce({
    config, bins,
    caseTypeId: opts.caseTypeId ?? 'jinsu',
    offsetCount: opts.offsetCount ?? 1,
    offsetMap: opts.offsetMap ?? null,
    excludedUnitIds: opts.excludedUnitIds ?? [],
    pick: makeSequencePicker([opts.pickIndex ?? 0]),
  });
  const rec = buildDrawRecord({
    seq,
    at: '2026-08-04T09:00:00+08:00',
    operator: 'github:test',
    caseNo: opts.caseNo ?? `115年度金訴字第${String(seq).padStart(3, '0')}號`,
    caseTypeName: '金訴',
    result,
  });
  return sealRecord(rec, prevHash);
}

describe('更正與作廢（SPEC §14 測試 21～25）', () => {
  test('#21 AMEND 不改變籤筒狀態', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins);
    const before = bins.jinsu.tickets.slice();

    const amend = buildAmend({
      targetRecord: rec,
      changes: { caseNo: '115年度金訴字第999號' },
      reason: '案號誤繕',
    });

    assert.deepEqual(bins.jinsu.tickets, before, 'AMEND 不得異動籤筒');
    assert.equal(amend.changes.caseNo.from, '115年度金訴字第001號');
    assert.equal(amend.changes.caseNo.to, '115年度金訴字第999號');
  });

  test('#21b AMEND 不得用於會影響籤筒的欄位', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins);

    assert.throws(
      () => buildAmend({ targetRecord: rec, changes: { offsetCount: 3 }, reason: '填錯' }),
      /OFFSET_AMEND/
    );
    assert.throws(
      () => buildAmend({ targetRecord: rec, changes: { resultUnitId: U.信 }, reason: '改承辦股' }),
      /VOID/
    );
  });

  test('#21c AMEND 未填理由 → 拒絕', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins);
    assert.throws(() => buildAmend({ targetRecord: rec, changes: { note: 'x' }, reason: '  ' }));
  });

  test('#22 OFFSET_AMEND 增加抵分 → 正確補扣', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins, { offsetCount: 1 }); // 抽中忠，未抵分

    assert.equal(count(bins.jinsu.tickets)[U.忠], 2);

    const r = applyOffsetAmend({
      config, bins, targetRecord: rec,
      newOffsetCount: 3, // 由抵 1 件改為抵 3 件 → 需再扣 2 支
      reason: '漏填重大案件抵分',
    });

    assert.equal(r.changes[0].delta, 2);
    assert.equal(r.changes[0].consumed, 2);
    assert.equal(r.changes[0].carriedOver, 0);
    assert.equal(count(bins.jinsu.tickets)[U.忠], undefined);
    assertRefillInvariant(bins.jinsu, config, '#22');
  });

  test('#22b OFFSET_AMEND 減少抵分 → 先沖銷欠籤，再退還籤', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins, { offsetCount: 3 }); // 抽中忠，筒內無忠籤 → 欠 2

    assert.equal(bins.jinsu.carryOverSkips[U.忠], 2);

    const r = applyOffsetAmend({
      config, bins, targetRecord: rec,
      newOffsetCount: 1, // 改為不抵分 → 沖銷 2 支欠籤
      reason: '抵分數誤填',
    });

    assert.equal(r.changes[0].delta, -2);
    assert.equal(r.changes[0].cancelledCarryOver, 2);
    assert.equal(r.changes[0].ticketsReturned, 0);
    assert.deepEqual(bins.jinsu.carryOverSkips, {});
    assert.equal(r.refills.length, 0, '抵分減少不應觸發補籤');
  });

  test('#22c OFFSET_AMEND 減少抵分且無欠籤 → 退還籤至籤筒', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins, { offsetCount: 3 }); // 扣 2 支忠，無欠籤

    assert.equal(count(bins.jinsu.tickets)[U.忠], undefined);

    applyOffsetAmend({
      config, bins, targetRecord: rec, newOffsetCount: 1, reason: '更正',
    });

    assert.equal(count(bins.jinsu.tickets)[U.忠], 2, '應退還 2 支忠籤');
  });

  test('#22d OFFSET_AMEND 不改變承辦股', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin([U.忠, U.忠, U.忠, U.信, U.和]), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins, { offsetCount: 1 });

    applyOffsetAmend({ config, bins, targetRecord: rec, newOffsetCount: 3, reason: '更正' });

    assert.equal(rec.resultUnitId, U.忠, '原紀錄的承辦股不得變動');
  });

  test('#23 VOID 最近一筆 → 籤筒完全回復至 binBefore', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const snapshot = {
      tickets: bins.jinsu.tickets.slice(),
      cycle: bins.jinsu.cycle,
      carryOverSkips: { ...bins.jinsu.carryOverSkips },
    };

    const rec = draw(config, bins, { offsetCount: 3 });
    assert.notDeepEqual(bins.jinsu.tickets, snapshot.tickets);

    const r = applyVoid({ bins, history: [rec], targetRecord: rec, reason: '抽錯案類' });

    assert.deepEqual(bins.jinsu.tickets, snapshot.tickets, '籤筒應完全回復');
    assert.equal(bins.jinsu.cycle, snapshot.cycle);
    assert.deepEqual(bins.jinsu.carryOverSkips, snapshot.carryOverSkips);
    assert.deepEqual(r.restoredBins, ['jinsu']);
  });

  test('#23b VOID 跨案類抵分的紀錄 → 兩個籤筒都回復', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const snapJinsu = bins.jinsu.tickets.slice();
    const snapJzs = bins.jinzhongsu.tickets.slice();

    const rec = draw(config, bins, {
      caseTypeId: 'jinzhongsu', offsetCount: 3, offsetMap: { jinzhongsu: 2, jinsu: 2 },
    });
    assert.notDeepEqual(bins.jinsu.tickets, snapJinsu);

    applyVoid({ bins, history: [rec], targetRecord: rec, reason: '登錄錯誤' });

    assert.deepEqual(bins.jinsu.tickets, snapJinsu);
    assert.deepEqual(bins.jinzhongsu.tickets, snapJzs);
  });

  test('#24 VOID 非最近一筆 → 拒絕', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const r1 = draw(config, bins, {}, 1, null);
    const r2 = draw(config, bins, {}, 2, r1.recordHash);

    assert.throws(
      () => applyVoid({ bins, history: [r1, r2], targetRecord: r1, reason: '想跳過作廢' }),
      (e) => e instanceof LotteryError && e.code === ERR.VOID_NOT_LATEST
    );

    // 由最新往回逐筆作廢則可行
    applyVoid({ bins, history: [r1, r2], targetRecord: r2, reason: '先作廢最新一筆' });
    r2.voided = true;
    applyVoid({ bins, history: [r1], targetRecord: r1, reason: '再作廢前一筆' });
    assert.deepEqual(bins.jinsu.tickets, ALL8);
  });

  test('#24b VOID 未填理由或重複作廢 → 拒絕', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins);

    assert.throws(() => applyVoid({ bins, history: [rec], targetRecord: rec, reason: '' }));
    rec.voided = true;
    assert.throws(() => applyVoid({ bins, history: [rec], targetRecord: rec, reason: '再作廢' }));
  });

  test('#25 REDRAW 且 redrawReturnsTicket = true → 原籤放回、抵分沖銷、重抽排除該股', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins, { offsetCount: 3, pickIndex: 0 }); // 抽中忠股

    assert.equal(rec.resultUnitId, U.忠);
    assert.equal(bins.jinsu.carryOverSkips[U.忠], 2);

    const r = applyRedraw({
      config, bins, history: [rec], originalRecord: rec,
      recusedUnitId: U.忠,
      recuseReason: '承辦法官自行迴避',
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.ticketReturned, true);
    assert.notEqual(r.result.resultUnitId, U.忠, '迴避股不得再被抽中');
    assert.equal(r.result.resultUnitId, U.孝);
    assert.ok(r.result.excludedUnitIds.includes(U.忠));
    // 原次抵分後果已隨回復消失，新承辦股才有自己的抵分
    assert.equal(bins.jinsu.carryOverSkips[U.忠], undefined, '原次對忠股的欠籤應已沖銷');
    assert.equal(bins.jinsu.carryOverSkips[U.孝], 2, '新承辦股承受抵分');
    // 忠股的籤已放回，仍在籤筒內
    assert.ok(r.result.binBefore.includes(U.忠));
  });

  test('#25b REDRAW 且 redrawReturnsTicket = false → 原籤不放回', () => {
    const config = freshConfig({ rules: { redrawReturnsTicket: false } });
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins, { pickIndex: 0 });

    const r = applyRedraw({
      config, bins, history: [rec], originalRecord: rec,
      recusedUnitId: U.忠, recuseReason: '迴避',
      pick: makeSequencePicker([0]),
    });

    assert.equal(r.ticketReturned, false);
    assert.ok(!r.result.binBefore.includes(U.忠), '原籤不放回，忠股的籤已撤出');
  });

  test('#25c REDRAW 的迴避股與原結果不符 → 拒絕', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const rec = draw(config, bins, { pickIndex: 0 });

    assert.throws(
      () => applyRedraw({
        config, bins, history: [rec], originalRecord: rec,
        recusedUnitId: U.信, recuseReason: '迴避',
        pick: makeSequencePicker([0]),
      }),
      (e) => e instanceof LotteryError && e.code === ERR.UNKNOWN_UNIT
    );
  });
});

describe('雜湊鏈（SPEC §14 測試 30～31）', () => {
  test('#30 正常歷史 → 雜湊鏈驗證通過', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const history = [];
    let prev = null;
    for (let i = 1; i <= 10; i++) {
      const rec = draw(config, bins, {}, i, prev);
      history.push(rec);
      prev = rec.recordHash;
    }

    const v = verifyChain(history);
    assert.equal(v.ok, true, v.reason ?? '');
  });

  test('#30b 竄改任一筆內容 → 驗證失敗並正確指出位置', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const history = [];
    let prev = null;
    for (let i = 1; i <= 10; i++) {
      const rec = draw(config, bins, {}, i, prev);
      history.push(rec);
      prev = rec.recordHash;
    }

    // 竄改第 5 筆的承辦股
    history[4].resultUnitId = U.平;
    history[4].resultUnitName = '平股';

    const v = verifyChain(history);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 4, '應指出第 5 筆（索引 4）');
    assert.equal(v.recordId, makeRecordId(5));
    assert.match(v.reason, /遭竄改/);
  });

  test('#30c 抽換整筆紀錄（連同重算雜湊）→ 仍因鏈結斷裂而失敗', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const history = [];
    let prev = null;
    for (let i = 1; i <= 6; i++) {
      const rec = draw(config, bins, {}, i, prev);
      history.push(rec);
      prev = rec.recordHash;
    }

    // 攻擊者重算第 3 筆的雜湊，使其自身校驗通過
    history[2].caseNo = '偽造案號';
    history[2] = sealRecord(history[2], history[1].recordHash);
    assert.equal(verifyChain([history[0], history[1], history[2]]).ok, true, '前三筆自身是連續的');

    // 但第 4 筆的 prevRecordHash 仍指向舊值 → 鏈結斷裂
    const v = verifyChain(history);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 3);
    assert.match(v.reason, /雜湊鏈斷裂/);
  });

  test('#31 刪除中間一筆 → 驗證失敗', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const history = [];
    let prev = null;
    for (let i = 1; i <= 6; i++) {
      const rec = draw(config, bins, {}, i, prev);
      history.push(rec);
      prev = rec.recordHash;
    }

    history.splice(2, 1); // 刪掉第 3 筆
    const v = verifyChain(history);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
  });

  test('#31b 序號未遞增 → 驗證失敗', () => {
    const config = freshConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const r1 = draw(config, bins, {}, 5, null);
    const r2 = sealRecord({ ...draw(config, bins, {}, 3, null), prevRecordHash: undefined }, r1.recordHash);

    const v = verifyChain([r1, r2]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /序號/);
  });
});
