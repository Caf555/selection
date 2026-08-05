/**
 * 設定檔結構驗證
 * SPEC.md §6.1、§13
 *
 * 這些檢查原本只存在於測試檔中，等於只在開發時把關。一旦設定可經由
 * 工作流程修改，就必須在**寫入前**驗證——否則一次手誤就能讓抽籤引擎
 * 當掉或行為異常，而問題要等到下次抽籤才會浮現。
 *
 * 因此本模組同時被 run-config.mjs（寫入前）與 config.test.mjs（開發時）使用。
 */

/**
 * @returns {string[]} 問題清單，空陣列代表通過
 */
export function validateConfig(config) {
  const problems = [];
  const P = (msg) => problems.push(msg);

  if (!Array.isArray(config.courts) || config.courts.length === 0) P('courts 不得為空');
  if (!Array.isArray(config.units) || config.units.length === 0) P('units 不得為空');
  if (!Array.isArray(config.caseTypes) || config.caseTypes.length === 0) P('caseTypes 不得為空');
  if (problems.length) return problems;

  const VALID_COLORS = ['blue', 'green', 'amber', 'purple'];

  /* ── 庭 ── */
  const courtIds = new Set();
  const courtOrders = new Set();
  for (const c of config.courts) {
    if (!c.id) { P(`庭別缺少 id：${JSON.stringify(c)}`); continue; }
    if (courtIds.has(c.id)) P(`庭別 ID 重複：${c.id}`);
    courtIds.add(c.id);
    if (!c.name) P(`庭別 ${c.id} 缺少名稱`);
    if (!Number.isInteger(c.order)) P(`庭別 ${c.id} 的 order 必須為整數`);
    else if (courtOrders.has(c.order)) P(`庭別 order 重複：${c.order}`);
    courtOrders.add(c.order);
    if (!VALID_COLORS.includes(c.color)) {
      P(`庭別 ${c.id} 的顏色「${c.color}」不在樣式表支援範圍（${VALID_COLORS.join('、')}），` +
        `標籤會失去顏色與圖示`);
    }
  }

  /* ── 股 ── */
  const unitIds = new Set();
  const unitOrders = new Set();
  const activeNames = new Set();
  for (const u of config.units) {
    if (!u.id) { P(`股別缺少 id：${JSON.stringify(u)}`); continue; }
    if (unitIds.has(u.id)) P(`股別 ID 重複：${u.id}`);
    unitIds.add(u.id);
    if (!u.name) P(`股別 ${u.id} 缺少名稱`);
    if (!courtIds.has(u.courtId)) P(`股別 ${u.id} 所屬的庭 ${u.courtId} 不存在`);

    if (!Number.isInteger(u.order)) P(`股別 ${u.id} 的 order 必須為整數`);
    else if (unitOrders.has(u.order)) {
      // order 重複會使籤筒排序不確定，第三人就無法重算驗證抽籤結果
      P(`股別 order 重複：${u.order}。籤筒排序將不確定，使抽籤結果無法被獨立驗證`);
    }
    unitOrders.add(u.order);

    const n = u.ticketsPerCycle ?? 1;
    if (!Number.isInteger(n) || n < 1) P(`股別 ${u.id} 的每輪籤數必須為 1 以上的整數`);

    if (u.active) {
      if (activeNames.has(u.name)) P(`在職股別名稱重複：${u.name}，抽籤結果將無法辨識是哪一股`);
      activeNames.add(u.name);
    }
  }

  /* ── 在職股的整體條件 ── */
  const active = config.units.filter((u) => u.active);
  if (active.length < 2) {
    P(`在職股僅 ${active.length} 個，少於 2 個無法進行有意義的抽籤`);
  } else {
    const courts = new Set(active.map((u) => u.courtId));
    if (courts.size < 2 && config.rules?.refillWhenTwoTicketsSameCourt !== false) {
      P('所有在職股都屬於同一庭，「剩 2 支同庭即補籤」的規則會使籤筒無限補籤');
    }
  }

  for (const u of active) {
    const court = config.courts.find((c) => c.id === u.courtId);
    if (court && court.active === false) P(`股別 ${u.name} 仍在職，但其所屬的庭 ${court.name} 已停用`);
  }

  /* ── 承辦股 ──
     與 units（支援股）是兩組不相交的名單：承辦股是案件的承辦單位、需要支援，
     不參與支援抽籤。清單可以是空的（尚未設定），但抽籤時必須指定，
     由 run-draw.mjs 於該時點檢查。 */
  if (config.requesters !== undefined) {
    if (!Array.isArray(config.requesters)) {
      P('requesters 必須是陣列');
    } else {
      const rIds = new Set();
      const rOrders = new Set();
      const rNames = new Set();
      const unitIdSet = new Set(config.units.map((u) => u.id));
      for (const r of config.requesters) {
        if (!r.id) { P(`承辦股缺少 id：${JSON.stringify(r)}`); continue; }
        if (rIds.has(r.id)) P(`承辦股 ID 重複：${r.id}`);
        rIds.add(r.id);
        if (!r.name) P(`承辦股 ${r.id} 缺少名稱`);
        if (!Number.isInteger(r.order)) P(`承辦股 ${r.id} 的 order 必須為整數`);
        else if (rOrders.has(r.order)) P(`承辦股 order 重複：${r.order}`);
        rOrders.add(r.order);
        if (r.active) {
          if (rNames.has(r.name)) P(`在職承辦股名稱重複：${r.name}`);
          rNames.add(r.name);
        }
        if (unitIdSet.has(r.id)) {
          P(`承辦股 ${r.id} 與支援股使用了相同的 ID，兩者必須是不相交的名單`);
        }
      }
    }
  }

  /* ── 案類 ── */
  const ctIds = new Set();
  for (const c of config.caseTypes) {
    if (!c.id) { P(`案類缺少 id`); continue; }
    if (ctIds.has(c.id)) P(`案類 ID 重複：${c.id}`);
    ctIds.add(c.id);
    if (!c.name) P(`案類 ${c.id} 缺少名稱`);
  }
  if (!config.caseTypes.some((c) => c.active)) P('沒有任何啟用的案類');

  /* ── 規則 ── */
  const r = config.rules ?? {};
  if (!Number.isInteger(r.refillWhenRemainingAtMost) || r.refillWhenRemainingAtMost < 0) {
    P('rules.refillWhenRemainingAtMost 必須為 0 以上的整數');
  }
  if (!Number.isInteger(r.maxOffsetPerCase) || r.maxOffsetPerCase < 1) {
    P('rules.maxOffsetPerCase 必須為 1 以上的整數');
  }
  if (!Number.isInteger(r.maxRefillLoops) || r.maxRefillLoops < 1) {
    P('rules.maxRefillLoops 必須為 1 以上的整數');
  }

  const totalTickets = active.reduce((s, u) => s + (u.ticketsPerCycle ?? 1), 0);
  if (Number.isInteger(r.refillWhenRemainingAtMost) && r.refillWhenRemainingAtMost >= totalTickets) {
    P(`補籤門檻 ${r.refillWhenRemainingAtMost} 不得大於或等於一輪的總籤數 ${totalTickets}，否則會無限補籤`);
  }

  /* ── drand ── */
  const d = config.drand ?? {};
  if (!Array.isArray(d.endpoints) || d.endpoints.length < 2) {
    P('drand 端點應至少設定 2 個以供備援');
  }
  if (!Number.isInteger(d.roundOffset) || d.roundOffset < 1) {
    P('drand.roundOffset 必須 >= 1，否則目標輪次在承諾當下已存在，承諾階段將失去意義');
  }
  if (Number.isInteger(d.minAgreeingEndpoints) && Array.isArray(d.endpoints)
      && d.minAgreeingEndpoints > d.endpoints.length) {
    P(`minAgreeingEndpoints (${d.minAgreeingEndpoints}) 大於端點總數 (${d.endpoints.length})，抽籤將永遠無法進行`);
  }

  return problems;
}

/** 僅在 P2 上線後才必要的檢查，另行提供以免開發階段誤擋 */
export function validateDrandReady(config) {
  const problems = [];
  const d = config.drand ?? {};
  if (!d.chainHash) problems.push('config.drand.chainHash 未填');
  if (!d.publicKey) problems.push('config.drand.publicKey 未填');
  if (!d.signatureDST) problems.push('config.drand.signatureDST 未填');
  return problems;
}
