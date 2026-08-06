/**
 * 更正、作廢與重抽
 * SPEC.md §7
 *
 * 四種機制界線分明：
 *   AMEND         案號、備註打錯       → 不動籤筒
 *   OFFSET_AMEND  抵分數填錯           → 只調籤筒，支援股不變
 *   VOID          整筆不應存在         → 完全回復籤筒
 *   REDRAW        抽中後才發現應迴避   → 回復後重抽
 */

import { deductOffset, refillLoop, normalizeBin, drawOnce } from './lottery.mjs';
import { LotteryError, ERR } from './errors.mjs';

/** 可用 AMEND 更正的欄位（皆不影響籤筒狀態，SPEC §7.2） */
export const AMENDABLE_FIELDS = ['caseNo', 'note', 'excludeReason'];

/** 籤筒狀態的比較用摘要 */
function binFingerprint(bin) {
  return JSON.stringify({
    t: bin.tickets,
    c: bin.cycle,
    o: Object.fromEntries(Object.entries(bin.carryOverSkips ?? {}).sort()),
  });
}

/**
 * 檢查某筆抽籤的效果是否仍原封不動地留在籤筒上。
 * VOID 與 REDRAW 皆以此為前提（SPEC §7.4）：作廢就是把籤筒回復到該次抽籤前，
 * 唯有「該次之後籤筒沒有淨變動」時，這樣回復才是正確的。
 *
 * ── 為什麼用狀態比對而非掃描後續紀錄 ─────────────────────────
 *
 * 先前的作法是掃描其後的紀錄，只要有任何一筆動過同一個籤筒就拒絕。
 * 這在批次抽籤後逐筆作廢時會誤判：
 *
 *     R-000004 抽籤 ┐
 *     R-000005 抽籤 ┘ 同一批
 *     R-000006 作廢 R-000005      ← 效果已被回復
 *
 * 此時要作廢 R-000004，舊邏輯看到「後面有 R-000005 這筆 DRAW」就擋下，
 * 但 R-000005 早已作廢、對籤筒不再有任何影響，籤筒其實正好等於
 * R-000004 抽完後的狀態，作廢是安全的。使用者因而卡在「叫我從最新一筆
 * 往回處理，但最新一筆就是它」的死路。
 *
 * 直接比對籤筒現況與該筆的 binsAfter 才是正確的判準：它不必推理紀錄之間
 * 的相互抵銷關係，只問「現在的狀態是不是就是當時的狀態」。
 */
/**
 * 判斷作廢／重抽應採用哪一種模式（SPEC §7.4）。
 *
 * ── 為什麼需要兩種模式 ─────────────────────────────────────
 *
 * 抽籤結果是一條相依鏈：每一次抽籤的結果取決於當時的籤筒，而籤筒取決於
 * 先前所有抽籤。批次抽 5 件時，第 3 件面對的籤筒已含有第 2 件的效果。
 *
 * 因此若要作廢中間某一筆，無法「把籤筒倒回去」——倒回去之後，第 3～5 件
 * 當初面對的籤筒就不存在了，它們的 pickIndex 會指向不同的股。更關鍵的是
 * 承諾—開籤的約束：每次抽籤的亂數綁定在含有 binsBefore 的承諾雜湊上，
 * 籤筒一變，等於拿一份承諾去證明它沒有承諾過的事。
 *
 *   rewind      目標是最近一筆且其後籤筒未變動 → 完整回復，連輪次與欠籤都精確
 *   compensate  其他情況 → 不回溯，只把該次消耗的籤退還至目前籤筒
 *
 * compensate 的正當性：籤筒是公平性的記帳工具。該次作廢代表該股實際上沒有
 * 承擔那件案子，那支籤就該回來；至於回到「當時的位置」或「現在」，對長期
 * 均衡沒有差別。代價是籤筒的演進序列與「該件從未發生」的假想情境不同，
 * 但那個情境本來就無法重現，除非連同後續的合法抽籤一起重抽。
 */
export function voidMode(bins, targetRecord) {
  const after = targetRecord.binsAfter;
  if (!after || Object.keys(after).length === 0) return 'compensate';

  for (const binId of Object.keys(after)) {
    const now = bins[binId];
    if (!now) return 'compensate';
    if (binFingerprint(now) !== binFingerprint(after[binId])) return 'compensate';
  }
  return 'rewind';
}

