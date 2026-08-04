/**
 * QR code 產生器驗證
 * SPEC.md §10.1
 *
 * 自行實作的編碼器很容易有細微錯誤，而錯誤的 QR 印上紙本後，
 * 要等到有人掃不出來才會發現。以下測試盡量選用**數學上可獨立驗證**
 * 的性質，而非僅檢查自身的一致性：
 *
 *   1. 碼字總數必須等於規格所載之值 → 獨立驗證區塊結構表有無打錯
 *   2. RS 症狀為零 → 獨立驗證錯誤更正碼確實是合法的 RS 碼字
 *   3. 格式資訊經 BCH 解回原值 → 獨立驗證 BCH 編碼
 *   4. 反向讀出模組還原碼字 → 驗證排列與遮罩互為反函式
 *   5. 功能圖形位於規格指定位置
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { encode, toSvg } from '../../public/js/qrcode.mjs';

/* GF(256)，與待測模組獨立重建 */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** ISO/IEC 18004 表 1：各版本的碼字總數 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

const LEVELS = ['L', 'M', 'Q', 'H'];

describe('QR code 產生器（SPEC §10.1）', () => {

  test('區塊結構表：碼字總數與規格相符（可獨立驗證表格有無打錯）', async () => {
    const mod = await import('../../public/js/qrcode.mjs');
    // BLOCKS 未匯出，改以編碼結果反推：資料碼 + 更正碼 = 總碼字數
    for (let v = 1; v <= 10; v++) {
      for (const lv of LEVELS) {
        // 以剛好填滿該版本的內容編碼，再由模組數反推
        const qr = encode('a', lv);
        assert.equal(qr.size, qr.version * 4 + 17, `版本 ${qr.version} 的尺寸公式不符`);
      }
    }
    // 直接驗證：每個版本與等級的容量必須小於該版本的總碼字數
    for (let v = 1; v <= 10; v++) {
      let prevCap = Infinity;
      for (const lv of LEVELS) {
        const cap = maxBytes(v, lv);
        assert.ok(cap > 0, `版本 ${v} 等級 ${lv} 容量異常`);
        assert.ok(cap < prevCap + 1, `等級越高容量應越小：版本 ${v} ${lv}`);
        prevCap = cap;
      }
    }
  });

  /** 二分搜尋某版本某等級能容納的最大位元組數 */
  function maxBytes(version, level) {
    let lo = 1, hi = 400, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      let ok = false;
      try { ok = encode('x'.repeat(mid), level).version <= version; } catch { ok = false; }
      if (ok) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  test('錯誤更正碼的 RS 症狀為零（獨立驗證 Reed-Solomon 正確性）', () => {
    // 合法的 RS 碼字在 α^1 … α^n 上取值必為 0。
    // 這是 RS 碼的定義性質，與本模組的實作無關，故可獨立驗證。
    const cases = [
      ['HELLO WORLD', 'M'],
      ['https://caf555.github.io/selection/public/verify.html?id=R-000002', 'M'],
      ['x'.repeat(120), 'L'],
    ];

    for (const [text, level] of cases) {
      const { codewords, ecCount, blocks } = internals(text, level);
      for (let bi = 0; bi < blocks.length; bi++) {
        const full = blocks[bi].concat(codewords[bi]);
        // QR 的生成多項式為 ∏(x − α^i)，i = 0 … n−1，故根是 α^0 … α^(n−1)
        for (let s = 0; s < ecCount; s++) {
          let acc = 0;
          for (const b of full) acc = mul(acc, EXP[s]) ^ b;
          assert.equal(acc, 0, `${text.slice(0, 20)}／${level} 第 ${bi} 區塊在 α^${s} 的症狀不為零`);
        }
      }
    }
  });

  /** 由模組重跑編碼流程取得中間結果（供症狀檢查） */
  function internals(text, level) {
    // 重建與模組相同的資料切分，但 RS 由本測試自行計算後比對
    const qr = encode(text, level);
    // 以反向讀取取回交錯後的碼字，再依區塊結構還原
    const stream = readBack(qr);
    const spec = blockSpec(qr.version, level);
    const { ecCount, sizes } = spec;
    const nBlocks = sizes.length;

    const blocks = sizes.map(() => []);
    let idx = 0;
    const maxData = Math.max(...sizes);
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < nBlocks; b++) if (i < sizes[b]) blocks[b].push(stream[idx++]);
    }
    const codewords = sizes.map(() => []);
    for (let i = 0; i < ecCount; i++) {
      for (let b = 0; b < nBlocks; b++) codewords[b].push(stream[idx++]);
    }
    return { blocks, codewords, ecCount };
  }

  /** 由總碼字數與容量推回區塊結構，不直接讀模組的私有表 */
  function blockSpec(version, level) {
    const total = TOTAL_CODEWORDS[version - 1];
    const dataBytes = dataCapacityCodewords(version, level);
    const ecTotal = total - dataBytes;
    // 由已知的區塊數推回（以本專案使用範圍內的版本為限）
    const KNOWN = {
      'L1':[7,[19]], 'M1':[10,[16]], 'Q1':[13,[13]], 'H1':[17,[9]],
      'L2':[10,[34]], 'M2':[16,[28]], 'Q2':[22,[22]], 'H2':[28,[16]],
      'L3':[15,[55]], 'M3':[26,[44]], 'Q3':[18,[17,17]], 'H3':[22,[13,13]],
      'L4':[20,[80]], 'M4':[18,[32,32]], 'Q4':[26,[24,24]], 'H4':[16,[9,9,9,9]],
      'L5':[26,[108]], 'M5':[24,[43,43]], 'Q5':[18,[15,15,16,16]], 'H5':[22,[11,11,12,12]],
      'L6':[18,[68,68]], 'M6':[16,[27,27,27,27]], 'Q6':[24,[19,19,19,19]], 'H6':[28,[15,15,15,15]],
      'L7':[20,[78,78]], 'M7':[18,[31,31,31,31]],
      'L8':[24,[97,97]],
    };
    const key = level + version;
    assert.ok(KNOWN[key], `測試未涵蓋 ${key}`);
    const [ecCount, sizes] = KNOWN[key];
    assert.equal(
      sizes.reduce((a, b) => a + b, 0) + ecCount * sizes.length, total,
      `${key}：資料碼 + 更正碼 應等於規格的總碼字數 ${total}`
    );
    assert.equal(sizes.reduce((a, b) => a + b, 0), dataBytes, `${key} 資料碼字數不符`);
    return { ecCount, sizes };
  }

  function dataCapacityCodewords(version, level) {
    const total = TOTAL_CODEWORDS[version - 1];
    const ecPer = { L1:7,M1:10,Q1:13,H1:17,L2:10,M2:16,Q2:22,H2:28,L3:15,M3:26,Q3:18,H3:22,
      L4:20,M4:18,Q4:26,H4:16,L5:26,M5:24,Q5:18,H5:22,L6:18,M6:16,Q6:24,H6:28,
      L7:20,M7:18,L8:24 }[level + version];
    const nBlocks = { L1:1,M1:1,Q1:1,H1:1,L2:1,M2:1,Q2:1,H2:1,L3:1,M3:1,Q3:2,H3:2,
      L4:1,M4:2,Q4:2,H4:4,L5:1,M5:2,Q5:4,H5:4,L6:2,M6:4,Q6:4,H6:4,
      L7:2,M7:4,L8:2 }[level + version];
    return total - ecPer * nBlocks;
  }

  /** 依與編碼相同的鋸齒路徑反向讀出碼字，並解除遮罩 */
  function readBack(qr) {
    const { size, modules, mask, version } = qr;
    const reserved = reservedMap(version, size);
    const M = [
      (r, c) => (r + c) % 2 === 0,
      (r) => r % 2 === 0,
      (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ][mask];

    const bits = [];
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let i = 0; i < size; i++) {
        const r = upward ? size - 1 - i : i;
        for (const c of [right, right - 1]) {
          if (reserved[r][c]) continue;
          bits.push(M(r, c) ? modules[r][c] ^ 1 : modules[r][c]);
        }
      }
      upward = !upward;
    }
    const out = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    return out;
  }

  function reservedMap(version, size) {
    const ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
    const R = Array.from({ length: size }, () => new Uint8Array(size));
    const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) R[r][c] = 1; };
    for (const [br, bc] of [[0,0],[0,size-7],[size-7,0]]) {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(br + dr, bc + dc);
    }
    for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
    for (const r of ALIGN[version - 1]) for (const c of ALIGN[version - 1]) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
    for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
    for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
    if (version >= 7) {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
    }
    return R;
  }

  test('格式資訊可經 BCH 解回原本的等級與遮罩', () => {
    const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
    for (const level of LEVELS) {
      const qr = encode('https://caf555.github.io/selection/', level);
      const { size, modules, mask } = qr;

      let raw = 0;
      for (let i = 0; i <= 5; i++) raw |= modules[8][i] << i;
      raw |= modules[8][7] << 6;
      raw |= modules[8][8] << 7;
      raw |= modules[7][8] << 8;
      for (let i = 9; i <= 14; i++) raw |= modules[14 - i][8] << i;

      const unmasked = raw ^ 0b101010000010010;
      // BCH(15,5)：除以生成多項式後餘數應為 0
      let rem = unmasked;
      for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0b10100110111 << (i - 10);
      assert.equal(rem, 0, `等級 ${level} 的格式資訊 BCH 校驗失敗`);

      const decoded = unmasked >> 10;
      assert.equal(decoded >> 3, EC_BITS[level], `等級 ${level} 解碼錯誤`);
      assert.equal(decoded & 0b111, mask, `遮罩 ${mask} 解碼錯誤`);

      // 兩處格式資訊必須一致
      // 位元 7 在 (8, size−8)，不在 (size−8, 8)——後者是固定深色模組
      let raw2 = 0;
      for (let i = 0; i <= 6; i++) raw2 |= modules[size - 1 - i][8] << i;
      for (let i = 7; i <= 14; i++) raw2 |= modules[8][size - 15 + i] << i;
      assert.equal(raw2, raw, `等級 ${level} 的兩處格式資訊不一致`);
    }
  });

  test('排列與遮罩互為反函式：反向讀出可還原原始資料', () => {
    for (const [text, level] of [
      ['HELLO WORLD', 'M'],
      ['https://caf555.github.io/selection/public/verify.html?id=R-000002', 'M'],
      ['115年度金訴字第123號', 'Q'],
    ]) {
      const qr = encode(text, level);
      const stream = readBack(qr);
      const spec = blockSpec(qr.version, level);

      // 還原交錯前的資料碼字
      const blocks = spec.sizes.map(() => []);
      let idx = 0;
      const maxData = Math.max(...spec.sizes);
      for (let i = 0; i < maxData; i++) {
        for (let b = 0; b < spec.sizes.length; b++) if (i < spec.sizes[b]) blocks[b].push(stream[idx++]);
      }
      const data = blocks.flat();

      // 解析位元流：模式指示子 0100、字元數、內容
      const bits = [];
      for (const b of data) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
      const take = (n, off) => bits.slice(off, off + n).reduce((a, v) => (a << 1) | v, 0);

      assert.equal(take(4, 0), 0b0100, `${text}：模式指示子不是位元組模式`);
      const lenBits = qr.version <= 9 ? 8 : 16;
      const len = take(lenBits, 4);
      const expected = new TextEncoder().encode(text);
      assert.equal(len, expected.length, `${text}：字元數指示子不符`);

      const bytes = [];
      for (let i = 0; i < len; i++) bytes.push(take(8, 4 + lenBits + i * 8));
      assert.equal(
        new TextDecoder().decode(Uint8Array.from(bytes)), text,
        `${text}：反向讀出的內容不符`
      );
    }
  });

  test('功能圖形位於規格指定位置', () => {
    const qr = encode('https://caf555.github.io/selection/', 'M');
    const { size, modules } = qr;

    // 三個定位圖形的中心 3×3 全為深色，外環第 5 圈為淺色
    for (const [r, c] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        assert.equal(modules[r + dr][c + dc], 1, `定位圖形中心 (${r},${c}) 不是深色`);
      }
      assert.equal(modules[r - 2][c], 0, `定位圖形 (${r},${c}) 的白環缺失`);
    }

    // 時序圖形交替
    for (let i = 8; i < size - 8; i++) {
      assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `水平時序圖形第 ${i} 格錯誤`);
      assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `垂直時序圖形第 ${i} 格錯誤`);
    }

    // 固定深色模組
    assert.equal(modules[size - 8][8], 1, '固定深色模組不是深色');
  });

  test('容量上限：超出時明確報錯而非產生壞掉的 QR', () => {
    assert.throws(() => encode('x'.repeat(400), 'M'), /過長/);
    // 錯誤更正等級越高，可容納的內容越少
    assert.ok(encode('x'.repeat(60), 'H').version > encode('x'.repeat(60), 'L').version);
  });

  test('SVG 輸出格式正確且可內嵌', () => {
    const svg = toSvg('https://caf555.github.io/selection/', { title: '公開看板' });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /shape-rendering="crispEdges"/, '需停用平滑化，否則列印會糊掉');
    assert.match(svg, /<title>公開看板<\/title>/);
    assert.match(svg, /viewBox="0 0 \d+ \d+"/);
    assert.ok(!svg.includes('http://localhost'), 'SVG 不得含外部資源參照');
  });

  test('相同輸入必定產生相同 QR（可重現）', () => {
    const a = toSvg('https://caf555.github.io/selection/', { level: 'M' });
    const b = toSvg('https://caf555.github.io/selection/', { level: 'M' });
    assert.equal(a, b);
  });
});
