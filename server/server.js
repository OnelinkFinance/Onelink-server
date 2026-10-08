import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import crypto from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { patchPage } from './client-workflow.js';
import { evaluateFinance, financeForOps } from './finance-rules.js';

// ---- cloud.js ----
const M_cloud = await (async () => {

// Free-tier persistence: mirrors data/*.json to Upstash Redis (free plan) so nothing is lost
// when a free host (Render free) restarts or sleeps. Optional — without the two env vars it does nothing.

const URL_ = process.env.UPSTASH_REDIS_REST_URL, TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
const enabled = !!(URL_ && TOK);
const files = {
  users: path.resolve(process.env.USERS_FILE || './data/users.json'),
  platform: path.resolve(process.env.DATA_FILE || './data/platform.json')
};
files.loginhistory = path.join(path.dirname(files.users), 'login-history.json'); // survives restarts like users/platform
async function cmd(args) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error('Upstash ' + r.status);
  return (await r.json()).result;
}
// Restore on boot, before auth/store read their files.
if (enabled) {
  for (const [k, f] of Object.entries(files)) {
    if (fs.existsSync(f)) continue;
    try {
      const v = await cmd(['GET', 'onelink:' + k]);
      if (v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); console.log('Restored', k, 'from Upstash'); }
    } catch (e) { console.error('Upstash restore failed:', k, e.message); }
  }
} else console.warn('UPSTASH_REDIS_REST_URL/TOKEN not set — data lives only on local disk.');

const kvGet = k => enabled ? cmd(['GET', k]) : Promise.resolve(null);
const kvSet = (k, v) => enabled ? cmd(['SET', k, v]) : Promise.resolve(null);
const kvDel = k => enabled ? cmd(['DEL', k]) : Promise.resolve(null);

const timers = {};
function push(k, json) {
  if (!enabled) return;
  clearTimeout(timers[k]);
  timers[k] = setTimeout(() => cmd(['SET', 'onelink:' + k, json]).catch(e => console.error('Upstash backup failed:', k, e.message)), 400);
}

return { enabled, kvGet, kvSet, kvDel, push };
})();

