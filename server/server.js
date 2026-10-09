import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { patchPage } from './client-workflow.js';
import { evaluateFinance, evaluateBooksCrossCheck, financeForOps } from './finance-rules.js';
import { ledgerHash, LEDGER_KEYS } from './ledger-hash.js';

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

// One Analytics HTTP call. A timeout / abort, a network error or a 5xx is retried once, always inside the job's deadline
// (each attempt's timeout is cut to the time left), so a slow moment at Zoho does not fail a whole refresh.
async function zaFetch(url, headers, deadline, what) {
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw zaErr(`Zoho Analytics export did not finish within ${JOB_DEADLINE / 1000} s`);
    const again = () => attempt === 0 && deadline - Date.now() > 1000;
    let res;
    try { res = await fetch(url, { headers, signal: AbortSignal.timeout(Math.min(15_000, left)) }); }
    catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      if ((timeout || e instanceof TypeError) && again()) { console.warn(`Zoho Analytics ${what}: ${e.message} — retrying once`); continue; }
      throw timeout ? zaErr(`Zoho Analytics ${what} timed out`) : e;
    }
    if (res.status >= 500 && again()) { await res.text().catch(() => {}); console.warn(`Zoho Analytics ${what}: HTTP ${res.status} — retrying once`); continue; }
    return res;
  }
}

async function analyticsSql(sql, what = 'balance') {
  const t = await accessToken();
  const h = { Authorization: 'Zoho-oauthtoken ' + t, 'ZANALYTICS-ORGID': zaOrg() };
  const base = `https://analyticsapi.zoho.${dc()}/restapi/v2/bulk/workspaces/${zaWs()}`;
  const check = async (res, what) => {
    if (res.ok) return res;
    if (res.status === 429) throw zaErr('Zoho Analytics rate limit', 'RATE');
    throw zaErr(`Zoho Analytics ${what} ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
  const t0 = Date.now(), deadline = t0 + JOB_DEADLINE;
  const r1 = await check(await zaFetch(`${base}/data?CONFIG=${encodeURIComponent(JSON.stringify({ sqlQuery: sql, responseFormat: 'csv' }))}`, h, deadline, what + ' export'), 'export');
  const jobId = (await r1.json())?.data?.jobId;
  if (!jobId) throw zaErr('Zoho Analytics returned no export job');
  for (let wait = 300; Date.now() - t0 < JOB_DEADLINE; wait = Math.min(wait * 1.4, 1000)) {
    await new Promise(r => setTimeout(r, wait));
    const r2 = await check(await zaFetch(`${base}/exportjobs/${jobId}`, h, deadline, what + ' job'), 'job');
    const code = String((await r2.json())?.data?.jobCode || '');
    if (code === '1003' || code === '1005') throw zaErr('Zoho Analytics export job failed (' + code + ')');
    if (code !== '1004') continue;
    const r3 = await check(await zaFetch(`${base}/exportjobs/${jobId}/data`, h, deadline, what + ' download'), 'download');
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
    // Logged once per refresh, however many callers wait on it.
    balancesLoading.catch(e => console.error('Zoho Analytics balance refresh failed:', e.message));
  }
  return balancesLoading;
}
// Fire-and-forget pre-load (called while the user is typing a client name); a failure is logged by refreshBalances.
function prefetchBalances() { if (Date.now() - balancesAt > BALANCE_TTL) refreshBalances().catch(() => {}); }
const balancesFresh = () => !!balances && Date.now() - balancesAt <= BALANCE_TTL;
const invalidateBalances = () => { balancesAt = 0; };

// Balance row for one Books contact, never older than BALANCE_TTL. null = no balance record in Analytics.
async function analyticsBalance(contactId) {
  if (!/^\d{1,30}$/.test(String(contactId || ''))) return null;
  if (!balancesFresh()) await refreshBalances();
  return balances.get(String(contactId)) || null;
}

// Connection verification before every balance check: both APIs must answer with the current OAuth token.
// Zoho Analytics and Zoho Books cannot authenticate each other — this proves each one is reachable and authorised now.
// A success is kept for CONN_TTL; a failure is never kept (the next check probes again).
const CONN_TTL = 60_000;
let lastConn = null, connOkAt = 0, connLoading = null;
const dubaiNow = d => d.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', ' ·');
function verifyConnections() {
  if (lastConn && lastConn.ok && Date.now() - connOkAt < CONN_TTL) return Promise.resolve(lastConn);
  if (connLoading) return connLoading;
  const probe = async fn => { const t0 = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t0 }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200) }; } };
  connLoading = (async () => {
    let t = null, tokenError = null;
    try { t = await accessToken(); } catch (e) { tokenError = { ok: false, ms: 0, error: 'Zoho OAuth: ' + String(e.message || e).slice(0, 180) }; }
    const [analytics, booksR] = tokenError ? [tokenError, tokenError] : await Promise.all([
      probe(async () => {
        const r = await fetch(`https://analyticsapi.zoho.${dc()}/restapi/v2/workspaces/${zaWs()}`, { headers: { Authorization: 'Zoho-oauthtoken ' + t, 'ZANALYTICS-ORGID': zaOrg() }, signal: AbortSignal.timeout(10_000) }).catch(e => ({ status: 0, text: async () => '', e }));
        await r.text().catch(() => {});
        if (r.status === 200) return;
        // The token may hold only the data scope (bulk export) and not workspace metadata: then the proof is a fresh
        // read of the balance table — the export every check uses anyway.
        if (r.status === 401 || r.status === 403) { await refreshBalances(); return; }
        throw new Error('Zoho Analytics workspace ' + (r.status || (r.e && r.e.message) || 'unreachable'));
      }),
      probe(async () => {
        const j = await books('contacts', { per_page: '1' });
        if (!j || !Array.isArray(j.contacts)) throw new Error('Zoho Books contacts: unexpected answer');
      })
    ]);
    const at = new Date();
    const res = { ok: analytics.ok && booksR.ok, at: at.toISOString(), atText: dubaiNow(at), analytics, books: booksR };
    lastConn = res;
    if (res.ok) connOkAt = Date.now();
    return res;
  })().finally(() => { connLoading = null; });
  return connLoading;
}
// The last verification without error text (public health endpoint).
const lastConnections = () => lastConn && { ok: lastConn.ok, at: lastConn.at, atText: lastConn.atText, analytics: { ok: lastConn.analytics.ok, ms: lastConn.analytics.ms }, books: { ok: lastConn.books.ok, ms: lastConn.books.ms } };

return { zohoReady, accessToken, exact, norm, num, books, verifyConnections, lastConnections, analyticsSql, booksSearchClients, booksGetContact, booksFindContactExact, analyticsBalance, prefetchBalances, balancesFresh, invalidateBalances, col, toRecord, config: () => ({ booksOrg: booksOrg() + ' (ELITE ONELINK CORPORATE SERVICES L.L.C S.O.C)', analyticsOrg: zaOrg(), workspace: zaWs(), table: zaTable() }) };
})();

