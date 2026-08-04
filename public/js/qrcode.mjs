/**
 * QR code 產生器（位元組模式，版本 1–10）
 * SPEC.md §10.1、§5.3
 *
 * 自行實作而不引用第三方套件的理由與 SPEC §5.3 一致：本站不得對外部
 * 服務發出請求。若改用線上 QR 產生服務，等於把案號送到第三方伺服器，
 * 且列印時只要對方停止服務就整批失效。
 *
 * 依 ISO/IEC 18004 實作，涵蓋：
 *   - 位元組模式編碼與填補
 *   - GF(256) 上的 Reed-Solomon 錯誤更正
 *   - 多區塊資料與更正碼交錯
 *   - 定位圖形、對齊圖形、時序圖形、格式與版本資訊
 *   - 八種遮罩的懲罰評估與擇優
 *
 * 版本 1–10 已足夠：本系統的驗證網址約 60 字元，
 * 版本 4／更正等級 M 即可容納（62 位元組）。
 */

/* ── GF(256) ──────────────────────────────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多項式
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * 產生 n 個更正碼所需的生成多項式 g(x) = ∏(x − α^i)，i = 0 … n−1
 *
 * 係數採**降冪**排列且首項為 1，因為 rsEncode 的長除法演算法要求如此。
 * 若寫成升冪，產生的更正碼會自我一致、資料也讀得回來，
 * 但那不是合法的 RS 碼字——掃描器一律會跑 RS 解碼，
 * 遇到非零症狀即判定失敗，QR 完全掃不出來。
 */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                    // 乘以 x
      next[j + 1] ^= gfMul(poly[j], EXP[i]); // 乘以 α^i
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < gen.length - 1; i++) {
        res[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return res;
}

/* ── 版本與區塊結構表（ISO/IEC 18004 表 9）─────────────────── */

// [每區塊更正碼數, 第一組區塊數, 第一組資料碼數, 第二組區塊數, 第二組資料碼數]
const BLOCKS = {
  L: [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],
      [18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69]],
  M: [[10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],
      [16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44]],
  Q: [[13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],
      [24,4,19,0,0],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20]],
  H: [[17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],
      [28,4,15,0,0],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16]],
};

const ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
const REMAINDER = [0,7,7,7,7,7,0,0,0,0];

function capacity(version, level) {
  const [ec, b1, d1, b2, d2] = BLOCKS[level][version - 1];
  return b1 * d1 + b2 * d2;
}

/* ── 格式與版本資訊 ───────────────────────────────────────── */

const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

function formatBits(level, mask) {
  let data = (EC_BITS[level] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) rem ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if (rem & (1 << i)) rem ^= 0b1111100100101 << (i - 12);
  }
  return (version << 12) | rem;
}

/* ── 矩陣建構 ─────────────────────────────────────────────── */

function newMatrix(size) {
  return {
    size,
    m: Array.from({ length: size }, () => new Int8Array(size).fill(-1)), // -1 = 尚未填入
  };
}

function placeFinder(mx, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= mx.size || cc >= mx.size) continue;
      const inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                     (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      mx.m[rr][cc] = inRing || inCore ? 1 : 0;
    }
  }
}

function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  const mx = newMatrix(size);

  placeFinder(mx, 0, 0);
  placeFinder(mx, 0, size - 7);
  placeFinder(mx, size - 7, 0);

  // 時序圖形
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    mx.m[6][i] = v;
    mx.m[i][6] = v;
  }

  // 對齊圖形
  const pos = ALIGN[version - 1];
  for (const r of pos) {
    for (const c of pos) {
      // 與定位圖形重疊者略過
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          mx.m[r + dr][c + dc] = ring === 1 ? 0 : 1;
        }
      }
    }
  }

  // 固定為深色的模組
  mx.m[size - 8][8] = 1;

  // 格式資訊保留區（先標記為已佔用）
  for (let i = 0; i < 9; i++) {
    if (mx.m[8][i] === -1) mx.m[8][i] = 0;
    if (mx.m[i][8] === -1) mx.m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (mx.m[8][size - 1 - i] === -1) mx.m[8][size - 1 - i] = 0;
    if (mx.m[size - 1 - i][8] === -1) mx.m[size - 1 - i][8] = 0;
  }

  // 版本資訊保留區（版本 7 以上）
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mx.m[i][size - 11 + j] = 0;
        mx.m[size - 11 + j][i] = 0;
      }
    }
  }

  return mx;
}

/** 記錄哪些位置屬於功能圖形，資料不得覆蓋 */
function functionMask(version) {
  const mx = buildFunctionPatterns(version);
  const size = mx.size;
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) reserved[r][c] = mx.m[r][c] === -1 ? 0 : 1;
  }
  return { base: mx, reserved };
}

/* ── 資料編碼 ─────────────────────────────────────────────── */

function encodeData(bytes, version, level) {
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  push(0b0100, 4);                              // 位元組模式
  push(bytes.length, version <= 9 ? 8 : 16);    // 字元數指示子
  for (const b of bytes) push(b, 8);

  const total = capacity(version, level) * 8;
  for (let i = 0; i < 4 && bits.length < total; i++) bits.push(0); // 終止符
  while (bits.length % 8 !== 0) bits.push(0);

  const pad = [0xec, 0x11];
  let pi = 0;
  while (bits.length < total) {
    push(pad[pi++ % 2], 8);
  }

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  return data;
}

