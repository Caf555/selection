#!/usr/bin/env node
/**
 * 組織設定變更的 GitHub Actions 執行腳本
 * SPEC.md §9.2、§13、R-07、R-08
 *
 * ── 為什麼設定變更也要走工作流程 ─────────────────────────────
 *
 * 直接編輯 data/config.json 再 commit 是可行的，但那條路繞過了授權檢查、
 * 繞過了結構驗證，也不會產生 CONFIG_CHANGE 稽核紀錄——分支保護與稽核
 * 都會形同虛設。設定會影響誰能被抽中、每輪放幾支籤，其影響力不亞於抽籤
 * 本身，理當同樣留痕。
 *
 * ── 立即生效（SPEC R-07）────────────────────────────────────
 *
 * 新增股會立即投入其籤、停用股會立即撤出其籤，並執行補籤檢查。
 * 修改每輪籤數則不動現有籤筒，自下次補籤起生效。
 */

import { appendFileSync, writeFileSync } from 'node:fs';

import {
  loadConfig, loadState, loadHistory, loadOperators,
  saveState, appendHistory, verifyIntegrity, checkOperator, checkPrivacy, paths,
} from './state.mjs';
import { addUnit, deactivateUnit, setTicketsPerCycle, createBin } from './lottery.mjs';
import { validateConfig } from './validate-config.mjs';
import { terms, EDITABLE_TERMS } from './terms.mjs';
import { buildAuditRecord, sealRecord } from './records.mjs';
import { LotteryError, ERR } from './errors.mjs';

function say(line = '') {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n', 'utf8');
  }
}

function die(msg) {
  say('');
  say('### ✗ 中止');
  say('');
  say('```');
  say(msg);
  say('```');
  process.exit(1);
}

const IN = {
  actor: process.env.ACTOR ?? '',
  action: (process.env.ACTION ?? '').trim(),
  paramsRaw: process.env.PARAMS ?? '',
  reason: (process.env.REASON ?? '').trim(),
  runUrl: process.env.RUN_URL ?? null,
};

function nowIso() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
}

function binsFromState(state) {
  const out = {};
  for (const k of Object.keys(state.bins)) {
    out[k] = {
      tickets: state.bins[k].tickets.slice(),
      cycle: state.bins[k].cycle,
      carryOverSkips: { ...state.bins[k].carryOverSkips },
    };
  }
  return out;
}

function req(params, ...keys) {
  for (const k of keys) {
    if (params[k] === undefined || params[k] === null || params[k] === '') {
      die(`動作 ${IN.action} 缺少必要參數：${k}`);
    }
  }
}

/* ── 動作實作 ─────────────────────────────────────────────── */

