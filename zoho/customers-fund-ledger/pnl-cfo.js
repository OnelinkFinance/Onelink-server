/* CFO review for the P&L tab: every income and cost entry with a verdict and its justification, a month pack
   (a month against the one before and its three-month average, with what moved and what is missing) and a change
   log for the cost-of-sales and disbursement accounts. The checks are in pnl-engine.js (review, monthPack, changes).
   Loaded after pnl-more.js and before pnl.js: it wraps PNLMore to receive the tab's state and helpers, then adds its
   own cards under the tab's first card. It reads nothing itself and changes nothing in Zoho. */
(function () {
'use strict';
const orig = window.PNLMore, root = document.getElementById('pnlRoot');
if (!orig || !root) return;
let C = null, ST, E, esc, fmt, fmt0, neg, mlab, dlab, TYPE, blink, queued = false;
const $ = (s) => root.querySelector(s);
const ORG = '898300452';
const LINK = { expense: 'expenses', journal: 'accountant/manualjournals', bill: 'bills', invoice: 'invoices', creditnote: 'creditnotes', customer_payment: 'paymentsreceived', invoice_payment: 'paymentsreceived', expense_refund: 'expenses' };
const X = { mode: 'review', months: 'prev2', rv: null, rs: 'attn', rsec: '', racct: '', rq: '', rshown: 150, lscope: 'both', lkind: 'closed', lshown: 150, snapEv: [], one: '' };
try { const p = JSON.parse(localStorage.getItem('pnl.cfo.v1') || 'null'); if (p) { X.mode = p.mode || X.mode; X.months = p.months || X.months; } } catch (e) {}
const save = () => { try { localStorage.setItem('pnl.cfo.v1', JSON.stringify({ mode: X.mode, months: X.months })); } catch (e) {} };
const kpi = (l, v, s, cls) => '<div class="kpi ' + (cls || '') + '"><span class="l">' + l + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></div>';
/* which months these views cover: by default last month and this month, whatever the period buttons above say */
const MSETS = [['prev2', 'Last month + this month'], ['lastm', 'Last month'], ['thism', 'This month'], ['period', 'The period chosen above']];
function mset() {
  const R = ST.R, cur = R.curM;
  if (X.one) return new Set([X.one]);
  if (X.months === 'lastm') return new Set([E.addM(cur, -1)]);
  if (X.months === 'thism') return new Set([cur]);
  if (X.months === 'period' && ST.set) return ST.set;
  return new Set([E.addM(cur, -1), cur]);
}
const mlabel = () => { const ms = [...mset()].sort(); return ms.length ? (ms.length === 1 ? mlab(ms[0]) : mlab(ms[0]) + ' to ' + mlab(ms[ms.length - 1])) : 'no months'; };
window.PNLMore = function (ctx) {
  const M = orig(ctx); C = ctx; ({ ST, E, esc, fmt, fmt0, neg, mlab, dlab, TYPE, blink } = ctx);
  const rm = M.renderMore; M.renderMore = function () { const r = rm.apply(this, arguments); queue(); return r; };
  const ex = M.exportSheets; M.exportSheets = function (XL, wb) { const r = ex.apply(this, arguments); try { sheets(XL, wb); } catch (e) {} return r; };
  return M;
};
function queue() { if (queued) return; queued = true; Promise.resolve().then(() => { queued = false; try { render(); } catch (e) { if (window.console) console.error('pnl-cfo', e); } }); }
/* the tab re-renders its figures on every change; follow it */
new MutationObserver((ms) => { if (ms.some((m) => !(m.target.closest && m.target.closest('#cfWrap')) && m.target.id !== 'cfWrap')) queue(); }).observe(root, { childList: true, subtree: true });

function shell() {
  if ($('#cfWrap')) return true;
  const first = root.querySelector('.card'); if (!first) return false;
  const st = document.createElement('style');
  st.textContent = '.pl-v{display:inline-block;font:600 11.5px var(--sans);padding:1px 9px;border-radius:999px;white-space:nowrap}.pl-v.ok{background:var(--good-bg);color:var(--good)}.pl-v.thin{background:var(--low-bg,var(--surface-2));color:var(--ink-2)}.pl-v.check{background:var(--med-bg);color:var(--med)}.pl-v.fix{background:var(--crit-bg);color:var(--crit)}' +
    '.pl-why2{font-size:12.5px;line-height:1.45}.pl-why2 .is{color:var(--ink)}.pl-why2 .ba{color:var(--ink-3)}.pl-why2 .do{color:var(--ink-2);margin-top:3px}.pl-why2 .do b{font-weight:600}' +
    '.pl-hl{width:100%;max-width:760px}.pl-hl td,.pl-hl th{padding:6px 12px}.pl-box{padding:12px 16px;font-size:13px;line-height:1.55;border-bottom:1px solid var(--rule,var(--line-soft))}.pl-box b{font-weight:600}.pl-box.warn{background:var(--med-bg);color:var(--ink)}' +
    '#cfWrap .seg{flex-wrap:wrap;max-width:100%}#cfWrap .cf-tools{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--rule,var(--line-soft))}#cfWrap .cf-tools input[type=search]{flex:1 1 200px;min-width:0}#cfWrap .cf-empty{padding:28px 16px;color:var(--ink-3);text-align:center;line-height:1.6}';
  document.head.appendChild(st);
  const w = document.createElement('div'); w.id = 'cfWrap';
  w.innerHTML = '<div class="card" style="margin-top:16px"><div class="cf-tools" style="border-bottom:0"><span class="lbl">View</span><div class="seg" id="cfMode" role="group" aria-label="View"></div><span class="lbl" id="cfMsL">Months</span><div class="seg" id="cfMs" role="group" aria-label="Months"></div></div></div><div id="cfRv" hidden></div><div id="cfPk" hidden></div><div id="cfLg" hidden></div>';
  first.insertAdjacentElement('afterend', w);
  w.addEventListener('click', onClick); w.addEventListener('input', onInput); w.addEventListener('change', onChange);
  return true;
}
function render() {
  if (!C || !shell()) return;
  const R = ST.R, on = X.mode !== 'overview' && !!R, first = root.querySelector('.card');
  /* everything of the tab below its first card is the "analysis and statement" view */
  for (const el of root.children) if (el.id !== 'cfWrap' && el !== first && el.tagName !== 'STYLE') { if (on) { if (!el.hidden) { el.hidden = true; el.dataset.cfHid = '1'; } } else if (el.dataset.cfHid) { el.hidden = false; delete el.dataset.cfHid; } }
  $('#cfMode').innerHTML = MODES.map(([k, t]) => '<button type="button" data-cfm="' + k + '" class="' + (X.mode === k ? 'on' : '') + '">' + t + '</button>').join('');
  $('#cfMs').innerHTML = MSETS.map(([k, t]) => '<button type="button" data-cfms="' + k + '" class="' + (!X.one && X.months === k ? 'on' : '') + '">' + t + '</button>').join('') + (X.one ? '<button type="button" class="on" data-cfms="' + X.months + '">' + mlab(X.one) + ' only ✕</button>' : '');
  $('#cfMs').hidden = $('#cfMsL').hidden = X.mode === 'overview';
  $('#cfRv').hidden = X.mode !== 'review' || !R; $('#cfPk').hidden = X.mode !== 'pack' || !R; $('#cfLg').hidden = X.mode !== 'log' || !R;
  if (!R) return;
  snapshot();
  if (X.mode === 'review') renderReview(); else if (X.mode === 'pack') renderPack(); else if (X.mode === 'log') renderLog();
}

/* ---------- every entry, month pack, change log ---------- */
const MODES = [['review', 'Every entry'], ['pack', 'Month pack'], ['log', 'Change log'], ['overview', 'Analysis and statement']];
const VERD = { ok: 'Justified', thin: 'Reference only', check: 'To check', fix: 'Must fix' };
const RS = [['attn', 'Needs attention', (r) => r.status === 'fix' || r.status === 'check'], ['fix', 'Must fix', (r) => r.status === 'fix'], ['check', 'To check', (r) => r.status === 'check'], ['thin', 'Reference only', (r) => r.status === 'thin'], ['ok', 'Justified', (r) => r.status === 'ok'], ['all', 'All', () => true]];
const refCell = (l) => (l.ref ? esc(l.ref) : /^(expense|journal|bill)$/.test(l.et) ? '<span class="muted">no reference</span>' : '') + (l.desc && l.desc !== l.ref ? '<div class="muted" style="font-size:12px">' + esc(l.desc) + '</div>' : '');
function reviewRows() {
  const q = X.rq.trim().toLowerCase(), t = (RS.find((x) => x[0] === X.rs) || RS[0])[2];
  return X.rv.rows.filter((r) => t(r) && (!X.rsec || r.a.sec === X.rsec) && (!X.racct || r.a.id === X.racct) && (!q || [r.a.name, r.l.ref, r.l.desc, r.l.tno, r.l.cname, r.l.vname, r.l.td, Math.abs(r.amt).toFixed(2), r.issues.join(' ')].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.sev - a.sev || Math.abs(b.amt) - Math.abs(a.amt));
}
function renderReview() {
  const V = X.rv = E.review(ST.R, mset()), s = V.sum, el = $('#cfRv'), pc = (n) => (s.n ? Math.round(n / s.n * 100) : 0) + '%';
  const base = V.rows.filter((r) => (!X.rsec || r.a.sec === X.rsec));
  const accs = [...new Map(base.map((r) => [r.a.id, r.a])).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (X.racct && !accs.some((a) => a.id === X.racct)) X.racct = '';
  const rows = reviewRows();
  let h = '<div class="card" style="margin-top:16px"><header><div><h2>Every entry, checked</h2><span class="sub">' + mlabel() + ' · ' + s.n.toLocaleString('en-US') + ' income and cost entries</span></div></header>' +
    '<div class="body"><div class="grid kpis">' + kpi('Justified', s.ok + ' · ' + pc(s.ok), 'AED ' + fmt0(s.okAmt) + ' · reference, and precedent or a document', 'ok') + kpi('Reference only', s.thin + ' · ' + pc(s.thin), 'AED ' + fmt0(s.thinAmt) + ' · nothing to compare with') + kpi('To check', s.check + ' · ' + pc(s.check), 'AED ' + fmt0(s.checkAmt), s.check ? 'low' : 'ok') + kpi('Must fix', String(s.fix), 'AED ' + fmt0(s.fixAmt), s.fix ? 'bad' : 'ok') + '</div></div>' +
    '<div class="pl-box">Each entry is tested for a reference, the right account, a client link where one is needed, duplicates, the side it is posted on, its date and, once Zoho Books has been read, a description and a receipt. <b>Precedent</b> means how the same supplier, merchant or reference wording is booked on every other entry in the books. “Reference only” entries have nothing wrong, but nothing backs them except their own reference.</div>' +
    '<div class="cf-tools"><div class="seg" role="group" aria-label="Verdict">' + RS.map(([k, t, fn]) => '<button type="button" data-cfrs="' + k + '" class="' + (X.rs === k ? 'on' : '') + '">' + t + ' <span class="muted">' + base.filter(fn).length + '</span></button>').join('') + '</div></div>' +
    '<div class="cf-tools"><input type="search" id="cfRQ" placeholder="Search reference, account, client, supplier, amount" value="' + esc(X.rq) + '" autocomplete="off" spellcheck="false" aria-label="Search entries">' +
    '<select id="cfRSec" aria-label="Section"><option value="">All sections</option>' + Object.keys(E.SEC_LABEL).map((k) => '<option value="' + k + '"' + (X.rsec === k ? ' selected' : '') + '>' + esc(E.SEC_LABEL[k]) + '</option>').join('') + '</select>' +
    '<select id="cfRAcct" aria-label="Account"><option value="">All accounts (' + accs.length + ')</option>' + accs.map((a) => '<option value="' + esc(a.id) + '"' + (a.id === X.racct ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select>' +
    '<span class="sub">' + rows.length.toLocaleString('en-US') + ' shown · AED ' + fmt0(rows.reduce((t, r) => t + Math.abs(r.amt), 0)) + '</span></div>';
  if (!rows.length) h += '<div class="cf-empty">No entries match.</div>';
  else {
    h += '<div class="scroll" style="max-height:680px"><table><thead><tr><th>Date</th><th>Ref #</th><th>Type</th><th>Account</th><th>Reference / description</th><th>Client / supplier</th><th class="n">Amount</th><th>Verdict</th><th>Why, and what to do</th><th></th></tr></thead><tbody>';
    for (const r of rows.slice(0, X.rshown)) { const l = r.l;
      h += '<tr><td>' + dlab(l.td) + '</td><td class="num" style="text-align:left">' + esc(l.tno) + '</td><td>' + esc(TYPE[l.et] || l.et) + '</td><td><button class="linkish" type="button" data-cfacc="' + esc(r.a.id) + '">' + esc(r.a.name) + '</button><div class="muted" style="font-size:12px">' + esc(E.SEC_LABEL[r.a.sec]) + '</div></td><td class="wrap">' + refCell(l) + '</td><td class="wrap">' + esc([l.cname, l.vname].filter(Boolean).join(' · ')) + '</td><td class="n">' + neg(l.amt, fmt(l.amt)) + '</td><td><span class="pl-v ' + r.status + '">' + VERD[r.status] + '</span></td><td class="wrap pl-why2">' + r.issues.map((i) => '<div class="is">' + esc(i) + '</div>').join('') + (r.basis ? '<div class="ba">' + esc(r.basis) + '</div>' : '') + (r.todo.length ? '<div class="do"><b>Do:</b> ' + esc(r.todo.join(' ')) + '</div>' : '') + '</td><td>' + blink(l) + '</td></tr>'; }
    h += '</tbody></table></div>';
    if (rows.length > X.rshown) h += '<div class="cf-tools"><button class="btn" type="button" data-cfrmore>Show ' + Math.min(300, rows.length - X.rshown) + ' more</button><span class="sub">' + (rows.length - X.rshown).toLocaleString('en-US') + ' not shown; the Excel export has every entry</span></div>';
  }
  el.innerHTML = h + '</div>';
}
function renderPack() {
  const R = ST.R, el = $('#cfPk'); let ms = [...mset()].filter((m) => R.months.includes(m)).sort(); const cut = ms.length > 3; if (cut) ms = ms.slice(-3);
  let h = cut ? '<div class="card" style="margin-top:16px"><div class="pl-box">The month pack shows the last three months of the chosen period. Pick a shorter period for other months.</div></div>' : '';
  for (const m of ms.reverse()) {
    const K = E.monthPack(R, m), V = E.review(R, new Set([m])).sum, T = K.cur, P = K.pv;
    const row = (l, a, b, bold) => '<tr' + (bold ? ' class="tot"' : '') + '><td>' + l + '</td><td class="n">' + neg(a, fmt0(a)) + '</td><td class="n">' + neg(b, fmt0(b)) + '</td><td class="n">' + neg(a - b, (a - b > 0 ? '+' : '') + fmt0(a - b)) + '</td></tr>';
    const movers = K.lines.filter((x) => x.big).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    h += '<div class="card" style="margin-top:16px"><header><div><h2>' + mlab(m) + (K.open ? ' · month still open' : '') + '</h2><span class="sub">against ' + mlab(K.prev) + ' and the average of ' + K.base.map(mlab).join(', ') + '</span></div><button class="btn" type="button" data-cfgo="' + m + '">Check this month’s entries</button></header>' +
      '<div class="scroll"><table class="pl-hl"><thead><tr><th></th><th class="n">' + mlab(m) + '</th><th class="n">' + mlab(K.prev) + '</th><th class="n">Change</th></tr></thead><tbody>' + row('Income', T.income + T.oinc, P.income + P.oinc) + row('Cost of goods sold', T.cogs, P.cogs) + row('Gross profit', T.gross, P.gross, true) + row('Operating expenses', T.opex + T.oexp, P.opex + P.oexp) + row('Net profit', T.net, P.net, true) + '</tbody></table></div>' +
      (K.pendingN ? '<div class="pl-box warn"><b>' + (K.open ? 'Not final: ' : 'Possibly incomplete: ') + K.pendingN + ' regular costs worth about AED ' + fmt0(K.pending) + ' a month ' + (K.open ? 'are not booked yet' : 'have nothing booked') + '.</b> ' + (K.open ? 'Net profit of ' + fmt0(T.net) + ' would be about ' + fmt0(T.net - K.pending) + ' once they are in.' : 'If they belong to ' + mlab(m) + ', net profit of ' + fmt0(T.net) + ' is overstated by up to that amount. They are marked “missing” below.') + '</div>' : '') +
      '<div class="pl-box"><b>Evidence:</b> ' + V.n + ' entries · ' + V.ok + ' justified · ' + V.thin + ' on their reference only · ' + V.check + ' to check (AED ' + fmt0(V.checkAmt) + ') · ' + V.fix + ' must fix (AED ' + fmt0(V.fixAmt) + ').</div>';
    if (movers.length) {
      h += '<div class="scroll" style="max-height:520px"><table><thead><tr><th>Account</th><th>Section</th><th class="n">' + mlab(m) + '</th><th class="n">' + mlab(K.prev) + '</th><th class="n">3-month average</th><th class="n">Against average</th><th>What explains it</th></tr></thead><tbody>';
      for (const x of movers) h += '<tr><td><button class="linkish" type="button" data-cfacc="' + esc(x.a.id) + '" data-cfgo="' + m + '">' + esc(x.a.name) + '</button>' + (x.missing ? ' <span class="pl-v ' + (K.open ? 'thin' : 'check') + '">' + (K.open ? 'not booked yet' : 'missing') + '</span>' : '') + '</td><td>' + esc(E.SEC_LABEL[x.a.sec]) + '</td><td class="n">' + neg(x.v, fmt0(x.v)) + '</td><td class="n">' + neg(x.prev, fmt0(x.prev)) + '</td><td class="n">' + fmt0(x.avg) + '</td><td class="n">' + (x.d > 0 ? '+' : '') + neg(x.d, fmt0(x.d)) + '</td><td class="wrap">' + esc(x.why) + '</td></tr>';
      h += '</tbody></table></div><div class="note">Accounts that moved by at least AED 2,000 and 30% against their three-month average. The explanation lists the largest entries behind the figure.</div>';
    }
    h += '</div>';
  }
  el.innerHTML = h || '<div class="card" style="margin-top:16px"><div class="cf-empty">No months in this period.</div></div>';
}
/* entries of the cost-of-sales and disbursement accounts, remembered in this browser so the next read can show what was changed or deleted */
const tracked = (a) => a.sec === 'cogs' || a.pass;
function snapshot() {
  try { X.snapEv = JSON.parse(localStorage.getItem('pnl.snapev.v1') || '[]'); } catch (e) { X.snapEv = []; }
  if (!ST.R || !ST.at) return;
  try {
    const cur = {}; for (const l of ST.R.L) if (tracked(l.a)) cur[l.atid] = [l.a.id, l.amt, l.td, l.tno, l.ref.slice(0, 60), l.cname.slice(0, 40)];
    const old = JSON.parse(localStorage.getItem('pnl.snap.v1') || 'null'); if (old && old.src === ST.at) return;
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    if (old && old.m) {
      const nm = (id) => { const a = ST.R.A.get(id); return a ? a.name : 'an account outside cost of sales'; }, ev = [];
      for (const [k, o] of Object.entries(old.m)) { const c = cur[k];
        if (!c) { const still = ST.R.L.find((l) => l.atid === k); ev.push({ at, since: old.at, kind: still ? 'Moved out' : 'Deleted', tno: o[3], ref: o[4], cl: o[5], td: o[2], acct: nm(o[0]), amt: o[1], note: still ? 'Moved from “' + nm(o[0]) + '” to “' + still.a.name + '”' : 'No longer in the ledger: deleted, or its account or amount line was replaced' }); continue; }
        if (c[0] !== o[0]) ev.push({ at, since: old.at, kind: 'Account changed', tno: c[3], ref: c[4], cl: c[5], td: c[2], acct: nm(c[0]), amt: c[1], note: 'Moved from “' + nm(o[0]) + '” to “' + nm(c[0]) + '”' });
        if (Math.abs(c[1] - o[1]) > 0.005) ev.push({ at, since: old.at, kind: 'Amount changed', tno: c[3], ref: c[4], cl: c[5], td: c[2], acct: nm(c[0]), amt: c[1], note: 'Was ' + fmt(o[1]) + ', now ' + fmt(c[1]) + ' (' + (c[1] - o[1] > 0 ? '+' : '') + fmt(c[1] - o[1]) + ')' });
        if (c[2] !== o[2]) ev.push({ at, since: old.at, kind: 'Date changed', tno: c[3], ref: c[4], cl: c[5], td: c[2], acct: nm(c[0]), amt: c[1], note: 'Was dated ' + o[2] + ', now ' + c[2] });
      }
      if (ev.length) { X.snapEv = ev.concat(X.snapEv).slice(0, 400); localStorage.setItem('pnl.snapev.v1', JSON.stringify(X.snapEv)); }
    }
    localStorage.setItem('pnl.snap.v1', JSON.stringify({ at, src: ST.at, m: cur }));
  } catch (e) {}
}
const LSCOPE = [['both', 'Cost of sales + disbursements', tracked], ['cogs', 'Cost of goods sold', (a) => a.sec === 'cogs'], ['disb', 'Disbursements of expenses', (a) => a.pass], ['all', 'All income and cost accounts', () => true]];
const LKIND = [['closed', 'Changed a closed month', (c) => c.kind === 'backdated' || c.kind === 'editclosed'], ['edited', 'Edited', (c) => c.kind === 'edited' || c.kind === 'editclosed'], ['created', 'Entered', (c) => c.kind === 'created' || c.kind === 'backdated'], ['all', 'All', () => true]];
const LK = { created: ['ok', 'Entered'], backdated: ['check', 'Entered late'], edited: ['thin', 'Edited'], editclosed: ['fix', 'Edited after month end'] };
function logRows() {
  const ms = [...mset()].sort(), from = (ms[0] || ST.R.curM) + '-01', to = ST.R.today;
  const sc = LSCOPE.find((x) => x[0] === X.lscope) || LSCOPE[0];
  return { from, to, all: E.changes(ST.R, from, to, sc[2]) };
}
function renderLog() {
  const el = $('#cfLg'), G = logRows(), kf = (LKIND.find((x) => x[0] === X.lkind) || LKIND[0])[2], rows = G.all.filter(kf);
  const sumOf = (fn) => { const a = G.all.filter(fn); return [a.length, a.reduce((t, c) => t + Math.abs(c.l.amt), 0)]; };
  const k1 = sumOf((c) => c.kind === 'created'), k2 = sumOf((c) => c.kind === 'backdated'), k3 = sumOf((c) => c.kind === 'edited'), k4 = sumOf((c) => c.kind === 'editclosed');
  let h = '<div class="card" style="margin-top:16px"><header><div><h2>Change log</h2><span class="sub">Entered or edited from ' + dlab(G.from) + ' to ' + dlab(G.to) + ', by Zoho’s own timestamps</span></div><div class="controls"><div class="seg" role="group" aria-label="Accounts">' + LSCOPE.map(([k, t]) => '<button type="button" data-cfls="' + k + '" class="' + (X.lscope === k ? 'on' : '') + '">' + t + '</button>').join('') + '</div></div></header>' +
    '<div class="body"><div class="grid kpis">' + kpi('Entered', String(k1[0]), 'AED ' + fmt0(k1[1]) + ' · in its own month') + kpi('Entered late', String(k2[0]), 'AED ' + fmt0(k2[1]) + ' · dated in an earlier month', k2[0] ? 'low' : 'ok') + kpi('Edited', String(k3[0]), 'AED ' + fmt0(k3[1]) + ' · month still open') + kpi('Edited after month end', String(k4[0]), 'AED ' + fmt0(k4[1]) + ' · a reported month moved', k4[0] ? 'bad' : 'ok') + '</div></div>' +
    '<div class="pl-box">Zoho records when an entry was first entered and when it was last edited, but not what the edit changed. An entry edited twice shows only its last edit. To see old and new values, this page remembers the cost-of-sales and disbursement entries in your browser at each refresh and lists the differences below from the second refresh on. The Customers Fund Disbursement Account has its own log: <button class="linkish" type="button" data-cfcfda>open its Change log tab</button>.</div>' +
    '<div class="cf-tools"><div class="seg" role="group" aria-label="Kind">' + LKIND.map(([k, t, fn]) => '<button type="button" data-cflk="' + k + '" class="' + (X.lkind === k ? 'on' : '') + '">' + t + ' <span class="muted">' + G.all.filter(fn).length + '</span></button>').join('') + '</div><span class="sub">' + rows.length + ' shown</span></div>';
  if (!rows.length) h += '<div class="cf-empty">Nothing of this kind in the period.</div>';
  else {
    h += '<div class="scroll" style="max-height:620px"><table><thead><tr><th>When</th><th>What happened</th><th>Dated</th><th>Ref #</th><th>Account</th><th>Reference</th><th>Client / supplier</th><th class="n">Amount</th><th>Effect</th><th></th></tr></thead><tbody>';
    for (const c of rows.slice(0, X.lshown)) { const l = c.l, k = LK[c.kind];
      h += '<tr><td style="white-space:nowrap">' + esc(dlab(c.when.slice(0, 10)) + ' ' + c.when.slice(11)) + '</td><td><span class="pl-v ' + k[0] + '">' + k[1] + '</span></td><td>' + dlab(l.td) + '</td><td class="num" style="text-align:left">' + esc(l.tno) + '</td><td>' + esc(l.a.name) + '</td><td class="wrap">' + refCell(l) + '</td><td class="wrap">' + esc([l.cname, l.vname].filter(Boolean).join(' · ')) + '</td><td class="n">' + neg(l.amt, fmt(l.amt)) + '</td><td class="wrap pl-why2">' + esc(c.note) + '</td><td>' + blink(l) + '</td></tr>'; }
    h += '</tbody></table></div>';
    if (rows.length > X.lshown) h += '<div class="cf-tools"><button class="btn" type="button" data-cflmore>Show ' + Math.min(300, rows.length - X.lshown) + ' more</button></div>';
  }
  h += '</div><div class="card" style="margin-top:16px"><header><div><h2>Changed since an earlier refresh</h2><span class="sub">Cost of sales and disbursement entries · old and new values · kept in this browser</span></div></header>';
  if (!X.snapEv.length) h += '<div class="cf-empty">No differences recorded yet. The entries were remembered at this refresh; anything moved, re-valued, re-dated or deleted before the next refresh will be listed here.</div>';
  else { h += '<div class="scroll" style="max-height:460px"><table><thead><tr><th>Noticed</th><th>Change</th><th>Dated</th><th>Ref #</th><th>Account</th><th>Reference</th><th>Client</th><th class="n">Amount</th><th>Old and new</th></tr></thead><tbody>';
    for (const e of X.snapEv.slice(0, 200)) h += '<tr><td style="white-space:nowrap">' + esc(e.at) + '<div class="muted" style="font-size:12px">since ' + esc(e.since || '') + '</div></td><td><span class="pl-v ' + (e.kind === 'Deleted' ? 'fix' : 'check') + '">' + esc(e.kind) + '</span></td><td>' + dlab(e.td) + '</td><td class="num" style="text-align:left">' + esc(e.tno) + '</td><td>' + esc(e.acct) + '</td><td class="wrap">' + esc(e.ref) + '</td><td class="wrap">' + esc(e.cl) + '</td><td class="n">' + fmt(e.amt) + '</td><td class="wrap pl-why2">' + esc(e.note) + '</td></tr>';
    h += '</tbody></table></div>'; }
  el.innerHTML = h + '</div>';
}


/* three more sheets in the tab's Excel export */
function sheets(XL, wb) {
  const R = ST.R; if (!R) return;
  const add = (name, aoa, w) => { const ws = XL.utils.aoa_to_sheet(aoa); ws['!cols'] = w.map((wch) => ({ wch })); XL.utils.book_append_sheet(wb, ws, name); };
  const V = E.review(R, mset());
  const ev = [['Verdict', 'Date', 'Month', 'Type', 'Ref #', 'Account', 'Section', 'Reference', 'Description', 'Client', 'Supplier', 'Amount AED', 'What is wrong', 'What supports it', 'What to do', 'Zoho Books link']];
  for (const r of V.rows.slice().sort((a, b) => b.sev - a.sev || a.l.td.localeCompare(b.l.td))) { const l = r.l; ev.push([VERD[r.status], l.td, l.m, TYPE[l.et] || l.et, l.tno, r.a.name, E.SEC_LABEL[r.a.sec], l.ref, l.desc, l.cname, l.vname, l.amt, r.issues.join(' | '), r.basis, r.todo.join(' '), LINK[l.et] ? 'https://books.zoho.com/app/' + ORG + '#/' + LINK[l.et] + '/' + l.eid : '']); }
  add('Every entry', ev, [14, 11, 9, 12, 12, 34, 20, 46, 46, 26, 26, 13, 60, 50, 60, 40]);
  const pk = [['Month', 'Account', 'Section', 'This month', 'Previous month', '3-month average', 'Against average', 'Missing', 'What explains it']];
  for (const m of [...mset()].filter((m) => R.months.includes(m)).sort().slice(-3)) { const K = E.monthPack(R, m); pk.push([m, 'NET PROFIT', '', K.cur.net, K.pv.net, '', '', '', K.pendingN ? K.pendingN + ' regular costs of about ' + Math.round(K.pending) + ' not booked' : '']); for (const x of K.lines.filter((x) => x.big).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))) pk.push([m, x.a.name, E.SEC_LABEL[x.a.sec], x.v, x.prev, x.avg, x.d, x.missing ? 'Yes' : '', x.why]); }
  add('Month pack', pk, [9, 36, 20, 13, 13, 13, 13, 8, 90]);
  const lg = [['When', 'What happened', 'Dated', 'Ref #', 'Account', 'Reference', 'Client', 'Supplier', 'Amount AED', 'Effect']];
  for (const c of logRows().all) lg.push([c.when, LK[c.kind][1], c.l.td, c.l.tno, c.l.a.name, c.l.ref, c.l.cname, c.l.vname, c.l.amt, c.note]);
  for (const e of X.snapEv) lg.push([e.at, e.kind, e.td, e.tno, e.acct, e.ref, e.cl, '', e.amt, e.note]);
  add('Change log', lg, [17, 22, 11, 12, 34, 46, 26, 26, 13, 80]);
}

function onClick(ev) {
  const t = ev.target;
  const md = t.closest('[data-cfm]'); if (md) { X.mode = md.dataset.cfm; save(); return render(); }
  const ms = t.closest('[data-cfms]'); if (ms) { X.months = ms.dataset.cfms; X.one = ''; X.rshown = X.lshown = 150; save(); return render(); }
  const go = t.closest('[data-cfgo]'); if (go) { X.one = go.dataset.cfgo; X.mode = 'review'; X.rs = 'attn'; X.rsec = ''; X.rq = ''; X.racct = (t.closest('[data-cfacc]') || { dataset: {} }).dataset.cfacc || ''; if (X.racct) X.rs = 'all'; X.rshown = 150; render(); const w = $('#cfWrap'); if (w.scrollIntoView) w.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const rs = t.closest('[data-cfrs]'); if (rs) { X.rs = rs.dataset.cfrs; X.rshown = 150; return renderReview(); }
  if (t.closest('[data-cfrmore]')) { X.rshown += 300; return renderReview(); }
  const a2 = t.closest('[data-cfacc]'); if (a2) { X.racct = a2.dataset.cfacc; X.rs = 'all'; X.mode = 'review'; X.rshown = 150; return render(); }
  const ls = t.closest('[data-cfls]'); if (ls) { X.lscope = ls.dataset.cfls; X.lshown = 150; return renderLog(); }
  const lk = t.closest('[data-cflk]'); if (lk) { X.lkind = lk.dataset.cflk; X.lshown = 150; return renderLog(); }
  if (t.closest('[data-cflmore]')) { X.lshown += 300; return renderLog(); }
  if (t.closest('[data-cfcfda]')) { const tb = document.querySelector('.tab[data-t="changes"]'); if (tb) tb.click(); }
}
function onInput(ev) { if (ev.target.id === 'cfRQ') { X.rq = ev.target.value; X.rshown = 150; const pos = ev.target.selectionStart; renderReview(); const q = $('#cfRQ'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {} } } }
function onChange(ev) {
  if (ev.target.id === 'cfRSec') { X.rsec = ev.target.value; X.racct = ''; X.rshown = 150; renderReview(); }
  else if (ev.target.id === 'cfRAcct') { X.racct = ev.target.value; X.rshown = 150; renderReview(); }
}
})();