// ---- zoho.js ----
const M_zoho = await (async () => {
const { kvGet, kvSet } = M_cloud;
// Zoho OAuth refresh + Books client search/lookup + Analytics balance row.
// Client identity is the Zoho Books contact_id picked from the live list — never a typed name.
const E = process.env;
const dc = () => E.ZOHO_DC || 'com';
let token = null, tokenExp = 0, rt = E.ZOHO_REFRESH_TOKEN || null;

// One-time bootstrap: exchange a 10-minute Self Client code (ZOHO_GRANT_CODE) for a permanent
// refresh token, kept in Upstash so it survives restarts. Never logged.
const zohoReady = (async () => {
  if (rt) return 'env';
  try { rt = await kvGet('onelink:zoho_rt'); } catch {}
  if (rt) return 'stored';
  if (!E.ZOHO_GRANT_CODE || !E.ZOHO_CLIENT_ID || !E.ZOHO_CLIENT_SECRET) return 'none';
  const q = new URLSearchParams({ code: E.ZOHO_GRANT_CODE, client_id: E.ZOHO_CLIENT_ID, client_secret: E.ZOHO_CLIENT_SECRET, grant_type: 'authorization_code' });
  try {
    const j = await (await fetch(`https://accounts.zoho.${dc()}/oauth/v2/token?${q}`, { method: 'POST' })).json();
    if (j.refresh_token) { rt = j.refresh_token; await kvSet('onelink:zoho_rt', rt).catch(() => {}); console.log('Zoho: grant code exchanged, refresh token stored.'); return 'exchanged'; }
    console.error('Zoho: grant code exchange failed —', j.error || 'no refresh_token (code expired or already used?)');
  } catch (e) { console.error('Zoho: grant code exchange error —', e.message); }
  return 'failed';
})();

async function accessToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  await zohoReady;
  const need = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'].filter(k => !E[k]);
  if (!rt) need.push('ZOHO_REFRESH_TOKEN (or a fresh ZOHO_GRANT_CODE)');
  if (need.length) throw Object.assign(new Error('Missing env: ' + need.join(', ')), { code: 'ENV' });
  const q = new URLSearchParams({ refresh_token: rt, client_id: E.ZOHO_CLIENT_ID, client_secret: E.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' });
  const res = await fetch(`https://accounts.zoho.${dc()}/oauth/v2/token?${q}`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  if (!j.access_token) throw Object.assign(new Error('Zoho OAuth refresh failed: ' + (j.error || res.status)), { code: 'AUTH' });
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// Strict equality — no trimming, no case folding, no fuzzy matching, no guessing.
const exact = (list, name, ...getters) => list.find(x => getters.some(g => g(x) === name)) || null;

// Loose normaliser — used ONLY for the relevance check and search ranking, never for identity.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Live sources. Clients come ONLY from ELITE ONELINK CORPORATE SERVICES L.L.C S.O.C (Zoho Books org 898300452).
// The same Zoho login also sees Onelink Rentals LLC-FZ (886143418) — never used here. The org is fixed in code:
// a ZOHO_BOOKS_ORG_ID pointing anywhere else is ignored. Analytics: the "Elite Onelink" workspace, whose
// CFD Customer Balances table is keyed by the Elite Books contact_id.
const ELITE_BOOKS_ORG = '898300452';
if (E.ZOHO_BOOKS_ORG_ID && E.ZOHO_BOOKS_ORG_ID !== ELITE_BOOKS_ORG)
  console.warn(`ZOHO_BOOKS_ORG_ID=${E.ZOHO_BOOKS_ORG_ID} ignored — clients are read only from Elite OneLink (${ELITE_BOOKS_ORG}).`);
const booksOrg = () => ELITE_BOOKS_ORG;
const zaOrg = () => E.ZOHO_ORG_ID || '926340534';
const zaWs = () => E.ZOHO_WORKSPACE_ID || '3241925000000011002';
const zaTable = () => E.ZA_BALANCE_TABLE || 'CFD Customer Balances';

async function books(p, params) {
  const t = await accessToken();
  const q = new URLSearchParams({ organization_id: booksOrg(), ...params });
  const res = await fetch(`https://www.zohoapis.${dc()}/books/v3/${p}?${q}`, { headers: { Authorization: 'Zoho-oauthtoken ' + t }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (res.status === 429) throw Object.assign(new Error('Zoho Books rate limit'), { code: 'RATE' });
  if (!res.ok) throw Object.assign(new Error('Zoho Books ' + res.status), { code: 'BOOKS' });
  return res.json();
}
const contactOut = c => ({ contactId: String(c.contact_id), contactName: c.contact_name, companyName: c.company_name || '', status: c.status, outstanding: num(c.outstanding_receivable_amount) });

// Type-ahead: active Books customers whose client or company name contains the typed letters.
// Books ignores contact_name_contains / company_name_contains (it then returns every contact A–Z), so the
// search uses search_text — a real "contains" over name, company, email and notes — and the result is
// filtered here to name/company matches only. A filter Zoho ignores can never fill the list with everyone.
const searchCache = new Map(); // term -> { at, list }
async function booksSearchClients(term) {
  const key = term.toLowerCase(), hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  if (!norm(term)) return [];
  const j = await books('contacts', { search_text: term, contact_type: 'customer', filter_by: 'Status.Active', per_page: '200', sort_column: 'contact_name' });
  const n = norm(term), has = c => [c.contact_name, c.company_name, ((c.first_name || '') + ' ' + (c.last_name || ''))].some(v => norm(v).includes(n));
  const starts = c => norm(c.contactName).startsWith(n) || norm(c.companyName).startsWith(n) ? 0 : 1;
  const list = (j?.contacts || []).filter(has).map(contactOut)
    .sort((a, b) => starts(a) - starts(b) || a.contactName.localeCompare(b.contactName)).slice(0, 20);
  searchCache.set(key, { at: Date.now(), list });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
  return list;
}

// The selected client, re-read from Books by its id — the browser never supplies the name.
async function booksGetContact(contactId) {
  if (!/^\d{1,30}$/.test(String(contactId || ''))) return null;
  const j = await books('contacts/' + contactId, {});
  return j && j.contact ? contactOut(j.contact) : null;
}

// Requests created before the dropdown only carry a name: exact match on contact or company name.
async function booksFindContactExact(name) {
  const j = await books('contacts', { search_text: name, per_page: '200' });
  const hit = exact(j?.contacts || [], name, c => c.contact_name, c => c.company_name);
  return hit ? contactOut(hit) : null;
}

// Columns of the balance table. Own env names (ZA_BALANCE_*), so settings left over from the
// earlier per-view lookup (ZA_COL_*) cannot point the live check at the wrong columns.
function col() {
  return {
    id: E.ZA_BALANCE_ID_COL || 'Resolved Customer ID', client: E.ZA_BALANCE_NAME_COL || 'Resolved Customer Name', company: E.ZA_BALANCE_COMPANY_COL || '',
    allocated: E.ZA_BALANCE_CREDITS_COL || 'Credits AED', used: E.ZA_BALANCE_DEBITS_COL || 'Debits AED',
    available: E.ZA_BALANCE_COL || 'Balance AED', categories: E.ZA_BALANCE_CATEGORIES_COL || ''
  };
}
// Analytics exports currency columns in compact form ('AED 35.06K'): honour the K/M/B suffix.
const num = v => { const t = String(v ?? '').trim(), m = /([KMB])$/i.exec(t); const x = Number(t.replace(/[^0-9.-]/g, '')) || 0; return m ? x * { K: 1e3, M: 1e6, B: 1e9 }[m[1].toUpperCase()] : x; };
function toRecord(r) {
  const C = col();
  return {
    clientId: r[C.id] || null, clientName: r[C.client] || '', companyName: C.company ? r[C.company] || '' : '',
    allocated: num(r[C.allocated]), used: num(r[C.used]),
    available: r[C.available] !== undefined && r[C.available] !== '' ? num(r[C.available]) : num(r[C.allocated]) - num(r[C.used]),
    categories: C.categories ? String(r[C.categories] || '').split(',').map(s => s.trim()).filter(Boolean) : [],
    status: r['Balance Status'] || '', alert: r['Balance Alert'] || ''
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.length > 1 || r[0]);
  return body.map(r => Object.fromEntries((head || []).map((h, i) => [h, r[i]])));
}

// Zoho Analytics balances. The balance table is a query table (the synchronous view export does not serve
// it), so it is read with a SQL export job — about 3 s. It holds one row per client (~300), so the whole table
// is read in one job and kept for BALANCE_TTL: a lookup is then instant, and no check uses a balance older
// than that. Typing in the client field pre-loads it, so it is normally ready by the time a client is picked.
const BALANCE_TTL = 60_000, JOB_DEADLINE = 25_000;
const zaErr = (msg, code = 'ANALYTICS') => Object.assign(new Error(msg), { code });

async function analyticsSql(sql, what = 'balance') {
  const t = await accessToken();
  const h = { headers: { Authorization: 'Zoho-oauthtoken ' + t, 'ZANALYTICS-ORGID': zaOrg() }, signal: AbortSignal.timeout(15_000) };
  const base = `https://analyticsapi.zoho.${dc()}/restapi/v2/bulk/workspaces/${zaWs()}`;
  const check = async (res, what) => {
    if (res.ok) return res;
    if (res.status === 429) throw zaErr('Zoho Analytics rate limit', 'RATE');
    throw zaErr(`Zoho Analytics ${what} ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
  const t0 = Date.now();
  const r1 = await check(await fetch(`${base}/data?CONFIG=${encodeURIComponent(JSON.stringify({ sqlQuery: sql, responseFormat: 'csv' }))}`, h), 'export');
  const jobId = (await r1.json())?.data?.jobId;
  if (!jobId) throw zaErr('Zoho Analytics returned no export job');
  for (let wait = 300; Date.now() - t0 < JOB_DEADLINE; wait = Math.min(wait * 1.4, 1000)) {
    await new Promise(r => setTimeout(r, wait));
    const r2 = await check(await fetch(`${base}/exportjobs/${jobId}`, h), 'job');
    const code = String((await r2.json())?.data?.jobCode || '');
    if (code === '1003' || code === '1005') throw zaErr('Zoho Analytics export job failed (' + code + ')');
    if (code !== '1004') continue;
    const r3 = await check(await fetch(`${base}/exportjobs/${jobId}/data`, h), 'download');
    const rows = parseCsv(await r3.text());
    console.log(`Zoho Analytics: ${rows.length} ${what} rows in ${Date.now() - t0} ms`);
    return rows;
  }
  throw zaErr(`Zoho Analytics export did not finish within ${JOB_DEADLINE / 1000} s`);
}

let balances = null, balancesAt = 0, balancesLoading = null;
function refreshBalances() {
  if (!balancesLoading) {
    const C = col();
    balancesLoading = analyticsSql(`select * from "${zaTable().replace(/"/g, '')}"`)
      .then(rows => {
        balances = new Map(rows.map(r => [String(r[C.id]).replace(/\.0+$/, ''), toRecord(r)]));
        balancesAt = Date.now();
        return balances;
      })
      .finally(() => { balancesLoading = null; });
  }
  return balancesLoading;
}
// Fire-and-forget pre-load (called while the user is typing a client name).
function prefetchBalances() { if (Date.now() - balancesAt > BALANCE_TTL) refreshBalances().catch(e => console.error('Zoho Analytics pre-load failed:', e.message)); }
const balancesFresh = () => !!balances && Date.now() - balancesAt <= BALANCE_TTL;
const invalidateBalances = () => { balancesAt = 0; };

// Balance row for one Books contact, never older than BALANCE_TTL. null = no balance record in Analytics.
async function analyticsBalance(contactId) {
  if (!/^\d{1,30}$/.test(String(contactId || ''))) return null;
  if (!balancesFresh()) await refreshBalances();
  return balances.get(String(contactId)) || null;
}

return { zohoReady, accessToken, exact, norm, num, analyticsSql, booksSearchClients, booksGetContact, booksFindContactExact, analyticsBalance, prefetchBalances, balancesFresh, invalidateBalances, col, toRecord, config: () => ({ booksOrg: booksOrg() + ' (ELITE ONELINK CORPORATE SERVICES L.L.C S.O.C)', analyticsOrg: zaOrg(), workspace: zaWs(), table: zaTable() }) };
})();

// ---- finance.js ----
const M_finance = await (async () => {
const { analyticsSql, analyticsBalance, booksGetContact, num, invalidateBalances } = M_zoho;
// Data for the three financial checks (decided in finance-rules.js). Elite OneLink's Zoho Analytics workspace holds the
// Books ledger: the Customer Fund Disbursement account (7050654000000685179) and Cost of Goods Sold (7050654000000034003),
// invoices and customer payments. Like the balance table, each source is one SQL export over every client, kept for
// FIN_TTL, so a check is a lookup. Duplicate Books contacts are folded onto their canonical contact with the same
// "CFD Automatic Customer Aliases" table the CFD Customer Balances table uses. The live Books contact (outstanding
// receivable) is read on every check, so a payment recorded or deleted in Books shows straight away.
const CFD_ACCOUNT = process.env.ZOHO_CFD_ACCOUNT_ID || '7050654000000685179';
const COGS_ACCOUNT = process.env.ZOHO_COGS_ACCOUNT_ID || '7050654000000034003';
const FIN_TTL = 60_000;
const CUST = c => `CASE WHEN A."Canonical Customer ID" IS NOT NULL THEN TO_STRING(A."Canonical Customer ID") ELSE TO_STRING(${c}) END`;
const ALIAS = c => `LEFT JOIN "CFD Automatic Customer Aliases" A ON ${c} = A."Source Customer ID"`;
const SQL = {
  split: `SELECT ${CUST('R."Resolved Customer ID"')} AS "Customer", TO_STRING(R."Account ID") AS "Account", ROUND(SUM(COALESCE(R."Credit Amount", 0)), 2) AS "Credits", ROUND(SUM(COALESCE(R."Debit Amount", 0)), 2) AS "Debits", COUNT(*) AS "Lines", SUM(CASE WHEN R."Books Customer Tag Status" = 'Customer Tagged' THEN 0 ELSE 1 END) AS "Untagged" FROM "CFD Customer Resolved" R ${ALIAS('R."Resolved Customer ID"')} WHERE R."Resolved Customer ID" IS NOT NULL GROUP BY ${CUST('R."Resolved Customer ID"')}, TO_STRING(R."Account ID")`,
  open: `SELECT ${CUST('I."Customer ID"')} AS "Customer", I."Invoice Number" AS "Invoice", I."Invoice Status" AS "Status", I."Due Date" AS "Due", ROUND(I."Total (BCY)", 2) AS "Total", ROUND(I."Balance (BCY)", 2) AS "Balance" FROM "Invoices" I ${ALIAS('I."Customer ID"')} WHERE I."Invoice Status" NOT IN ('Draft', 'Void') AND I."Balance (BCY)" > 0`,
  pay: `SELECT ${CUST('C."Customer ID"')} AS "Customer", COUNT(*) AS "Payments", ROUND(SUM(C."Amount (BCY)"), 2) AS "Received", ROUND(SUM(C."Unused Amount (BCY)"), 2) AS "Unapplied", ROUND(SUM(C."Refund Amount (BCY)"), 2) AS "Refunded", MAX(C."Payment Date") AS "Last" FROM "Customer Payments" C ${ALIAS('C."Customer ID"')} GROUP BY ${CUST('C."Customer ID"')}`,
  alias: `SELECT TO_STRING(A."Source Customer ID") AS "Source", TO_STRING(A."Canonical Customer ID") AS "Canonical" FROM "CFD Automatic Customer Aliases" A`
};
const key = v => String(v ?? '').trim().replace(/\.0+$/, '');
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${m[3]} ${MO[Number(m[2]) - 1]} ${m[1]}` : String(v || ''); };

let data = null, dataAt = 0, loading = null;
// Duplicate Books contacts are folded onto one canonical contact in every Analytics table (CFD Customer Balances
// included). The picked contact may be the duplicate, so every lookup goes through this map. Changes rarely: 10 min.
let aliases = new Map(), aliasesAt = 0;
const ALIAS_TTL = 10 * 60_000;
const canonical = id => aliases.get(key(id)) || key(id);
function refresh() {
  if (!loading) {
    // Analytics allows five export jobs at a time: these three plus the balance table, then the alias table on its own.
    loading = Promise.all([analyticsSql(SQL.split, 'CFD/COGS split'), analyticsSql(SQL.open, 'open invoice'), analyticsSql(SQL.pay, 'customer payment')])
      .then(async res => {
        if (Date.now() - aliasesAt > ALIAS_TTL) {
          try { aliases = new Map((await analyticsSql(SQL.alias, 'customer alias')).map(r => [key(r.Source), key(r.Canonical)]).filter(([a, b]) => a && b && a !== b)); aliasesAt = Date.now(); }
          catch (e) { console.error('Zoho Analytics customer aliases not refreshed:', e.message); }
        }
        return res;
      })
      .then(([split, open, pay]) => {
        const S = new Map(), O = new Map(), P = new Map();
        for (const r of split) {
          const k = key(r.Customer), acc = key(r.Account), side = acc === CFD_ACCOUNT ? 'cfd' : acc === COGS_ACCOUNT ? 'cogs' : null;
          if (!k || !side) continue;
          const e = S.get(k) || { cfd: { credits: 0, debits: 0, lines: 0, untagged: 0 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } };
          const t = e[side]; t.credits += num(r.Credits); t.debits += num(r.Debits); t.lines += num(r.Lines); t.untagged += num(r.Untagged);
          S.set(k, e);
        }
        for (const r of open) { const k = key(r.Customer); if (!k) continue; (O.get(k) || O.set(k, []).get(k)).push({ invoice: r.Invoice || '', status: r.Status || '', due: r.Due || '', total: num(r.Total), balance: num(r.Balance) }); }
        for (const r of pay) {
          const k = key(r.Customer); if (!k) continue;
          const e = P.get(k) || { payments: 0, received: 0, unapplied: 0, refunded: 0, last: '' };
          e.payments += num(r.Payments); e.received += num(r.Received); e.unapplied += num(r.Unapplied); e.refunded += num(r.Refunded);
          if (day(r.Last) && (!e.last || String(r.Last) > e._raw)) { e.last = day(r.Last); e._raw = String(r.Last); }
          P.set(k, e);
        }
        data = { split: S, open: O, pay: P }; dataAt = Date.now();
        return data;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}
const fresh = () => !!data && Date.now() - dataAt <= FIN_TTL;
function prefetch() { if (!fresh()) refresh().catch(e => console.error('Zoho Analytics finance pre-load failed:', e.message)); }
const invalidate = () => { dataAt = 0; invalidateBalances(); };

const dubai = d => d.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', ' ·');
// All three checks for one Books contact. books: the live contact if the caller already read it.
// committed: amounts already approved or credited for this client on the platform, not yet booked in the ledger.
async function run({ contactId, amount, paid, books, committed }) {
  const raw = key(contactId);
  if (!/^\d{1,30}$/.test(raw)) throw Object.assign(new Error('Zoho Books contact id required'), { code: 'BOOKS' });
  const [contact, d] = await Promise.all([books ? Promise.resolve(books) : booksGetContact(raw), fresh() ? Promise.resolve(data) : refresh()]);
  const k = canonical(raw), rec = await analyticsBalance(k);
  const { _raw, ...pay } = d.pay.get(k) || { payments: 0, received: 0, unapplied: 0, refunded: 0, last: '' };
  const f = evaluateFinance({ amount, paid, books: contact, rec, split: d.split.get(k) || null, open: d.open.get(k) || [], pay, committed });
  const t = new Date();
  return { id: 'FV-' + crypto.randomBytes(4).toString('hex').toUpperCase(), at: t.toISOString(), atText: dubai(t), clientId: k,
    source: 'Zoho Books (live contact) + Zoho Analytics (CFD, COGS, invoices, payments)', ...f };
}
// What a request stores: the checks, never the headline strings.
const record = f => f && ({ id: f.id, at: f.at, atText: f.atText, amount: f.amount, ok: f.ok, source: f.source, checks: f.checks });

return { run, record, prefetch, invalidate, forOps: financeForOps, fresh, canonical };
})();

// ---- rules.js ----
const M_rules = await (async () => {
const { norm } = M_zoho;
// The approval rules, in one pure function so they can be unit-tested.
// Live data only: the Books contact and the Analytics balance row are passed in by the caller.

const STATUS = {
  PROVISIONAL: 'Pending Sven Approval',
  FLAGGED: 'Flagged – Sven review',
  NOT: 'Not Approved'
};
const MSG = {
  NOT_FOUND: 'Client not found in Zoho Books. Cannot proceed.',
  INSUFFICIENT: 'Client does not have sufficient balance in Zoho Analytics. Flagging Sven for review.',
  PASSED: 'Pending Sven Approval.',
  // Operations never see balances, so their message carries no amount.
  OPS_INSUFFICIENT: 'Client does not have sufficient balance to request funds. Please contact Sven.',
  LOCKED: 'A request for this client is already pending approval by Sven. No new requests can be submitted until the current one is approved.',
  MANDATORY: 'All mandatory fields must be completed before submitting the request.',
  NOT_VALIDATED: "The client's balance was not validated in Zoho Analytics just before sending. Pick the client again and resend."
};

// Relevance: the purpose must fall in a category the client's ledger covers (when it lists any),
// and the request's company must belong to the matched client record (when it names one).
function relevance(req, rec) {
  const p = norm(req.purpose);
  const catOk = !rec.categories.length || rec.categories.some(c => { const n = norm(c); return n && (p.includes(n) || n.includes(p)); });
  const co = norm(req.company), rc = norm(rec.companyName), rn = norm(rec.clientName);
  const coOk = !co || !rc || co.includes(rc) || rc.includes(co) || co.includes(rn) || rn.includes(co);
  return { ok: catOk && coOk, catOk, coOk };
}

// books: the Zoho Books contact (required). rec: its Zoho Analytics balance row (null = no balance).
// fin: the three financial checks (finance-rules.js) — all three must pass.
// Nothing here ever grants final approval — the best outcome is provisional, pending Sven.
function decide({ req, books, rec, fin }) {
  const requested = Number(req.requestedAmount) || 0;
  const base = { requested, booksMatched: !!books, analyticsMatched: !!rec, booksContactId: books ? books.contactId : null, flagSven: true };

  // 1. The client must exist in Zoho Books.
  if (!books) return { ...base, ok: false, clientMatched: false, relevancePassed: false, available: 0, reason: 'CLIENT_NOT_FOUND', approvalStatus: STATUS.NOT, approvedAmount: 0, notes: MSG.NOT_FOUND };

  const out = { ...base, clientMatched: true, clientId: books.contactId, companyName: books.companyName || req.company };
  // 2. The balance must be validated in Zoho Analytics — no row means no validated balance.
  if (!rec) return { ...out, ok: false, relevancePassed: false, available: 0, allocated: 0, used: 0, remaining: 0, reason: 'NO_ANALYTICS_RECORD', approvalStatus: STATUS.FLAGGED, approvedAmount: 0, notes: MSG.INSUFFICIENT + ' (No balance record for this client in Zoho Analytics.)' };
  Object.assign(out, { available: rec.available, allocated: rec.allocated, used: rec.used });

  // 3. Relevance to the client's ledger.
  const rel = relevance(req, rec);
  if (!rel.ok) return { ...out, ok: false, relevancePassed: false, remaining: rec.available, reason: 'NOT_RELEVANT', approvalStatus: STATUS.FLAGGED, approvedAmount: 0, notes: !rel.catOk ? `Purpose "${req.purpose}" is not a category on the client's ledger (${rec.categories.join(', ')}).` : `Company "${req.company}" does not belong to this client record.` };

  // 4. Zero or insufficient balance → flag Sven; nothing approved.
  if (rec.available <= 0 || rec.available < requested) return { ...out, ok: false, relevancePassed: true, remaining: Math.max(0, rec.available), reason: 'INSUFFICIENT_BALANCE', approvalStatus: STATUS.FLAGGED, approvedAmount: 0, notes: MSG.INSUFFICIENT };

  // 5. Customer Fund Disbursement, COGS and invoice-payment checks → any failure flags Sven; nothing approved.
  if (fin && !fin.ok) return { ...out, ok: false, relevancePassed: true, remaining: Math.max(0, rec.available - requested), reason: 'FINANCIAL_CHECKS_FAILED', approvalStatus: STATUS.FLAGGED, approvedAmount: 0, notes: 'Financial validation failed — ' + fin.staffError,
    publicNotes: 'Financial validation failed — ' + fin.failed.map(f => f.label).join(', ') + '. Flagging Sven for review.' };

  // 6. Sufficient → provisional only; Sven gives the final confirmation.
  return { ...out, ok: true, relevancePassed: true, remaining: rec.available - requested, reason: 'VALIDATION_PASSED', approvalStatus: STATUS.PROVISIONAL, approvedAmount: requested, notes: MSG.PASSED };
}

return { STATUS, MSG, relevance, decide };
})();

// ---- sheets.js ----
const M_sheets = await (async () => {

// Finance_Approval_Records — append-only log with frozen header + status colours.

const HEADER = ['Client Name', 'Company Name', 'Amount Requested', 'Amount Approved', 'Approval Status', 'Zoho Analytics Balance', 'Notes / Flags', 'Timestamp', 'Reviewer'];
const LAST = String.fromCharCode(64 + HEADER.length); // 'I'
let api = null, sheetId = null, ready = false;

function client() {
  if (api) return api;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64 || !process.env.GOOGLE_SHEET_ID) return null;
  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  api = google.sheets({ version: 'v4', auth });
  return api;
}
const tab = () => process.env.GOOGLE_SHEET_TAB || 'Finance_Approval_Records';
const rgb = h => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });

async function ensure(s, id) {
  if (ready) return;
  const meta = await s.spreadsheets.get({ spreadsheetId: id });
  let sh = meta.data.sheets.find(x => x.properties.title === tab());
  if (!sh) {
    const r = await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: tab() } } }] } });
    sheetId = r.data.replies[0].addSheet.properties.sheetId;
  } else sheetId = sh.properties.sheetId;

  // A new tab gets the full header; an older 7-column tab gains Timestamp + Reviewer. Data rows are never touched.
  const head = await s.spreadsheets.values.get({ spreadsheetId: id, range: `${tab()}!A1:${LAST}1` });
  const have = (head.data.values && head.data.values[0]) || [];
  if (have.join('|') !== HEADER.join('|')) {
    await s.spreadsheets.values.update({ spreadsheetId: id, range: `${tab()}!A1:${LAST}1`, valueInputOption: 'RAW', requestBody: { values: [HEADER] } });
    const range = { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADER.length };
    const rule = (formula, color, index) => ({ addConditionalFormatRule: { index, rule: { ranges: [range], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format: { backgroundColor: rgb(color) } } } } });
    await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
      rule('=REGEXMATCH($E2,"^Pending Sven Approval")', '#d9ead3', 0),
      rule('=REGEXMATCH($E2,"^Flagged")', '#fff2cc', 1),
      rule('=$E2="Not Approved"', '#f4cccc', 2)
    ] } });
  }
  ready = true;
}

// USER_ENTERED keeps numbers numeric; text that starts like a formula ('=', '+', '-', '@') stays text.
const txt = v => /^[=+\-@]/.test(String(v ?? '')) ? "'" + v : (v ?? '');

// row: one funding-check record as exported to the group chat (see exportRecord in server.js).
async function appendRecord(row) {
  const s = client();
  if (!s) return { written: false, why: 'GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_B64 not set' };
  const id = process.env.GOOGLE_SHEET_ID;
  await ensure(s, id);
  const r = await s.spreadsheets.values.append({
    spreadsheetId: id, range: `${tab()}!A:${LAST}`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[txt(row.clientName), txt(row.companyName), row.requested, row.approved, txt(row.status), row.balance, txt(row.notes), txt(row.timestamp), txt(row.reviewer)]] }
  });
  await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: HEADER.length } } }] } });
  return { written: true, range: r.data.updates.updatedRange };
}

return { appendRecord };
})();

