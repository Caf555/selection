/**
 * JSON 正規化（RFC 8785 JCS）與 SHA-256 / HMAC-SHA256
 * SPEC.md §5.3、§6.2、§6.3
 *
 * 正規化的目的：任何實作、任何語言、任何時間，對同一份資料都算出同一個雜湊值，
 * 第三人才能獨立驗證歷史紀錄未遭竄改。
 */

import { createHash, createHmac } from 'node:crypto';
import { LotteryError, ERR } from './errors.mjs';

/**
 * RFC 8785 JSON Canonicalization Scheme
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

/** 對字串或 Buffer 取 SHA-256，回傳十六進位字串 */
export function sha256Hex(input) {
  return createHash('sha256').update(input, typeof input === 'string' ? 'utf8' : undefined).digest('hex');
}

/**
 * 對物件取正規化雜湊，回傳 "sha256:xxxx" 格式
 * @param {*} obj
 * @param {string[]} [omitKeys] 計算前先移除的鍵（例如雜湊欄位本身）
 */
export function hashObject(obj, omitKeys = []) {
  const clone = { ...obj };
  for (const k of omitKeys) delete clone[k];
  return 'sha256:' + sha256Hex(canonicalize(clone));
}

/** HMAC-SHA256，回傳 Buffer */
export function hmac(key, message) {
  return createHmac('sha256', key).update(message).digest();
}

/** HMAC-SHA256，回傳十六進位字串 */
export function hmacHex(key, message) {
  return hmac(key, message).toString('hex');
}
