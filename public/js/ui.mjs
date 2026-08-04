/**
 * 共用畫面元件
 * SPEC.md §9.1
 *
 * 庭別一律以「顏色 + 圖示 + 文字」三重標示，不得單以顏色表意。
 * 色盲、單色列印、螢幕閱讀器皆須能正確辨識。
 */

import { courtOf, unitOf } from './data.mjs';

/** 庭別的圖示。與顏色、文字並列，構成三重標示 */
const GLYPH = { blue: '■', green: '●', amber: '▲', purple: '◆' };
const FALLBACK_ORDER = ['blue', 'green', 'amber', 'purple'];

export function courtStyle(config, courtId) {
  const court = courtOf(config, courtId);
  const color = court?.color ?? FALLBACK_ORDER[(court?.order ?? 1) % 4];
  return {
    name: court?.name ?? courtId,
    shortName: court?.shortName ?? court?.name ?? courtId,
    color,
    glyph: GLYPH[color] ?? '★',
  };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/** 庭別標籤 HTML */
export function courtBadge(config, courtId, { short = false } = {}) {
  const s = courtStyle(config, courtId);
  const label = short ? s.shortName : s.name;
  return (
    `<span class="court c-${s.color}">` +
    `<span class="glyph" aria-hidden="true">${s.glyph}</span>` +
    `<span>${esc(label)}</span></span>`
  );
}

/** 籤條圖示。數字同時以文字呈現，不依賴圖形辨識 */
export function ticketBars(n, colorVar) {
  if (n <= 0) return '';
  const capped = Math.min(n, 12);
  const bars = `<span class="bars" style="color:${colorVar}" aria-hidden="true">` +
    '<i></i>'.repeat(capped) + '</span>';
  return n > capped ? bars + `<span aria-hidden="true">…</span>` : bars;
}

/**
 * 單一籤筒的完整區塊
 * @param {object} config
 * @param {object} caseType
 * @param {object} bin  { tickets, cycle, carryOverSkips }
 */
export function renderBin(config, caseType, bin) {
  const counts = {};
  for (const t of bin.tickets) counts[t] = (counts[t] ?? 0) + 1;

  const rows = config.units
    .filter((u) => u.active)
    .sort((a, b) => a.order - b.order)
    .map((u) => {
      const n = counts[u.id] ?? 0;
      const owed = bin.carryOverSkips?.[u.id] ?? 0;
      const per = u.ticketsPerCycle ?? 1;
      const s = courtStyle(config, u.courtId);

      const tags = [];
      if (owed > 0) tags.push(`<span class="tag owe">抵分欠 ${owed} 支</span>`);
      if (per !== 1) tags.push(`<span class="tag perc">每輪 ${per} 支</span>`);

      const right = n > 0
        ? `${ticketBars(n, `var(--ct-${s.color})`)}<span>${n} 支</span>`
        : `<span class="done-mark">本輪已輪畢 ✓</span>`;

      return (
        `<div class="unit${n === 0 ? ' done' : ''}">` +
        `<div class="name">${esc(u.name)} ${courtBadge(config, u.courtId, { short: true })} ${tags.join(' ')}</div>` +
        `<div class="tickets">${right}<span class="sr-only">${esc(u.name)} 剩餘 ${n} 支籤</span></div>` +
        `</div>`
      );
    })
    .join('');

  const threshold = config.rules?.refillWhenRemainingAtMost ?? 1;
  const twoSame = config.rules?.refillWhenTwoTicketsSameCourt !== false;

  return (
    `<div class="bin">` +
    `<h2>${esc(caseType.name)}</h2>` +
    `<div class="binmeta">第 ${bin.cycle} 輪　籤筒內共 ${bin.tickets.length} 支籤　` +
    `（剩 ${threshold} 支${twoSame ? '、或剩 2 支同庭' : ''}時自動補籤）</div>` +
    `<div class="units">${rows}</div>` +
    `</div>`
  );
}

/** 紀錄狀態標籤 */
export function statusBadge(rec) {
  if (rec.voided) return '<span class="badge b-void">已作廢</span>';
  if (rec.superseded) return '<span class="badge b-void">已重抽，不生效</span>';
  if (rec.type === 'REDRAW') return '<span class="badge b-redraw">迴避重抽</span>';
  if (rec.type === 'OFFLINE_BACKFILL') return '<span class="badge b-plain">離線補登</span>';
  if (rec.amended) return '<span class="badge b-plain">已更正</span>';
  return '<span class="badge b-ok">有效</span>';
}

/** 頁首導覽 */
export function nav(current) {
  const q = location.search;
  const items = [
    ['index.html', '公開看板'],
    ['history.html', '歷史查詢'],
    ['verify.html', '結果驗證'],
    ['draw.html', '抽籤台'],
    ['admin.html', '組織管理'],
  ];
  return (
    `<nav class="main" aria-label="主要導覽">` +
    items
      .map(([href, label]) =>
        `<a href="${href}${q}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`
      )
      .join('') +
    `</nav>`
  );
}

/** 示範資料警示 */
export function demoBanner(isDemo) {
  if (!isDemo) return '';
  return (
    `<div class="note warn" role="alert">` +
    `<strong>示範資料</strong>　目前顯示的是隨機產生的示範內容，僅供版面檢視，` +
    `案號與抽籤結果均非真實紀錄。正式資料請移除網址中的 <code>?src=</code> 參數。` +
    `</div>`
  );
}

/**
 * 檢查頁面是否為舊版（SPEC §9.1）
 *
 * GitHub Pages 會對 HTML 與 JS 設定快取，更新後使用者的瀏覽器仍會繼續執行
 * 舊版程式直到快取過期。在本系統中這有具體風險：舊版抽籤台曾把「已完成但
 * 暫時讀不到結果」顯示成「抽籤未完成」，使用者照著重抽就會多消耗一支籤、
 * 扭曲籤筒，而且不會察覺。
 *
 * config.json 一律以 no-store 取得，必為最新；頁面內嵌的版本號則會隨 HTML
 * 一起被快取。兩者不符即代表這份頁面是舊的。
 *
 * @param {object} config
 * @param {string} pageVersion 頁面內嵌的版本號
 * @param {{blocking?: boolean}} [opt] blocking＝阻擋操作（抽籤台等會改變狀態的頁面）
 * @returns {string} 需要顯示的警示 HTML，無異常時為空字串
 */
export function versionBanner(config, pageVersion, { blocking = false } = {}) {
  const latest = config.appVersion;
  if (!latest || latest === pageVersion) return '';

  const reload = `location.replace(location.pathname + '?_reload=' + Date.now() + location.hash)`;
  return (
    `<div class="note warn" role="alert" style="margin-bottom:1.2rem">` +
    `<strong>本頁不是最新版本</strong>（頁面 ${esc(pageVersion)}，最新 ${esc(latest)}）<br><br>` +
    (blocking
      ? `為避免依舊版程式做出錯誤判斷，<strong>請先重新載入再操作</strong>。<br><br>`
      : `顯示內容可能不正確。<br><br>`) +
    `<button class="btn" type="button" onclick="${reload}">重新載入最新版</button>` +
    `<div style="margin-top:.6rem;font-size:0.9rem">若仍顯示舊版，請按 Ctrl + Shift + R 強制重新載入。</div>` +
    `</div>`
  );
}

export function fail(container, err) {
  container.innerHTML =
    `<div class="note warn" role="alert"><strong>無法載入資料</strong><br>${esc(err.message)}` +
    `<br><br>若在本機檢視，請先啟動預覽伺服器：<code>node tools/serve.mjs</code>，` +
    `再開啟 <code>http://localhost:8080/public/index.html</code>。</div>`;
}