// ---- finance.js ----
const M_finance = await (async () => {
const { analyticsSql, analyticsBalance, booksGetContact, num, invalidateBalances, books } = M_zoho;
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
  alias: `SELECT TO_STRING(A."Source Customer ID") AS "Source", TO_STRING(A."Canonical Customer ID") AS "Canonical" FROM "CFD Automatic Customer Aliases" A`,
  // Per client: what its invoices total, what is still open or written off, and what payments and credit notes were applied.
  // Every CFD / COGS ledger line of the last 46 days (all customers — a Books movement Analytics filed under another
  // customer is still synced), plus every credit-note line ever (so a credit note already in the ledger is never added twice).
  recent: since => `SELECT ${CUST('R."Resolved Customer ID"')} AS "Customer", TO_STRING(R."Account ID") AS "Account", TO_STRING(R."Entity ID") AS "Entity ID", TO_STRING(R."Transaction ID") AS "Transaction ID", R."Entity Type" AS "Entity Type", ROUND(COALESCE(R."Credit Amount", 0), 2) AS "Credit", ROUND(COALESCE(R."Debit Amount", 0), 2) AS "Debit", R."Transaction Date" AS "Date" FROM "CFD Customer Resolved" R ${ALIAS('R."Resolved Customer ID"')} WHERE R."Transaction Date" >= '${since}' OR R."Entity Type" = 'creditnote'`,
  // How far Analytics has synced: the newest "Last Modified Time" in the ledger lines.
  watermark: `SELECT MAX(R."Last Modified Time") AS "Watermark" FROM "CFD Customer Resolved" R`,
  inv: `WITH IP AS (SELECT "Invoice ID" AS Invoice_ID, SUM("Amount (BCY)") AS Paid FROM "Invoice Payments" GROUP BY "Invoice ID"), CN AS (SELECT "Invoice ID" AS Invoice_ID, SUM("Amount (BCY)") AS Credited FROM "Creditnotes Invoice" GROUP BY "Invoice ID") SELECT ${CUST('I."Customer ID"')} AS "Customer", COUNT(*) AS "Invoices", ROUND(SUM(I."Total (BCY)"), 2) AS "Invoiced", ROUND(SUM(I."Balance (BCY)"), 2) AS "Outstanding", ROUND(SUM(COALESCE(I."Write Off Amount (BCY)", 0)), 2) AS "Written off", ROUND(SUM(COALESCE(IP.Paid, 0)), 2) AS "Paid", ROUND(SUM(COALESCE(CN.Credited, 0)), 2) AS "Credited" FROM "Invoices" I ${ALIAS('I."Customer ID"')} LEFT JOIN IP ON I."Invoice ID" = IP.Invoice_ID LEFT JOIN CN ON I."Invoice ID" = CN.Invoice_ID WHERE I."Invoice Status" NOT IN ('Draft', 'Void') GROUP BY ${CUST('I."Customer ID"')}`
};
const key = v => String(v ?? '').trim().replace(/\.0+$/, '');
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${m[3]} ${MO[Number(m[2]) - 1]} ${m[1]}` : String(v || ''); };
const todayDubai = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }); // 'YYYY-MM-DD'
const daysBack = n => { const d = new Date(todayDubai() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

let data = null, dataAt = 0, loading = null;
// Duplicate Books contacts are folded onto one canonical contact in every Analytics table (CFD Customer Balances
// included). The picked contact may be the duplicate, so every lookup goes through this map. Changes rarely: 10 min.
let aliases = new Map(), aliasesAt = 0;
const ALIAS_TTL = 10 * 60_000;
const canonical = id => aliases.get(key(id)) || key(id);
let aliasLoading = null;
// In the background, after the other exports (Analytics allows five jobs at a time); checks use the last good map meanwhile.
function refreshAliases() {
  if (aliasLoading || Date.now() - aliasesAt <= ALIAS_TTL) return;
  aliasLoading = analyticsSql(SQL.alias, 'customer alias')
    .then(rows => { aliases = new Map(rows.map(r => [key(r.Source), key(r.Canonical)]).filter(([a, b]) => a && b && a !== b)); aliasesAt = Date.now(); })
    .catch(e => { aliasesAt = Date.now() - ALIAS_TTL + 60_000; console.error('Zoho Analytics customer aliases not refreshed:', e.message); }) // retry in a minute
    .finally(() => { aliasLoading = null; });
}
// Is this contact one of several Books contacts folded together (it, or another contact, maps onto the same canonical one)?
const grouped = id => { const k = canonical(id); return k !== key(id) || [...aliases.values()].includes(k); };
function refresh() {
  if (!loading) {
    loading = Promise.all([analyticsSql(SQL.split, 'CFD/COGS split'), analyticsSql(SQL.open, 'open invoice'), analyticsSql(SQL.pay, 'customer payment')])
      // The first load waits for the alias map (until then a duplicate contact would look like a client with nothing on file);
      // afterwards it refreshes in the background.
      .then(async res => {
        if (!aliasesAt) { refreshAliases(); await aliasLoading; } else refreshAliases();
        // Second batch: Analytics runs at most five export jobs at a time. The recent ledger lines and the watermark are
        // read right after the split, as one snapshot with it; they are only needed by the Books cross-verification.
        const [invR, recR, wmR] = await Promise.allSettled([analyticsSql(SQL.inv, 'invoice settlement'), analyticsSql(SQL.recent(daysBack(46)), 'recent ledger line'), analyticsSql(SQL.watermark, 'ledger watermark')]);
        let inv = null;
        if (invR.status === 'fulfilled') inv = invR.value;
        else {
          console.error('Zoho Analytics invoice settlement not read:', invR.reason.message);
          if (!(data && data.inv)) throw invR.reason; // never decide on a missing source — the check answers "Zoho unavailable"
        }
        // Never an older copy of the recent lines next to a newer split: a failed read leaves none (the cross-check then fails closed).
        if (recR.status === 'rejected') console.error('Zoho Analytics recent ledger lines not read:', recR.reason.message);
        if (wmR.status === 'rejected') console.error('Zoho Analytics ledger watermark not read:', wmR.reason.message);
        const recent = recR.status === 'fulfilled' ? {
          lines: recR.value.map(r => ({ customer: key(r.Customer), account: key(r.Account), entityId: key(r['Entity ID']), txnId: key(r['Transaction ID']), type: r['Entity Type'] || '', credit: num(r.Credit), debit: num(r.Debit), date: r.Date || '' })),
          watermark: wmR.status === 'fulfilled' && wmR.value[0] ? wmR.value[0].Watermark || null : null
        } : null;
        return [...res, inv, recent];
      })
      .then(([split, open, pay, inv, recent]) => {
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
        const I = inv ? new Map() : data.inv; // a failed read keeps the last good figures
        for (const r of inv || []) {
          const k = key(r.Customer); if (!k) continue;
          const e = I.get(k) || { invoices: 0, invoiced: 0, outstanding: 0, writtenOff: 0, paid: 0, credited: 0 };
          e.invoices += num(r.Invoices); e.invoiced += num(r.Invoiced); e.outstanding += num(r.Outstanding); e.writtenOff += num(r['Written off']); e.paid += num(r.Paid); e.credited += num(r.Credited);
          I.set(k, e);
        }
        data = { split: S, open: O, pay: P, inv: I, recent }; dataAt = Date.now();
        return data;
      })
      .finally(() => { loading = null; });
    // Logged once per refresh — not once for every caller waiting on the same refresh.
    loading.catch(e => console.error('Zoho Analytics finance refresh failed:', e.message));
  }
  return loading;
}
const fresh = () => !!data && Date.now() - dataAt <= FIN_TTL;
const STALE_OK = 15 * 60_000;
// The data for a check: fresh, or up to STALE_OK old while a refresh runs behind it, or — on the first load — awaited.
const current = () => fresh() ? Promise.resolve(data) : data && Date.now() - dataAt <= STALE_OK ? (refresh().catch(() => {}), Promise.resolve(data)) : refresh();
function prefetch() { if (!fresh()) refresh().catch(() => {}); }
const invalidate = () => { dataAt = 0; invalidateBalances(); };

const dubai = d => d.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', ' ·');
// ---- Zoho Books cross-verification data (only when the Analytics CFD check fails) ----
// Books allows ~100 calls a minute per organisation: every source is cached for BOOKS_TTL (per client for the per-customer
// lists, per window for the account transactions and journals) and concurrent checks share one call. Failures are never cached.
const BOOKS_TTL = 60_000, MAX_PAGES = 5, MAX_DRAFT_JOURNALS = 10, MAX_GROUP = 5;
// At most CALL_CAP Books calls for one cross-check (cache hits are free), at most CONCURRENCY at a time across all checks.
// A check that would need more fails closed ("could not be completed").
const CALL_CAP = 25, CONCURRENCY = 4;
let activeCalls = 0;
const waiting = [];
const slot = () => (activeCalls < CONCURRENCY ? (activeCalls++, Promise.resolve()) : new Promise(r => waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else activeCalls--; };
function budget() {
  const b = { used: 0 };
  b.books = async (p, params) => {
    if (b.used >= CALL_CAP) throw booksErr(`the cross-check would need more than ${CALL_CAP} Zoho Books calls`);
    b.used++;
    await slot();
    try { return await books(p, params); } finally { release(); }
  };
  return b;
}
const bcache = new Map(); // key -> { at, p, pending }
function cachedBooks(k, fn) {
  const e = bcache.get(k);
  if (e && (e.pending || Date.now() - e.at < BOOKS_TTL)) return e.p;
  const ent = { at: Date.now(), pending: true, p: null };
  ent.p = fn();
  ent.p.then(() => { ent.pending = false; ent.at = Date.now(); }, () => { if (bcache.get(k) === ent) bcache.delete(k); });
  bcache.set(k, ent);
  if (bcache.size > 500) for (const [kk, v] of bcache) { if (bcache.size <= 400) break; if (!v.pending) bcache.delete(kk); }
  return ent.p;
}
const booksErr = msg => Object.assign(new Error(msg), { code: 'BOOKS' });
// A Books list, page by page (200 a page, at most MAX_PAGES). A list answering 404, or a body without the list, is an
// error — never "nothing" (404 means nothing only for a single record).
async function pages(B, p, params, field) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await B.books(p, { ...params, per_page: '200', page: String(page) });
    if (j === null) throw booksErr(`Zoho Books ${p} answered 404`);
    if (typeof j.code === 'number' && j.code !== 0) throw booksErr(`Zoho Books ${p} answered code ${j.code}`);
    if (!Array.isArray(j[field])) throw booksErr(`Zoho Books ${p}: no ${field} list in the answer`);
    rows.push(...j[field]);
    const more = j.page_context && typeof j.page_context.has_more_page === 'boolean' ? j.page_context.has_more_page : j[field].length >= 200;
    if (!more) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
const settle = p => p.then(v => ({ ok: true, ...v }), e => ({ ok: false, rows: null, error: e.message, code: e.code }));
const accountTx = (B, account, since) => cachedBooks(`tx:${account}:${since}`, () => pages(B, 'chartofaccounts/transactions', { account_id: account, 'date.start': since }, 'transactions'));
async function perClient(B, kind, field, ids) {
  if (ids.length > MAX_GROUP) throw booksErr(`${ids.length} Books contacts are folded onto this client — more than one check reads`);
  const parts = await Promise.all(ids.map(id => cachedBooks(`${kind}:${id}`, () => pages(B, kind, { customer_id: id }, field))));
  return { rows: parts.flatMap(x => x.rows), truncated: parts.some(x => x.truncated) };
}
// Journals since the window start; the draft / pending ones (at most MAX_DRAFT_JOURNALS) are opened to see their customers.
const journals = (B, since) => cachedBooks(`journals:${since}`, async () => {
  const list = await pages(B, 'journals', { 'date.start': since }, 'journals');
  const pend = list.rows.filter(j => j && ['draft', 'pending_approval', 'submitted'].includes(String(j.status || '').toLowerCase()));
  const details = {};
  await Promise.all(pend.slice(0, MAX_DRAFT_JOURNALS).map(async j => {
    const id = key(j.journal_id);
    if (!/^\d{1,30}$/.test(id)) return;
    const d = await cachedBooks('journal:' + id, () => B.books('journals/' + id, {}));
    if (d === null) { details[id] = []; return; } // a single record: deleted since the list was read
    if (!d || !d.journal || !Array.isArray(d.journal.line_items)) throw booksErr('Zoho Books journal ' + id + ': no line items in the answer');
    details[id] = d.journal.line_items;
  }));
  return { rows: list.rows, truncated: list.truncated, details };
});
// Every Books contact that is this client: the picked one, its canonical contact, and every contact folded onto that.
function groupIds(raw) {
  const k = canonical(raw), out = new Set([key(raw), k]);
  for (const [src, can] of aliases) if (can === k) out.add(src);
  return [...out].filter(x => /^\d{1,30}$/.test(x));
}
async function crossCheck({ raw, contact, d, rec, amount, paid, committed }) {
  const k = canonical(raw), ids = groupIds(raw);
  // Always from the 45-day floor: an entry booked today can be dated weeks back, so the Analytics watermark cannot bound it.
  // Older unsynced entries are an accepted limit (Analytics syncs within hours).
  const since = daysBack(45);
  const B = budget();
  const [cfdTx, cogsTx, creditnotes, invoices, payments, jr] = await Promise.all([
    settle(accountTx(B, CFD_ACCOUNT, since)), settle(accountTx(B, COGS_ACCOUNT, since)),
    settle(perClient(B, 'creditnotes', 'creditnotes', ids)), settle(perClient(B, 'invoices', 'invoices', ids)), settle(perClient(B, 'customerpayments', 'customerpayments', ids)),
    settle(journals(B, since))
  ]);
  for (const [n, r] of Object.entries({ cfdTx, cogsTx, creditnotes, invoices, payments, journals: jr })) if (!r.ok) console.error(`Zoho Books cross-verification: ${n} not read for ${k} —`, r.error);
  const { _raw, ...pay } = d.pay.get(k) || { payments: 0, received: 0, unapplied: 0, refunded: 0, last: '' };
  return evaluateBooksCrossCheck({
    amount, paid, committed, contact, rec, split: d.split.get(k) || null, pay,
    inv: d.inv ? d.inv.get(k) || { invoices: 0, invoiced: 0, outstanding: 0, writtenOff: 0, paid: 0, credited: 0 } : null,
    ids, names: contact ? [contact.contactName, contact.companyName] : [], accounts: { cfd: CFD_ACCOUNT, cogs: COGS_ACCOUNT },
    recent: d.recent, windowStart: since, books: { cfdTx, cogsTx, creditnotes, invoices, payments, journals: jr }
  });
}

// The financial checks for one Books contact. books: the live contact if the caller already read it.
// committed: amounts already approved or credited for this client on the platform, not yet booked in the ledger.
// connections: the verification that ran just before (M_zoho.verifyConnections).
// Step 1, always: the Zoho Analytics checks (CFD, COGS, invoices). If the Analytics CFD balance covers the request, they decide.
// Step 2, only when it does not: the Zoho Books cross-verification decides, with five checks.
async function run({ contactId, amount, paid, books: contactIn, committed, connections }) {
  const raw = key(contactId);
  if (!/^\d{1,30}$/.test(raw)) throw Object.assign(new Error('Zoho Books contact id required'), { code: 'BOOKS' });
  const [contact, d] = await Promise.all([contactIn ? Promise.resolve(contactIn) : booksGetContact(raw), current()]);
  const k = canonical(raw), rec = await analyticsBalance(k);
  const { _raw, ...pay } = d.pay.get(k) || { payments: 0, received: 0, unapplied: 0, refunded: 0, last: '' };
  const f = evaluateFinance({ amount, paid, books: contact, rec, split: d.split.get(k) || null, open: d.open.get(k) || [], pay, committed, grouped: grouped(raw),
    inv: d.inv ? d.inv.get(k) || { invoices: 0, invoiced: 0, outstanding: 0, writtenOff: 0, paid: 0, credited: 0 } : null });
  const cfd = f.checks.find(c => c.key === 'CFD');
  const primary = { ok: cfd.ok, code: cfd.code, text: cfd.message, detail: cfd.detail };
  const out = cfd.ok
    ? { ...f, route: 'ANALYTICS', source: 'Zoho Books (live contact) + Zoho Analytics (CFD, COGS, invoices, payments)' }
    : { ...(await crossCheck({ raw, contact, d, rec, amount, paid, committed })), route: 'BOOKS_CROSSCHECK',
        source: 'Zoho Analytics (CFD) → Zoho Books live cross-verification (CFD, COGS, credit / debit notes, journals, payments)' };
  const t = new Date(), c = connections || {};
  return { id: 'FV-' + crypto.randomBytes(4).toString('hex').toUpperCase(), at: t.toISOString(), atText: dubai(t), clientId: k,
    connections: { analytics: !!(c.analytics && c.analytics.ok), books: !!(c.books && c.books.ok), atText: c.atText || '' }, primary, ...out };
}
// What a request stores: the checks, never the headline strings.
const record = f => f && ({ id: f.id, at: f.at, atText: f.atText, amount: f.amount, ok: f.ok, source: f.source, route: f.route, connections: f.connections, primary: f.primary, checks: f.checks });

// Everything debited to the client's CFD and COGS accounts so far (the card spend booked against its funds).
const totalDebits = (d, contactId) => { const e = d.split.get(canonical(contactId)); return e ? Math.round((e.cfd.debits + e.cogs.debits) * 100) / 100 : 0; };
async function ledgerDebits(contactId) { return totalDebits(await current(), contactId); }
// The figure as of now if the cached data is fresh — the baseline when a card is topped up. null = not fresh.
const ledgerDebitsNow = contactId => fresh() ? totalDebits(data, contactId) : null;

return { run, record, prefetch, invalidate, forOps: financeForOps, fresh, canonical, ledgerDebits, ledgerDebitsNow };
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
  OPS_INSUFFICIENT: 'Client does not have sufficient balance. You may escalate to Management.',
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
  // Zoho Analytics alone did not cover the request, so the Zoho Books cross-verification (five checks) decided the balance.
  if (fin && fin.route === 'BOOKS_CROSSCHECK') {
    const live = typeof fin.available === 'number' ? fin.available : 0;
    Object.assign(out, { available: rec ? rec.available : 0, allocated: rec ? rec.allocated : 0, used: rec ? rec.used : 0, booksAvailable: typeof fin.available === 'number' ? fin.available : null });
    if (rec) {
      const rel = relevance(req, rec);
      if (!rel.ok) return { ...out, ok: false, relevancePassed: false, remaining: Math.max(0, live), reason: 'NOT_RELEVANT', approvalStatus: STATUS.FLAGGED, approvedAmount: 0, notes: !rel.catOk ? `Purpose "${req.purpose}" is not a category on the client's ledger (${rec.categories.join(', ')}).` : `Company "${req.company}" does not belong to this client record.` };
    }
    if (!fin.ok) return { ...out, ok: false, relevancePassed: true, remaining: Math.max(0, live - requested), reason: 'FINANCIAL_CHECKS_FAILED', approvalStatus: STATUS.FLAGGED, approvedAmount: 0, notes: 'Zoho Books cross-verification failed — ' + fin.staffError,
      publicNotes: 'Financial validation failed — ' + fin.failed.map(f => f.label).join(', ') + '. Flagging Sven for review.' };
    return { ...out, ok: true, relevancePassed: true, remaining: live - requested, reason: 'VALIDATION_PASSED', approvalStatus: STATUS.PROVISIONAL, approvedAmount: requested, notes: MSG.PASSED + ' (Zoho Analytics did not cover it; Zoho Books cross-verification passed.)' };
  }
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

