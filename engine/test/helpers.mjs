/**
 * 測試共用工具
 */

import { readFileSync } from 'node:fs';
import { courtIdOf } from '../lottery.mjs';

const RAW_CONFIG = JSON.parse(
  readFileSync(new URL('../../data/config.json', import.meta.url), 'utf8')
);

/** 每個測試取得獨立的設定副本，避免互相污染 */
export function freshConfig(overrides = {}) {
  const c = structuredClone(RAW_CONFIG);
  if (overrides.rules) Object.assign(c.rules, overrides.rules);
  return c;
}

/** 股別代號速查（刑一：忠孝／刑二：仁愛／刑三：信義／刑四：和平） */
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

/** 建立籤筒集合，未指定的案類給予空籤筒 */
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
