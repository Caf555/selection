/**
 * 測試共用工具
 *
 * 測試刻意**不讀取** data/config.json，改用本檔自訂的固定 fixture。
 * 理由：庭別與股別名稱是會隨組織調整而變動的營運資料，若測試綁在正式設定上，
 * 日後改一個股名就會弄壞整批演算法測試，掩蓋真正的問題。
 * 演算法測試要驗的是規則本身，與叫什麼名字無關。
 *
 * 正式設定的結構正確性另由 config.test.mjs 檢查。
 */

import { courtIdOf } from '../lottery.mjs';

/** 測試 fixture：4 庭 × 2 股，每股每輪 1 支籤 */
const FIXTURE = {
  schemaVersion: 1,
  courts: [
    { id: 'ct-01', name: '測試一庭', shortName: '測一', order: 1, active: true, color: 'blue' },
    { id: 'ct-02', name: '測試二庭', shortName: '測二', order: 2, active: true, color: 'green' },
    { id: 'ct-03', name: '測試三庭', shortName: '測三', order: 3, active: true, color: 'amber' },
    { id: 'ct-04', name: '測試四庭', shortName: '測四', order: 4, active: true, color: 'purple' },
  ],
  units: [
    { id: 'un-01', name: '忠股', courtId: 'ct-01', order: 1, active: true, ticketsPerCycle: 1 },
    { id: 'un-02', name: '孝股', courtId: 'ct-01', order: 2, active: true, ticketsPerCycle: 1 },
    { id: 'un-03', name: '仁股', courtId: 'ct-02', order: 3, active: true, ticketsPerCycle: 1 },
    { id: 'un-04', name: '愛股', courtId: 'ct-02', order: 4, active: true, ticketsPerCycle: 1 },
    { id: 'un-05', name: '信股', courtId: 'ct-03', order: 5, active: true, ticketsPerCycle: 1 },
    { id: 'un-06', name: '義股', courtId: 'ct-03', order: 6, active: true, ticketsPerCycle: 1 },
    { id: 'un-07', name: '和股', courtId: 'ct-04', order: 7, active: true, ticketsPerCycle: 1 },
    { id: 'un-08', name: '平股', courtId: 'ct-04', order: 8, active: true, ticketsPerCycle: 1 },
  ],
  caseTypes: [
    { id: 'jinsu', name: '金訴', order: 1, active: true },
    { id: 'jinzhongsu', name: '金重訴', order: 2, active: true },
  ],
  rules: {
    refillWhenRemainingAtMost: 1,
    refillWhenTwoTicketsSameCourt: true,
    defaultOffsetScope: 'sameCaseType',
    maxOffsetPerCase: 10,
    maxRefillLoops: 20,
    redrawReturnsTicket: true,
  },
};

/** 每個測試取得獨立的設定副本，避免互相污染 */
export function freshConfig(overrides = {}) {
  const c = structuredClone(FIXTURE);
  if (overrides.rules) Object.assign(c.rules, overrides.rules);
  return c;
}

/** 股別代號速查（測一：忠孝／測二：仁愛／測三：信義／測四：和平） */
export const U = {
  忠: 'un-01',
  孝: 'un-02',
  仁: 'un-03',
  愛: 'un-04',
  信: 'un-05',
  義: 'un-06',
  和: 'un-07',
  平: 'un-08',
};

export const ALL8 = [U.忠, U.孝, U.仁, U.愛, U.信, U.義, U.和, U.平];

/** 建立單一籤筒 */
export function makeBin(tickets, opts = {}) {
  return {
    tickets: tickets.slice(),
    cycle: opts.cycle ?? 1,
    carryOverSkips: { ...(opts.carryOverSkips ?? {}) },
  };
}

/** 建立籤筒集合，未指定的案類給予滿籤筒 */
export function makeBins(spec) {
  const out = {};
  for (const k of ['jinsu', 'jinzhongsu']) {
    out[k] = spec[k] ? makeBin(spec[k].tickets ?? spec[k], spec[k].opts ?? spec[k]) : makeBin(ALL8);
  }
  return out;
}

/** 統計籤筒中各股的籤數 */
export function count(tickets) {
  const m = {};
  for (const t of tickets) m[t] = (m[t] ?? 0) + 1;
  return m;
}

/**
 * SPEC §3.3 步驟 4 的不變量：
 * 每次抽籤結束後，籤筒必定「支數 >= 2」且「非（支數 == 2 且兩支同庭）」。
 * 此不變量若被破壞，即代表補籤檢查在錯誤的時點執行（SPEC §3.6）。
 */
export function assertRefillInvariant(bin, config, label = '') {
  const n = bin.tickets.length;
  if (n <= (config.rules.refillWhenRemainingAtMost ?? 1)) {
    throw new Error(
      `${label} 違反補籤不變量：籤筒僅剩 ${n} 支，應已觸發補籤（SPEC §3.6）` +
        `\n  籤筒內容：${JSON.stringify(bin.tickets)}`
    );
  }
  if (config.rules.refillWhenTwoTicketsSameCourt && n === 2) {
    const a = courtIdOf(config, bin.tickets[0]);
    const b = courtIdOf(config, bin.tickets[1]);
    if (a === b) {
      throw new Error(
        `${label} 違反補籤不變量：籤筒剩 2 支且同屬 ${a}，應已觸發補籤（SPEC §3.6 情境 C）` +
          `\n  籤筒內容：${JSON.stringify(bin.tickets)}`
      );
    }
  }
}
