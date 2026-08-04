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

/** 發動指定的工作流程 */
export async function dispatchWorkflow(config, token, workflowFile, inputs) {
  const g = config.github;
  await call(token, `/repos/${g.owner}/${g.repo}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: g.branch, inputs }),
  });
}

/** 發動抽籤工作流程 */
export async function dispatchDraw(config, token, inputs) {
  return dispatchWorkflow(config, token, config.github.workflowFile, inputs);
}

/**
 * 找出剛才發動的那一次執行。
 *
 * GitHub 的 dispatch API 不回傳 run id，只能事後比對。
 * 以「建立時間晚於發動時刻」篩選，並扣掉 60 秒容許伺服器時鐘差。
 */
export async function findRun(config, token, sinceMs, { attempts = 20, intervalMs = 3000, workflowFile = null } = {}) {
  const g = config.github;
  const cutoff = sinceMs - 60000;
  const file = workflowFile ?? g.workflowFile;

  for (let i = 0; i < attempts; i++) {
    const data = await call(
      token,
      `/repos/${g.owner}/${g.repo}/actions/workflows/${file}/runs?event=workflow_dispatch&per_page=10`
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
 * 剛抽完的結果會讀到舊的。raw.githubusercontent 快得多。
 *
 * 但 raw 也有 CDN 快取，會出現兩種延遲：
 *   1. 剛推送的內容尚未傳播到邊緣節點
 *   2. repo 由私有轉公開後，先前的 404 仍留在快取中
 * 因此必須重試到「確實看見新紀錄」為止，不能只試一次就報錯。
 *
 * @param {number} minSeq 必須讀到 seq 大於此值的紀錄才算成功
 */
export async function fetchFreshHistory(config, minSeq = -1, { attempts = 12, intervalMs = 2500 } = {}) {
  const g = config.github;
  let lastProblem = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const url = `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${g.branch}/data/history.jsonl?t=${Date.now()}_${i}`;
      const res = await fetch(url, { cache: 'no-store' });

      if (res.ok) {
        const text = await res.text();
        const records = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
        const newest = records.length ? records[records.length - 1].seq : -1;
        if (newest > minSeq) return records;
        lastProblem = `最新紀錄仍是舊的（序號 ${newest}），資料尚未傳播`;
      } else {
        lastProblem = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastProblem = e.message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const e = new Error(
    `抽籤已完成，但暫時讀不到最新紀錄（${lastProblem}）。\n` +
      `結果已經寫入且不會遺失，請至公開看板查看。`
  );
  e.dataLagOnly = true;
  throw e;
}

export function runUrl(config, runId) {
  const g = config.github;
  return `https://github.com/${g.owner}/${g.repo}/actions/runs/${runId}`;
}

/** 某個工作流程的執行頁（供結果頁提供「作廢這筆」的入口） */
export function workflowUrl(config, file) {
  const g = config.github;
  return `https://github.com/${g.owner}/${g.repo}/actions/workflows/${file}`;
}
