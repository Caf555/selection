/**
 * 角色用詞測試
 * SPEC.md §2、§13
 *
 * ── 這些測試在保護什麼 ─────────────────────────────────────
 *
 * 抽籤機制（籤筒、輪分、補籤、抵分、迴避）與任務內容無關。本次「為案件抽
 * 支援股」的任務結束後，同一套機制應能改做其他輪分任務，而不必更動已經
 * 驗證過的核心演算法——改程式就意味著要重新驗證整套演算法。
 *
 * 因此角色名稱必須來自設定而非寫死。本檔驗證：改設定確實能改變輸出，
 * 且未設定時仍有合理的預設值。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { terms, DEFAULT_TERMS, EDITABLE_TERMS } from '../terms.mjs';
import { buildMessage } from '../notify.mjs';
import { validateConfig } from '../validate-config.mjs';
import { loadConfig } from '../state.mjs';

const REC = [{
  caseTypeId: 'jinsu', caseNo: 'A-1',
  requesterUnitName: '甲股', resultUnitName: '理股', resultCourtName: '第十六庭',
  offsetCount: 1, at: '2026-08-05T09:00:00+08:00', drand: { round: 1 },
}];

const baseConfig = (terminology) => ({
  caseTypes: [{ id: 'jinsu', name: '金訴', active: true }],
  terminology,
});

describe('角色用詞', () => {
  test('未設定時使用預設值', () => {
    assert.deepEqual(terms({}), DEFAULT_TERMS);
    assert.deepEqual(terms(undefined), DEFAULT_TERMS);
    assert.deepEqual(terms({ terminology: {} }), DEFAULT_TERMS);
  });

  test('部分設定時，未指定的項目仍使用預設值', () => {
    const t = terms({ terminology: { drawee: '值班股' } });
    assert.equal(t.drawee, '值班股');
    assert.equal(t.requester, DEFAULT_TERMS.requester, '未指定者應保留預設');
  });

  test('空字串或只含空白視為未設定，不會產生空白標籤', () => {
    // 若直接採用空白字串，畫面上會出現沒有標題的欄位，讀者無從得知那一欄是什麼
    const t = terms({ terminology: { drawee: '', requester: '   ', action: '\t\n' } });
    assert.equal(t.drawee, DEFAULT_TERMS.drawee);
    assert.equal(t.requester, DEFAULT_TERMS.requester);
    assert.equal(t.action, DEFAULT_TERMS.action);
  });

  test('用詞前後的空白會被去除', () => {
    assert.equal(terms({ terminology: { drawee: '  值班股  ' } }).drawee, '值班股');
  });

  test('改用詞即可改變通知內容，不需改程式', () => {
    const before = buildMessage({ config: baseConfig(undefined), records: REC });
    assert.match(before, /支援股抽籤結果/);
    assert.match(before, /承辦股：甲股/);

    const after = buildMessage({
      config: baseConfig({ requester: '請假股', drawee: '值班股', action: '代班' }),
      records: REC,
    });
    assert.match(after, /值班股抽籤結果/);
    assert.match(after, /請假股：甲股/);
    assert.match(after, /代班/);
    assert.ok(!after.includes('支援股'), '舊用詞不應殘留');
    assert.ok(!after.includes('承辦股'), '舊用詞不應殘留');
  });

  test('可修改的用詞欄位與預設值的鍵一致', () => {
    assert.deepEqual(EDITABLE_TERMS.slice().sort(), Object.keys(DEFAULT_TERMS).sort());
  });
});

describe('用詞設定的驗證', () => {
  const withTerms = (terminology) => {
    const c = structuredClone(loadConfig());
    c.terminology = terminology;
    return validateConfig(c);
  };

  test('正式設定的用詞通過驗證', () => {
    assert.deepEqual(validateConfig(loadConfig()), []);
  });

  test('兩種角色名稱相同 → 拒絕', () => {
    // 名稱相同會使畫面上兩欄同名，讀者無法分辨哪一欄是抽出來的
    const p = withTerms({ requester: '甲股', drawee: '甲股' });
    assert.ok(p.some((x) => /不得相同/.test(x)), p.join('；'));
  });

  test('空字串或過長 → 拒絕', () => {
    assert.ok(withTerms({ drawee: '' }).some((x) => /不得為空/.test(x)));
    assert.ok(withTerms({ drawee: 'x'.repeat(21) }).some((x) => /過長/.test(x)));
  });

  test('未知欄位 → 拒絕（避免打錯欄位名而默默不生效）', () => {
    assert.ok(withTerms({ drawe: '值班股' }).some((x) => /未知欄位/.test(x)));
  });

  test('terminology 不是物件 → 拒絕', () => {
    assert.ok(withTerms(['x']).some((x) => /必須是物件/.test(x)));
  });
});

describe('畫面不得寫死角色名稱', () => {
  const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
  const pages = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

  test('顯示用的角色名稱一律取自設定', () => {
    // 允許出現在註解與說明性散文中，但不得作為欄位標題或標籤直接寫死，
    // 否則改設定後畫面會出現新舊用詞並存的情形。
    const HARDCODED = [
      /<th scope="col">承辦股<\/th>/,
      /<th scope="col">支援股<\/th>/,
      /<label[^>]*>承辦股<\/label>/,
      /<label[^>]*>支援股<\/label>/,
      /<h2 class="sec">支援統計<\/h2>/,
    ];
    const bad = [];
    for (const f of pages) {
      const text = readFileSync(join(PUBLIC_DIR, f), 'utf8');
      for (const re of HARDCODED) {
        if (re.test(text)) bad.push(`${f}　${re}`);
      }
    }
    assert.deepEqual(bad, [],
      '下列位置把角色名稱寫死了，改設定後會與其他地方不一致：\n  ' + bad.join('\n  '));
  });
});
