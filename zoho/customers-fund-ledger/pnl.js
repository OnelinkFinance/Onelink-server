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
const ST = { rows: null, acc: null, at: 0, busy: false, err: '', hid: { n: 0, amt: 0 }, R: null, S: null, set: null, period: 'todate', from: '', to: '', view: 'month', check: null, q: '', acct: '', sort: 'amt', shown: 100, shut: new Set(), drill: '', flags: new Map() };
const BK = { map: null, at: 0, busy: false, page: 0, err: '' };
try { const c = JSON.parse(sessionStorage.getItem('pnl.rows.v1') || 'null'); if (c && c.rows && c.acc) { ST.rows = c.rows.map((r) => Object.fromEntries(c.cols.map((k, i) => [k, r[i]]))); ST.acc = c.acc; ST.at = c.at; ST.hid = c.hid || ST.hid; } } catch (e) {}
try { const c = JSON.parse(localStorage.getItem('pnl.bk.v1') || 'null'); if (c && c.rows) { BK.map = new Map(c.rows.map((r) => [r[0], { a: !!r[1], v: r[2], m: r[3], d: r[4], r: r[5] }])); BK.at = c.at; } } catch (e) {}
try { const p = JSON.parse(localStorage.getItem('pnl.ui.v1') || 'null'); if (p) { ST.period = p.period || ST.period; ST.view = p.view || ST.view; } } catch (e) {}
const saveUi = () => { try { localStorage.setItem('pnl.ui.v1', JSON.stringify({ period: ST.period, view: ST.view })); } catch (e) {} };

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
  const fix = ST.R.findings.filter((f) => f.sev === 'fix').reduce((t, f) => t + f.items.length, 0);
  const cnt = document.getElementById('cntPnl'); if (cnt) { cnt.textContent = fix || ''; cnt.classList.toggle('hot', fix > 0); }
}
async function refresh(force) {
  const K = core(); if (!K.mcp || !K.exportCSV || ST.busy) return;
  if (!force && ST.at && Date.now() - ST.at < 30 * 60000) return;
  ST.busy = true; ST.err = ''; renderStatus();
  try {
    const [rows, acc] = await Promise.all([K.exportCSV(Q.pl), K.exportCSV(Q.ac)]);
    ST.rows = scope(rows); ST.acc = acc; ST.at = Date.now();
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
  else if (ST.period === 'thism') ms = [cur];
  else if (ST.period === 'future') ms = all;
  else if (ST.period === 'custom') { const a = ST.from || all[0], b = ST.to || all[all.length - 1]; ms = all.filter((m) => m >= (a < b ? a : b) && m <= (a < b ? b : a)); }
  else ms = R.months;
  return new Set(ms);
}
const PERIODS = [['todate', 'All to date'], ['ytd', 'This year'], ['l12', 'Last 12 months'], ['lastm', 'Last month'], ['thism', 'This month'], ['future', 'Incl. future-dated'], ['custom', 'Custom']];
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
  '#plPeriod,#plView{flex-wrap:wrap;max-width:100%}#pnlRoot .controls{flex-wrap:wrap;min-width:0;max-width:100%}' +
  '.pl-empty{padding:28px 16px;color:var(--ink-3);text-align:center;line-height:1.6}' +
  '.pl-status{display:flex;flex-wrap:wrap;gap:4px 16px;padding:0 16px 12px;font-size:12px;color:var(--ink-3)}.pl-status b{color:var(--ink-2);font-weight:600}.pl-status .err{color:var(--crit)}' +
  '</style>' +
  '<div class="card"><header><div><h2>Profit and loss review</h2><span class="sub" id="plSub"></span></div>' +
  '<div class="controls"><div class="seg" id="plPeriod" role="group" aria-label="Period"></div><span id="plCustom" hidden><select id="plFrom" aria-label="From month"></select> <span class="lbl">to</span> <select id="plTo" aria-label="To month"></select></span>' +
  '<button class="btn" type="button" id="plXls">Export Excel</button><button class="btn primary" type="button" id="plRefresh">Refresh from Zoho</button></div></header>' +
  '<div class="body"><div class="grid kpis" id="plKpis"></div></div><div class="pl-status" id="plStatus"></div><ul class="pl-ins" id="plIns"></ul></div>' +
  '<div class="card" style="margin-top:16px" id="plTodo"><header><div><h2>What needs to be done</h2><span class="sub" id="plTodoSub"></span></div></header><div class="pl-grid"><div class="pl-cks" id="plCks"></div><div class="pl-det" id="plDet"></div></div></div>' +
  '<div class="card" style="margin-top:16px"><header><div><h2>Profit and loss by period</h2><span class="sub" id="plStSub"></span></div><div class="controls"><div class="seg" id="plView" role="group" aria-label="Columns"></div></div></header>' +
  '<div class="scroll"><table class="pl-st" id="plSt"></table></div><div class="note">Figures are the accrual ledger in Zoho Books, in AED: income is credits less debits, costs are debits less credits. “Disbursements Of Expenses” holds costs billed straight on to clients, so it nets to about zero. Click an account to list its entries. An orange number beside an account is how many of its entries are on the list above.</div></div>' +
  '<div class="card" style="margin-top:16px" id="plDrillCard" hidden><header><div><h2 id="plDrillH"></h2><span class="sub" id="plDrillSub"></span></div><button class="btn" type="button" id="plDrillX">Close</button></header><div class="scroll" style="max-height:520px"><table id="plDrill"></table></div></div>';

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
  if (!R) $('#plSt').innerHTML = '<tbody><tr><td class="pl-empty">' + (ST.busy ? 'Reading the P&L from Zoho…' : K.mcp ? 'Press Refresh from Zoho to read the P&L.' : 'The P&L is read live from Zoho with your own access; none of it is stored in this page.<br>Open the page in claude.ai, then press <b>Connect Zoho &amp; refresh</b>.') + '</td></tr></tbody>';
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
    await K.saveFile('PnL_review_' + todayDubai() + '.xlsx', new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })));
  } catch (e) { ST.err = 'Export failed: ' + ((e && e.message) || e); renderStatus(); }
}

/* ---------- events ---------- */
root.addEventListener('click', (ev) => {
  const t = ev.target;
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
root.addEventListener('input', (ev) => { if (ev.target.id === 'plQ') { ST.q = ev.target.value; ST.shown = 100; const pos = ev.target.selectionStart; renderDetail(); const q = $('#plQ'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {} } } });
root.addEventListener('change', (ev) => {
  const id = ev.target.id;
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