// ---- gate.js ----
const M_gate = await (async () => {

// Signed proof that a client name passed the exact Zoho check.
// A fund request may only be created / checked when it carries a valid token
// whose name is byte-identical to the request's clientName.

const secret = () => {
  const s = process.env.VALIDATION_SECRET;
  if (!s || s.length < 32) throw Object.assign(new Error('VALIDATION_SECRET missing or shorter than 32 chars'), { code: 'ENV' });
  return s;
};
const b64 = b => Buffer.from(b).toString('base64url');
const TTL_MS = 30 * 60 * 1000;

function issue(clientName, clientId, matchedIn) {
  const body = b64(JSON.stringify({ n: clientName, id: clientId, m: matchedIn, exp: Date.now() + TTL_MS }));
  const sig = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + sig;
}

// Signature check on bytes (timingSafeEqual throws on unequal byte lengths) and a body that may be garbage: never throws.
function signedBody(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const a = Buffer.from(String(sig || '')), b = Buffer.from(b64(crypto.createHmac('sha256', secret()).update(body).digest()));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p && typeof p === 'object' ? p : null; } catch { return null; }
}

function verify(token, clientName) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, why: 'NO_TOKEN' };
  const p = signedBody(token);
  if (!p) return { ok: false, why: 'BAD_SIGNATURE' };
  if (p.exp < Date.now()) return { ok: false, why: 'EXPIRED' };
  if (p.n !== clientName) return { ok: false, why: 'NAME_MISMATCH' };
  return { ok: true, clientId: p.id, matchedIn: p.m };
}

// One attempt per session: a failed name locks the session until it restarts.
const locks = new Map(); // sessionId -> { name, at }
const lock = (sid, name) => sid && locks.set(sid, { name, at: new Date().toISOString() });
const locked = sid => (sid && locks.get(sid)) || null;
const unlock = sid => sid && locks.delete(sid);

// Short-lived signed payload, e.g. "this user's balance pre-check for this client and amount passed".
function sign(payload, ttlMs) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return body + '.' + b64(crypto.createHmac('sha256', secret()).update(body).digest());
}
function unsign(token) {
  const p = signedBody(token);
  return !p || !(p.exp >= Date.now()) ? null : p;
}

return { issue, verify, lock, locked, unlock, sign, unsign };
})();

