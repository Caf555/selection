/**
 * drand 公共亂數燈塔
 * SPEC.md §4.1、§4.2、§4.5
 *
 * 本檔為**抽籤路徑**使用，刻意不引用任何第三方套件。
 * 完整的 BLS 密碼學驗簽在 engine/bls.mjs，由每日稽核與驗證頁執行（第一層／第二層見下）。
 *
 * ── 兩層驗證 ─────────────────────────────────────────────────
 *
 * 第一層（本檔，抽籤當下必做）
 *   1. 同一輪次向多個獨立端點取值，全部回應必須逐位元組完全一致
 *   2. randomness 必須等於 SHA256(signature)（drand 對本鏈的定義）
 *   3. 成功回應數未達 minAgreeingEndpoints → 中止抽籤
 *
 * 第二層（engine/bls.mjs，每日稽核與驗證頁）
 *   以鏈公鑰對簽章做 BLS12-381 配對驗證，提供密碼學上的證明。
 *
 * ── 絕對禁止 ─────────────────────────────────────────────────
 * drand 不可用時**必須中止抽籤**，嚴禁改用本機亂數（SPEC §4.5）。
 * 本檔任何路徑都不會產生亂數，只會取得或失敗。
 */

import { createHash } from 'node:crypto';
import { LotteryError } from './errors.mjs';

export const DRAND_ERR = {
  UNAVAILABLE: 'DRAND_UNAVAILABLE',
  DISAGREE: 'DRAND_DISAGREE',
  BAD_RANDOMNESS: 'DRAND_BAD_RANDOMNESS',
  CHAIN_MISMATCH: 'DRAND_CHAIN_MISMATCH',
  ROUND_NOT_YET: 'DRAND_ROUND_NOT_YET',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new LotteryError(DRAND_ERR.BAD_RANDOMNESS, `不是合法的十六進位字串：${String(hex).slice(0, 32)}`);
  }
  return Buffer.from(hex, 'hex');
}

