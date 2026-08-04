/**
 * drand 簽章的 BLS12-381 密碼學驗證（第二層驗證）
 * SPEC.md §4.1
 *
 * ── 為什麼這是唯一使用第三方套件的檔案 ─────────────────────────
 *
 * drand quicknet 採用 bls-unchained-g1-rfc9380：簽章在 G1、公鑰在 G2，
 * 驗證需要 BLS12-381 的配對運算（pairing）。自行手寫配對密碼學約需一千行
 * 以上，且任何細微實作錯誤都可能讓驗證形同虛設 —— 自己寫比用經過審計的
 * 現成實作更危險。
 *
 * 因此本檔引用 @noble/curves（本身零相依、經專業審計），並限縮其影響範圍：
 *
 *   抽籤路徑        engine/drand.mjs   零第三方相依（多端點交叉比對）
 *   稽核與驗證路徑  engine/bls.mjs     使用 @noble/curves 做完整驗簽
 *
 * 也就是說，即使 @noble/curves 有朝一日不可用或出現問題，**抽籤仍可正常
 * 進行**，只是暫時少了第二層的密碼學證明。分案作業不會因此停擺。
 *
 * ── 重要實作細節 ───────────────────────────────────────────────
 * 對於被竄改的簽章，@noble/curves 會**擲出例外**而非回傳 false
 * （因為竄改後的位元組通常不是合法的曲線點）。
 * 若不攔截，稽核流程會直接崩潰而不是回報「驗證失敗」——外觀上看起來
 * 像是系統故障，而不是偵測到問題。本檔一律將例外轉為驗證失敗。
 */

import { messageForRound } from './drand.mjs';

let _bls = null;

/** 延遲載入，使未安裝 @noble/curves 的環境仍能執行抽籤 */
async function loadBls() {
  if (_bls) return _bls;
  const m = await import('@noble/curves/bls12-381.js');
  _bls = m.bls12_381;
  return _bls;
}

export async function blsAvailable() {
  try {
    await loadBls();
    return true;
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(String(hex), 'hex'));
}

/**
 * 驗證某一輪 drand 的簽章。
 *
 * @param {object} config    需含 config.drand.publicKey 與 signatureDST
 * @param {number} round
 * @param {string} signature 十六進位字串
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function verifyRoundSignature(config, round, signature) {
  const d = config.drand;

  if (d.schemeID && d.schemeID !== 'bls-unchained-g1-rfc9380') {
    return {
      ok: false,
      reason:
        `本模組僅實作 bls-unchained-g1-rfc9380，設定的 schemeID 為 ${d.schemeID}。` +
        `更換鏈時必須一併確認簽章群組與 DST，不可沿用。`,
    };
  }
  if (!d.publicKey || !d.signatureDST) {
    return { ok: false, reason: 'config.drand 缺少 publicKey 或 signatureDST' };
  }

  let bls;
  try {
    bls = await loadBls();
  } catch (e) {
    return { ok: false, reason: `無法載入 @noble/curves：${e.message}` };
  }

  try {
    const msg = messageForRound(round);
    const point = bls.shortSignatures.hash(new Uint8Array(msg), d.signatureDST);
    const ok = bls.shortSignatures.verify(hexToBytes(signature), point, hexToBytes(d.publicKey));
    return ok
      ? { ok: true, reason: null }
      : { ok: false, reason: `第 ${round} 輪的簽章未通過鏈公鑰驗證` };
  } catch (e) {
    // 竄改的簽章通常不是合法曲線點，noble 會擲出例外。
    // 這是驗證失敗，不是系統故障，必須以失敗回報而非讓流程崩潰。
    return { ok: false, reason: `第 ${round} 輪的簽章無法解析或不在正確的子群內：${e.message}` };
  }
}

/** 驗證一筆抽籤紀錄中的 drand 資料 */
export async function verifyRecordDrand(config, record) {
  if (!record.drand) {
    return { ok: false, skipped: true, reason: '本筆紀錄沒有 drand 資料' };
  }
  if (record.drand.chainHash !== config.drand.chainHash) {
    return {
      ok: false,
      skipped: false,
      reason:
        `紀錄使用的鏈雜湊 ${record.drand.chainHash} 與目前設定不同。` +
        `若曾更換亂數燈塔，須以當時的鏈公鑰驗證。`,
    };
  }
  const r = await verifyRoundSignature(config, record.drand.round, record.drand.signature);
  return { ...r, skipped: false };
}
