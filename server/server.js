import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import crypto from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { patchPage } from './client-workflow.js';

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

const timers = {};
function push(k, json) {
  if (!enabled) return;
  clearTimeout(timers[k]);
  timers[k] = setTimeout(() => cmd(['SET', 'onelink:' + k, json]).catch(e => console.error('Upstash backup failed:', k, e.message)), 400);
}

return { enabled, kvGet, kvSet, push };
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
const contactOut = c => ({ contactId: String(c.contact_id), contactName: c.contact_name, companyName: c.company_name || '', status: c.status });

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
const num = v => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
function toRecord(r) {
  const C = col();
  return {
    clientId: r[C.id] || null, clientName: r[C.client] || '', companyName: C.company ? r[C.company] || '' : '',
    allocated: num(r[C.allocated]), used: num(r[C.used]),
    available: r[C.available] !== undefined && r[C.available] !== '' ? num(r[C.available]) : num(r[C.allocated]) - num(r[C.used]),
    categories: C.categories ? String(r[C.categories] || '').split(',').map(s => s.trim()).filter(Boolean) : []
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

async function analyticsSql(sql) {
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
    console.log(`Zoho Analytics: ${rows.length} balance rows in ${Date.now() - t0} ms`);
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

// Balance row for one Books contact, never older than BALANCE_TTL. null = no balance record in Analytics.
async function analyticsBalance(contactId) {
  if (!/^\d{1,30}$/.test(String(contactId || ''))) return null;
  if (!balancesFresh()) await refreshBalances();
  return balances.get(String(contactId)) || null;
}

return { zohoReady, accessToken, exact, norm, booksSearchClients, booksGetContact, booksFindContactExact, analyticsBalance, prefetchBalances, balancesFresh, col, toRecord, config: () => ({ booksOrg: booksOrg() + ' (ELITE ONELINK CORPORATE SERVICES L.L.C S.O.C)', analyticsOrg: zaOrg(), workspace: zaWs(), table: zaTable() }) };
})();

// ---- rules.js ----
const M_rules = await (async () => {
const { norm } = M_zoho;
// The approval rules, in one pure function so they can be unit-tested.
// Live data only: the Books contact and the Analytics balance row are passed in by the caller.

const STATUS = {
  PROVISIONAL: 'Partially Approved – pending final confirmation with Sven',
  FLAGGED: 'Flagged – Sven review',
  NOT: 'Not Approved'
};
const MSG = {
  NOT_FOUND: 'Client not found in Zoho Books. Cannot proceed.',
  INSUFFICIENT: 'Client does not have sufficient balance in Zoho Analytics. Flagging Sven for review.',
  PASSED: 'Partially Approved – pending final confirmation with Sven.'
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
// Nothing here ever grants final approval — the best outcome is provisional, pending Sven.
function decide({ req, books, rec }) {
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

  // 5. Sufficient → provisional only; Sven gives the final confirmation.
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
      rule('=REGEXMATCH($E2,"^Partially Approved")', '#d9ead3', 0),
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

function verify(token, clientName) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, why: 'NO_TOKEN' };
  const [body, sig] = token.split('.');
  const want = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, why: 'BAD_SIGNATURE' };
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (p.exp < Date.now()) return { ok: false, why: 'EXPIRED' };
  if (p.n !== clientName) return { ok: false, why: 'NAME_MISMATCH' };
  return { ok: true, clientId: p.id, matchedIn: p.m };
}

// One attempt per session: a failed name locks the session until it restarts.
const locks = new Map(); // sessionId -> { name, at }
const lock = (sid, name) => sid && locks.set(sid, { name, at: new Date().toISOString() });
const locked = sid => (sid && locks.get(sid)) || null;
const unlock = sid => sid && locks.delete(sid);

return { issue, verify, lock, locked, unlock };
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
function seedTeam() {
  const pw = process.env.SEED_TEAM_PASSWORD;
  if (!pw || pw.length < 8) return [];
  const mk = (key, name, dept) => ({ key, name, username: key + '@onelink.solutions', role: dept, dept, active: true, perms: dept === 'OPERATIONS' ? OPS : [], pw: hash(pw), pwSetAt: new Date().toISOString(), failCount: 0, lockedUntil: 0, created: new Date().toISOString() });
  return [mk('adnan', 'Adnan', 'MANAGEMENT'), ...['amina', 'anastasiya', 'maram', 'musa', 'wafaa'].map(k => mk(k, k[0].toUpperCase() + k.slice(1), 'OPERATIONS'))];
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
const pub = (u, on = onlineKeys()) => ({ key: u.key, name: u.name, username: u.username, role: u.role, dept: u.dept, active: u.active, perms: u.perms || [], created: u.created,
  lastLogin: when(u.lastLogin), lastLoginAt: u.lastLogin || null, online: on.has(u.key), passwordSetAt: u.pwSetAt || null, passwordSet: u.pwSetAt ? when(u.pwSetAt) : 'not recorded yet', // tracked from this version on
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

return { setBroadcast, load, pub, requireAuth, isMaster, mount };
})();

// ---- store.js ----
const M_store = await (async () => {
const { push } = M_cloud;
const { requireAuth, isMaster, setBroadcast, load: loadUsers, pub } = M_auth;
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
try {
  const L = JSON.parse(fs.readFileSync(new URL('./ledger.json', import.meta.url), 'utf8'));
  if (!db.requests.length) {
    for (const c of COLS) if (Array.isArray(L[c])) db[c] = L[c];
    db.rev++; persist(); console.log('Ledger: loaded', db.requests.length, 'requests into an empty server.');
  } else {
    const n = mergeMissing('requests', L.requests || []);
    if (n) { db.rev++; persist(); }
    console.log('Ledger:', n ? 'added ' + n + ' missing requests.' : 'server already up to date.');
  }
} catch (e) { console.error('Ledger not applied:', e.message); }

const clients = new Set(); // { res, user }
const ops = u => u.dept === 'OPERATIONS' && !isMaster(u);
// What each user may see
function visible(u, col, item) {
  if (isMaster(u)) return true;
  if (col === 'requests') return !ops(u) || item.by === u.key;
  if (col === 'notifications') return item.to === u.key;
  if (col === 'audit') return u.dept === 'MANAGEMENT';
  return true; // chat: shared group thread
}
function send(c, ev) { c.res.write(`data: ${JSON.stringify(ev)}\n\n`); }
function broadcast(ev, col, item) {
  for (const c of clients) {
    if (ev.type === 'login' && !isMaster(c.user)) continue;
    if (ev.type === 'accounts' && !isMaster(c.user)) continue;
    if (col && item && !visible(c.user, col, item)) continue;
    send(c, ev);
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
  if (isMaster(u)) return true;
  if (col === 'requests') {
    if (ops(u)) return item.by === u.key && (!prev || prev.by === u.key) && (!prev || prev.status === item.status || ['NEW', 'ACTION'].includes(item.status) || (prev.status === 'CREDITED' && item.status === 'PAID'));
    return (u.perms || []).some(p => ['APPROVE_REQUEST', 'DECLINE_REQUEST', 'CREDIT_FUNDS', 'RELEASE_FUNDS', 'PARTIAL_APPROVE_REQUEST'].includes(p)) || u.dept === 'MANAGEMENT' || u.dept === 'FINANCE';
  }
  if (col === 'chat') return !prev && item.who === u.key;
  if (col === 'notifications') return !prev || prev.to === u.key; // create for anyone, mark own as read
  if (col === 'audit') return !prev;
  return false;
}

function upsert(col, item) {
  const list = db[col], i = list.findIndex(x => x.id === item.id);
  const prev = i >= 0 ? list[i] : null;
  if (i >= 0) list[i] = item; else if (col === 'chat') list.push(item); else list.unshift(item); // chat is oldest-first, the rest newest-first
  if (col === 'audit' && list.length > 5000) list.length = 5000;
  db.rev++; persist();
  return prev;
}

function mount(app) {
  app.get('/api/sync/snapshot', requireAuth, (q, s) => {
    const u = q.user, out = { rev: db.rev, me: pub(u), empty: db.requests.length === 0 };
    for (const c of COLS) out[c] = db[c].filter(x => visible(u, c, x));
    out.accounts = loadUsers().map(u => pub(u));
    s.json(out);
  });

  // First Master Admin sign-in uploads the existing workbook when the server is empty.
  app.post('/api/sync/bootstrap', requireAuth, (q, s) => {
    if (!isMaster(q.user)) return s.status(403).json({ ok: false });
    if (db.requests.length) return s.status(409).json({ ok: false, error: 'Server already has data' });
    for (const c of COLS) if (Array.isArray(q.body?.[c])) db[c] = q.body[c];
    db.rev++; persist();
    broadcast({ type: 'reload' });
    s.json({ ok: true, rev: db.rev });
  });

  // Master Admin adds historical items the server does not have yet — ids already present are never touched.
  // Each new item is slotted in by date ('09 Apr') so the newest-first order holds; existing order is kept.
  app.post('/api/sync/merge', requireAuth, (q, s) => {
    if (!isMaster(q.user)) return s.status(403).json({ ok: false });
    const { col, items } = q.body || {};
    if (!COLS.includes(col) || !Array.isArray(items)) return s.status(400).json({ ok: false, error: 'col + items[] required' });
    const added = mergeMissing(col, items);
    if (!added) return s.json({ ok: true, added: 0, rev: db.rev });
    db.rev++; persist();
    broadcast({ type: 'reload' });
    s.json({ ok: true, added, rev: db.rev });
  });

  app.post('/api/sync/put', requireAuth, (q, s) => {
    const { col, item } = q.body || {};
    if (!COLS.includes(col) || !item || typeof item.id !== 'string') return s.status(400).json({ ok: false, error: 'col + item.id required' });
    const prev = db[col].find(x => x.id === item.id) || null;
    if (!mayWrite(q.user, col, item, prev)) return s.status(403).json({ ok: false, error: 'Not permitted' });
    upsert(col, item);
    broadcast({ type: 'put', col, item, rev: db.rev, by: q.user.key }, col, item);
    s.json({ ok: true, rev: db.rev });
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
}

// Server-authored items (funding-check results): stored and pushed live like any user write.
function postSystem(col, item) {
  upsert(col, item);
  broadcast({ type: 'put', col, item, rev: db.rev, by: 'system' }, col, item);
  return item;
}

return { mount, postSystem };
})();

// ---- server.js ----
const { booksSearchClients, booksGetContact, booksFindContactExact, analyticsBalance, prefetchBalances, balancesFresh, accessToken, zohoReady, config: zohoConfig } = M_zoho;
const { decide, MSG } = M_rules;
const { appendRecord } = M_sheets;
const gate = M_gate;
const auth = M_auth;
const store = M_store;

const E = process.env;
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

app.get('/api/health', async (_q, s) => s.json({ ok: true, zoho: await zohoReady, live: zohoConfig(), balancesFresh: balancesFresh(), sheet: !!(E.GOOGLE_SHEET_ID && E.GOOGLE_SERVICE_ACCOUNT_B64), time: new Date().toISOString() }));

app.get('/api/zoho/test', async (_q, s) => {
  try { await accessToken(); s.json({ ok: true, oauth: 'refreshed', live: zohoConfig() }); } catch (e) { zohoErr(s, e); }
});

// STEP 1a — type-ahead. Live Zoho Books customers matching the typed letters (2+).
app.get('/api/zoho/clients', async (q, s) => {
  const term = typeof q.query.q === 'string' ? q.query.q.trim().slice(0, 100) : '';
  if (term.length < 2) return s.json({ ok: true, clients: [], tooShort: true });
  prefetchBalances(); // so the balance is ready when a client is picked
  try {
    const clients = await booksSearchClients(term);
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
  const contactId = String(q.query.contactId || '');
  if (!/^\d{1,30}$/.test(contactId)) return s.status(400).json({ ok: false, error: 'contactId required' });
  try { s.json({ ok: true, clientId: contactId, balance: balanceOut(await analyticsBalance(contactId)), checkedAt: new Date().toISOString() }); } catch (e) { zohoErr(s, e); }
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
    text: `Zoho check · ${rec.clientName}${rec.requestId ? ' · ' + rec.requestId : ''} — requested ${aed(rec.requested)}, Zoho Analytics balance ${aed(rec.balance)}. ${d.ok ? rec.status + '.' : rec.notes} Reviewer: ${REVIEWER}.`,
    zoho: rec
  });
  store.postSystem('notifications', {
    id: 'zn' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), to: 'sven', at: t.both, read: false, req: rec.requestId,
    text: (d.ok ? 'Pending your final confirmation — ' : 'Flagged for your review — ') + `${rec.clientName}: ${aed(rec.requested)} requested, ${aed(rec.balance)} in Zoho Analytics. ${rec.notes}`
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

  // The balance must come from Zoho Analytics — if it cannot be read, nothing is decided.
  let rec;
  try { rec = await analyticsBalance(books.contactId); } catch (e) { return zohoErr(s, e); }

  const d = decide({ req, books, rec });
  const validationId = 'ZV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const checkedAt = new Date().toISOString();
  const exported = exportRecord(req, d, q.user, { validationId, checkedAt });

  let sheet;
  try {
    sheet = await appendRecord({ ...exported, notes: `${exported.reason} · ${exported.notes} · ${req.purpose} · ${exported.requestId || '—'} · ${validationId} · checked by ${exported.checkedBy}` });
  } catch (e) { sheet = { written: false, why: e.message }; }

  const svenSummary = { clientName: req.clientName, requestedAmount: req.requestedAmount, zohoAnalyticsBalance: exported.balance, approvalStatus: d.approvalStatus, flagReason: d.ok ? '' : d.notes };
  const svenNotified = await notifySven(`OneLink funding check — ${req.clientName}: ${d.approvalStatus}. Requested ${aed(req.requestedAmount)}, Zoho Analytics balance ${aed(exported.balance)}.${d.ok ? '' : ' ' + d.notes}`, { summary: svenSummary });

  s.json({
    ok: d.ok, reason: d.reason, approvalStatus: d.approvalStatus, approvedAmount: d.approvedAmount,
    clientMatched: d.clientMatched, booksMatched: d.booksMatched, analyticsMatched: d.analyticsMatched, relevancePassed: d.relevancePassed,
    clientId: d.clientId || null,
    availableBalance: d.available ?? 0, allocatedBalance: d.allocated ?? 0, usedBalance: d.used ?? 0,
    remainingAfterRequest: d.remaining ?? 0, requestedAmount: req.requestedAmount,
    notes: d.notes, flagSven: d.flagSven, svenNotified, svenSummary, sheet, reviewer: REVIEWER, exported,
    source: 'Zoho Books + Zoho Analytics', validationId, checkedAt
  });
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
