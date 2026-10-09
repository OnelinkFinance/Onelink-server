// Zoho stub, loaded with `node --import ./test/zoho-stub.mjs server.js`.
// Replaces globalThis.fetch for Zoho hosts only (accounts / Books / Analytics); everything else goes to the real fetch.
// Fixtures are re-read from the JSON file in env ZOHO_STUB_FIXTURE on EVERY request, so a test can change data
// between steps (remember the server caches Analytics data and Books cross-check data for 60 s).
//
// Fixture shape:
// {
//   contacts: [{ contact_id, contact_name, company_name, status, outstanding_receivable_amount }],
//   balances: [{ "Resolved Customer ID", "Resolved Customer Name", "Credits AED", "Debits AED", "Balance AED", "Balance Status", "Balance Alert" }],
//   split:    [{ Customer, Account, Credits, Debits, Lines, Untagged, 'Last debit' }],
//   invoices: [{ Customer, Invoice, Status, Due, Total, Balance }],              // Analytics open invoices
//   payments: [{ Customer, Payments, Received, Unapplied, Refunded, Last }],     // Analytics customer payments
//   settlement: [{ Customer, Invoices, Invoiced, Outstanding, 'Written off', Paid, Credited }],
//   aliases:  [{ Source, Canonical }],
//   recent:   [{ Customer, Account, 'Entity ID', 'Transaction ID', 'Entity Type', Credit, Debit, Date }],  // Analytics recent ledger lines
//   watermark: [{ Watermark }],                                                  // Analytics max "Last Modified Time"
//   books: {                                                                     // Zoho Books cross-verification (live API)
//     transactions: { '<account id>': [{ transaction_id, categorized_transaction_id, transaction_type, transaction_date,
//                     customer_id, payee, debit_amount, credit_amount, reference_number, description }] },
//     creditnotes: [{ creditnote_id, creditnote_number, customer_id, status, total, balance, date }],
//     invoices: [{ invoice_id, invoice_number, customer_id, type, status, total, balance }],
//     customerpayments: [{ payment_id, payment_number, customer_id, amount, unused_amount, date }],
//     journals: [{ journal_id, entry_number, journal_date, status, total }],
//     journalDetails: { '<journal id>': { journal_id, status, line_items: [{ customer_id, debit_or_credit, amount }] } }
//   },
//   fail:  { <kind>: <status> }   // force an HTTP error for one kind (always)
//   flaky: { <kind>: <n> }        // the first n requests of that kind answer 503, then normally (per server process)
//   delay: { <kind>: <ms> }       // answer that kind after a pause
// }
// Kinds: books (every Books call), contacts, booksProbe (contacts?per_page=1 without search), transactions,
// creditnotes, booksInvoices, customerpayments, journals, journal (detail), analytics (every Analytics call),
// workspace (the Analytics connection probe), and the SQL kinds balances, split, invoices, payments, settlement,
// aliases, recent, watermark.
// Every request is appended (one JSON line, with its kind) to env ZOHO_STUB_LOG when set.
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const HEAD = {
  balances: ['Resolved Customer ID', 'Resolved Customer Name', 'Credits AED', 'Debits AED', 'Balance AED', 'Balance Status', 'Balance Alert'],
  split: ['Customer', 'Account', 'Credits', 'Debits', 'Lines', 'Untagged', 'Last debit'],
  invoices: ['Customer', 'Invoice', 'Status', 'Due', 'Total', 'Balance'],
  payments: ['Customer', 'Payments', 'Received', 'Unapplied', 'Refunded', 'Last'],
  settlement: ['Customer', 'Invoices', 'Invoiced', 'Outstanding', 'Written off', 'Paid', 'Credited'],
  aliases: ['Source', 'Canonical'],
  recent: ['Customer', 'Account', 'Entity ID', 'Transaction ID', 'Entity Type', 'Credit', 'Debit', 'Date'],
  watermark: ['Watermark']
};
const fixture = () => {
  const f = process.env.ZOHO_STUB_FIXTURE;
  if (!f) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error('zoho-stub: fixture unreadable', e.message); return {}; }
};
const log = entry => { if (process.env.ZOHO_STUB_LOG) try { fs.appendFileSync(process.env.ZOHO_STUB_LOG, JSON.stringify(entry) + '\n'); } catch {} };
const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (head, rows) => [head.map(cell).join(',')].concat((rows || []).map(r => head.map(h => cell(r[h])).join(','))).join('\r\n') + '\r\n';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/csv' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const jobs = new Map(); // jobId -> kind
const seen = new Map(); // kind -> requests so far (for flaky)
let seq = 1;
function kindOf(sql) {
  if (sql.includes('AS "Source"')) return 'aliases';                 // the alias table on its own
  if (sql.includes('"Invoice Payments"')) return 'settlement';       // invoice settlement (before the plain invoice list)
  if (sql.includes('CFD Customer Balances')) return 'balances';
  if (sql.includes('AS "Watermark"')) return 'watermark';            // before the other "CFD Customer Resolved" queries
  if (sql.includes('AS "Entity ID"')) return 'recent';
  if (sql.includes('CFD Customer Resolved')) return 'split';
  if (sql.includes('"Invoices"')) return 'invoices';
  if (sql.includes('"Customer Payments"')) return 'payments';
  return null;
}
// An error to force for this request: fail.<kind> (always) or flaky.<kind> (the first n requests).
function forced(fx, kinds) {
  for (const k of kinds) {
    if (fx.fail && fx.fail[k]) return fx.fail[k];
    if (fx.flaky && fx.flaky[k]) { const n = (seen.get(k) || 0) + 1; seen.set(k, n); if (n <= fx.flaky[k]) return 503; }
  }
  return 0;
}
const page = (url, rows, field, extra = {}) => {
  const per = Number(url.searchParams.get('per_page') || 200), p = Number(url.searchParams.get('page') || 1);
  const slice = rows.slice((p - 1) * per, p * per);
  return json({ code: 0, message: 'success', [field]: slice, page_context: { page: p, per_page: per, has_more_page: rows.length > p * per }, ...extra });
};

