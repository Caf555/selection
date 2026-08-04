/**
 * 抽籤系統錯誤型別
 * SPEC.md §3
 */

export class LotteryError extends Error {
  /**
   * @param {string} code    錯誤代碼，供程式判斷與紀錄
   * @param {string} message 中文訊息，直接顯示給操作者
   * @param {object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LotteryError';
    this.code = code;
    this.details = details;
  }
}

export const ERR = {
  ALL_EXCLUDED: 'ALL_EXCLUDED',           // 所有股均已迴避，無法抽籤
  REFILL_LOOP: 'REFILL_LOOP',             // 補籤迴圈超過上限，設定異常
  EMPTY_BIN: 'EMPTY_BIN',                 // 籤筒為空且無法補籤
  OFFSET_TOO_LARGE: 'OFFSET_TOO_LARGE',   // 抵分數超過上限
  UNKNOWN_UNIT: 'UNKNOWN_UNIT',           // 股別不存在
  UNKNOWN_CASETYPE: 'UNKNOWN_CASETYPE',   // 案類不存在
  NO_ACTIVE_UNIT: 'NO_ACTIVE_UNIT',       // 無任何在職股
  BAD_CANONICAL: 'BAD_CANONICAL',         // 資料無法正規化（非整數、非有限數等）
  CHAIN_BROKEN: 'CHAIN_BROKEN',           // 雜湊鏈驗證失敗
  STATE_HASH_MISMATCH: 'STATE_HASH_MISMATCH',
  VOID_NOT_LATEST: 'VOID_NOT_LATEST',     // 只能作廢該籤筒最近一筆
  DUPLICATE_CASE_NO: 'DUPLICATE_CASE_NO', // 案號重複
  PRIVACY_VIOLATION: 'PRIVACY_VIOLATION', // 疑似個資
};
