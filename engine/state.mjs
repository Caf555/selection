/**
 * 資料檔讀寫與完整性驗證
 * SPEC.md §6.1～§6.3、§8.3
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashObject } from './hash.mjs';
import { parseJsonl, verifyChain } from './records.mjs';
import { createAllBins } from './lottery.mjs';
import { LotteryError, ERR } from './errors.mjs';

export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

const paths = (dir = DATA_DIR) => ({
  config: join(dir, 'config.json'),
  state: join(dir, 'state.json'),
  history: join(dir, 'history.jsonl'),
  operators: join(dir, 'operators.json'),
});

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 寫出 JSON，統一為 2 空格縮排 + LF 換行，使 git diff 可讀 */
function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2).replace(/\r\n/g, '\n') + '\n', 'utf8');
}

export function loadConfig(dir = DATA_DIR) {
  return readJson(paths(dir).config);
}

export function loadOperators(dir = DATA_DIR) {
  const p = paths(dir).operators;
  return existsSync(p) ? readJson(p) : { schemaVersion: 1, operators: [] };
}

export function loadHistory(dir = DATA_DIR) {
  const p = paths(dir).history;
  return existsSync(p) ? parseJsonl(readFileSync(p, 'utf8')) : [];
}

/** 計算並附加 stateHash（SPEC §6.2） */
export function sealState(state) {
  const sealed = { ...state };
  delete sealed.stateHash;
  sealed.stateHash = hashObject(sealed);
  return sealed;
}

export function loadState(dir = DATA_DIR) {
  const p = paths(dir).state;
  if (!existsSync(p)) {
    throw new LotteryError(ERR.STATE_HASH_MISMATCH, `找不到 state.json，請先執行 init`);
  }
  const state = readJson(p);
  const expected = hashObject(state, ['stateHash']);
  if (state.stateHash !== expected) {
    throw new LotteryError(
      ERR.STATE_HASH_MISMATCH,
      `state.json 的雜湊不符，檔案可能已遭直接修改。\n` +
        `  紀錄值：${state.stateHash}\n  重算值：${expected}`
    );
  }
  return state;
}

export function saveState(state, dir = DATA_DIR) {
  writeJson(paths(dir).state, sealState(state));
}

export function appendHistory(record, dir = DATA_DIR) {
  appendFileSync(paths(dir).history, JSON.stringify(record) + '\n', 'utf8');
}

/** 建立初始 state.json */
export function initState(config) {
  const bins = createAllBins(config);
  return sealState({
    schemaVersion: 1,
    seq: 0,
    updatedAt: new Date().toISOString(),
    bins: Object.fromEntries(
      Object.keys(bins).map((k) => [
        k,
        { tickets: bins[k].tickets, cycle: bins[k].cycle, carryOverSkips: bins[k].carryOverSkips, lastRecordId: null },
      ])
    ),
    prevStateHash: null,
  });
}

/**
 * 抽籤前的完整性檢查（SPEC §8.3）
 * 任一項不通過即中止，不得繼續抽籤。
 */
export function verifyIntegrity(dir = DATA_DIR) {
  const problems = [];

  let state = null;
  try {
    state = loadState(dir);
  } catch (e) {
    problems.push(e.message);
  }

  const history = loadHistory(dir);
  const chain = verifyChain(history);
  if (!chain.ok) problems.push(chain.reason);

  if (state && history.length > 0) {
    const last = history[history.length - 1];
    if (last.seq !== state.seq) {
      problems.push(
        `state.json 的序號 ${state.seq} 與歷史最後一筆的序號 ${last.seq} 不一致`
      );
    }
  }

  return { ok: problems.length === 0, problems, recordCount: history.length };
}

/** 個資樣式檢查（SPEC §8.4） */
export function checkPrivacy(config, text) {
  const patterns = config.privacy?.warnOnPatterns ?? [];
  const hits = [];
  for (const p of patterns) {
    const re = new RegExp(p);
    if (re.test(text)) hits.push(p);
  }
  if (hits.length > 0) {
    throw new LotteryError(
      ERR.PRIVACY_VIOLATION,
      `輸入內容疑似含有個人資料（符合樣式 ${hits.join('、')}）。\n` +
        `本 repo 為公開，嚴禁填入當事人姓名、身分證字號等個資（SPEC §8.4）。`,
      { hits }
    );
  }
  return true;
}

/**
 * 檢查操作者授權（SPEC §8.2 第 3 層）
 *
 * 帳號比對必須忽略大小寫：GitHub 帳號本身大小寫不敏感，
 * 但 API 與 github.actor 回傳的是註冊時的正規大小寫（例如 Caf555）。
 * 若在 operators.json 寫成小寫並做精確比對，授權會無故被拒。
 */
export function checkOperator(operators, githubLogin, requiredRole = 'DRAW_OPERATOR', today = null) {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const key = String(githubLogin ?? '').toLowerCase();
  const op = operators.operators.find(
    (o) => String(o.githubLogin ?? '').toLowerCase() === key
  );

  if (!op) return { allowed: false, reason: `${githubLogin} 不在授權清單內` };
  if (op.validFrom && now < op.validFrom) {
    return { allowed: false, reason: `${githubLogin} 的授權自 ${op.validFrom} 起生效` };
  }
  if (op.validTo && now > op.validTo) {
    return { allowed: false, reason: `${githubLogin} 的授權已於 ${op.validTo} 到期` };
  }

  const rank = { DRAW_OPERATOR: 1, ADMIN: 2 };
  if ((rank[op.role] ?? 0) < (rank[requiredRole] ?? 99)) {
    return { allowed: false, reason: `${githubLogin} 的角色為 ${op.role}，需要 ${requiredRole}` };
  }

  return { allowed: true, operator: op };
}

export { paths };
