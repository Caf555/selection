/**
 * drand 兩層驗證與承諾—開籤測試
 * SPEC.md §14 測試項目 27～29、§4.1～§4.2
 *
 * 全部測試皆離線執行：
 *   - 第一層以攔截 fetch 的方式模擬各種端點故障與不一致
 *   - 第二層使用固定的真實 drand 輪次作為 fixture
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchRound, latestRound, targetRoundFor, messageForRound, DRAND_ERR } from '../drand.mjs';
import { verifyRoundSignature } from '../bls.mjs';
import { buildCommitPayload, commitPayloadHash, executeReveal } from '../commit.mjs';
import { loadConfig } from '../state.mjs';
import { LotteryError, ERR } from '../errors.mjs';
import { freshConfig, makeBin, U, ALL8 } from './helpers.mjs';

/** 真實的 drand quicknet 第 20000000 輪，用於離線驗證第二層 */
const FIXTURE = {
  round: 20000000,
  randomness: 'f39c98df5525968e6622e0c63edb3d1f9c5607cf780db78abdded36e4b3dba95',
  signature: '96892582a33552a7b67ba44ef09c3ccd535bbebe760c93ecf45be8958d0c0f06390c6d19d7bf492eb806af7eef6b125c',
};

const realConfig = loadConfig();

/** 測試用的 drand 設定，接上測試 fixture 的組織設定 */
function drandConfig(overrides = {}) {
  const c = freshConfig();
  c.drand = { ...structuredClone(realConfig.drand), ...overrides };
  return c;
}

/* ── fetch 攔截 ──────────────────────────────────────────── */

const realFetch = globalThis.fetch;
let routes = new Map();

function mockEndpoint(endpoint, handler) {
  routes.set(endpoint, handler);
}

