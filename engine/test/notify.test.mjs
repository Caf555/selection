/**
 * 通知模組測試
 * SPEC.md §10.2
 *
 * 重點在「推播失敗絕不可中止抽籤」：抽籤結果在推播之前就已寫入並推送，
 * 若因通知失敗而讓工作流程失敗，操作者會以為抽籤沒成功而重抽，
 * 那會再消耗一支籤。通知的問題不該演變成分案的問題。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildMessage, sendLine, lineCredentialsFromEnv } from '../notify.mjs';
import { freshConfig } from './helpers.mjs';

function cfg(line = {}) {
  const c = freshConfig();
  c.notify = { web: { enabled: true }, line: { enabled: true, includeCaseNo: true, ...line } };
  return c;
}

const REC = [{
  recordId: 'R-000010', type: 'DRAW', seq: 10,
  at: '2026-08-04T14:57:57.523+08:00',
  caseTypeId: 'jinsu', caseNo: '115金訴-031',
  resultUnitName: '治股', resultCourtName: '第十九庭', offsetCount: 1,
  drand: { round: 31007771 },
}];

describe('通知訊息內容（SPEC §10.2）', () => {
  test('含案號時列出每一件的承辦股', () => {
    const t = buildMessage({ config: cfg(), records: REC, dashboardUrl: 'https://example.test/' });
    assert.match(t, /115金訴-031/);
    assert.match(t, /第十九庭 治股/);
    assert.match(t, /drand 第 31007771 輪/);
    assert.match(t, /https:\/\/example\.test\//);
  });

  test('不含案號時只推摘要，且明確說明原因', () => {
    const t = buildMessage({ config: cfg(), records: REC, dashboardUrl: 'https://example.test/', includeCaseNo: false });
    assert.ok(!t.includes('115金訴-031'), '關閉時不得洩漏案號');
    assert.ok(!t.includes('治股'), '關閉時不得洩漏承辦股');
    assert.match(t, /金訴　1 件/);
    assert.match(t, /不於通知中揭露案號/);
    assert.match(t, /https:\/\/example\.test\//, '仍須提供看板網址');
  });

  test('抵分件數會標示出來', () => {
    const t = buildMessage({ config: cfg(), records: [{ ...REC[0], offsetCount: 3 }] });
    assert.match(t, /抵 3 件/);
  });

  test('批次多件時標示件數', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...REC[0], caseNo: `A-${i}` }));
    const t = buildMessage({ config: cfg(), records: many });
    assert.match(t, /共 5 件/);
  });

  test('內容過長時截斷，不讓 API 因超長而整批失敗', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...REC[0], caseNo: `115年度金訴字第${i}號` }));
    const t = buildMessage({ config: cfg(), records: many });
    assert.ok(t.length <= 4950, `訊息長度 ${t.length} 超過 LINE 上限`);
    assert.match(t, /內容過長/);
  });

  test('沒有紀錄時回傳 null', () => {
    assert.equal(buildMessage({ config: cfg(), records: [] }), null);
  });
});

describe('推播失敗處理（不得中止抽籤）', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('未啟用時跳過且不擲出例外', async () => {
    const c = cfg({ enabled: false });
    const r = await sendLine({ config: c, text: 'x', token: 't', groupIds: ['g'] });
    assert.equal(r.skipped, true);
    assert.equal(r.sent, 0);
  });

  test('缺少權杖或群組時跳過且不擲出例外', async () => {
    const a = await sendLine({ config: cfg(), text: 'x', token: null, groupIds: ['g'] });
    assert.equal(a.skipped, true);
    assert.match(a.problems.join(), /LINE_CHANNEL_TOKEN/);

    const b = await sendLine({ config: cfg(), text: 'x', token: 't', groupIds: [] });
    assert.equal(b.skipped, true);
    assert.match(b.problems.join(), /LINE_GROUP_IDS/);
  });

  test('API 回傳錯誤時記錄失敗但不擲出例外', async () => {
    globalThis.fetch = async () => ({
      ok: false, status: 429,
      json: async () => ({ message: 'You have reached your monthly limit.' }),
    });
    const r = await sendLine({ config: cfg(), text: 'x', token: 't', groupIds: ['Cabc1234'] });
    assert.equal(r.failed, 1);
    assert.equal(r.sent, 0);
    assert.match(r.problems.join(), /429/);
    assert.match(r.problems.join(), /monthly limit/);
  });

  test('網路例外時記錄失敗但不擲出例外', async () => {
    globalThis.fetch = async () => { throw new Error('network unreachable'); };
    const r = await sendLine({ config: cfg(), text: 'x', token: 't', groupIds: ['g1', 'g2'] });
    assert.equal(r.failed, 2);
    assert.match(r.problems.join(), /network unreachable/);
  });

  test('部分成功時如實回報，不因單一群組失敗而全部視為失敗', async () => {
    let n = 0;
    globalThis.fetch = async () => (++n === 1
      ? { ok: true, status: 200, json: async () => ({}) }
      : { ok: false, status: 400, json: async () => ({ message: 'invalid to' }) });

    const r = await sendLine({ config: cfg(), text: 'x', token: 't', groupIds: ['g1', 'g2'] });
    assert.equal(r.sent, 1);
    assert.equal(r.failed, 1);
  });

  test('錯誤訊息不得完整洩漏群組 ID', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
    const secret = 'Cffffffffffffffffffffffffffff9999';
    const r = await sendLine({ config: cfg(), text: 'x', token: 't', groupIds: [secret] });
    assert.ok(!r.problems.join().includes(secret), '完整群組 ID 不應出現在日誌中');
    assert.match(r.problems.join(), /9999/, '應保留末四碼供辨識');
  });

  test('權杖不得出現在任何回報內容中', async () => {
    globalThis.fetch = async () => { throw new Error('boom'); };
    const token = 'SUPER-SECRET-CHANNEL-TOKEN';
    const r = await sendLine({ config: cfg(), text: 'x', token, groupIds: ['g'] });
    assert.ok(!JSON.stringify(r).includes(token));
  });
});

describe('環境變數讀取', () => {
  test('以逗號或空白分隔多個群組 ID', () => {
    assert.deepEqual(
      lineCredentialsFromEnv({ LINE_CHANNEL_TOKEN: 'tok', LINE_GROUP_IDS: 'a, b\nc  d' }),
      { token: 'tok', groupIds: ['a', 'b', 'c', 'd'] }
    );
  });

  test('未設定時回傳空值而非擲出例外', () => {
    assert.deepEqual(lineCredentialsFromEnv({}), { token: null, groupIds: [] });
  });
});
