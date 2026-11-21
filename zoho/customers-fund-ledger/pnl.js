/* P&L review tab of the Customers Fund Ledger page.
   Reads every ledger line on an income, cost-of-sales or expense account from Zoho Analytics, and each expense's
   description and receipt from Zoho Books, then shows the P&L by month and the entries that need attention
   (pnl-engine.js holds the checks). Nothing is written to Zoho, and no P&L data is stored in the page itself:
   it is read with the viewer's own Zoho access and kept only in that viewer's browser. */
(function () {
'use strict';
const E = window.PNLEngine, root = document.getElementById('pnlRoot');
if (!E || !root) return;
const $ = (s, r) => (r || root).querySelector(s);
const $$ = (s, r) => [...(r || root).querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || isNaN(n) ? '—' : (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt0 = (n) => (n == null || isNaN(n) ? '—' : Math.abs(n) < 0.5 ? '0' : (n < 0 ? '−' : '') + Math.round(Math.abs(n)).toLocaleString('en-US'));
const pct = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '%');
const neg = (n, t) => (n < -0.004 ? '<span class="neg">' + t + '</span>' : t);
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlab = (m) => (m ? MN[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4) : '');
const dlab = (d) => (d ? +d.slice(8, 10) + ' ' + MN[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : '');
const todayDubai = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
const when = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ORG = '898300452', ZB = 'Zoho Books', ZA = 'Zoho Analytics';
const LINK = { expense: 'expenses', journal: 'accountant/manualjournals', bill: 'bills', invoice: 'invoices', creditnote: 'creditnotes', customer_payment: 'paymentsreceived', invoice_payment: 'paymentsreceived', expense_refund: 'expenses' };
const TYPE = { expense: 'Expense', journal: 'Journal', bill: 'Bill', invoice: 'Invoice', creditnote: 'Credit note', customer_payment: 'Payment', invoice_payment: 'Payment', expense_refund: 'Expense refund', bad_debt: 'Bad debt', bill_payment: 'Bill payment', other_income: 'Other income', creditnote_refund: 'Refund' };
const blink = (l) => (LINK[l.et] && l.eid ? '<a class="bk" target="_blank" rel="noopener" href="https://books.zoho.com/app/' + ORG + '#/' + LINK[l.et] + '/' + esc(l.eid) + '">Open in Books ↗</a>' : '');
const alink = (a) => '<a class="bk" target="_blank" rel="noopener" href="https://books.zoho.com/app/' + ORG + '#/accountant/chartofaccounts/' + esc(a.id) + '">Open account ↗</a>';
const core = () => window.CFD_CORE || {};
const SEV = { fix: ['critical', 'Must fix'], review: ['medium', 'Check'], tidy: ['low', 'Tidy up'] };
const Q = {"pl": "SELECT TO_STRING(T.\"Accrual Transaction ID\") AS atid, T.\"Entity Type\" AS et, TO_STRING(T.\"Entity ID\") AS eid, TO_STRING(T.\"Account ID\") AS acct, DATE_FORMAT(T.\"Transaction Date\",'%Y-%m-%d') AS td, T.\"Transaction Number\" AS tno, T.\"Reference No.\" AS ref, T.\"Reference Number\" AS refn, ROUND(COALESCE(T.\"Debit Amount\",0),2) AS dr, ROUND(COALESCE(T.\"Credit Amount\",0),2) AS cr, TO_STRING(COALESCE(T.\"Customer ID\", E.\"Customer ID\")) AS cust, C.\"Customer Name\" AS cname, TO_STRING(COALESCE(T.\"Vendor ID\", E.\"Vendor ID\", B.\"Vendor ID\")) AS vend, V.\"Vendor Name\" AS vname, DATE_FORMAT(T.\"Last Modified Time\",'%Y-%m-%d %H:%i') AS lm, DATE_FORMAT(COALESCE(E.\"Created Time\", J.\"Created Time\", B.\"Created Time\"),'%Y-%m-%d %H:%i') AS ct, E.\"Is Billable\" AS bill, PA.\"Account Name\" AS pf FROM \"Accrual Transactions\" T JOIN \"Accounts\" A ON T.\"Account ID\"=A.\"Account ID\" LEFT JOIN \"Expenses\" E ON T.\"Entity Type\"='expense' AND T.\"Entity ID\"=E.\"Expense ID\" LEFT JOIN \"Manual Journals\" J ON T.\"Entity Type\"='journal' AND T.\"Entity ID\"=J.\"Journal ID\" LEFT JOIN \"Bills\" B ON T.\"Entity Type\"='bill' AND T.\"Entity ID\"=B.\"Bill ID\" LEFT JOIN \"Customers\" C ON COALESCE(T.\"Customer ID\", E.\"Customer ID\")=C.\"Customer ID\" LEFT JOIN \"Vendors\" V ON COALESCE(T.\"Vendor ID\", E.\"Vendor ID\", B.\"Vendor ID\")=V.\"Vendor ID\" LEFT JOIN \"Accounts\" PA ON E.\"Paid Through\"=PA.\"Account ID\" WHERE A.\"Account Type\" IN ('Income','Other Income','Cost Of Goods Sold','Expense','Other Expense')", "ac": "SELECT TO_STRING(A.\"Account ID\") AS acct, A.\"Account Name\" AS aname, A.\"Account Type\" AS atype, TO_STRING(A.\"Parent Account ID\") AS parent, A.\"Active\" AS active, A.\"Account Code\" AS code, DATE_FORMAT(A.\"Created Time\",'%Y-%m-%d') AS created FROM \"Accounts\" A WHERE A.\"Account Type\" IN ('Income','Other Income','Cost Of Goods Sold','Expense','Other Expense')"};

/* ---------- state ---------- */
const ST = { rows: null, acc: null, at: 0, busy: false, err: '', hid: { n: 0, amt: 0 }, R: null, S: null, set: null, period: 'prev2', from: '', to: '', view: 'month', check: null, q: '', acct: '', sort: 'amt', shown: 100, shut: new Set(), drill: '', flags: new Map(), mode: 'review', rv: null, rs: 'attn', rsec: '', racct: '', rq: '', rshown: 150, lscope: 'both', lkind: 'closed', lshown: 150, snapEv: [], fresh: false };
const BK = { map: null, at: 0, busy: false, page: 0, err: '' };
try { const c = JSON.parse(sessionStorage.getItem('pnl.rows.v1') || 'null'); if (c && c.rows && c.acc) { ST.rows = c.rows.map((r) => Object.fromEntries(c.cols.map((k, i) => [k, r[i]]))); ST.acc = c.acc; ST.at = c.at; ST.hid = c.hid || ST.hid; } } catch (e) {}
try { const c = JSON.parse(localStorage.getItem('pnl.bk.v1') || 'null'); if (c && c.rows) { BK.map = new Map(c.rows.map((r) => [r[0], { a: !!r[1], v: r[2], m: r[3], d: r[4], r: r[5] }])); BK.at = c.at; } } catch (e) {}
try { const p = JSON.parse(localStorage.getItem('pnl.ui.v2') || 'null'); if (p) { ST.period = p.period || ST.period; ST.view = p.view || ST.view; ST.mode = p.mode || ST.mode; } } catch (e) {}
const saveUi = () => { try { localStorage.setItem('pnl.ui.v2', JSON.stringify({ period: ST.period, view: ST.view, mode: ST.mode })); } catch (e) {} };

/* ---------- data ---------- */
const payloadOf = (res) => { let p = res && (res.payload !== undefined ? res.payload : res); if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) {} } return p; };
function scope(rows) {
  const S = window.OLScope; ST.hid = { n: 0, amt: 0 };
  if (!S || !S.hidden) return rows;
  return rows.filter((r) => { if (!S.hidden({ cname: r.cname, ref: r.ref })) return true; ST.hid.n++; ST.hid.amt += Math.abs((+r.dr || 0) - (+r.cr || 0)); return false; });
}
function recompute() {
  if (!ST.rows || !ST.acc) return;
  ST.R = E.analyse({ rows: ST.rows, accounts: ST.acc, today: todayDubai(), books: BK.map });
  ST.flags = new Map();
  for (const f of ST.R.findings) for (const i of f.items) if (i.l) { if (!ST.flags.has(i.l.atid)) ST.flags.set(i.l.atid, []); ST.flags.get(i.l.atid).push(f); }
  if (!ST.check || !ST.R.findings.some((f) => f.id === ST.check)) ST.check = (ST.R.findings.find((f) => f.items.length) || {}).id || null;
  snapshot();
  const fix = ST.R.findings.filter((f) => f.sev === 'fix').reduce((t, f) => t + f.items.length, 0);
  const cnt = document.getElementById('cntPnl'); if (cnt) { cnt.textContent = fix || ''; cnt.classList.toggle('hot', fix > 0); }
}
async function refresh(force) {
  const K = core(); if (!K.mcp || !K.exportCSV || ST.busy) return;
  if (!force && ST.at && Date.now() - ST.at < 30 * 60000) return;
  ST.busy = true; ST.err = ''; renderStatus();
  try {
    const [rows, acc] = await Promise.all([K.exportCSV(Q.pl), K.exportCSV(Q.ac)]);
    ST.rows = scope(rows); ST.acc = acc; ST.at = Date.now(); ST.fresh = true;
    try { const cols = Object.keys(ST.rows[0] || {}); sessionStorage.setItem('pnl.rows.v1', JSON.stringify({ at: ST.at, cols, rows: ST.rows.map((r) => cols.map((c) => r[c])), acc, hid: ST.hid })); } catch (e) {}
    recompute();
  } catch (e) { ST.err = K.describe ? K.describe(e, ZA) : String((e && e.message) || e); }
  ST.busy = false; render();
  if (ST.R && (!BK.map || Date.now() - BK.at > 12 * 3600000)) loadBooks();
}
/* every expense's description, receipt and supplier, straight from Zoho Books (200 a page) */
async function loadBooks() {
  const K = core(); if (!K.mcp || BK.busy) return;
  BK.busy = true; BK.err = ''; BK.page = 0; renderStatus();
  const map = new Map();
  try {
    for (let page = 1; page <= 80; page++) {
      const p = payloadOf(await K.mcp.callTool(ZB, 'list_expenses', { query_params: { organization_id: ORG, per_page: 200, page } }, { cache: false }));
      const d = (p && (p.data || p)) || {};
      if (!Array.isArray(d.expenses)) throw new Error(d.message || 'Zoho Books did not return expenses.');
      for (const x of d.expenses) {
        const desc = String(x.description || '').replace(/\s+/g, ' ').trim(), mm = /Merchant\s*[:\-]\s*([^|,\n]+)/i.exec(String(x.description || ''));
        map.set(String(x.expense_id), { a: !!(x.has_attachment || x.expense_receipt_name), v: x.vendor_name || '', m: mm ? mm[1].trim().slice(0, 40) : '', d: desc.slice(0, 140), r: String(x.reference_number || '').slice(0, 100) });
      }
      BK.page = page; renderStatus();
      if (!(d.page_context && d.page_context.has_more_page)) break;
    }
    BK.map = map; BK.at = Date.now();
    try { localStorage.setItem('pnl.bk.v1', JSON.stringify({ at: BK.at, rows: [...map].map(([k, v]) => [k, v.a ? 1 : 0, v.v, v.m, v.d, v.r]) })); } catch (e) {}
    recompute();
  } catch (e) { BK.err = K.describe ? K.describe(e, ZB) : String((e && e.message) || e); }
  BK.busy = false; render();
}

/* ---------- period ---------- */
function monthSet() {
  const R = ST.R, cur = R.curM, all = R.months.concat(R.future);
  let ms;
  if (ST.period === 'ytd') ms = R.months.filter((m) => m.slice(0, 4) === cur.slice(0, 4));
  else if (ST.period === 'l12') ms = R.months.slice(-12);
  else if (ST.period === 'lastm') ms = [E.addM(cur, -1)];
  else if (ST.period === 'prev2') ms = [E.addM(cur, -1), cur];
  else if (ST.period === 'thism') ms = [cur];
  else if (ST.period === 'future') ms = all;
  else if (ST.period === 'custom') { const a = ST.from || all[0], b = ST.to || all[all.length - 1]; ms = all.filter((m) => m >= (a < b ? a : b) && m <= (a < b ? b : a)); }
  else ms = R.months;
  return new Set(ms);
}
const PERIODS = [['prev2', 'Last month + this month'], ['todate', 'All to date'], ['ytd', 'This year'], ['l12', 'Last 12 months'], ['lastm', 'Last month'], ['thism', 'This month'], ['future', 'Incl. future-dated'], ['custom', 'Custom']];
const periodLabel = () => { const ms = [...ST.set].sort(); return ms.length ? (ms.length === 1 ? mlab(ms[0]) : mlab(ms[0]) + ' to ' + mlab(ms[ms.length - 1])) : 'no months'; };
const inPeriod = (i) => !i.m || ST.set.has(i.m);
const itemsOf = (f) => f.items.filter(inPeriod);

/* ---------- shell ---------- */
root.innerHTML = '<style>' +
  '.pl-grid{display:grid;grid-template-columns:minmax(250px,320px) minmax(0,1fr);gap:0;align-items:start}' +
  '@media (max-width:900px){.pl-grid{grid-template-columns:minmax(0,1fr)}}' +
  '.pl-cks{display:flex;flex-direction:column;border-right:1px solid var(--line-soft);max-height:640px;overflow:auto}' +
  '@media (max-width:900px){.pl-cks{border-right:0;border-bottom:1px solid var(--line-soft);max-height:300px}}' +
  '.pl-sevh{font:600 11.5px var(--sans);color:var(--ink-3);padding:10px 14px 4px}' +
  '.pl-ck{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;text-align:left;border:0;border-bottom:1px solid var(--rule,var(--line-soft));background:none;color:var(--ink);padding:9px 14px;font:inherit}' +
  '.pl-ck:hover{background:var(--surface-2)}.pl-ck[aria-pressed="true"]{background:var(--surface-2);box-shadow:inset 3px 0 0 var(--accent)}' +
  '.pl-ck b{font-weight:600;font-size:13.5px}.pl-ck .c{font:600 13px var(--mono)}.pl-ck small{grid-column:1/-1;color:var(--ink-3);font-size:12px}' +
  '.pl-ck.zero{opacity:.55}' +
  '.pl-det{min-width:0}.pl-why{padding:12px 16px;border-bottom:1px solid var(--rule,var(--line-soft));font-size:13px;line-height:1.5}' +
  '.pl-why h3{font:600 15px var(--sans);margin:0 0 4px}.pl-why p{margin:2px 0}.pl-why .do{color:var(--ink)}.pl-why .do b{font-weight:600}' +
  '.pl-tools{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--rule,var(--line-soft))}' +
  '.pl-tools input[type=search]{flex:1 1 200px;min-width:0}' +
  '.pl-ins{margin:0;padding:10px 16px 12px 34px;font-size:13px;line-height:1.6;color:var(--ink-2)}.pl-ins b{color:var(--ink);font-weight:600}' +
  '.pl-st th,.pl-st td{white-space:nowrap}.pl-st td:first-child,.pl-st th:first-child{position:sticky;left:0;background:var(--surface);z-index:1;white-space:normal;min-width:220px;max-width:340px}' +
  '.pl-st tr.sec td{font-weight:600;background:var(--surface-2)}.pl-st tr.sec td:first-child{background:var(--surface-2)}' +
  '.pl-st tr.grp td{font-weight:600}.pl-st tr.grp td:first-child{cursor:pointer}.pl-st tr.acc td:first-child{padding-left:30px}.pl-st tr.acc.in td:first-child{padding-left:46px}' +
  '.pl-st tr.acc{cursor:pointer}.pl-st tr.res td{font-weight:700;border-top:1px solid var(--line);background:var(--surface-2)}.pl-st tr.res td:first-child{background:var(--surface-2)}' +
  '.pl-st tr.mrg td{color:var(--ink-3);font-size:12px}.pl-st td.z{color:var(--ink-3);opacity:.5}.pl-st tr.selrow td{background:var(--active,var(--surface-2))!important}' +
  '.pl-tw{display:inline-block;width:14px;color:var(--ink-3)}.pl-n{font:500 11px var(--mono);color:var(--med);margin-left:6px}' +
  '.pl-fl{display:inline-block;font-size:11px;padding:0 6px;border-radius:999px;margin:1px 3px 1px 0;background:var(--med-bg);color:var(--med)}.pl-fl.fix{background:var(--crit-bg);color:var(--crit)}' +
  '#pnlRoot .seg{flex-wrap:wrap;max-width:100%}#plPeriod,#plView{flex-wrap:wrap;max-width:100%}#pnlRoot .controls{flex-wrap:wrap;min-width:0;max-width:100%}' +
  '.pl-v{display:inline-block;font:600 11.5px var(--sans);padding:1px 9px;border-radius:999px;white-space:nowrap}.pl-v.ok{background:var(--good-bg,var(--ok-bg));color:var(--good,var(--ok))}.pl-v.thin{background:var(--low-bg,var(--surface-2));color:var(--ink-2)}.pl-v.check{background:var(--med-bg);color:var(--med)}.pl-v.fix{background:var(--crit-bg);color:var(--crit)}' +
  '.pl-why2{font-size:12.5px;line-height:1.45}.pl-why2 .is{color:var(--ink)}.pl-why2 .ba{color:var(--ink-3)}.pl-why2 .do{color:var(--ink-2);margin-top:3px}.pl-why2 .do b{font-weight:600}' +
  '.pl-hl{width:100%;max-width:760px}.pl-hl td,.pl-hl th{padding:6px 12px}.pl-box{padding:12px 16px;font-size:13px;line-height:1.55;border-bottom:1px solid var(--rule,var(--line-soft))}.pl-box b{font-weight:600}.pl-box.warn{background:var(--med-bg);color:var(--ink)}' +
  '.pl-empty{padding:28px 16px;color:var(--ink-3);text-align:center;line-height:1.6}' +
  '.pl-status{display:flex;flex-wrap:wrap;gap:4px 16px;padding:0 16px 12px;font-size:12px;color:var(--ink-3)}.pl-status b{color:var(--ink-2);font-weight:600}.pl-status .err{color:var(--crit)}' +
  '</style>' +
  '<div class="card"><header><div><h2>Profit and loss review</h2><span class="sub" id="plSub"></span></div>' +
  '<div class="controls"><div class="seg" id="plPeriod" role="group" aria-label="Period"></div><span id="plCustom" hidden><select id="plFrom" aria-label="From month"></select> <span class="lbl">to</span> <select id="plTo" aria-label="To month"></select></span>' +
  '<button class="btn" type="button" id="plXls">Export Excel</button><button class="btn primary" type="button" id="plRefresh">Refresh from Zoho</button></div></header>' +
  '<div class="pl-tools" style="border-top:1px solid var(--rule,var(--line-soft))"><span class="lbl">View</span><div class="seg" id="plMode" role="group" aria-label="View"></div></div><div class="body"><div class="grid kpis" id="plKpis"></div></div><div class="pl-status" id="plStatus"></div><ul class="pl-ins" id="plIns"></ul></div>' +
  '<div id="plOv"><div class="card" style="margin-top:16px" id="plTodo"><header><div><h2>What needs to be done</h2><span class="sub" id="plTodoSub"></span></div></header><div class="pl-grid"><div class="pl-cks" id="plCks"></div><div class="pl-det" id="plDet"></div></div></div>' +
  '<div class="card" style="margin-top:16px"><header><div><h2>Profit and loss by period</h2><span class="sub" id="plStSub"></span></div><div class="controls"><div class="seg" id="plView" role="group" aria-label="Columns"></div></div></header>' +
  '<div class="scroll"><table class="pl-st" id="plSt"></table></div><div class="note">Figures are the accrual ledger in Zoho Books, in AED: income is credits less debits, costs are debits less credits. “Disbursements Of Expenses” holds costs billed straight on to clients, so it nets to about zero. Click an account to list its entries. An orange number beside an account is how many of its entries are on the list above.</div></div>' +
  '<div class="card" style="margin-top:16px" id="plDrillCard" hidden><header><div><h2 id="plDrillH"></h2><span class="sub" id="plDrillSub"></span></div><button class="btn" type="button" id="plDrillX">Close</button></header><div class="scroll" style="max-height:520px"><table id="plDrill"></table></div></div></div>' +
  '<div id="plRv" hidden></div><div id="plPk" hidden></div><div id="plLg" hidden></div>';

/* ---------- render ---------- */
function renderStatus() {
  const K = core(), b = [];
  const el = $('#plStatus'); if (!el) return;
  if (ST.busy) b.push('<span><b>Reading the P&L from Zoho Analytics…</b></span>');
  else if (ST.at) b.push('<span>Ledger read from Zoho Analytics <b>' + esc(when(ST.at)) + '</b>' + (ST.R ? ' · ' + ST.R.L.length.toLocaleString('en-US') + ' lines, ' + ST.R.A.size + ' accounts' : '') + '</span>');
  if (BK.busy) b.push('<span><b>Reading descriptions and receipts from Zoho Books… page ' + BK.page + '</b></span>');
  else if (BK.map) b.push('<span>Descriptions and receipts from Zoho Books <b>' + esc(when(BK.at)) + '</b> · ' + BK.map.size.toLocaleString('en-US') + ' expenses <button class="btn sm" type="button" data-plbooks>Read again</button></span>');
  else if (K.mcp && ST.R) b.push('<span>Descriptions and receipts not read yet <button class="btn sm" type="button" data-plbooks>Read from Zoho Books</button></span>');
  if (ST.hid.n) b.push('<span>' + ST.hid.n + ' entries of other Onelink Group companies hidden</span>');
  if (ST.err) b.push('<span class="err">' + esc(ST.err) + '</span>');
  if (BK.err) b.push('<span class="err">' + esc(BK.err) + '</span>');
  el.innerHTML = b.join('');
  const rb = $('#plRefresh'); rb.disabled = ST.busy; rb.textContent = ST.busy ? 'Reading…' : K.mcp ? 'Refresh from Zoho' : 'Connect Zoho & refresh';
}
function kpi(l, v, s, cls) { return '<div class="kpi ' + (cls || '') + '"><span class="l">' + l + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></div>'; }
function renderTop() {
  $('#plPeriod').innerHTML = PERIODS.map(([k, t]) => '<button type="button" data-plp="' + k + '" class="' + (ST.period === k ? 'on' : '') + '">' + t + '</button>').join('');
  $('#plView').innerHTML = [['month', 'Months'], ['quarter', 'Quarters'], ['year', 'Years'], ['total', 'Total only']].map(([k, t]) => '<button type="button" data-plv="' + k + '" class="' + (ST.view === k ? 'on' : '') + '">' + t + '</button>').join('');
  const R = ST.R; $('#plCustom').hidden = ST.period !== 'custom' || !R;
  if (!R) { $('#plSub').textContent = ''; $('#plKpis').innerHTML = ''; $('#plIns').innerHTML = ''; return; }
  const all = R.months.concat(R.future), opt = (sel) => all.map((m) => '<option value="' + m + '"' + (m === sel ? ' selected' : '') + '>' + mlab(m) + '</option>').join('');
  $('#plFrom').innerHTML = opt(ST.from || all[0]); $('#plTo').innerHTML = opt(ST.to || R.curM);
  const T = ST.S.T, F = R.findings, n = (sev) => F.filter((f) => f.sev === sev).reduce((t, f) => t + itemsOf(f).length, 0);
  $('#plSub').textContent = periodLabel() + ' · AED';
  $('#plKpis').innerHTML = kpi('Income', fmt0(T.income + T.oinc), T.oinc ? 'incl. ' + fmt0(T.oinc) + ' other income' : 'sales less discounts and returns') +
    kpi('Cost of goods sold', fmt0(T.cogs), pct(T.income ? T.cogs / T.income : null) + ' of income') +
    kpi('Gross profit', fmt0(T.gross), 'margin ' + pct(T.income ? T.gross / T.income : null), T.gross < 0 ? 'bad' : 'ok') +
    kpi('Operating expenses', fmt0(T.opex), pct(T.income ? T.opex / T.income : null) + ' of income') +
    kpi('Net profit', fmt0(T.net), 'margin ' + pct(T.income ? T.net / T.income : null), T.net < 0 ? 'bad' : 'ok') +
    kpi('Must fix', String(n('fix')), 'entries in this period', n('fix') ? 'bad' : 'ok') +
    kpi('To check', String(n('review')), n('tidy') + ' tidy-ups as well');
  $('#plIns').innerHTML = insights().map((t) => '<li>' + t + '</li>').join('');
}
/* a few sentences on what stands out in the chosen period */
function insights() {
  const R = ST.R, S = ST.S, T = S.T, out = [], ms = [...ST.set].filter((m) => m <= R.curM).sort();
  out.push((T.net < 0 ? '<b>Net loss of ' + fmt0(-T.net) + '</b>' : '<b>Net profit of ' + fmt0(T.net) + '</b>') + ' on income of ' + fmt0(T.income + T.oinc) + '. Gross margin is ' + pct(T.income ? T.gross / T.income : null) + '; operating expenses take ' + pct(T.income ? T.opex / T.income : null) + ' of income.');
  const groups = [...S.secs.opex.groups.values()].map((g) => ({ name: g.name || 'Ungrouped accounts', total: g.total })).filter((g) => Math.abs(g.total) > 1).sort((a, b) => b.total - a.total);
  if (groups.length && T.opex > 0) out.push('Largest operating costs: ' + groups.slice(0, 3).map((g) => '<b>' + esc(g.name) + '</b> ' + fmt0(g.total) + ' (' + pct(g.total / T.opex) + ')').join(', ') + '.');
  if (ms.length >= 3) {
    const by = ms.map((m) => [m, S.net.get(m) || 0]), best = by.slice().sort((a, b) => b[1] - a[1])[0], worst = by.slice().sort((a, b) => a[1] - b[1])[0], loss = by.filter((x) => x[1] < 0).length;
    out.push('Best month: <b>' + mlab(best[0]) + '</b> (' + fmt0(best[1]) + '). Worst month: <b>' + mlab(worst[0]) + '</b> (' + fmt0(worst[1]) + '). ' + loss + ' of ' + by.length + ' months made a loss.');
  }
  /* the last finished month against the three before it */
  const last = E.addM(R.curM, -1), prev = [2, 3, 4].map((k) => E.addM(R.curM, -k)).filter((m) => R.months.includes(m));
  if (ST.set.has(last) && prev.length === 3) {
    const mv = [];
    for (const a of R.A.values()) { if (a.kids || a.pass || a.sec !== 'opex') continue; const v = a.by.get(last) || 0, avg = prev.reduce((t, m) => t + (a.by.get(m) || 0), 0) / 3; if (Math.abs(v - avg) >= 5000 && (avg === 0 || Math.abs(v - avg) / Math.abs(avg) >= 0.5)) mv.push({ a, v, avg, d: v - avg }); }
    mv.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    if (mv.length) out.push('In ' + mlab(last) + ', against the three months before: ' + mv.slice(0, 4).map((x) => '<b>' + esc(x.a.name) + '</b> ' + (x.d > 0 ? 'up' : 'down') + ' ' + fmt0(Math.abs(x.d)) + ' (' + fmt0(x.v) + ' vs about ' + fmt0(x.avg) + ')').join('; ') + '.');
  }
  const fut = R.L.filter((l) => l.td > R.today), futAmt = fut.reduce((t, l) => t + (l.a.sec === 'income' || l.a.sec === 'oinc' ? -l.amt : l.amt), 0);
  if (fut.length) out.push('<b>' + fmt0(futAmt) + ' of costs are dated after today</b> (' + mlab(R.future[0]) + ' to ' + mlab(R.future[R.future.length - 1]) + '); they are left out unless you pick “Incl. future-dated”.');
  const pass = [...R.A.values()].filter((a) => a.pass).reduce((t, a) => t + a.total, 0);
  if (Math.abs(pass) >= 1) out.push('“Disbursements Of Expenses” should net to zero once every client cost is invoiced; it is currently <b>' + fmt(pass) + '</b>.');
  return out;
}
function renderChecks() {
  const R = ST.R; if (!R) { $('#plCks').innerHTML = ''; $('#plDet').innerHTML = ''; return; }
  let h = '', tot = 0;
  for (const sev of ['fix', 'review', 'tidy']) {
    const fs = R.findings.filter((f) => f.sev === sev); if (!fs.length) continue;
    h += '<div class="pl-sevh">' + SEV[sev][1] + '</div>';
    for (const f of fs) {
      const it = itemsOf(f), amt = it.reduce((t, i) => t + Math.abs(i.amt), 0), wait = (f.id === 'nodesc' || f.id === 'noreceipt') && !R.booksRead; tot += it.length;
      h += '<button type="button" class="pl-ck' + (it.length ? '' : ' zero') + '" data-plck="' + f.id + '" aria-pressed="' + (ST.check === f.id) + '"><b>' + esc(f.title) + '</b><span class="c">' + (wait ? '…' : it.length.toLocaleString('en-US')) + '</span><small>' + (wait ? 'needs Zoho Books' : it.length ? 'AED ' + fmt0(amt) : 'none in this period') + '</small></button>';
    }
  }
  $('#plCks').innerHTML = h; $('#plTodoSub').textContent = tot.toLocaleString('en-US') + ' items in ' + periodLabel();
  renderDetail();
}
function renderDetail() {
  const R = ST.R, f = R && R.findings.find((x) => x.id === ST.check), el = $('#plDet');
  if (!f) { el.innerHTML = '<div class="pl-empty">Nothing needs attention in this period.</div>'; return; }
  let items = itemsOf(f);
  const accs = [...new Map(items.map((i) => [i.a.id, i.a])).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (ST.acct && !accs.some((a) => a.id === ST.acct)) ST.acct = '';
  if (ST.acct) items = items.filter((i) => i.a.id === ST.acct);
  const q = ST.q.trim().toLowerCase();
  if (q) items = items.filter((i) => (i.a.name + ' ' + (i.l ? [i.l.ref, i.l.desc, i.l.tno, i.l.cname, i.l.vname, i.l.td, Math.abs(i.l.amt).toFixed(2)].join(' ') : '') + ' ' + i.note).toLowerCase().includes(q));
  const sorts = { amt: (a, b) => Math.abs(b.amt) - Math.abs(a.amt), new: (a, b) => ((b.l ? b.l.td : b.m) || '').localeCompare((a.l ? a.l.td : a.m) || ''), old: (a, b) => ((a.l ? a.l.td : a.m) || '').localeCompare((b.l ? b.l.td : b.m) || ''), acc: (a, b) => a.a.name.localeCompare(b.a.name) || Math.abs(b.amt) - Math.abs(a.amt) };
  items = items.slice().sort(f.id === 'dup' && ST.sort === 'amt' ? (a, b) => Math.abs(b.amt) - Math.abs(a.amt) || String(a.grp).localeCompare(String(b.grp)) : sorts[ST.sort] || sorts.amt);
  const wait = (f.id === 'nodesc' || f.id === 'noreceipt') && !R.booksRead;
  let h = '<div class="pl-why"><h3>' + esc(f.title) + ' <span class="sev ' + SEV[f.sev][0] + '">' + SEV[f.sev][1] + '</span></h3><p class="muted">' + esc(f.why) + '</p><p class="do"><b>What to do:</b> ' + esc(f.todo) + '</p></div>';
  if (wait) { el.innerHTML = h + '<div class="pl-empty">' + (BK.busy ? 'Reading every expense from Zoho Books… page ' + BK.page + '.' : 'This check needs each expense’s description and receipt from Zoho Books.<br><button class="btn primary" type="button" data-plbooks style="margin-top:8px">Read from Zoho Books</button>') + '</div>'; return; }
  h += '<div class="pl-tools"><input type="search" id="plQ" placeholder="Search reference, account, client, amount" value="' + esc(ST.q) + '" autocomplete="off" spellcheck="false" aria-label="Search these entries">' +
    '<select id="plAcct" aria-label="Account"><option value="">All accounts (' + accs.length + ')</option>' + accs.map((a) => '<option value="' + esc(a.id) + '"' + (a.id === ST.acct ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select>' +
    '<select id="plSort" aria-label="Sort"><option value="amt">Largest first</option><option value="new">Newest first</option><option value="old">Oldest first</option><option value="acc">By account</option></select>' +
    '<span class="sub">' + items.length.toLocaleString('en-US') + ' shown · AED ' + fmt0(items.reduce((t, i) => t + Math.abs(i.amt), 0)) + '</span></div>';
  if (!items.length) { el.innerHTML = h + '<div class="pl-empty">No entries match.</div>'; fix(); return; }
  const lineItems = items.some((i) => i.l);
  h += '<div class="scroll" style="max-height:560px"><table><thead><tr>' + (lineItems ? '<th>Date</th><th>Ref #</th><th>Type</th><th>Account</th><th>Reference / description</th><th>Client / supplier</th><th class="n">Amount</th><th>Why it is listed</th><th></th>' : '<th>Account</th><th>Section</th><th>Month</th><th class="n">Amount</th><th>Why it is listed</th><th></th>') + '</tr></thead><tbody>';
  for (const i of items.slice(0, ST.shown)) {
    const l = i.l, a = i.a;
    if (l) h += '<tr><td>' + dlab(l.td) + '</td><td class="num" style="text-align:left">' + esc(l.tno) + '</td><td>' + esc(TYPE[l.et] || l.et) + '</td><td><button class="linkish" type="button" data-placc="' + esc(a.id) + '">' + esc(a.name) + '</button></td><td class="wrap">' + (l.ref ? esc(l.ref) : /^(expense|journal|bill)$/.test(l.et) ? '<span class="muted">no reference</span>' : '') + (l.desc && l.desc !== l.ref ? '<div class="muted" style="font-size:12px">' + esc(l.desc) + '</div>' : '') + '</td><td class="wrap">' + esc([l.cname, l.vname].filter(Boolean).join(' · ')) + '</td><td class="n">' + neg(l.amt, fmt(l.amt)) + '</td><td class="wrap">' + esc(i.note) + (i.to ? ' <button class="linkish" type="button" data-placc="' + esc(i.to.id) + '">see that account</button>' : '') + '</td><td>' + blink(l) + '</td></tr>';
    else h += '<tr><td><button class="linkish" type="button" data-placc="' + esc(a.id) + '">' + esc(a.name) + '</button></td><td>' + esc(E.SEC_LABEL[a.sec]) + '</td><td>' + esc(mlab(i.m)) + '</td><td class="n">' + (i.amt ? neg(i.amt, fmt(i.amt)) : '') + '</td><td class="wrap">' + esc(i.note) + '</td><td>' + alink(a) + '</td></tr>';
  }
  h += '</tbody></table></div>';
  if (items.length > ST.shown) h += '<div class="pl-tools"><button class="btn" type="button" data-plmore>Show ' + Math.min(200, items.length - ST.shown) + ' more</button><span class="sub">' + (items.length - ST.shown).toLocaleString('en-US') + ' not shown; the Excel export has them all</span></div>';
  el.innerHTML = h; fix();
  function fix() { const s = $('#plSort'); if (s) s.value = ST.sort; }
}
/* columns of the statement for the chosen view */
function columns() {
  const ms = [...ST.set].sort();
  if (ST.view === 'total') return [];
  if (ST.view === 'month') return ms.map((m) => ({ label: mlab(m), ms: [m] }));
  const key = ST.view === 'year' ? (m) => m.slice(0, 4) : (m) => 'Q' + (Math.floor((+m.slice(5, 7) - 1) / 3) + 1) + ' ' + m.slice(0, 4);
  const g = new Map(); for (const m of ms) { const k = key(m); if (!g.has(k)) g.set(k, []); g.get(k).push(m); }
  return [...g].map(([label, x]) => ({ label, ms: x }));
}
function renderStatement() {
  const R = ST.R, S = ST.S, el = $('#plSt'); if (!R) { el.innerHTML = ''; $('#plStSub').textContent = ''; return; }
  const cols = columns(), sum = (by, c) => c.ms.reduce((t, m) => t + (by.get(m) || 0), 0);
  const cnt = new Map(); for (const f of R.findings) for (const i of itemsOf(f)) cnt.set(i.a.id, (cnt.get(i.a.id) || 0) + 1);
  const cells = (by, total, bold) => cols.map((c) => { const v = sum(by, c); return '<td class="n' + (Math.abs(v) < 0.5 ? ' z' : '') + '">' + neg(v, fmt0(v)) + '</td>'; }).join('') + '<td class="n">' + (bold ? '<b>' : '') + neg(total, fmt0(total)) + (bold ? '</b>' : '') + '</td>';
  let h = '<thead><tr><th>Account</th>' + cols.map((c) => '<th class="n">' + esc(c.label) + '</th>').join('') + '<th class="n">Total</th></tr></thead><tbody>';
  const section = (k) => {
    const s = S.secs[k]; if (!s.groups.size) return;
    h += '<tr class="sec"><td>' + esc(s.label) + '</td>' + cells(s.by, s.total, true) + '</tr>';
    const gs = [...s.groups.values()].sort((a, b) => (a.name === '' ? 1 : b.name === '' ? -1 : Math.abs(b.total) - Math.abs(a.total)));
    for (const g of gs) {
      const shut = g.name && ST.shut.has(k + '|' + g.name);
      if (g.name) h += '<tr class="grp" data-plgrp="' + esc(k + '|' + g.name) + '"><td><span class="pl-tw">' + (shut ? '▸' : '▾') + '</span>' + esc(g.name) + ' <span class="muted" style="font-weight:400">· ' + g.accounts.length + '</span></td>' + cells(g.by, g.total, true) + '</tr>';
      if (shut) continue;
      for (const x of g.accounts.sort((a, b) => Math.abs(b.total) - Math.abs(a.total))) {
        if (Math.abs(x.total) < 0.005 && !x.by.size) continue;
        const n = cnt.get(x.a.id);
        h += '<tr class="acc' + (g.name ? ' in' : '') + (ST.drill === x.a.id ? ' selrow' : '') + '" data-placc="' + esc(x.a.id) + '"><td>' + esc(x.a.name) + (n ? '<span class="pl-n" title="' + n + ' entries on the list above">' + n + '</span>' : '') + '</td>' + cells(x.by, x.total) + '</tr>';
      }
    }
  };
  const result = (label, by, total, base) => {
    h += '<tr class="res"><td>' + label + '</td>' + cells(by, total, true) + '</tr>';
    if (base) h += '<tr class="mrg"><td>' + base.label + '</td>' + cols.map((c) => { const b = sum(base.by, c); return '<td class="n">' + (b ? pct(sum(by, c) / b) : '—') + '</td>'; }).join('') + '<td class="n">' + (base.total ? pct(total / base.total) : '—') + '</td></tr>';
  };
  const inc = { label: 'Gross margin', by: S.secs.income.by, total: S.T.income };
  section('income'); section('cogs'); result('Gross profit', S.gross, S.T.gross, inc);
  section('opex'); result('Operating profit', S.oper, S.T.oper);
  section('oinc'); section('oexp'); result('Net profit', S.net, S.T.net, { label: 'Net margin', by: S.secs.income.by, total: S.T.income });
  el.innerHTML = h + '</tbody>';
  $('#plStSub').textContent = periodLabel() + ' · AED, whole numbers';
}
function renderDrill() {
  const R = ST.R, a = R && ST.drill && R.A.get(ST.drill), card = $('#plDrillCard');
  card.hidden = !a; if (!a) return;
  const lines = a.lines.filter((l) => ST.set.has(l.m)).sort((x, y) => y.td.localeCompare(x.td));
  $('#plDrillH').textContent = a.name;
  $('#plDrillSub').textContent = E.SEC_LABEL[a.sec] + (a.group ? ' · ' + a.group : '') + ' · ' + lines.length + ' entries in ' + periodLabel() + ' · net ' + fmt(lines.reduce((t, l) => t + l.amt, 0));
  let h = '<thead><tr><th>Date</th><th>Ref #</th><th>Type</th><th>Reference / description</th><th>Client / supplier</th><th class="n">Debit</th><th class="n">Credit</th><th>On the list for</th><th></th></tr></thead><tbody>';
  for (const l of lines.slice(0, 400)) {
    const fl = (ST.flags.get(l.atid) || []).map((f) => '<span class="pl-fl' + (f.sev === 'fix' ? ' fix' : '') + '">' + esc(f.title) + '</span>').join('');
    h += '<tr><td>' + dlab(l.td) + '</td><td class="num" style="text-align:left">' + esc(l.tno) + '</td><td>' + esc(TYPE[l.et] || l.et) + '</td><td class="wrap">' + (l.ref ? esc(l.ref) : /^(expense|journal|bill)$/.test(l.et) ? '<span class="muted">no reference</span>' : '') + (l.desc && l.desc !== l.ref ? '<div class="muted" style="font-size:12px">' + esc(l.desc) + '</div>' : '') + '</td><td class="wrap">' + esc([l.cname, l.vname].filter(Boolean).join(' · ')) + '</td><td class="n">' + (l.dr ? fmt(l.dr) : '') + '</td><td class="n">' + (l.cr ? fmt(l.cr) : '') + '</td><td class="wrap">' + fl + '</td><td>' + blink(l) + '</td></tr>';
  }
  if (!lines.length) h += '<tr><td class="empty" colspan="9">No entries in this period.</td></tr>';
  else if (lines.length > 400) h += '<tr><td class="empty" colspan="9">' + (lines.length - 400) + ' older entries not shown.</td></tr>';
  $('#plDrill').innerHTML = h + '</tbody>';
}
function render() {
  renderStatus();
  const R = ST.R, K = core();
  $('#plTodo').hidden = !R;
  if (R) { ST.set = monthSet(); ST.S = E.statement(R, ST.set); }
  renderTop(); renderChecks(); renderStatement(); renderDrill();
  $('#plMode').innerHTML = MODES.map(([k, t]) => '<button type="button" data-plm="' + k + '" class="' + (ST.mode === k ? 'on' : '') + '">' + t + '</button>').join('');
  $('#plOv').hidden = ST.mode !== 'overview'; $('#plRv').hidden = ST.mode !== 'review' || !R; $('#plPk').hidden = ST.mode !== 'pack' || !R; $('#plLg').hidden = ST.mode !== 'log' || !R;
  if (R) { ST.rv = E.review(R, ST.set); if (ST.mode === 'review') renderReview(); else if (ST.mode === 'pack') renderPack(); else if (ST.mode === 'log') renderLog(); }
  if (!R) $('#plSt').innerHTML = '<tbody><tr><td class="pl-empty">' + (ST.busy ? 'Reading the P&L from Zoho…' : K.mcp ? 'Press Refresh from Zoho to read the P&L.' : 'The P&L is read live from Zoho with your own access; none of it is stored in this page.<br>Open the page in claude.ai, then press <b>Connect Zoho &amp; refresh</b>.') + '</td></tr></tbody>';
}


/* ---------- every entry, month pack, change log ---------- */
const MODES = [['review', 'Every entry'], ['pack', 'Month pack'], ['log', 'Change log'], ['overview', 'Overview']];
const VERD = { ok: 'Justified', thin: 'Reference only', check: 'To check', fix: 'Must fix' };
const RS = [['attn', 'Needs attention', (r) => r.status === 'fix' || r.status === 'check'], ['fix', 'Must fix', (r) => r.status === 'fix'], ['check', 'To check', (r) => r.status === 'check'], ['thin', 'Reference only', (r) => r.status === 'thin'], ['ok', 'Justified', (r) => r.status === 'ok'], ['all', 'All', () => true]];
const refCell = (l) => (l.ref ? esc(l.ref) : /^(expense|journal|bill)$/.test(l.et) ? '<span class="muted">no reference</span>' : '') + (l.desc && l.desc !== l.ref ? '<div class="muted" style="font-size:12px">' + esc(l.desc) + '</div>' : '');
function reviewRows() {
  const q = ST.rq.trim().toLowerCase(), t = (RS.find((x) => x[0] === ST.rs) || RS[0])[2];
  return ST.rv.rows.filter((r) => t(r) && (!ST.rsec || r.a.sec === ST.rsec) && (!ST.racct || r.a.id === ST.racct) && (!q || [r.a.name, r.l.ref, r.l.desc, r.l.tno, r.l.cname, r.l.vname, r.l.td, Math.abs(r.amt).toFixed(2), r.issues.join(' ')].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.sev - a.sev || Math.abs(b.amt) - Math.abs(a.amt));
}
function renderReview() {
  const V = ST.rv, s = V.sum, el = $('#plRv'), pc = (n) => (s.n ? Math.round(n / s.n * 100) : 0) + '%';
  const base = V.rows.filter((r) => (!ST.rsec || r.a.sec === ST.rsec));
  const accs = [...new Map(base.map((r) => [r.a.id, r.a])).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (ST.racct && !accs.some((a) => a.id === ST.racct)) ST.racct = '';
  const rows = reviewRows();
  let h = '<div class="card" style="margin-top:16px"><header><div><h2>Every entry, checked</h2><span class="sub">' + periodLabel() + ' · ' + s.n.toLocaleString('en-US') + ' income and cost entries</span></div></header>' +
    '<div class="body"><div class="grid kpis">' + kpi('Justified', s.ok + ' · ' + pc(s.ok), 'AED ' + fmt0(s.okAmt) + ' · reference, and precedent or a document', 'ok') + kpi('Reference only', s.thin + ' · ' + pc(s.thin), 'AED ' + fmt0(s.thinAmt) + ' · nothing to compare with') + kpi('To check', s.check + ' · ' + pc(s.check), 'AED ' + fmt0(s.checkAmt), s.check ? 'low' : 'ok') + kpi('Must fix', String(s.fix), 'AED ' + fmt0(s.fixAmt), s.fix ? 'bad' : 'ok') + '</div></div>' +
    '<div class="pl-box">Each entry is tested for a reference, the right account, a client link where one is needed, duplicates, the side it is posted on, its date and, once Zoho Books has been read, a description and a receipt. <b>Precedent</b> means how the same supplier, merchant or reference wording is booked on every other entry in the books. “Reference only” entries have nothing wrong, but nothing backs them except their own reference.</div>' +
    '<div class="pl-tools"><div class="seg" role="group" aria-label="Verdict">' + RS.map(([k, t, fn]) => '<button type="button" data-plrs="' + k + '" class="' + (ST.rs === k ? 'on' : '') + '">' + t + ' <span class="muted">' + base.filter(fn).length + '</span></button>').join('') + '</div></div>' +
    '<div class="pl-tools"><input type="search" id="plRQ" placeholder="Search reference, account, client, supplier, amount" value="' + esc(ST.rq) + '" autocomplete="off" spellcheck="false" aria-label="Search entries">' +
    '<select id="plRSec" aria-label="Section"><option value="">All sections</option>' + Object.keys(E.SEC_LABEL).map((k) => '<option value="' + k + '"' + (ST.rsec === k ? ' selected' : '') + '>' + esc(E.SEC_LABEL[k]) + '</option>').join('') + '</select>' +
    '<select id="plRAcct" aria-label="Account"><option value="">All accounts (' + accs.length + ')</option>' + accs.map((a) => '<option value="' + esc(a.id) + '"' + (a.id === ST.racct ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select>' +
    '<span class="sub">' + rows.length.toLocaleString('en-US') + ' shown · AED ' + fmt0(rows.reduce((t, r) => t + Math.abs(r.amt), 0)) + '</span></div>';
  if (!rows.length) h += '<div class="pl-empty">No entries match.</div>';
  else {
    h += '<div class="scroll" style="max-height:680px"><table><thead><tr><th>Date</th><th>Ref #</th><th>Type</th><th>Account</th><th>Reference / description</th><th>Client / supplier</th><th class="n">Amount</th><th>Verdict</th><th>Why, and what to do</th><th></th></tr></thead><tbody>';
    for (const r of rows.slice(0, ST.rshown)) { const l = r.l;
      h += '<tr><td>' + dlab(l.td) + '</td><td class="num" style="text-align:left">' + esc(l.tno) + '</td><td>' + esc(TYPE[l.et] || l.et) + '</td><td><button class="linkish" type="button" data-placc2="' + esc(r.a.id) + '">' + esc(r.a.name) + '</button><div class="muted" style="font-size:12px">' + esc(E.SEC_LABEL[r.a.sec]) + '</div></td><td class="wrap">' + refCell(l) + '</td><td class="wrap">' + esc([l.cname, l.vname].filter(Boolean).join(' · ')) + '</td><td class="n">' + neg(l.amt, fmt(l.amt)) + '</td><td><span class="pl-v ' + r.status + '">' + VERD[r.status] + '</span></td><td class="wrap pl-why2">' + r.issues.map((i) => '<div class="is">' + esc(i) + '</div>').join('') + (r.basis ? '<div class="ba">' + esc(r.basis) + '</div>' : '') + (r.todo.length ? '<div class="do"><b>Do:</b> ' + esc(r.todo.join(' ')) + '</div>' : '') + '</td><td>' + blink(l) + '</td></tr>'; }
    h += '</tbody></table></div>';
    if (rows.length > ST.rshown) h += '<div class="pl-tools"><button class="btn" type="button" data-plrmore>Show ' + Math.min(300, rows.length - ST.rshown) + ' more</button><span class="sub">' + (rows.length - ST.rshown).toLocaleString('en-US') + ' not shown; the Excel export has every entry</span></div>';
  }
  el.innerHTML = h + '</div>';
}
function renderPack() {
  const R = ST.R, el = $('#plPk'); let ms = [...ST.set].filter((m) => R.months.includes(m)).sort(); const cut = ms.length > 3; if (cut) ms = ms.slice(-3);
  let h = cut ? '<div class="card" style="margin-top:16px"><div class="pl-box">The month pack shows the last three months of the chosen period. Pick a shorter period for other months.</div></div>' : '';
  for (const m of ms.reverse()) {
    const K = E.monthPack(R, m), V = E.review(R, new Set([m])).sum, T = K.cur, P = K.pv;
    const row = (l, a, b, bold) => '<tr' + (bold ? ' class="tot"' : '') + '><td>' + l + '</td><td class="n">' + neg(a, fmt0(a)) + '</td><td class="n">' + neg(b, fmt0(b)) + '</td><td class="n">' + neg(a - b, (a - b > 0 ? '+' : '') + fmt0(a - b)) + '</td></tr>';
    const movers = K.lines.filter((x) => x.big).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    h += '<div class="card" style="margin-top:16px"><header><div><h2>' + mlab(m) + (K.open ? ' · month still open' : '') + '</h2><span class="sub">against ' + mlab(K.prev) + ' and the average of ' + K.base.map(mlab).join(', ') + '</span></div><button class="btn" type="button" data-plgo="' + m + '">Check this month’s entries</button></header>' +
      '<div class="scroll"><table class="pl-hl"><thead><tr><th></th><th class="n">' + mlab(m) + '</th><th class="n">' + mlab(K.prev) + '</th><th class="n">Change</th></tr></thead><tbody>' + row('Income', T.income + T.oinc, P.income + P.oinc) + row('Cost of goods sold', T.cogs, P.cogs) + row('Gross profit', T.gross, P.gross, true) + row('Operating expenses', T.opex + T.oexp, P.opex + P.oexp) + row('Net profit', T.net, P.net, true) + '</tbody></table></div>' +
      (K.pendingN ? '<div class="pl-box warn"><b>' + (K.open ? 'Not final: ' : 'Possibly incomplete: ') + K.pendingN + ' regular costs worth about AED ' + fmt0(K.pending) + ' a month ' + (K.open ? 'are not booked yet' : 'have nothing booked') + '.</b> ' + (K.open ? 'Net profit of ' + fmt0(T.net) + ' would be about ' + fmt0(T.net - K.pending) + ' once they are in.' : 'If they belong to ' + mlab(m) + ', net profit of ' + fmt0(T.net) + ' is overstated by up to that amount. They are marked “missing” below.') + '</div>' : '') +
      '<div class="pl-box"><b>Evidence:</b> ' + V.n + ' entries · ' + V.ok + ' justified · ' + V.thin + ' on their reference only · ' + V.check + ' to check (AED ' + fmt0(V.checkAmt) + ') · ' + V.fix + ' must fix (AED ' + fmt0(V.fixAmt) + ').</div>';
    if (movers.length) {
      h += '<div class="scroll" style="max-height:520px"><table><thead><tr><th>Account</th><th>Section</th><th class="n">' + mlab(m) + '</th><th class="n">' + mlab(K.prev) + '</th><th class="n">3-month average</th><th class="n">Against average</th><th>What explains it</th></tr></thead><tbody>';
      for (const x of movers) h += '<tr><td><button class="linkish" type="button" data-placc2="' + esc(x.a.id) + '" data-plgo="' + m + '">' + esc(x.a.name) + '</button>' + (x.missing ? ' <span class="pl-v ' + (K.open ? 'thin' : 'check') + '">' + (K.open ? 'not booked yet' : 'missing') + '</span>' : '') + '</td><td>' + esc(E.SEC_LABEL[x.a.sec]) + '</td><td class="n">' + neg(x.v, fmt0(x.v)) + '</td><td class="n">' + neg(x.prev, fmt0(x.prev)) + '</td><td class="n">' + fmt0(x.avg) + '</td><td class="n">' + (x.d > 0 ? '+' : '') + neg(x.d, fmt0(x.d)) + '</td><td class="wrap">' + esc(x.why) + '</td></tr>';
      h += '</tbody></table></div><div class="note">Accounts that moved by at least AED 2,000 and 30% against their three-month average. The explanation lists the largest entries behind the figure.</div>';
    }
    h += '</div>';
  }
  el.innerHTML = h || '<div class="card" style="margin-top:16px"><div class="pl-empty">No months in this period.</div></div>';
}
/* entries of the cost-of-sales and disbursement accounts, remembered in this browser so the next read can show what was changed or deleted */
const tracked = (a) => a.sec === 'cogs' || a.pass;
function snapshot() {
  try { ST.snapEv = JSON.parse(localStorage.getItem('pnl.snapev.v1') || '[]'); } catch (e) { ST.snapEv = []; }
  if (!ST.fresh || !ST.R) return; ST.fresh = false;
  try {
    const cur = {}; for (const l of ST.R.L) if (tracked(l.a)) cur[l.atid] = [l.a.id, l.amt, l.td, l.tno, l.ref.slice(0, 60), l.cname.slice(0, 40)];
    const old = JSON.parse(localStorage.getItem('pnl.snap.v1') || 'null'), at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    if (old && old.m) {
      const nm = (id) => { const a = ST.R.A.get(id); return a ? a.name : 'an account outside cost of sales'; }, ev = [];
      for (const [k, o] of Object.entries(old.m)) { const c = cur[k];
        if (!c) { const still = ST.R.L.find((l) => l.atid === k); ev.push({ at, since: old.at, kind: still ? 'Moved out' : 'Deleted', tno: o[3], ref: o[4], cl: o[5], td: o[2], acct: nm(o[0]), amt: o[1], note: still ? 'Moved from “' + nm(o[0]) + '” to “' + still.a.name + '”' : 'No longer in the ledger: deleted, or its account or amount line was replaced' }); continue; }
        if (c[0] !== o[0]) ev.push({ at, since: old.at, kind: 'Account changed', tno: c[3], ref: c[4], cl: c[5], td: c[2], acct: nm(c[0]), amt: c[1], note: 'Moved from “' + nm(o[0]) + '” to “' + nm(c[0]) + '”' });
        if (Math.abs(c[1] - o[1]) > 0.005) ev.push({ at, since: old.at, kind: 'Amount changed', tno: c[3], ref: c[4], cl: c[5], td: c[2], acct: nm(c[0]), amt: c[1], note: 'Was ' + fmt(o[1]) + ', now ' + fmt(c[1]) + ' (' + (c[1] - o[1] > 0 ? '+' : '') + fmt(c[1] - o[1]) + ')' });
        if (c[2] !== o[2]) ev.push({ at, since: old.at, kind: 'Date changed', tno: c[3], ref: c[4], cl: c[5], td: c[2], acct: nm(c[0]), amt: c[1], note: 'Was dated ' + o[2] + ', now ' + c[2] });
      }
      if (ev.length) { ST.snapEv = ev.concat(ST.snapEv).slice(0, 400); localStorage.setItem('pnl.snapev.v1', JSON.stringify(ST.snapEv)); }
    }
    localStorage.setItem('pnl.snap.v1', JSON.stringify({ at, m: cur }));
  } catch (e) {}
}
const LSCOPE = [['both', 'Cost of sales + disbursements', tracked], ['cogs', 'Cost of goods sold', (a) => a.sec === 'cogs'], ['disb', 'Disbursements of expenses', (a) => a.pass], ['all', 'All income and cost accounts', () => true]];
const LKIND = [['closed', 'Changed a closed month', (c) => c.kind === 'backdated' || c.kind === 'editclosed'], ['edited', 'Edited', (c) => c.kind === 'edited' || c.kind === 'editclosed'], ['created', 'Entered', (c) => c.kind === 'created' || c.kind === 'backdated'], ['all', 'All', () => true]];
const LK = { created: ['ok', 'Entered'], backdated: ['check', 'Entered late'], edited: ['thin', 'Edited'], editclosed: ['fix', 'Edited after month end'] };
function logRows() {
  const ms = [...ST.set].sort(), from = (ms[0] || ST.R.curM) + '-01', to = ST.R.today;
  const sc = LSCOPE.find((x) => x[0] === ST.lscope) || LSCOPE[0];
  return { from, to, all: E.changes(ST.R, from, to, sc[2]) };
}
function renderLog() {
  const el = $('#plLg'), G = logRows(), kf = (LKIND.find((x) => x[0] === ST.lkind) || LKIND[0])[2], rows = G.all.filter(kf);
  const sumOf = (fn) => { const a = G.all.filter(fn); return [a.length, a.reduce((t, c) => t + Math.abs(c.l.amt), 0)]; };
  const k1 = sumOf((c) => c.kind === 'created'), k2 = sumOf((c) => c.kind === 'backdated'), k3 = sumOf((c) => c.kind === 'edited'), k4 = sumOf((c) => c.kind === 'editclosed');
  let h = '<div class="card" style="margin-top:16px"><header><div><h2>Change log</h2><span class="sub">Entered or edited from ' + dlab(G.from) + ' to ' + dlab(G.to) + ', by Zoho’s own timestamps</span></div><div class="controls"><div class="seg" role="group" aria-label="Accounts">' + LSCOPE.map(([k, t]) => '<button type="button" data-plls="' + k + '" class="' + (ST.lscope === k ? 'on' : '') + '">' + t + '</button>').join('') + '</div></div></header>' +
    '<div class="body"><div class="grid kpis">' + kpi('Entered', String(k1[0]), 'AED ' + fmt0(k1[1]) + ' · in its own month') + kpi('Entered late', String(k2[0]), 'AED ' + fmt0(k2[1]) + ' · dated in an earlier month', k2[0] ? 'low' : 'ok') + kpi('Edited', String(k3[0]), 'AED ' + fmt0(k3[1]) + ' · month still open') + kpi('Edited after month end', String(k4[0]), 'AED ' + fmt0(k4[1]) + ' · a reported month moved', k4[0] ? 'bad' : 'ok') + '</div></div>' +
    '<div class="pl-box">Zoho records when an entry was first entered and when it was last edited, but not what the edit changed. An entry edited twice shows only its last edit. To see old and new values, this page remembers the cost-of-sales and disbursement entries in your browser at each refresh and lists the differences below from the second refresh on. The Customers Fund Disbursement Account has its own log: <button class="linkish" type="button" data-plcfda>open its Change log tab</button>.</div>' +
    '<div class="pl-tools"><div class="seg" role="group" aria-label="Kind">' + LKIND.map(([k, t, fn]) => '<button type="button" data-pllk="' + k + '" class="' + (ST.lkind === k ? 'on' : '') + '">' + t + ' <span class="muted">' + G.all.filter(fn).length + '</span></button>').join('') + '</div><span class="sub">' + rows.length + ' shown</span></div>';
  if (!rows.length) h += '<div class="pl-empty">Nothing of this kind in the period.</div>';
  else {
    h += '<div class="scroll" style="max-height:620px"><table><thead><tr><th>When</th><th>What happened</th><th>Dated</th><th>Ref #</th><th>Account</th><th>Reference</th><th>Client / supplier</th><th class="n">Amount</th><th>Effect</th><th></th></tr></thead><tbody>';
    for (const c of rows.slice(0, ST.lshown)) { const l = c.l, k = LK[c.kind];
      h += '<tr><td style="white-space:nowrap">' + esc(dlab(c.when.slice(0, 10)) + ' ' + c.when.slice(11)) + '</td><td><span class="pl-v ' + k[0] + '">' + k[1] + '</span></td><td>' + dlab(l.td) + '</td><td class="num" style="text-align:left">' + esc(l.tno) + '</td><td>' + esc(l.a.name) + '</td><td class="wrap">' + refCell(l) + '</td><td class="wrap">' + esc([l.cname, l.vname].filter(Boolean).join(' · ')) + '</td><td class="n">' + neg(l.amt, fmt(l.amt)) + '</td><td class="wrap pl-why2">' + esc(c.note) + '</td><td>' + blink(l) + '</td></tr>'; }
    h += '</tbody></table></div>';
    if (rows.length > ST.lshown) h += '<div class="pl-tools"><button class="btn" type="button" data-pllmore>Show ' + Math.min(300, rows.length - ST.lshown) + ' more</button></div>';
  }
  h += '</div><div class="card" style="margin-top:16px"><header><div><h2>Changed since an earlier refresh</h2><span class="sub">Cost of sales and disbursement entries · old and new values · kept in this browser</span></div></header>';
  if (!ST.snapEv.length) h += '<div class="pl-empty">No differences recorded yet. The entries were remembered at this refresh; anything moved, re-valued, re-dated or deleted before the next refresh will be listed here.</div>';
  else { h += '<div class="scroll" style="max-height:460px"><table><thead><tr><th>Noticed</th><th>Change</th><th>Dated</th><th>Ref #</th><th>Account</th><th>Reference</th><th>Client</th><th class="n">Amount</th><th>Old and new</th></tr></thead><tbody>';
    for (const e of ST.snapEv.slice(0, 200)) h += '<tr><td style="white-space:nowrap">' + esc(e.at) + '<div class="muted" style="font-size:12px">since ' + esc(e.since || '') + '</div></td><td><span class="pl-v ' + (e.kind === 'Deleted' ? 'fix' : 'check') + '">' + esc(e.kind) + '</span></td><td>' + dlab(e.td) + '</td><td class="num" style="text-align:left">' + esc(e.tno) + '</td><td>' + esc(e.acct) + '</td><td class="wrap">' + esc(e.ref) + '</td><td class="wrap">' + esc(e.cl) + '</td><td class="n">' + fmt(e.amt) + '</td><td class="wrap pl-why2">' + esc(e.note) + '</td></tr>';
    h += '</tbody></table></div>'; }
  el.innerHTML = h + '</div>';
}

/* ---------- export ---------- */
async function exportXls() {
  const K = core(), R = ST.R; if (!R) return;
  try {
    if (!window.XLSX) await K.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const X = window.XLSX, wb = X.utils.book_new();
    const todo = [['Check', 'Priority', 'Date', 'Month', 'Type', 'Ref #', 'Account', 'Section', 'Reference', 'Description', 'Client', 'Supplier', 'Amount AED', 'Why it is listed', 'What to do', 'Zoho Books link']];
    for (const f of R.findings) for (const i of itemsOf(f)) { const l = i.l, a = i.a; todo.push([f.title, SEV[f.sev][1], l ? l.td : '', i.m || '', l ? TYPE[l.et] || l.et : 'Account', l ? l.tno : '', a.name, E.SEC_LABEL[a.sec], l ? l.ref : '', l ? l.desc : '', l ? l.cname : '', l ? l.vname : '', i.amt, i.note, f.todo, l && LINK[l.et] ? 'https://books.zoho.com/app/' + ORG + '#/' + LINK[l.et] + '/' + l.eid : '']); }
    const w1 = X.utils.aoa_to_sheet(todo); w1['!cols'] = [28, 10, 11, 9, 12, 10, 34, 20, 50, 50, 28, 28, 14, 50, 60, 40].map((wch) => ({ wch }));
    X.utils.book_append_sheet(wb, w1, 'To do');
    const cols = columns(), S = ST.S, sum = (by, c) => E.r2(c.ms.reduce((t, m) => t + (by.get(m) || 0), 0));
    const st = [['Elite Onelink Corporate Services L.L.C S.O.C – Profit and loss, ' + periodLabel() + ' (AED)'], [], ['Section', 'Group', 'Account'].concat(cols.map((c) => c.label), ['Total'])];
    for (const k of ['income', 'cogs', 'opex', 'oinc', 'oexp']) {
      const s = S.secs[k]; if (!s.groups.size) continue;
      for (const g of s.groups.values()) for (const x of g.accounts) st.push([s.label, g.name, x.a.name].concat(cols.map((c) => sum(x.by, c)), [x.total]));
      st.push([s.label + ' total', '', ''].concat(cols.map((c) => sum(s.by, c)), [s.total]));
      if (k === 'cogs') st.push(['Gross profit', '', ''].concat(cols.map((c) => sum(S.gross, c)), [S.T.gross]));
      if (k === 'opex') st.push(['Operating profit', '', ''].concat(cols.map((c) => sum(S.oper, c)), [S.T.oper]));
    }
    st.push(['Net profit', '', ''].concat(cols.map((c) => sum(S.net, c)), [S.T.net]));
    const w2 = X.utils.aoa_to_sheet(st); w2['!cols'] = [{ wch: 24 }, { wch: 28 }, { wch: 40 }].concat(cols.map(() => ({ wch: 13 })), [{ wch: 14 }]);
    X.utils.book_append_sheet(wb, w2, 'P&L');
    const ev = [['Verdict', 'Date', 'Month', 'Type', 'Ref #', 'Account', 'Section', 'Reference', 'Description', 'Client', 'Supplier', 'Amount AED', 'What is wrong', 'What supports it', 'What to do', 'Zoho Books link']];
    for (const r of ST.rv.rows.slice().sort((a, b) => b.sev - a.sev || a.l.td.localeCompare(b.l.td))) { const l = r.l; ev.push([VERD[r.status], l.td, l.m, TYPE[l.et] || l.et, l.tno, r.a.name, E.SEC_LABEL[r.a.sec], l.ref, l.desc, l.cname, l.vname, l.amt, r.issues.join(' | '), r.basis, r.todo.join(' '), LINK[l.et] ? 'https://books.zoho.com/app/' + ORG + '#/' + LINK[l.et] + '/' + l.eid : '']); }
    const w3 = X.utils.aoa_to_sheet(ev); w3['!cols'] = [14, 11, 9, 12, 12, 34, 20, 46, 46, 26, 26, 13, 60, 50, 60, 40].map((wch) => ({ wch }));
    X.utils.book_append_sheet(wb, w3, 'Every entry');
    const pk = [['Month', 'Account', 'Section', 'This month', 'Previous month', '3-month average', 'Against average', 'Missing', 'What explains it']];
    for (const m of [...ST.set].filter((m) => R.months.includes(m)).sort().slice(-3)) { const K = E.monthPack(R, m); pk.push([m, 'NET PROFIT', '', K.cur.net, K.pv.net, '', '', '', K.pendingN ? K.pendingN + ' regular costs of about ' + Math.round(K.pending) + ' not booked' : '']); for (const x of K.lines.filter((x) => x.big).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))) pk.push([m, x.a.name, E.SEC_LABEL[x.a.sec], x.v, x.prev, x.avg, x.d, x.missing ? 'Yes' : '', x.why]); }
    const w4 = X.utils.aoa_to_sheet(pk); w4['!cols'] = [9, 36, 20, 13, 13, 13, 13, 8, 90].map((wch) => ({ wch }));
    X.utils.book_append_sheet(wb, w4, 'Month pack');
    const lg = [['When', 'What happened', 'Dated', 'Ref #', 'Account', 'Reference', 'Client', 'Supplier', 'Amount AED', 'Effect']];
    for (const c of logRows().all) lg.push([c.when, LK[c.kind][1], c.l.td, c.l.tno, c.l.a.name, c.l.ref, c.l.cname, c.l.vname, c.l.amt, c.note]);
    for (const e of ST.snapEv) lg.push([e.at, e.kind, e.td, e.tno, e.acct, e.ref, e.cl, '', e.amt, e.note]);
    const w5 = X.utils.aoa_to_sheet(lg); w5['!cols'] = [17, 22, 11, 12, 34, 46, 26, 26, 13, 80].map((wch) => ({ wch }));
    X.utils.book_append_sheet(wb, w5, 'Change log');
    await K.saveFile('PnL_review_' + todayDubai() + '.xlsx', new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })));
  } catch (e) { ST.err = 'Export failed: ' + ((e && e.message) || e); renderStatus(); }
}

/* ---------- events ---------- */
root.addEventListener('click', (ev) => {
  const t = ev.target;
  const md = t.closest('[data-plm]'); if (md) { ST.mode = md.dataset.plm; saveUi(); return render(); }
  const go = t.closest('[data-plgo]'); if (go) { ST.period = 'custom'; ST.from = ST.to = go.dataset.plgo; ST.mode = 'review'; ST.rs = 'attn'; ST.rsec = ''; ST.rq = ''; ST.racct = (t.closest('[data-placc2]') || { dataset: {} }).dataset.placc2 || ''; if (ST.racct) ST.rs = 'all'; ST.rshown = 150; render(); window.scrollTo({ top: root.getBoundingClientRect().top + window.scrollY - 80 }); return; }
  const rs = t.closest('[data-plrs]'); if (rs) { ST.rs = rs.dataset.plrs; ST.rshown = 150; return renderReview(); }
  if (t.closest('[data-plrmore]')) { ST.rshown += 300; return renderReview(); }
  const a2 = t.closest('[data-placc2]'); if (a2) { ST.racct = a2.dataset.placc2; ST.rs = 'all'; ST.mode = 'review'; ST.rshown = 150; return render(); }
  const ls = t.closest('[data-plls]'); if (ls) { ST.lscope = ls.dataset.plls; ST.lshown = 150; return renderLog(); }
  const lk = t.closest('[data-pllk]'); if (lk) { ST.lkind = lk.dataset.pllk; ST.lshown = 150; return renderLog(); }
  if (t.closest('[data-pllmore]')) { ST.lshown += 300; return renderLog(); }
  if (t.closest('[data-plcfda]')) { const tb = [...document.querySelectorAll('.tab')].find((x) => /change log/i.test(x.textContent)); if (tb) tb.click(); return; }
  const p = t.closest('[data-plp]'); if (p) { ST.period = p.dataset.plp; ST.shown = 100; saveUi(); return render(); }
  const v = t.closest('[data-plv]'); if (v) { ST.view = v.dataset.plv; saveUi(); renderTop(); return renderStatement(); }
  const c = t.closest('[data-plck]'); if (c) { ST.check = c.dataset.plck; ST.q = ''; ST.acct = ''; ST.shown = 100; return renderChecks(); }
  if (t.closest('[data-plmore]')) { ST.shown += 200; return renderDetail(); }
  if (t.closest('[data-plbooks]')) return loadBooks();
  const g = t.closest('[data-plgrp]'); if (g) { const k = g.dataset.plgrp; ST.shut.has(k) ? ST.shut.delete(k) : ST.shut.add(k); return renderStatement(); }
  const a = t.closest('[data-placc]'); if (a && !t.closest('a')) { ST.drill = a.dataset.placc; renderStatement(); renderDrill(); const card = $('#plDrillCard'); if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (t.closest('#plDrillX')) { ST.drill = ''; renderStatement(); return renderDrill(); }
  if (t.closest('#plXls')) return exportXls();
  if (t.closest('#plRefresh')) { const K = core(); if (K.mcp) return refresh(true); if (K.connect) return Promise.resolve(K.connect()).then(() => refresh(true)); ST.err = 'Live figures load when this page is opened in claude.ai with the Zoho Analytics and Zoho Books connectors.'; return renderStatus(); }
});
root.addEventListener('input', (ev) => { if (ev.target.id === 'plRQ') { ST.rq = ev.target.value; ST.rshown = 150; const pos = ev.target.selectionStart; renderReview(); const q = $('#plRQ'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {} } return; } if (ev.target.id === 'plQ') { ST.q = ev.target.value; ST.shown = 100; const pos = ev.target.selectionStart; renderDetail(); const q = $('#plQ'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {} } } });
root.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'plRSec') { ST.rsec = ev.target.value; ST.racct = ''; ST.rshown = 150; return renderReview(); }
  if (id === 'plRAcct') { ST.racct = ev.target.value; ST.rshown = 150; return renderReview(); }
  if (id === 'plAcct') { ST.acct = ev.target.value; ST.shown = 100; renderDetail(); }
  else if (id === 'plSort') { ST.sort = ev.target.value; renderDetail(); }
  else if (id === 'plFrom' || id === 'plTo') { ST.from = $('#plFrom').value; ST.to = $('#plTo').value; render(); }
});
const panel = document.getElementById('p-pnl');
const visible = () => !!panel && panel.classList.contains('on');
if (panel) new MutationObserver(() => { if (visible()) { render(); refresh(false); } }).observe(panel, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('cfd-core', () => { renderStatus(); if (visible() && !ST.busy) refresh(false); });
recompute(); render();
if (visible()) refresh(false);
})();
