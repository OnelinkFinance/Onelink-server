/* Fund requests tab of the Customers Fund Ledger page.
   Shows every Client Payment Request from Zoho Books (custom module cm_client_payment_request) with an analysis of
   each one: whether the client's CFDA funds cover it, what else is committed, whether Zoho's own check is still
   current, duplicates, waiting time and the client's history. The client's CFDA balance is read from
   cm_client_cfda_balance only as an input to that analysis. Rules: cfi-engine.js. Nothing is written to Zoho. */
(function () {
'use strict';
const C = window.CFI, root = document.getElementById('cfiRoot');
if (!C || !root) return;
const $ = (s, r) => (r || root).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || n === '' || isNaN(n) ? '—' : (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt0 = (n) => (n == null || isNaN(n) ? '—' : (n < 0 ? '−' : '') + Math.round(Math.abs(n)).toLocaleString('en-US'));
const aed = (n) => 'AED ' + fmt(n);
const num = (v) => { const x = Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')); return v === '' || v == null || !isFinite(x) ? 0 : x; };
const str = (v) => String(v == null ? '' : v).trim();
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dlab = (d) => (d && d.length >= 10 ? +d.slice(8, 10) + ' ' + MN[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : d || '');
const today = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const when = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ORG = '898300452', ZB = 'Zoho Books', REQ_API = 'cm_client_payment_request', BAL_API = 'cm_client_cfda_balance', LINE_API = 'cm_cfda_statement_line';
const core = () => window.CFD_CORE || {};
const MAP = {
  bal: (r) => ({ client_id: str(r.cf_client), client: str(r.cf_client_formatted || r.record_name), received: num(r.cf_received_into_cfda), paid: num(r.cf_paid_out_of_cfda), balance: r.cf_cfda_balance === '' || r.cf_cfda_balance == null ? null : num(r.cf_cfda_balance), last_entry: str(r.cf_last_cfda_entry_date), updated_at: str(r.cf_updated_at) }),
  req: (r) => ({ id: str(r.module_record_id), by: str(r.created_by_id || r.record_created_by), name: str(r.record_name) || '(no company name)', client_id: str(r.cf_client), client: str(r.cf_client_formatted), service: str(r.cf_service), amount: num(r.cf_amount_aed), status: str(r.status), payment_status: str(r.cf_status), paid_date: str(r.cf_paid_date), created: str(r.created_time).slice(0, 10), mode: str(r.cf_fund_transfer_type), ref: str(r.cf_authority_invoice_or_ref_no) === '0' ? '' : str(r.cf_authority_invoice_or_ref_no), check_balance: r.cf_cfda_balance === '' || r.cf_cfda_balance == null ? null : num(r.cf_cfda_balance), check_result: str(r.cf_covered_or_short), checked_at: str(r.cf_balance_checked_at) }),
  line: (r) => ({ client_id: str(r.cf_client), date: str(r.cf_transaction_date), type: str(r.cf_entity_type), ref: str(r.cf_reference_no || r.record_name), paid: num(r.cf_paid_aed), received: num(r.cf_received_aed), running: r.cf_running_balance_aed === '' || r.cf_running_balance_aed == null ? null : num(r.cf_running_balance_aed) }),
};
/* Zoho Books users (id → name) as of 20 Nov 2026; refreshed live from list_users when the page may call it */
const USERS = new Map(Object.entries({"7050654000005348001": "Adnan Yousaf", "7050654000000211051": "Ahsan Azeem", "7050654000008418023": "Alex Sladzevskis", "7050654000000495041": "Alin", "7050654000002796027": "Alona Zeleniuk", "7050654000000540035": "Amina Plieva", "7050654000004031001": "Anas", "7050654000005604001": "Anastasiya Kaptur", "7050654000000495061": "Andrei", "7050654000008391084": "Aulia Hafidar Salmaa Rubiarto", "7050654000000495051": "Carmen", "7050654000001372001": "Celina Bouchebbah", "7050654000005554129": "Client Accounting", "7050654000000495071": "David", "7050654000007347010": "Edmore Tatenda Chitambo", "7050654000000211106": "Eduard Nedelcu", "7050654000006398025": "Hanan Mahmoud", "7050654000000211084": "Harry Jack Crusher", "7050654000000188001": "IT Team", "7050654000004878021": "Joud", "7050654000000211073": "Kinaz Al Ahmadieh", "7050654000000674002": "Madina", "7050654000000211062": "Maram Fiddah", "7050654000001805016": "Melannie", "7050654000009444031": "Naushad Aboobakkar", "7050654000007553514": "Nicholas Stephen Van Niekerk", "7050654000000495011": "Nick", "7050654000008870008": "Nisa Aytek", "7050654000004031039": "Omar", "7050654000004650001": "Sinan", "7050654000000495031": "Sophia", "7050654000000167001": "Stefan Stefan", "7050654000009406034": "Sven Joe - Finance", "7050654000004878063": "Sven Joe Salas", "7050654000001667001": "Valeriia", "7050654000004878042": "Wafaa", "7050654000009123020": "Wafaa Al Bacha", "7050654000000104001": "Waqas Akram", "7050654000005554189": "Yelaman Shulembay", "7050654000000093001": "Zoho Admin"}));
const who = (id) => (id ? USERS.get(id) || 'User …' + id.slice(-5) : 'Unknown');
const BGS = [['aurora', 'Aurora'], ['emerald', 'Emerald'], ['dusk', 'Dusk'], ['ocean', 'Ocean'], ['sand', 'Sand'], ['mist', 'Mist']];
const ST = { req: [], bal: [], more: false, err: '', balErr: '', at: 0, busy: false, rows: [], hid: 0, q: '', f: 'open', sort: 'risk', open: '', lines: {}, linesBusy: '', shown: 30, bg: 'aurora', by: '' };
try { const b = localStorage.getItem('cfi.bg'); if (BGS.some((x) => x[0] === b)) ST.bg = b; } catch (e) {}
const pageBg = () => { const g = window.OLTheme && window.OLTheme.get(); return g && BGS.some((x) => x[0] === g) ? g : ''; };
if (pageBg()) ST.bg = pageBg();

/* ---------- data ---------- */
const payloadOf = (res) => { let p = res && (res.payload !== undefined ? res.payload : res); if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) {} } return p; };
async function page(api, params) {
  const p = payloadOf(await core().mcp.callTool(ZB, 'list_custom_module_records', { path_variables: { module_name: api }, query_params: Object.assign({ organization_id: ORG, per_page: 200, sort_column: 'created_time', sort_order: 'D' }, params) }, { cache: false }));
  let d = (p && (p.data || p)) || {}; if (d.data && !d.module_records) d = d.data;
  if (!Array.isArray(d.module_records)) throw new Error(d.message || 'Zoho Books did not answer.');
  return { recs: d.module_records, more: !!(d.page_context && d.page_context.has_more_page) };
}
async function all(api, map, max) { const out = []; let more = false; for (let pg = 1; pg <= max; pg++) { const r = await page(api, { page: pg }); out.push(...r.recs.map(map)); more = r.more; if (!more) break; } return { rows: out, more }; }
const hidden = (name) => { const S = window.OLScope; return !!(S && S.hidden && S.hidden({ cname: name, ref: '' })); };

/* one analysis per request */
function compute() {
  const t = today(), bal = new Map(ST.bal.map((b) => [b.client_id, b])), by = new Map(); ST.hid = 0;
  for (const q of ST.req) { const k = q.client_id || 'none|' + q.id; if (!by.has(k)) by.set(k, []); by.get(k).push(q); }
  const rows = [];
  by.forEach((reqs, cid) => {
    const linked = !cid.startsWith('none|'), b = linked ? bal.get(cid) : null, cname = reqs[0].client || (b && b.client) || '';
    if (hidden(cname) || hidden(reqs[0].name)) { ST.hid += reqs.length; return; }
    const ev = C.evaluateClient({ cfda: b ? { received: b.received, paid: b.paid, balance: b.balance == null ? '' : b.balance } : {}, requests: reqs.map((q) => ({ id: q.id, status: q.status, paymentStatus: q.payment_status, amount: q.amount, created: q.created })), refunds: [], reserved: 0, today: t });
    const byId = new Map(ev.requests.map((x) => [x.id, x]));
    const paidReqs = reqs.filter((q) => C.isPaid({ paymentStatus: q.payment_status })), paidTotal = paidReqs.reduce((s, q) => s + q.amount, 0);
    for (const q of reqs) {
      const x = byId.get(q.id), paid = C.isPaid({ paymentStatus: q.payment_status }), rejected = C.isRejected({ status: q.status, paymentStatus: q.payment_status });
      const age = q.created ? Math.max(0, days(q.created, t)) : 0;
      const stale = !!(x && b && b.updated_at && q.checked_at && b.updated_at > q.checked_at && q.check_balance != null && Math.abs(q.check_balance - ev.current) > 0.01);
      const dup = x && x.duplicateOf ? reqs.find((o) => o.id === x.duplicateOf) : null;
      const forThis = x ? ev.current - x.otherOpen : null;
      let v;
      if (paid) v = 'paid'; else if (rejected) v = 'rejected'; else if (!x) v = q.status === 'draft' ? 'draft' : 'closed';
      else if (!linked) v = 'unlinked'; else if (x.availableAfter < 0) v = 'short'; else if (x.availableAfter < C.LOW_BALANCE) v = 'low'; else v = 'covered';
      /* the checks behind the verdict: [level, text] */
      const ck = [];
      if (x) {
        if (!linked) ck.push(['bad', 'No client is selected on the request, so its funds cannot be checked. Choose the client in Zoho Books.']);
        else if (!b) ck.push(['bad', 'This client has no CFDA balance record, so the balance is taken as zero.']);
        if (linked) {
          if (ev.current < 0) ck.push(['bad', 'The client already owes Elite Onelink ' + aed(-ev.current) + '.']);
          if (x.availableAfter >= 0) ck.push(['ok', 'Funds cover it: the client holds ' + aed(ev.current) + (x.otherOpen ? ', ' + aed(x.otherOpen) + ' is committed to other open requests,' : '') + ' leaving ' + aed(x.availableAfter) + ' after this request.']);
          else ck.push(['bad', 'Short by ' + aed(-x.availableAfter) + ': the client holds ' + aed(ev.current) + (x.otherOpen ? ' with ' + aed(x.otherOpen) + ' committed to other open requests' : '') + ', against this request of ' + aed(x.amount) + '.']);
          if (x.availableAfter >= 0 && x.availableAfter < C.LOW_BALANCE) ck.push(['warn', 'Paying it leaves less than ' + aed(C.LOW_BALANCE) + ' on the client’s account.']);
        }
        if (q.status === 'approved' && x.availableAfter < 0) ck.push(['bad', 'Already approved although the funds do not cover it.']);
        if (stale) ck.push(['warn', 'Zoho Books checked this on ' + q.checked_at + ' with a balance of ' + aed(q.check_balance) + '; the balance is now ' + aed(ev.current) + '. Re-save the request to refresh its check.']);
        else if (!q.check_result) ck.push(['warn', 'Zoho Books has not run its own balance check on this request.']);
        else if (/short/i.test(q.check_result) !== (x.availableAfter < 0)) ck.push(['warn', 'Zoho Books’ own check says “' + q.check_result + '”, which differs from the figures now.']);
        else ck.push(['ok', 'Zoho Books’ own check agrees (' + q.check_result + (q.checked_at ? ', ' + q.checked_at : '') + ').']);
        if (dup) ck.push(['warn', 'Possible duplicate of “' + dup.name + '” (' + aed(dup.amount) + ', ' + dlab(dup.created) + ').']);
        if (age > 7) ck.push(['warn', 'Waiting ' + age + ' days since it was raised.']);
        else ck.push(['ok', age ? 'Raised ' + age + ' day' + (age > 1 ? 's' : '') + ' ago.' : 'Raised today.']);
        if (!q.ref) ck.push(['warn', 'No authority invoice or reference number entered.']);
        if (!q.amount) ck.push(['bad', 'No amount entered.']);
      } else if (paid) {
        ck.push(['ok', 'Paid' + (q.paid_date ? ' on ' + dlab(q.paid_date) : '') + (q.mode ? ' by ' + q.mode.toLowerCase() : '') + '.']);
        if (/short/i.test(q.check_result)) ck.push(['warn', 'It was marked paid although Zoho Books’ check said “' + q.check_result + '”' + (q.check_balance != null ? ' (balance ' + aed(q.check_balance) + ')' : '') + '.']);
        if (!q.ref) ck.push(['warn', 'No authority invoice or reference number entered.']);
        if (linked && ev.current < 0) ck.push(['warn', 'The client now owes Elite Onelink ' + aed(-ev.current) + '.']);
      } else if (rejected) ck.push(['info', 'Rejected; it does not hold any of the client’s funds.']);
      else ck.push(['info', q.status === 'draft' ? 'Still a draft; it is not counted against the client’s funds until it is submitted.' : 'Closed.']);
      if (linked) ck.push(['info', 'Client history: ' + reqs.length + ' request' + (reqs.length > 1 ? 's' : '') + ' in total, ' + paidReqs.length + ' paid (' + aed(paidTotal) + ')' + (ev.openCount ? ', ' + ev.openCount + ' open (' + aed(ev.openTotal) + ')' : '') + '.']);
      const bad = ck.filter((c) => c[0] === 'bad').length, warn = ck.filter((c) => c[0] === 'warn').length;
      rows.push({ id: q.id, by: q.by, name: q.name, cid: linked ? cid : '', client: cname, service: q.service, amount: q.amount, created: q.created, age, paid_date: q.paid_date, mode: q.mode, ref: q.ref,
        approval: q.status === 'pending_approval' ? 'Pending approval' : q.status === 'approved' ? 'Approved' : q.status === 'rejected' ? 'Rejected' : q.status === 'draft' ? 'Draft' : q.status,
        payment: q.payment_status, open: !!x, v, held: linked ? ev.current : null, other: x ? x.otherOpen : null, forThis, after: x ? x.availableAfter : null,
        cover: x && x.amount > 0 ? Math.max(0, Math.min(1, (forThis || 0) / x.amount)) : null, note: x ? x.recommendation : '', ck, bad, warn, stale, dup: !!dup,
        score: (x ? 1000 : 0) + bad * 100 + warn * 10 + (x && x.availableAfter < 0 ? Math.min(99, -x.availableAfter / 1000) : 0), zoho: q.check_result, checked: q.checked_at, last: b ? b.last_entry : '' });
    }
  });
  ST.rows = rows;
  const short = rows.filter((r) => r.v === 'short').length;
  const cnt = document.getElementById('cntCfi'); if (cnt) { cnt.textContent = short || ''; cnt.classList.toggle('hot', short > 0); }
}
async function refresh(force) {
  const K = core(); if (!K.mcp || ST.busy) return;
  if (!force && ST.at && Date.now() - ST.at < 5 * 60000) return;
  ST.busy = true; ST.err = ''; ST.balErr = ''; renderStatus();
  const say = (e) => (K.describe ? K.describe(e, ZB) : String((e && e.message) || e));
  await Promise.all([
    all(REQ_API, MAP.req, 5).then((r) => { ST.req = r.rows; ST.more = r.more; }, (e) => { ST.err = say(e); }),
    core().mcp.callTool(ZB, 'list_users', { query_params: { organization_id: ORG, per_page: 200, filter_by: 'Status.All' } }, { cache: true }).then((res) => { const p = payloadOf(res), d = (p && (p.data || p)) || {}; for (const u of d.users || []) if (u.user_id && u.name) USERS.set(String(u.user_id), u.name); }, () => {}),
    all(BAL_API, MAP.bal, 10).then((r) => { ST.bal = r.rows.filter((b) => b.client_id); }, (e) => { ST.balErr = say(e); }),
  ]);
  ST.at = Date.now(); ST.busy = false; ST.lines = {}; compute(); render();
}
/* the client's latest CFDA entries, shown inside a request's analysis */
async function loadLines(r) {
  if (!r.cid || ST.lines[r.cid] || !core().mcp) return;
  ST.linesBusy = r.cid; renderList();
  try { const out = []; for (let pg = 1; pg <= 3; pg++) { const p = await page(LINE_API, { page: pg, search_text: r.client }); out.push(...p.recs.map(MAP.line)); if (!p.more) break; } ST.lines[r.cid] = out.filter((l) => l.client_id === r.cid).sort((a, b) => b.date.localeCompare(a.date)); }
  catch (e) { ST.lines[r.cid] = []; }
  ST.linesBusy = ''; renderList();
}

/* ---------- shell ---------- */
root.innerHTML = '<style>' +
  '.fx{--fx-ink:#f4f7f6;--fx-ink2:rgba(244,247,246,.74);--fx-ink3:rgba(244,247,246,.52);--fx-glass:rgba(255,255,255,.09);--fx-glass2:rgba(255,255,255,.14);--fx-line:rgba(255,255,255,.2);--fx-shadow:0 10px 40px rgba(0,0,0,.28);--fx-ok:#6ee7a8;--fx-warn:#fcd34d;--fx-bad:#ff9a9a;--fx-info:#a5c8ff;--fx-track:rgba(255,255,255,.16);' +
  'position:relative;border-radius:22px;padding:22px;color:var(--fx-ink);overflow:hidden;isolation:isolate;transition:background .5s ease;font-family:var(--sans)}' +
  '.fx[data-bg=aurora]{background:radial-gradient(900px 500px at 8% -10%,#1fb89a 0,transparent 60%),radial-gradient(800px 520px at 100% 0,#6d5dfc 0,transparent 58%),radial-gradient(700px 600px at 50% 120%,#0ea5e9 0,transparent 60%),#0a1a24}' +
  '.fx[data-bg=emerald]{background:radial-gradient(900px 520px at 0 0,#2f8f6b 0,transparent 60%),radial-gradient(800px 600px at 100% 100%,#b08d3c 0,transparent 55%),#0f2a20}' +
  '.fx[data-bg=dusk]{background:radial-gradient(900px 520px at 0 0,#f97362 0,transparent 58%),radial-gradient(900px 600px at 100% 20%,#8b5cf6 0,transparent 58%),radial-gradient(700px 500px at 40% 120%,#f59e0b 0,transparent 60%),#1d1230}' +
  '.fx[data-bg=ocean]{background:radial-gradient(900px 520px at 100% 0,#22d3ee 0,transparent 58%),radial-gradient(900px 600px at 0 100%,#2563eb 0,transparent 60%),#061a33}' +
  '.fx[data-bg=sand],.fx[data-bg=mist]{--fx-ink:#1c2622;--fx-ink2:rgba(28,38,34,.76);--fx-ink3:rgba(28,38,34,.56);--fx-glass:rgba(255,255,255,.5);--fx-glass2:rgba(255,255,255,.72);--fx-line:rgba(255,255,255,.85);--fx-shadow:0 10px 36px rgba(60,50,30,.14);--fx-ok:#0f7a48;--fx-warn:#9a6200;--fx-bad:#b42318;--fx-info:#1d4ed8;--fx-track:rgba(28,38,34,.12)}' +
  '.fx[data-bg=sand]{background:radial-gradient(800px 500px at 0 0,#f6c98a 0,transparent 60%),radial-gradient(800px 560px at 100% 10%,#f2a7a0 0,transparent 58%),radial-gradient(700px 500px at 50% 120%,#bfe3c8 0,transparent 60%),#f5efe4}' +
  '.fx[data-bg=mist]{background:radial-gradient(800px 500px at 0 0,#b9d9ff 0,transparent 60%),radial-gradient(800px 560px at 100% 0,#d6c8ff 0,transparent 58%),radial-gradient(700px 500px at 50% 120%,#bdeee0 0,transparent 60%),#eef3f8}' +
  '.fx-g{background:var(--fx-glass);border:1px solid var(--fx-line);border-radius:18px;-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);box-shadow:var(--fx-shadow),inset 0 1px 0 rgba(255,255,255,.22)}' +
  '.fx-top{display:flex;flex-wrap:wrap;gap:14px 20px;align-items:flex-end;justify-content:space-between;margin-bottom:18px}' +
  '.fx-top h2{font:600 26px/1.15 var(--serif,var(--sans));margin:0;color:var(--fx-ink);letter-spacing:-.01em}.fx-top p{margin:4px 0 0;color:var(--fx-ink2);font-size:13px}' +
  '.fx-acts{display:flex;flex-wrap:wrap;gap:10px;align-items:center}' +
  '.fx-sw{display:flex;gap:6px;padding:6px 8px;border-radius:999px;align-items:center}.fx-sw span{font-size:11.5px;color:var(--fx-ink2);margin:0 4px 0 2px}' +
  '.fx-sw button{width:22px;height:22px;border-radius:50%;border:2px solid transparent;padding:0;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,.18)}.fx-sw button[aria-pressed=true]{border-color:var(--fx-ink);transform:scale(1.12)}' +
  '.fx-sw [data-fxbg=aurora]{background:linear-gradient(135deg,#1fb89a,#6d5dfc)}.fx-sw [data-fxbg=emerald]{background:linear-gradient(135deg,#2f8f6b,#b08d3c)}.fx-sw [data-fxbg=dusk]{background:linear-gradient(135deg,#f97362,#8b5cf6)}.fx-sw [data-fxbg=ocean]{background:linear-gradient(135deg,#22d3ee,#2563eb)}.fx-sw [data-fxbg=sand]{background:linear-gradient(135deg,#f6c98a,#f2a7a0)}.fx-sw [data-fxbg=mist]{background:linear-gradient(135deg,#b9d9ff,#d6c8ff)}' +
  '.fx-btn{font:600 13px var(--sans);color:var(--fx-ink);background:var(--fx-glass2);border:1px solid var(--fx-line);border-radius:999px;padding:8px 16px;cursor:pointer;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}.fx-btn:hover{filter:brightness(1.12)}.fx-btn:disabled{opacity:.6;cursor:default}' +
  '.fx-btn.pri{background:var(--fx-ink);color:#10201b;border-color:transparent}.fx[data-bg=sand] .fx-btn.pri,.fx[data-bg=mist] .fx-btn.pri{color:#fff}' +
  '.fx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}' +
  '.fx-k{padding:14px 16px;text-align:left;font:inherit;color:inherit;cursor:pointer}.fx-k:hover{background:var(--fx-glass2)}.fx-k[aria-pressed=true]{background:var(--fx-glass2);box-shadow:var(--fx-shadow),inset 0 0 0 1.5px var(--fx-ink)}' +
  '.fx-k .l{display:block;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--fx-ink2)}.fx-k .v{display:block;font:600 26px/1.2 var(--mono);margin:4px 0 2px}.fx-k .s{display:block;font-size:12px;color:var(--fx-ink2)}' +
  '.fx-k.bad .v{color:var(--fx-bad)}.fx-k.ok .v{color:var(--fx-ok)}.fx-k.warn .v{color:var(--fx-warn)}' +
  '.fx-status{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--fx-ink2);margin:0 4px 14px}.fx-status b{color:var(--fx-ink);font-weight:600}.fx-status .err{color:var(--fx-bad);font-weight:600}' +
  '.fx-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 12px;margin-bottom:14px}' +
  '.fx-bar input,.fx-bar select{font:14px var(--sans);color:var(--fx-ink);background:var(--fx-glass);border:1px solid var(--fx-line);border-radius:999px;padding:8px 14px;min-width:0}.fx-bar input{flex:1 1 220px}.fx-bar input::placeholder{color:var(--fx-ink3)}.fx-bar select option{color:#1c2622}' +
  '.fx-chips{display:flex;flex-wrap:wrap;gap:6px}.fx-chip{font:600 12.5px var(--sans);color:var(--fx-ink2);background:transparent;border:1px solid var(--fx-line);border-radius:999px;padding:6px 12px;cursor:pointer}.fx-chip b{font-weight:600;opacity:.7;margin-left:4px}.fx-chip[aria-pressed=true]{background:var(--fx-ink);color:#10201b;border-color:transparent}.fx[data-bg=sand] .fx-chip[aria-pressed=true],.fx[data-bg=mist] .fx-chip[aria-pressed=true]{color:#fff}' +
  '.fx-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;align-items:start}@media (max-width:420px){.fx-list{grid-template-columns:minmax(0,1fr)}.fx{padding:14px;border-radius:16px}}' +
  '.fx-card{padding:16px 16px 14px;cursor:pointer;transition:transform .15s ease,background .2s ease;min-width:0}.fx-card:hover{transform:translateY(-2px);background:var(--fx-glass2)}.fx-card.open{grid-column:1/-1;cursor:default;transform:none;background:var(--fx-glass2)}' +
  '.fx-h{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}.fx-h h3{font:600 16px/1.3 var(--sans);margin:0;color:var(--fx-ink);overflow-wrap:anywhere}.fx-h small{display:block;color:var(--fx-ink2);font-size:12.5px;margin-top:2px;overflow-wrap:anywhere}' +
  '.fx-pill{display:inline-flex;align-items:center;gap:6px;font:600 11.5px var(--sans);padding:4px 10px;border-radius:999px;white-space:nowrap;background:var(--fx-glass2);border:1px solid var(--fx-line);color:var(--fx-ink)}.fx-pill i{width:7px;height:7px;border-radius:50%;background:currentColor}' +
  '.fx-pill.ok{color:var(--fx-ok)}.fx-pill.warn{color:var(--fx-warn)}.fx-pill.bad{color:var(--fx-bad)}.fx-pill.info{color:var(--fx-ink2)}' +
  '.fx-amt{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:12px 0 8px}.fx-amt b{font:600 24px var(--mono);color:var(--fx-ink)}.fx-amt span{font-size:12.5px;color:var(--fx-ink2);text-align:right}' +
  '.fx-by{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--fx-ink2);margin:-2px 0 10px}.fx-by b{color:var(--fx-ink);font-weight:600}.fx-by i{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:600 11px var(--sans);font-style:normal;background:var(--fx-glass2);border:1px solid var(--fx-line);color:var(--fx-ink)}' +
  '.fx-meter{height:8px;border-radius:999px;background:var(--fx-track);overflow:hidden}.fx-meter i{display:block;height:100%;border-radius:999px;background:var(--fx-ok)}.fx-meter.warn i{background:var(--fx-warn)}.fx-meter.bad i{background:var(--fx-bad)}' +
  '.fx-sub{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;font-size:12.5px;color:var(--fx-ink2);margin-top:8px}.fx-sub b{color:var(--fx-ink);font-weight:600}' +
  '.fx-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.fx-tag{font-size:11.5px;padding:2px 9px;border-radius:999px;border:1px solid var(--fx-line);color:var(--fx-ink2)}.fx-tag.warn{color:var(--fx-warn)}.fx-tag.bad{color:var(--fx-bad)}' +
  '.fx-an{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:18px;margin-top:16px;padding-top:16px;border-top:1px solid var(--fx-line)}@media (max-width:900px){.fx-an{grid-template-columns:minmax(0,1fr)}}' +
  '.fx-an h4{font:600 12px var(--sans);letter-spacing:.07em;text-transform:uppercase;color:var(--fx-ink2);margin:0 0 8px}' +
  '.fx-verdict{font-size:14.5px;line-height:1.5;color:var(--fx-ink);margin:0 0 14px}' +
  '.fx-cks{list-style:none;margin:0 0 6px;padding:0}.fx-cks li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;padding:7px 0;font-size:13.5px;line-height:1.45;color:var(--fx-ink);border-bottom:1px solid var(--fx-track)}.fx-cks li:last-child{border-bottom:0}' +
  '.fx-cks .d{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font:700 11px var(--sans);margin-top:1px;color:#10201b}.fx-cks .ok .d{background:var(--fx-ok)}.fx-cks .warn .d{background:var(--fx-warn)}.fx-cks .bad .d{background:var(--fx-bad)}.fx-cks .info .d{background:var(--fx-track);color:var(--fx-ink)}.fx[data-bg=sand] .fx-cks .d,.fx[data-bg=mist] .fx-cks .d{color:#fff}.fx[data-bg=sand] .fx-cks .info .d,.fx[data-bg=mist] .fx-cks .info .d{color:var(--fx-ink)}' +
  '.fx-math{width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:14px}.fx-math td{padding:6px 0;border-bottom:1px solid var(--fx-track);color:var(--fx-ink2)}.fx-math td:last-child{text-align:right;font-family:var(--mono);color:var(--fx-ink)}.fx-math tr,.fx-math td,.fx-lines tr,.fx-lines td{background:transparent!important}.fx-math tr.tot td{border-bottom:0;font-weight:700;color:var(--fx-ink);padding-top:9px}.fx-math .neg{color:var(--fx-bad)}' +
  '.fx-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px 14px;margin:0 0 14px}.fx-facts div{min-width:0}.fx-facts dt{font-size:11.5px;color:var(--fx-ink3)}.fx-facts dd{margin:1px 0 0;font-size:13.5px;color:var(--fx-ink);overflow-wrap:anywhere}' +
  '.fx-lines{width:100%;border-collapse:collapse;font-size:12.5px}.fx-lines td{padding:5px 6px 5px 0;border-bottom:1px solid var(--fx-track);color:var(--fx-ink2);vertical-align:top}.fx-lines td.n{text-align:right;font-family:var(--mono);color:var(--fx-ink);white-space:nowrap}.fx-lines td.r{overflow-wrap:anywhere}' +
  '.fx-empty{padding:34px 16px;text-align:center;color:var(--fx-ink2);line-height:1.6;grid-column:1/-1}.fx-more{grid-column:1/-1;text-align:center}.fx-x{float:right}' +
  '@media (prefers-reduced-motion:reduce){.fx,.fx-card{transition:none}}' +
  '</style>' +
  '<div class="fx" id="fx" data-bg="' + ST.bg + '"><div class="fx-top"><div><h2>Client fund requests</h2><p>Every payment request in Zoho Books, checked against the client’s funds in the Customers Fund Disbursement Account.</p></div>' +
  '<div class="fx-acts"><div class="fx-sw fx-g" role="group" aria-label="Background"><span>Background</span>' + BGS.map(([k, t]) => '<button type="button" data-fxbg="' + k + '" title="' + t + '" aria-label="' + t + ' background" aria-pressed="' + (ST.bg === k) + '"></button>').join('') + '</div>' +
  '<button class="fx-btn" type="button" id="fxXls">Export Excel</button><button class="fx-btn pri" type="button" id="fxRefresh">Refresh</button></div></div>' +
  '<div class="fx-kpis" id="fxKpis"></div><div class="fx-status" id="fxStatus"></div>' +
  '<div class="fx-bar fx-g"><input type="search" id="fxQ" placeholder="Search company, client, creator, service or reference" autocomplete="off" spellcheck="false" aria-label="Search requests"><div class="fx-chips" id="fxF" role="group" aria-label="Filter requests"></div>' +
  '<select id="fxBy" aria-label="Created by"></select><select id="fxSort" aria-label="Sort"><option value="risk">Needs attention first</option><option value="new">Newest first</option><option value="old">Oldest first</option><option value="amt">Largest first</option><option value="client">By client</option></select></div>' +
  '<div class="fx-list" id="fxList"></div></div>';

/* ---------- render ---------- */
const V = { covered: ['ok', 'Covered'], low: ['warn', 'Covered · low balance'], short: ['bad', 'Short'], unlinked: ['bad', 'No client linked'], paid: ['info', 'Paid'], rejected: ['info', 'Rejected'], draft: ['info', 'Draft'], closed: ['info', 'Closed'] };
const F = [['open', 'Open', (r) => r.open], ['short', 'Short', (r) => r.v === 'short' || r.v === 'unlinked'], ['covered', 'Covered', (r) => r.v === 'covered' || r.v === 'low'], ['pending', 'Pending approval', (r) => r.open && r.approval === 'Pending approval'], ['approved', 'Approved, unpaid', (r) => r.open && r.approval === 'Approved'], ['flag', 'With warnings', (r) => r.open && (r.bad || r.warn)], ['paid', 'Paid', (r) => r.v === 'paid'], ['rejected', 'Rejected', (r) => r.v === 'rejected'], ['all', 'All', () => true]];
const ftest = (k) => (F.find((f) => f[0] === k) || F[0])[2];
function renderStatus() {
  const K = core(), b = [];
  if (ST.busy) b.push('<span><b>Reading payment requests from Zoho Books…</b></span>');
  else if (ST.at) b.push('<span>Read from Zoho Books <b>' + esc(when(ST.at)) + '</b> · ' + ST.rows.length + (ST.more ? '+' : '') + ' requests' + (ST.more ? ' (the newest ' + ST.req.length + ')' : '') + '</span>');
  else b.push('<span>' + (K.mcp ? 'Not read yet.' : 'Live requests load when this page is opened in claude.ai with the Zoho Books connector.') + '</span>');
  if (ST.hid) b.push('<span>' + ST.hid + ' requests of other Onelink Group companies hidden</span>');
  if (ST.err) b.push('<span class="err">Payment requests: ' + esc(ST.err) + '</span>');
  if (ST.balErr) b.push('<span class="err">Client balances could not be read, so cover is not checked: ' + esc(ST.balErr) + '</span>');
  $('#fxStatus').innerHTML = b.join('');
  const rb = $('#fxRefresh'); rb.disabled = ST.busy; rb.textContent = ST.busy ? 'Reading…' : K.mcp ? 'Refresh' : 'Connect Zoho & refresh';
}
const scoped = () => (ST.by ? ST.rows.filter((r) => r.by === ST.by) : ST.rows);
function renderBy() {
  const n = new Map(); for (const r of ST.rows) n.set(r.by, (n.get(r.by) || 0) + 1);
  if (ST.by && !n.has(ST.by)) ST.by = '';
  $('#fxBy').innerHTML = '<option value="">Created by: everyone (' + ST.rows.length + ')</option>' + [...n].sort((a, b) => who(a[0]).localeCompare(who(b[0]))).map(([id, c]) => '<option value="' + esc(id) + '"' + (id === ST.by ? ' selected' : '') + '>' + esc(who(id)) + ' (' + c + ')</option>').join('');
}
function renderKpis() {
  const R = scoped(), open = R.filter((r) => r.open), sum = (a) => a.reduce((t, r) => t + r.amount, 0);
  const short = open.filter(ftest('short')), cov = open.filter(ftest('covered')), pend = open.filter(ftest('pending')), flag = open.filter(ftest('flag'));
  const mo = today().slice(0, 7), paid = R.filter((r) => r.v === 'paid' && (r.paid_date || '').slice(0, 7) === mo);
  const k = (f, l, v, s, cls) => '<button type="button" class="fx-k fx-g ' + (cls || '') + '" data-fxf="' + f + '" aria-pressed="' + (ST.f === f) + '"><span class="l">' + l + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></button>';
  $('#fxKpis').innerHTML = k('open', 'Open requests', open.length, 'AED ' + fmt0(sum(open)) + ' to pay') +
    k('covered', 'Covered', cov.length, 'AED ' + fmt0(sum(cov)) + ' safe to pay', 'ok') +
    k('short', 'Short', short.length, short.length ? 'AED ' + fmt0(short.reduce((t, r) => t + Math.max(0, -(r.after || 0)), 0)) + ' missing' : 'nothing is short', short.length ? 'bad' : 'ok') +
    k('pending', 'Pending approval', pend.length, 'AED ' + fmt0(sum(pend))) +
    k('flag', 'With warnings', flag.length, 'open requests to look at', flag.length ? 'warn' : 'ok') +
    k('paid', 'Paid this month', paid.length, 'AED ' + fmt0(sum(paid)));
  $('#fxF').innerHTML = F.map(([id, t, fn]) => '<button type="button" class="fx-chip" data-fxf="' + id + '" aria-pressed="' + (ST.f === id) + '">' + t + '<b>' + R.filter(fn).length + '</b></button>').join('');
}
function analysis(r) {
  const math = r.open && r.cid ? '<h4>The numbers</h4><table class="fx-math"><tr><td>Client’s CFDA balance</td><td>' + (r.held < 0 ? '<span class="neg">' + fmt(r.held) + '</span>' : fmt(r.held)) + '</td></tr><tr><td>Committed to the client’s other open requests</td><td>' + (r.other ? '−' + fmt(r.other) : '0.00') + '</td></tr><tr><td>This request</td><td>−' + fmt(r.amount) + '</td></tr><tr class="tot"><td>Left after paying it</td><td>' + (r.after < 0 ? '<span class="neg">' + fmt(r.after) + '</span>' : fmt(r.after)) + '</td></tr></table>' : '';
  const fact = (l, v) => (v ? '<div><dt>' + l + '</dt><dd>' + esc(v) + '</dd></div>' : '');
  const facts = '<h4>Request details</h4><dl class="fx-facts">' + fact('Client', r.client) + fact('Created by', who(r.by)) + fact('Service', r.service) + fact('Raised', dlab(r.created)) + fact('Approval', r.approval) + fact('Payment status', r.payment) + fact('Paid on', dlab(r.paid_date)) + fact('Paid by', r.mode) + fact('Authority ref', r.ref) + fact('Zoho check', r.zoho) + fact('Checked at', r.checked) + '</dl>';
  const ln = r.cid ? ST.lines[r.cid] : null;
  const lines = r.cid ? '<h4>Client’s latest CFDA entries</h4>' + (ln ? (ln.length ? '<table class="fx-lines">' + ln.slice(0, 8).map((l) => '<tr><td>' + esc(dlab(l.date)) + '</td><td class="r">' + esc(l.type) + ' · ' + esc(l.ref) + '</td><td class="n">' + (l.received ? '+' + fmt(l.received) : '−' + fmt(l.paid)) + '</td><td class="n">' + (l.running == null ? '' : fmt(l.running)) + '</td></tr>').join('') + '</table>' : '<p class="fx-verdict" style="font-size:13px">No CFDA entries found for this client.</p>') : '<p class="fx-verdict" style="font-size:13px">' + (ST.linesBusy === r.cid ? 'Reading from Zoho Books…' : '') + '</p>') : '';
  return '<div class="fx-an"><div><h4>Analysis</h4>' + (r.note ? '<p class="fx-verdict">' + esc(r.note) + '</p>' : '') + '<ul class="fx-cks">' + r.ck.map(([lv, t]) => '<li class="' + lv + '"><span class="d" aria-hidden="true">' + ({ ok: '✓', warn: '!', bad: '✕', info: 'i' })[lv] + '</span><span>' + esc(t) + '</span></li>').join('') + '</ul></div><div>' + math + facts + lines + '</div></div>';
}
function card(r) {
  const v = V[r.v] || V.closed, open = ST.open === r.id;
  const meter = r.cover != null ? '<div class="fx-meter ' + (r.v === 'short' || r.v === 'unlinked' ? 'bad' : r.v === 'low' ? 'warn' : '') + '" role="img" aria-label="Funds cover ' + Math.round(r.cover * 100) + '% of this request"><i style="width:' + Math.max(2, Math.round(r.cover * 100)) + '%"></i></div>' : '';
  const sub = r.open ? '<span>Funds for it <b>' + (r.cid ? fmt(r.forThis) : '—') + '</b>' + (r.cover != null ? ' · ' + Math.round(r.cover * 100) + '% covered' : '') + '</span><span>After paying <b>' + (r.cid ? fmt(r.after) : '—') + '</b></span>' : '<span>' + esc(r.v === 'paid' ? 'Paid ' + dlab(r.paid_date) : r.approval) + '</span><span>' + esc(r.ref ? 'Ref ' + r.ref : '') + '</span>';
  const tags = [r.open ? [r.approval === 'Approved' ? '' : '', r.approval] : null, r.stale ? ['warn', 'Zoho check out of date'] : null, r.dup ? ['warn', 'Possible duplicate'] : null, r.open && r.age > 7 ? ['warn', 'Waiting ' + r.age + ' days'] : null, !r.open && r.warn ? ['warn', r.warn + ' warning' + (r.warn > 1 ? 's' : '')] : null].filter(Boolean);
  return '<article class="fx-card fx-g' + (open ? ' open' : '') + '" data-fxr="' + esc(r.id) + '" tabindex="0" role="button" aria-expanded="' + open + '">' + (open ? '<button class="fx-btn fx-x" type="button" data-fxclose>Close</button>' : '') +
    '<div class="fx-h"><div><h3>' + esc(r.name) + '</h3><small>' + esc([r.client && r.client !== r.name ? r.client : '', r.service].filter(Boolean).join(' · ')) + '</small></div><span class="fx-pill ' + v[0] + '"><i></i>' + v[1] + '</span></div>' +
    '<div class="fx-amt"><b>' + fmt(r.amount) + '</b><span>AED · raised ' + esc(dlab(r.created)) + '</span></div><div class="fx-by"><i aria-hidden="true">' + esc(who(r.by).slice(0, 1).toUpperCase()) + '</i>Created by <b>' + esc(who(r.by)) + '</b></div>' + meter + '<div class="fx-sub">' + sub + '</div>' +
    (tags.length ? '<div class="fx-tags">' + tags.map(([c, t]) => '<span class="fx-tag ' + c + '">' + esc(t) + '</span>').join('') + '</div>' : '') + (open ? analysis(r) : '') + '</article>';
}
const SORT = { risk: (a, b) => b.score - a.score || b.created.localeCompare(a.created), new: (a, b) => b.created.localeCompare(a.created), old: (a, b) => a.created.localeCompare(b.created), amt: (a, b) => b.amount - a.amount, client: (a, b) => (a.client || a.name).localeCompare(b.client || b.name) || b.created.localeCompare(a.created) };
function renderList() {
  const q = ST.q.trim().toLowerCase();
  const rows = scoped().filter(ftest(ST.f)).filter((r) => !q || [r.name, r.client, r.service, r.ref, who(r.by), r.amount.toFixed(2)].join(' ').toLowerCase().includes(q)).sort(SORT[ST.sort] || SORT.risk);
  let h = rows.slice(0, ST.shown).map(card).join('');
  if (!rows.length) h = '<div class="fx-empty fx-g">' + (ST.busy ? 'Reading payment requests from Zoho Books…' : ST.err ? esc(ST.err) : ST.at ? 'No requests match.' : core().mcp ? 'Press Refresh to read the payment requests.' : 'Open this page in claude.ai and press <b>Connect Zoho &amp; refresh</b> to read the payment requests.') + '</div>';
  else if (rows.length > ST.shown) h += '<div class="fx-more"><button class="fx-btn" type="button" data-fxmore>Show ' + Math.min(30, rows.length - ST.shown) + ' more of ' + (rows.length - ST.shown) + '</button></div>';
  $('#fxList').innerHTML = h;
}
function render() { renderStatus(); renderBy(); renderKpis(); renderList(); }

async function exportXls() {
  const K = core();
  try {
    if (!window.XLSX) await K.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const X = window.XLSX, wb = X.utils.book_new();
    const aoa = [['Raised', 'Created by', 'Request', 'Client', 'Service', 'Amount AED', 'Approval', 'Payment status', 'Verdict', 'CFDA balance', 'Other open requests', 'Left after paying', 'Covered %', 'Recommendation', 'Problems', 'Warnings', 'All checks', 'Zoho check', 'Zoho checked at', 'Paid on', 'Authority ref']];
    for (const r of scoped().slice().sort(SORT.risk)) aoa.push([r.created, who(r.by), r.name, r.client, r.service, r.amount, r.approval, r.payment, (V[r.v] || V.closed)[1], r.held, r.other, r.after, r.cover == null ? '' : Math.round(r.cover * 100), r.note, r.ck.filter((c) => c[0] === 'bad').map((c) => c[1]).join(' | '), r.ck.filter((c) => c[0] === 'warn').map((c) => c[1]).join(' | '), r.ck.map((c) => c[1]).join(' | '), r.zoho, r.checked, r.paid_date, r.ref]);
    const ws = X.utils.aoa_to_sheet(aoa); ws['!cols'] = [11, 24, 34, 30, 20, 13, 16, 14, 20, 13, 13, 13, 9, 60, 60, 60, 80, 14, 20, 11, 16].map((wch) => ({ wch }));
    X.utils.book_append_sheet(wb, ws, 'Fund requests');
    await K.saveFile('Client_fund_requests_' + today() + '.xlsx', new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })));
  } catch (e) { ST.err = 'Export failed: ' + ((e && e.message) || e); renderStatus(); }
}

