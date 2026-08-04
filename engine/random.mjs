/**
 * 抽籤位置的推導
 * SPEC.md §4.3
 *
 * 必須使用拒絕採樣（rejection sampling），不得直接取模。
 * 直接取模會產生模數偏差：當 2^64 不能被 n 整除時，較小的索引出現機率會略高，
 * 使排序在前的股受分機率略大於其他股。此偏差雖小，但在法院分案中不可接受。
 */

import { hmac } from './hash.mjs';
import { LotteryError, ERR } from './errors.mjs';

const TWO_POW_64 = 1n << 64n;

/**
 * 由亂數來源建立抽籤函式
 *
 * @param {Buffer|string} randomnessSource drand 的 randomness（hex 字串或 Buffer）
 * @param {string} commitPayloadHash       承諾階段酬載的雜湊，綁定抽籤標的
 * @returns {(n: number, itemSeq: number) => number} 回傳 [0, n) 的均勻整數
 */
export function makePicker(randomnessSource, commitPayloadHash) {
  const key =
    typeof randomnessSource === 'string'
      ? Buffer.from(randomnessSource, 'hex')
      : randomnessSource;

  const seed = hmac(key, commitPayloadHash);

  return function pick(n, itemSeq = 0) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new LotteryError(ERR.EMPTY_BIN, `可抽籤數必須為正整數，收到 ${n}`);
    }
    if (n === 1) return 0;

    const big = BigInt(n);
    const limit = (TWO_POW_64 / big) * big; // 可用區間上界，超出者拒絕

    for (let counter = 0; ; counter++) {
      const block = hmac(seed, `pick|${itemSeq}|${counter}`);
      const v = block.readBigUInt64BE(0);
      if (v < limit) return Number(v % big);
      // v >= limit：落在會造成偏差的尾段，丟棄後重取
    }
  };
}

/**
 * 測試用：以固定字串種子建立確定性抽籤函式。
 * 演算法與 makePicker 完全相同，僅亂數來源不同。
 * **嚴禁用於正式抽籤。**
 */
export function makeSeededPicker(seedString) {
  return makePicker(Buffer.from(seedString, 'utf8'), 'TEST-ONLY');
}

/**
 * 測試用：依預先指定的索引序列回傳結果，用於精確控制抽中哪一支籤。
 * **嚴禁用於正式抽籤。**
 */
export function makeSequencePicker(sequence) {
  let i = 0;
  return function pick(n) {
    if (i >= sequence.length) {
      throw new Error(`測試序列已用盡（已取 ${i} 次），請補足 sequence`);
    }
    const idx = sequence[i++];
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
      throw new Error(`測試序列第 ${i - 1} 個值 ${idx} 超出範圍 [0, ${n})`);
    }
    return idx;
  };
}
