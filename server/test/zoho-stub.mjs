// Zoho stub, loaded with `node --import ./test/zoho-stub.mjs server.js`.
// Replaces globalThis.fetch for Zoho hosts only (accounts / Books / Analytics); everything else goes to the real fetch.
// Fixtures are re-read from the JSON file in env ZOHO_STUB_FIXTURE on EVERY request, so a test can change data
// between steps (remember the server caches Analytics data for 60 s).
//
// Fixture shape:
// {
//   contacts: [{ contact_id, contact_name, company_name, status, outstanding_receivable_amount }],
//   balances: [{ "Resolved Customer ID", "Resolved Customer Name", "Credits AED", "Debits AED", "Balance AED", "Balance Status", "Balance Alert" }],
//   split:    [{ Customer, Account, Credits, Debits, Lines, Untagged, 'Last debit' }],
//   invoices: [{ Customer, Invoice, Status, Due, Total, Balance }],
//   payments: [{ Customer, Payments, Received, Unapplied, Refunded, Last }],
//   fail:     { books?: <status>, analytics?: <status> }   // optional: force an HTTP error
// }
// Every request is appended (one JSON line) to env ZOHO_STUB_LOG when set.
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const HEAD = {
  balances: ['Resolved Customer ID', 'Resolved Customer Name', 'Credits AED', 'Debits AED', 'Balance AED', 'Balance Status', 'Balance Alert'],
  split: ['Customer', 'Account', 'Credits', 'Debits', 'Lines', 'Untagged', 'Last debit'],
  invoices: ['Customer', 'Invoice', 'Status', 'Due', 'Total', 'Balance'],
  payments: ['Customer', 'Payments', 'Received', 'Unapplied', 'Refunded', 'Last']
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

const jobs = new Map(); // jobId -> kind
let seq = 1;
function kindOf(sql) {
  if (sql.includes('CFD Customer Balances')) return 'balances';
  if (sql.includes('CFD Customer Resolved')) return 'split';
  if (sql.includes('"Invoices"')) return 'invoices';
  if (sql.includes('"Customer Payments"')) return 'payments';
  return null;
}

globalThis.fetch = async function stubFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const host = url.hostname;
  if (!/(^|\.)zoho(apis)?\.(com|eu|in|com\.au|jp|sa|ca)$/.test(host)) return realFetch(input, init);
  const fx = fixture();
  log({ method, host, path: url.pathname, query: Object.fromEntries(url.searchParams) });

  // OAuth
  if (host.startsWith('accounts.zoho.') && url.pathname === '/oauth/v2/token' && method === 'POST')
    return json({ access_token: 'stub-access-' + Date.now(), expires_in: 3600, token_type: 'Bearer' });

  // Books
  if (host.startsWith('www.zohoapis.') && url.pathname.startsWith('/books/v3/contacts')) {
    if (fx.fail && fx.fail.books) return json({ code: 1, message: 'stub failure' }, fx.fail.books);
    const contacts = fx.contacts || [];
    const m = /^\/books\/v3\/contacts\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const c = contacts.find(x => String(x.contact_id) === m[1]);
      return c ? json({ code: 0, contact: c }) : json({ code: 1002, message: 'Contact does not exist.' }, 404);
    }
    const q = (url.searchParams.get('search_text') || '').toLowerCase();
    const list = contacts.filter(c => !q || String(c.contact_name || '').toLowerCase().includes(q) || String(c.company_name || '').toLowerCase().includes(q));
    return json({ code: 0, contacts: list });
  }

  // Analytics bulk SQL export
  if (host.startsWith('analyticsapi.zoho.')) {
    if (fx.fail && fx.fail.analytics) return json({ status: 'failure' }, fx.fail.analytics);
    const base = /^\/restapi\/v2\/bulk\/workspaces\/[^/]+/.exec(url.pathname);
    if (!base) return json({ status: 'failure', summary: 'unknown path' }, 404);
    const rest = url.pathname.slice(base[0].length);
    if (rest === '/data') {
      const cfg = JSON.parse(url.searchParams.get('CONFIG') || '{}');
      const kind = kindOf(String(cfg.sqlQuery || ''));
      if (!kind) return json({ status: 'failure', summary: 'unknown table' }, 400);
      const jobId = String(1000000 + seq++);
      jobs.set(jobId, kind);
      return json({ status: 'success', data: { jobId } });
    }
    const j = /^\/exportjobs\/(\d+)(\/data)?$/.exec(rest);
    if (j) {
      const kind = jobs.get(j[1]);
      if (!kind) return json({ status: 'failure' }, 404);
      if (!j[2]) return json({ status: 'success', data: { jobId: j[1], jobCode: '1004', jobStatus: 'JOB COMPLETED' } });
      return text(csv(HEAD[kind], fx[kind]));
    }
    return json({ status: 'failure' }, 404);
  }
  return json({ error: 'zoho-stub: unhandled ' + method + ' ' + url.href }, 404);
};