const ACTIONS = {
  'add-court'(config, bins, p) {
    req(p, 'id', 'name');
    if (config.courts.some((c) => c.id === p.id)) die(`庭別 ID 已存在：${p.id}`);
    const order = p.order ?? Math.max(0, ...config.courts.map((c) => c.order)) + 1;
    config.courts.push({
      id: p.id, name: p.name, shortName: p.shortName ?? p.name,
      order, active: true, color: p.color ?? 'blue',
    });
    config.courts.sort((a, b) => a.order - b.order);
    return { summary: `新增庭別 ${p.name}（${p.id}）`, binChanges: [] };
  },

  'rename-court'(config, bins, p) {
    req(p, 'id', 'name');
    const c = config.courts.find((x) => x.id === p.id);
    if (!c) die(`庭別不存在：${p.id}`);
    const from = c.name;
    c.name = p.name;
    if (p.shortName) c.shortName = p.shortName;
    if (p.color) c.color = p.color;
    return { summary: `庭別更名：${from} → ${p.name}`, binChanges: [] };
  },

  'deactivate-court'(config, bins, p) {
    req(p, 'id');
    const c = config.courts.find((x) => x.id === p.id);
    if (!c) die(`庭別不存在：${p.id}`);
    const stillActive = config.units.filter((u) => u.active && u.courtId === p.id);
    if (stillActive.length > 0) {
      die(`庭別 ${c.name} 底下仍有在職股：${stillActive.map((u) => u.name).join('、')}\n` +
          `請先逐一停用這些股，再停用該庭。`);
    }
    c.active = false;
    return { summary: `停用庭別 ${c.name}`, binChanges: [] };
  },

  'add-unit'(config, bins, p) {
    req(p, 'id', 'name', 'courtId');
    const n = p.ticketsPerCycle ?? 1;
    const order = p.order ?? Math.max(0, ...config.units.map((u) => u.order)) + 1;
    const adj = addUnit(config, bins, {
      id: p.id, name: p.name, courtId: p.courtId, order, ticketsPerCycle: n, note: p.note ?? '',
    });
    return {
      summary: `新增股別 ${p.name}（每輪 ${n} 支籤，立即投入現有籤筒）`,
      binChanges: adj,
    };
  },

  'rename-unit'(config, bins, p) {
    req(p, 'id', 'name');
    const u = config.units.find((x) => x.id === p.id);
    if (!u) die(`股別不存在：${p.id}`);
    const from = u.name;
    u.name = p.name;
    return { summary: `股別更名：${from} → ${p.name}`, binChanges: [] };
  },

  'move-unit'(config, bins, p) {
    req(p, 'id', 'courtId');
    const u = config.units.find((x) => x.id === p.id);
    if (!u) die(`股別不存在：${p.id}`);
    const from = config.courts.find((c) => c.id === u.courtId)?.name ?? u.courtId;
    const to = config.courts.find((c) => c.id === p.courtId)?.name ?? p.courtId;
    u.courtId = p.courtId;
    return { summary: `${u.name} 改隸：${from} → ${to}`, binChanges: [] };
  },

  'set-tickets'(config, bins, p) {
    req(p, 'id', 'ticketsPerCycle');
    const n = Number(p.ticketsPerCycle);
    const chg = setTicketsPerCycle(config, p.id, n);
    const u = config.units.find((x) => x.id === p.id);
    return {
      summary: `${u.name} 每輪籤數：${chg.before} → ${chg.after}（不影響現有籤筒，自下次補籤起生效）`,
      binChanges: [],
    };
  },

  'deactivate-unit'(config, bins, p) {
    req(p, 'id');
    const u = config.units.find((x) => x.id === p.id);
    if (!u) die(`股別不存在：${p.id}`);
    if (!u.active) die(`${u.name} 已經是停用狀態`);
    const adj = deactivateUnit(config, bins, p.id);
    return { summary: `停用股別 ${u.name}（其籤立即自籤筒撤出）`, binChanges: adj };
  },

  'reactivate-unit'(config, bins, p) {
    req(p, 'id');
    const u = config.units.find((x) => x.id === p.id);
    if (!u) die(`股別不存在：${p.id}`);
    if (u.active) die(`${u.name} 已經是在職狀態`);
    u.active = true;
    // 復職不立即投籤，自下次補籤起參與，避免本輪受分機率異常偏高
    return {
      summary: `${u.name} 復職（自下次補籤起參與抽籤，本輪不投入籤）`,
      binChanges: [],
    };
  },

  // ── 承辦股 ──
  // 與支援股是兩組不相交的名單：承辦股是案件的承辦單位、需要支援，
  // 不參與支援抽籤，因此新增或停用都不會影響籤筒。

  'add-requester'(config, bins, p) {
    req(p, 'id', 'name');
    config.requesters ??= [];
    if (config.requesters.some((r) => r.id === p.id)) die(`承辦股 ID 已存在：${p.id}`);
    if (config.units.some((u) => u.id === p.id)) {
      die(`${p.id} 已是支援股的 ID。承辦股與支援股必須是不相交的名單。`);
    }
    const order = p.order ?? Math.max(0, ...config.requesters.map((r) => r.order)) + 1;
    config.requesters.push({ id: p.id, name: p.name, order, active: true, note: p.note ?? '' });
    config.requesters.sort((a, b) => a.order - b.order);
    return { summary: `新增承辦股 ${p.name}（${p.id}）`, binChanges: [] };
  },

  'rename-requester'(config, bins, p) {
    req(p, 'id', 'name');
    const r = (config.requesters ?? []).find((x) => x.id === p.id);
    if (!r) die(`承辦股不存在：${p.id}`);
    const from = r.name;
    r.name = p.name;
    return { summary: `承辦股更名：${from} → ${p.name}`, binChanges: [] };
  },

  'deactivate-requester'(config, bins, p) {
    req(p, 'id');
    const r = (config.requesters ?? []).find((x) => x.id === p.id);
    if (!r) die(`承辦股不存在：${p.id}`);
    if (!r.active) die(`${r.name} 已經是停用狀態`);
    r.active = false;
    return { summary: `停用承辦股 ${r.name}（不影響籤筒）`, binChanges: [] };
  },

  'reactivate-requester'(config, bins, p) {
    req(p, 'id');
    const r = (config.requesters ?? []).find((x) => x.id === p.id);
    if (!r) die(`承辦股不存在：${p.id}`);
    if (r.active) die(`${r.name} 已經是在職狀態`);
    r.active = true;
    return { summary: `承辦股 ${r.name} 恢復啟用`, binChanges: [] };
  },

  'add-case-type'(config, bins, p) {
    req(p, 'id', 'name');
    if (config.caseTypes.some((c) => c.id === p.id)) die(`案類 ID 已存在：${p.id}`);
    const order = p.order ?? Math.max(0, ...config.caseTypes.map((c) => c.order)) + 1;
    config.caseTypes.push({ id: p.id, name: p.name, order, active: true });
    config.caseTypes.sort((a, b) => a.order - b.order);
    return { summary: `新增案類 ${p.name}（${p.id}）`, binChanges: [], newBin: p.id };
  },

  'rename-case-type'(config, bins, p) {
    req(p, 'id', 'name');
    const c = config.caseTypes.find((x) => x.id === p.id);
    if (!c) die(`案類不存在：${p.id}`);
    const from = c.name;
    c.name = p.name;
    return { summary: `案類更名：${from} → ${p.name}`, binChanges: [] };
  },

  // ── 角色用詞 ──
  // 抽籤機制與任務內容無關。本次任務結束後若要改做其他輪分任務，
  // 只需改用詞與兩份名單，不必更動已驗證過的核心演算法。
  'set-term'(config, bins, p) {
    req(p, 'key', 'value');
    if (!EDITABLE_TERMS.includes(p.key)) {
      die(`不允許的用詞欄位：${p.key}。可修改的項目：${EDITABLE_TERMS.join('、')}`);
    }
    const value = String(p.value).trim();
    if (!value) die(`用詞不得為空`);
    if (value.length > 20) die(`用詞過長（${value.length} 字），請控制在 20 字以內`);

    config.terminology ??= {};
    const before = terms(config)[p.key];
    config.terminology[p.key] = value;
    return { summary: `用詞 ${p.key}：${before} → ${value}`, binChanges: [] };
  },

  // ── 角色轉換 ──
  // 以單一動作完成「自一份名單移出、加入另一份」，使稽核紀錄能直接看出
  // 這是一次角色調整，而不是兩筆看似無關的變更。
  //
  // 刻意使用新的 ID：歷史紀錄中的舊 ID 已代表舊角色，沿用會使同一個 ID
  // 在不同時期指涉不同身分，日後查核將無從分辨。

  'move-to-requester'(config, bins, p) {
    req(p, 'id', 'newId');
    const u = config.units.find((x) => x.id === p.id);
    if (!u) die(`${terms(config).drawee}不存在：${p.id}`);
    if (!u.active) die(`${u.name} 已停用，無需轉換`);
    config.requesters ??= [];
    if (config.requesters.some((r) => r.id === p.newId)) die(`承辦股 ID 已存在：${p.newId}`);
    if (config.units.some((x) => x.id === p.newId)) die(`${p.newId} 已是抽籤名單的 ID`);

    const adj = deactivateUnit(config, bins, p.id);
    const order = p.order ?? Math.max(0, ...config.requesters.map((r) => r.order)) + 1;
    config.requesters.push({
      id: p.newId, name: p.name ?? u.name, order, active: true,
      note: `由 ${u.name}（${p.id}）轉換而來`,
    });
    config.requesters.sort((a, b) => a.order - b.order);

    const T = terms(config);
    return {
      summary: `${u.name} 由「${T.drawee}」轉為「${T.requester}」（${p.id} → ${p.newId}），其籤已自籤筒撤出`,
      binChanges: adj,
    };
  },

  'move-to-drawee'(config, bins, p) {
    req(p, 'id', 'newId', 'courtId');
    const r = (config.requesters ?? []).find((x) => x.id === p.id);
    if (!r) die(`${terms(config).requester}不存在：${p.id}`);
    if (!r.active) die(`${r.name} 已停用，無需轉換`);
    if (config.units.some((x) => x.id === p.newId)) die(`抽籤名單 ID 已存在：${p.newId}`);

    r.active = false;
    r.note = `已轉為${terms(config).drawee}（${p.newId}）`;

    const n = p.ticketsPerCycle ?? 1;
    const order = p.order ?? Math.max(0, ...config.units.map((u) => u.order)) + 1;
    const adj = addUnit(config, bins, {
      id: p.newId, name: p.name ?? r.name, courtId: p.courtId, order,
      ticketsPerCycle: n, note: `由 ${r.name}（${p.id}）轉換而來`,
    });

    const T = terms(config);
    return {
      summary: `${r.name} 由「${T.requester}」轉為「${T.drawee}」（${p.id} → ${p.newId}），` +
        `已立即投入 ${n} 支籤`,
      binChanges: adj,
    };
  },

  'set-notify'(config, bins, p) {
    req(p, 'key');
    // 只開放這幾項；其餘通知設定（例如端點位址）不應由日常操作變更
    const ALLOWED = {
      'line.enabled': 'boolean',
      'line.mode': ['broadcast', 'push'],
      'line.includeCaseNo': 'boolean',
      'web.enabled': 'boolean',
    };
    if (!(p.key in ALLOWED)) {
      die(`不允許透過本流程修改 notify.${p.key}。可修改的項目：${Object.keys(ALLOWED).join('、')}`);
    }

    const [group, field] = p.key.split('.');
    config.notify ??= {};
    config.notify[group] ??= {};
    const before = config.notify[group][field];

    const spec = ALLOWED[p.key];
    let val;
    if (Array.isArray(spec)) {
      val = String(p.value);
      if (!spec.includes(val)) die(`notify.${p.key} 必須是 ${spec.join(' 或 ')}，收到「${val}」`);
    } else {
      val = p.value === true || p.value === 'true';
    }
    config.notify[group][field] = val;

    const notes = [];
    if (p.key === 'line.enabled' && val === true) {
      const mode = config.notify.line.mode === 'push' ? 'push' : 'broadcast';
      notes.push(`目前為 ${mode} 模式`);
      notes.push(mode === 'push'
        ? '需已設定 Actions Secret：LINE_CHANNEL_TOKEN 與 LINE_GROUP_IDS'
        : '需已設定 Actions Secret：LINE_CHANNEL_TOKEN；收訊者須將官方帳號加為好友');
    }

    return {
      summary: `通知設定 notify.${p.key}：${before} → ${val}` +
        (notes.length ? `\n  - ${notes.join('\n  - ')}` : ''),
      binChanges: [],
    };
  },

  'set-rule'(config, bins, p) {
    req(p, 'key');
    const ALLOWED = [
      'refillWhenRemainingAtMost', 'refillWhenTwoTicketsSameCourt',
      'maxOffsetPerCase', 'maxRefillLoops', 'redrawReturnsTicket',
    ];
    if (!ALLOWED.includes(p.key)) {
      die(`不允許透過本流程修改 rules.${p.key}。可修改的項目：${ALLOWED.join('、')}`);
    }
    const before = config.rules[p.key];
    let val = p.value;
    if (typeof before === 'boolean') val = val === true || val === 'true';
    else if (typeof before === 'number') val = Number(val);
    config.rules[p.key] = val;
    return { summary: `規則 ${p.key}：${before} → ${val}`, binChanges: [] };
  },
};

