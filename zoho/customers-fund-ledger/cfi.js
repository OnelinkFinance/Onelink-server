/* Fund intelligence tab of the Customers Fund Ledger page.
   Reads four Zoho Books custom modules live — Client CFDA Balances, Client Payment Requests, CFDA Statement Lines and
   Deal Submissions — and works out, per client, what is held, what is committed to open payment requests and whether
   each request is covered (rules: cfi-engine.js, the same code as server/cfi-engine.js). Nothing is written to Zoho. */
(function () {
'use strict';
const C = window.CFI, root = document.getElementById('cfiRoot');
if (!C || !root) return;
const $ = (s, r) => (r || root).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || n === '' || isNaN(n) ? '—' : (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt0 = (n) => (n == null || isNaN(n) ? '—' : (n < 0 ? '−' : '') + Math.round(Math.abs(n)).toLocaleString('en-US'));
const neg = (n, t) => (n < -0.004 ? '<span class="neg">' + t + '</span>' : t);
const num = (v) => { const x = Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')); return v === '' || v == null || !isFinite(x) ? 0 : x; };
const str = (v) => String(v == null ? '' : v).trim();
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dlab = (d) => (d && d.length >= 10 ? +d.slice(8, 10) + ' ' + MN[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : d || '');
const today = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
const when = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ORG = '898300452', ZB = 'Zoho Books';
const core = () => window.CFD_CORE || {};
const MODS = {
  cfda: { api: 'cm_client_cfda_balance', label: 'Client CFDA Balances', pages: 10 },
  req: { api: 'cm_client_payment_request', label: 'Client Payment Requests', pages: 5 },
  line: { api: 'cm_cfda_statement_line', label: 'CFDA Statement Lines', pages: 3 },
  deal: { api: 'cm_deal_submission', label: 'Deal Submissions', pages: 3 },
};
const MAP = {
  cfda: (r) => ({ id: str(r.module_record_id), client_id: str(r.cf_client), client: str(r.cf_client_formatted || r.record_name), received: num(r.cf_received_into_cfda), paid: num(r.cf_paid_out_of_cfda), balance: r.cf_cfda_balance === '' || r.cf_cfda_balance == null ? null : num(r.cf_cfda_balance), other: num(r.cf_bills_credit_notes_invoices_on_cfda), entries: num(r.cf_entries_counted), last_entry: str(r.cf_last_cfda_entry_date), updated_at: str(r.cf_updated_at) }),
  req: (r) => ({ id: str(r.module_record_id), name: str(r.record_name) || '(no company name)', client_id: str(r.cf_client), client: str(r.cf_client_formatted), service: str(r.cf_service), amount: num(r.cf_amount_aed), status: str(r.status), payment_status: str(r.cf_status), paid_date: str(r.cf_paid_date), created: str(r.created_time).slice(0, 10), mode: str(r.cf_fund_transfer_type), ref: str(r.cf_authority_invoice_or_ref_no), check_balance: r.cf_cfda_balance === '' || r.cf_cfda_balance == null ? null : num(r.cf_cfda_balance), check_result: str(r.cf_covered_or_short), checked_at: str(r.cf_balance_checked_at) }),
  line: (r) => ({ id: str(r.module_record_id), client_id: str(r.cf_client), client: str(r.cf_client_formatted), date: str(r.cf_transaction_date), type: str(r.cf_entity_type), ref: str(r.cf_reference_no || r.record_name), paid: num(r.cf_paid_aed), received: num(r.cf_received_aed), running: r.cf_running_balance_aed === '' || r.cf_running_balance_aed == null ? null : num(r.cf_running_balance_aed) }),
  /* Deal Submission fields are kept as they come, so new fields show without a change here */
  deal: (r) => { const f = {}; for (const k of Object.keys(r)) if (/^cf_.*_formatted$/.test(k) && str(r[k])) f[k.slice(3, -10)] = str(r[k]); return { id: str(r.module_record_id), name: str(r.record_name), client: str(r.cf_client_formatted || r.cf_customer_formatted), status: str(r.status), created: str(r.created_time).slice(0, 10), f }; },
};

const ST = { d: { cfda: [], req: [], line: [], deal: [] }, more: {}, err: {}, at: 0, busy: false, step: '', clients: [], reqs: [], hid: 0, q: '', f: 'all', sort: 'available', dir: 1, rf: 'open', sel: '', selLines: null, selBusy: false, shown: 60 };

/* ---------- data ---------- */
const payloadOf = (res) => { let p = res && (res.payload !== undefined ? res.payload : res); if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) {} } return p; };
async function page(api, params) {
  const p = payloadOf(await core().mcp.callTool(ZB, 'list_custom_module_records', { path_variables: { module_name: api }, query_params: Object.assign({ organization_id: ORG, per_page: 200, sort_column: 'created_time', sort_order: 'D' }, params) }, { cache: false }));
  let d = (p && (p.data || p)) || {}; if (d.data && !d.module_records) d = d.data;
  if (!Array.isArray(d.module_records)) throw new Error(d.message || 'Zoho Books did not answer.');
  return { recs: d.module_records, more: !!(d.page_context && d.page_context.has_more_page) };
}
async function loadMod(k) {
  const m = MODS[k], out = []; let more = false;
  for (let pg = 1; pg <= m.pages; pg++) { const r = await page(m.api, { page: pg }); out.push(...r.recs.map(MAP[k])); more = r.more; if (!more) break; }
  return { rows: out, more };
}
const hidden = (name) => { const S = window.OLScope; return !!(S && S.hidden && S.hidden({ cname: name, ref: '' })); };
function compute() {
  const t = today(), by = new Map(); ST.hid = 0;
  const get = (id, name) => { let c = by.get(id); if (!c) { c = { id, client: name || '', cfda: null, reqs: [] }; by.set(id, c); } if (!c.client && name) c.client = name; return c; };
  for (const b of ST.d.cfda) if (b.client_id) { const c = get(b.client_id, b.client); c.cfda = b; c.client = b.client || c.client; }
  for (const q of ST.d.req) if (q.client_id) get(q.client_id, q.client).reqs.push(q);
  const clients = [], reqs = [];
  by.forEach((c) => {
    if (hidden(c.client)) { ST.hid++; return; }
    const ev = C.evaluateClient({ cfda: c.cfda ? { received: c.cfda.received, paid: c.cfda.paid, balance: c.cfda.balance == null ? '' : c.cfda.balance } : {}, requests: c.reqs.map((q) => ({ id: q.id, status: q.status, paymentStatus: q.payment_status, amount: q.amount, created: q.created })), refunds: [], reserved: 0, today: t });
    clients.push({ id: c.id, client: c.client || c.id, received: ev.deposits, paid: ev.expenses, current: ev.current, open: ev.openTotal, openCount: ev.openCount, available: ev.available, fund: ev.fundStatus, approval: ev.approvalStatus, risk: ev.riskScore, riskStatus: ev.riskStatus, why: ev.riskFactors.map((f) => '+' + f.pts + ' ' + f.why).join('; '), note: ev.recommendation, nreq: c.reqs.length, last: c.cfda ? c.cfda.last_entry : '', updated: c.cfda ? c.cfda.updated_at : '', noBal: !c.cfda });
    const byId = new Map(ev.requests.map((x) => [x.id, x]));
    for (const q of c.reqs) {
      const x = byId.get(q.id), closed = C.isPaid({ paymentStatus: q.payment_status }) ? 'Paid' : C.isRejected({ status: q.status, paymentStatus: q.payment_status }) ? 'Rejected' : q.status === 'draft' ? 'Draft' : 'Closed';
      const stale = !!(x && c.cfda && c.cfda.updated_at && q.checked_at && c.cfda.updated_at > q.checked_at && q.check_balance != null && Math.abs(q.check_balance - ev.current) > 0.01);
      const dup = x && x.duplicateOf ? c.reqs.find((o) => o.id === x.duplicateOf) : null;
      reqs.push({ id: q.id, name: q.name, cid: c.id, client: c.client, service: q.service, amount: q.amount, created: q.created, approval: q.status === 'pending_approval' ? 'Pending approval' : q.status === 'approved' ? 'Approved' : q.status === 'rejected' ? 'Rejected' : q.status === 'draft' ? 'Draft' : q.status, payment: q.payment_status, open: !!x, state: x ? x.status : closed, held: ev.current, after: x ? x.availableAfter : null, note: x ? x.recommendation : '', dup: dup ? dup.name : '', stale, zoho: q.check_result, zohoBal: q.check_balance, checked: q.checked_at, mode: q.mode, ref: q.ref });
    }
  });
  ST.clients = clients; ST.reqs = reqs;
  const short = reqs.filter((r) => r.open && r.state === 'SHORT').length;
  const cnt = document.getElementById('cntCfi'); if (cnt) { cnt.textContent = short || ''; cnt.classList.toggle('hot', short > 0); }
}
async function refresh(force) {
  const K = core(); if (!K.mcp || ST.busy) return;
  if (!force && ST.at && Date.now() - ST.at < 5 * 60000) return;
  ST.busy = true; ST.err = {}; renderStatus();
  await Promise.all(Object.keys(MODS).map(async (k) => {
    try { const r = await loadMod(k); ST.d[k] = r.rows; ST.more[k] = r.more; }
    catch (e) { ST.err[k] = K.describe ? K.describe(e, ZB) : String((e && e.message) || e); }
  }));
  ST.at = Date.now(); ST.busy = false; compute(); render();
}
/* every statement line of one client: Zoho's text search on the client's name, then matched on the client id */
async function loadLines(c) {
  ST.selBusy = true; ST.selLines = null; renderClient();
  try {
    const out = [];
    for (let pg = 1; pg <= 5; pg++) { const r = await page(MODS.line.api, { page: pg, search_text: c.client }); out.push(...r.recs.map(MAP.line)); if (!r.more) break; }
    if (ST.sel === c.id) ST.selLines = out.filter((l) => l.client_id === c.id);
  } catch (e) { if (ST.sel === c.id) ST.selLines = ST.d.line.filter((l) => l.client_id === c.id); }
  ST.selBusy = false; renderClient();
}

/* ---------- shell ---------- */
root.innerHTML = '<style>' +
  '.fi-status{display:flex;flex-wrap:wrap;gap:4px 16px;padding:0 16px 12px;font-size:12px;color:var(--ink-3)}.fi-status b{color:var(--ink-2);font-weight:600}.fi-status .err{color:var(--crit)}' +
  '.fi-tools{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line-soft)}.fi-tools input[type=search]{flex:1 1 220px;min-width:0}' +
  '.fi-pill{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap;background:var(--surface-2);color:var(--ink-2)}' +
  '.fi-pill.ok{background:var(--ok-bg,var(--surface-2));color:var(--ok,var(--ink))}.fi-pill.warn{background:var(--med-bg);color:var(--med)}.fi-pill.bad{background:var(--crit-bg);color:var(--crit)}' +
  '.fi-empty{padding:26px 16px;color:var(--ink-3);text-align:center;line-height:1.6}' +
  '#cfiRoot th[data-fis]{cursor:pointer}#cfiRoot tr[data-fic]{cursor:pointer}#cfiRoot tr.selrow td{background:var(--active,var(--surface-2))}' +
  '#cfiRoot .seg{flex-wrap:wrap;max-width:100%}#cfiRoot .controls{flex-wrap:wrap;min-width:0;max-width:100%}' +
  '.fi-note{font-size:12px;color:var(--ink-3)}' +
  '</style>' +
  '<div class="card"><header><div><h2>Client fund intelligence</h2><span class="sub">Live from the Zoho Books custom modules · AED</span></div><div class="controls"><button class="btn" type="button" id="fiXls">Export Excel</button><button class="btn primary" type="button" id="fiRefresh">Refresh from Zoho Books</button></div></header>' +
  '<div class="body"><div class="grid kpis" id="fiKpis"></div></div><div class="fi-status" id="fiStatus"></div></div>' +
  '<div class="card" style="margin-top:16px"><header><div><h2>Clients</h2><span class="sub" id="fiCSub"></span></div><div class="controls"><div class="seg" id="fiF" role="group" aria-label="Filter clients"></div></div></header>' +
  '<div class="fi-tools"><input type="search" id="fiQ" placeholder="Search client" autocomplete="off" spellcheck="false" aria-label="Search client"></div>' +
  '<div class="scroll" style="max-height:560px"><table id="fiC"></table></div><div class="note">Available = CFDA balance less open payment requests (submitted or approved, not paid, not rejected). Click a client for its payment requests and CFDA statement lines.</div></div>' +
  '<div class="card" style="margin-top:16px" id="fiSelCard" hidden><header><div><h2 id="fiSelH"></h2><span class="sub" id="fiSelSub"></span></div><button class="btn" type="button" id="fiSelX">Close</button></header><div id="fiSel"></div></div>' +
  '<div class="card" style="margin-top:16px"><header><div><h2>Client Payment Requests</h2><span class="sub" id="fiRSub"></span></div><div class="controls"><div class="seg" id="fiRF" role="group" aria-label="Filter requests"></div></div></header><div class="scroll" style="max-height:560px"><table id="fiR"></table></div></div>' +
  '<div class="card" style="margin-top:16px"><header><div><h2>Latest CFDA Statement Lines</h2><span class="sub" id="fiLSub"></span></div></header><div class="scroll" style="max-height:460px"><table id="fiL"></table></div></div>' +
  '<div class="card" style="margin-top:16px"><header><div><h2>Deal Submissions</h2><span class="sub" id="fiDSub"></span></div></header><div class="scroll" style="max-height:460px"><table id="fiD"></table></div></div>';

/* ---------- render ---------- */
const FUND = { 'Available': 'ok', 'Low balance': 'warn', 'Covered after refund': 'warn', 'Short': 'bad', 'No funds held': '' };
const REQ = { COVERED: ['ok', 'Covered'], 'PENDING REFUND': ['warn', 'Pending refund'], SHORT: ['bad', 'Short'], Paid: ['', 'Paid'], Rejected: ['', 'Rejected'], Draft: ['', 'Draft'], Closed: ['', 'Closed'] };
const pill = (cls, t) => '<span class="fi-pill ' + cls + '">' + esc(t) + '</span>';
const riskCls = (s) => (s === 'Critical' || s === 'High' ? 'bad' : s === 'Medium' ? 'warn' : 'ok');
function kpi(l, v, s, cls) { return '<div class="kpi ' + (cls || '') + '"><span class="l">' + l + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></div>'; }
function renderStatus() {
  const K = core(), b = [], el = $('#fiStatus');
  if (ST.busy) b.push('<span><b>Reading the custom modules from Zoho Books…</b></span>');
  else if (ST.at) b.push('<span>Read from Zoho Books <b>' + esc(when(ST.at)) + '</b></span>');
  else b.push('<span>' + (K.mcp ? 'Not read yet.' : 'Live figures load when this page is opened in claude.ai with the Zoho Books connector.') + '</span>');
  for (const k of Object.keys(MODS)) {
    if (ST.err[k]) b.push('<span class="err">' + esc(MODS[k].label) + ': ' + esc(ST.err[k]) + '</span>');
    else if (ST.at) b.push('<span>' + esc(MODS[k].label) + ' <b>' + ST.d[k].length.toLocaleString('en-US') + (ST.more[k] ? '+' : '') + '</b></span>');
  }
  if (ST.hid) b.push('<span>' + ST.hid + ' clients of other Onelink Group companies hidden</span>');
  el.innerHTML = b.join('');
  const rb = $('#fiRefresh'); rb.disabled = ST.busy; rb.textContent = ST.busy ? 'Reading…' : K.mcp ? 'Refresh from Zoho Books' : 'Connect Zoho & refresh';
}
function renderKpis() {
  const cs = ST.clients, rq = ST.reqs.filter((r) => r.open);
  const held = cs.filter((c) => c.current > 0), owe = cs.filter((c) => c.current < 0), short = rq.filter((r) => r.state === 'SHORT');
  const sum = (a, k) => a.reduce((t, x) => t + x[k], 0);
  $('#fiKpis').innerHTML = kpi('Funds held', fmt0(sum(held, 'current')), held.length + ' clients with a balance', 'ok') +
    kpi('Clients owing', fmt0(-sum(owe, 'current')), owe.length + ' clients below zero', owe.length ? 'bad' : '') +
    kpi('Open requests', fmt0(sum(rq, 'amount')), rq.length + ' not yet paid') +
    kpi('Short requests', String(short.length), short.length ? 'AED ' + fmt0(sum(short, 'amount')) + ' not covered' : 'every open request is covered', short.length ? 'bad' : 'ok') +
    kpi('Available after requests', fmt0(sum(cs.filter((c) => c.available > 0), 'available')), 'across clients with funds') +
    kpi('Deal submissions', String(ST.d.deal.length), ST.d.deal.length ? 'in Zoho Books' : 'none entered yet');
}
const CF = [['all', 'All'], ['funds', 'Holding funds'], ['open', 'Open requests'], ['short', 'Short'], ['owe', 'Owes us'], ['low', 'Low balance']];
const cfTest = { all: () => true, funds: (c) => c.current > 0, open: (c) => c.openCount > 0, short: (c) => c.available < 0 && c.openCount > 0, owe: (c) => c.current < 0, low: (c) => c.fund === 'Low balance' };
const CCOLS = [['client', 'Client', ''], ['received', 'Received', 'n'], ['paid', 'Paid out', 'n'], ['current', 'CFDA balance', 'n'], ['open', 'Open requests', 'n'], ['available', 'Available', 'n'], ['fund', 'Fund status', ''], ['risk', 'Risk', 'n'], ['last', 'Last entry', '']];
function renderClients() {
  $('#fiF').innerHTML = CF.map(([k, t]) => '<button type="button" data-fif="' + k + '" class="' + (ST.f === k ? 'on' : '') + '">' + t + ' <span class="muted">' + ST.clients.filter(cfTest[k]).length + '</span></button>').join('');
  const q = ST.q.trim().toLowerCase();
  let rows = ST.clients.filter(cfTest[ST.f]).filter((c) => !q || c.client.toLowerCase().includes(q));
  const k = ST.sort; rows.sort((a, b) => (typeof a[k] === 'string' ? String(a[k]).localeCompare(String(b[k])) : a[k] - b[k]) * ST.dir || a.client.localeCompare(b.client));
  $('#fiCSub').textContent = rows.length + ' of ' + ST.clients.length + ' clients';
  let h = '<thead><tr>' + CCOLS.map(([id, t, c]) => '<th class="' + c + '" data-fis="' + id + '">' + t + (ST.sort === id ? (ST.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') + '<th>What to do</th></tr></thead><tbody>';
  for (const c of rows.slice(0, ST.shown)) h += '<tr data-fic="' + esc(c.id) + '" class="' + (ST.sel === c.id ? 'selrow' : '') + '"><td class="wrap"><b>' + esc(c.client) + '</b>' + (c.noBal ? ' <span class="fi-note">no CFDA balance row</span>' : '') + '</td><td class="n">' + fmt(c.received) + '</td><td class="n">' + fmt(c.paid) + '</td><td class="n">' + neg(c.current, fmt(c.current)) + '</td><td class="n">' + (c.openCount ? fmt(c.open) + ' <span class="fi-note">· ' + c.openCount + '</span>' : '—') + '</td><td class="n"><b>' + neg(c.available, fmt(c.available)) + '</b></td><td>' + pill(FUND[c.fund] || '', c.fund) + '</td><td class="n" title="' + esc(c.why) + '">' + pill(riskCls(c.riskStatus), c.risk + ' ' + c.riskStatus) + '</td><td>' + esc(dlab(c.last)) + '</td><td class="wrap">' + esc(c.note) + '</td></tr>';
  if (!rows.length) h += '<tr><td class="fi-empty" colspan="10">' + (ST.at ? 'No clients match.' : ST.busy ? 'Reading…' : 'Press Refresh from Zoho Books.') + '</td></tr>';
  else if (rows.length > ST.shown) h += '<tr><td class="fi-empty" colspan="10"><button class="btn" type="button" data-fimore>Show ' + Math.min(100, rows.length - ST.shown) + ' more</button></td></tr>';
  $('#fiC').innerHTML = h + '</tbody>';
}
function reqRow(r, withClient) {
  const s = REQ[r.state] || ['', r.state];
  return '<tr><td>' + esc(dlab(r.created)) + '</td><td class="wrap"><b>' + esc(r.name) + '</b>' + (withClient && r.client && r.client !== r.name ? '<div class="fi-note">' + esc(r.client) + '</div>' : '') + '</td><td>' + esc(r.service) + '</td><td class="n">' + fmt(r.amount) + '</td><td>' + esc(r.approval) + (r.payment ? '<div class="fi-note">' + esc(r.payment) + '</div>' : '') + '</td><td>' + pill(s[0], s[1]) + (r.stale ? ' ' + pill('warn', 'Zoho check out of date') : '') + (r.dup ? ' ' + pill('warn', 'Possible duplicate') : '') + '</td><td class="n">' + (r.open ? neg(r.held, fmt(r.held)) : '') + '</td><td class="n">' + (r.open ? neg(r.after, fmt(r.after)) : '') + '</td><td class="wrap">' + esc(r.open ? r.note : [r.zoho, r.ref ? 'ref ' + r.ref : ''].filter(Boolean).join(' · ')) + (r.dup ? '<div class="fi-note">Same amount as “' + esc(r.dup) + '”</div>' : '') + '</td></tr>';
}
const RHEAD = '<thead><tr><th>Created</th><th>Request</th><th>Service</th><th class="n">Amount</th><th>Approval</th><th>Fund check</th><th class="n">CFDA balance</th><th class="n">Available after</th><th>Recommendation</th></tr></thead>';
const RF = [['open', 'Open'], ['short', 'Short'], ['stale', 'Check out of date'], ['all', 'All']];
const rfTest = { open: (r) => r.open, short: (r) => r.open && r.state === 'SHORT', stale: (r) => r.stale, all: () => true };
function renderReqs() {
  $('#fiRF').innerHTML = RF.map(([k, t]) => '<button type="button" data-firf="' + k + '" class="' + (ST.rf === k ? 'on' : '') + '">' + t + ' <span class="muted">' + ST.reqs.filter(rfTest[k]).length + '</span></button>').join('');
  const rows = ST.reqs.filter(rfTest[ST.rf]).sort((a, b) => (a.open && b.open ? (a.after || 0) - (b.after || 0) : 0) || b.created.localeCompare(a.created));
  $('#fiRSub').textContent = rows.length + ' of ' + ST.reqs.length + (ST.more.req ? '+ (newest ' + ST.d.req.length + ' read)' : '') + ' requests';
  $('#fiR').innerHTML = RHEAD + '<tbody>' + (rows.slice(0, 200).map((r) => reqRow(r, true)).join('') || '<tr><td class="fi-empty" colspan="9">' + (ST.at ? 'No requests here.' : '') + '</td></tr>') + '</tbody>';
}
const LHEAD = (withClient) => '<thead><tr><th>Date</th>' + (withClient ? '<th>Client</th>' : '') + '<th>Type</th><th>Reference</th><th class="n">Received</th><th class="n">Paid out</th><th class="n">Running balance</th></tr></thead>';
const lineRow = (l, withClient) => '<tr><td>' + esc(dlab(l.date)) + '</td>' + (withClient ? '<td class="wrap">' + esc(l.client) + '</td>' : '') + '<td>' + esc(l.type) + '</td><td class="wrap">' + esc(l.ref) + '</td><td class="n">' + (l.received ? fmt(l.received) : '') + '</td><td class="n">' + (l.paid ? fmt(l.paid) : '') + '</td><td class="n">' + (l.running == null ? '' : neg(l.running, fmt(l.running))) + '</td></tr>';
function renderLines() {
  const rows = ST.d.line.filter((l) => !hidden(l.client)).sort((a, b) => b.date.localeCompare(a.date));
  $('#fiLSub').textContent = 'Newest ' + rows.length + (ST.more.line ? ' (older lines open from a client above)' : '');
  $('#fiL').innerHTML = LHEAD(true) + '<tbody>' + (rows.slice(0, 300).map((l) => lineRow(l, true)).join('') || '<tr><td class="fi-empty" colspan="7">' + (ST.at ? 'No statement lines.' : '') + '</td></tr>') + '</tbody>';
}
function renderDeals() {
  const rows = ST.d.deal, keys = [...new Set(rows.flatMap((d) => Object.keys(d.f)))].slice(0, 14);
  $('#fiDSub').textContent = rows.length + ' submissions';
  if (!rows.length) { $('#fiD').innerHTML = '<tbody><tr><td class="fi-empty">' + (ST.err.deal ? '' : ST.at ? 'No deal submissions have been entered in Zoho Books yet. They will show here as soon as the first one is saved.' : '') + '</td></tr></tbody>'; return; }
  $('#fiD').innerHTML = '<thead><tr><th>Created</th><th>Deal</th><th>Status</th>' + keys.map((k) => '<th>' + esc(k.replace(/_/g, ' ')) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((d) => '<tr><td>' + esc(dlab(d.created)) + '</td><td class="wrap"><b>' + esc(d.name) + '</b></td><td>' + esc(d.status.replace(/_/g, ' ')) + '</td>' + keys.map((k) => '<td class="wrap">' + esc(d.f[k] || '') + '</td>').join('') + '</tr>').join('') + '</tbody>';
}
function renderClient() {
  const c = ST.clients.find((x) => x.id === ST.sel), card = $('#fiSelCard');
  card.hidden = !c; if (!c) return;
  $('#fiSelH').textContent = c.client;
  $('#fiSelSub').textContent = 'CFDA balance ' + fmt(c.current) + ' · open requests ' + fmt(c.open) + ' · available ' + fmt(c.available) + (c.updated ? ' · balance updated ' + c.updated : '');
  const rq = ST.reqs.filter((r) => r.cid === c.id).sort((a, b) => b.created.localeCompare(a.created));
  const ln = (ST.selLines || ST.d.line.filter((l) => l.client_id === c.id)).slice().sort((a, b) => b.date.localeCompare(a.date));
  $('#fiSel').innerHTML = '<div class="fi-tools"><span>' + esc(c.note) + '</span></div>' + (c.why ? '<div class="fi-tools fi-note">Risk ' + c.risk + ' (' + esc(c.riskStatus) + '): ' + esc(c.why) + '</div>' : '') +
    '<div class="fi-tools"><b>Payment requests</b><span class="fi-note">' + rq.length + '</span></div><div class="scroll" style="max-height:320px"><table>' + RHEAD + '<tbody>' + (rq.map((r) => reqRow(r, false)).join('') || '<tr><td class="fi-empty" colspan="9">No payment requests.</td></tr>') + '</tbody></table></div>' +
    '<div class="fi-tools"><b>CFDA statement lines</b><span class="fi-note">' + (ST.selBusy ? 'reading from Zoho Books…' : ln.length + ' lines') + '</span></div><div class="scroll" style="max-height:380px"><table>' + LHEAD(false) + '<tbody>' + (ln.map((l) => lineRow(l, false)).join('') || '<tr><td class="fi-empty" colspan="6">' + (ST.selBusy ? 'Reading…' : 'No statement lines.') + '</td></tr>') + '</tbody></table></div>';
}
function render() { renderStatus(); renderKpis(); renderClients(); renderClient(); renderReqs(); renderLines(); renderDeals(); }

async function exportXls() {
  const K = core();
  try {
    if (!window.XLSX) await K.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const X = window.XLSX, wb = X.utils.book_new(), add = (name, aoa) => X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), name);
    add('Clients', [['Client', 'Received', 'Paid out', 'CFDA balance', 'Open requests', 'Open count', 'Available', 'Fund status', 'Approval', 'Risk score', 'Risk', 'Last entry', 'What to do']].concat(ST.clients.map((c) => [c.client, c.received, c.paid, c.current, c.open, c.openCount, c.available, c.fund, c.approval, c.risk, c.riskStatus, c.last, c.note])));
    add('Payment requests', [['Created', 'Request', 'Client', 'Service', 'Amount', 'Approval', 'Payment status', 'Fund check', 'CFDA balance', 'Available after', 'Recommendation', 'Zoho check', 'Zoho check at', 'Check out of date', 'Possible duplicate of', 'Reference']].concat(ST.reqs.map((r) => [r.created, r.name, r.client, r.service, r.amount, r.approval, r.payment, (REQ[r.state] || ['', r.state])[1], r.held, r.after, r.note, r.zoho, r.checked, r.stale ? 'Yes' : '', r.dup, r.ref])));
    add('Statement lines', [['Date', 'Client', 'Type', 'Reference', 'Received', 'Paid out', 'Running balance']].concat(ST.d.line.filter((l) => !hidden(l.client)).map((l) => [l.date, l.client, l.type, l.ref, l.received || '', l.paid || '', l.running])));
    const keys = [...new Set(ST.d.deal.flatMap((d) => Object.keys(d.f)))];
    add('Deal submissions', [['Created', 'Deal', 'Status'].concat(keys)].concat(ST.d.deal.map((d) => [d.created, d.name, d.status].concat(keys.map((k) => d.f[k] || '')))));
    await K.saveFile('Client_fund_intelligence_' + today() + '.xlsx', new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })));
  } catch (e) { ST.err.export = 'Export failed: ' + ((e && e.message) || e); renderStatus(); }
}

/* ---------- events ---------- */
root.addEventListener('click', (ev) => {
  const t = ev.target;
  const f = t.closest('[data-fif]'); if (f) { ST.f = f.dataset.fif; ST.shown = 60; return renderClients(); }
  const rf = t.closest('[data-firf]'); if (rf) { ST.rf = rf.dataset.firf; return renderReqs(); }
  const s = t.closest('[data-fis]'); if (s) { const k = s.dataset.fis; if (ST.sort === k) ST.dir = -ST.dir; else { ST.sort = k; ST.dir = k === 'client' ? 1 : k === 'available' ? 1 : -1; } return renderClients(); }
  if (t.closest('[data-fimore]')) { ST.shown += 100; return renderClients(); }
  const c = t.closest('[data-fic]'); if (c) { ST.sel = c.dataset.fic; renderClients(); const cl = ST.clients.find((x) => x.id === ST.sel); if (cl && core().mcp) loadLines(cl); else renderClient(); const card = $('#fiSelCard'); if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (t.closest('#fiSelX')) { ST.sel = ''; ST.selLines = null; renderClients(); return renderClient(); }
  if (t.closest('#fiXls')) return exportXls();
  if (t.closest('#fiRefresh')) { const K = core(); if (K.mcp) return refresh(true); if (K.connect) return Promise.resolve(K.connect()).then(() => refresh(true)); }
});
root.addEventListener('input', (ev) => { if (ev.target.id === 'fiQ') { ST.q = ev.target.value; ST.shown = 60; renderClients(); } });
const panel = document.getElementById('p-cfi');
const visible = () => !!panel && panel.classList.contains('on');
if (panel) new MutationObserver(() => { if (visible()) { render(); refresh(false); } }).observe(panel, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('cfd-core', () => { renderStatus(); if (visible() && !ST.busy) refresh(false); });
setInterval(() => { if (visible() && !document.hidden) refresh(false); }, 60000);
render();
if (visible()) refresh(false);
})();
