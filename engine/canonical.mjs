/**
 * RFC 8785 JSON Canonicalization Scheme
 * SPEC.md §5.3
 *
 * 本檔刻意不引用任何 Node.js 專屬模組，使瀏覽器（驗證頁）與 Node.js（抽籤引擎）
 * 執行的是**同一份**正規化程式碼。若兩邊各自實作，驗證頁通過與否就不再具有意義。
 *
 * 規則：
 *   - 物件鍵依 UTF-16 碼元排序（JavaScript 預設字串比較即為此規則）
 *   - 不含任何空白
 *   - 字串轉義依 ECMAScript JSON.stringify（JCS 明定採用此規則）
 *   - 值為 undefined 的鍵一律略去
 *
 * 刻意的限制：**只允許整數**。
 * 本系統的資料全為整數（籤數、輪次、序號），禁止浮點數可完全避開
 * 浮點數序列化在不同語言間的差異，確保跨實作驗證必定一致。
 */

import { LotteryError, ERR } from './errors.mjs';

export function canonicalize(value) {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new LotteryError(ERR.BAD_CANONICAL, `無法正規化非有限數：${value}`);
    }
    if (!Number.isInteger(value)) {
      throw new LotteryError(
        ERR.BAD_CANONICAL,
        `本系統僅允許整數，收到浮點數：${value}（SPEC §5.3）`
      );
    }
    return String(value);
  }

  if (t === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort(); // 預設排序即為 UTF-16 碼元順序
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
      '}'
    );
  }

  throw new LotteryError(ERR.BAD_CANONICAL, `無法正規化的型別：${t}`);
}

/** 移除指定鍵後再正規化（例如計算雜湊時排除雜湊欄位本身） */
export function canonicalizeOmitting(obj, omitKeys = []) {
  const clone = { ...obj };
  for (const k of omitKeys) delete clone[k];
  return canonicalize(clone);
}
