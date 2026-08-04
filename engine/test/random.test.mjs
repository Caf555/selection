/**
 * 亂數推導與長期公平性測試
 * SPEC.md §14 測試項目 26、27、35、§4.3
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makePicker, makeSeededPicker } from '../random.mjs';
import { drawOnce, createBin } from '../lottery.mjs';
import { canonicalize, hashObject } from '../hash.mjs';
import { freshConfig, ALL8, assertRefillInvariant } from './helpers.mjs';

/** 卡方統計量 */
function chiSquare(observed, expected) {
  let x = 0;
  for (const o of observed) x += ((o - expected) ** 2) / expected;
  return x;
}

describe('拒絕採樣與可重現性（SPEC §14 測試 26～27）', () => {
  test('#26 拒絕採樣：n = 3、5、7 等非 2 冪值，分布無模數偏差', () => {
    // 自由度 df = n-1，取 p = 0.001 的臨界值，避免偶發性失敗
    const critical = { 3: 13.82, 5: 18.47, 7: 22.46 };
    const N = 120000;

    for (const n of [3, 5, 7]) {
      const counts = new Array(n).fill(0);
      const pick = makeSeededPicker(`rejection-sampling-n${n}`);
      for (let i = 0; i < N; i++) counts[pick(n, i)]++;

      const x = chiSquare(counts, N / n);
      assert.ok(
        x < critical[n],
        `n = ${n} 的分布偏離均勻：卡方 ${x.toFixed(2)} >= 臨界值 ${critical[n]}\n` +
          `  各索引次數：${counts.join(', ')}（期望值 ${N / n}）`
      );

      // 直接取模會使低位索引偏高，額外檢查首尾差異
      const maxDev = Math.max(...counts) - Math.min(...counts);
      assert.ok(
        maxDev < N / n * 0.03,
        `n = ${n} 的最大最小差 ${maxDev} 過大，疑似模數偏差`
      );
    }
  });

  test('#26b n = 1 時恆回傳 0，n <= 0 時拒絕', () => {
    const pick = makeSeededPicker('edge');
    assert.equal(pick(1, 0), 0);
    assert.throws(() => pick(0, 0));
    assert.throws(() => pick(-1, 0));
  });

  test('#27 相同 randomness 與相同 commitPayload → 結果完全可重現', () => {
    const randomness = 'a3f1c9e27b48d5601122334455667788990aabbccddeeff00112233445566778';
    const payload = {
      batchId: 'B-000001',
      caseTypeId: 'jinsu',
      caseNos: ['115年度金訴字第001號', '115年度金訴字第002號'],
      round: 5123456,
    };
    const payloadHash = hashObject(payload);

    const run = () => {
      const config = freshConfig();
      const bins = { jinsu: createBin(config), jinzhongsu: createBin(config) };
      const pick = makePicker(randomness, payloadHash);
      const out = [];
      for (let i = 0; i < 40; i++) {
        out.push(drawOnce({ config, bins, caseTypeId: 'jinsu', pick, itemSeq: i }).resultUnitId);
      }
      return out;
    };

    assert.deepEqual(run(), run(), '同樣的輸入必須得到同樣的結果');

    // 酬載只要有任何差異，結果就完全不同
    const other = makePicker(randomness, hashObject({ ...payload, batchId: 'B-000002' }));
    const same = makePicker(randomness, payloadHash);
    let diff = 0;
    for (let i = 0; i < 40; i++) if (other(8, i) !== same(8, i)) diff++;
    assert.ok(diff > 20, '不同酬載應產生實質不同的序列');
  });

  test('#27b 正規化：鍵序不同但內容相同的物件，雜湊必須相同', () => {
    const a = { b: 2, a: 1, c: [3, { y: 2, x: 1 }] };
    const b = { c: [3, { x: 1, y: 2 }], a: 1, b: 2 };
    assert.equal(canonicalize(a), canonicalize(b));
    assert.equal(hashObject(a), hashObject(b));
    assert.equal(canonicalize(a), '{"a":1,"b":2,"c":[3,{"x":1,"y":2}]}');
  });

  test('#27c 正規化：拒絕浮點數與非有限數（SPEC §5.3）', () => {
    assert.throws(() => canonicalize({ n: 1.5 }));
    assert.throws(() => canonicalize({ n: NaN }));
    assert.throws(() => canonicalize({ n: Infinity }));
    assert.equal(canonicalize({ n: -3 }), '{"n":-3}');
  });
});

describe('長期公平性（SPEC §14 測試 35）', () => {
  test('#35 一萬次抽籤，各股受分件數的分布通過卡方檢定', () => {
    const config = freshConfig();
    const bins = { jinsu: createBin(config), jinzhongsu: createBin(config) };
    const pick = makeSeededPicker('fairness-10000');

    const N = 10000;
    const counts = Object.fromEntries(ALL8.map((u) => [u, 0]));

    for (let i = 0; i < N; i++) {
      const r = drawOnce({ config, bins, caseTypeId: 'jinsu', pick, itemSeq: i });
      counts[r.resultUnitId]++;
      assertRefillInvariant(bins.jinsu, config, `#35 第 ${i} 次`);
    }

    const observed = ALL8.map((u) => counts[u]);
    const expected = N / 8;
    const x = chiSquare(observed, expected);

    // df = 7，p = 0.001 的臨界值為 24.32
    assert.ok(
      x < 24.32,
      `各股受分件數偏離均勻：卡方 ${x.toFixed(2)}\n` +
        ALL8.map((u, i) => `  ${u}: ${observed[i]}`).join('\n')
    );

    // 輪分制的偏差應遠小於純隨機抽樣
    const maxDev = Math.max(...observed) - Math.min(...observed);
    assert.ok(maxDev < expected * 0.05, `最大最小差 ${maxDev} 過大（期望值 ${expected}）`);
  });

  test('#35b 抵分不會使任何股長期受惠或受損：抵分後的總件數（含抵分）應趨近均等', () => {
    const config = freshConfig();
    const bins = { jinsu: createBin(config), jinzhongsu: createBin(config) };
    const pick = makeSeededPicker('fairness-offset');

    const N = 6000;
    const weighted = Object.fromEntries(ALL8.map((u) => [u, 0]));

    for (let i = 0; i < N; i++) {
      // 每 10 件出現 1 件抵 3 分的重大案件
      const offsetCount = i % 10 === 0 ? 3 : 1;
      const r = drawOnce({ config, bins, caseTypeId: 'jinsu', offsetCount, pick, itemSeq: i });
      weighted[r.resultUnitId] += offsetCount; // 以「折算件數」計算實際工作量
    }

    const observed = ALL8.map((u) => weighted[u]);
    const expected = observed.reduce((a, b) => a + b, 0) / 8;
    const maxDev = Math.max(...observed) - Math.min(...observed);

    assert.ok(
      maxDev < expected * 0.08,
      `含抵分的折算件數偏差過大：最大最小差 ${maxDev}（平均 ${expected.toFixed(1)}）\n` +
        ALL8.map((u, i) => `  ${u}: ${observed[i]}`).join('\n')
    );
  });
});