/* ── 授權清單（另存於 operators.json）───────────────────────── */

const OPERATOR_ACTIONS = {
  'add-operator'(operators, p) {
    req(p, 'githubLogin', 'role');
    if (!['DRAW_OPERATOR', 'ADMIN'].includes(p.role)) die(`角色必須是 DRAW_OPERATOR 或 ADMIN`);
    const key = String(p.githubLogin).toLowerCase();
    if (operators.operators.some((o) => String(o.githubLogin).toLowerCase() === key)) {
      die(`${p.githubLogin} 已在授權清單內。若要調整角色或重新啟用，請先撤銷再新增。`);
    }
    operators.operators.push({
      githubLogin: p.githubLogin,
      displayName: p.displayName ?? p.githubLogin,
      role: p.role,
      validFrom: p.validFrom ?? nowIso().slice(0, 10),
      validTo: null,
      note: p.note ?? '',
    });
    return `新增授權：${p.githubLogin}（${p.role}）`;
  },

  'revoke-operator'(operators, p) {
    req(p, 'githubLogin');
    const key = String(p.githubLogin).toLowerCase();
    const o = operators.operators.find((x) => String(x.githubLogin).toLowerCase() === key);
    if (!o) die(`${p.githubLogin} 不在授權清單內`);
    if (o.validTo) die(`${p.githubLogin} 的授權已於 ${o.validTo} 撤銷`);
    // 刻意保留該筆而非刪除，撤銷本身也是需要留存的稽核事實
    o.validTo = p.validTo ?? nowIso().slice(0, 10);
    return `撤銷授權：${p.githubLogin}（自 ${o.validTo} 起失效，紀錄保留）`;
  },
};