/** 找出該筆之後仍然生效、且動過同一籤筒的紀錄，供說明用 */
function laterEffectiveRecords(history, targetRecord) {
  const voided = new Set(history.filter((r) => r.type === 'VOID').map((r) => r.targetRecordId));
  const idx = history.findIndex((r) => r.recordId === targetRecord.recordId);
  if (idx === -1) return [];
  const touched = Object.keys(targetRecord.binsAfter ?? {});
  return history.slice(idx + 1).filter((r) => {
    if (!['DRAW', 'REDRAW', 'OFFSET_AMEND', 'BIN_ADJUST', 'OFFLINE_BACKFILL'].includes(r.type)) return false;
    if (voided.has(r.recordId)) return false;
    const t = Object.keys(r.binsBefore ?? (r.caseTypeId ? { [r.caseTypeId]: 1 } : {}));
    return t.some((b) => touched.includes(b));
  });
}

/**
 * 補償式回復：不回溯籤筒，只把該次消耗掉的籤退還至目前籤筒。
 *
 * 只會增加籤數，因此**不需要也不可以執行補籤檢查**——補籤的觸發條件是
 * 籤筒過低，補償只會使其變高。
 *
 * @param {boolean} returnDrawnTicket 是否退還抽出的那支籤。
 *        迴避重抽且設定為「原籤不放回」時為 false，但抵分後果仍須沖銷。
 */
export function applyRedrawCompensation(args) {
  return compensate(args);
}

function compensate({ config, bins, record, returnDrawnTicket = true }) {
  const unitId = record.resultUnitId;
  const unit = config.units.find((u) => u.id === unitId);
  // 已停用的股不該有籤留在籤筒內，故不退還
  const unitActive = unit ? unit.active !== false : false;
  const changes = [];

  if (returnDrawnTicket) {
    const bin = bins[record.caseTypeId];
    if (unitActive) {
      bin.tickets.push(unitId);
      changes.push({ binId: record.caseTypeId, drawnTicketReturned: 1 });
    } else {
      changes.push({
        binId: record.caseTypeId,
        drawnTicketReturned: 0,
        skipped: `${unit ? unit.name : unitId} 已停用，籤不退還`,
      });
    }
  }

  // 沖銷抵分後果。以 offsetMap 的原始扣減量為準：先沖銷尚未消化的欠籤，
  // 其餘退還為實際的籤。如此不論當初是自籤筒扣除、或記為欠籤後於補籤時扣除，
  // 都能正確還原該股應得的支數。
  for (const [binId, extra] of Object.entries(record.offsetMap ?? {})) {
    if (!extra || extra <= 0) continue;
    const bin = bins[binId];
    if (!bin) continue;

    let refund = extra;
    const owed = bin.carryOverSkips[unitId] ?? 0;
    const cancelled = Math.min(owed, refund);
    if (cancelled > 0) {
      const left = owed - cancelled;
      if (left > 0) bin.carryOverSkips[unitId] = left;
      else delete bin.carryOverSkips[unitId];
    }
    refund -= cancelled;

    let returned = 0;
    if (unitActive) {
      for (let i = 0; i < refund; i++) bin.tickets.push(unitId);
      returned = refund;
    }
    changes.push({
      binId, offsetReversed: extra,
      carryOverCancelled: cancelled,
      ticketsReturned: returned,
      ...(unitActive ? {} : { skipped: '該股已停用，籤不退還' }),
    });
  }

  for (const binId of Object.keys(bins)) {
    bins[binId].tickets = normalizeBin(bins[binId].tickets, config);
  }

  return changes;
}

/**
 * AMEND — 更正不影響籤筒的欄位（SPEC §7.2）
 * 原紀錄完全不動，僅新增一筆更正紀錄。
 */
export function buildAmend({ targetRecord, changes, reason }) {
  if (!reason || !String(reason).trim()) {
    throw new LotteryError(ERR.CHAIN_BROKEN, 'AMEND 必須填寫更正理由');
  }
  const bad = Object.keys(changes).filter((k) => !AMENDABLE_FIELDS.includes(k));
  if (bad.length > 0) {
    throw new LotteryError(
      ERR.CHAIN_BROKEN,
      `欄位 ${bad.join('、')} 會影響籤筒狀態，不得使用 AMEND。` +
        `抵分數請用 OFFSET_AMEND，整筆錯誤請用 VOID（SPEC §7.1）`
    );
  }
  return {
    targetRecordId: targetRecord.recordId,
    reason: String(reason),
    changes: Object.fromEntries(
      Object.keys(changes).map((k) => [k, { from: targetRecord[k] ?? null, to: changes[k] }])
    ),
  };
}

/**
 * OFFSET_AMEND — 更正抵分數（SPEC §7.3）
 * 支援股與抽籤結果不變，僅調整抵分後果。
 *
 *   增加：對差額比照抵分扣減（籤筒優先、不足記欠籤），再跑補籤檢查
 *   減少：先沖銷欠籤，仍有餘額則退還籤；不執行補籤檢查（籤數只會增加）
 */
