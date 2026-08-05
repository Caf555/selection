/**
 * 角色用詞
 * SPEC.md §2、§13
 *
 * ── 為什麼用詞要可設定 ─────────────────────────────────────
 *
 * 本系統目前的任務是「為已確定承辦股的案件抽出支援股」。但抽籤機制本身
 * （籤筒、輪分、補籤、抵分、迴避）與任務內容無關——同一套機制可以用來抽
 * 值班股、併案股或任何需要輪流分配的對象。
 *
 * 若把「承辦股」「支援股」寫死在程式與畫面裡，任務一改就得改程式，
 * 而改程式意味著要重新驗證整套演算法。把用詞抽成設定，就能只改設定、
 * 不動已經驗證過的核心邏輯。
 *
 * 本檔刻意不引用任何 Node.js 專屬模組，供瀏覽器與 Node 共用。
 */

export const DEFAULT_TERMS = {
  /** 需要被支援的一方，於抽籤時與案號一併輸入，不參與抽籤 */
  requester: '承辦股',
  /** 抽籤抽出的一方，籤筒輪分的對象 */
  drawee: '支援股',
  /** 動作名稱，用於「○○統計」「○○件數」等處 */
  action: '支援',
  /** 系統名稱，顯示於頁面標題 */
  systemName: '案件支援股抽籤系統',
};

/**
 * 取得目前設定的用詞，未設定者使用預設值。
 * @param {object} config
 */
export function terms(config) {
  const t = config?.terminology ?? {};
  // 只含空白的字串視為未設定。若直接採用，畫面上會出現空白的欄位標題，
  // 讀者無從得知那一欄是什麼。
  const pick = (v, fallback) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || fallback;
  };
  return {
    requester: pick(t.requester, DEFAULT_TERMS.requester),
    drawee: pick(t.drawee, DEFAULT_TERMS.drawee),
    action: pick(t.action, DEFAULT_TERMS.action),
    systemName: pick(t.systemName, DEFAULT_TERMS.systemName),
  };
}

/** 可經「組織設定變更」流程調整的用詞欄位 */
export const EDITABLE_TERMS = Object.keys(DEFAULT_TERMS);
