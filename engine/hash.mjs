/**
 * SHA-256 / HMAC-SHA256（Node.js 端）
 * SPEC.md §5.3、§6.2、§6.3
 *
 * JSON 正規化在 engine/canonical.mjs，該檔不依賴 Node.js，
 * 供瀏覽器驗證頁載入同一份程式碼（見 public/js/hashweb.mjs）。
 */

import { createHash, createHmac } from 'node:crypto';
import { canonicalize, canonicalizeOmitting } from './canonical.mjs';

export { canonicalize, canonicalizeOmitting };

/** 對字串或 Buffer 取 SHA-256，回傳十六進位字串 */
export function sha256Hex(input) {
  const h = createHash('sha256');
  if (typeof input === 'string') h.update(input, 'utf8');
  else h.update(input);
  return h.digest('hex');
}

/**
 * 對物件取正規化雜湊，回傳 "sha256:xxxx" 格式
 * @param {*} obj
 * @param {string[]} [omitKeys] 計算前先移除的鍵（例如雜湊欄位本身）
 */
export function hashObject(obj, omitKeys = []) {
  return 'sha256:' + sha256Hex(canonicalizeOmitting(obj, omitKeys));
}

/** HMAC-SHA256，回傳 Buffer */
export function hmac(key, message) {
  return createHmac('sha256', key).update(message).digest();
}

/** HMAC-SHA256，回傳十六進位字串 */
export function hmacHex(key, message) {
  return hmac(key, message).toString('hex');
}