export function applyOffsetAmend({ config, bins, targetRecord, newOffsetCount, newOffsetMap, reason }) {
  if (!reason || !String(reason).trim()) {
    throw new LotteryError(ERR.CHAIN_BROKEN, 'OFFSET_AMEND 必須填寫更正理由');
  }
  const maxOffset = config.rules.maxOffsetPerCase ?? 10;
  if (newOffsetCount != null && (newOffsetCount < 1 || newOffsetCount > maxOffset)) {
    throw new LotteryError(ERR.OFFSET_TOO_LARGE, `抵分件數必須介於 1 與 ${maxOffset} 之間`);
  }

  const unitId = targetRecord.resultUnitId;
  const oldMap = targetRecord.offsetMap ?? {};
  const nextMap = newOffsetMap ?? { [targetRecord.caseTypeId]: (newOffsetCount ?? 1) - 1 };

  const touched = new Set([...Object.keys(oldMap), ...Object.keys(nextMap)]);
  const changes = [];
  const refills = [];

  for (const binId of touched) {
    const bin = bins[binId];
    if (!bin) throw new LotteryError(ERR.UNKNOWN_CASETYPE, `案類不存在：${binId}`);

    const before = oldMap[binId] ?? 0;
    const after = nextMap[binId] ?? 0;
    const delta = after - before;
    if (delta === 0) continue;

    if (delta > 0) {
      // 抵分增加：比照 SPEC §3.3 步驟 3
      const r = deductOffset(bin, unitId, delta);
      changes.push({ binId, delta, consumed: r.consumed, carriedOver: r.carriedOver });
    } else {
      // 抵分減少：先沖銷欠籤，再退還籤
      let refund = -delta;
      const owed = bin.carryOverSkips[unitId] ?? 0;
      const cancelled = Math.min(owed, refund);
      if (cancelled > 0) {
        const left = owed - cancelled;
        if (left > 0) bin.carryOverSkips[unitId] = left;
        else delete bin.carryOverSkips[unitId];
      }
      refund -= cancelled;
      for (let i = 0; i < refund; i++) bin.tickets.push(unitId);
      bin.tickets = normalizeBin(bin.tickets, config);
      changes.push({ binId, delta, cancelledCarryOver: cancelled, ticketsReturned: refund });
    }
  }

  // 只有「抵分增加」的籤筒需要補籤檢查（減少只會使籤數增加）
  for (const binId of touched) {
    if ((nextMap[binId] ?? 0) > (oldMap[binId] ?? 0)) {
      refills.push(...refillLoop(bins[binId], config, binId, 'offset-amend'));
    }
  }

  return {
    targetRecordId: targetRecord.recordId,
    reason: String(reason),
    offsetCountFrom: targetRecord.offsetCount,
    offsetCountTo: newOffsetCount ?? targetRecord.offsetCount,
    offsetMapFrom: oldMap,
    offsetMapTo: nextMap,
    changes,
    refills,
    binsAfter: Object.fromEntries(
      [...touched].map((id) => [
        id,
        { tickets: bins[id].tickets.slice(), cycle: bins[id].cycle, carryOverSkips: { ...bins[id].carryOverSkips } },
      ])
    ),
  };
}

/**
 * VOID — 作廢整筆抽籤並完全回復籤筒（SPEC §7.4）
 * 僅能作廢該籤筒最近一筆且其後未再變動的紀錄。
 */