// ---- auth.js ----
const M_auth = await (async () => {
const { push } = M_cloud;
// Server-side authentication — the real enforcement layer.
// Users persist in data/users.json until the Master Admin deletes or deactivates them.
// Passwords: scrypt + per-user salt. Sessions: bearer token (also accepted as HttpOnly cookie), 30-min idle expiry.

const FILE = path.resolve(process.env.USERS_FILE || './data/users.json');
const IDLE_MS = 30 * 60 * 1000, LOCK_AFTER = 5, LOCK_MS = 15 * 60 * 1000;
const sessions = new Map();           // token -> { user, last }
// Sign-in history: kept in data/login-history.json (and Upstash) so Master Control still has it after a restart.
const HFILE = path.join(path.dirname(FILE), 'login-history.json');
const history = (() => { try { return JSON.parse(fs.readFileSync(HFILE, 'utf8')); } catch { return []; } })();
let hSaveT = null;
const saveHistory = () => { clearTimeout(hSaveT); hSaveT = setTimeout(() => { const j = JSON.stringify(history); try { fs.mkdirSync(path.dirname(HFILE), { recursive: true }); fs.writeFileSync(HFILE, j); } catch {} push('loginhistory', j); }, 300); };
let onEvent = () => {};               // set by sync layer for live broadcast
const setBroadcast = fn => { onEvent = fn; };

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const check = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  const a = Buffer.from(h || '', 'hex'), b = crypto.scryptSync(pw, salt || '', 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const OPS = ['VIEW_DASHBOARD', 'VIEW_OPERATIONS_DASHBOARD', 'VIEW_OWN_REQUESTS', 'CREATE_REQUEST', 'EDIT_REQUEST', 'UPLOAD_DOCUMENTS', 'REQUEST_APPROVAL', 'VIEW_ACTIVITY'];
const MGMT = ['VIEW_DASHBOARD', 'VIEW_MANAGEMENT_DASHBOARD', 'VIEW_ALL_OPERATIONS_REQUESTS', 'VIEW_CLIENT_BALANCE', 'VIEW_FINANCIAL_DATA', 'VIEW_ACTIVITY', 'VIEW_AUDIT_LOG']; // decisions go through the escalation endpoints
// Management: the three people an escalation goes to. Each decides alone; Sven still gives the final approval.
const MANAGEMENT = [['adnan', 'Adnan', 'CFO'], ['ahmed', 'Ahmed', 'General Manager'], ['eduard', 'Eduard', 'Chief Legal Officer']];
function seedTeam() {
  const pw = process.env.SEED_TEAM_PASSWORD;
  if (!pw || pw.length < 8) return [];
  const mk = (key, name, dept, title = '') => ({ key, name, username: key + '@onelink.solutions', role: dept, dept, title, active: true, perms: dept === 'OPERATIONS' ? OPS : dept === 'MANAGEMENT' ? MGMT : [], pw: hash(pw), pwSetAt: new Date().toISOString(), failCount: 0, lockedUntil: 0, created: new Date().toISOString() });
  return [...MANAGEMENT.map(([k, n, t]) => mk(k, n, 'MANAGEMENT', t)), ...['amina', 'anastasiya', 'maram', 'musa', 'wafaa'].map(k => mk(k, k[0].toUpperCase() + k.slice(1), 'OPERATIONS'))];
}
// An existing server gains any management account it is missing — deactivated and without a password until Sven
// sets one in Master Control → Users — and the management titles. Nothing else about existing accounts changes.
function ensureManagement() {
  let users;
  try { users = load(); } catch { return; }
  let changed = false;
  for (const [key, name, title] of MANAGEMENT) {
    const u = users.find(x => x.key === key);
    if (!u) {
      users.push({ key, name, username: key + '@onelink.solutions', role: 'MANAGEMENT', dept: 'MANAGEMENT', title, active: false, perms: MGMT, pw: null, pwSetAt: null, failCount: 0, lockedUntil: 0, created: new Date().toISOString() });
      console.log(`Accounts: added ${name} (${title}) — deactivated until the Master Administrator sets a password.`);
      changed = true;
    } else if (!u.title && u.dept === 'MANAGEMENT') { u.title = title; changed = true; }
  }
  if (changed) save(users);
}
function load() {
  if (!fs.existsSync(FILE)) {
    const pw = process.env.MASTER_ADMIN_PASSWORD;
    if (!pw || pw.length < 12) throw new Error('Set MASTER_ADMIN_PASSWORD (12+ chars) for the first start — it creates the Master Admin account.');
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    save([{ key: 'sven', name: 'Sven', username: (process.env.MASTER_ADMIN_EMAIL || 'sven@onelink.solutions').toLowerCase(), role: 'MASTER_ADMIN', dept: 'FINANCE', active: true, perms: ['*'], pw: hash(pw), pwSetAt: new Date().toISOString(), failCount: 0, lockedUntil: 0, created: new Date().toISOString() }, ...seedTeam()]);
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function save(users) { const j = JSON.stringify(users, null, 2); fs.writeFileSync(FILE + '.tmp', j); fs.renameSync(FILE + '.tmp', FILE); push('users', j); }
// Dubai time, as the rest of the platform shows it ('02 Oct · 14:05').
const when = iso => { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return String(iso); return d.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', ' ·'); };
const onlineKeys = () => { const k = new Set(); for (const v of sessions.values()) if (Date.now() - v.last <= IDLE_MS) k.add(v.user); return k; };
const pub = (u, on = onlineKeys()) => ({ key: u.key, name: u.name, username: u.username, role: u.role, dept: u.dept, title: u.title || '', active: u.active, perms: u.perms || [], created: u.created,
  opsMaster: isOpsMaster(u), lastLogin: when(u.lastLogin), lastLoginAt: u.lastLogin || null, online: on.has(u.key), passwordSetAt: u.pwSetAt || null, passwordSet: u.pwSetAt ? when(u.pwSetAt) : 'not recorded yet', // tracked from this version on
  locked: (u.lockedUntil || 0) > Date.now() });
const broadcastUsers = () => { const on = onlineKeys(); onEvent({ type: 'accounts', items: load().map(u => pub(u, on)) }); };

function record(kind, who, detail, ip) {
  const e = { at: new Date().toISOString(), kind, who, detail, ip };
  history.unshift(e); history.length = Math.min(history.length, 500);
  saveHistory();
  onEvent({ type: 'login', item: e });
}

const tokenOf = q => {
  const b = /^Bearer\s+([A-Za-z0-9_-]{32,})$/.exec(q.headers.authorization || '');
  if (b) return b[1];
  if (typeof q.query?.t === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(q.query.t)) return q.query.t; // EventSource cannot set headers
  return (/(?:^|;\s*)ol_auth=([A-Za-z0-9_-]{32,})/.exec(q.headers.cookie || '') || [])[1];
};

function requireAuth(q, s, next) {
  const t = tokenOf(q), sess = t && sessions.get(t);
  if (!sess || Date.now() - sess.last > IDLE_MS) { if (t) sessions.delete(t); return s.status(401).json({ ok: false, reason: 'LOGIN_REQUIRED' }); }
  const u = load().find(x => x.key === sess.user);
  if (!u || !u.active) { sessions.delete(t); return s.status(401).json({ ok: false, reason: 'ACCOUNT_INACTIVE' }); }
  sess.last = Date.now(); q.user = u; q.token = t; next();
}
const isMaster = u => u?.role === 'MASTER_ADMIN' || (u?.perms || []).includes('*');
// Master Operations Control: an Operations user who sees and acts on every Operations request (default: Amina).
const opsMasterKeys = () => (process.env.OPS_MASTER_KEYS || 'amina').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const isOpsMaster = u => !!u && u.dept === 'OPERATIONS' && !isMaster(u) && (opsMasterKeys().includes(u.key) || (u.perms || []).includes('OPS_MASTER'));
const requireMaster = (q, s, next) => isMaster(q.user) ? next() : s.status(403).json({ ok: false, reason: 'MASTER_ADMIN_ONLY' });
const kill = key => { for (const [t, v] of sessions) if (v.user === key) sessions.delete(t); };
const keyFor = (username, users) => {
  const base = username.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  let k = base, i = 2; while (users.some(u => u.key === k)) k = base + i++;
  return k;
};

setInterval(() => {
  let gone = 0;
  for (const [t, v] of sessions) if (Date.now() - v.last > IDLE_MS) { sessions.delete(t); gone++; }
  if (gone) broadcastUsers();
}, 60_000).unref();
ensureManagement();

function mount(app) {
  app.post('/api/auth/login', (q, s) => {
    const id = String(q.body?.username || '').trim().toLowerCase(), pw = String(q.body?.password || '');
    const users = load(), u = users.find(x => x.username === id || x.key === id);
    const bad = (code, msg, kind = 'FAILED') => { record(kind, u ? u.name : id, msg, q.ip); s.status(code).json({ ok: false, error: msg }); };
    if (!u) return bad(401, 'Email or password is not right.');
    if ((u.lockedUntil || 0) > Date.now()) return bad(423, 'Account locked after five wrong passwords. Try again in 15 minutes or ask Sven to reset it.', 'LOCKED');
    if (!u.active) return bad(403, 'Account deactivated by the Master Administrator.', 'BLOCKED');
    if (!check(pw, u.pw)) {
      u.failCount = (u.failCount || 0) + 1;
      const left = LOCK_AFTER - u.failCount;
      if (u.failCount >= LOCK_AFTER) { u.failCount = 0; u.lockedUntil = Date.now() + LOCK_MS; }
      save(users); broadcastUsers();
      return bad(401, left > 0 ? `Email or password is not right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Five wrong passwords — account locked for 15 minutes.', left > 0 ? 'FAILED' : 'LOCKED');
    }
    u.failCount = 0; u.lockedUntil = 0; u.lastLogin = new Date().toISOString(); save(users);
    const t = crypto.randomBytes(32).toString('base64url');
    sessions.set(t, { user: u.key, last: Date.now() });
    s.append('Set-Cookie', `ol_auth=${t}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${IDLE_MS / 1000}`);
    record('SUCCESS', u.name, 'Signed in', q.ip); broadcastUsers();
    s.json({ ok: true, token: t, user: pub(u) });
  });
  // Operations user forgot their password → Sven is notified live (response never reveals whether the account exists)
  const resetHits = new Map();
  app.post('/api/auth/reset-request', (q, s) => {
    const id = String(q.body?.username || '').trim().toLowerCase(), now = Date.now();
    const last = resetHits.get(q.ip) || 0; resetHits.set(q.ip, now);
    const u = load().find(x => x.username === id || x.key === id);
    if (u && now - last > 10000) { record('RESET_REQUEST', u.name, 'Asked the Master Administrator for a password reset', q.ip); onEvent({ type: 'reset-request', user: pub(u) }); }
    s.json({ ok: true });
  });
  // Master Admin recovery with the RECOVERY_CODE env value
  app.post('/api/auth/recover', (q, s) => {
    const code = String(q.body?.code || ''), pw = String(q.body?.password || ''), want = process.env.RECOVERY_CODE || '';
    const users = load(), u = users.find(x => isMaster(x));
    const ok = want.length >= 12 && code.length === want.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(want));
    if (!ok) { record('FAILED', u ? u.name : 'master', 'Wrong recovery code', q.ip); return s.status(403).json({ ok: false, error: 'That recovery code is not right.' }); }
    if (pw.length < 12) return s.status(400).json({ ok: false, error: 'Use at least twelve characters.' });
    u.pw = hash(pw); u.pwSetAt = new Date().toISOString(); u.failCount = 0; u.lockedUntil = 0; u.active = true; save(users); kill(u.key);
    record('RESET', u.name, 'Master password reset with the recovery code', q.ip); broadcastUsers();
    s.json({ ok: true });
  });
  app.post('/api/auth/logout', requireAuth, (q, s) => { sessions.delete(q.token); record('LOGOUT', q.user.name, 'Signed out', q.ip); broadcastUsers(); s.json({ ok: true }); });
  app.get('/api/auth/me', requireAuth, (q, s) => s.json({ ok: true, user: pub(q.user) }));

  app.get('/api/admin/users', requireAuth, requireMaster, (_q, s) => { const on = onlineKeys(); s.json(load().map(u => pub(u, on))); });
  app.post('/api/admin/users', requireAuth, requireMaster, (q, s) => {
    const b = q.body || {}, users = load(), username = String(b.username || '').trim().toLowerCase();
    if (!/.+@.+\..+/.test(username) || !b.name || String(b.password || '').length < 8) return s.status(400).json({ ok: false, error: 'Name, work email and an 8+ character password are required.' });
    if (users.some(u => u.username === username)) return s.status(409).json({ ok: false, error: 'An account already uses that email.' });
    const dept = b.dept || 'OPERATIONS';
    const u = { key: keyFor(username, users), name: String(b.name), username, role: b.role || dept, dept, active: b.active !== false, perms: Array.isArray(b.perms) ? b.perms : (dept === 'OPERATIONS' ? OPS : []), pw: hash(String(b.password)), pwSetAt: new Date().toISOString(), failCount: 0, lockedUntil: 0, created: new Date().toISOString() };
    users.push(u); save(users); record('USER_CREATED', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true, user: pub(u) });
  });
  app.patch('/api/admin/users/:key', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key), b = q.body || {};
    if (!u) return s.status(404).json({ ok: false });
    if (b.name) u.name = String(b.name);
    if (typeof b.title === 'string') u.title = b.title.slice(0, 60);
    if (b.username && /.+@.+\..+/.test(b.username)) u.username = String(b.username).toLowerCase();
    if (!isMaster(u)) { if (b.dept) u.dept = b.dept; if (b.role) u.role = b.role; if (Array.isArray(b.perms)) u.perms = b.perms; }
    save(users); broadcastUsers(); s.json({ ok: true, user: pub(u) });
  });
  app.post('/api/admin/users/:key/active', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key);
    if (!u || isMaster(u)) return s.status(400).json({ ok: false });
    u.active = !!q.body?.active; save(users);
    if (!u.active) kill(u.key);
    record(u.active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true, user: pub(u) });
  });
  app.post('/api/admin/users/:key/password', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key), pw = String(q.body?.password || '');
    if (!u || pw.length < 8) return s.status(400).json({ ok: false });
    u.pw = hash(pw); u.pwSetAt = new Date().toISOString(); u.failCount = 0; u.lockedUntil = 0; save(users); kill(u.key);
    record('PASSWORD_RESET', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true, user: pub(u) });
  });
  app.delete('/api/admin/users/:key', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key);
    if (!u || isMaster(u)) return s.status(400).json({ ok: false });
    save(users.filter(x => x.key !== u.key)); kill(u.key);
    record('USER_DELETED', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true });
  });
  app.get('/api/admin/login-history', requireAuth, requireMaster, (_q, s) => s.json(history.slice(0, 200)));
  // One-glance account status for the Master Administrator. Passwords are scrypt hashes and can never be shown.
  app.get('/api/admin/accounts-status', requireAuth, requireMaster, (_q, s) => {
    const on = onlineKeys();
    s.json(load().map(u => { const p = pub(u, on); return { name: p.name, username: p.username, role: p.role, active: p.active, locked: p.locked, online: p.online, lastSignIn: p.lastLogin, passwordLastSet: p.passwordSet }; }));
  });
}

const isManagement = u => !!u && u.active !== false && u.dept === 'MANAGEMENT';

return { setBroadcast, load, pub, requireAuth, isMaster, isOpsMaster, isManagement, mount };
})();

// ---- store.js ----
const M_store = await (async () => {
const { push, enabled: cloudOn, kvGet, kvSet, kvDel } = M_cloud;
const { requireAuth, isMaster, isOpsMaster, isManagement, setBroadcast, load: loadUsers, pub } = M_auth;
// Shared, persistent platform data + real-time push (Server-Sent Events).
// Every signed-in browser reads the same data and receives every change the moment it happens.

const FILE = path.resolve(process.env.DATA_FILE || './data/platform.json');
const COLS = ['requests', 'chat', 'notifications', 'audit'];
let db = { rev: 0, requests: [], chat: [], notifications: [], audit: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
let saveT = null;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); push('platform', JSON.stringify(db)); }, 150); };

// Insert items whose id is not in db[col] yet. Each goes before the first entry older than it ('09 Apr'),
// so the newest-first order holds; existing entries are never changed or reordered.
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateKey = d => { const m = /^(\d{1,2}) ([A-Z][a-z]{2})/.exec(String(d || '')), i = m ? MO.indexOf(m[2]) : -1; return i >= 0 ? i * 100 + Number(m[1]) : 1e9; };
function mergeMissing(col, items) {
  const have = new Set(db[col].map(x => x.id));
  const add = items.filter(x => x && typeof x.id === 'string' && !have.has(x.id));
  for (const it of add.sort((a, b) => dateKey(b.date) - dateKey(a.date))) {
    const k = dateKey(it.date), i = db[col].findIndex(x => dateKey(x.date) < k);
    if (i < 0) db[col].push(it); else db[col].splice(i, 0, it);
  }
  return add.length;
}

// ledger.json is the source of truth for the request history (rebuilt from the Alaan Card Invoices group).
// It lives beside server.js, apart from the Claude Design export, and is applied on every start:
// an empty server takes all of it; a server with data only gains the requests it is missing.
// A platform reset records what it removed (db.purged) and when (db.resetAt): removed history never comes back,
// and an emptied server is not mistaken for a first start.
let LEDGER = { requests: [], chat: [], notifications: [], audit: [] };
try {
  LEDGER = JSON.parse(fs.readFileSync(new URL('./ledger.json', import.meta.url), 'utf8'));
  const gone = new Set(db.purged || []);
  if (!db.requests.length && !db.resetAt) {
    for (const c of COLS) if (Array.isArray(LEDGER[c])) db[c] = LEDGER[c];
    db.rev++; persist(); console.log('Ledger: loaded', db.requests.length, 'requests into an empty server.');
  } else {
    const n = mergeMissing('requests', (LEDGER.requests || []).filter(r => !gone.has(r.id)));
    if (n) { db.rev++; persist(); }
    console.log('Ledger:', n ? 'added ' + n + ' missing requests.' : 'server already up to date.');
  }
} catch (e) { console.error('Ledger not applied:', e.message); }
const LEDGER_IDS = Object.fromEntries(COLS.map(c => [c, new Set((LEDGER[c] || []).map(x => x && x.id))]));
// History = imported from the ledger; everything else was created on the live platform.
const isHistory = r => LEDGER_IDS.requests.has(r.id) && !r.createdAt;

const clients = new Set(); // { res, user }
const ops = u => u.dept === 'OPERATIONS' && !isMaster(u);
// What each user may see
// Operations staff (other than Master Operations Control) are "restricted": they see only what they created.
const restricted = u => ops(u) && !isOpsMaster(u);
const ownerOf = id => (id && (db.requests.find(r => r.id === id) || {}).by) || null;
// Request data — the request, its audit trail, its Zoho check records — belongs to its requestor.
const ownsRequestData = (u, reqId) => !restricted(u) || (!!reqId && ownerOf(reqId) === u.key);
function visible(u, col, item) {
  if (isMaster(u)) return true;
  if (col === 'requests') return !restricted(u) || item.by === u.key;
  if (col === 'notifications') return item.to === u.key;
  if (col === 'audit') return u.dept === 'MANAGEMENT' || isOpsMaster(u) || (restricted(u) && ownsRequestData(u, item.req));
  if (col === 'chat' && (item.who === 'Zoho' || item.zoho)) return ownsRequestData(u, item.req); // process data
  return true; // people's messages: shared group thread
}
const NO_ACCESS = 'No access — request not created by you';
// Operations never see Zoho Analytics balances. What they receive is stripped here, on the server:
// the request's balance field, amounts in its history lines, the financial check figures, and the balance record on Zoho chat items.
const hideAmounts = t => String(t ?? '')
  .replace(/re-validated at AED [\d,]+(?:\.\d+)? available/gi, 're-validated in Zoho Analytics')
  .replace(/(Zoho (?:Analytics )?balance:?) (?:of )?AED [\d,]+(?:\.\d+)?(?: available)?/gi, '$1')
  .replace(/,? ?AED [\d,]+(?:\.\d+)? in Zoho Analytics/gi, '');
function redact(u, col, item) {
  if (!item || !restricted(u)) return item; // Master Operations Control sees balances
  if (col === 'requests') {
    const { zohoBalance, ...r } = item;
    if (Array.isArray(r.timeline)) r.timeline = r.timeline.map(t => ({ ...t, text: hideAmounts(t.text) }));
    if (r.finance) r.finance = M_finance.forOps(r.finance);
    return r;
  }
  if (col === 'chat' && item.zoho) { const { zoho, ...c } = item; return { ...c, text: hideAmounts(c.text) }; }
  if (col === 'audit' && item.detail) return { ...item, detail: String(item.detail).replace(/AED\s?[\d,]+(?:\.\d+)?K?/gi, 'AED •••') }; // e.g. 'balance moved to AED 3,000'
  return item;
}
// An Operations browser only holds the stripped copy: when it saves a request, put the hidden parts back.
function restoreHidden(item, prev) {
  if (prev.zohoBalance !== undefined && item.zohoBalance === undefined) item.zohoBalance = prev.zohoBalance;
  if (Array.isArray(item.timeline) && Array.isArray(prev.timeline))
    item.timeline = item.timeline.map((t, i) => { const o = prev.timeline[i]; return o && t.at === o.at && t.text === hideAmounts(o.text) ? o : t; });
}

// One open request per Zoho Books client: New, waiting on information, or with management. Approving, declining or voiding unlocks.
const OPEN = ['NEW', 'ACTION', 'ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED'];
// Only the server moves a request into these (escalation endpoints, void) — and out of ESCALATED / MGMT_INFO.
const SERVER_STATUS = ['ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED', 'VOID'];
// Set only by the server: whatever a browser sends for these is replaced by the stored value.
const SERVER_FIELDS = ['finance', 'financeLatest', 'escalation', 'voided', 'requestorId', 'clientId', 'createdAt'];
// Operations cannot change the money or the client on a request once it exists (Master Operations Control included).
const OPS_FIXED = ['requested', 'approved', 'credited', 'zohoClientId', 'zohoClient', 'zohoBalance', 'zohoReason', 'zohoValidationId', 'zohoCheckedAt', 'override'];
const pendingRequestFor = contactId => (contactId && db.requests.find(r => String(r.zohoClientId || '') === String(contactId) && OPEN.includes(r.status))) || null;

// The three financial checks run at Send: kept here until the request (or its escalation) arrives, then attached to it.
const finStore = new Map(); // FV id -> { fin, u, at }
const finPut = (fin, userKey) => { finStore.set(fin.id, { fin, u: userKey, at: Date.now() }); for (const [k, v] of finStore) if (Date.now() - v.at > DAY) finStore.delete(k); };
const finGet = (id, userKey) => { const e = id && finStore.get(id); return e && e.u === userKey ? e.fin : null; };

// Rules for a brand-new request, enforced here whatever the browser does.
function newRequestProblem(u, item) {
  const blank = v => !String(v ?? '').trim();
  if (blank(item.company) || blank(item.purpose) || !(Number(item.requested) > 0) || blank(item.paid) || blank(item.zohoClientId))
    return { status: 422, reason: 'MANDATORY_FIELDS', error: M_rules.MSG.MANDATORY };
  const pend = pendingRequestFor(item.zohoClientId);
  if (pend) return { status: 409, reason: 'REQUEST_PENDING', error: M_rules.MSG.LOCKED, pendingId: pend.id };
  const pass = M_gate.unsign(item.zohoSubmitToken);
  // Single use: the pass is good only while the result of the checks it was issued for is still waiting here.
  if (!pass || pass.k !== 'submit' || pass.u !== u.key || String(pass.c) !== String(item.zohoClientId) || Number(pass.a) !== Number(item.requested) || !finGet(pass.f, u.key))
    return { status: 422, reason: 'BALANCE_NOT_VALIDATED', error: M_rules.MSG.NOT_VALIDATED };
  if (String(item.paid).trim() !== String(pass.p || '')) return { status: 422, reason: 'PAID_CHANGED', error: '“Client already paid us?” changed after the financial checks ran. Press Send again.' };
  return null;
}
// A refused request must not leave a "<name> requested ..." notification pointing at nothing (or at someone else's request).
const refused = new Map(); // `${userKey}:${requestId}` -> { reason, at }
const notSubmitted = (n, reason) => ({ ...n, req: null, text: 'Not submitted — ' + n.text.replace(/\.$/, '') + '. ' + reason });

function send(c, ev) { c.res.write(`data: ${JSON.stringify(ev)}\n\n`); }
function broadcast(ev, col, item) {
  for (const c of clients) {
    if (ev.type === 'login' && !isMaster(c.user)) continue;
    if (ev.type === 'accounts' && !isMaster(c.user)) continue;
    if (col && item && !visible(c.user, col, item)) continue;
    send(c, col && item && ev.item ? { ...ev, item: redact(c.user, col, ev.item) } : ev);
  }
}
setBroadcast(ev => {
  if (ev.type === 'reset-request') {
    const item = { id: 'r' + Date.now().toString(36), to: 'sven', text: 'Password reset requested by ' + ev.user.name + ' (' + ev.user.username + '). Set a temporary password in Users.', at: new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), read: false, req: null };
    upsert('notifications', item);
    return broadcast({ type: 'put', col: 'notifications', item, rev: db.rev, by: 'system' }, 'notifications', item);
  }
  broadcast(ev);
});

// Write rules — enforced here, not in the browser
function mayWrite(u, col, item, prev) {
  if (col === 'requests') {
    if (prev && prev.status === 'VOID') return false;                       // voided: locked for everyone
    if (!prev && item.status !== 'NEW') return false;                       // new requests start at Pending Sven Approval
    if (prev && prev.status !== item.status && (SERVER_STATUS.includes(item.status) || prev.status === 'ESCALATED' || prev.status === 'MGMT_INFO')) return false; // management decides
  }
  if (isMaster(u)) return true;
  if (col === 'requests') {
    // Operations: new requests in their own name; edits to their own (Master Operations Control: to any),
    // never a finance decision (approve / credit / decline stay with Sven).
    if (ops(u)) return (prev ? item.by === prev.by && (prev.by === u.key || isOpsMaster(u)) : item.by === u.key)
      && (!prev || prev.status === item.status || (prev.status === 'NEW' && item.status === 'ACTION') || (prev.status === 'ACTION' && item.status === 'NEW') || (prev.status === 'CREDITED' && item.status === 'PAID'));
    // Management decide escalations (and void) through their own endpoints; Sven gives every final approval,
    // so a management account may add notes and files but never move a request's status.
    if (u.dept === 'MANAGEMENT') return !!prev && prev.status === item.status;
    return (u.perms || []).some(p => ['APPROVE_REQUEST', 'DECLINE_REQUEST', 'CREDIT_FUNDS', 'RELEASE_FUNDS', 'PARTIAL_APPROVE_REQUEST'].includes(p)) || u.dept === 'FINANCE';
  }
  if (col === 'chat') return !prev && item.who === u.key;
  if (col === 'notifications') return !prev || prev.to === u.key; // create for anyone, mark own as read
  if (col === 'audit') return !prev;
  return false;
}
const VOID_LOCKED = 'This request has been voided and is locked — nothing on it can change.';

// Request numbers are picked in the sender's browser ("highest FR number I can see + 1"). Operations users only
// see their own requests, so their number can already belong to someone else's. The creator ("by") of a request
// never changes, so a put whose id exists with a different creator is a NEW request: it gets the next free
// number. The old number is remembered per user for a day, so that browser's follow-up writes (notification,
// chat, Zoho check, edits) land on the right request until it has renamed it. Numbers used before a platform
// reset (db.floorNo) are never handed out again.
const remaps = new Map(); // `${userKey}:${oldId}` -> { id, at }
const DAY = 24 * 3600 * 1000;
const numOf = id => Number(String(id).replace(/\D/g, '')) || 0;
const nextRequestId = () => 'FR-' + (Math.max(db.floorNo || 0, db.requests.reduce((a, r) => Math.max(a, numOf(r.id)), 0)) + 1);
function resolveRequestId(userKey, id, maxAge = DAY) {
  const r = id && remaps.get(userKey + ':' + id);
  if (r && Date.now() - r.at > DAY) { remaps.delete(userKey + ':' + id); return id; }
  return r && Date.now() - r.at <= maxAge ? r.id : id;
}
// A put carrying a submit pass is a brand-new request. A resend of the same request carries the pass of the checks
// already attached to it; any other request under a taken number (another user's — or the same user's escalation,
// numbered by the server before this browser saw it) is a different request.
const sameSubmission = (item, taken) => { const p = M_gate.unsign(item.zohoSubmitToken); return !!(p && taken.finance && p.f === taken.finance.id); };

// Zoho result of the automatic check that runs when a request is sent. The server attaches it to the request
// itself; if the browser's copy of the request has not arrived yet, it waits here and is attached on arrival.
const pendingZoho = new Map(); // `${userKey}:${requestId as the browser named it}` -> { fields, tl, at }
const withZoho = (r, z) => {
  const n = Object.assign({}, r, z.fields);
  if (!(n.timeline || []).some(t => t.text === z.tl.text)) n.timeline = (n.timeline || []).concat([z.tl]);
  return n;
};
function attachZohoResult(userKey, requestId, fields, tl, clientId) {
  if (!requestId) return false;
  const id = resolveRequestId(userKey, requestId), r = db.requests.find(x => x.id === id);
  const same = x => !clientId || String(x.zohoClientId || '') === String(clientId); // a check of this request's own client
  if (r && r.by === userKey) { const ok = r.status === 'NEW' && same(r); if (ok) postSystem('requests', withZoho(r, { fields, tl })); return ok; } // only the check right after Send
  pendingZoho.set(userKey + ':' + requestId, { fields, tl, clientId, at: Date.now() });
  for (const [k, v] of pendingZoho) if (Date.now() - v.at > DAY) pendingZoho.delete(k);
  return false;
}
// A check Sven (or another finance user) ran on an existing request. The checks from submission (or escalation) are the
// evidence the request was raised on and never change; the latest re-check is kept beside them.
function attachFinance(requestId, fin) {
  const r = requestId && db.requests.find(x => x.id === requestId);
  if (!r || r.status === 'VOID' || !fin) return false;
  postSystem('requests', r.finance ? { ...r, financeLatest: M_finance.record(fin) } : { ...r, finance: M_finance.record(fin) });
  return true;
}
// Approved or credited on the platform but not yet booked in the CFD ledger: held against the client's balance.
function committedFor(contactId, exceptId) {
  const k = M_finance.canonical(contactId), list = db.requests.filter(r => r.id !== exceptId && r.zohoClientId && M_finance.canonical(r.zohoClientId) === k && ['APPROVED', 'CREDITED'].includes(r.status));
  return { amount: list.reduce((a, r) => a + (Number(r.status === 'CREDITED' ? r.credited || r.approved : r.approved) || Number(r.requested) || 0), 0), count: list.length };
}
// Wait briefly for the browser's copy of a just-sent request (it is pushed alongside the check).
async function awaitOwnRequest(userKey, requestId, ms = 1500) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const id = resolveRequestId(userKey, requestId);
    if (db.requests.some(x => x.id === id && x.by === userKey)) return id;
  }
  return resolveRequestId(userKey, requestId);
}

function upsert(col, item) {
  const list = db[col], i = list.findIndex(x => x.id === item.id);
  const prev = i >= 0 ? list[i] : null;
  if (i >= 0) list[i] = item; else if (col === 'chat') list.push(item); else list.unshift(item); // chat is oldest-first, the rest newest-first
  if (col === 'audit' && list.length > 5000) list.length = 5000;
  db.rev++; persist();
  return prev;
}

// ---- requests: escalation, void, invoice chasing (server-side transitions) ----
const aed = n => 'AED ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const hex = n => crypto.randomBytes(n).toString('hex').toUpperCase();
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const titled = u => 'Mr. ' + u.name + (u.title ? ' (' + u.title + ')' : '');
const management = () => loadUsers().filter(x => x.dept === 'MANAGEMENT');
const financeTeam = () => loadUsers().filter(x => x.active !== false && (isMaster(x) || x.dept === 'FINANCE'));
// Lines and files the server adds carry srv: true — a browser's older copy of the request can never drop them (see /api/sync/put).
const tlAt = () => AUDIT_DAY().replace(/^0/, ''); // history lines use the page's own format ('8 Oct · 14:05')
const line = (r, text) => (r.timeline || []).concat([{ at: tlAt(), text, srv: true }]);
function notify(to, text, req) {
  postSystem('notifications', { id: 'sn' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), to, text, at: AUDIT_DAY(), read: false, req: req || null, _at: Date.now() });
}
const notifyMany = (keys, text, req, except) => [...new Set(keys)].filter(k => k && k !== except).forEach(k => notify(k, text, req));
const FILE_DIR = path.resolve('./data/files');
async function fileExists(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ''))) return false;
  if (fs.existsSync(path.join(FILE_DIR, id + '.json'))) return true;
  try { return cloudOn ? !!(await kvGet('onelink:filemeta:' + id)) : false; } catch { return false; }
}
async function cleanDocs(list) {
  const out = [];
  for (const d of (Array.isArray(list) ? list : []).slice(0, 20)) {
    if (!d || typeof d.name !== 'string' || !(await fileExists(d.fileId))) continue;
    out.push({ key: 'f' + Date.now().toString(36) + out.length, name: str(d.name, 200), type: str(d.type, 40) || 'Invoice', size: Number(d.size) || 0, fileId: d.fileId, status: 'done', srv: true });
  }
  return out;
}
const reqOut = (u, r) => redact(u, 'requests', r);

function mountRequests(app) {
  const fail = (s, status, error, extra) => s.status(status).json({ ok: false, error, ...extra });
  app.use('/api/requests', (q, s, next) => resetting ? fail(s, 503, 'A platform reset is running — try again in a moment.') : next());
  const find = (q, s) => {
    const r = db.requests.find(x => x.id === String(q.params.id || ''));
    if (!r) { fail(s, 404, 'No such request'); return null; }
    if (!visible(q.user, 'requests', r)) { audit(q.user, 'ACCESS_DENIED', `Tried to act on ${r.id}, created by ${r.by}`, r); fail(s, 403, NO_ACCESS); return null; }
    return r;
  };

  // Escalate to management: the financial checks failed at Send. The request is created here, with the server's
  // number, the failed checks and the justification, and goes to Mr. Adnan, Mr. Ahmed and Mr. Eduard.
  app.post('/api/requests/escalate', requireAuth, async (q, s) => {
    const u = q.user, b = q.body || {}, R = b.request || {};
    const pass = M_gate.unsign(b.escalateToken);
    if (!pass || pass.k !== 'esc' || pass.u !== u.key) return fail(s, 403, 'The escalation pass has expired — press Send again to re-run the financial checks.');
    const fin = finGet(pass.f, u.key);
    if (!fin) return fail(s, 409, 'The financial check result has expired — press Send again to re-run the checks.');
    if (Number(R.requested) !== Number(pass.a)) return fail(s, 422, 'The amount changed after the checks ran — press Send again.');
    const just = str(b.justification, 2000);
    if (just.length < 15) return fail(s, 422, 'Give management a justification of at least 15 characters.');
    if (!str(R.company, 200) || !str(R.purpose, 500) || !str(pass.p, 60)) return fail(s, 422, M_rules.MSG.MANDATORY, { reason: 'MANDATORY_FIELDS' });
    const pend = pendingRequestFor(pass.c);
    if (pend) return fail(s, 409, M_rules.MSG.LOCKED, { reason: 'REQUEST_PENDING', pendingId: pend.id });
    const docs = await cleanDocs(R.docs);
    if (pendingRequestFor(pass.c)) return fail(s, 409, M_rules.MSG.LOCKED, { reason: 'REQUEST_PENDING' });
    const at = new Date().toISOString(), atText = AUDIT_DAY(), id = nextRequestId(), amount = Number(pass.a);
    const people = management();
    const escalation = {
      id: 'ESC-' + hex(3), at, atText, by: u.key, byName: u.name, justification: just, failed: fin.failed,
      to: people.map(p => ({ key: p.key, name: p.name, title: p.title || '' })), decision: null,
      log: [{ at, atText, who: u.key, whoName: u.name, action: 'CREATED', note: just }]
    };
    const failedLabels = fin.failed.map(f => f.label).join(', ');
    const item = {
      id, by: u.key, company: str(R.company, 200), person: str(pass.n, 200) || str(R.person, 200), zohoClient: str(pass.n, 200), zohoClientId: String(pass.c),
      purpose: str(R.purpose, 500), zone: str(R.zone, 80), requested: amount, approved: null, credited: 0, status: 'ESCALATED',
      date: str(R.date, 20) || new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short' }),
      paid: str(pass.p, 60), notes: str(R.notes, 2000), docs, flagged: true, // the answer the checks ran with
      timeline: [
        { at: tlAt(), text: `${u.name} requested ${aed(amount)}` + (docs.length ? ` with ${docs.length} document${docs.length > 1 ? 's' : ''}` : ' — no document attached'), srv: true },
        { at: tlAt(), text: `Financial validation ${fin.id} failed — ${failedLabels}`, srv: true },
        { at: tlAt(), text: `${u.name} escalated to management (${escalation.id}) — ${just}`, srv: true }
      ],
      requestorId: u.key, clientId: String(pass.c), createdAt: at, finance: M_finance.record(fin), escalation
    };
    finStore.delete(pass.f);
    postSystem('requests', item);
    audit(u, 'ESCALATION_CREATED', `${escalation.id} · ${item.company} — ${aed(amount)} · failed: ${failedLabels} · ${just}`, item);
    notifyMany(people.map(p => p.key), `ESCALATION ${escalation.id} — ${u.name} needs a management decision on ${id} · ${item.company} · ${aed(amount)}. Failed: ${failedLabels}. Reason: ${just}`, id, u.key);
    notify('sven', `Escalated to management — ${id} · ${item.company} · ${aed(amount)} (${failedLabels} failed). You give the final approval if management approves.`, id);
    s.json({ ok: true, id, item: reqOut(u, item) });
  });

  // Management decision: any one of the three decides. APPROVE overrides the failed checks (Sven still gives the
  // final approval), REJECT declines and unlocks the client, INFO sends it back to the requester.
  app.post('/api/requests/:id/escalation', requireAuth, (q, s) => {
    const u = q.user, b = q.body || {};
    if (!isManagement(u)) return fail(s, 403, 'Only management (Mr. Adnan, Mr. Ahmed, Mr. Eduard) can decide an escalation.');
    const r = find(q, s); if (!r) return;
    if (!r.escalation || !['ESCALATED', 'MGMT_INFO'].includes(r.status)) return fail(s, 409, 'This request is not waiting for a management decision.');
    if (r.by === u.key || r.escalation.by === u.key) return fail(s, 403, 'You raised this escalation — one of the other members of management decides it.');
    const action = String(b.action || '').toUpperCase(), note = str(b.note, 2000);
    if (!['APPROVE', 'REJECT', 'INFO'].includes(action)) return fail(s, 400, 'Choose approve, reject or request more information.');
    if (note.length < 3) return fail(s, 422, 'Add a note for the record.');
    const at = new Date().toISOString(), atText = AUDIT_DAY(), who = titled(u);
    const decision = { action, by: u.key, byName: u.name, title: u.title || '', at, atText, note };
    const escalation = { ...r.escalation, decision, log: (r.escalation.log || []).concat([{ at, atText, who: u.key, whoName: u.name, action, note }]) };
    const words = { APPROVE: 'approved the escalation — proceed', REJECT: 'rejected the escalation', INFO: 'asked for more information' }[action];
    const next = { ...r, escalation, status: { APPROVE: 'MGMT_APPROVED', REJECT: 'DECLINED', INFO: 'MGMT_INFO' }[action], timeline: line(r, `${who} ${words} — ${note}`) };
    if (action === 'REJECT') Object.assign(next, { approved: 0, notes: `Escalation rejected by ${who} — ${note}`, flagged: false });
    postSystem('requests', next);
    audit(u, { APPROVE: 'ESCALATION_APPROVED', REJECT: 'ESCALATION_REJECTED', INFO: 'ESCALATION_INFO_REQUESTED' }[action], `${escalation.id} · ${r.id} · ${r.company} — ${note}`, next);
    const text = `${r.id} · ${r.company}: ${who} ${words} — ${note}`;
    notify(r.by, action === 'INFO' ? `Management needs more information — ${text}` : text, r.id);
    if (action === 'APPROVE') notify('sven', `Management approved — your final approval is needed. ${text}`, r.id);
    else notify('sven', text, r.id);
    notifyMany(management().map(p => p.key), text, r.id, u.key);
    s.json({ ok: true, item: reqOut(u, next) });
  });

  // The requester answers management's question: back to Awaiting Management Decision.
  app.post('/api/requests/:id/escalation/reply', requireAuth, (q, s) => {
    const u = q.user, r = find(q, s); if (!r) return;
    if (r.status !== 'MGMT_INFO') return fail(s, 409, 'Management has not asked for more information on this request.');
    if (!(r.by === u.key || isOpsMaster(u))) return fail(s, 403, 'Only the requester can answer management.');
    const note = str(q.body?.note, 2000);
    if (note.length < 3) return fail(s, 422, 'Write the information management asked for.');
    const at = new Date().toISOString(), atText = AUDIT_DAY();
    const escalation = { ...r.escalation, decision: null, log: (r.escalation.log || []).concat([{ at, atText, who: u.key, whoName: u.name, action: 'REPLY', note }]) };
    const next = { ...r, escalation, status: 'ESCALATED', timeline: line(r, `${u.name} answered management — ${note}`) };
    postSystem('requests', next);
    audit(u, 'ESCALATION_INFO_PROVIDED', `${escalation.id} · ${r.id} · ${r.company} — ${note}`, next);
    notifyMany(management().map(p => p.key).concat('sven'), `${u.name} answered management on ${r.id} · ${r.company}: ${note}`, r.id, u.key);
    s.json({ ok: true, item: reqOut(u, next) });
  });

  // Void: Sven and management only. The request stays on record, locked; the client is free for a new request.
  app.post('/api/requests/:id/void', requireAuth, (q, s) => {
    const u = q.user;
    if (!(isMaster(u) || isManagement(u))) return fail(s, 403, 'Only Sven and management can void a request.');
    const r = find(q, s); if (!r) return;
    if (r.status === 'VOID') return fail(s, 409, 'This request is already voided.');
    const reason = str(q.body?.reason, 1000);
    if (reason.length < 5) return fail(s, 422, 'A reason is required to void a request.');
    const at = new Date().toISOString(), atText = AUDIT_DAY(), who = isMaster(u) ? u.name : titled(u);
    const next = { ...r, status: 'VOID', flagged: false, voided: { by: u.key, byName: u.name, at, atText, reason, prevStatus: r.status }, timeline: line(r, `${who} voided this request — ${reason}`) };
    postSystem('requests', next);
    audit(u, 'REQUEST_VOIDED', `${r.id} · ${r.company} — was ${r.status} — ${reason}`, next);
    notifyMany([r.by], `${r.id} · ${r.company} was voided by ${who}: ${reason}. A new request can be raised for this client.`, r.id, u.key);
    notifyMany(['sven'].concat(r.escalation ? management().map(p => p.key) : []), `${r.id} · ${r.company} voided by ${who} — ${reason}`, r.id, u.key);
    s.json({ ok: true, item: reqOut(u, next) });
  });

  // Chase invoice: at any stage (not once voided). New invoice / receipt + note → history, audit, Finance team.
  app.post('/api/requests/:id/chase', requireAuth, async (q, s) => {
    const u = q.user, r = find(q, s); if (!r) return;
    if (r.status === 'VOID') return fail(s, 409, VOID_LOCKED);
    const note = str(q.body?.note, 1000), docs = await cleanDocs(q.body?.docs);
    if (!note && !docs.length) return fail(s, 422, 'Add a note or attach the invoice / receipt.');
    const cur = db.requests.find(x => x.id === r.id) || r; // re-read: files were checked asynchronously
    if (cur.status === 'VOID') return fail(s, 409, VOID_LOCKED);
    const names = docs.map(d => d.name).join(', ');
    const next = { ...cur, docs: (cur.docs || []).concat(docs), timeline: line(cur, `${u.name} chased the invoice` + (docs.length ? ` — attached ${names}` : '') + (note ? `: ${note}` : '')) };
    postSystem('requests', next);
    audit(u, 'INVOICE_CHASED', `${r.id} · ${r.company}` + (docs.length ? ` — ${docs.length} file${docs.length > 1 ? 's' : ''}: ${names}` : '') + (note ? ` — ${note}` : ''), next);
    const text = `Invoice chase — ${r.id} · ${r.company}: ${u.name}` + (docs.length ? ` attached ${names}` : '') + (note ? ` — ${note}` : '');
    notifyMany(financeTeam().map(x => x.key).concat(r.by), text, r.id, u.key);
    s.json({ ok: true, item: reqOut(u, next) });
  });
}

// ---- platform reset: back up, then remove test data ----
const BDIR = path.join(path.dirname(FILE), 'backups');
const BINDEX = path.join(BDIR, 'index.json');
async function backups() {
  try { return JSON.parse(fs.readFileSync(BINDEX, 'utf8')); } catch {}
  try { const v = cloudOn ? await kvGet('onelink:backups') : null; return v ? JSON.parse(v) : []; } catch { return []; }
}
async function takeBackup(u, reason) {
  const at = new Date(), id = 'BK-' + at.toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + hex(2);
  const counts = Object.fromEntries(COLS.map(c => [c, db[c].length]));
  const body = JSON.stringify({ id, at: at.toISOString(), by: u.name, reason, db });
  fs.mkdirSync(BDIR, { recursive: true });
  fs.writeFileSync(path.join(BDIR, id + '.json'), body);
  if (cloudOn) await kvSet('onelink:backup:' + id, body); // must land before anything is removed
  const all = [{ id, at: at.toISOString(), atText: AUDIT_DAY(), by: u.name, reason, counts }].concat(await backups());
  const list = all.slice(0, 10);
  for (const old of all.slice(10)) { // the ten newest are kept; older copies are deleted from disk and Upstash
    try { fs.unlinkSync(path.join(BDIR, old.id + '.json')); } catch {}
    if (cloudOn) kvDel('onelink:backup:' + old.id).catch(e => console.error('Old backup not deleted:', old.id, e.message));
  }
  fs.writeFileSync(BINDEX, JSON.stringify(list));
  if (cloudOn) await kvSet('onelink:backups', JSON.stringify(list)).catch(e => console.error('Backup index not mirrored:', e.message));
  return id;
}
async function readBackup(id) {
  if (!/^BK-[0-9TZ]+-[0-9A-F]{4}$/.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(BDIR, id + '.json'), 'utf8')); } catch {}
  try { const v = cloudOn ? await kvGet('onelink:backup:' + id) : null; return v ? JSON.parse(v) : null; } catch { return null; }
}
let resetting = false;
function mountReset(app) {
  const masterOnly = (q, s, next) => isMaster(q.user) ? next() : s.status(403).json({ ok: false, error: 'Master Administrator only.' });
  const uName = k => (loadUsers().find(x => x.key === k) || {}).name || k;
  app.get('/api/admin/reset/preview', requireAuth, masterOnly, async (_q, s) => {
    const live = db.requests.filter(r => !isHistory(r));
    s.json({ ok: true, live: live.map(r => ({ id: r.id, company: r.company, by: r.by, byName: uName(r.by), status: r.status, requested: r.requested, date: r.date })),
      history: { requests: db.requests.length - live.length }, notifications: db.notifications.length, audit: db.audit.length, chat: db.chat.length,
      lastReset: db.lastReset || null, backups: await backups() });
  });
  app.post('/api/admin/reset', requireAuth, masterOnly, async (q, s) => {
    const u = q.user, b = q.body || {}, reason = str(b.reason, 500);
    if (b.confirm !== 'RESET') return s.status(422).json({ ok: false, error: 'Type RESET to confirm.' });
    if (reason.length < 5) return s.status(422).json({ ok: false, error: 'Give a reason for the record.' });
    if (resetting) return s.status(409).json({ ok: false, error: 'A reset is already running.' });
    const want = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
    const remove = new Set(db.requests.filter(r => (want.has(r.id) && !isHistory(r)) || (b.includeHistory === true && isHistory(r))).map(r => r.id));
    if (!remove.size && !b.clearNotifications) return s.status(422).json({ ok: false, error: 'Nothing selected to remove.' });
    resetting = true;
    try {
      let backupId;
      try { backupId = await takeBackup(u, reason); }
      catch (e) { console.error('Backup failed:', e.message); return s.status(502).json({ ok: false, error: 'The backup could not be saved — nothing was removed. ' + e.message }); }
      const floor = db.requests.reduce((a, r) => Math.max(a, numOf(r.id)), db.floorNo || 0);
      const before = Object.fromEntries(COLS.map(c => [c, db[c].length]));
      const hist = b.includeHistory === true;
      const tied = x => remove.has(x.req);
      db.requests = db.requests.filter(r => !remove.has(r.id));
      db.chat = db.chat.filter(x => !tied(x) && !(hist && LEDGER_IDS.chat.has(x.id)));
      db.notifications = b.clearNotifications ? [] : db.notifications.filter(x => !tied(x) && !(hist && LEDGER_IDS.notifications.has(x.id)));
      db.audit = db.audit.filter(x => !tied(x) && !(hist && LEDGER_IDS.audit.has(x.id)));
      db.purged = [...new Set((db.purged || []).concat([...remove]))];
      db.floorNo = floor;
      const removed = Object.fromEntries(COLS.map(c => [c, before[c] - db[c].length]));
      db.resetAt = new Date().toISOString();
      db.lastReset = { at: db.resetAt, atText: AUDIT_DAY(), by: u.name, reason, backupId, removed, includeHistory: hist };
      refused.clear(); pendingZoho.clear(); remaps.clear(); finStore.clear();
      M_finance.invalidate();
      db.rev++; persist();
      audit(u, 'PLATFORM_RESET', `${removed.requests} requests, ${removed.chat} chat records, ${removed.notifications} notifications and ${removed.audit} audit entries removed${hist ? ' (history included)' : ''} · backup ${backupId} · ${reason}`, null);
      broadcast({ type: 'reload' });
      console.log(`Platform reset by ${u.name}: ${JSON.stringify(removed)} · backup ${backupId}`);
      s.json({ ok: true, backupId, removed, kept: Object.fromEntries(COLS.map(c => [c, db[c].length])) });
    } finally { resetting = false; }
  });
  app.post('/api/admin/reset/restore', requireAuth, masterOnly, async (q, s) => {
    const u = q.user, b = q.body || {};
    if (b.confirm !== 'RESTORE') return s.status(422).json({ ok: false, error: 'Type RESTORE to confirm.' });
    if (resetting) return s.status(409).json({ ok: false, error: 'A reset or restore is already running.' });
    const bk = await readBackup(b.backupId);
    if (!bk || !bk.db || !Array.isArray(bk.db.requests)) return s.status(404).json({ ok: false, error: 'Backup not found.' });
    resetting = true;
    try {
      let safety;
      try { safety = await takeBackup(u, 'Before restoring ' + bk.id); } // what is on the platform now stays recoverable
      catch (e) { return s.status(502).json({ ok: false, error: 'The current data could not be backed up — nothing was restored. ' + e.message }); }
      const floor = db.requests.reduce((a, r) => Math.max(a, numOf(r.id)), db.floorNo || 0);
      db = Object.assign({ rev: 0, requests: [], chat: [], notifications: [], audit: [] }, bk.db, { rev: Math.max(db.rev, bk.db.rev || 0) + 1 });
      db.floorNo = Math.max(floor, bk.db.floorNo || 0); // numbers handed out since the backup are never reissued
      refused.clear(); pendingZoho.clear(); remaps.clear(); finStore.clear();
      M_finance.invalidate();
      persist();
      audit(u, 'PLATFORM_RESTORED', `Restored backup ${bk.id} taken ${bk.at} by ${bk.by} · the data it replaced is in backup ${safety}`, null);
      broadcast({ type: 'reload' });
      s.json({ ok: true, restored: bk.id, safetyBackupId: safety, counts: Object.fromEntries(COLS.map(c => [c, db[c].length])) });
    } finally { resetting = false; }
  });
}

function mount(app) {
  app.get('/api/sync/snapshot', requireAuth, (q, s) => {
    const u = q.user, out = { rev: db.rev, me: pub(u), empty: db.requests.length === 0 && !db.resetAt };
    for (const c of COLS) out[c] = db[c].filter(x => visible(u, c, x)).map(x => redact(u, c, x));
    out.accounts = loadUsers().map(u => pub(u));
    s.json(out);
  });

  // The history comes from ledger.json on the server; a browser's built-in copy is never uploaded.
  app.post('/api/sync/bootstrap', requireAuth, (q, s) => s.status(409).json({ ok: false, error: 'The server loads its history from ledger.json — browser data is not accepted.' }));

  // Master Admin adds historical items the server does not have yet — ids already present are never touched.
  // Each new item is slotted in by date ('09 Apr') so the newest-first order holds; existing order is kept.
  app.post('/api/sync/merge', requireAuth, (q, s) => {
    if (!isMaster(q.user)) return s.status(403).json({ ok: false });
    const { col, items } = q.body || {};
    if (!COLS.includes(col) || !Array.isArray(items)) return s.status(400).json({ ok: false, error: 'col + items[] required' });
    const gone = new Set(db.purged || []);
    const strip = x => { const c = { ...x }; for (const k of SERVER_FIELDS.concat(['zohoClientId', 'zohoToken', 'zohoSubmitToken', 'override'])) delete c[k]; return c; };
    const added = mergeMissing(col, col === 'requests' ? items.filter(x => x && typeof x === 'object' && !gone.has(x.id) && !SERVER_STATUS.includes(x.status)).map(strip) : items);
    if (!added) return s.json({ ok: true, added: 0, rev: db.rev });
    db.rev++; persist();
    broadcast({ type: 'reload' });
    s.json({ ok: true, added, rev: db.rev });
  });

  app.post('/api/sync/put', requireAuth, (q, s) => {
    if (resetting) return s.status(503).json({ ok: false, error: 'A platform reset is running — try again in a moment.' });
    const { col, item } = q.body || {};
    if (!COLS.includes(col) || !item || typeof item !== 'object' || typeof item.id !== 'string') return s.status(400).json({ ok: false, error: 'col + item.id required' });
    if (col === 'requests' && ['timeline', 'docs'].some(k => item[k] !== undefined && (!Array.isArray(item[k]) || item[k].some(x => !x || typeof x !== 'object'))))
      return s.status(400).json({ ok: false, error: 'timeline and docs must be lists of entries' });
    let renamed = null;
    const sentId = item.id; // the number the browser used, before any renumbering
    if (col === 'requests') {
      const fresh = typeof item.zohoSubmitToken === 'string';
      const mapped = resolveRequestId(q.user.key, item.id);
      const ownReal = db.requests.find(x => x.id === item.id && x.by === q.user.key);
      if (mapped !== item.id && (fresh || !ownReal)) item.id = mapped; // the renamed new request — never the user's real one
      else {
        const taken = db.requests.find(x => x.id === item.id);
        const reused = !taken && numOf(item.id) <= (db.floorNo || 0); // a number from before the last reset
        if ((taken && (taken.by !== item.by || (fresh && !sameSubmission(item, taken)))) || reused) {
          renamed = nextRequestId(); // its mapping is recorded below, once the request is accepted
          console.log(`Request number ${item.id} ${taken ? 'already belongs to ' + taken.by : 'was used before the last reset'}; ${q.user.key}'s new request saved as ${renamed}.`);
          item.id = renamed;
        }
      }
    } else if (typeof item.req === 'string') item.req = resolveRequestId(q.user.key, item.req, 10 * 60_000);
    const prev = db[col].find(x => x.id === item.id) || null;
    if (!mayWrite(q.user, col, item, prev)) {
      if (col === 'requests' && prev && restricted(q.user) && prev.by !== q.user.key) audit(q.user, 'ACCESS_DENIED', `Tried to change ${prev.id} (${prev.company}), created by ${prev.by}`, prev);
      const why = col === 'requests' && prev && prev.status === 'VOID' ? VOID_LOCKED
        : col === 'requests' && prev && prev.by !== q.user.key && restricted(q.user) ? NO_ACCESS
        : col === 'requests' && prev && prev.status !== item.status ? 'That status change is not permitted — escalations are decided by management, and voided requests are locked.'
        : 'Not permitted';
      return s.status(403).json({ ok: false, error: why });
    }
    if (col === 'requests') {
      // Server-owned fields: always the stored value (or absent on a new request), whatever the browser sent.
      for (const k of SERVER_FIELDS) { if (prev && prev[k] !== undefined) item[k] = prev[k]; else delete item[k]; }
      if (prev && (ops(q.user) || q.user.dept === 'MANAGEMENT')) {
        for (const k of OPS_FIXED) { if (prev[k] !== undefined) item[k] = prev[k]; else delete item[k]; }
        if (prev.zohoStatus) item.zohoStatus = prev.zohoStatus; // Operations may only mark an unchecked request 'Not validated'
      }
      if (prev && q.user.dept === 'MANAGEMENT' && !isMaster(q.user)) { // notes and files only: every other field stays as stored
        const keep = { ...prev, notes: item.notes, docs: item.docs, timeline: item.timeline };
        for (const k of Object.keys(item)) delete item[k];
        Object.assign(item, keep);
        const seen = new Set((item.timeline || []).map(t => t.at + '|' + t.text));
        const lost = (prev.timeline || []).filter(t => !seen.has(t.at + '|' + t.text));
        if (lost.length) item.timeline = lost.concat(item.timeline || []);
      }
    }
    if (col === 'requests' && prev && OPEN.includes(item.status) && !OPEN.includes(prev.status)) {
      const other = pendingRequestFor(item.zohoClientId);
      if (other && other.id !== item.id) return s.status(409).json({ ok: false, reason: 'REQUEST_PENDING', error: `${other.id} is already open for this client — ${item.id} cannot be re-opened.`, pendingId: other.id });
    }
    if (col === 'requests' && !prev) {
      const bad = newRequestProblem(q.user, item);
      if (bad) {
        refused.set(q.user.key + ':' + sentId, { reason: bad.error, at: Date.now() });
        for (const n of db.notifications) // its notification may already be here
          if (n.req === sentId && n.to === 'sven' && n.text.startsWith(q.user.name + ' requested') && Date.now() - (n._at || 0) < 120_000) postSystem('notifications', notSubmitted(n, bad.error));
        console.log(`New request ${sentId} from ${q.user.key} refused: ${bad.reason}`);
        return s.status(bad.status).json({ ok: false, reject: true, ...bad });
      }
      const pass = M_gate.unsign(item.zohoSubmitToken), fin = pass && finGet(pass.f, q.user.key);
      if (fin) { item.finance = M_finance.record(fin); finStore.delete(pass.f); }
      // Nothing decided yet: whatever a browser put in these is dropped; the client is the one the checks ran for.
      Object.assign(item, { approved: null, credited: 0, flagged: false });
      for (const k of ['zohoStatus', 'zohoBalance', 'zohoReason', 'zohoValidationId', 'zohoCheckedAt', 'override', 'escalatedBy']) delete item[k];
      if (pass && pass.n) item.zohoClient = item.person = String(pass.n);
      delete item.zohoSubmitToken; // single use, not stored
      refused.delete(q.user.key + ':' + sentId); // a corrected retry under the same number is a real request
      if (renamed) remaps.set(q.user.key + ':' + sentId, { id: renamed, at: Date.now() });
    }
    if (col === 'notifications' && !prev && item.req && refused.has(q.user.key + ':' + item.req)) Object.assign(item, notSubmitted(item, refused.get(q.user.key + ':' + item.req).reason));
    if (col === 'notifications' && !prev) item._at = Date.now();
    if (col === 'requests' && prev && restricted(q.user)) restoreHidden(item, prev);
    if (col === 'requests' && !prev) Object.assign(item, { requestorId: item.by, clientId: item.zohoClientId || null, createdAt: new Date().toISOString() }); // tags
    // A browser can send two versions of one request back to back (created, then the Zoho result added);
    // if the older lands last it must not erase the Zoho result or its history line.
    if (col === 'requests' && prev && prev.zohoStatus && !item.zohoStatus) {
      for (const k of ['zohoStatus', 'zohoBalance', 'zohoReason', 'zohoValidationId', 'zohoCheckedAt', 'flagged']) if (prev[k] !== undefined) item[k] = prev[k];
      const have = new Set((item.timeline || []).map(t => t.at + '|' + t.text));
      const lost = (prev.timeline || []).filter(t => /^Zoho (Analytics|balance check)/.test(t.text) && !have.has(t.at + '|' + t.text));
      if (lost.length) item.timeline = (item.timeline || []).concat(lost);
    }
    // What the server added (escalation, decisions, void, invoice chases) survives a browser that still holds an older copy.
    if (col === 'requests' && prev) {
      const seen = new Set((item.timeline || []).map(t => t.at + '|' + t.text));
      const lostLines = (prev.timeline || []).filter(t => t.srv && !seen.has(t.at + '|' + t.text) && !seen.has(t.at + '|' + hideAmounts(t.text)));
      if (lostLines.length) item.timeline = (item.timeline || []).concat(lostLines);
      const files = new Set((item.docs || []).map(d => d.fileId).filter(Boolean));
      const lostDocs = (prev.docs || []).filter(d => d.srv && d.fileId && !files.has(d.fileId));
      if (lostDocs.length) item.docs = (item.docs || []).concat(lostDocs);
    }
    if (col === 'requests' && item.by === q.user.key) {
      const k = q.user.key + ':' + sentId, z = pendingZoho.get(k);
      if (z && (!z.clientId || String(z.clientId) === String(item.zohoClientId || ''))) { Object.assign(item, withZoho(item, z)); pendingZoho.delete(k); }
    }
    upsert(col, item);
    broadcast({ type: 'put', col, item, rev: db.rev, by: q.user.key }, col, item);
    if (col === 'requests') audit(q.user, !prev ? 'REQUEST_CREATED' : prev.status !== item.status ? 'REQUEST_' + item.status : 'REQUEST_EDITED',
      !prev ? `${item.company} — ${item.requested} AED` : prev.status !== item.status ? `${prev.status} → ${item.status}` : 'Details updated', item);
    s.json({ ok: true, rev: db.rev, id: item.id, renamed });
  });

  app.get('/api/sync/stream', requireAuth, (q, s) => {
    s.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    s.flushHeaders();
    const c = { res: s, user: q.user };
    clients.add(c);
    send(c, { type: 'hello', rev: db.rev, online: clients.size });
    const hb = setInterval(() => s.write(`: hb ${Date.now()}\n\n`), 20000);
    q.on('close', () => { clearInterval(hb); clients.delete(c); });
  });

  app.get('/api/sync/health', (_q, s) => s.json({ ok: true, rev: db.rev, online: clients.size }));

  // Opening a request: logged (once a minute per person and request); someone else's → refused and logged.
  app.post('/api/audit/view', requireAuth, (q, s) => {
    const id = String(q.body?.req || ''), r = db.requests.find(x => x.id === id);
    if (!r) return s.status(404).json({ ok: false, error: 'No such request' });
    if (!visible(q.user, 'requests', r)) { audit(q.user, 'ACCESS_DENIED', `Tried to open ${r.id}, created by ${r.by}`, r); return s.status(403).json({ ok: false, error: NO_ACCESS }); }
    const k = q.user.key + ':' + id;
    if (Date.now() - (viewed.get(k) || 0) > 60_000) { viewed.set(k, Date.now()); audit(q.user, 'REQUEST_VIEWED', `${r.id} · ${r.company}`, r); }
    s.json({ ok: true });
  });

  mountRequests(app);
  mountReset(app);
}

// Security log, written by the server: every request created, edited, decided, viewed, or refused.
const AUDIT_DAY = () => new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', ' ·');
function audit(u, action, detail, r) {
  postSystem('audit', { id: 'sa' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), at: AUDIT_DAY(), user: u.name, userId: u.key, dept: u.dept,
    action, detail, req: r ? r.id : '', client: r ? (r.zohoClient || r.person || r.company || '') : '', clientId: r ? r.zohoClientId || '' : '', by: 'server' });
}
const viewed = new Map(); // `${user}:${req}` -> last logged

// Server-authored items (funding-check results): stored and pushed live like any user write.
function postSystem(col, item) {
  upsert(col, item);
  broadcast({ type: 'put', col, item, rev: db.rev, by: 'system' }, col, item);
  return item;
}

const wasRefused = (userKey, id) => !!(id && refused.has(userKey + ':' + id) && !db.requests.some(r => r.id === resolveRequestId(userKey, id) && r.by === userKey));
const getRequest = id => db.requests.find(r => r.id === id) || null;
const status = () => ({ lastReset: db.lastReset || null, requests: db.requests.length });

const canSee = (u, r) => visible(u, 'requests', r);

const isFinanceUser = u => isMaster(u) || (u.dept === 'FINANCE' && u.active !== false);

return { mount, postSystem, resolveRequestId, attachZohoResult, attachFinance, awaitOwnRequest, pendingRequestFor, wasRefused, isOps: restricted, finPut, getRequest, canSee, committedFor, isFinanceUser, status };
})();

// ---- server.js ----
const { booksSearchClients, booksGetContact, booksFindContactExact, analyticsBalance, prefetchBalances, balancesFresh, accessToken, zohoReady, config: zohoConfig } = M_zoho;
const { decide, MSG, STATUS } = M_rules;
const { appendRecord } = M_sheets;
const gate = M_gate;
const auth = M_auth;
const store = M_store;

const E = process.env;
// Express 4 does not catch errors thrown in async handlers: log them instead of letting one bad request stop the server.
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.stack || e));
const app = express();
const origins = (E.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o) || origins.includes('*') || /\.onrender\.com$/.test(o)), credentials: true }));
app.use(express.json({ limit: '12mb' }));