return { issue, verify, lock, locked, unlock, sign, unsign, signedBody };
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
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => {
  try { const j = JSON.stringify(db); fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', j); fs.renameSync(FILE + '.tmp', FILE); push('platform', j); }
  catch (e) { console.error('Platform data not saved:', e.message); }
}, 150); };

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
// A platform reset records what it removed (db.purged; the live ones also in db.purgedLive) and when (db.resetAt):
// removed history never comes back, and an emptied server is not mistaken for a first start.
//
// Numbers: the live platform numbers new requests after the highest one it holds, so a newer ledger can bring history
// under a number a live request already took (or took and a reset removed). That history is never dropped and no number
// is ever used twice: it is imported under a fresh number, recorded in db.ledgerIds { ledger id: platform id } so every
// later start maps it the same way. History ids are always looked up through that map.
const idNum = id => Number(String(id ?? '').replace(/\D/g, '')) || 0;
const isLiveRecord = r => !!(r && (r.createdAt || r.requestorId)); // created on the platform (history entries carry neither)
const ledgerMap = () => (db.ledgerIds && typeof db.ledgerIds === 'object' && !Array.isArray(db.ledgerIds) ? db.ledgerIds : {});
const platformIdOf = ledgerId => ledgerMap()[ledgerId] || ledgerId;
const historyGone = id => (db.purged || []).includes(id) && !(db.purgedLive || []).includes(id);
// Tombstones written before purgedLive existed do not say whether they were live or history. The ledger then ended at
// FR-527 (LEDGER_PREVIOUS_MAX overrides it); live numbers were always handed out above every number the server held, so
// a tombstone above the old ledger's end can only have been a live request. Done once (db.tombstones = 2); from then on every reset says which is which.
const PREVIOUS_LEDGER_MAX = 527;
function classifyTombstones() {
  if (db.tombstones === 2) return false;
  const old = (db.purged || []).filter(id => !(db.purgedLive || []).includes(id));
  if (old.length) {
    const inLedger = new Set((LEDGER.requests || []).map(r => r && r.id));
    const hist = db.requests.filter(r => inLedger.has(r.id) && !isLiveRecord(r)).map(r => idNum(r.id));
    // The previous ledger's end: the highest history id still here, the ids `previous` names (all from the old ledger), and
    // never below FR-527 — where it ended in production — so purged history at the top is not mistaken for live requests.
    const prevKeys = Object.keys((LEDGER.previous && typeof LEDGER.previous === 'object') ? LEDGER.previous : {}).map(idNum);
    const oldMax = Math.max(Number(process.env.LEDGER_PREVIOUS_MAX) || PREVIOUS_LEDGER_MAX, ...hist, ...prevKeys);
    const live = old.filter(id => idNum(id) > oldMax);
    db.purgedLive = [...new Set((db.purgedLive || []).concat(live))];
    console.log(`Ledger: ${old.length} earlier reset tombstones classified — ${live.length} live (above FR-${oldMax}), ${old.length - live.length} history.`);
  }
  db.tombstones = 2;
  return true;
}
// Highest number the ledger occupies or will occupy (its own ids and the fresh numbers given to colliding entries).
const ledgerMaxNo = () => Math.max(0, ...(LEDGER.requests || []).map(r => idNum(r && r.id)), ...Object.values(ledgerMap()).map(idNum));
// An open history request arriving with a newer ledger may already have been raised again on the live platform (Operations
// re-entered it before the history caught up). Imported as it is, Sven would see two pending requests for the same money:
// it is imported voided instead when a live request (not voided) matches it on company or client name and amount and was
// created on or after the history request's day. Each live request accounts for one history request at most.
const LEDGER_OPEN = ['NEW', 'ACTION', 'APPROVED'];
const normName = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The day of a ledger date ('29 Sep'), in the year that puts it at or before the live request's creation.
function ledgerDayMs(date, createdMs) {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2})/.exec(String(date || '')), mo = m ? MONTHS.indexOf(m[2]) : -1;
  if (mo < 0 || !Number.isFinite(createdMs)) return null;
  const y = new Date(createdMs).getUTCFullYear();
  let t = Date.UTC(y, mo, Number(m[1])) - 4 * 3600_000; // midnight in Dubai
  if (t > createdMs + 24 * 3600_000) t = Date.UTC(y - 1, mo, Number(m[1])) - 4 * 3600_000;
  return t;
}
function duplicateOf(L, used) {
  if (!LEDGER_OPEN.includes(L.status)) return null;
  const names = new Set([L.company, L.person, L.zohoClient].map(normName).filter(n => n && n !== '-'));
  if (!names.size) return null;
  return db.requests.find(r => {
    if (!r.createdAt || r.status === 'VOID' || used.has(r.id)) return false;
    if (Math.abs((Number(r.requested) || 0) - (Number(L.requested) || 0)) > 0.005 || !(Number(L.requested) > 0)) return false;
    if (![r.company, r.person, r.zohoClient].some(v => names.has(normName(v)))) return false;
    const created = Date.parse(r.createdAt), day = ledgerDayMs(L.date, created);
    return day !== null && created >= day;
  }) || null;
}
function voidAsDuplicate(L, live) {
  const now = new Date(), atText = now.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', ' ·');
  const reason = `Duplicate — raised again on the platform as ${live.id}`;
  console.log(`Ledger: ${L.id} (${L.company}, ${L.requested}) is already on the platform as ${live.id} — imported as voided.`);
  return { ...L, status: 'VOID', flagged: false, voided: { by: 'system', byName: 'System', at: now.toISOString(), atText, reason, prevStatus: L.status },
    timeline: (Array.isArray(L.timeline) ? L.timeline : []).concat([{ at: atText.replace(/^0/, ''), text: `Voided by the system — ${reason}`, srv: true }]) };
}
function mergeLedger() {
  const map = { ...ledgerMap() }, purgedLive = new Set(db.purgedLive || []), add = [], used = new Set();
  let voided = 0;
  let next = null, remapped = 0;
  for (const L of LEDGER.requests || []) {
    if (!L || typeof L.id !== 'string') continue;
    let pid = map[L.id];
    if (!pid) {
      const cur = db.requests.find(r => r.id === L.id);
      if ((cur && isLiveRecord(cur)) || purgedLive.has(L.id)) {
        if (next === null) next = Math.max(db.floorNo || 0, ledgerMaxNo(), ...db.requests.map(r => idNum(r.id)), ...(db.purged || []).map(idNum), ...Object.values(map).map(idNum));
        pid = L.id.replace(/\d+$/, '') + (++next);
        map[L.id] = pid; remapped++;
        console.log(`Ledger: ${L.id} is taken by a ${cur ? 'live request' : 'live request removed in a reset'} — imported the history as ${pid}.`);
      } else pid = L.id;
    }
    if (historyGone(pid)) continue; // removed history stays removed
    let entry = pid === L.id ? L : { ...L, id: pid };
    if (!db.requests.some(r => r.id === pid)) { // being imported now
      const dup = duplicateOf(entry, used);
      if (dup) { used.add(dup.id); entry = voidAsDuplicate(entry, dup); voided++; }
    }
    add.push(entry);
  }
  if (remapped) db.ledgerIds = map;
  return { added: mergeMissing('requests', add), remapped, voided };
}
// A newer ledger.json may also carry updated versions of history requests (later messages approved / credited / paid
// them): `previous` maps each such id to the ledgerHash of the entry as the old ledger.json had it. A history request the
// platform never touched still has exactly that fingerprint (and no field beyond the ledger's own): it is replaced by
// the new entry. One that was edited on the platform keeps the platform's version. (Fingerprints use the ledger's id.)
function applyLedgerUpdates() {
  const prev = LEDGER.previous && typeof LEDGER.previous === 'object' && !Array.isArray(LEDGER.previous) ? LEDGER.previous : {};
  const ids = Object.keys(prev);
  if (!ids.length) return 0;
  const entries = new Map((LEDGER.requests || []).filter(r => r && typeof r.id === 'string').map(r => [r.id, r]));
  let updated = 0, kept = 0;
  for (const id of ids) {
    const entry = entries.get(id), pid = platformIdOf(id), i = db.requests.findIndex(r => r.id === pid);
    if (!entry || historyGone(pid) || i < 0) continue;
    const cur = db.requests[i];
    if (isLiveRecord(cur)) continue; // created on the live platform, not history
    const h = ledgerHash({ ...cur, id }), plain = Object.keys(cur).every(k => LEDGER_KEYS.includes(k));
    if (h === ledgerHash(entry) && plain) continue; // already the new version
    if (h === prev[id] && plain) { db.requests[i] = { ...JSON.parse(JSON.stringify(entry)), id: pid }; updated++; }
    else kept++;
  }
  console.log(`Ledger: updated ${updated} history requests (${kept} left as edited on the platform).`);
  return updated;
}
let LEDGER = { requests: [], chat: [], notifications: [], audit: [] };
try {
  LEDGER = JSON.parse(fs.readFileSync(process.env.LEDGER_FILE ? path.resolve(process.env.LEDGER_FILE) : new URL('./ledger.json', import.meta.url), 'utf8'));
  if (!db.requests.length && !db.resetAt) {
    for (const c of COLS) if (Array.isArray(LEDGER[c])) db[c] = LEDGER[c];
    db.tombstones = 2;
    db.rev++; persist(); console.log('Ledger: loaded', db.requests.length, 'requests into an empty server.');
  } else {
    const c = classifyTombstones();
    const { added, remapped, voided } = mergeLedger();
    console.log('Ledger:', added ? 'added ' + added + ' missing requests' + (remapped ? ` (${remapped} under new numbers)` : '') + (voided ? ` (${voided} voided as duplicates of live requests)` : '') + '.' : 'server already up to date.');
    const u = applyLedgerUpdates();
    if (c || added || remapped || u) { db.rev++; persist(); } // persisted once
  }
} catch (e) { console.error('Ledger not applied:', e.message); }
const LEDGER_IDS = Object.fromEntries(COLS.map(c => [c, new Set((LEDGER[c] || []).map(x => x && x.id))]));
// The platform ids of the history requests (through db.ledgerIds — read live, a restore can bring another map).
const historyIds = () => new Set((LEDGER.requests || []).map(r => r && platformIdOf(r.id)));
// History = imported from the ledger; everything else was created on the live platform.
const isHistory = (r, ids = historyIds()) => ids.has(r.id) && !isLiveRecord(r);

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
// Management decision notes are not for Operations. Lines written before this rule carried the note after the decision
// words ('… rejected the escalation — <note>'): Operations get them without it.
const hideRejectNote = n => /^Escalation rejected by /.test(n) ? n.replace(/^(Escalation rejected by .+?) — [\s\S]*$/, '$1') : n;
const hideDecisionNote = t => String(t ?? '').replace(/((?:approved the escalation — proceed|rejected the escalation))(?: — [\s\S]*)$/, '$1');
let mgmtKeys = { at: 0, set: new Set() };
const managementKeys = () => { if (Date.now() - mgmtKeys.at > 5000) { try { mgmtKeys = { at: Date.now(), set: new Set(loadUsers().filter(x => x.dept === 'MANAGEMENT').map(x => x.key)) }; } catch {} } return mgmtKeys.set; };
// What an Operations user may see of an escalation: notes only from the log entries they wrote themselves, the open
// question management asked (infoRequest), and the justification unless a member of management wrote it.
function escalationForOps(u, e) {
  if (!e || typeof e !== 'object') return e;
  const out = { ...e };
  if (Array.isArray(e.log)) out.log = e.log.map(x => { if (!x || typeof x !== 'object' || x.who === u.key) return x; const { note, ...rest } = x; return rest; });
  // A legacy "needs info" decision holds management's question to the requester — like infoRequest, it stays.
  if (e.decision && typeof e.decision === 'object' && e.decision.by !== u.key && e.decision.action !== 'INFO') { const { note, ...d } = e.decision; out.decision = d; }
  if (e.by !== u.key && managementKeys().has(e.by)) delete out.justification;
  return out;
}
function redact(u, col, item) {
  if (!item || !ops(u)) return item; // every Operations user, Master Operations Control included, sees no balances or amounts
  if (col === 'requests') {
    const { zohoBalance, ...r } = item;
    if (Array.isArray(r.timeline)) { const mk = managementKeys(); r.timeline = r.timeline.filter(t => !(t && t.by && mk.has(t.by))).map(t => ({ ...t, text: hideDecisionNote(hideAmounts(t.text)) })); }
    for (const k of ['finance', 'financeLatest']) if (r[k]) r[k] = M_finance.forOps(r[k]); // every financial check record
    if (r.escalation) r.escalation = escalationForOps(u, r.escalation);
    if (typeof r.notes === 'string') r.notes = hideRejectNote(r.notes);
    return r;
  }
  if (col === 'chat' && item.zoho) { const { zoho, ...c } = item; return { ...c, text: hideAmounts(c.text) }; }
  if (col === 'notifications' && item.text) return { ...item, text: hideDecisionNote(item.text) };
  if (col === 'audit') {
    const { opsDetail, ...a } = item;
    if (opsDetail !== undefined) a.detail = opsDetail; // the server wrote a version without the management note
    else if (['ESCALATION_APPROVED', 'ESCALATION_REJECTED'].includes(a.action) && typeof a.detail === 'string') a.detail = a.detail.replace(/^(ESC-[0-9A-F]+ · [^·]+ · .*?) — [\s\S]*$/, '$1');
    if (a.detail) a.detail = String(a.detail).replace(/AED\s?[\d,]+(?:\.\d+)?K?/gi, 'AED •••'); // e.g. 'balance moved to AED 3,000'
    return a;
  }
  return item;
}
// An Operations browser only holds the stripped copy: when it saves a request, put the hidden parts back.
function restoreHidden(item, prev) {
  if (prev.zohoBalance !== undefined && item.zohoBalance === undefined) item.zohoBalance = prev.zohoBalance;
  if (typeof prev.notes === 'string' && item.notes === hideRejectNote(prev.notes)) item.notes = prev.notes; // unchanged, as they received it
  if (Array.isArray(item.timeline) && Array.isArray(prev.timeline))
    item.timeline = item.timeline.map((t, i) => { const o = prev.timeline[i]; return o && t.at === o.at && t.text === hideAmounts(o.text) ? o : t; });
}

