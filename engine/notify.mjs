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

const LINE_PUSH = 'https://api.line.me/v2/bot/message/push';

/**
 * 組出通知文字
 * @param {object} args { config, records, dashboardUrl, includeCaseNo }
 */
export function buildMessage({ config, records, dashboardUrl, includeCaseNo = true }) {
  if (records.length === 0) return null;

  const ct = (id) => config.caseTypes.find((c) => c.id === id)?.name ?? id;
  const head = records.length === 1 ? '【分案抽籤結果】' : `【分案抽籤結果】共 ${records.length} 件`;

  const lines = [head, ''];

  if (includeCaseNo) {
    for (const r of records) {
      lines.push(`${ct(r.caseTypeId)}　${r.caseNo}`);
      lines.push(`　→　${r.resultCourtName} ${r.resultUnitName}` +
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

/**
 * 推播至 LINE 群組。
 *
 * @returns {Promise<{sent:number, failed:number, skipped:boolean, problems:string[]}>}
 *          任何情況都不擲出例外。
 */
export async function sendLine({ config, text, token, groupIds }) {
  const cfg = config.notify?.line ?? {};
  const result = { sent: 0, failed: 0, skipped: false, problems: [] };

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
  const targets = (groupIds ?? []).filter(Boolean);
  if (targets.length === 0) {
    result.skipped = true;
    result.problems.push('未設定 LINE_GROUP_IDS（Actions Secret），未推播');
    return result;
  }

  for (const to of targets) {
    try {
      const res = await fetch(LINE_PUSH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        result.sent += 1;
      } else {
        result.failed += 1;
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.message) detail += `：${body.message}`;
        } catch { /* 部分錯誤回應沒有內容 */ }
        // 目標 ID 可能含群組識別資訊，只保留末四碼供辨識
        result.problems.push(`推播至 …${String(to).slice(-4)} 失敗（${detail}）`);
      }
    } catch (e) {
      result.failed += 1;
      result.problems.push(`推播至 …${String(to).slice(-4)} 例外：${e.message}`);
    }
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