// Session id (cookie) — the one-attempt lock is keyed on it.
app.use((q, s, next) => {
  const m = /(?:^|;\s*)ol_sid=([A-Za-z0-9_-]{16,})/.exec(q.headers.cookie || '');
  q.sid = m ? m[1] : crypto.randomBytes(18).toString('base64url');
  if (!m) s.append('Set-Cookie', `ol_sid=${q.sid}; Path=/; HttpOnly; Secure; SameSite=None`);
  next();
});

auth.mount(app);
store.mount(app);
// Every Zoho route requires a signed-in session — no guest or anonymous access.
app.use('/api/zoho', auth.requireAuth);

const NOT_FOUND_MSG = MSG.NOT_FOUND;
const REVIEWER = 'Sven';
const zohoErr = (s, e) => s.status(e.code === 'ENV' ? 500 : e.code === 'AUTH' ? 401 : e.code === 'RATE' ? 429 : 502)
  .json({ ok: false, reason: 'ZOHO_UNAVAILABLE', code: e.code, error: e.message });

async function notifySven(text, extra) {
  if (!E.SVEN_WEBHOOK_URL) return false;
  try { await fetch(E.SVEN_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...extra }) }); return true; }
  catch { return false; }
}

// Dubai time, in the formats the platform already uses ('02 Oct', '14:05', '02 Oct · 14:05').
function stamp(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  const mo = String(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(p.month) + 1).padStart(2, '0');
  return { day: Number(p.day) + ' ' + p.month, at: p.hour + ':' + p.minute, both: p.day + ' ' + p.month + ' · ' + p.hour + ':' + p.minute, sheet: `${p.year}-${mo}-${p.day} ${p.hour}:${p.minute}:${p.second} GST` };
}
const aed = n => 'AED ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