// One open request per Zoho Books client: New, waiting on information, or with management. Approving, declining or voiding unlocks.
const OPEN = ['NEW', 'ACTION', 'ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED'];
// Only the server moves a request into these (escalation endpoints, void) — and out of ESCALATED / MGMT_INFO / MGMT_REJECTED.
const SERVER_STATUS = ['ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED', 'MGMT_REJECTED', 'VOID'];
// Set only by the server: whatever a browser sends for these is replaced by the stored value.
const SERVER_FIELDS = ['finance', 'financeLatest', 'escalation', 'voided', 'requestorId', 'clientId', 'createdAt', 'creditedAt', 'ledgerDebitsAtCredit'];
// Operations cannot change the money or the client on a request once it exists (Master Operations Control included).
const OPS_FIXED = ['requested', 'approved', 'credited', 'paid', 'company', 'purpose', 'zone', 'zohoClientId', 'zohoClient', 'zohoBalance', 'zohoReason', 'zohoValidationId', 'zohoCheckedAt', 'override'];
// The client is the canonical Books contact (duplicates folded together). Open requests from the March–September
// history carry no Books id: they lock the client whose Books contact or company name matches theirs exactly.
const nameKey = v => String(v || '').trim().toLowerCase();
function pendingRequestFor(contactId, names = []) {
  if (!contactId) return null;
  const k = M_finance.canonical(contactId), want = new Set(names.map(nameKey).filter(n => n && n !== '—'));
  return db.requests.find(r => OPEN.includes(r.status) && (r.zohoClientId ? M_finance.canonical(r.zohoClientId) === k : [r.person, r.company, r.zohoClient].some(v => want.has(nameKey(v))))) || null;
}

// The three financial checks run at Send: kept here until the request (or its escalation) arrives, then attached to it.
const finStore = new Map(); // FV id -> { fin, u, at }
const finPut = (fin, userKey) => { finStore.set(fin.id, { fin, u: userKey, at: Date.now() }); for (const [k, v] of finStore) if (Date.now() - v.at > DAY) finStore.delete(k); };
const finGet = (id, userKey) => { const e = id && finStore.get(id); return e && e.u === userKey ? e.fin : null; };
const hasPendingCheck = (userKey, contactId, amount) => { const k = M_finance.canonical(contactId);
  for (const e of finStore.values()) if (e.u === userKey && e.fin.ok && M_finance.canonical(e.fin.clientId) === k && Number(e.fin.amount) === Number(amount)) return true;
  return false; };

