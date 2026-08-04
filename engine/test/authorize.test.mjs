/**
 * 授權比對測試
 * SPEC.md §8.2 第 3 層、§14 測試項目 32～34
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkOperator, loadOperators } from '../state.mjs';

const OPS = {
  schemaVersion: 1,
  operators: [
    { githubLogin: 'Caf555', displayName: '系統管理者', role: 'ADMIN', validFrom: '2026-08-01', validTo: null },
    { githubLogin: 'clerk-wang', displayName: '王書記官', role: 'DRAW_OPERATOR', validFrom: '2026-08-01', validTo: null },
    { githubLogin: 'clerk-lee', displayName: '李書記官', role: 'DRAW_OPERATOR', validFrom: '2026-08-01', validTo: '2026-08-31' },
    { githubLogin: 'future-guy', displayName: '未到職', role: 'DRAW_OPERATOR', validFrom: '2026-12-01', validTo: null },
  ],
};

const TODAY = '2026-09-15';

describe('授權比對（SPEC §14 測試 32～34）', () => {
  test('帳號大小寫不同仍應通過（GitHub 帳號大小寫不敏感）', () => {
    // github.actor 回傳註冊時的正規大小寫，清單裡若寫成別的大小寫不應影響授權。
    // 實機首次測試即因精確比對而被誤拒。
    for (const login of ['Caf555', 'caf555', 'CAF555', 'CaF555']) {
      const r = checkOperator(OPS, login, 'DRAW_OPERATOR', TODAY);
      assert.equal(r.allowed, true, `${login} 應通過授權`);
      assert.equal(r.operator.displayName, '系統管理者');
    }
  });

  test('#32 不在清單內 → 拒絕', () => {
    const r = checkOperator(OPS, 'stranger', 'DRAW_OPERATOR', TODAY);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /不在授權清單/);
  });

  test('#33 授權已到期 → 拒絕', () => {
    const r = checkOperator(OPS, 'clerk-lee', 'DRAW_OPERATOR', TODAY);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /到期/);
  });

  test('#33b 授權尚未生效 → 拒絕', () => {
    const r = checkOperator(OPS, 'future-guy', 'DRAW_OPERATOR', TODAY);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /起生效/);
  });

  test('#33c 到期日當天仍有效（validTo 為包含當日）', () => {
    assert.equal(checkOperator(OPS, 'clerk-lee', 'DRAW_OPERATOR', '2026-08-31').allowed, true);
    assert.equal(checkOperator(OPS, 'clerk-lee', 'DRAW_OPERATOR', '2026-09-01').allowed, false);
  });

  test('#34 DRAW_OPERATOR 不得執行需要 ADMIN 的作業', () => {
    const r = checkOperator(OPS, 'clerk-wang', 'ADMIN', TODAY);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /角色/);
  });

  test('#34b ADMIN 可執行 DRAW_OPERATOR 的作業', () => {
    assert.equal(checkOperator(OPS, 'Caf555', 'DRAW_OPERATOR', TODAY).allowed, true);
    assert.equal(checkOperator(OPS, 'Caf555', 'ADMIN', TODAY).allowed, true);
  });

  test('空白或 undefined 的帳號 → 拒絕（不得因此誤配到清單首筆）', () => {
    for (const bad of ['', null, undefined]) {
      assert.equal(checkOperator(OPS, bad, 'DRAW_OPERATOR', TODAY).allowed, false);
    }
  });

  test('正式 data/operators.json 中的帳號可通過授權', () => {
    const real = loadOperators();
    assert.ok(real.operators.length > 0, '授權清單不得為空，否則無人能抽籤');
    for (const o of real.operators) {
      if (o.validTo) continue;
      const r = checkOperator(real, o.githubLogin, 'DRAW_OPERATOR');
      assert.equal(r.allowed, true, `${o.githubLogin} 應可通過授權，實際：${r.reason}`);
    }
  });
});