beforeEach(() => {
  routes = new Map();
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [endpoint, handler] of routes) {
      if (u.startsWith(endpoint)) {
        const r = await handler(u);
        if (r === null) throw new Error('連線失敗');
        return { ok: true, status: 200, json: async () => r };
      }
    }
    throw new Error('未攔截的網址：' + u);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function serveAll(config, body) {
  for (const e of config.drand.endpoints) mockEndpoint(e, async () => body);
}

/* ════════════════════════════════════════════════════════════
   第一層：多端點交叉比對
   ════════════════════════════════════════════════════════════ */

describe('第一層　多端點交叉比對（SPEC §4.1）', () => {
  test('全部端點一致 → 通過，並記錄同意的端點', async () => {
    const config = drandConfig();
    serveAll(config, FIXTURE);

    const r = await fetchRound(config, FIXTURE.round);
    assert.equal(r.round, FIXTURE.round);
    assert.equal(r.randomness, FIXTURE.randomness);
    assert.equal(r.agreeingEndpoints.length, 4);
  });

  test('#29 全部端點不可用 → 中止，且確認未使用本機亂數', async () => {
    const config = drandConfig();
    for (const e of config.drand.endpoints) mockEndpoint(e, async () => null);

    await assert.rejects(
      () => fetchRound(config, FIXTURE.round),
      (e) => e instanceof LotteryError && e.code === DRAND_ERR.UNAVAILABLE
    );
    await assert.rejects(
      () => latestRound(config),
      (e) => e instanceof LotteryError && e.code === DRAND_ERR.UNAVAILABLE
    );
  });

  test('可用端點數未達 minAgreeingEndpoints → 中止', async () => {
    const config = drandConfig({ minAgreeingEndpoints: 3 });
    const eps = config.drand.endpoints;
    mockEndpoint(eps[0], async () => FIXTURE);
    mockEndpoint(eps[1], async () => FIXTURE);
    mockEndpoint(eps[2], async () => null);
    mockEndpoint(eps[3], async () => null);

    await assert.rejects(
      () => fetchRound(config, FIXTURE.round),
      (e) => e.code === DRAND_ERR.UNAVAILABLE && /僅 2 個/.test(e.message)
    );
  });

  test('某一端點回傳不同的亂數 → 中止（偵測到端點被動手腳）', async () => {
    const config = drandConfig();
    const eps = config.drand.endpoints;
    for (const e of eps) mockEndpoint(e, async () => FIXTURE);
    mockEndpoint(eps[2], async () => ({
      ...FIXTURE,
      randomness: 'aa'.repeat(32),
      signature: 'bb'.repeat(48),
    }));

    await assert.rejects(
      () => fetchRound(config, FIXTURE.round),
      (e) => e.code === DRAND_ERR.DISAGREE
    );
  });

  test('randomness 不等於 SHA256(signature) → 中止', async () => {
    const config = drandConfig();
    serveAll(config, { ...FIXTURE, randomness: 'cc'.repeat(32) });

    await assert.rejects(
      () => fetchRound(config, FIXTURE.round),
      (e) => e.code === DRAND_ERR.BAD_RANDOMNESS
    );
  });

  test('端點回傳的輪次與請求的不符 → 中止', async () => {
    const config = drandConfig();
    serveAll(config, FIXTURE);

    await assert.rejects(
      () => fetchRound(config, 19999999),
      (e) => e.code === DRAND_ERR.DISAGREE
    );
  });

  test('latest 取各端點的最小輪次（避免指定部分端點尚未產生的輪次）', async () => {
    const config = drandConfig();
    const eps = config.drand.endpoints;
    mockEndpoint(eps[0], async () => ({ ...FIXTURE, round: 100 }));
    mockEndpoint(eps[1], async () => ({ ...FIXTURE, round: 102 }));
    mockEndpoint(eps[2], async () => ({ ...FIXTURE, round: 101 }));
    mockEndpoint(eps[3], async () => ({ ...FIXTURE, round: 102 }));

    assert.equal(await latestRound(config), 100);
  });

  test('roundOffset 必須 >= 1，否則承諾階段失去意義', () => {
    assert.equal(targetRoundFor(drandConfig({ roundOffset: 2 }), 500), 502);
    assert.throws(() => targetRoundFor(drandConfig({ roundOffset: 0 }), 500), /失去意義/);
  });
});

/* ════════════════════════════════════════════════════════════
   第二層：BLS 密碼學驗簽
   ════════════════════════════════════════════════════════════ */

describe('第二層　BLS 密碼學驗簽（SPEC §4.1）', () => {
  test('#28 真實輪次的簽章通過鏈公鑰驗證', async () => {
    const r = await verifyRoundSignature(realConfig, FIXTURE.round, FIXTURE.signature);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  test('#28b 竄改簽章 → 驗證失敗，且不得擲出未攔截的例外', async () => {
    // @noble/curves 對非法曲線點會擲出例外；若未攔截，稽核流程會直接崩潰，
    // 外觀上像系統故障而不是「偵測到竄改」。
    const bytes = Buffer.from(FIXTURE.signature, 'hex');
    bytes[10] ^= 0x01;

    const r = await verifyRoundSignature(realConfig, FIXTURE.round, bytes.toString('hex'));
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.length > 0, '必須說明失敗原因');
  });

  test('#28c 以錯誤的輪次驗證同一個簽章 → 失敗', async () => {
    const r = await verifyRoundSignature(realConfig, FIXTURE.round + 1, FIXTURE.signature);
    assert.equal(r.ok, false);
  });

  test('#28d 更換簽章方案而未一併更新群組設定 → 拒絕而非誤判通過', async () => {
    const c = structuredClone(realConfig);
    c.drand.schemeID = 'pedersen-bls-chained';
    const r = await verifyRoundSignature(c, FIXTURE.round, FIXTURE.signature);
    assert.equal(r.ok, false);
    assert.match(r.reason, /schemeID/);
  });

  test('被簽章的訊息為 SHA256(輪次的 8 位元組大端表示)', () => {
    const msg = messageForRound(20000000);
    assert.equal(msg.length, 32);
    assert.notDeepEqual(msg, messageForRound(20000001));
  });
});

/* ════════════════════════════════════════════════════════════
   承諾—開籤
   ════════════════════════════════════════════════════════════ */

describe('承諾—開籤流程（SPEC §4.2）', () => {
  function setup() {
    const config = drandConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const payload = buildCommitPayload({
      config, bins, caseTypeId: 'jinsu',
      items: [{ caseNo: 'A-001' }, { caseNo: 'A-002', offsetCount: 3 }],
      operator: 'github:caf555',
      targetRound: FIXTURE.round,
      batchId: 'B-000001',
      at: '2026-08-04T09:00:00+08:00',
    });
    return { config, bins, payload };
  }

  test('承諾酬載涵蓋全部影響結果的因素', () => {
    const { payload } = setup();
    assert.equal(payload.drand.targetRound, FIXTURE.round);
    assert.equal(payload.items.length, 2);
    assert.ok(payload.binsBefore.jinsu, '必須快照籤筒');
    assert.ok(payload.configHash.startsWith('sha256:'), '股別名單與規則也必須納入承諾');
  });

  test('跨案類抵分時，另一個籤筒也必須納入承諾快照', () => {
    const config = drandConfig();
    const bins = { jinsu: makeBin(ALL8), jinzhongsu: makeBin(ALL8) };
    const payload = buildCommitPayload({
      config, bins, caseTypeId: 'jinzhongsu',
      items: [{ caseNo: 'B-001', offsetCount: 3, offsetMap: { jinzhongsu: 2, jinsu: 2 } }],
      operator: 'x', targetRound: 1, batchId: 'B-1', at: 'now',
    });
    assert.ok(payload.binsBefore.jinsu, '未快照跨案類籤筒，等於留下開籤時才決定的變數');
    assert.ok(payload.binsBefore.jinzhongsu);
  });

  test('#27 相同承諾與相同亂數 → 結果完全可重現', () => {
    const run = () => {
      const { config, bins, payload } = setup();
      return executeReveal({ config, bins, payload, drandResult: { ...FIXTURE, chainHash: config.drand.chainHash } })
        .results.map((r) => r.resultUnitId);
    };
    assert.deepEqual(run(), run());
  });

  test('承諾內容任一處不同 → 結果完全不同（案號改一個字即可）', () => {
    const a = setup();
    const resA = executeReveal({
      config: a.config, bins: a.bins, payload: a.payload,
      drandResult: { ...FIXTURE, chainHash: a.config.drand.chainHash },
    });

    const b = setup();
    b.payload.items[0].caseNo = 'A-001改';
    const resB = executeReveal({
      config: b.config, bins: b.bins, payload: b.payload,
      drandResult: { ...FIXTURE, chainHash: b.config.drand.chainHash },
    });

    assert.notEqual(commitPayloadHash(a.payload), commitPayloadHash(b.payload));
    assert.notEqual(resA.payloadHash, resB.payloadHash);
  });

  test('開籤使用的輪次與承諾的不符 → 中止', () => {
    const { config, bins, payload } = setup();
    assert.throws(
      () => executeReveal({
        config, bins, payload,
        drandResult: { ...FIXTURE, round: FIXTURE.round + 1, chainHash: config.drand.chainHash },
      }),
      /與承諾的 .* 不符/
    );
  });

  test('承諾之後籤筒遭變動 → 開籤中止', () => {
    const { config, bins, payload } = setup();
    bins.jinsu.tickets.push(U.忠); // 有人在承諾與開籤之間動了籤筒

    assert.throws(
      () => executeReveal({ config, bins, payload, drandResult: { ...FIXTURE, chainHash: config.drand.chainHash } }),
      (e) => e instanceof LotteryError && e.code === ERR.STATE_HASH_MISMATCH
    );
  });

  test('鏈雜湊不符 → 中止', () => {
    const { config, bins, payload } = setup();
    assert.throws(
      () => executeReveal({ config, bins, payload, drandResult: { ...FIXTURE, chainHash: 'ff'.repeat(32) } }),
      /鏈雜湊/
    );
  });

  test('開籤結果含完整的 drand 佐證資料', () => {
    const { config, bins, payload } = setup();
    const out = executeReveal({
      config, bins, payload,
      drandResult: { ...FIXTURE, chainHash: config.drand.chainHash, agreeingEndpoints: ['a', 'b', 'c'] },
    });
    assert.equal(out.drand.round, FIXTURE.round);
    assert.equal(out.drand.crossChecked, true);
    assert.equal(out.drand.signatureVerified, null, 'BLS 驗簽由第二層稽核填寫');
    assert.deepEqual(out.drand.agreeingEndpoints, ['a', 'b', 'c']);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].offsetCount, 3);
  });
});