// Rules for a brand-new request, enforced here whatever the browser does.
function newRequestProblem(u, item) {
  const blank = v => !String(v ?? '').trim();
  if (blank(item.company) || blank(item.purpose) || !(Number(item.requested) > 0) || blank(item.paid) || blank(item.zohoClientId))
    return { status: 422, reason: 'MANDATORY_FIELDS', error: M_rules.MSG.MANDATORY };
  const pend = pendingRequestFor(item.zohoClientId, [item.zohoClient, item.person, item.company]);
  if (pend) return { status: 409, reason: 'REQUEST_PENDING', error: M_rules.MSG.LOCKED, pendingId: pend.id };
  const pass = M_gate.unsign(item.zohoSubmitToken);
  // Single use: the pass is good only while the result of the checks it was issued for is still waiting here.
  if (!pass || pass.k !== 'submit' || pass.u !== u.key || String(pass.c) !== String(item.zohoClientId) || Number(pass.a) !== Number(item.requested) || !finGet(pass.f, u.key))
    return { status: 422, reason: 'BALANCE_NOT_VALIDATED', error: M_rules.MSG.NOT_VALIDATED };
  if (String(item.paid).trim() !== String(pass.p || '')) return { status: 422, reason: 'PAID_CHANGED', error: '“Client already paid us?” changed after the financial checks ran. Press Send again.' };
  if (Array.isArray(pass.o) && pass.o.length && !pass.o.includes(String(item.company).trim())) return { status: 422, reason: 'COMPANY_NOT_FROM_BOOKS', error: 'Pick the company from the Zoho Books list.' };
  return null;
}
// A refused request must not leave a "<name> requested ..." notification pointing at nothing (or at someone else's request).
const refused = new Map(); // `${userKey}:${requestId}` -> { reason, at }
const remember = (map, k, v, max = 5000) => { map.set(k, v); for (const [key, e] of map) { if (map.size <= max && Date.now() - (e.at || 0) < DAY) break; map.delete(key); } };
const notSubmitted = (n, reason) => ({ ...n, req: null, text: 'Not submitted — ' + n.text.replace(/\.$/, '') + '. ' + reason });

function send(c, ev) { try { c.res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch (e) { console.error('Live event not sent:', e.message); } }
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
    if (prev && prev.status !== item.status && (SERVER_STATUS.includes(item.status) || ['ESCALATED', 'MGMT_INFO', 'MGMT_REJECTED'].includes(prev.status))) return false; // management decides
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
  // Create (restricted Operations: only for finance and management), mark own as read.
  if (col === 'notifications') return prev ? prev.to === u.key : !restricted(u) || item.to === u.key || (() => { const t = loadUsers().find(x => x.key === item.to); return !!t && (isMaster(t) || ['FINANCE', 'MANAGEMENT'].includes(t.dept)); })();
  if (col === 'audit') return !prev;
  return false;
}
const VOID_LOCKED = 'This request has been voided and is locked — nothing on it can change.';
// A history line written in a browser by Operations or management: never marked as the server's, always signed.
const authored = (t, u) => { const { srv, ...line } = t; const text = String(line.text || ''); return { ...line, by: u.key, text: text.startsWith(u.name) ? text : u.name + ': ' + text }; };
// At most WRITE_MAX browser writes per user per minute (a person clicking stays far below it; a script does not).
const WRITE_MAX = 120, writes = new Map();
function writesExceeded(userKey) {
  const now = Date.now(), list = (writes.get(userKey) || []).filter(t => now - t < 60_000);
  list.push(now); writes.set(userKey, list);
  return list.length > WRITE_MAX;
}
// An entry a browser sends: at most 8 levels deep and 400 KB (documents are stored separately, by file id).
function tooBig(item) {
  const deep = (v, d) => d > 8 || (v && typeof v === 'object' && Object.values(v).some(x => deep(x, d + 1)));
  if (deep(item, 0)) return true;
  try { return JSON.stringify(item).length > 400_000; } catch { return true; }
}

// Request numbers are picked in the sender's browser ("highest FR number I can see + 1"). Operations users only
// see their own requests, so their number can already belong to someone else's. The creator ("by") of a request
// never changes, so a put whose id exists with a different creator is a NEW request: it gets the next free
// number. The old number is remembered per user for a day, so that browser's follow-up writes (notification,
// chat, Zoho check, edits) land on the right request until it has renamed it. Numbers used before a platform
// reset (db.floorNo) are never handed out again.
const remaps = new Map(); // `${userKey}:${oldId}` -> { id, at }
const DAY = 24 * 3600 * 1000;
const numOf = id => Number(String(id).replace(/\D/g, '')) || 0;
// Never a number the ledger holds or will hold (its own ids and the fresh numbers given to colliding history).
const nextRequestId = () => 'FR-' + (Math.max(db.floorNo || 0, ledgerMaxNo(), db.requests.reduce((a, r) => Math.max(a, numOf(r.id)), 0)) + 1);
function resolveRequestId(userKey, id, maxAge = DAY) {
  const r = id && remaps.get(userKey + ':' + id);
  if (r && Date.now() - r.at > DAY) { remaps.delete(userKey + ':' + id); return id; }
  return r && Date.now() - r.at <= maxAge ? r.id : id;
}
// A put carrying a submit pass is a brand-new request. A resend of the same request carries the pass of the checks
// already attached to it; any other request under a taken number (another user's — or the same user's escalation,
// numbered by the server before this browser saw it) is a different request.
// The pass may have expired by the time a browser resends (it keeps its copy): only a validly signed pass for OTHER checks
// marks a different request; an unreadable one on the user's own number is treated as an edit.
const sameSubmission = (item, taken) => { const p = M_gate.signedBody(item.zohoSubmitToken); return !p || !p.f || !!(taken.finance && p.f === taken.finance.id); };

