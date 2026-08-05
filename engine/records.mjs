/**
 * 紀錄產生與雜湊鏈
 * SPEC.md §6.3～§6.5
 *
 * 歷史紀錄只增不刪，每筆以 prevRecordHash 指向前一筆，形成雜湊鏈。
 * 任何一筆遭竄改，其後所有紀錄的驗證都會失敗，且能精確指出斷裂位置。
 */

import { hashObject } from './hash.mjs';
import { LotteryError, ERR } from './errors.mjs';

export const RECORD_TYPES = [
  'DRAW', 'REDRAW', 'AMEND', 'OFFSET_AMEND', 'VOID',
  'CONFIG_CHANGE', 'BIN_ADJUST', 'OFFLINE_BACKFILL', 'DENIED',
];

/** 紀錄編號：R-000128 */
export function makeRecordId(seq) {
  return 'R-' + String(seq).padStart(6, '0');
}

/** 批次編號：B-000042 */
export function makeBatchId(seq) {
  return 'B-' + String(seq).padStart(6, '0');
}

/**
 * 封緘紀錄：接上雜湊鏈並計算本筆雜湊。
 * 必須是寫入歷史前的最後一個動作。
 */
export function sealRecord(record, prevRecordHash) {
  const sealed = { ...record, prevRecordHash: prevRecordHash ?? null };
  delete sealed.recordHash;
  sealed.recordHash = hashObject(sealed);
  return sealed;
}

/** 由抽籤結果組成 DRAW 紀錄（SPEC §6.5） */
export function buildDrawRecord({
  seq, at, operator, workflowRunUrl, batchId, caseNo, note = '',
  caseTypeName, result, drand = null, commitPayloadHash = null,
  requesterUnitId = null, requesterUnitName = null,
}) {
  return {
    recordId: makeRecordId(seq),
    type: 'DRAW',
    seq,
    at,
    operator,
    workflowRunUrl: workflowRunUrl ?? null,

    batchId: batchId ?? null,
    itemSeq: result.itemSeq ?? 0,
    caseTypeId: result.caseTypeId,
    caseTypeName,
    caseNo,
    note,

    // 承辦股：案件的承辦單位，需要支援。與抽出的支援股是兩組不相交的名單。
    requesterUnitId: requesterUnitId ?? result.requesterUnitId ?? null,
    requesterUnitName: requesterUnitName ?? result.requesterUnitName ?? null,

    offsetCount: result.offsetCount,
    offsetMap: result.offsetMap,
    excludedUnitIds: result.excludedUnitIds,
    excludeReason: result.excludeReason ?? '',

    binBefore: result.binBefore,
    binBeforeHash: hashObject({ tickets: result.binBefore }),
    cycleBefore: result.cycleBefore,
    binsBefore: result.binsBefore,
    drawable: result.drawable,
    drawableCount: result.drawableCount,

    commitPayloadHash,
    drand,
    pickIndex: result.pickIndex,

    resultUnitId: result.resultUnitId,
    resultUnitName: result.resultUnitName,
    resultCourtId: result.resultCourtId,
    resultCourtName: result.resultCourtName,

    offsetConsumedFromBin: result.offsetConsumedFromBin,
    offsetCarriedOver: result.offsetCarriedOver,
    refills: result.refills,

    binAfter: result.binAfter,
    binAfterHash: hashObject({ tickets: result.binAfter }),
    cycleAfter: result.cycleAfter,
    binsAfter: result.binsAfter,

    voided: false,
  };
}

/** 產生非抽籤類的稽核紀錄（AMEND / VOID / CONFIG_CHANGE / DENIED 等） */
export function buildAuditRecord({ seq, type, at, operator, workflowRunUrl, payload }) {
  if (!RECORD_TYPES.includes(type)) {
    throw new LotteryError(ERR.CHAIN_BROKEN, `未知的紀錄類型：${type}`);
  }
  return {
    recordId: makeRecordId(seq),
    type,
    seq,
    at,
    operator,
    workflowRunUrl: workflowRunUrl ?? null,
    ...payload,
  };
}

/**
 * 驗證整條雜湊鏈。
 * @returns {{ok: boolean, brokenAt: number|null, reason: string|null}}
 */
export function verifyChain(records) {
  let prev = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];

    const expected = hashObject(r, ['recordHash']);
    if (r.recordHash !== expected) {
      return {
        ok: false,
        brokenAt: i,
        recordId: r.recordId,
        reason: `第 ${i + 1} 筆（${r.recordId}）內容遭竄改：` +
          `紀錄的雜湊為 ${r.recordHash}，重算結果為 ${expected}`,
      };
    }

    if (r.prevRecordHash !== prev) {
      return {
        ok: false,
        brokenAt: i,
        recordId: r.recordId,
        reason: `第 ${i + 1} 筆（${r.recordId}）的雜湊鏈斷裂：` +
          `prevRecordHash 為 ${r.prevRecordHash}，應為 ${prev}`,
      };
    }

    if (i > 0 && r.seq <= records[i - 1].seq) {
      return {
        ok: false,
        brokenAt: i,
        recordId: r.recordId,
        reason: `第 ${i + 1} 筆（${r.recordId}）的序號 ${r.seq} 未遞增`,
      };
    }

    prev = r.recordHash;
  }
  return { ok: true, brokenAt: null, reason: null };
}

/** 讀取 JSONL */
export function parseJsonl(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new LotteryError(ERR.CHAIN_BROKEN, `history.jsonl 第 ${i + 1} 行不是合法 JSON`);
      }
    });
}

/** 寫出 JSONL（每筆一行，正規化前的原樣輸出） */
export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