/* ── 主流程 ───────────────────────────────────────────────── */

function main() {
  const config = loadConfig();
  const operators = loadOperators();

  say('## 授權檢查');
  say('');

  const auth = checkOperator(operators, IN.actor, 'ADMIN');
  if (!auth.allowed) die(`拒絕執行：${auth.reason}（設定變更需要 ADMIN）`);
  say(`- 執行者：\`${IN.actor}\`（${auth.operator.displayName}，${auth.operator.role}）`);

  const v = verifyIntegrity();
  if (!v.ok) die('資料完整性驗證失敗，設定變更中止：\n  ' + v.problems.join('\n  '));
  say(`- 資料完整性：通過（歷史 ${v.recordCount} 筆）`);

  if (!IN.reason) die('必須填寫變更理由');
  checkPrivacy(config, IN.reason);
  say(`- 變更理由：${IN.reason}`);
  say('');

  let params;
  try {
    params = IN.paramsRaw.trim() ? JSON.parse(IN.paramsRaw) : {};
  } catch (e) {
    die(`參數不是合法的 JSON：${e.message}\n  收到：${IN.paramsRaw}`);
  }

  const state = loadState();
  const bins = binsFromState(state);
  const configBefore = structuredClone(config);

  say('## 變更內容');
  say('');

  let summary, binChanges = [], operatorSummary = null, newBin = null;

  if (OPERATOR_ACTIONS[IN.action]) {
    operatorSummary = OPERATOR_ACTIONS[IN.action](operators, params);
    summary = operatorSummary;
    writeFileSync(paths().operators, JSON.stringify(operators, null, 2) + '\n', 'utf8');
  } else if (ACTIONS[IN.action]) {
    const r = ACTIONS[IN.action](config, bins, params);
    summary = r.summary;
    binChanges = r.binChanges ?? [];
    newBin = r.newBin ?? null;

    // ── 寫入前驗證（這是直接編輯 config.json 所缺少的把關）──
    const problems = validateConfig(config);
    if (problems.length) {
      die('變更後的設定未通過結構驗證，已中止且未寫入任何檔案：\n  - ' + problems.join('\n  - '));
    }

    // 新增案類須同時建立籤筒，否則抽籤時會找不到對應籤筒
    if (newBin && !state.bins[newBin]) {
      bins[newBin] = createBin(config);
      state.bins[newBin] = { tickets: [], cycle: 0, carryOverSkips: {}, lastRecordId: null };
    }

    config.updatedAt = nowIso();
    writeFileSync(paths().config, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } else {
    die(`未知的動作：${IN.action}\n  可用動作：${[...Object.keys(ACTIONS), ...Object.keys(OPERATOR_ACTIONS)].join('、')}`);
  }

  say(`- ${summary}`);
  for (const a of binChanges) {
    const parts = [];
    if (a.ticketsAdded) parts.push(`投入 ${a.ticketsAdded} 支`);
    if (a.ticketsRemoved) parts.push(`撤出 ${a.ticketsRemoved} 支`);
    if (a.refills?.length) parts.push(`觸發補籤 ${a.refills.length} 次`);
    parts.push(`現有 ${a.remainingAfter} 支`);
    say(`  - ${config.caseTypes.find((c) => c.id === a.binId)?.name ?? a.binId}：${parts.join('、')}`);
  }
  say('');

  /* ── 寫入狀態與稽核紀錄 ─────────────────────────────────── */

  const history = loadHistory();
  const prev = history.length ? history[history.length - 1].recordHash : null;
  const seq = state.seq + 1;

  const changedBins = binChanges.length > 0 || newBin;
  if (changedBins) {
    for (const binId of Object.keys(bins)) {
      state.bins[binId] = {
        ...(state.bins[binId] ?? { lastRecordId: null }),
        tickets: bins[binId].tickets,
        cycle: bins[binId].cycle,
        carryOverSkips: bins[binId].carryOverSkips,
      };
    }
  }

  const rec = sealRecord(
    buildAuditRecord({
      seq,
      type: changedBins ? 'BIN_ADJUST' : 'CONFIG_CHANGE',
      at: nowIso(),
      operator: `github:${IN.actor}`,
      workflowRunUrl: IN.runUrl,
      payload: {
        action: IN.action,
        params,
        reason: IN.reason,
        summary,
        binChanges,
        // 保留變更前後的設定摘要，使日後可追溯當時的組織狀態
        courtsBefore: configBefore.courts.map((c) => ({ id: c.id, name: c.name, active: c.active })),
        unitsBefore: configBefore.units.map((u) => ({
          id: u.id, name: u.name, courtId: u.courtId, active: u.active, ticketsPerCycle: u.ticketsPerCycle ?? 1,
        })),
        unitsAfter: config.units.map((u) => ({
          id: u.id, name: u.name, courtId: u.courtId, active: u.active, ticketsPerCycle: u.ticketsPerCycle ?? 1,
        })),
      },
    }),
    prev
  );

  appendHistory(rec);
  state.seq = seq;
  state.updatedAt = nowIso();
  saveState(state);

  say(`稽核紀錄：\`${rec.recordId}\`（${rec.type}）`);
  say('');

  const abnormal = config.units.filter((u) => u.active && (u.ticketsPerCycle ?? 1) !== 1);
  if (abnormal.length) {
    say('> ⚠ 目前有股別的每輪籤數不等於 1：');
    for (const u of abnormal) say(`> ・${u.name}　每輪 ${u.ticketsPerCycle} 支`);
    say('> 追分完成後請記得改回 1。');
  }
}

try {
  main();
} catch (e) {
  if (e instanceof LotteryError) die(`[${e.code}] ${e.message}`);
  die(e.stack ?? String(e));
}