export function applyVoid({ config, bins, history = [], targetRecord, reason }) {
  if (!reason || !String(reason).trim()) {
    throw new LotteryError(ERR.CHAIN_BROKEN, 'VOID 必須填寫作廢理由');
  }
  if (targetRecord.voided || history.some((r) => r.type === 'VOID' && r.targetRecordId === targetRecord.recordId)) {
    throw new LotteryError(ERR.VOID_NOT_LATEST, `紀錄 ${targetRecord.recordId} 已作廢`);
  }
  if (!config) {
    throw new LotteryError(ERR.CHAIN_BROKEN, 'applyVoid 需要 config 以判斷股別是否仍在職');
  }

  const mode = voidMode(bins, targetRecord);
  const touched = Object.keys(targetRecord.binsAfter ?? targetRecord.binsBefore ?? {});
  const before = Object.fromEntries(touched.map((id) => [id, bins[id]?.tickets.length ?? 0]));

  let changes = [];
  if (mode === 'rewind') {
    for (const binId of Object.keys(targetRecord.binsBefore)) {
      const snap = targetRecord.binsBefore[binId];
      bins[binId].tickets = snap.tickets.slice();
      bins[binId].cycle = snap.cycle;
      bins[binId].carryOverSkips = { ...snap.carryOverSkips };
      changes.push({ binId, rewoundTo: snap.tickets.length, cycle: snap.cycle });
    }
  } else {
    changes = compensate({ config, bins, record: targetRecord });
  }

  const later = mode === 'compensate' ? laterEffectiveRecords(history, targetRecord) : [];

  return {
    targetRecordId: targetRecord.recordId,
    reason: String(reason),
    mode,
    // 兩種模式的語意不同，紀錄中必須明確區分，否則第三人無從判斷
    // 目前籤筒狀態的由來
    modeNote: mode === 'rewind'
      ? '籤筒已完整回復至該次抽籤之前（籤數、輪次、抵分欠籤）'
      : `籤筒未回溯，僅將該次消耗的籤退還至目前籤筒；其後 ${later.length} 筆仍生效的抽籤不受影響`,
    unaffectedLaterRecords: later.map((r) => r.recordId),
    changes,
    restoredBins: touched,
    ticketsBefore: before,
    binsAfter: Object.fromEntries(
      touched.filter((id) => bins[id]).map((id) => [
        id,
        { tickets: bins[id].tickets.slice(), cycle: bins[id].cycle, carryOverSkips: { ...bins[id].carryOverSkips } },
      ])
    ),
  };
}

/**
 * REDRAW — 抽後迴避重抽（SPEC §7.5）
 *
 * 實作方式：完全回復至原次抽籤前的狀態，再以新的亂數重抽，並將迴避股排除。
 * 相較於「逐項沖銷抵分後果」，完全回復可證明正確且不受原次補籤影響。
 *
 * rules.redrawReturnsTicket
 *   true （預設）：原籤放回。迴避者未實際受分案，應回復其受分機會。
 *   false        ：原籤不放回，該股本輪視為已輪畢。
 */
export function applyRedraw({
  config, bins, history, originalRecord, recusedUnitId, recuseReason, pick, itemSeq = 0,
}) {
  if (!recuseReason || !String(recuseReason).trim()) {
    throw new LotteryError(ERR.CHAIN_BROKEN, 'REDRAW 必須填寫迴避理由');
  }
  if (recusedUnitId !== originalRecord.resultUnitId) {
    throw new LotteryError(
      ERR.UNKNOWN_UNIT,
      `迴避股 ${recusedUnitId} 與原抽籤結果 ${originalRecord.resultUnitId} 不符`
    );
  }
  const returnsTicket = config.rules.redrawReturnsTicket !== false;
  const mode = voidMode(bins, originalRecord);
  const preRefills = [];

  if (mode === 'rewind') {
    // 1. 回復至原次抽籤前的狀態
    for (const binId of Object.keys(originalRecord.binsBefore)) {
      const snap = originalRecord.binsBefore[binId];
      bins[binId].tickets = snap.tickets.slice();
      bins[binId].cycle = snap.cycle;
      bins[binId].carryOverSkips = { ...snap.carryOverSkips };
    }
    // 2. 依設定決定原籤是否放回
    if (!returnsTicket) {
      const bin = bins[originalRecord.caseTypeId];
      const idx = bin.tickets.indexOf(recusedUnitId);
      if (idx !== -1) bin.tickets.splice(idx, 1);
      preRefills.push(...refillLoop(bin, config, originalRecord.caseTypeId, 'redraw-no-return'));
    }
  } else {
    // 中間某筆的重抽：不回溯籤筒，只沖銷該次的效果（SPEC §7.4）。
    // returnDrawnTicket 直接對應 redrawReturnsTicket——迴避者未實際受分案時
    // 應回復其受分機會，設定為不放回時則僅沖銷抵分。
    compensate({ config, bins, record: originalRecord, returnDrawnTicket: returnsTicket });
  }

  // 3. 排除該股重抽
  const excluded = [...new Set([...(originalRecord.excludedUnitIds ?? []), recusedUnitId])];
  const result = drawOnce({
    config, bins,
    caseTypeId: originalRecord.caseTypeId,
    excludedUnitIds: excluded,
    offsetCount: originalRecord.offsetCount,
    offsetMap: originalRecord.offsetMap,
    pick, itemSeq,
  });

  return {
    originalRecordId: originalRecord.recordId,
    recusedUnitId,
    recuseReason: String(recuseReason),
    ticketReturned: returnsTicket,
    mode,
    modeNote: mode === 'rewind'
      ? '籤筒已回復至原次抽籤之前後重抽'
      : '籤筒未回溯，僅沖銷原次的效果後以目前籤筒重抽；其後仍生效的抽籤不受影響',
    preRefills,
    result,
  };
}
