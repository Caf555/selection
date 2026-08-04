/**
 * 前端版本一致性檢查
 *
 * ── 這個測試存在的原因 ─────────────────────────────────────
 *
 * GitHub Pages 會對 HTML 與 JS 設定快取，程式更新後使用者的瀏覽器仍會
 * 繼續執行舊版直到快取過期。實際發生過的後果：舊版抽籤台把「已完成但
 * 暫時讀不到結果」顯示成「抽籤未完成」，操作者照著重抽就會多消耗一支籤、
 * 扭曲籤筒，而且不會察覺。
 *
 * 解法是各頁面內嵌版本號，與 config.json 的 appVersion 比對；不符即提示
 * 重新載入，抽籤台與管理頁更直接阻擋操作。
 *
 * 但這套機制有個前提：修改前端程式時必須記得同步提高兩邊的版本號。
 * 本測試就是在檢查這件事——版本號不一致時，全體使用者都會被誤判為舊版
 * 而無法操作，屬於會癱瘓系統的錯誤。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../state.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const config = loadConfig();
const pages = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

describe('前端版本一致性', () => {
  test('config.json 有 appVersion 且格式正確', () => {
    assert.ok(config.appVersion, 'config.json 缺少 appVersion');
    assert.match(config.appVersion, /^\d+\.\d+\.\d+$/,
      `appVersion 應為 x.y.z 格式，收到「${config.appVersion}」`);
  });

  test('找得到頁面檔（避免路徑錯誤導致測試空轉通過）', () => {
    assert.ok(pages.length >= 5, `只找到 ${pages.length} 個頁面，路徑可能有誤`);
  });

  test('每個頁面都宣告 APP_VERSION，且與 config.appVersion 一致', () => {
    const bad = [];
    for (const f of pages) {
      const text = readFileSync(join(PUBLIC_DIR, f), 'utf8');
      const m = text.match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (!m) { bad.push(`${f}：未宣告 APP_VERSION`); continue; }
      if (m[1] !== config.appVersion) {
        bad.push(`${f}：${m[1]}　但 config.appVersion 為 ${config.appVersion}`);
      }
    }
    assert.deepEqual(bad, [],
      '版本號不一致會使全體使用者被誤判為舊版而無法操作：\n  ' + bad.join('\n  ') +
      '\n\n修改 public/ 底下的檔案後，請同步更新 config.json 的 appVersion 與各頁面的 APP_VERSION。');
  });

  test('會改變狀態的頁面必須以阻擋模式檢查版本', () => {
    // 抽籤台與管理頁若跑舊版程式，可能送出與畫面不符的請求或誘使重抽，
    // 僅提示不足以避免損害，必須直接擋下操作。
    for (const f of ['draw.html', 'admin.html']) {
      const text = readFileSync(join(PUBLIC_DIR, f), 'utf8');
      assert.match(text, /versionBanner\([^)]*blocking:\s*true/s,
        `${f} 應以 { blocking: true } 呼叫 versionBanner`);
    }
  });

  test('唯讀頁面會顯示版本提示', () => {
    for (const f of ['index.html', 'history.html', 'verify.html', 'print.html']) {
      const text = readFileSync(join(PUBLIC_DIR, f), 'utf8');
      assert.match(text, /versionBanner\(/, `${f} 未呼叫 versionBanner`);
    }
  });
});