async function books(url, fx, method) {
  const B = fx.books || {}, p = url.pathname.replace(/^\/books\/v3\//, ''), cid = url.searchParams.get('customer_id');
  const byCustomer = list => (list || []).filter(x => !cid || String(x.customer_id) === cid);
  let kind, answer;
  if (p === 'contacts' || p.startsWith('contacts/')) {
    const probe = p === 'contacts' && url.searchParams.get('per_page') === '1' && !url.searchParams.get('search_text');
    kind = probe ? 'booksProbe' : 'contacts';
    answer = () => {
      const contacts = fx.contacts || [];
      const m = /^contacts\/([^/]+)$/.exec(p);
      if (m) { const c = contacts.find(x => String(x.contact_id) === m[1]); return c ? json({ code: 0, contact: c }) : json({ code: 1002, message: 'Contact does not exist.' }, 404); }
      const q = (url.searchParams.get('search_text') || '').toLowerCase();
      const list = contacts.filter(c => !q || String(c.contact_name || '').toLowerCase().includes(q) || String(c.company_name || '').toLowerCase().includes(q));
      return probe ? json({ code: 0, contacts: list.slice(0, 1) }) : json({ code: 0, contacts: list });
    };
  } else if (p === 'chartofaccounts/transactions') {
    kind = 'transactions';
    answer = () => {
      const start = url.searchParams.get('date.start') || '';
      const rows = ((B.transactions || {})[url.searchParams.get('account_id')] || []).filter(t => !start || String(t.transaction_date || '9999') >= start);
      return page(url, rows, 'transactions');
    };
  } else if (p === 'creditnotes') { kind = 'creditnotes'; answer = () => page(url, byCustomer(B.creditnotes), 'creditnotes'); }
  else if (p === 'invoices') { kind = 'booksInvoices'; answer = () => page(url, byCustomer(B.invoices), 'invoices'); }
  else if (p === 'customerpayments') { kind = 'customerpayments'; answer = () => page(url, byCustomer(B.customerpayments), 'customerpayments'); }
  else if (p === 'journals') {
    kind = 'journals';
    answer = () => { const start = url.searchParams.get('date.start') || ''; return page(url, (B.journals || []).filter(j => !start || String(j.journal_date || '9999') >= start), 'journals'); };
  } else if (/^journals\/[^/]+$/.test(p)) {
    kind = 'journal';
    answer = () => { const d = (B.journalDetails || {})[p.split('/')[1]]; return d ? json({ code: 0, journal: d }) : json({ code: 1002, message: 'Journal does not exist.' }, 404); };
  } else return { kind: 'unknown', res: json({ code: 5, message: 'zoho-stub: unhandled Books path ' + p }, 404) };
  if (fx.delay && fx.delay[kind]) await sleep(fx.delay[kind]);
  const err = forced(fx, ['books', kind]);
  return { kind, res: err ? json({ code: 1, message: 'stub failure: ' + kind }, err) : answer() };
}

globalThis.fetch = async function stubFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const host = url.hostname;
  if (!/(^|\.)zoho(apis)?\.(com|eu|in|com\.au|jp|sa|ca)$/.test(host)) return realFetch(input, init);
  const fx = fixture();
  const entry = { method, host, path: url.pathname, query: Object.fromEntries(url.searchParams) };

  // OAuth
  if (host.startsWith('accounts.zoho.') && url.pathname === '/oauth/v2/token' && method === 'POST') {
    log(entry);
    if (fx.fail && fx.fail.oauth) return json({ error: 'invalid_code' }, 200);
    return json({ access_token: 'stub-access-' + Date.now(), expires_in: 3600, token_type: 'Bearer' });
  }

  // Books
  if (host.startsWith('www.zohoapis.') && url.pathname.startsWith('/books/v3/')) {
    const { kind, res } = await books(url, fx, method);
    log({ ...entry, kind, status: res.status });
    return res;
  }

  // Analytics: the workspace (connection probe) and the bulk SQL export
  if (host.startsWith('analyticsapi.zoho.')) {
    if (/^\/restapi\/v2\/workspaces\/[^/]+$/.test(url.pathname)) {
      if (fx.delay && fx.delay.workspace) await sleep(fx.delay.workspace);
      const err = forced(fx, ['analytics', 'workspace']);
      log({ ...entry, kind: 'workspace', status: err || 200 });
      return err ? json({ status: 'failure', summary: 'stub failure: workspace' }, err) : json({ status: 'success', data: { workspaces: { workspaceId: url.pathname.split('/').pop(), workspaceName: 'Elite Onelink' } } });
    }
    const base = /^\/restapi\/v2\/bulk\/workspaces\/[^/]+/.exec(url.pathname);
    if (!base) { log(entry); return json({ status: 'failure', summary: 'unknown path' }, 404); }
    const rest = url.pathname.slice(base[0].length);
    if (rest === '/data') {
      const cfg = JSON.parse(url.searchParams.get('CONFIG') || '{}');
      const kind = kindOf(String(cfg.sqlQuery || ''));
      if (fx.delay && kind && fx.delay[kind]) await sleep(fx.delay[kind]);
      const err = forced(fx, ['analytics', kind]);
      log({ ...entry, kind, status: err || (kind ? 200 : 400) });
      if (err) return json({ status: 'failure', summary: 'stub failure: ' + kind }, err); // e.g. fail: { settlement: 503 }
      if (!kind) return json({ status: 'failure', summary: 'unknown table' }, 400);
      const jobId = String(1000000 + seq++);
      jobs.set(jobId, kind);
      return json({ status: 'success', data: { jobId } });
    }
    log(entry);
    if (fx.fail && fx.fail.analytics) return json({ status: 'failure' }, fx.fail.analytics);
    const j = /^\/exportjobs\/(\d+)(\/data)?$/.exec(rest);
    if (j) {
      const kind = jobs.get(j[1]);
      if (!kind) return json({ status: 'failure' }, 404);
      if (!j[2]) return json({ status: 'success', data: { jobId: j[1], jobCode: '1004', jobStatus: 'JOB COMPLETED' } });
      return text(csv(HEAD[kind], fx[kind]));
    }
    return json({ status: 'failure' }, 404);
  }
  log(entry);
  return json({ error: 'zoho-stub: unhandled ' + method + ' ' + url.href }, 404);
};