app.get('/api/health', async (_q, s) => s.json({ ok: true, zoho: await zohoReady, live: zohoConfig(), balancesFresh: balancesFresh(), financeFresh: M_finance.fresh(), sheet: !!(E.GOOGLE_SHEET_ID && E.GOOGLE_SERVICE_ACCOUNT_B64), lastReset: store.status().lastReset, time: new Date().toISOString() }));

app.get('/api/zoho/test', async (_q, s) => {
  try { await accessToken(); s.json({ ok: true, oauth: 'refreshed', live: zohoConfig() }); } catch (e) { zohoErr(s, e); }
});

// STEP 1a — type-ahead. Live Zoho Books customers matching the typed letters (2+).
app.get('/api/zoho/clients', async (q, s) => {
  const term = typeof q.query.q === 'string' ? q.query.q.trim().slice(0, 100) : '';
  if (term.length < 2) return s.json({ ok: true, clients: [], tooShort: true });
  prefetchBalances(); M_finance.prefetch(); // so the balance and the financial checks are ready when a client is picked
  try {
    // The Books receivable is read for the financial checks only — never sent to the browser.
    const clients = (await booksSearchClients(term)).map(({ outstanding, ...c }) => { const p = store.pendingRequestFor(c.contactId); return p ? { ...c, pendingId: p.id } : c; });
    s.json({ ok: true, clients, notFound: !clients.length, message: clients.length ? '' : NOT_FOUND_MSG, source: 'Zoho Books · live' });
  } catch (e) { zohoErr(s, e); }
});