/* ---------- events ---------- */
function openCard(id) {
  ST.open = ST.open === id ? '' : id; renderList();
  const r = ST.rows.find((x) => x.id === ST.open); if (!r) return;
  loadLines(r);
  const el = $('.fx-card.open'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
root.addEventListener('click', (ev) => {
  const t = ev.target;
  const bg = t.closest('[data-fxbg]'); if (bg) { ST.bg = bg.dataset.fxbg; $('#fx').dataset.bg = ST.bg; root.querySelectorAll('[data-fxbg]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.fxbg === ST.bg)); try { localStorage.setItem('cfi.bg', ST.bg); } catch (e) {} return; }
  const f = t.closest('[data-fxf]'); if (f) { ST.f = f.dataset.fxf; ST.shown = 30; renderKpis(); return renderList(); }
  if (t.closest('[data-fxmore]')) { ST.shown += 30; return renderList(); }
  if (t.closest('[data-fxclose]')) { ST.open = ''; return renderList(); }
  if (t.closest('#fxXls')) return exportXls();
  if (t.closest('#fxRefresh')) { const K = core(); if (K.mcp) return refresh(true); if (K.connect) return Promise.resolve(K.connect()).then(() => refresh(true)); return; }
  const c = t.closest('[data-fxr]'); if (c && !(c.classList.contains('open') && !t.closest('.fx-h'))) return openCard(c.dataset.fxr);
});
root.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches && ev.target.matches('[data-fxr]')) { ev.preventDefault(); openCard(ev.target.dataset.fxr); } });
root.addEventListener('input', (ev) => { if (ev.target.id === 'fxQ') { ST.q = ev.target.value; ST.shown = 30; renderList(); } });
root.addEventListener('change', (ev) => { if (ev.target.id === 'fxSort') { ST.sort = ev.target.value; renderList(); } else if (ev.target.id === 'fxBy') { ST.by = ev.target.value; ST.shown = 30; renderKpis(); renderList(); } });
const panel = document.getElementById('p-cfi');
const visible = () => !!panel && panel.classList.contains('on');
if (panel) new MutationObserver(() => { if (visible()) { render(); refresh(false); } }).observe(panel, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('cfd-core', () => { renderStatus(); if (visible() && !ST.busy) refresh(false); });
setInterval(() => { if (visible() && !document.hidden && !ST.open) refresh(false); }, 60000);
document.addEventListener('ol-bg', () => { const g = pageBg(); if (!g) return; ST.bg = g; $('#fx').dataset.bg = g; root.querySelectorAll('[data-fxbg]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.fxbg === g)); });
render();
if (visible()) refresh(false);
})();
