/* P&L review engine: pure functions, no DOM. Used by pnl.js on the Customers Fund Ledger page and by the tests.
   Input: every Zoho Books ledger line on an income, cost-of-sales or expense account (from Zoho Analytics), the
   chart of accounts, and (optionally) what Zoho Books says about each expense (description, receipt).
   Output: the P&L by account and month, and a list of findings — entries that need fixing or checking. */
(function (root) {
'use strict';
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const SEC = { 'Income': 'income', 'Other Income': 'oinc', 'Cost Of Goods Sold': 'cogs', 'Expense': 'opex', 'Other Expense': 'oexp' };
const SEC_LABEL = { income: 'Income', cogs: 'Cost of goods sold', opex: 'Operating expenses', oinc: 'Other income', oexp: 'Other expenses' };
/* accounts that are a holding place, and accounts that say nothing about what was bought */
const HOLD = /uncategori[sz]ed|suspense|missing invoice|unknown|ask my accountant|to be classified|clearing/i;
const GENERIC = /^(other|other expenses?|other charges|general income|miscellaneous( expenses?)?)$/i;
const PASS = /^disbursements of expenses$/i;          /* costs billed straight on to clients: nets to zero */
const AUTO = /bank (fees|charges)|bank charges|stripe fees|card charges|exchange gain/i;   /* posted by feeds, no receipt expected */
const RECUR = /salary|salaries|\brent\b|retainer|intern|consultant/i;
const DOC = new Set(['expense', 'journal', 'bill', 'expense_refund']);   /* entries a person typed */
const STOP = new Set(('payment payments paid charges charge expense expenses fees invoice invoices bill client clients company office dubai monthly month ' +
  'january february march april june july august september october november december 2025 2026 2027 from with this that have been were ' +
  'amount total balance transfer online purchase card alaan wallet bank account services service general other misc refund reversal adjustment').split(' '));
/* wording that points to one account whatever the supplier: [what the entry says, the account it belongs in] */
const WORDS = [
  [/\b(careem|uber|taxi|hala cab|bolt ride)\b/i, /taxi/i, 'a taxi ride', /quik|grocer|food|pantry|eats|delivery/i],
  [/facebook|facebk|\bmeta ads|instagram ads/i, /facebook/i, 'Facebook advertising'],
  [/google ?ads|google\*ads|adwords/i, /google ads/i, 'Google Ads'],
  [/tik ?tok/i, /tik ?tok/i, 'TikTok advertising'],
  [/\b(chatgpt|chat gpt|openai)\b/i, /chat ?gpt|openai/i, 'ChatGPT'],
  [/\b(claude\.ai|anthropic)\b/i, /claude/i, 'Claude'],
  [/\bzoho\b/i, /zoho/i, 'a Zoho subscription'],
  [/\b(enoc|adnoc|emarat|petrol|fuel)\b/i, /fuel/i, 'fuel'],
  [/\b(aramex|dhl|fedex|courier)\b/i, /courier/i, 'a courier'],
  [/\b(etisalat|virgin mobile|du telecom|e& ?uae)\b/i, /telephone/i, 'a phone or internet bill'],
];
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const normRef = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const addM = (m, k) => { let y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + k; y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12; return y + '-' + String(mo + 1).padStart(2, '0'); };

/* what each check means, how serious it is, and what to do about it */
const CHECKS = [
  { id: 'hold', sev: 'fix', title: 'Sitting in a holding account', why: 'These entries are in an account such as Uncategorized or a clearing account, so the P&L does not say what the money was for.', todo: 'Open each entry in Zoho Books and move it to the account it belongs to.' },
  { id: 'future', sev: 'fix', title: 'Dated in the future', why: 'Entries dated after today already sit in the P&L of later months.', todo: 'If the date is a typing error, correct it. If it is a prepayment (rent, insurance), book it to Prepaid Expenses and release it month by month.' },
  { id: 'miscat', sev: 'review', title: 'Probably in the wrong account', why: 'The same supplier, or the same wording in the reference, is booked to a different account nearly every other time.', todo: 'Check the entry; if it matches the others, change its account in Zoho Books.' },
  { id: 'clientcost', sev: 'review', title: 'Client cost booked as overhead', why: 'The entry is tagged to a client but sits in an operating expense account, so it lowers net profit without showing in that client’s cost of sales or gross margin.', todo: 'If the cost was for the client, move it to Cost of Goods Sold (or the client fund account if the client is paying). If it is a company cost, remove the client tag.' },
  { id: 'cogsnoclient', sev: 'review', title: 'Cost of sale with no client', why: 'A cost-of-sales entry with no client cannot be matched to the revenue it belongs to.', todo: 'Add the client to the entry in Zoho Books (the Untagged entries tab lists the same entries with a suggested client).' },
  { id: 'sign', sev: 'review', title: 'Posted on the wrong side', why: 'A credit in an expense account or a debit in an income account, entered by hand. It can hide income inside expenses or the other way round.', todo: 'Confirm it is a genuine refund or correction. If it is income, book it to an income account.' },
  { id: 'incomejournal', sev: 'review', title: 'Income booked by journal', why: 'Revenue was posted with a manual journal instead of an invoice, so it has no invoice, client statement or VAT treatment behind it.', todo: 'Check each one has support, and raise an invoice where one is missing.' },
  { id: 'dup', sev: 'review', title: 'Possible duplicates', why: 'Two or more entries in the same account on the same day for the same amount.', todo: 'Compare them in Zoho Books and delete the one entered twice.' },
  { id: 'gap', sev: 'review', title: 'Monthly cost missing or doubled', why: 'An account that is booked every month (a salary, rent, a retainer) has a month with nothing, or a month at about twice the usual amount.', todo: 'Check the missing month was not booked to another account, and that the doubled month is not a duplicate.' },
  { id: 'outlier', sev: 'review', title: 'Unusually large for its account', why: 'The entry is at least five times the usual size for that account.', todo: 'Confirm the amount and the account. Large one-off costs are often an asset, a prepayment or a different category.' },
  { id: 'late', sev: 'review', title: 'Entered long after its date', why: 'The entry was created more than 45 days after its transaction date, in a month that had already ended, so an earlier month’s P&L changed after the fact.', todo: 'Make sure the earlier month’s reported figures were updated, or re-date the entry.' },
  { id: 'mix', sev: 'review', title: 'Same kind of cost in two sections', why: 'Commission and referral accounts sit partly in Cost of Goods Sold and partly in operating expenses, so gross margin is not comparable between months.', todo: 'Decide where commissions belong and change the account type of the odd ones out.' },
  { id: 'parent', sev: 'review', title: 'Posted to a group account', why: 'The account is a heading with sub-accounts under it. Entries posted to the heading itself are not classified.', todo: 'Move each entry to the right sub-account.' },
  { id: 'generic', sev: 'review', title: 'In a catch-all account', why: 'Accounts such as Other Expenses or Miscellaneous do not say what was bought.', todo: 'Move each entry to a specific account.' },
  { id: 'noref', sev: 'review', title: 'No reference', why: 'The entry has no reference text, so nobody can tell from the ledger what it was for.', todo: 'Open the entry in Zoho Books and add a reference that says what was paid and for whom.' },
  { id: 'nodesc', sev: 'review', title: 'No description in Zoho Books', why: 'The expense has no notes in Zoho Books.', todo: 'Add a short description to the expense.' },
  { id: 'noreceipt', sev: 'review', title: 'No receipt attached', why: 'The expense has no receipt or invoice attached in Zoho Books. Without one it may not be deductible and cannot be checked.', todo: 'Attach the receipt to the expense in Zoho Books.' },
  { id: 'oneoff', sev: 'tidy', title: 'Accounts used once or twice', why: 'These accounts hold one or two entries in total. They make the P&L long without adding information.', todo: 'Move the entries to a broader account and mark the account inactive.' },
  { id: 'unused', sev: 'tidy', title: 'Accounts never used', why: 'Active accounts with no entries in any period.', todo: 'Mark them inactive in Zoho Books so they stop appearing in pick lists.' },
];

function analyse(input) {
  const today = input.today, curM = today.slice(0, 7), books = input.books || null;
  /* books: expense id -> { d: description, a: has a receipt, v: supplier, r: full reference, m: merchant } read from Zoho Books */
  /* ---------- accounts ---------- */
  const A = new Map();
  for (const a of (input.accounts || [])) {
    const sec = SEC[a.atype]; if (!sec) continue;
    A.set(String(a.acct), { id: String(a.acct), name: String(a.aname || '').trim(), type: a.atype, sec, parent: a.parent ? String(a.parent) : '', active: !/^(no|false|0)$/i.test(String(a.active || 'Yes')),
      created: a.created || '', kids: 0, n: 0, total: 0, by: new Map(), first: '', last: '', lines: [] });
  }
  for (const a of A.values()) if (a.parent && A.has(a.parent)) A.get(a.parent).kids++;
  for (const a of A.values()) {
    let x = a, g = 0; while (x.parent && A.has(x.parent) && g++ < 6) x = A.get(x.parent);
    a.group = x === a && !a.kids ? '' : x.name; a.groupId = x === a && !a.kids ? '' : x.id;
    a.pass = PASS.test(a.name);
  }
  /* ---------- lines ---------- */
  const L = []; let unknown = 0;
  for (const x of (input.rows || [])) {
    const a = A.get(String(x.acct)); if (!a) { unknown++; continue; }
    const dr = +x.dr || 0, cr = +x.cr || 0, td = String(x.td || '');
    const amt = a.sec === 'income' || a.sec === 'oinc' ? r2(cr - dr) : r2(dr - cr);
    const l = { atid: x.atid, et: x.et, eid: String(x.eid || ''), a, td, m: td.slice(0, 7), tno: x.tno || '', ref: String(x.ref || x.refn || '').replace(/\s+/g, ' ').trim(), dr, cr, amt,
      cust: x.cust || '', cname: x.cname || '', vend: x.vend || '', vname: String(x.vname || '').trim(), lm: x.lm || '', ct: x.ct || '', bill: x.bill || '', pf: x.pf || '', doc: DOC.has(x.et), desc: '', merch: '' };
    const bk = books && x.et === 'expense' ? books.get(l.eid) : null;
    if (bk) { l.bk = bk; l.desc = String(bk.d || '').replace(/\s+/g, ' ').trim(); l.merch = String(bk.m || '').trim(); if (bk.r && bk.r.length > l.ref.length) l.ref = String(bk.r).replace(/\s+/g, ' ').trim(); if (!l.vname && bk.v) l.vname = String(bk.v).trim(); }
    l.text = (l.ref + ' ' + l.desc).trim();
    L.push(l); a.lines.push(l); a.n++; a.total = r2(a.total + amt); a.by.set(l.m, r2((a.by.get(l.m) || 0) + amt));
    if (!a.first || td < a.first) a.first = td; if (!a.last || td > a.last) a.last = td;
  }
  /* the books were set up on the day the first entry was typed; anything dated before that was loaded as history */
  let golive = ''; for (const l of L) if (l.ct && (!golive || l.ct < golive)) golive = l.ct;
  golive = golive.slice(0, 10);
  let m0 = curM; for (const l of L) if (l.m && l.m < m0) m0 = l.m;
  const months = []; for (let m = m0; m <= curM; m = addM(m, 1)) months.push(m);
  const future = [...new Set(L.filter((l) => l.m > curM).map((l) => l.m))].sort();

  /* ---------- findings ---------- */
  const F = new Map(CHECKS.map((c) => [c.id, Object.assign({ items: [] }, c)]));
  const add = (id, l, note, extra) => F.get(id).items.push(Object.assign({ l, a: l.a, m: l.m, amt: l.amt, note: note || '' }, extra || {}));
  const addAcc = (id, a, m, amt, note) => F.get(id).items.push({ l: null, a, m: m || '', amt: amt || 0, note: note || '' });

  for (const l of L) {
    const a = l.a;
    if (HOLD.test(a.name)) add('hold', l, 'In “' + a.name + '”');
    else if (GENERIC.test(a.name)) add('generic', l, 'In “' + a.name + '”');
    if (a.kids > 0 && a.sec !== 'income') add('parent', l, '“' + a.name + '” has ' + a.kids + ' sub-accounts');
    if (l.td > today) add('future', l, 'Dated ' + l.td + ', counted in ' + l.m);
    if (l.doc && !l.ref && l.et !== 'bill') add('noref', l, l.desc ? 'Has a description but no reference' : '');
    if (l.doc && l.et !== 'expense_refund') {
      if ((a.sec === 'opex' || a.sec === 'cogs' || a.sec === 'oexp') && l.cr > 0 && !a.pass && !AUTO.test(a.name)) add('sign', l, 'Credit of ' + l.cr.toFixed(2) + ' in an expense account');
      if ((a.sec === 'income' || a.sec === 'oinc') && l.dr > 0 && l.et !== 'journal') add('sign', l, 'Debit of ' + l.dr.toFixed(2) + ' in an income account');
    }
    if ((a.sec === 'income' || a.sec === 'oinc') && l.et === 'journal') add(l.dr > 0 ? 'sign' : 'incomejournal', l, l.dr > 0 ? 'Journal debit of ' + l.dr.toFixed(2) + ' in an income account' : 'Journal ' + (l.tno || '') + ' credits income');
    if (a.sec === 'opex' && !a.pass && l.doc && l.et !== 'expense_refund' && l.cust && l.amt > 0) add('clientcost', l, 'Tagged to ' + (l.cname || 'a client'));
    if (a.sec === 'cogs' && l.doc && !l.cust && !/commission/i.test(a.name + ' ' + a.group) && !HOLD.test(a.name)) add('cogsnoclient', l, '');
    if (l.doc && l.ct && l.td && l.td <= today) { const d = days(l.td, l.ct.slice(0, 10)); if (d > 45 && l.m < l.ct.slice(0, 7) && l.td >= golive) add('late', l, 'Dated ' + l.td + ', entered ' + l.ct.slice(0, 10) + ' (' + d + ' days later)'); }
    if (l.bk) { if (!l.desc) add('nodesc', l, ''); if (!l.bk.a && !AUTO.test(a.name) && Math.abs(l.amt) >= 1) add('noreceipt', l, ''); }
  }
  /* possible duplicates: same account, day, amount and wording, entered as different documents */
  {
    const g = new Map();
    for (const l of L) { if (!l.doc || Math.abs(l.amt) < 50 || AUTO.test(l.a.name)) continue; const k = l.a.id + '|' + l.td + '|' + Math.abs(l.amt).toFixed(2) + '|' + normRef(l.ref) + '|' + (l.ref ? '' : normRef(l.vname)); if (!g.has(k)) g.set(k, []); g.get(k).push(l); }
    for (const arr of g.values()) {
      const ents = new Set(arr.map((l) => l.et + '|' + l.eid)); if (ents.size < 2) continue;
      if (arr.every((l) => l.et === 'bill') && new Set(arr.map((l) => l.tno)).size === arr.length) continue;
      if (!arr[0].ref && !(arr[0].vname && Math.abs(arr[0].amt) >= 200) && Math.abs(arr[0].amt) < 1000) continue;
      arr.forEach((l) => add('dup', l, ents.size + ' entries of ' + Math.abs(l.amt).toFixed(2) + ' on ' + l.td, { grp: arr[0].atid }));
    }
  }
  /* monthly accounts: a month with nothing, or about double */
  for (const a of A.values()) {
    if (a.sec !== 'opex' || a.pass || a.kids || !(RECUR.test(a.name) || /salar/i.test(a.group))) continue;
    const act = months.filter((m) => Math.abs(a.by.get(m) || 0) > 0.004); if (act.length < 4) continue;
    const med = median(act.map((m) => Math.abs(a.by.get(m)))), first = act[0], last = act[act.length - 1];
    for (const m of months) {
      if (m <= first || m >= last) continue;
      const v = Math.abs(a.by.get(m) || 0);
      if (v < 0.005) addAcc('gap', a, m, 0, 'Nothing booked in this month; the usual month is about ' + med.toFixed(2));
    }
    for (const m of act) { const v = Math.abs(a.by.get(m)); if (med > 0 && v >= 1.8 * med && v - med >= 1000) addAcc('gap', a, m, r2(a.by.get(m)), 'About ' + (v / med).toFixed(1) + ' times the usual month (' + med.toFixed(2) + ')'); }
  }
  /* unusually large entries in an overhead account */
  for (const a of A.values()) {
    if (a.sec !== 'opex' || a.pass || RECUR.test(a.name) || /salar/i.test(a.group)) continue;
    const docs = a.lines.filter((l) => l.doc && l.amt > 0); if (docs.length < 8) continue;
    const med = median(docs.map((l) => l.amt));
    for (const l of docs) if (l.amt >= Math.max(5 * med, 5000)) add('outlier', l, 'Usual entry in “' + a.name + '” is about ' + med.toFixed(2));
  }
  /* probably the wrong account: the same supplier or wording nearly always goes somewhere else */
  {
    const pool = L.filter((l) => l.doc && l.et !== 'expense_refund' && (l.a.sec === 'opex' || l.a.sec === 'cogs') && !l.a.pass && l.amt > 0);
    const flagged = new Set();
    const rule = (keyOf, label, minN, share) => {
      const g = new Map();
      for (const l of pool) for (const k of keyOf(l)) { if (!g.has(k)) g.set(k, new Map()); const e = g.get(k); if (!e.has(l.a.id)) e.set(l.a.id, new Set()); e.get(l.a.id).add(l.et + '|' + l.eid); }
      const best = new Map();
      for (const [k, e] of g) {
        let tot = 0, top = null, topN = 0; for (const [id, s] of e) { tot += s.size; if (s.size > topN) { topN = s.size; top = id; } }
        if (tot >= minN && topN / tot >= share && tot - topN >= 1) best.set(k, { top, topN, tot });
      }
      for (const l of pool) for (const k of keyOf(l)) {
        const b = best.get(k); if (!b || b.top === l.a.id || flagged.has(l.atid)) continue;
        const t = A.get(b.top);
        /* a different person's salary account, or an account in a different section, is not "the same thing" */
        if (RECUR.test(t.name) || RECUR.test(l.a.name)) continue;
        flagged.add(l.atid); add('miscat', l, label(k) + ' booked to “' + t.name + '” in ' + b.topN + ' of ' + b.tot + ' entries', { to: t });
      }
    };
    rule((l) => (l.vname && !/suppliers?$/i.test(l.vname) ? ['v:' + l.vname.toLowerCase()] : []), (k) => 'Supplier “' + k.slice(2) + '” is', 5, 0.8);
    rule((l) => (l.merch && !l.cust ? ['m:' + l.merch.toLowerCase()] : []), (k) => 'Merchant “' + k.slice(2) + '” is', 5, 0.8);
  }
  /* wording that names a specific kind of cost sitting in some other overhead account */
  {
    const seen = new Set(F.get('miscat').items.map((i) => i.l.atid));
    const targets = WORDS.map(([re, acc, what, not]) => ({ re, acc, what, not, to: [...A.values()].filter((a) => acc.test(a.name) && a.n && !a.kids).sort((x, y) => y.n - x.n)[0] })).filter((w) => w.to);
    for (const l of L) {
      if (!l.doc || l.et === 'expense_refund' || l.a.sec !== 'opex' || l.a.pass || l.cust || l.amt <= 0 || seen.has(l.atid)) continue;
      if (RECUR.test(l.a.name) || /salar|consultant/i.test(l.a.group)) continue;
      for (const w of targets) { if (w.acc.test(l.a.name) || !w.re.test(l.text) || (w.not && w.not.test(l.text))) continue; add('miscat', l, 'Reads like ' + w.what + '; those are booked to “' + w.to.name + '”', { to: w.to }); break; }
    }
  }
  /* commission and referral accounts split between cost of sales and overhead */
  {
    const cm = [...A.values()].filter((a) => /commission|referral/i.test(a.name) && !a.kids && a.n && (a.sec === 'cogs' || a.sec === 'opex'));
    const inC = cm.filter((a) => a.sec === 'cogs'), inO = cm.filter((a) => a.sec === 'opex');
    if (inC.length && inO.length) { const odd = inC.length >= inO.length ? inO : inC, other = odd === inO ? 'Cost of Goods Sold' : 'operating expenses'; for (const a of odd) addAcc('mix', a, '', a.total, 'Is under ' + SEC_LABEL[a.sec] + '; ' + (odd === inO ? inC.length : inO.length) + ' other commission or referral accounts are under ' + other); }
  }
  for (const a of A.values()) {
    if (a.kids || a.pass) continue;
    if (a.n > 0 && a.n <= 2 && !HOLD.test(a.name)) addAcc('oneoff', a, a.last.slice(0, 7), a.total, a.n + (a.n === 1 ? ' entry' : ' entries') + ' in total' + (a.group ? ', under ' + a.group : ''));
    if (a.n === 0 && a.active && a.created && a.created > '1971') addAcc('unused', a, '', 0, 'Created ' + a.created + (a.group ? ', under ' + a.group : ''));
  }
  const findings = CHECKS.map((c) => F.get(c.id)).filter((f) => f.items.length || ((f.id === 'nodesc' || f.id === 'noreceipt') && !books));
  return { A, L, months, future, findings, unknown, today, curM, booksRead: !!books };
}

/* totals for a set of months: every section, every group, every account */
function statement(R, monthSet) {
  const inP = (m) => !monthSet || monthSet.has(m);
  const secs = {}; for (const k of Object.keys(SEC_LABEL)) secs[k] = { key: k, label: SEC_LABEL[k], total: 0, by: new Map(), groups: new Map() };
  for (const a of R.A.values()) {
    if (a.kids && !a.n) continue;
    let tot = 0; const by = new Map();
    for (const [m, v] of a.by) if (inP(m)) { tot += v; by.set(m, v); }
    if (!a.n && !tot) continue;
    const s = secs[a.sec], gk = a.group || '';
    if (!s.groups.has(gk)) s.groups.set(gk, { name: gk, total: 0, by: new Map(), accounts: [] });
    const g = s.groups.get(gk); g.accounts.push({ a, total: r2(tot), by });
    g.total = r2(g.total + tot); s.total = r2(s.total + tot);
    for (const [m, v] of by) { g.by.set(m, r2((g.by.get(m) || 0) + v)); s.by.set(m, r2((s.by.get(m) || 0) + v)); }
  }
  const col = (f) => { const o = new Map(); for (const m of R.months.concat(R.future)) if (inP(m)) o.set(m, r2(f(m))); return o; };
  const v = (k, m) => secs[k].by.get(m) || 0;
  const gross = col((m) => v('income', m) - v('cogs', m)), oper = col((m) => v('income', m) - v('cogs', m) - v('opex', m)), net = col((m) => v('income', m) - v('cogs', m) - v('opex', m) + v('oinc', m) - v('oexp', m));
  const T = { income: secs.income.total, cogs: secs.cogs.total, opex: secs.opex.total, oinc: secs.oinc.total, oexp: secs.oexp.total };
  T.gross = r2(T.income - T.cogs); T.oper = r2(T.gross - T.opex); T.net = r2(T.oper + T.oinc - T.oexp);
  return { secs, gross, oper, net, T };
}

/* ---------- line-by-line review: every entry gets a verdict and the reason it sits where it does ----------
   Precedent = how the same supplier (or, with no supplier, the same merchant or the same reference wording) was
   booked on every other entry. An entry is "justified" when it has a reference, nothing is flagged on it and its
   account agrees with precedent, or it is a system document (invoice, credit note, payroll journal) that explains itself. */
const VAGUE = /^(payment|paid|expense|expenses|misc|miscellaneous|other|others|charges?|fees?|na|n\/a|test|invoice|bill|transfer|cash|card|alaan|purchase)$/i;
const POOL = /^(alaan suppliers?|suppliers?|vendor|vendors|misc|various|cash|petty cash|other|others|general)$/i;
const SELF = new Set(['invoice', 'creditnote', 'customer_payment', 'invoice_payment', 'bill_payment', 'creditnote_refund', 'bad_debt']);
function precedentKey(l) {
  if (l.vname && !POOL.test(l.vname)) return ['supplier', l.vname.toLowerCase()];
  if (l.merch) return ['merchant', l.merch.toLowerCase()];
  const k = normRef(l.ref).split(' ').filter((w) => w.length > 2 && !/^\d+$/.test(w)).slice(0, 2).join(' ');
  return k.length >= 5 ? ['wording', k] : null;
}
function review(R, monthSet) {
  const flags = new Map();
  for (const f of R.findings) for (const i of f.items) if (i.l) { if (!flags.has(i.l.atid)) flags.set(i.l.atid, []); flags.get(i.l.atid).push({ f, note: i.note, to: i.to || null }); }
  /* precedent tables over the whole ledger, not only the chosen months */
  const P = new Map();
  for (const l of R.L) {
    if (!l.doc) continue;
    const pk = precedentKey(l); if (!pk) continue; l._pk = pk;
    const k = pk[0] + '|' + pk[1]; if (!P.has(k)) P.set(k, { n: 0, by: new Map(), amts: new Map() });
    const p = P.get(k); p.n++; p.by.set(l.a.id, (p.by.get(l.a.id) || 0) + 1);
    if (!p.amts.has(l.a.id)) p.amts.set(l.a.id, []); p.amts.get(l.a.id).push(Math.abs(l.amt));
  }
  const rows = [];
  for (const l of R.L) {
    if (monthSet && !monthSet.has(l.m)) continue;
    const a = l.a, fl = flags.get(l.atid) || [], issues = [], todo = [], basis = []; let strong = SELF.has(l.et);
    let sev = 0; /* 0 justified, 1 to check, 2 must fix */
    const push = (lv, text, act) => { issues.push(text); if (act) todo.push(act); if (lv > sev) sev = lv; };
    for (const x of fl) {
      const f = x.f; if (f.id === 'noref' || f.id === 'oneoff') continue;
      push(f.sev === 'fix' ? 2 : f.sev === 'review' ? 1 : 0, f.title + (x.note ? ': ' + x.note : ''), f.todo);
    }
    /* reference */
    if (l.doc && l.et !== 'bill') {
      if (!l.ref && !l.desc) push(1, 'No reference and no description', 'Write what the money was for in the reference of the entry.');
      else if (!l.ref) push(1, 'No reference (only a description)', 'Copy the purpose into the reference so it shows on the ledger.');
      else if (VAGUE.test(l.ref.trim()) || l.ref.trim().length < 5) push(1, 'Reference “' + l.ref + '” does not say what it was for', 'Replace it with the supplier, the service and the client or period.');
    }
    /* precedent: where the same supplier / merchant / wording goes on other entries */
    let prec = null;
    if (l._pk) {
      const p = P.get(l._pk[0] + '|' + l._pk[1]), others = p.n - 1, here = (p.by.get(a.id) || 0) - 1;
      if (others >= 2) {
        let top = null; for (const [id, c] of p.by) { const cc = id === a.id ? c - 1 : c; if (!top || cc > top[1]) top = [id, cc]; }
        const ta = R.A.get(top[0]);
        prec = { kind: l._pk[0], key: l._pk[1], others, here, top: ta, topN: top[1] };
        if (here / others >= 0.6) { strong = true; basis.push('Same ' + l._pk[0] + ' is booked to this account on ' + here + ' of ' + others + ' other entries'); }
        else if (ta && ta.id !== a.id && top[1] / others >= 0.75 && others >= 4) push(1, 'Same ' + l._pk[0] + ' is booked to “' + ta.name + '” on ' + top[1] + ' of ' + others + ' other entries, but here to “' + a.name + '”', 'Check the account; move it to “' + ta.name + '” if it is the same kind of cost.');
        else basis.push('Same ' + l._pk[0] + ' is spread over ' + p.by.size + ' accounts (' + here + ' of ' + others + ' other entries here)');
        const arr = (p.amts.get(a.id) || []).slice().sort((x, y) => x - y);
        if (arr.length >= 4 && l._pk[0] !== 'wording') { const med = median(arr), v = Math.abs(l.amt); if (med > 0 && v >= med * 3 && v - med >= 1000) push(1, 'Amount is ' + (v / med).toFixed(1) + ' times the usual ' + med.toFixed(2) + ' for this ' + l._pk[0] + ' in this account', 'Confirm the amount against the invoice or receipt.'); else if (med > 0) basis.push('amount in line with the usual ' + med.toFixed(0)); }
      } else if (l.doc) basis.push('No earlier entries for this ' + l._pk[0] + ' to compare with');
    }
    if (SELF.has(l.et)) basis.unshift((l.et === 'invoice' ? 'Sales invoice' : l.et === 'creditnote' ? 'Credit note' : 'System entry') + ' ' + (l.tno || '') + (l.cname ? ' to ' + l.cname : ''));
    if (l.cname && (a.sec === 'cogs' || a.pass)) basis.push('linked to client ' + l.cname);
    if (l.bk && l.bk.a) basis.push('receipt attached');
    if (!SELF.has(l.et) && !basis.length && !issues.length) { basis.push('Has a reference; nothing else to compare it with'); }
    /* an entry with nothing wrong but nothing to back it either stands on its reference alone */
    const status = sev === 2 ? 'fix' : sev === 1 ? 'check' : strong || (l.bk && l.bk.a) ? 'ok' : 'thin';
    if (status === 'thin') todo.push('Make sure the reference names the supplier, what was bought and the period or client, and attach the invoice.');
    rows.push({ l, a, m: l.m, amt: l.amt, sev, status, issues, todo: [...new Set(todo)], basis: basis.join('; '), prec });
  }
  const sum = { n: rows.length, ok: 0, thin: 0, check: 0, fix: 0, amt: 0, okAmt: 0, thinAmt: 0, checkAmt: 0, fixAmt: 0 };
  for (const r of rows) { const v = Math.abs(r.amt); sum[r.status]++; sum.amt += v; sum[r.status + 'Amt'] += v; }
  return { rows, sum };
}

/* ---------- month pack: one month against the month before and the three-month average, with what moved ---------- */
function monthPack(R, m) {
  const prev = addM(m, -1), base = [1, 2, 3].map((k) => addM(m, -k)).filter((x) => R.months.includes(x));
  const cur = statement(R, new Set([m])), pv = statement(R, new Set([prev]));
  const avgOf = (a) => (base.length ? r2(base.reduce((t, x) => t + (a.by.get(x) || 0), 0) / base.length) : 0);
  const lines = [], open = m >= R.curM; let pending = 0, pendingN = 0;
  for (const a of R.A.values()) {
    if (a.kids && !a.n) continue;
    const v = a.by.get(m) || 0, p = a.by.get(prev) || 0, avg = avgOf(a);
    const regular = base.filter((x) => (a.by.get(x) || 0) !== 0).length >= 2;
    if (!v && !p && !avg) continue;
    const ents = a.lines.filter((l) => l.m === m).sort((x, y) => Math.abs(y.amt) - Math.abs(x.amt));
    const d = r2(v - avg), big = Math.abs(d) >= 2000 && (avg === 0 || Math.abs(d) / Math.abs(avg) >= 0.3);
    let why = '';
    if (big) {
      if (!v) { why = open ? 'Not booked yet (the month is still open); usually about ' + avg.toFixed(0) + '.' : 'Nothing booked this month; usually about ' + avg.toFixed(0) + '. Check it was not missed or booked to another account.'; if (regular && (a.sec === 'opex' || a.sec === 'cogs' || a.sec === 'oexp') && avg > 0) { pending = r2(pending + avg); pendingN++; } }
      else if (!avg) why = 'New this period: ' + ents.slice(0, 3).map((l) => (l.ref || l.vname || l.cname || l.tno || 'entry') + ' ' + l.amt.toFixed(0)).join('; ');
      else why = (d > 0 ? 'Up' : 'Down') + ' ' + Math.abs(d).toFixed(0) + ' on the usual ' + avg.toFixed(0) + '. Largest: ' + ents.slice(0, 3).map((l) => (l.ref || l.vname || l.cname || l.tno || 'entry') + ' ' + l.amt.toFixed(0)).join('; ');
    }
    lines.push({ a, v: r2(v), prev: r2(p), avg, d, big, why, n: ents.length, missing: big && !v && regular && avg > 0 });
  }
  return { m, prev, base, open, pending, pendingN, cur: cur.T, pv: pv.T, lines };
}

/* ---------- change log from Zoho's own timestamps: what was entered or edited, and when ---------- */
function changes(R, from, to, pick) {
  const out = [];
  for (const l of R.L) {
    if (pick && !pick(l.a)) continue;
    const c = l.ct ? l.ct.slice(0, 10) : '', e = l.lm ? l.lm.slice(0, 10) : '';
    const inW = (d) => d && d >= from && d <= to;
    if (inW(c)) { const late = l.td && days(l.td, c); out.push({ l, a: l.a, when: l.ct, kind: l.m < c.slice(0, 7) ? 'backdated' : 'created', note: l.m < c.slice(0, 7) ? 'Entered ' + c + ' but dated ' + l.td + ' (' + late + ' days earlier): it changed the ' + l.m + ' figures after that month ended' : 'Entered' }); }
    if (inW(e) && e !== c && l.lm > l.ct) { const closed = l.m < e.slice(0, 7); out.push({ l, a: l.a, when: l.lm, kind: closed ? 'editclosed' : 'edited', note: (closed ? 'Edited ' + e + ' although it is dated ' + l.td + ': the ' + l.m + ' figures moved after that month ended' : 'Edited ' + e) + (l.ct ? ' (first entered ' + c + ')' : '') }); }
  }
  return out.sort((x, y) => y.when.localeCompare(x.when));
}

const api = { analyse, statement, review, monthPack, changes, CHECKS, SEC_LABEL, addM, r2, median, normRef };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PNLEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
