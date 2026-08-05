/**
 * 抽籤核心演算法
 * SPEC.md §3（規範來源，實作不得偏離）
 *
 * ════════════════════════════════════════════════════════════════════
 *  執行順序警告（SPEC §3.6）
 *
 *  單次抽籤的內部序列固定為：
 *      抽出 → 抵分扣減（全部受影響案類）→ 補籤檢查（全部受影響案類）→ 產生紀錄
 *
 *  **絕對不可將「抵分扣減」與「補籤檢查」對調。**
 *
 *  對調後果（SPEC §3.6 情境 B / C）：
 *    - 抵分扣減會在補籤檢查之後才發生，使籤筒停在低於門檻的狀態而未補籤
 *    - 極端情況籤筒僅剩 1～2 支，下一件案件的支援股形同「指定」，機率 100%
 *    - 且該次抽籤在 drand 簽章、雜湊鏈、驗證頁上全部顯示「通過」，
 *      沒有任何既有驗證機制會攔下它
 *
 *  在多數情況下兩種順序結果相同，因此此錯誤不會在日常操作中被察覺。
 *  唯一的防線是 engine/test/offset.test.mjs 中標註 SPEC-3.6 的測試。
 *  重構本檔案時請先讀完 SPEC.md §3.6。
 * ════════════════════════════════════════════════════════════════════
 */

import { LotteryError, ERR } from './errors.mjs';

// ─────────────────────────────────────────────────────────────────────
// 設定查詢
// ─────────────────────────────────────────────────────────────────────

export function getUnit(config, unitId) {
  const u = config.units.find((x) => x.id === unitId);
  if (!u) throw new LotteryError(ERR.UNKNOWN_UNIT, `股別不存在：${unitId}`);
  return u;
}

export function courtIdOf(config, unitId) {
  return getUnit(config, unitId).courtId;
}

export function unitName(config, unitId) {
  return getUnit(config, unitId).name;
}

export function courtName(config, courtId) {
  const c = config.courts.find((x) => x.id === courtId);
  return c ? c.name : courtId;
}

export function activeUnits(config) {
  return config.units
    .filter((u) => u.active)
    .slice()
    .sort((a, b) => a.order - b.order);
}

// ─────────────────────────────────────────────────────────────────────
// 籤筒正規化（SPEC §3.2）
// ─────────────────────────────────────────────────────────────────────

/**
 * 依股別 order 遞增排序，同股的多支籤相鄰。
 * 目的：讓「第 k 個位置對應哪一支籤」成為確定值，使第三人能獨立重算抽籤結果。
 * 此排序不影響公平性，因為抽出的位置由不可預測的公共亂數決定。
 */
