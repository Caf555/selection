/**
 * GitHub API 用戶端（抽籤台專用）
 * SPEC.md §8.2、§11.1
 *
 * ── 權杖的處理原則 ─────────────────────────────────────────
 *
 * 1. 權杖只存在操作者自己電腦的 localStorage，不經任何第三方伺服器。
 * 2. **絕不放進網址、絕不寫入 console、絕不隨錯誤訊息輸出。**
 *    網址會留在瀏覽歷史、書籤與伺服器日誌裡。
 * 3. 權杖只需要 `Actions: Read and write` 一項權限。
 *    刻意不要 `Contents` 權限 —— 持有者因此在技術上無法修改任何資料檔，
 *    只能發動抽籤。這是整個權限設計的關鍵。
 */

const API = 'https://api.github.com';
const TOKEN_KEY = 'court-lottery.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t.trim());
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** 將 GitHub 的錯誤碼轉成操作者看得懂的說明 */
function explain(status, body) {
  switch (status) {
    case 401:
      return '權杖無效或已過期。請重新申請一組新的權杖。';
    case 403:
      return '權杖有效，但權限不足或已被撤銷。請確認權杖有勾選 Actions: Read and write。';
    case 404:
      return '找不到 repo 或抽籤工作流程。請確認權杖的 Repository access 有選到本 repo。';
    case 422:
      return `輸入內容被 GitHub 拒絕：${body?.message ?? '參數不正確'}`;
    default:
      return `GitHub 回應 HTTP ${status}${body?.message ? '：' + body.message : ''}`;
  }
}

async function call(token, path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...headers(token), ...(init.headers ?? {}) } });
  if (res.status === 204) return null;

  let body = null;
  try {
    body = await res.json();
  } catch { /* 部分回應沒有內容 */ }

  if (!res.ok) {
    const err = new Error(explain(res.status, body));
    err.status = res.status;
    throw err;
  }
  return body;
}

/** 驗證權杖可用，並回傳登入帳號 */
export async function verifyToken(config, token) {
  const g = config.github;
  // 先確認能讀到工作流程 —— 這正是抽籤所需的最低權限
  await call(token, `/repos/${g.owner}/${g.repo}/actions/workflows/${g.workflowFile}`);

  let login = null;
  try {
    const me = await call(token, '/user');
    login = me?.login ?? null;
  } catch {
    // 細粒度權杖可能無 /user 讀取權限，這不影響抽籤
  }
  return { ok: true, login };
}

/** 發動抽籤工作流程 */
export async function dispatchDraw(config, token, inputs) {
  const g = config.github;
  await call(token, `/repos/${g.owner}/${g.repo}/actions/workflows/${g.workflowFile}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: g.branch, inputs }),
  });
}

/**
 * 找出剛才發動的那一次執行。
 *
 * GitHub 的 dispatch API 不回傳 run id，只能事後比對。
 * 以「建立時間晚於發動時刻」篩選，並扣掉 60 秒容許伺服器時鐘差。
 */
export async function findRun(config, token, sinceMs, { attempts = 20, intervalMs = 3000 } = {}) {
  const g = config.github;
  const cutoff = sinceMs - 60000;

  for (let i = 0; i < attempts; i++) {
    const data = await call(
      token,
      `/repos/${g.owner}/${g.repo}/actions/workflows/${g.workflowFile}/runs?event=workflow_dispatch&per_page=10`
    );
    const runs = (data?.workflow_runs ?? []).filter((r) => new Date(r.created_at).getTime() >= cutoff);
    if (runs.length > 0) {
      runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return runs[0];
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/** 輪詢執行狀態直到結束 */
export async function waitRun(config, token, runId, { onTick = null, timeoutMs = 600000 } = {}) {
  const g = config.github;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const run = await call(token, `/repos/${g.owner}/${g.repo}/actions/runs/${runId}`);
    if (onTick) onTick(run);
    if (run.status === 'completed') return run;
    if (Date.now() > deadline) {
      const e = new Error('等待執行結果逾時。抽籤可能仍在進行，請查看執行紀錄。');
      e.run = run;
      throw e;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/**
 * 讀取剛寫入的資料。
 *
 * 不從 GitHub Pages 讀 —— 推送後 Pages 需約一分鐘才重新部署，
 * 剛抽完的結果會讀到舊的。raw.githubusercontent 則是即時的。
 */
export async function fetchFreshHistory(config) {
  const g = config.github;
  const url = `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${g.branch}/data/history.jsonl?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? '無法讀取最新紀錄。若 repo 仍為私有，raw 網址需要授權，請直接查看執行紀錄。'
        : `無法讀取最新紀錄（HTTP ${res.status}）`
    );
  }
  const text = await res.text();
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

export function runUrl(config, runId) {
  const g = config.github;
  return `https://github.com/${g.owner}/${g.repo}/actions/runs/${runId}`;
}