async function getJson(url, timeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 取得鏈資訊，並確認其雜湊與公鑰與設定相符。
 * 若不相符，代表端點提供的是另一條鏈 —— 必須中止。
 */
export async function fetchChainInfo(config, endpoint) {
  const d = config.drand;
  const info = await getJson(`${endpoint}/${d.chainHash}/info`, d.requestTimeoutMs ?? 8000);

  if (info.hash !== d.chainHash) {
    throw new LotteryError(
      DRAND_ERR.CHAIN_MISMATCH,
      `${endpoint} 回傳的鏈雜湊為 ${info.hash}，與設定的 ${d.chainHash} 不符`
    );
  }
  if (info.public_key !== d.publicKey) {
    throw new LotteryError(
      DRAND_ERR.CHAIN_MISMATCH,
      `${endpoint} 回傳的鏈公鑰與設定不符，可能連到了偽造的端點`
    );
  }
  return info;
}

/**
 * 向單一端點取得指定輪次。
 * round 傳 'latest' 可取最新輪次。
 */
async function fetchRoundFrom(config, endpoint, round) {
  const d = config.drand;
  const path = round === 'latest' ? 'latest' : String(round);
  const j = await getJson(`${endpoint}/${d.chainHash}/public/${path}`, d.requestTimeoutMs ?? 8000);

  if (!j || typeof j.round !== 'number' || !j.signature || !j.randomness) {
    throw new Error('回應格式不正確');
  }
  return { round: j.round, signature: j.signature, randomness: j.randomness, endpoint };
}

/**
 * 取得目前的最新輪次編號。
 *
 * 各端點的最新輪次可能相差一兩輪（出塊傳播有時間差），
 * 故取**最小值**：寧可承諾一個稍舊的基準，也不要指定一個部分端點還沒有的輪次。
 */
export async function latestRound(config) {
  const d = config.drand;
  const results = await Promise.allSettled(
    d.endpoints.map((e) => fetchRoundFrom(config, e, 'latest'))
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);

  if (ok.length === 0) {
    const why = results.map((r, i) => `${d.endpoints[i]}: ${r.reason?.message ?? '失敗'}`).join('；');
    throw new LotteryError(
      DRAND_ERR.UNAVAILABLE,
      `無法連線至任何 drand 端點，抽籤中止。嚴禁改用本機亂數（SPEC §4.5）。\n  ${why}`
    );
  }
  return Math.min(...ok.map((r) => r.round));
}

/**
 * 取得指定輪次，並執行第一層驗證。
 *
 * @returns {{round, signature, randomness, agreeingEndpoints: string[], chainHash}}
 */
export async function fetchRound(config, round) {
  const d = config.drand;
  const minAgree = d.minAgreeingEndpoints ?? 3;

  const results = await Promise.allSettled(
    d.endpoints.map((e) => fetchRoundFrom(config, e, round))
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${d.endpoints[i]}: ${r.reason?.message ?? '失敗'}` : null))
    .filter(Boolean);

  if (ok.length < minAgree) {
    throw new LotteryError(
      DRAND_ERR.UNAVAILABLE,
      `僅 ${ok.length} 個 drand 端點可用，未達要求的 ${minAgree} 個，抽籤中止。\n` +
        `  嚴禁改用本機亂數（SPEC §4.5）。\n  失敗端點：${failed.join('；')}`,
      { round, available: ok.length, required: minAgree }
    );
  }

  // ① 多端點交叉比對：所有回應必須完全一致
  const first = ok[0];
  for (const r of ok) {
    if (r.round !== first.round || r.signature !== first.signature || r.randomness !== first.randomness) {
      throw new LotteryError(
        DRAND_ERR.DISAGREE,
        `drand 端點對第 ${round} 輪的回應不一致，抽籤中止。\n` +
          `  ${first.endpoint} → ${first.randomness}\n  ${r.endpoint} → ${r.randomness}`,
        { round, responses: ok }
      );
    }
  }

  if (round !== 'latest' && first.round !== Number(round)) {
    throw new LotteryError(
      DRAND_ERR.DISAGREE,
      `要求第 ${round} 輪，端點回傳第 ${first.round} 輪`
    );
  }

  // ② randomness 必須等於 SHA256(signature)
  const expected = sha256(hexToBytes(first.signature));
  if (expected !== first.randomness) {
    throw new LotteryError(
      DRAND_ERR.BAD_RANDOMNESS,
      `第 ${first.round} 輪的 randomness 與 SHA256(signature) 不符，資料可能遭竄改。\n` +
        `  回傳值 ${first.randomness}\n  重算值 ${expected}`,
      { round: first.round }
    );
  }

  return {
    round: first.round,
    signature: first.signature,
    randomness: first.randomness,
    chainHash: d.chainHash,
    agreeingEndpoints: ok.map((r) => r.endpoint),
    unavailableEndpoints: failed,
  };
}

/**
 * 等待指定輪次產生後取回。
 *
 * 承諾階段固定的目標輪次在當下尚未存在（roundOffset >= 1），
 * 這正是「結果無人能預知」的來源。此函式負責等到它出現。
 */
export async function waitForRound(config, round, { maxWaitMs = 120000, onWait = null } = {}) {
  const d = config.drand;
  const periodMs = (d.periodSeconds ?? 3) * 1000;
  const deadline = Date.now() + maxWaitMs;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchRound(config, round);
    } catch (e) {
      const notYet =
        e.code === DRAND_ERR.UNAVAILABLE || e.code === DRAND_ERR.DISAGREE;
      if (!notYet || Date.now() >= deadline) {
        if (Date.now() >= deadline) {
          throw new LotteryError(
            DRAND_ERR.ROUND_NOT_YET,
            `等待第 ${round} 輪逾時（${Math.round(maxWaitMs / 1000)} 秒）。` +
              `承諾資料仍在 data/pending/，可用 resume 流程續行，不會產生操控空間。`,
            { round }
          );
        }
        if (!notYet) throw e;
      }
      if (onWait) onWait(attempt, round);
      await new Promise((r) => setTimeout(r, Math.min(periodMs, deadline - Date.now())));
    }
  }
}

/** 依設定計算承諾階段的目標輪次（SPEC §4.2 步驟 2） */
export function targetRoundFor(config, currentRound) {
  const offset = config.drand.roundOffset ?? 2;
  if (!Number.isInteger(offset) || offset < 1) {
    throw new LotteryError(
      DRAND_ERR.CHAIN_MISMATCH,
      `roundOffset 必須 >= 1。若為 0，目標輪次在承諾當下即已存在，` +
        `承諾—開籤流程將完全失去意義。`
    );
  }
  return currentRound + offset;
}

/** 供 bls.mjs 與測試共用：由輪次計算被簽章的訊息 */
export function messageForRound(round) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(round), 0);
  return createHash('sha256').update(buf).digest();
}