// Zoho result of the automatic check that runs when a request is sent. The server attaches it to the request
// itself; if the browser's copy of the request has not arrived yet, it waits here and is attached on arrival.
const pendingZoho = new Map(); // `${userKey}:${requestId as the browser named it}` -> { fields, tl, at }
const withZoho = (r, z) => {
  const n = Object.assign({}, r, z.fields);
  if (r.flagged) n.flagged = true; // a flag Sven (or anyone) raised stays until finance clears it
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
// The cached ledger was not fresh when the card was topped up: read it now and record the baseline (until then, held in full).
function fillBaseline(id) {
  const r = db.requests.find(x => x.id === id);
  if (!r || !r.zohoClientId || typeof r.ledgerDebitsAtCredit === 'number') return;
  M_finance.ledgerDebits(r.zohoClientId).then(v => {
    const cur = db.requests.find(x => x.id === id);
    if (cur && typeof cur.ledgerDebitsAtCredit !== 'number' && cur.creditedAt) postSystem('requests', { ...cur, ledgerDebitsAtCredit: v });
  }).catch(e => console.error('Ledger baseline not recorded for', id, '—', e.message, '(held in full meanwhile)'));
}
// Money approved on the platform but not yet booked in the CFD ledger is held against the client's balance, so two
// requests cannot both be approved against the same funds:
//   APPROVED — the full approved amount (nothing is on the card yet);
//   CREDITED / PAID (and a credited request voided afterwards — the money is on the card) — what the ledger has not yet
//   absorbed: when the card is topped up the server records the client's total CFD + COGS debits (ledgerDebitsAtCredit);
//   debits booked since then are set against the credited requests oldest first. A hold lapses after HOLD_DAYS.
// ledgerDebits: the client's total debits now (M_finance.ledgerDebits).
const HOLD_DAYS = 30;
const CREDITED_LIKE = r => ['CREDITED', 'PAID'].includes(r.status) || (r.status === 'VOID' && r.voided && ['CREDITED', 'PAID'].includes(r.voided.prevStatus));
function committedFor(contactId, exceptId, ledgerDebits = 0) {
  const k = M_finance.canonical(contactId);
  const mine = db.requests.filter(r => r.id !== exceptId && r.zohoClientId && M_finance.canonical(r.zohoClientId) === k);
  const approved = mine.filter(r => r.status === 'APPROVED');
  let amount = approved.reduce((a, r) => a + (Number(r.approved) || Number(r.requested) || 0), 0), count = approved.length;
  const recent = mine.filter(r => CREDITED_LIKE(r) && r.creditedAt && Date.now() - Date.parse(r.creditedAt) < HOLD_DAYS * DAY);
  // No baseline (the ledger could not be read when the card was topped up): held in full until HOLD_DAYS.
  for (const r of recent.filter(x => typeof x.ledgerDebitsAtCredit !== 'number')) { amount += Number(r.credited || r.approved) || Number(r.requested) || 0; count++; }
  const credited = recent.filter(r => typeof r.ledgerDebitsAtCredit === 'number').sort((a, b) => Date.parse(a.creditedAt) - Date.parse(b.creditedAt));
  if (credited.length) {
    let booked = Math.max(0, ledgerDebits - credited[0].ledgerDebitsAtCredit); // spend booked since the oldest of them was credited
    for (const r of credited) {
      const amt = Number(r.credited || r.approved) || Number(r.requested) || 0, absorbed = Math.min(amt, booked);
      booked -= absorbed;
      if (amt - absorbed > 0.005) { amount += amt - absorbed; count++; }
    }
  }
  return { amount: Math.round(amount * 100) / 100, count };
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
  if (col === 'notifications' && list.length > 5000) list.length = 5000;        // newest first
  if (col === 'chat' && list.length > 10000) list.splice(0, list.length - 10000); // oldest first
  db.rev++; persist();
  return prev;
}

// ---- requests: escalation, void, invoice chasing (server-side transitions) ----
const aed = n => 'AED ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const hex = n => crypto.randomBytes(n).toString('hex').toUpperCase();
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const titled = u => 'Mr. ' + u.name + (u.title ? ' (' + u.title + ')' : '');
const management = () => loadUsers().filter(x => x.dept === 'MANAGEMENT');
const andList = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
// Who an escalation went to. Escalations from before routing went to all of management.
const recipientsOf = r => (r.escalation && Array.isArray(r.escalation.to) && r.escalation.to.length ? r.escalation.to : management().map(p => ({ key: p.key, name: p.name, title: p.title || '' })));
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
    if (Array.isArray(pass.o) && pass.o.length && !pass.o.includes(str(R.company, 200))) return fail(s, 422, 'Pick the company from the Zoho Books list.', { reason: 'COMPANY_NOT_FROM_BOOKS' });
    // Who decides: 'ALL' management (the default) or the members chosen. Only they are notified, only they may decide.
    const everyone = management(), wantTo = b.to === undefined || b.to === null ? 'ALL' : b.to;
    let routing, people;
    // 'ALL' = every ACTIVE member of management (an account without a password cannot sign in to decide).
    if (wantTo === 'ALL') {
      routing = 'ALL'; people = everyone.filter(p => p.active !== false);
      if (!people.some(p => p.key !== u.key)) return fail(s, 422, 'No active management account can decide this — Sven must activate one in Master Control → Users.', { reason: 'NO_ACTIVE_MANAGEMENT' });
    }
    else if (Array.isArray(wantTo)) {
      const keys = [...new Set(wantTo.map(x => String(x ?? '').trim().toLowerCase()))];
      if (!keys.length) return fail(s, 422, 'Choose at least one member of management to send the escalation to.', { reason: 'RECIPIENTS_REQUIRED' });
      const unknown = keys.filter(k => !everyone.some(p => p.key === k));
      if (unknown.length) return fail(s, 422, 'Not a member of management: ' + unknown.join(', ').slice(0, 200) + '.', { reason: 'UNKNOWN_RECIPIENT' });
      people = everyone.filter(p => keys.includes(p.key));
      const off = people.filter(p => p.active === false);
      if (off.length) return fail(s, 422, `${andList(off.map(titled))} cannot receive escalations yet — the account is not active.`, { reason: 'RECIPIENT_INACTIVE' });
      routing = 'SELECTED';
    } else return fail(s, 422, 'Choose who the escalation goes to.', { reason: 'RECIPIENTS_REQUIRED' });
    if (!people.some(p => p.key !== u.key)) return fail(s, 422, 'Choose a member of management other than yourself — you cannot decide your own escalation.', { reason: 'RECIPIENTS_REQUIRED' });
    const names = [pass.n].concat(Array.isArray(pass.o) ? pass.o : []);
    const pend = pendingRequestFor(pass.c, names);
    if (pend) return fail(s, 409, M_rules.MSG.LOCKED, { reason: 'REQUEST_PENDING', pendingId: pend.id });
    const docs = await cleanDocs(R.docs);
    if (pendingRequestFor(pass.c, names)) return fail(s, 409, M_rules.MSG.LOCKED, { reason: 'REQUEST_PENDING' });
    const at = new Date().toISOString(), atText = AUDIT_DAY(), id = nextRequestId(), amount = Number(pass.a);
    const escalation = {
      id: 'ESC-' + hex(3), at, atText, by: u.key, byName: u.name, justification: just, failed: fin.failed,
      to: people.map(p => ({ key: p.key, name: p.name, title: p.title || '' })), routing, decision: null,
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
        // A justification written by a member of management is a management note: not in the history Operations see.
        { at: tlAt(), text: `${u.name} escalated to management (${escalation.id})` + (isManagement(u) ? '' : ` — ${just}`), srv: true }
      ],
      requestorId: u.key, clientId: String(pass.c), createdAt: at, finance: M_finance.record(fin), escalation
    };
    finStore.delete(pass.f);
    postSystem('requests', item);
    audit(u, 'ESCALATION_CREATED', `${escalation.id} · ${item.company} — ${aed(amount)} · failed: ${failedLabels} · ${just}`, item,
      isManagement(u) ? `${escalation.id} · ${item.company} — ${aed(amount)} · failed: ${failedLabels}` : undefined);
    notifyMany(people.map(p => p.key), `ESCALATION ${escalation.id} — ${u.name} needs a management decision on ${id} · ${item.company} · ${aed(amount)}. Failed: ${failedLabels}. Reason: ${just}`, id, u.key);
    notifyMany(['sven'], `Escalated to ${routing === 'ALL' ? 'management' : andList(people.map(titled))} — ${id} · ${item.company} · ${aed(amount)} (${failedLabels} failed). You give the final approval if management approves.`, id, u.key);
    s.json({ ok: true, id, item: reqOut(u, item) });
  });

  // Management decision: one of the managers the escalation was sent to decides. APPROVE overrides the failed checks
  // (Sven still gives the final approval), REJECT ends it as Rejected by Management and unlocks the client, INFO asks the
  // requester a question while the request stays Awaiting Management Decision. Decision notes never reach Operations.
  app.post('/api/requests/:id/escalation', requireAuth, (q, s) => {
    const u = q.user, b = q.body || {};
    if (!isManagement(u)) return fail(s, 403, 'Only management (Mr. Adnan, Mr. Ahmed, Mr. Eduard) can decide an escalation.');
    const r = find(q, s); if (!r) return;
    if (!r.escalation || !['ESCALATED', 'MGMT_INFO'].includes(r.status)) return fail(s, 409, 'This request is not waiting for a management decision.');
    if (r.by === u.key || r.escalation.by === u.key) return fail(s, 403, 'You raised this escalation — one of the other members of management decides it.');
    const to = recipientsOf(r);
    if (!to.some(t => t.key === u.key)) return fail(s, 403, `This escalation was sent to ${andList(to.map(titled))}.`);
    const action = String(b.action || '').toUpperCase(), note = str(b.note, 2000);
    if (!['APPROVE', 'REJECT', 'INFO'].includes(action)) return fail(s, 400, 'Choose approve, reject or request more information.');
    if (note.length < 3) return fail(s, 422, 'Add a note for the record.');
    const at = new Date().toISOString(), atText = AUDIT_DAY(), who = titled(u);
    const escalation = { ...r.escalation, log: (r.escalation.log || []).concat([{ at, atText, who: u.key, whoName: u.name, action, note }]) };
    let next;
    if (action === 'INFO') {
      escalation.infoRequest = { by: u.key, byName: u.name, title: u.title || '', at, atText, note };
      if (escalation.decision && escalation.decision.action === 'INFO') escalation.decision = null; // a legacy "needs info" decision
      next = { ...r, escalation, status: 'ESCALATED', timeline: line(r, `${who} asked for more information — ${note}`) };
    } else {
      escalation.decision = { action, by: u.key, byName: u.name, title: u.title || '', at, atText, note };
      delete escalation.infoRequest;
      // The history line carries no note — it lives in escalation.log, which Operations do not see.
      next = { ...r, escalation, status: action === 'APPROVE' ? 'MGMT_APPROVED' : 'MGMT_REJECTED', timeline: line(r, `${who} ${action === 'APPROVE' ? 'approved the escalation — proceed' : 'rejected the escalation'}`) };
      if (action === 'REJECT') Object.assign(next, { approved: 0, flagged: false });
    }
    postSystem('requests', next);
    const base = `${escalation.id} · ${r.id} · ${r.company}`;
    audit(u, { APPROVE: 'ESCALATION_APPROVED', REJECT: 'ESCALATION_REJECTED', INFO: 'ESCALATION_INFO_REQUESTED' }[action], `${base} — ${note}`, next, action === 'INFO' ? undefined : base);
    const head = `${r.id} · ${r.company}: ${who}`;
    // The requester: the question (INFO) — never the note of an approval or a rejection.
    const toRequester = { APPROVE: `${head} approved the escalation — proceed. Sven gives the final approval.`, REJECT: `${head} rejected the escalation. The client is free for a new request.`, INFO: `Management needs more information — ${head} asks: ${note}` }[action];
    const full = { APPROVE: `Management approved — your final approval is needed. ${head} approved the escalation — proceed. Note: ${note}`, REJECT: `${head} rejected the escalation (Rejected by Management). Note: ${note}`, INFO: `${head} asked the requester for more information: ${note}` }[action];
    if (r.by !== u.key) notify(r.by, r.by === 'sven' ? full : toRequester, r.id);
    notifyMany(['sven'].concat(to.map(t => t.key)).filter(k => k !== r.by), full, r.id, u.key);
    s.json({ ok: true, item: reqOut(u, next) });
  });

  // The requester (or Master Operations Control) answers management's question: Awaiting Management Decision again.
  app.post('/api/requests/:id/escalation/reply', requireAuth, (q, s) => {
    const u = q.user, r = find(q, s); if (!r) return;
    const asked = r.status === 'ESCALATED' && r.escalation && r.escalation.infoRequest;
    if (!r.escalation || !(asked || r.status === 'MGMT_INFO')) return fail(s, 409, 'Management has not asked for more information on this request.');
    if (!(r.by === u.key || isOpsMaster(u))) return fail(s, 403, 'Only the requester can answer management.');
    const note = str(q.body?.note, 2000);
    if (note.length < 3) return fail(s, 422, 'Write the information management asked for.');
    const at = new Date().toISOString(), atText = AUDIT_DAY();
    const escalation = { ...r.escalation, log: (r.escalation.log || []).concat([{ at, atText, who: u.key, whoName: u.name, action: 'REPLY', note }]) };
    delete escalation.infoRequest;
    if (escalation.decision && escalation.decision.action === 'INFO') escalation.decision = null;
    const next = { ...r, escalation, status: 'ESCALATED', timeline: line(r, `${u.name} answered management — ${note}`) };
    postSystem('requests', next);
    audit(u, 'ESCALATION_INFO_PROVIDED', `${escalation.id} · ${r.id} · ${r.company} — ${note}`, next);
    notifyMany(recipientsOf(r).map(p => p.key).concat('sven'), `${u.name} answered management on ${r.id} · ${r.company}: ${note}`, r.id, u.key);
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
    notifyMany(['sven'].concat(r.escalation ? recipientsOf(r).map(p => p.key) : []), `${r.id} · ${r.company} voided by ${who} — ${reason}`, r.id, u.key);
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
  const KEEP_ACTIONS = ['PLATFORM_RESET', 'PLATFORM_RESTORED'];
  const reqIds = () => new Set(db.requests.map(r => r.id));
  const liveLog = (col, ids) => x => !LEDGER_IDS[col].has(x.id) && (!x.req || !ids.has(x.req)) && !KEEP_ACTIONS.includes(x.action);
  app.get('/api/admin/reset/preview', requireAuth, masterOnly, async (_q, s) => {
    const hids = historyIds(), live = db.requests.filter(r => !isHistory(r, hids)), ids = reqIds();
    s.json({ ok: true, live: live.map(r => ({ id: r.id, company: r.company, by: r.by, byName: uName(r.by), status: r.status, requested: r.requested, date: r.date })),
      history: { requests: db.requests.length - live.length }, notifications: db.notifications.length, audit: db.audit.length, chat: db.chat.length,
      liveLogs: { audit: db.audit.filter(liveLog('audit', ids)).length, chat: db.chat.filter(liveLog('chat', ids)).length },
      lastReset: db.lastReset || null, backups: await backups() });
  });
  app.post('/api/admin/reset', requireAuth, masterOnly, async (q, s) => {
    const u = q.user, b = q.body || {}, reason = str(b.reason, 500);
    if (b.confirm !== 'RESET') return s.status(422).json({ ok: false, error: 'Type RESET to confirm.' });
    if (reason.length < 5) return s.status(422).json({ ok: false, error: 'Give a reason for the record.' });
    if (resetting) return s.status(409).json({ ok: false, error: 'A reset is already running.' });
    const want = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
    const hids = historyIds();
    const remove = new Set(db.requests.filter(r => (want.has(r.id) && !isHistory(r, hids)) || (b.includeHistory === true && isHistory(r, hids))).map(r => r.id));
    const removeLive = db.requests.filter(r => remove.has(r.id) && !isHistory(r, hids)).map(r => r.id);
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
      // Optionally also the audit entries and chat messages written on the live platform that belong to no remaining request.
      const ids = reqIds(), logs = b.clearLiveLogs === true;
      db.chat = db.chat.filter(x => !tied(x) && !(hist && LEDGER_IDS.chat.has(x.id)) && !(logs && liveLog('chat', ids)(x)));
      db.notifications = b.clearNotifications ? [] : db.notifications.filter(x => !tied(x) && !(hist && LEDGER_IDS.notifications.has(x.id)));
      db.audit = db.audit.filter(x => !tied(x) && !(hist && LEDGER_IDS.audit.has(x.id)) && !(logs && liveLog('audit', ids)(x)));
      db.purged = [...new Set((db.purged || []).concat([...remove]))];
      db.purgedLive = [...new Set((db.purgedLive || []).concat(removeLive))]; // so a ledger entry with that number is never dropped
      db.tombstones = 2;
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
    if (tooBig(item)) return s.status(413).json({ ok: false, error: 'That entry is too large or too deeply nested.' });
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(item.id) || (col === 'requests' && !/^[A-Za-z0-9_-]{1,40}$/.test(item.id))) return s.status(400).json({ ok: false, error: 'Invalid id.' });
    if (writesExceeded(q.user.key)) return s.status(429).json({ ok: false, error: 'Too many changes in a short time — wait a moment.' });
    let renamed = null;
    const sentId = item.id; // the number the browser used, before any renumbering
    if (col === 'requests') {
      const fresh = typeof item.zohoSubmitToken === 'string';
      const mapped = resolveRequestId(q.user.key, item.id);
      const ownReal = db.requests.find(x => x.id === item.id && x.by === q.user.key);
      if (mapped !== item.id && (fresh || !ownReal)) item.id = mapped; // the renamed new request — never the user's real one
      else {
        const taken = db.requests.find(x => x.id === item.id);
        const reused = !taken && (numOf(item.id) <= (db.floorNo || 0) || numOf(item.id) <= ledgerMaxNo()); // a number from before the last reset, or one the ledger holds
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
        // Operations may only mark an unchecked request 'Not validated', and may raise the flag but never clear it.
        if (prev.zohoStatus || item.zohoStatus !== 'Not validated') { if (prev.zohoStatus !== undefined) item.zohoStatus = prev.zohoStatus; else delete item.zohoStatus; }
        if (prev.flagged) item.flagged = true;
        // History is append-only for them: every stored line stays as stored; lines they add go after it.
        if (Array.isArray(prev.timeline)) {
          const stored = new Set(prev.timeline.flatMap(t => [t.at + '|' + t.text, t.at + '|' + hideAmounts(t.text), t.at + '|' + hideDecisionNote(hideAmounts(t.text))])); // as stored, or as they received it
          item.timeline = prev.timeline.concat((item.timeline || []).filter(t => !stored.has(t.at + '|' + t.text)).map(t => authored(t, q.user)));
        }
      }
      if (prev && q.user.dept === 'MANAGEMENT' && !isMaster(q.user)) { // notes and files only: every other field stays as stored
        // Files only. Notes on a request go through the escalation endpoints (and stay out of Operations' view);
        // a history line they add here is kept, signed, and treated as a management note.
        const keep = { ...prev, docs: item.docs, timeline: item.timeline };
        for (const k of Object.keys(item)) delete item[k];
        Object.assign(item, keep);
      }
      // When the card is topped up (once — an undo of "paid" does not count again): the time and the client's ledger debits then.
      if (prev && item.status === 'CREDITED' && prev.status !== 'CREDITED' && !prev.creditedAt) {
        item.creditedAt = new Date().toISOString();
        const base = item.zohoClientId ? M_finance.ledgerDebitsNow(item.zohoClientId) : null;
        if (base !== null) item.ledgerDebitsAtCredit = base; else if (item.zohoClientId) setTimeout(() => fillBaseline(item.id), 0);
      }
    }
    if (col === 'requests' && prev && OPEN.includes(item.status) && !OPEN.includes(prev.status)) {
      const other = pendingRequestFor(item.zohoClientId, [item.zohoClient, item.person, item.company]);
      if (other && other.id !== item.id) return s.status(409).json({ ok: false, reason: 'REQUEST_PENDING', error: `${other.id} is already open for this client — ${item.id} cannot be re-opened.`, pendingId: other.id });
    }
    if (col === 'requests' && !prev && !isMaster(q.user)) item.timeline = (item.timeline || []).map(t => authored(t, q.user)); // a new request's lines
    if (col === 'requests' && !prev) {
      const bad = newRequestProblem(q.user, item);
      if (bad) {
        remember(refused, q.user.key + ':' + sentId, { reason: bad.error, at: Date.now() });
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
    if (col === 'audit' && !prev) Object.assign(item, { user: q.user.name, userId: q.user.key, dept: q.user.dept, by: 'browser' }); // never someone else's name
    if (col === 'notifications' && !prev && !isMaster(q.user)) {
      // A notification from a browser says who sent it.
      item.from = q.user.key;
      if (!String(item.text || '').startsWith(q.user.name)) item.text = q.user.name + ': ' + String(item.text || '');
    }
    if (col === 'notifications' && !prev && item.req && refused.has(q.user.key + ':' + item.req)) Object.assign(item, notSubmitted(item, refused.get(q.user.key + ':' + item.req).reason));
    if (col === 'notifications' && !prev) item._at = Date.now();
    if (col === 'notifications' && prev) Object.assign(item, { ...prev, read: !!item.read }); // the recipient can only mark it read
    if (col === 'chat' && !prev) item.who = q.user.key;
    if (col === 'requests' && prev && ops(q.user)) restoreHidden(item, prev);
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
    // The merged request (stored history plus additions) stays within bounds too.
    if (col === 'requests' && ((item.timeline || []).length > 400 || (item.docs || []).length > 100 || JSON.stringify(item).length > 600_000))
      return s.status(413).json({ ok: false, error: 'This request has reached its size limit — contact Sven.' });
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
// opsDetail: the version of detail Operations see (e.g. without a management note).
function audit(u, action, detail, r, opsDetail) {
  postSystem('audit', { id: 'sa' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), at: AUDIT_DAY(), user: u.name, userId: u.key, dept: u.dept,
    action, detail, ...(opsDetail !== undefined ? { opsDetail } : {}), req: r ? r.id : '', client: r ? (r.zohoClient || r.person || r.company || '') : '', clientId: r ? r.zohoClientId || '' : '', by: 'server' });
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

const hidesAmounts = u => ops(u);

return { mount, postSystem, audit, resolveRequestId, attachZohoResult, attachFinance, awaitOwnRequest, pendingRequestFor, wasRefused, isOps: restricted, hidesAmounts, finPut, hasPendingCheck, getRequest, canSee, committedFor, isFinanceUser, status };
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

// Before every balance check: Zoho Analytics and Zoho Books must both answer with the current token. If either does not,
// nothing is decided — the request is blocked and Sven is told (one notification per 30 minutes).
const CONN_ALERT_MS = 30 * 60_000;
let connAlertAt = 0;
const CONN_FAILED = 'Zoho Analytics and Zoho Books could not both be verified — the request is blocked and Sven has been notified.';
async function connectionsOk(q, s) {
  let c;
  try { c = await M_zoho.verifyConnections(); }
  catch (e) { const at = new Date(); c = { ok: false, at: at.toISOString(), atText: stamp(at).both, analytics: { ok: false, ms: 0, error: e.message }, books: { ok: false, ms: 0, error: e.message } }; }
  if (c && c.ok) return c;
  const word = x => (x && x.ok ? 'OK' : 'FAILED');
  if (Date.now() - connAlertAt > CONN_ALERT_MS) {
    connAlertAt = Date.now();
    const text = `Zoho connection check failed (Analytics: ${word(c.analytics)}, Books: ${word(c.books)}) — funding checks are blocked until it recovers.`;
    store.postSystem('notifications', { id: 'zc' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), to: 'sven', at: stamp().both, read: false, req: null, text, _at: Date.now() });
    console.error(text, 'Analytics:', c.analytics && c.analytics.error || 'ok', '· Books:', c.books && c.books.error || 'ok');
    notifySven(text).catch(() => {});
  }
  const strip = x => ({ ok: !!(x && x.ok), ms: x && x.ms || 0 });
  const connections = store.hidesAmounts(q.user) ? { ok: false, at: c.at, atText: c.atText, analytics: strip(c.analytics), books: strip(c.books) } : c;
  s.status(503).json({ ok: false, reason: 'ZOHO_CONNECTION_FAILED', error: CONN_FAILED, connections });
  return null;
}

app.get('/api/health', async (_q, s) => s.json({ ok: true, zoho: await zohoReady, live: zohoConfig(), connections: M_zoho.lastConnections(), balancesFresh: balancesFresh(), financeFresh: M_finance.fresh(), sheet: !!(E.GOOGLE_SHEET_ID && E.GOOGLE_SERVICE_ACCOUNT_B64), lastReset: store.status().lastReset, time: new Date().toISOString() }));

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
    const clients = (await booksSearchClients(term)).map(({ outstanding, ...c }) => { const p = store.pendingRequestFor(c.contactId, [c.contactName, c.companyName]); return p ? { ...c, pendingId: p.id } : c; });
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
  const pend = store.pendingRequestFor(books.contactId, [books.contactName, books.companyName]);
  if (pend) return s.status(409).json({ found: true, locked: true, reason: 'REQUEST_PENDING', error: MSG.LOCKED, pendingId: pend.id, clientName: books.contactName });
  M_finance.prefetch();
  if (store.hidesAmounts(q.user)) {
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
  if (store.hidesAmounts(q.user)) return s.status(403).json({ ok: false, error: 'Balances are not shown to Operations.' });
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
  const b = q.body || {}, amount = Number(b.amount), opsUser = store.hidesAmounts(q.user), paid = typeof b.paid === 'string' ? b.paid.trim() : '';
  if (!(amount > 0) || !paid) return s.status(422).json({ ok: false, reason: 'MANDATORY_FIELDS', error: MSG.MANDATORY });
  let v;
  try { v = gate.verify(b.validationToken, typeof b.clientName === 'string' ? b.clientName : ''); } catch (e) { return zohoErr(s, e); }
  if (!v.ok) return s.status(403).json({ ok: false, reason: 'INVALID_VALIDATION_TOKEN', why: v.why, error: NOT_FOUND_MSG });
  const connections = await connectionsOk(q, s);
  if (!connections) return;
  let contact;
  try { contact = await booksGetContact(v.clientId); } catch (e) { return zohoErr(s, e); }
  const names = contact ? [contact.contactName, contact.companyName].filter(Boolean) : [b.clientName];
  const pend = store.pendingRequestFor(v.clientId, names);
  if (pend) return s.status(409).json({ ok: false, reason: 'REQUEST_PENDING', error: MSG.LOCKED, pendingId: pend.id });
  const probe = opsUser ? probing(q.user.key, M_finance.canonical(v.clientId), amount) : null;
  if (probe) {
    if (probe.first) {
      store.audit(q.user, 'BALANCE_PROBE_BLOCKED', `${b.clientName} — ${probe.why}`);
      store.postSystem('notifications', { id: 'zp' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), to: 'sven', at: stamp().both, read: false, req: null,
        text: `${q.user.name}: ${probe.why} for ${b.clientName} — checks paused for an hour.` });
    }
    return s.status(429).json({ ok: false, reason: 'TOO_MANY_AMOUNTS', error: 'Too many checks for this client. Contact Sven.' });
  }
  let fin;
  try { fin = await M_finance.run({ contactId: v.clientId, amount, paid, books: contact, connections, committed: store.committedFor(v.clientId, null, await M_finance.ledgerDebits(v.clientId)) }); } catch (e) { return zohoErr(s, e); }
  store.finPut(fin, q.user.key);
  const view = opsUser ? M_finance.forOps(M_finance.record(fin)) : M_finance.record(fin);
  const cfd = fin.checks.find(c => c.key === 'CFD');
  if (!fin.ok && blockedAlertDue(q.user.key, v.clientId, amount)) {
    const t = stamp();
    store.postSystem('notifications', {
      id: 'zb' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), to: 'sven', at: t.both, read: false, req: null,
      text: `Blocked — ${q.user.name} tried to request ${aed(amount)} for ${b.clientName}. Failed: ${fin.failed.map(f => f.label).join(', ')}. ${fin.staffError}`
    });
  }
  if (!fin.ok) {
    return s.status(422).json({ ok: false, sufficient: cfd.ok, reason: 'FINANCIAL_CHECKS_FAILED', error: opsUser ? fin.opsError : fin.staffError,
      failed: fin.failed, finance: view, escalate: { allowed: true, token: gate.sign({ k: 'esc', u: q.user.key, c: v.clientId, a: amount, n: b.clientName, o: names, p: paid, f: fin.id }, 30 * 60 * 1000) } });
  }
  s.json({ ok: true, sufficient: true, status: STATUS.PROVISIONAL, submitToken: gate.sign({ k: 'submit', u: q.user.key, c: v.clientId, a: amount, n: b.clientName, o: names, p: paid, f: fin.id }, 15 * 60 * 1000),
    finance: view });
});

// Operations only ever learn sufficient / not sufficient. Trying many amounts for one client would reveal its balance:
// an Operations user gets PROBE_MAX different amounts per client (and PROBE_TOTAL checks in all) per hour; past that,
// checks for that client stop for an hour. Returns null when allowed, else { why, first } (first: alert once per lock).
const PROBE_MAX = 6, PROBE_TOTAL = 40, HOUR = 3600_000, probes = new Map(), probeLocks = new Map();
const alerted = new Map(); // `${user}:${client}:${amount}` -> last 'Blocked' alert to Sven
const blockedAlertDue = (u, c, a) => { const k = u + ':' + c + ':' + a, due = Date.now() - (alerted.get(k) || 0) > 10 * 60_000; if (due) alerted.set(k, Date.now()); if (alerted.size > 5000) alerted.delete(alerted.keys().next().value); return due; };
function probing(userKey, clientKey, amount) {
  const now = Date.now(), k = userKey + ':' + clientKey, lock = probeLocks.get(k);
  if (lock && now < lock) return { why: 'checks paused', first: false };
  const list = (probes.get(k) || []).filter(x => now - x.at < HOUR); list.push({ amount, at: now }); probes.set(k, list);
  const all = (probes.get(userKey) || []).filter(t => now - t < HOUR); all.push(now); probes.set(userKey, all);
  if (probes.size > 5000) probes.delete(probes.keys().next().value);
  const why = new Set(list.map(x => x.amount)).size > PROBE_MAX ? `more than ${PROBE_MAX} different amounts checked within an hour`
    : all.length > PROBE_TOTAL ? `more than ${PROBE_TOTAL} checks within an hour` : '';
  if (!why) return null;
  probeLocks.set(k, now + HOUR);
  return { why, first: true };
}

const checks = new Map(); // `${user}:${request or client}` -> last funding check
function checkThrottled(userKey, what) {
  const k = userKey + ':' + what, last = checks.get(k) || 0;
  if (Date.now() - last < 120_000) return true;
  checks.set(k, Date.now());
  if (checks.size > 5000) checks.delete(checks.keys().next().value);
  return false;
}

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
  // A request already on the platform is checked against its own client — the pick token (30 minutes) is not needed.
  const known = req.requestId ? store.getRequest(store.resolveRequestId(q.user.key, req.requestId)) : null;
  // A history request (from before the Zoho client link) names no Books client: Operations cannot point it at one.
  if (known && !known.zohoClientId && store.hidesAmounts(q.user))
    return s.status(409).json({ ok: false, reason: 'NO_ZOHO_CLIENT', error: 'This request predates the Zoho client link — Sven checks it before approving.' });
  const connections = await connectionsOk(q, s);
  if (!connections) return;
  // Outside finance, one check per request (or client) every two minutes: each check notifies Sven and writes the sheet.
  if (!store.isFinanceUser(q.user) && checkThrottled(q.user.key, known ? known.id : (b.validationToken ? 't:' + String(b.validationToken).slice(0, 80) : 'n:' + req.clientName)))
    return s.status(429).json({ ok: false, reason: 'CHECKED_RECENTLY', error: 'This request was checked a moment ago — try again in two minutes.' });
  let books;
  try {
    if (known && known.zohoClientId && store.canSee(q.user, known)) books = await booksGetContact(known.zohoClientId);
    else if (b.validationToken) {
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
  // Operations check only a request they submitted (its stored amount), or — while it is still on its way — the exact client
  // and amount of the checks the server issued at Send: no free-form amounts to probe a balance with.
  if (store.hidesAmounts(q.user) && !stored && !store.hasPendingCheck(q.user.key, books.contactId, req.requestedAmount))
    return s.status(409).json({ ok: false, reason: 'REQUEST_NOT_FOUND', error: 'The request has not reached the server yet — Sven checks it before approving.' });
  if (stored && stored.status === 'VOID') return s.status(409).json({ ok: false, reason: 'REQUEST_VOID', error: 'This request has been voided.' });
  // A check on a stored request is a check of THAT request: its client and its amount, never ones from the browser.
  if (stored && stored.zohoClientId && String(stored.zohoClientId) !== String(books.contactId))
    return s.status(409).json({ ok: false, reason: 'CLIENT_MISMATCH', error: `This check was for a different client than ${stored.id}.` });
  if (stored) Object.assign(req, { requestedAmount: Number(stored.approved || stored.requested) || req.requestedAmount, clientName: books.contactName,
    company: stored.company || req.company, purpose: stored.purpose || req.purpose });

  // The balance and the three financial checks come from Zoho — if they cannot be read, nothing is decided.
  let rec, fin, held = 0;
  try {
    const committed = store.committedFor(books.contactId, stored ? stored.id : null, await M_finance.ledgerDebits(books.contactId));
    [rec, fin] = await Promise.all([analyticsBalance(M_finance.canonical(books.contactId)), M_finance.run({ contactId: books.contactId, amount: req.requestedAmount, paid: stored ? stored.paid : String(b.paid || ''), books, committed, connections })]);
    held = committed.amount;
  } catch (e) { return zohoErr(s, e); }

  // Decided on what can still be approved: the ledger balance less amounts approved or credited and not yet booked.
  // The record, the sheet and Sven's messages keep the ledger figure itself as the Zoho Analytics balance.
  const d = decide({ req, books, rec: rec && { ...rec, available: rec.available - held }, fin });
  if (rec) Object.assign(d, { available: rec.available, availableNet: rec.available - held, held });
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
    availableBalance: d.availableNet ?? d.available ?? 0, ledgerBalance: d.available ?? 0, heldBalance: d.held ?? 0, allocatedBalance: d.allocated ?? 0, usedBalance: d.used ?? 0,
    remainingAfterRequest: d.remaining ?? 0, requestedAmount: req.requestedAmount,
    notes: d.notes, flagSven: d.flagSven, svenNotified, svenSummary, sheet, reviewer: REVIEWER, exported, requestId: req.requestId || null, attachedToRequest: attached,
    source: 'Zoho Books + Zoho Analytics', route: fin.route, booksAvailable: d.booksAvailable ?? null, validationId, checkedAt, finance: M_finance.record(fin)
  };
  if (store.hidesAmounts(q.user)) { // the result, never the balance
    for (const k of ['availableBalance', 'ledgerBalance', 'heldBalance', 'allocatedBalance', 'usedBalance', 'remainingAfterRequest', 'svenSummary', 'exported', 'booksAvailable']) delete out[k];
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
  // Only PDFs and images open in the browser; anything else downloads. Never sniffed, never scripted (stored-XSS guard).
  const safe = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/i.test(m.mime || '');
  s.set({ 'Content-Type': safe ? m.mime : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': (safe ? 'inline' : 'attachment') + '; filename="' + String(m.name || 'file').replace(/[^\w. -]/g, '_') + '"' });
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
// Brand: the OneLink mark in the tab, on the home screen and in the page title.
const BRAND_DIR = fileURLToPath(new URL('./brand', import.meta.url));
app.use('/brand', express.static(BRAND_DIR, { maxAge: '1d', index: false, fallthrough: false }));
app.get('/favicon.ico', (_q, s) => s.sendFile(path.join(BRAND_DIR, 'favicon.ico'), { maxAge: '1d' }, e => { if (e && !s.headersSent) s.status(404).end(); }));
const BRAND_HEAD = '<title>OneLink Funds</title>\n  <link rel="icon" type="image/png" sizes="32x32" href="/brand/icon-32.png">\n  <link rel="icon" href="/favicon.ico" sizes="any">\n  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">\n  <meta name="theme-color" content="#1f6bff">';
// Only the document's own <head> is touched (the bundled template further down is left alone).
function brandHead(html) {
  const end = html.search(/<\/head>/i);
  if (end < 0) return html;
  let head = html.slice(0, end);
  if (head.includes('href="/brand/icon-32.png"')) return html;
  head = /<title>[^<]*<\/title>/i.test(head) ? head.replace(/<title>[^<]*<\/title>/i, BRAND_HEAD) : head.replace(/<head([^>]*)>/i, '<head$1>\n  ' + BRAND_HEAD);
  return head + html.slice(end);
}
let liveHtml = { mtime: 0, body: null };
function servedHtml() {
  const mtime = fs.statSync(__html).mtimeMs;
  if (liveHtml.mtime !== mtime) {
    let body = fs.readFileSync(__html, 'utf8'), hit = 0;
    for (const [from, to] of LIVE_RULES) { const next = body.replace(from, to); if (next !== body) hit++; body = next; }
    const wf = patchPage(body);
    body = brandHead(wf.html);
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
// Warm the Zoho caches once the server is up, so the first check after a restart does not wait for every export.
zohoReady.then(r => { if (r !== 'none' && r !== 'failed') setTimeout(() => { prefetchBalances(); M_finance.prefetch(); }, 1500); });
