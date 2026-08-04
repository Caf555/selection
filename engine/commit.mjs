/**
 * 兩階段「承諾—開籤」
 * SPEC.md §4.2
 *
 * ── 這個流程要防的是什麼 ─────────────────────────────────────
 *
 * 如果抽籤是「按下去 → 立刻算出結果 → 決定要不要存檔」，那麼操作者可以
 * 反覆嘗試直到抽到滿意的結果，而歷史紀錄上完全看不出來。
 *
 * 兩階段流程讓這件事在技術上不可能：
 *
 *   階段一（承諾）先把「要抽哪些案、用哪一輪亂數」寫進 git 並推送。
 *              此時目標輪次的亂數**尚未產生**，任何人都無法預知結果。
 *   階段二（開籤）等該輪亂數出現後才推導結果。
 *
 * 承諾一旦推送，抽籤標的與亂數來源就同時固定了。想換結果只能換一個輪次，
 * 而那會在 git 歷史留下一筆孤兒承諾 —— 這正是稽核時要找的東西。
 *
 * 因此：**承諾階段的推送失敗時絕不可略過而直接開籤。**
 */

import { hashObject } from './hash.mjs';
import { makePicker } from './random.mjs';
import { drawBatch } from './lottery.mjs';
import { LotteryError, ERR } from './errors.mjs';

/**
 * 建立承諾酬載。
 *
 * 內容涵蓋所有會影響結果的因素，任一項在開籤前被更動，
 * commitPayloadHash 就會改變，開籤推導出的結果也會完全不同。
 */
/**
 * @param {object} [extra] 額外併入酬載的欄位。
 *   迴避重抽用它承載 redraw 區塊與「承諾當下的籤筒雜湊」，
 *   使這些資訊同樣在亂數產生前就被固定，不能事後更動。
 */
export function buildCommitPayload({
  config, bins, caseTypeId, items, operator, targetRound, batchId, at, extra = {},
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new LotteryError(ERR.CHAIN_BROKEN, '承諾酬載必須至少包含一件案件');
  }

  // 承諾階段就把可能被異動的籤筒全部快照。
  // 若只快照本案類，跨案類抵分的另一個籤筒就成了開籤時才決定的變數。
  const touched = new Set([caseTypeId]);
  for (const it of items) {
    for (const b of Object.keys(it.offsetMap ?? {})) touched.add(b);
  }

  const binsBefore = {};
  for (const binId of [...touched].sort()) {
    if (!bins[binId]) throw new LotteryError(ERR.UNKNOWN_CASETYPE, `案類不存在：${binId}`);
    binsBefore[binId] = {
      tickets: bins[binId].tickets.slice(),
      cycle: bins[binId].cycle,
      carryOverSkips: { ...bins[binId].carryOverSkips },
    };
  }

  return {
    batchId,
    at,
    operator,
    caseTypeId,
    items: items.map((it, i) => ({
      itemSeq: i,
      caseNo: String(it.caseNo),
      offsetCount: it.offsetCount ?? 1,
      offsetMap: it.offsetMap ?? null,
      excludedUnitIds: (it.excludedUnitIds ?? []).slice().sort(),
      excludeReason: it.excludeReason ?? '',
      note: it.note ?? '',
    })),
    binsBefore,
    // 股別名單與規則也會影響結果，一併納入承諾
    configHash: hashObject({
      units: config.units,
      courts: config.courts,
      caseTypes: config.caseTypes,
      rules: config.rules,
    }),
    drand: {
      chainHash: config.drand.chainHash,
      targetRound,
    },
    ...extra,
  };
}

/** 籤筒集合的雜湊，用於確認狀態在承諾與開籤之間未被更動 */
export function binsHash(bins, binIds = null) {
  const ids = (binIds ?? Object.keys(bins)).slice().sort();
  return hashObject(
    Object.fromEntries(
      ids.map((id) => [
        id,
        { t: bins[id].tickets, c: bins[id].cycle, o: bins[id].carryOverSkips },
      ])
    )
  );
}

export function commitPayloadHash(payload) {
  return hashObject(payload);
}

/**
 * 開籤：以目標輪次的亂數推導全部結果。
 *
 * 呼叫前必須確認：
 *   1. 承諾酬載已成功推送（階段一完成）
 *   2. drandResult 的輪次確實等於承諾的 targetRound
 *   3. drandResult 已通過 engine/drand.mjs 的第一層驗證
 */
export function executeReveal({ config, bins, payload, drandResult }) {
  if (drandResult.round !== payload.drand.targetRound) {
    throw new LotteryError(
      ERR.CHAIN_BROKEN,
      `開籤使用的輪次 ${drandResult.round} 與承諾的 ${payload.drand.targetRound} 不符。` +
        `這會使承諾階段失去意義，流程中止。`
    );
  }
  if (drandResult.chainHash !== payload.drand.chainHash) {
    throw new LotteryError(
      ERR.CHAIN_BROKEN,
      `開籤使用的鏈雜湊與承諾的不符，流程中止。`
    );
  }

  // 開籤前重新確認籤筒仍與承諾當時一致。
  // 若中間有人動過籤筒，先前的承諾就不再對應現在的狀態。
  for (const binId of Object.keys(payload.binsBefore)) {
    const snap = payload.binsBefore[binId];
    const now = bins[binId];
    if (!now || hashObject({ t: snap.tickets, c: snap.cycle, o: snap.carryOverSkips })
              !== hashObject({ t: now.tickets, c: now.cycle, o: now.carryOverSkips })) {
      throw new LotteryError(
        ERR.STATE_HASH_MISMATCH,
        `籤筒 ${binId} 在承諾之後遭到變動，開籤中止。\n` +
          `  承諾時 ${snap.tickets.length} 支（第 ${snap.cycle} 輪）\n` +
          `  目前   ${now ? now.tickets.length : '(不存在)'} 支`
      );
    }
  }

  const payloadHash = commitPayloadHash(payload);
  const pick = makePicker(drandResult.randomness, payloadHash);

  const results = drawBatch({
    config, bins,
    caseTypeId: payload.caseTypeId,
    items: payload.items.map((it) => ({
      caseNo: it.caseNo,
      offsetCount: it.offsetCount,
      offsetMap: it.offsetMap,
      excludedUnitIds: it.excludedUnitIds,
    })),
    pick,
  });

  return {
    payloadHash,
    results: results.map((r, i) => ({
      ...r,
      caseNo: payload.items[i].caseNo,
      note: payload.items[i].note,
      excludeReason: payload.items[i].excludeReason,
    })),
    drand: {
      chainHash: drandResult.chainHash,
      round: drandResult.round,
      randomness: drandResult.randomness,
      signature: drandResult.signature,
      agreeingEndpoints: drandResult.agreeingEndpoints,
      crossChecked: true,
      signatureVerified: null, // 由第二層 BLS 稽核填寫
    },
  };
}
