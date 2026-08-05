/**
 * 抽籤結果通知
 * SPEC.md §10.2
 *
 * ── 重要原則 ─────────────────────────────────────────────────
 *
 * **推播失敗絕不可中止抽籤。**
 * 抽籤結果在此之前就已寫入並推送完成，是既成事實。若因為 LINE 額度用盡、
 * 網路不通或權杖過期就讓工作流程失敗，操作者會以為抽籤沒成功而重抽，
 * 那會再消耗一支籤、扭曲籤筒——通知的問題不該演變成分案的問題。
 *
 * 因此本模組的所有函式都只回報結果，不擲出例外。
 *
 * ── LINE Notify 已終止服務 ───────────────────────────────────
 *
 * LINE Notify 已於 2025-03-31 終止，本模組改用 LINE Messaging API
 * （LINE 官方帳號）。設定步驟見 README。
 */

import { terms } from './terms.mjs';

const LINE_PUSH = 'https://api.line.me/v2/bot/message/push';
const LINE_BROADCAST = 'https://api.line.me/v2/bot/message/broadcast';

/**
 * 組出通知文字
 * @param {object} args { config, records, dashboardUrl, includeCaseNo }
 */
export function buildMessage({ config, records, dashboardUrl, includeCaseNo = true }) {
  if (records.length === 0) return null;

  const ct = (id) => config.caseTypes.find((c) => c.id === id)?.name ?? id;
  const T = terms(config);
  const head = records.length === 1 ? `【${T.drawee}抽籤結果】` : `【${T.drawee}抽籤結果】共 ${records.length} 件`;

  const lines = [head, ''];

  if (includeCaseNo) {
    for (const r of records) {
      lines.push(`${ct(r.caseTypeId)}　${r.caseNo}` +
        (r.requesterUnitName ? `（${T.requester}：${r.requesterUnitName}）` : ''));
      lines.push(`　${T.action}　${r.resultCourtName} ${r.resultUnitName}` +
        (r.offsetCount > 1 ? `（抵 ${r.offsetCount} 件）` : ''));
    }
  } else {
    // 案號不外流時只推摘要，仍讓收訊者知道有新的分案
    const byType = {};
    for (const r of records) byType[r.caseTypeId] = (byType[r.caseTypeId] ?? 0) + 1;
    for (const [id, n] of Object.entries(byType)) lines.push(`${ct(id)}　${n} 件`);
    lines.push('');
    lines.push('（依規定不於通知中揭露案號，請至看板查閱）');
  }

  const at = records[records.length - 1].at;
  lines.push('');
  lines.push(`時間：${String(at).slice(0, 16).replace('T', ' ')}`);
  if (records[0].drand?.round) lines.push(`公共亂數：drand 第 ${records[0].drand.round} 輪`);
  if (dashboardUrl) {
    lines.push('');
    lines.push(`查詢與驗證：${dashboardUrl}`);
  }

  const text = lines.join('\n');
  return text.length > 4900 ? text.slice(0, 4890) + '\n…（內容過長，請至看板查閱）' : text;
}

/** 送出單一請求，將各種失敗一律轉為可回報的結果 */
async function post(url, token, body, label) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { ok: true };

    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.message) detail += `：${j.message}`;
    } catch { /* 部分錯誤回應沒有內容 */ }
    return { ok: false, problem: `${label} 失敗（${detail}）` };
  } catch (e) {
    return { ok: false, problem: `${label} 例外：${e.message}` };
  }
}

/**
 * 推播抽籤結果。
 *
 * 兩種模式（config.notify.line.mode）：
 *
 *   broadcast（預設）推播給所有將官方帳號加為好友的人。
 *                    **不需要 groupId、不需要 webhook**，設定最單純。
 *   push             推播至指定群組，需要 groupId。
 *                    LINE 未提供列出群組的 API，groupId 只能自 webhook 事件取得
 *                    （見 tools/get-group-id.mjs），設定較繁瑣。
 *
 * @returns {Promise<{sent:number, failed:number, skipped:boolean, mode:string, problems:string[]}>}
 *          任何情況都不擲出例外——推播失敗不得影響已完成的分案。
 */
export async function sendLine({ config, text, token, groupIds }) {
  const cfg = config.notify?.line ?? {};
  const mode = cfg.mode === 'push' ? 'push' : 'broadcast';
  const result = { sent: 0, failed: 0, skipped: false, mode, problems: [] };

  if (!cfg.enabled) {
    result.skipped = true;
    result.problems.push('config.notify.line.enabled 為 false，未推播');
    return result;
  }
  if (!text) {
    result.skipped = true;
    result.problems.push('沒有可推播的內容');
    return result;
  }
  if (!token) {
    result.skipped = true;
    result.problems.push('未設定 LINE_CHANNEL_TOKEN（Actions Secret），未推播');
    return result;
  }

  const messages = [{ type: 'text', text }];

  if (mode === 'broadcast') {
    const r = await post(LINE_BROADCAST, token, { messages }, '廣播');
    if (r.ok) result.sent = 1;
    else { result.failed = 1; result.problems.push(r.problem); }
    return result;
  }

  const targets = (groupIds ?? []).filter(Boolean);
  if (targets.length === 0) {
    result.skipped = true;
    result.problems.push(
      '未設定 LINE_GROUP_IDS（Actions Secret），未推播。' +
      '若不想處理群組 ID，可將 config.notify.line.mode 設為 broadcast'
    );
    return result;
  }

  for (const to of targets) {
    // 目標 ID 可能含群組識別資訊，訊息中只保留末四碼供辨識
    const r = await post(LINE_PUSH, token, { to, messages }, `推播至 …${String(to).slice(-4)}`);
    if (r.ok) result.sent += 1;
    else { result.failed += 1; result.problems.push(r.problem); }
  }

  return result;
}

/** 自環境變數讀取設定（GitHub Actions Secret） */
export function lineCredentialsFromEnv(env = process.env) {
  return {
    token: env.LINE_CHANNEL_TOKEN || null,
    groupIds: (env.LINE_GROUP_IDS || '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
