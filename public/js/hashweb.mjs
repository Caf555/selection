/**
 * 瀏覽器端雜湊
 * SPEC.md §4.4
 *
 * 正規化程式碼直接引用 engine/canonical.mjs — 與抽籤引擎執行的是同一份檔案。
 * 若驗證頁自行重寫一份正規化邏輯，驗證通過與否就不再具有意義。
 */

import { canonicalize, canonicalizeOmitting } from '../../engine/canonical.mjs';

export { canonicalize, canonicalizeOmitting };

export async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashObject(obj, omitKeys = []) {
  return 'sha256:' + (await sha256Hex(canonicalizeOmitting(obj, omitKeys)));
}
