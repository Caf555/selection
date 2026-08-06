/**
 * 資料載入與共用查詢
 * SPEC.md §6
 */

/**
 * 資料來源目錄。
 * 預設讀取正式資料 ../data/；可用網址參數 ?src=/demo/ 改讀示範資料。
 */
export function dataBase() {
  const p = new URLSearchParams(location.search).get('src');
  if (!p) return '../data/';
  // 僅允許同源的相對路徑，避免被導向外部來源
  if (/^https?:/i.test(p) || p.startsWith('//')) return '../data/';
  return p.endsWith('/') ? p : p + '/';
}

export function isDemo() {
  return dataBase() !== '../data/';
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`讀取 ${url} 失敗（HTTP ${res.status}）`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`讀取 ${url} 失敗（HTTP ${res.status}）`);
  return res.text();
}

export async function loadAll() {
  const base = dataBase();
  const [config, state, historyText] = await Promise.all([
    getJson(base + 'config.json'),
    getJson(base + 'state.json'),
    getText(base + 'history.jsonl'),
  ]);

  const history = historyText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  return { config, state, history, base };
}

/* ── 查詢輔助 ──────────────────────────────────────────────── */

export function unitOf(config, unitId) {
  return config.units.find((u) => u.id === unitId) ?? null;
}

export function courtOf(config, courtId) {
  return config.courts.find((c) => c.id === courtId) ?? null;
}

export function caseTypeOf(config, id) {
  return config.caseTypes.find((c) => c.id === id) ?? null;
}

export function unitDisplayName(config, unitId) {
  return unitOf(config, unitId)?.name ?? unitId;
}

/**
 * 抽籤結果清單，並標記每筆是否仍然生效。
 *
 *   voided     已由 VOID 紀錄作廢
 *   superseded 已由 REDRAW 取代（原支援股迴避，該次抽籤不生效）
 *
 * 兩者都必須排除在統計之外，否則同一件案子會被計算兩次，
 * 且迴避的股會被誤計為曾受分案。
 */
export function effectiveDraws(history) {
  // 作廢的時間、理由、執行者與處理方式都必須可查——僅標示「已作廢」
  // 而查不到原因，等於沒有留下紀錄
  const voidInfo = new Map(
    history.filter((r) => r.type === 'VOID').map((r) => [r.targetRecordId, r])
  );
  const voided = new Set(voidInfo.keys());
  const superseded = new Set(
    history.filter((r) => r.type === 'REDRAW' && r.originalRecordId).map((r) => r.originalRecordId)
  );
  return history
    .filter((r) => (r.type === 'DRAW' || r.type === 'REDRAW' || r.type === 'OFFLINE_BACKFILL'))
    .map((r) => ({
      ...r,
      voided: r.voided === true || voided.has(r.recordId),
      superseded: superseded.has(r.recordId),
      voidRecord: voidInfo.get(r.recordId) ?? null,
    }));
}

/** 是否計入受分統計 */
export function counts(rec) {
  return !rec.voided && !rec.superseded;
}

/** 取得某筆紀錄最終生效的欄位值（套用其後所有 AMEND） */
export function applyAmends(history, record) {
  const out = { ...record, amended: false, amendments: [] };
  for (const r of history) {
    if (r.type !== 'AMEND' || r.targetRecordId !== record.recordId) continue;
    out.amended = true;
    out.amendments.push(r);
    for (const k of Object.keys(r.changes ?? {})) out[k] = r.changes[k].to;
  }
  return out;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