// Live Analytics balance in the shape the browser shows.
const balanceOut = rec => rec
  ? { found: true, available: rec.available, allocated: rec.allocated, used: rec.used, source: 'Zoho Analytics · live' }
  : { found: false, available: 0, allocated: 0, used: 0, source: 'Zoho Analytics · live' };

// STEP 1b — the user picked a client from the list. Only a Books contact_id is accepted: the name is
// re-read from Zoho Books, so nothing typed by hand can become a client. The balance is fetched right away.
app.post('/api/zoho/validate-client', async (q, s) => {
  const lk = gate.locked(q.sid);
  if (lk) return s.status(423).json({ found: false, locked: true, reason: 'WORKFLOW_LOCKED', error: NOT_FOUND_MSG, lockedName: lk.name });
  const contactId = String(q.body?.contactId ?? '');
  if (!/^\d{1,30}$/.test(contactId)) return s.status(400).json({ found: false, reason: 'SELECT_FROM_LIST', error: 'Select the client from the Zoho Books list — typed names are not accepted.' });

  let books;
  try { books = await booksGetContact(contactId); } catch (e) { return zohoErr(s, e); }
  if (!books || books.status !== 'active') {
    gate.lock(q.sid, contactId);
    await notifySven(`BLOCKED — fund request attempted for Zoho Books contact ${contactId}, which is not an active client.`, { contactId });
    return s.status(422).json({ found: false, locked: true, reason: 'CLIENT_NOT_FOUND', error: NOT_FOUND_MSG });
  }
  const pend = store.pendingRequestFor(books.contactId);
  if (pend) return s.status(409).json({ found: true, locked: true, reason: 'REQUEST_PENDING', error: MSG.LOCKED, pendingId: pend.id, clientName: books.contactName });
  M_finance.prefetch();
  if (store.isOps(q.user)) {
    prefetchBalances(); // validated in the background on Send — never shown to Operations
    return s.json({ found: true, clientName: books.contactName, companyName: books.companyName, clientId: books.contactId, matchedIn: 'Zoho Books',
      token: gate.issue(books.contactName, books.contactId, 'Zoho Books'), balance: { hidden: true } });
  }
  // The selection never waits long on Analytics: after 5 s the page shows "reading balance" and asks again.
  const balance = await Promise.race([
    analyticsBalance(books.contactId).then(balanceOut, e => ({ found: false, error: e.message, source: 'Zoho Analytics · not reachable' })),
    new Promise(r => setTimeout(() => r({ pending: true, source: 'Zoho Analytics · loading' }), 5000))
  ]);
  s.json({
    found: true, clientName: books.contactName, companyName: books.companyName, clientId: books.contactId, matchedIn: 'Zoho Books',
    token: gate.issue(books.contactName, books.contactId, 'Zoho Books'), balance
  });
});

// Re-read the selected client's balance (e.g. before sending, if the page sat open).
app.get('/api/zoho/client-balance', async (q, s) => {
  if (store.isOps(q.user)) return s.status(403).json({ ok: false, error: 'Balances are not shown to Operations.' });
  const contactId = String(q.query.contactId || '');
  if (!/^\d{1,30}$/.test(contactId)) return s.status(400).json({ ok: false, error: 'contactId required' });
  try { s.json({ ok: true, clientId: contactId, balance: balanceOut(await analyticsBalance(contactId)), checkedAt: new Date().toISOString() }); } catch (e) { zohoErr(s, e); }
});

// Send, step 1: the client is not locked and passes the three financial checks — Customer Fund Disbursement account,
// Cost of Goods Sold account, invoice payment verification (finance-rules.js). On success the browser gets a short-lived
// signed pass for exactly this user, client and amount; the server refuses a new request without it. On failure nothing
// is created and the browser gets an escalation pass instead: the request can go to management with a justification.
// Operations only learn which checks passed — never a balance or an amount.
app.post('/api/zoho/precheck', async (q, s) => {
  const b = q.body || {}, amount = Number(b.amount), opsUser = store.isOps(q.user), paid = typeof b.paid === 'string' ? b.paid.trim() : '';
  if (!(amount > 0) || !paid) return s.status(422).json({ ok: false, reason: 'MANDATORY_FIELDS', error: MSG.MANDATORY });
  let v;
  try { v = gate.verify(b.validationToken, typeof b.clientName === 'string' ? b.clientName : ''); } catch (e) { return zohoErr(s, e); }
  if (!v.ok) return s.status(403).json({ ok: false, reason: 'INVALID_VALIDATION_TOKEN', why: v.why, error: NOT_FOUND_MSG });
  const pend = store.pendingRequestFor(v.clientId);
  if (pend) return s.status(409).json({ ok: false, reason: 'REQUEST_PENDING', error: MSG.LOCKED, pendingId: pend.id });
  let fin;
  try { fin = await M_finance.run({ contactId: v.clientId, amount, paid, committed: store.committedFor(v.clientId) }); } catch (e) { return zohoErr(s, e); }
  store.finPut(fin, q.user.key);
  const view = opsUser ? M_finance.forOps(M_finance.record(fin)) : M_finance.record(fin);
  const cfd = fin.checks.find(c => c.key === 'CFD');
  if (!fin.ok) {
    const t = stamp();
    store.postSystem('notifications', {
      id: 'zb' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), to: 'sven', at: t.both, read: false, req: null,
      text: `Blocked — ${q.user.name} tried to request ${aed(amount)} for ${b.clientName}. Failed: ${fin.failed.map(f => f.label).join(', ')}. ${fin.staffError}`
    });
    return s.status(422).json({ ok: false, sufficient: cfd.ok, reason: 'FINANCIAL_CHECKS_FAILED', error: opsUser ? fin.opsError : fin.staffError,
      failed: fin.failed, finance: view, escalate: { allowed: true, token: gate.sign({ k: 'esc', u: q.user.key, c: v.clientId, a: amount, n: b.clientName, p: paid, f: fin.id }, 30 * 60 * 1000) } });
  }
  s.json({ ok: true, sufficient: true, status: STATUS.PROVISIONAL, submitToken: gate.sign({ k: 'submit', u: q.user.key, c: v.clientId, a: amount, n: b.clientName, p: paid, f: fin.id }, 15 * 60 * 1000),
    finance: view });
});