export function normalizeBin(tickets, config) {
  const order = new Map(config.units.map((u) => [u.id, u.order]));
  return tickets
    .slice()
    .sort((a, b) => {
      const oa = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
      const ob = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

// ─────────────────────────────────────────────────────────────────────
// 補籤（SPEC §3.4）
// ─────────────────────────────────────────────────────────────────────

/**
 * 補籤門檻判斷（SPEC §3.3 步驟 4）
 *   - 籤筒支數 <= refillWhenRemainingAtMost（預設 1）
 *   - 或 支數 == 2 且該 2 支同屬一庭（含同一股的兩支籤，SPEC R-04）
 */
export function needsRefill(bin, config) {
  const n = bin.tickets.length;
  const threshold = config.rules.refillWhenRemainingAtMost ?? 1;

  if (n <= threshold) return true;

  if (config.rules.refillWhenTwoTicketsSameCourt && n === 2) {
    return courtIdOf(config, bin.tickets[0]) === courtIdOf(config, bin.tickets[1]);
  }

  return false;
}

/**
 * 執行一次補籤（SPEC §3.4）
 *   1. 每個在職股依其 ticketsPerCycle 放入籤
 *   2. 立即扣除欠籤
 *   3. 輪次 +1
 *   4. 重新正規化排序
 */
export function refillOnce(bin, config, binId, reason) {
  const units = activeUnits(config);
  if (units.length === 0) {
    throw new LotteryError(ERR.NO_ACTIVE_UNIT, '無任何在職股，無法補籤');
  }

  const added = [];
  for (const u of units) {
    const n = u.ticketsPerCycle ?? 1;
    for (let i = 0; i < n; i++) added.push(u.id);
  }
  bin.tickets = bin.tickets.concat(added);

  // 立即扣除欠籤（SPEC §3.4 步驟 2）
  const carryOverApplied = {};
  for (const unitId of Object.keys(bin.carryOverSkips)) {
    const owed = bin.carryOverSkips[unitId];
    if (!owed || owed <= 0) {
      delete bin.carryOverSkips[unitId];
      continue;
    }
    let removed = 0;
    while (removed < owed) {
      const idx = bin.tickets.indexOf(unitId);
      if (idx === -1) break; // 籤筒內已無該股的籤，餘額續留至下次補籤
      bin.tickets.splice(idx, 1);
      removed++;
    }
    if (removed > 0) carryOverApplied[unitId] = removed;
    const left = owed - removed;
    if (left > 0) bin.carryOverSkips[unitId] = left;
    else delete bin.carryOverSkips[unitId];
  }

  bin.cycle += 1;
  bin.tickets = normalizeBin(bin.tickets, config);

  return {
    binId,
    reason,
    added: added.length,
    carryOverApplied,
    cycleAfter: bin.cycle,
    remainingAfter: bin.tickets.length,
  };
}

/**
 * 補籤檢查迴圈（SPEC §3.3 步驟 4）
 *
 * 必須是迴圈而非單次判斷：補籤後扣除欠籤可能使籤筒再度低於門檻，形成連鎖補籤。
 */
export function refillLoop(bin, config, binId, reason = 'threshold') {
  const out = [];
  const max = config.rules.maxRefillLoops ?? 20;

  while (needsRefill(bin, config)) {
    if (out.length >= max) {
      throw new LotteryError(
        ERR.REFILL_LOOP,
        `補籤迴圈超過上限 ${max} 次，請檢查股別設定（籤筒 ${binId}）`,
        { binId, tickets: bin.tickets.slice() }
      );
    }
    out.push(refillOnce(bin, config, binId, out.length === 0 ? reason : 'chained'));
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 抵分（SPEC §3.3 步驟 3）
// ─────────────────────────────────────────────────────────────────────

/**
 * 對單一籤筒執行抵分扣減。
 *
 * ⚠ SPEC §3.6 實作約束 #1：
 *   **本函式不得呼叫 refillOnce / refillLoop / needsRefill。**
 *   補籤只能由 drawOnce 在所有扣減完成後統一觸發。
 *
 * 「籤筒中還有的籤優先抵分」：先扣籤筒現有的籤，不足額才記為欠籤。
 */
export function deductOffset(bin, unitId, extra) {
  let remaining = extra;
  let consumed = 0;

  while (remaining > 0) {
    const idx = bin.tickets.indexOf(unitId);
    if (idx === -1) break; // 籤筒內已無該股的籤
    bin.tickets.splice(idx, 1);
    consumed++;
    remaining--;
  }

  if (remaining > 0) {
    bin.carryOverSkips[unitId] = (bin.carryOverSkips[unitId] ?? 0) + remaining;
  }

  return { consumed, carriedOver: remaining };
}

// ─────────────────────────────────────────────────────────────────────
// 單次抽籤（SPEC §3.3）
// ─────────────────────────────────────────────────────────────────────

function computeDrawable(tickets, excludedUnitIds) {
  const excluded = new Set(excludedUnitIds);
  const out = [];
  for (let i = 0; i < tickets.length; i++) {
    if (!excluded.has(tickets[i])) out.push({ unitId: tickets[i], binIndex: i });
  }
  return out;
}

/**
 * 執行一次抽籤。會就地修改 bins。
 *
 * @param {object}   args
 * @param {object}   args.config
 * @param {object}   args.bins            全部籤筒 { caseTypeId: {tickets, cycle, carryOverSkips} }
 * @param {string}   args.caseTypeId      本次抽籤的案類
 * @param {string[]} [args.excludedUnitIds] 本次應迴避的股（籤留在筒內，僅本次不可被抽中）
 * @param {number}   [args.offsetCount]   抵 M 件，預設 1
 * @param {object}   [args.offsetMap]     { caseTypeId: 扣減支數 }。未給則預設 { 本案類: M-1 }
 * @param {Function} args.pick            (n, itemSeq) => [0, n) 的均勻整數
 * @param {number}   [args.itemSeq]       批次中的序號，供亂數推導使用
 */
export function drawOnce({
  config,
  bins,
  caseTypeId,
  excludedUnitIds = [],
  offsetCount = 1,
  offsetMap = null,
  pick,
  itemSeq = 0,
}) {
  const bin = bins[caseTypeId];
  if (!bin) throw new LotteryError(ERR.UNKNOWN_CASETYPE, `案類不存在：${caseTypeId}`);

  const maxOffset = config.rules.maxOffsetPerCase ?? 10;
  if (!Number.isInteger(offsetCount) || offsetCount < 1) {
    throw new LotteryError(ERR.OFFSET_TOO_LARGE, `抵分件數必須為 1 以上的整數，收到 ${offsetCount}`);
  }
  if (offsetCount > maxOffset) {
    throw new LotteryError(
      ERR.OFFSET_TOO_LARGE,
      `抵分件數 ${offsetCount} 超過上限 ${maxOffset}（config.rules.maxOffsetPerCase）`
    );
  }

  for (const id of excludedUnitIds) getUnit(config, id); // 驗證股別存在

  // 未指定 offsetMap 時，預設僅作用於本案類（SPEC R-06）
  const effectiveOffsetMap = offsetMap ?? { [caseTypeId]: offsetCount - 1 };
  for (const binId of Object.keys(effectiveOffsetMap)) {
    if (!bins[binId]) throw new LotteryError(ERR.UNKNOWN_CASETYPE, `案類不存在：${binId}`);
  }

  const binBefore = bin.tickets.slice();
  const cycleBefore = bin.cycle;
  const refills = [];

  // 快照全部可能被異動的籤筒，供 VOID 作廢時完整回復（SPEC §7.4）
  const touchedBinIdsUpfront = new Set([caseTypeId, ...Object.keys(effectiveOffsetMap)]);
  const binsBefore = {};
  for (const binId of touchedBinIdsUpfront) {
    binsBefore[binId] = {
      tickets: bins[binId].tickets.slice(),
      cycle: bins[binId].cycle,
      carryOverSkips: { ...bins[binId].carryOverSkips },
    };
  }

  // ── 步驟 1：計算可抽集合 ──────────────────────────────────────────
  //
  // 前置檢查：全部在職股皆迴避 → 補再多次籤也不會有可抽的籤，立即中止。
  const activeIds = activeUnits(config).map((u) => u.id);
  const excludedSet = new Set(excludedUnitIds);
  if (activeIds.length === 0 || activeIds.every((id) => excludedSet.has(id))) {
    throw new LotteryError(ERR.ALL_EXCLUDED, '所有在職股均已迴避，無法抽籤', {
      caseTypeId,
      excludedUnitIds,
    });
  }

  let drawable = computeDrawable(bin.tickets, excludedUnitIds);

  // 籤筒內尚有籤，但全數屬於本次迴避的股 → 補籤後再抽。
  //
  // 須以迴圈處理：當多個股累積欠籤時，補籤放入的籤會立即被欠籤扣除，
  // 剩下的籤可能仍全屬迴避股，補一次並不足夠。
  // 欠籤總額每次補籤必定嚴格遞減（停用股無籤可扣，不會消耗他股的籤），
  // 且已確認至少有一個在職股未被迴避，故此迴圈必定收斂。
  {
    const maxLoops = config.rules.maxRefillLoops ?? 20;
    let guard = 0;
    while (drawable.length === 0) {
      if (guard++ >= maxLoops) {
        throw new LotteryError(
          ERR.EMPTY_BIN,
          `連續補籤 ${maxLoops} 次後仍無可抽的籤，請檢查欠籤與股別設定（籤筒 ${caseTypeId}）`,
          { caseTypeId, excludedUnitIds, carryOverSkips: { ...bin.carryOverSkips } }
        );
      }
      refills.push(refillOnce(bin, config, caseTypeId, 'exclusion-exhausted'));
      refills.push(...refillLoop(bin, config, caseTypeId, 'chained'));
      drawable = computeDrawable(bin.tickets, excludedUnitIds);
    }
  }

  // ── 步驟 2：抽籤 ────────────────────────────────────────────────
  const drawableSnapshot = drawable.map((d) => d.unitId);
  const pickIndex = pick(drawable.length, itemSeq);
  if (!Number.isInteger(pickIndex) || pickIndex < 0 || pickIndex >= drawable.length) {
    throw new LotteryError(ERR.EMPTY_BIN, `抽籤索引 ${pickIndex} 超出範圍 [0, ${drawable.length})`);
  }
  const drawnUnitId = drawable[pickIndex].unitId;
  bin.tickets.splice(drawable[pickIndex].binIndex, 1);

  // ── 步驟 3：抵分扣減 ────────────────────────────────────────────
  //    ⚠ 必須在步驟 4 之前完成。對調將導致 SPEC §3.6 情境 B / C 的瑕疵。
  const touchedBinIds = new Set([caseTypeId]);
  const offsetConsumedFromBin = {};
  const offsetCarriedOver = {};

  for (const binId of Object.keys(effectiveOffsetMap)) {
    const extra = effectiveOffsetMap[binId];
    if (!extra || extra <= 0) continue;
    const r = deductOffset(bins[binId], drawnUnitId, extra);
    offsetConsumedFromBin[binId] = r.consumed;
    offsetCarriedOver[binId] = r.carriedOver;
    touchedBinIds.add(binId);
  }

  // ── 步驟 4：補籤檢查（在所有扣減完成後才執行）──────────────────
  for (const binId of touchedBinIds) {
    refills.push(...refillLoop(bins[binId], config, binId));
  }

  const unit = getUnit(config, drawnUnitId);

  return {
    caseTypeId,
    excludedUnitIds: excludedUnitIds.slice(),
    offsetCount,
    offsetMap: effectiveOffsetMap,

    binBefore,
    cycleBefore,
    binsBefore,
    binsAfter: Object.fromEntries(
      [...touchedBinIds].map((id) => [
        id,
        {
          tickets: bins[id].tickets.slice(),
          cycle: bins[id].cycle,
          carryOverSkips: { ...bins[id].carryOverSkips },
        },
      ])
    ),
    drawable: drawableSnapshot,
    drawableCount: drawableSnapshot.length,
    pickIndex,

    resultUnitId: drawnUnitId,
    resultUnitName: unit.name,
    resultCourtId: unit.courtId,
    resultCourtName: courtName(config, unit.courtId),

    offsetConsumedFromBin,
    offsetCarriedOver,
    refills,

    binAfter: bin.tickets.slice(),
    cycleAfter: bin.cycle,
  };
}

/**
 * 批次抽籤（SPEC §3.7）
 * 逐件依序抽籤，前一件造成的籤筒異動立即影響下一件。
 * 任一件失敗即中止整批，已完成的件不回復。
 */
export function drawBatch({ config, bins, caseTypeId, items, pick }) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const r = drawOnce({
        config,
        bins,
        caseTypeId,
        excludedUnitIds: it.excludedUnitIds ?? [],
        offsetCount: it.offsetCount ?? 1,
        offsetMap: it.offsetMap ?? null,
        pick,
        itemSeq: i,
      });
      results.push({ ...r, caseNo: it.caseNo, itemSeq: i });
    } catch (e) {
      e.details = {
        ...(e.details ?? {}),
        completedCount: results.length,
        failedAtIndex: i,
        failedCaseNo: it.caseNo,
      };
      e.partialResults = results;
      throw e;
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// 股別變動（SPEC R-07：立即生效）
// ─────────────────────────────────────────────────────────────────────

/**
 * 新增股，立即投入其 ticketsPerCycle 支籤至所有籤筒，並執行補籤檢查。
 */
export function addUnit(config, bins, unit) {
  if (config.units.some((u) => u.id === unit.id)) {
    throw new LotteryError(ERR.UNKNOWN_UNIT, `股別 ID 重複：${unit.id}`);
  }
  const newUnit = { ticketsPerCycle: 1, active: true, note: '', ...unit };
  config.units.push(newUnit);
  config.units.sort((a, b) => a.order - b.order);

  const adjustments = [];
  for (const binId of Object.keys(bins)) {
    const bin = bins[binId];
    const n = newUnit.ticketsPerCycle;
    for (let i = 0; i < n; i++) bin.tickets.push(newUnit.id);
    bin.tickets = normalizeBin(bin.tickets, config);
    adjustments.push({
      binId,
      action: 'ADD_UNIT',
      unitId: newUnit.id,
      ticketsAdded: n,
      refills: refillLoop(bin, config, binId, 'bin-adjust'),
      remainingAfter: bin.tickets.length,
    });
  }
  return adjustments;
}

/**
 * 停用股，立即自所有籤筒撤出其全部籤，並執行補籤檢查。
 */
export function deactivateUnit(config, bins, unitId) {
  const u = getUnit(config, unitId);
  u.active = false;

  const adjustments = [];
  for (const binId of Object.keys(bins)) {
    const bin = bins[binId];
    const before = bin.tickets.length;
    bin.tickets = bin.tickets.filter((t) => t !== unitId);
    adjustments.push({
      binId,
      action: 'DEACTIVATE_UNIT',
      unitId,
      ticketsRemoved: before - bin.tickets.length,
      refills: refillLoop(bin, config, binId, 'bin-adjust'),
      remainingAfter: bin.tickets.length,
    });
  }
  return adjustments;
}

/**
 * 修改每輪籤數 N。不影響現有籤筒，自下次補籤起生效（SPEC 測試 #18）。
 */
export function setTicketsPerCycle(config, unitId, n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new LotteryError(ERR.UNKNOWN_UNIT, `每輪籤數必須為 1 以上的整數，收到 ${n}`);
  }
  const u = getUnit(config, unitId);
  const before = u.ticketsPerCycle ?? 1;
  u.ticketsPerCycle = n;
  return { unitId, before, after: n };
}

// ─────────────────────────────────────────────────────────────────────
// 建立初始籤筒
// ─────────────────────────────────────────────────────────────────────

export function createBin(config) {
  const bin = { tickets: [], cycle: 0, carryOverSkips: {} };
  refillOnce(bin, config, null, 'init');
  return bin;
}

export function createAllBins(config) {
  const bins = {};
  for (const ct of config.caseTypes.filter((c) => c.active)) {
    bins[ct.id] = createBin(config);
  }
  return bins;
}

/** 深層複製籤筒集合，供快照與回復使用 */
export function cloneBins(bins) {
  const out = {};
  for (const k of Object.keys(bins)) {
    out[k] = {
      tickets: bins[k].tickets.slice(),
      cycle: bins[k].cycle,
      carryOverSkips: { ...bins[k].carryOverSkips },
    };
  }
  return out;
}