/** 依區塊結構切分、計算更正碼並交錯 */
function interleave(data, version, level) {
  const [ecCount, b1, d1, b2, d2] = BLOCKS[level][version - 1];
  const blocks = [];
  let p = 0;
  for (let i = 0; i < b1; i++) { blocks.push(data.slice(p, p + d1)); p += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(data.slice(p, p + d2)); p += d2; }

  const ecBlocks = blocks.map((b) => rsEncode(b, ecCount));

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

/* ── 資料排列與遮罩 ───────────────────────────────────────── */

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function placeData(base, reserved, codewords, size, mask) {
  const m = base.m.map((row) => Int8Array.from(row));
  const bits = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  let bi = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳過時序圖形所在的第 6 行
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (const c of [right, right - 1]) {
        if (reserved[r][c]) continue;
        const bit = bi < bits.length ? bits[bi++] : 0;
        m[r][c] = MASKS[mask](r, c) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }
  return m;
}

function applyFormat(m, size, level, mask, version) {
  const fmt = formatBits(level, mask);
  for (let i = 0; i <= 5; i++) m[8][i] = (fmt >> i) & 1;
  m[8][7] = (fmt >> 6) & 1;
  m[8][8] = (fmt >> 7) & 1;
  m[7][8] = (fmt >> 8) & 1;
  for (let i = 9; i <= 14; i++) m[14 - i][8] = (fmt >> i) & 1;

  // 第二份副本：位元 0–6 沿右下垂直排列，位元 7–14 沿右上水平排列。
  // 垂直段只到位元 6 —— (size-8, 8) 是規格指定的固定深色模組，
  // 若把位元 7 寫在該處會被覆蓋，使兩份格式資訊不一致而讀不出來。
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = (fmt >> i) & 1;
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = (fmt >> i) & 1;
  m[size - 8][8] = 1;

  if (version >= 7) {
    const ver = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (ver >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      m[r][c] = bit;
      m[c][r] = bit;
    }
  }
}

/** 遮罩懲罰評估（ISO/IEC 18004 §8.8.2） */
function penalty(m, size) {
  let score = 0;

  // 規則一：同色連續模組
  for (let i = 0; i < size; i++) {
    for (const dir of [0, 1]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = dir ? m[j - 1][i] : m[i][j - 1];
        const b = dir ? m[j][i] : m[i][j];
        if (a === b) { run++; }
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // 規則二：2×2 同色區塊
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // 規則三：類似定位圖形的排列
  const p1 = [1,0,1,1,1,0,1,0,0,0,0];
  const p2 = [0,0,0,0,1,0,1,1,1,0,1];
  const match = (arr, pat) => pat.every((v, i) => arr[i] === v);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      const row = [], col = [];
      for (let k = 0; k < 11; k++) { row.push(m[i][j + k]); col.push(m[j + k][i]); }
      if (match(row, p1) || match(row, p2)) score += 40;
      if (match(col, p1) || match(col, p2)) score += 40;
    }
  }

  // 規則四：深色模組比例
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

/* ── 對外介面 ─────────────────────────────────────────────── */

/**
 * 產生 QR code 模組矩陣
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} level 錯誤更正等級，預設 M
 * @returns {{size:number, modules:number[][], version:number, level:string}}
 */
export function encode(text, level = 'M') {
  const bytes = Array.from(new TextEncoder().encode(text));

  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const header = 4 + (v <= 9 ? 8 : 16);
    if (bytes.length * 8 + header <= capacity(v, level) * 8) { version = v; break; }
  }
  if (!version) {
    throw new Error(
      `內容過長（${bytes.length} 位元組），超出版本 10／等級 ${level} 的容量。` +
      `請改用較短的網址，或降低更正等級。`
    );
  }

  const data = encodeData(bytes, version, level);
  const codewords = interleave(data, version, level);
  const size = version * 4 + 17;
  const { base, reserved } = functionMask(version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = placeData(base, reserved, codewords, size, mask);
    applyFormat(m, size, level, mask, version);
    const p = penalty(m, size);
    if (!best || p < best.p) best = { p, m, mask };
  }

  return {
    size,
    version,
    level,
    mask: best.mask,
    modules: best.m.map((row) => Array.from(row)),
  };
}

/**
 * 產生 SVG。用向量而非點陣圖，列印時不論放大到多少都保持銳利。
 * @param {string} text
 * @param {object} [opt] { level, margin, scale, dark, light, title }
 */
export function toSvg(text, opt = {}) {
  const { level = 'M', margin = 4, scale = 4, dark = '#000000', light = '#ffffff', title = '' } = opt;
  const qr = encode(text, level);
  const dim = qr.size + margin * 2;

  let path = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `width="${dim * scale}" height="${dim * scale}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="${title || 'QR code'}">` +
    (title ? `<title>${title}</title>` : '') +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