// Restart from the beginning — the only way to clear the lock.
app.post('/api/zoho/restart', (q, s) => { gate.unlock(q.sid); s.json({ ok: true }); });

// The approval/flag outcome as one record. It is posted to the group chat and that same exported
// record is what lands in the funding sheet, so the chat and the sheet can never disagree.
function exportRecord(req, d, user, ids) {
  const t = stamp();
  const rec = {
    requestId: req.requestId || null, clientName: req.clientName, clientId: d.clientId || null, companyName: d.companyName || req.company,
    requested: req.requestedAmount, approved: d.approvedAmount, balance: d.analyticsMatched ? d.available : 0,
    status: d.approvalStatus, reason: d.reason, notes: d.notes, timestamp: t.sheet, reviewer: REVIEWER,
    checkedBy: user.name, validationId: ids.validationId, checkedAt: ids.checkedAt
  };
  const chat = store.postSystem('chat', {
    id: 'z' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), day: t.day, at: t.at, who: 'Zoho', kind: 'msg', req: rec.requestId,
    // The group chat is shared with Operations: the balance stays in the structured record (Sven, sheet), not the text.
    text: `Zoho check · ${rec.clientName}${rec.requestId ? ' · ' + rec.requestId : ''} — requested ${aed(rec.requested)}. ${d.ok ? rec.status + '.' : d.publicNotes || rec.notes} Reviewer: ${REVIEWER}.`,
    zoho: rec
  });
  store.postSystem('notifications', {
    id: 'zn' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), to: 'sven', at: t.both, read: false, req: rec.requestId,
    text: (d.ok ? 'Pending your approval — ' : 'Flagged for your review — ') + `${rec.clientName}: ${aed(rec.requested)} requested, ${aed(rec.balance)} in Zoho Analytics. ${rec.notes}`
  });
  return chat.zoho;
}

// STEP 2 — balance check and approval/flag, then the sheet. Live Zoho Books + Zoho Analytics only.
app.post('/api/zoho/client-funding-check', async (q, s) => {
  const b = q.body || {};
  const req = {
    requestId: String(b.requestId || ''), clientName: typeof b.clientName === 'string' ? b.clientName : '',
    company: String(b.company || ''), purpose: String(b.purpose || ''), requestedAmount: Number(b.requestedAmount)
  };
  if (!req.clientName) return s.status(400).json({ ok: false, reason: 'BAD_REQUEST', error: 'clientName required' });
  if (!(req.requestedAmount > 0)) return s.status(400).json({ ok: false, reason: 'BAD_REQUEST', error: 'requestedAmount must be > 0' });

  // A token proves the client was picked from the Books list (it carries the contact_id).
  // Requests raised before the dropdown carry none and must match a Books contact exactly by name.
  let books;
  try {
    if (b.validationToken) {
      const v = gate.verify(b.validationToken, req.clientName);
      if (!v.ok) return s.status(403).json({ ok: false, reason: 'INVALID_VALIDATION_TOKEN', why: v.why, error: NOT_FOUND_MSG });
      books = await booksGetContact(v.clientId);
      if (books && books.contactName !== req.clientName) books = null;
    } else books = await booksFindContactExact(req.clientName);
  } catch (e) { return zohoErr(s, e); }

  // Hard stop: not in Zoho Books → no approval logic, no sheet row, nothing.
  if (!books) return s.status(422).json({ ok: false, clientMatched: false, reason: 'CLIENT_NOT_FOUND', approvalStatus: 'Not Approved', approvedAmount: 0, flagSven: true, error: NOT_FOUND_MSG, notes: NOT_FOUND_MSG, sheet: { written: false, why: 'client not in Zoho Books' } });

  // The browser pushes the new request alongside this check and it may get a new number: wait for it briefly,
  // so the chat record, Sven's notification and the sheet row all carry the request's final number.
  const sentId = req.requestId;
  if (sentId) req.requestId = await store.awaitOwnRequest(q.user.key, sentId);
  if (sentId && store.wasRefused(q.user.key, sentId)) return s.status(409).json({ ok: false, reason: 'REQUEST_NOT_SUBMITTED', error: 'The request was not submitted, so it was not checked.' });
  const stored = req.requestId ? store.getRequest(req.requestId) : null;
  if (stored && !store.canSee(q.user, stored)) return s.status(403).json({ ok: false, reason: 'NO_ACCESS', error: 'No access — request not created by you' });
  if (stored && stored.status === 'VOID') return s.status(409).json({ ok: false, reason: 'REQUEST_VOID', error: 'This request has been voided.' });
  // A check on a stored request is a check of THAT request: its client and its amount, never ones from the browser.
  if (stored && stored.zohoClientId && String(stored.zohoClientId) !== String(books.contactId))
    return s.status(409).json({ ok: false, reason: 'CLIENT_MISMATCH', error: `This check was for a different client than ${stored.id}.` });
  if (stored) req.requestedAmount = Number(stored.approved || stored.requested) || req.requestedAmount;

  // The balance and the three financial checks come from Zoho — if they cannot be read, nothing is decided.
  let rec, fin;
  try {
    [rec, fin] = await Promise.all([analyticsBalance(M_finance.canonical(books.contactId)), M_finance.run({ contactId: books.contactId, amount: req.requestedAmount, paid: stored ? stored.paid : String(b.paid || ''), books, committed: store.committedFor(books.contactId, stored ? stored.id : null) })]);
  } catch (e) { return zohoErr(s, e); }

  const d = decide({ req, books, rec, fin });
  const validationId = 'ZV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const checkedAt = new Date().toISOString();
  const exported = exportRecord(req, d, q.user, { validationId, checkedAt });
  const t = stamp();
  const attached = store.attachZohoResult(q.user.key, sentId, {
    zohoStatus: d.approvalStatus, zohoBalance: exported.balance, zohoReason: d.reason, zohoValidationId: validationId, zohoCheckedAt: checkedAt, flagged: !d.ok
  }, { at: t.day + ' · ' + t.at, text: `Zoho Analytics check — ${d.approvalStatus}${d.ok ? '' : '. ' + (d.reason === 'FINANCIAL_CHECKS_FAILED' ? 'Failed: ' + fin.failed.map(f => f.label).join(', ') : d.notes)}` }, books.contactId);
  // A check on an existing request by finance (Sven before approving / crediting): the request keeps the latest validation.
  if (!attached && stored && store.isFinanceUser(q.user)) store.attachFinance(stored.id, fin);

  let sheet;
  try {
    sheet = await appendRecord({ ...exported, notes: `${exported.reason} · ${exported.notes} · ${req.purpose} · ${exported.requestId || '—'} · ${validationId} · checked by ${exported.checkedBy}` });
  } catch (e) { sheet = { written: false, why: e.message }; }

  const svenSummary = { clientName: req.clientName, requestedAmount: req.requestedAmount, zohoAnalyticsBalance: exported.balance, approvalStatus: d.approvalStatus, flagReason: d.ok ? '' : d.notes };
  const svenNotified = await notifySven(`OneLink funding check — ${req.clientName}: ${d.approvalStatus}. Requested ${aed(req.requestedAmount)}, Zoho Analytics balance ${aed(exported.balance)}.${d.ok ? '' : ' ' + d.notes}`, { summary: svenSummary });

  const out = {
    ok: d.ok, reason: d.reason, approvalStatus: d.approvalStatus, approvedAmount: d.approvedAmount,
    clientMatched: d.clientMatched, booksMatched: d.booksMatched, analyticsMatched: d.analyticsMatched, relevancePassed: d.relevancePassed,
    clientId: d.clientId || null,
    availableBalance: d.available ?? 0, allocatedBalance: d.allocated ?? 0, usedBalance: d.used ?? 0,
    remainingAfterRequest: d.remaining ?? 0, requestedAmount: req.requestedAmount,
    notes: d.notes, flagSven: d.flagSven, svenNotified, svenSummary, sheet, reviewer: REVIEWER, exported, requestId: req.requestId || null, attachedToRequest: attached,
    source: 'Zoho Books + Zoho Analytics', validationId, checkedAt, finance: M_finance.record(fin)
  };
  if (store.isOps(q.user)) { // the result, never the balance
    for (const k of ['availableBalance', 'allocatedBalance', 'usedBalance', 'remainingAfterRequest', 'svenSummary', 'exported']) delete out[k];
    out.finance = M_finance.forOps(out.finance);
    if (!d.ok) out.notes = d.reason === 'FINANCIAL_CHECKS_FAILED' ? fin.opsError : MSG.OPS_INSUFFICIENT;
  }
  s.json(out);
});

// ---- documents: stored in Upstash (survives restarts) + local disk cache ----
const FILE_DIR = path.resolve('./data/files');
app.post('/api/files', M_auth.requireAuth, async (q, s) => {
  const { name, mime, data } = q.body || {};
  if (!name || typeof data !== 'string' || !data) return s.status(400).json({ ok: false, error: 'name + data required' });
  if (data.length > 10_000_000) return s.status(413).json({ ok: false, error: 'File over 7 MB' });
  const id = crypto.randomUUID();
  const meta = JSON.stringify({ name: String(name).slice(0, 200), mime: String(mime || 'application/octet-stream').slice(0, 100), by: q.user.name, at: Date.now() });
  try {
    fs.mkdirSync(FILE_DIR, { recursive: true });
    fs.writeFileSync(path.join(FILE_DIR, id), data); fs.writeFileSync(path.join(FILE_DIR, id + '.json'), meta);
    if (M_cloud.enabled) { await M_cloud.kvSet('onelink:file:' + id, data); await M_cloud.kvSet('onelink:filemeta:' + id, meta); }
    s.json({ ok: true, id });
  } catch (e) { console.error('File store failed:', e.message); s.status(502).json({ ok: false, error: 'Storage failed' }); }
});
app.get('/api/files/:id', M_auth.requireAuth, async (q, s) => {
  const id = String(q.params.id);
  if (!/^[0-9a-f-]{36}$/.test(id)) return s.status(400).end();
  let data = null, meta = null;
  const f = path.join(FILE_DIR, id);
  if (fs.existsSync(f)) { data = fs.readFileSync(f, 'utf8'); meta = fs.readFileSync(f + '.json', 'utf8'); }
  else if (M_cloud.enabled) { data = await M_cloud.kvGet('onelink:file:' + id); meta = await M_cloud.kvGet('onelink:filemeta:' + id); }
  if (!data) return s.status(404).json({ ok: false, error: 'File not found' });
  const m = JSON.parse(meta || '{}');
  s.set({ 'Content-Type': m.mime || 'application/octet-stream', 'Content-Disposition': 'inline; filename="' + String(m.name || 'file').replace(/[^\w. -]/g, '_') + '"' });
  s.send(Buffer.from(data, 'base64'));
});

// ---- Zoho Analytics discovery (lists what the server's Zoho login can see) ----
app.get('/api/zoho/analytics-discover', async (q, s) => {
  if (!E.DIAG_KEY || q.query.key !== E.DIAG_KEY) return s.status(403).json({ ok: false });
  try {
    const t = await accessToken(), base = 'https://analyticsapi.zoho.' + (E.ZOHO_DC || 'com') + '/restapi/v2';
    const h = o => ({ headers: Object.assign({ Authorization: 'Zoho-oauthtoken ' + t }, o ? { 'ZANALYTICS-ORGID': o } : {}) });
    const orgs = await (await fetch(base + '/orgs', h())).json();
    const ws = await (await fetch(base + '/workspaces', h())).json();
    const out = { orgs, workspaces: ws, views: {} };
    const all = [].concat(ws?.data?.ownedWorkspaces || [], ws?.data?.sharedWorkspaces || []);
    for (const w of all.slice(0, 10)) {
      const v = await (await fetch(base + '/workspaces/' + w.workspaceId + '/views', h(w.orgId))).json();
      out.views[w.workspaceName + ' (' + w.workspaceId + ', org ' + w.orgId + ')'] = (v?.data?.views || []).map(x => x.viewType + ' · ' + x.viewName + ' · ' + x.viewId);
    }
    if (q.query.view && q.query.ws && q.query.org) {
      const cfg = encodeURIComponent(JSON.stringify({ responseFormat: 'json' }));
      const r = await fetch(base + '/workspaces/' + q.query.ws + '/views/' + q.query.view + '/data?CONFIG=' + cfg, h(q.query.org));
      const txt = await r.text(); out.sample = { status: r.status, body: txt.slice(0, 3000) };
    }
    s.json(out);
  } catch (e) { s.status(502).json({ ok: false, error: e.message }); }
});

const __html = new URL('./index.html', import.meta.url);
// The Claude Design export has a few dates frozen at export time. Swap them for live ones as the page is served,
// so every new export stays current without hand edits. A rule whose text is not found in an export simply does nothing.
const TODAY = "new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })";
const LIVE_RULES = [
  // re-render every 30 s so the greeting, day line and times move on their own
  ['this._sess = setInterval(() => this.checkSession(), 15000);', "this._sess = setInterval(() => this.checkSession(), 15000); this._live = setInterval(() => this.setState({ liveNow: Date.now() }), 30000);"],
  ['clearInterval(this._sess);', 'clearInterval(this._sess); clearInterval(this._live);'],
  [/dayLine: '[A-Z][a-z]+day · \d{1,2} [A-Z][a-z]+ \d{4}',/, "dayLine: new Date().toLocaleDateString('en-GB', { weekday: 'long' }) + ' · ' + " + TODAY + ','],
  [/(requests · 18 March to )\d{1,2} [A-Z][a-z]+ \d{4}( · )/, "$1' + " + TODAY + " + '$2"],
  [/' messages · \d{1,2} to \d{1,2} [A-Z][a-z]+ \d{4}'/, "' messages · updated live'"],
  [/ — \d{1,2} to \d{1,2} [A-Z][a-z]+\.'/, ".'"]
];
let liveHtml = { mtime: 0, body: null };
function servedHtml() {
  const mtime = fs.statSync(__html).mtimeMs;
  if (liveHtml.mtime !== mtime) {
    let body = fs.readFileSync(__html, 'utf8'), hit = 0;
    for (const [from, to] of LIVE_RULES) { const next = body.replace(from, to); if (next !== body) hit++; body = next; }
    const wf = patchPage(body);
    body = wf.html;
    liveHtml = { mtime, body };
    console.log('Live dates: applied', hit, 'of', LIVE_RULES.length, 'rules to index.html');
    if (wf.hit) console.log('Zoho client workflow: applied', wf.hit, 'of', wf.total, 'rules');
    else console.error('Zoho client workflow NOT applied — this export no longer matches (' + wf.missed + '). The server still refuses typed client names.');
  }
  return liveHtml.body;
}
app.get(['/', '/app'], (req, res) => {
  try { res.set('Cache-Control', 'no-cache').type('html').send(servedHtml()); } catch (e) { res.status(404).send('index.html missing'); }
});
app.listen(E.PORT || 8787, () => console.log(`OneLink backend on :${E.PORT || 8787}`));
