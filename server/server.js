import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import crypto from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

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
// Zoho OAuth refresh + Books contact lookup + Analytics balance row.
// Client identity is EXACT-match only: spelling, spacing, punctuation and case.
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
  const res = await fetch(`https://accounts.zoho.${dc()}/oauth/v2/token?${q}`, { method: 'POST' });
  const j = await res.json();
  if (!j.access_token) throw Object.assign(new Error('Zoho OAuth refresh failed: ' + (j.error || res.status)), { code: 'AUTH' });
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// Strict equality — no trimming, no case folding, no fuzzy matching, no guessing.
const exact = (list, name, ...getters) => list.find(x => getters.some(g => g(x) === name)) || null;

// Loose normaliser — used ONLY for the relevance check, never for identity.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function booksFindContactExact(name) {
  if (!E.ZOHO_BOOKS_ORG_ID) return { skipped: true };
  const t = await accessToken();
  const q = new URLSearchParams({ organization_id: E.ZOHO_BOOKS_ORG_ID, search_text: name, per_page: '200' });
  const res = await fetch(`https://www.zohoapis.${dc()}/books/v3/contacts?${q}`, { headers: { Authorization: 'Zoho-oauthtoken ' + t } });
  if (!res.ok) throw Object.assign(new Error('Zoho Books ' + res.status), { code: 'BOOKS' });
  const j = await res.json();
  const hit = exact(j.contacts || [], name, c => c.contact_name, c => c.company_name);
  return hit ? { contactId: hit.contact_id, contactName: hit.contact_name, companyName: hit.company_name } : null;
}

async function analyticsFindClientExact(name) {
  if (!E.ZOHO_VIEW_ID) return null; // balance table not shared yet — Books alone validates identity
  const need = ['ZOHO_ORG_ID', 'ZOHO_WORKSPACE_ID', 'ZOHO_VIEW_ID'].filter(k => !E[k]);
  if (need.length) throw Object.assign(new Error('Missing env: ' + need.join(', ')), { code: 'ENV' });
  const t = await accessToken();
  const C = col();
  const esc = s => String(s).replace(/'/g, "''");
  const crit = `("${C.client}" = '${esc(name)}' or "${C.company}" = '${esc(name)}')`;
  const config = JSON.stringify({ responseFormat: 'json', criteria: crit });
  const url = `https://analyticsapi.zoho.${dc()}/restapi/v2/workspaces/${E.ZOHO_WORKSPACE_ID}/views/${E.ZOHO_VIEW_ID}/data?CONFIG=${encodeURIComponent(config)}`;
  const res = await fetch(url, { headers: { Authorization: 'Zoho-oauthtoken ' + t, 'ZANALYTICS-ORGID': E.ZOHO_ORG_ID } });
  if (res.status === 429) throw Object.assign(new Error('Zoho Analytics rate limit'), { code: 'RATE' });
  if (!res.ok) throw Object.assign(new Error('Zoho Analytics ' + res.status + ' ' + (await res.text()).slice(0, 200)), { code: 'ANALYTICS' });
  const j = await res.json();
  const rows = j.data || (j.response && j.response.result && j.response.result.rows) || [];
  // Analytics criteria can be case-insensitive — re-check strictly here.
  const hit = exact(rows, name, r => r[C.client], r => r[C.company]);
  return hit ? toRecord(hit) : null;
}

function col() {
  return {
    client: E.ZA_COL_CLIENT || 'Client Name', company: E.ZA_COL_COMPANY || 'Company Name', id: E.ZA_COL_CLIENT_ID || 'Client ID',
    allocated: E.ZA_COL_ALLOCATED || 'Allocated', used: E.ZA_COL_USED || 'Used',
    available: E.ZA_COL_AVAILABLE || 'Available Balance', categories: E.ZA_COL_CATEGORIES || 'Categories'
  };
}
const num = v => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
function toRecord(r) {
  const C = col();
  return {
    clientId: r[C.id] || null, clientName: r[C.client] || '', companyName: r[C.company] || '',
    allocated: num(r[C.allocated]), used: num(r[C.used]),
    available: r[C.available] !== undefined ? num(r[C.available]) : num(r[C.allocated]) - num(r[C.used]),
    categories: String(r[C.categories] || '').split(',').map(s => s.trim()).filter(Boolean)
  };
}

return { zohoReady, accessToken, exact, norm, booksFindContactExact, analyticsFindClientExact, col, toRecord };
})();

// ---- rules.js ----
const M_rules = await (async () => {
const { norm } = M_zoho;
// The approval rules, in one pure function so they can be unit-tested.

const STATUS = {
  APPROVED: 'Approved (Pending Sven Final Check)',
  PARTIAL: 'Partially Approved',
  NOT: 'Not Approved'
};

// Relevance: the purpose must fall in a category the client's MCP ledger covers,
// and the request's company must belong to the matched client record.
function relevance(req, rec) {
  const p = norm(req.purpose);
  const catOk = !rec.categories.length || rec.categories.some(c => { const n = norm(c); return n && (p.includes(n) || n.includes(p)); });
  const co = norm(req.company), rc = norm(rec.companyName), rn = norm(rec.clientName);
  const coOk = !co || !rc || co.includes(rc) || rc.includes(co) || co.includes(rn) || rn.includes(co);
  return { ok: catOk && coOk, catOk, coOk };
}

function decide({ req, books, rec }) {
  const requested = Number(req.requestedAmount) || 0;
  const booksMatched = !!(books && !books.skipped);
  const analyticsMatched = !!rec;
  const base = { requested, booksMatched, analyticsMatched, booksContactId: booksMatched ? books.contactId : null };

  // 1. Client name must exist in Zoho Books OR Zoho Analytics.
  if (!booksMatched && !analyticsMatched) return { ...base, ok: false, clientMatched: false, relevancePassed: false, reason: 'CLIENT_NOT_FOUND', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: 'Client name not found in Zoho Books or Zoho Analytics — rejected.' };
  // Balance only lives in Analytics; a Books-only match has no balance to release against.
  if (!analyticsMatched) return { ...base, ok: false, clientMatched: true, relevancePassed: false, available: 0, reason: 'NO_ANALYTICS_RECORD', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: 'Client exists in Zoho Books but has no balance record in Zoho Analytics.' };

  const out = { ...base, clientMatched: true, clientId: rec.clientId, companyName: rec.companyName || req.company, available: rec.available, allocated: rec.allocated, used: rec.used };

  // 3. Relevance to the client's MCP data.
  const rel = relevance(req, rec);
  if (!rel.ok) return { ...out, ok: false, relevancePassed: false, remaining: rec.available, reason: 'NOT_RELEVANT', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: !rel.catOk ? `Purpose "${req.purpose}" is not a category on the client's ledger (${rec.categories.join(', ')}).` : `Company "${req.company}" does not belong to this client record.` };

  // 2/4/5. Balance.
  if (rec.available <= 0) return { ...out, ok: false, relevancePassed: true, remaining: 0, reason: 'ZERO_AVAILABLE_BALANCE', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: 'Zero client balance in Zoho Analytics.' };
  if (rec.available < requested) return { ...out, ok: true, partialOnly: true, relevancePassed: true, remaining: 0, reason: 'PARTIAL_BALANCE', approvalStatus: STATUS.PARTIAL, approvedAmount: rec.available, flagSven: true, notes: `Capped at available balance ${rec.available}; ${requested - rec.available} short. Needs Sven final confirmation.` };
  return { ...out, ok: true, relevancePassed: true, remaining: rec.available - requested, reason: 'VALIDATION_PASSED', approvalStatus: STATUS.APPROVED, approvedAmount: requested, flagSven: true, notes: 'Full balance available. Pending Sven final check.' };
}

return { STATUS, relevance, decide };
})();

// ---- sheets.js ----
const M_sheets = await (async () => {

// Finance_Approval_Records — append-only log with frozen header + status colours.

const HEADER = ['Client Name', 'Company Name', 'Amount Requested', 'Amount Approved', 'Approval Status', 'Zoho Analytics Balance', 'Notes / Flags'];
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

  const head = await s.spreadsheets.values.get({ spreadsheetId: id, range: `${tab()}!A1:G1` });
  if (!head.data.values || !head.data.values.length) {
    await s.spreadsheets.values.update({ spreadsheetId: id, range: `${tab()}!A1:G1`, valueInputOption: 'RAW', requestBody: { values: [HEADER] } });
    const range = { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 };
    const rule = (formula, color, index) => ({ addConditionalFormatRule: { index, rule: { ranges: [range], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format: { backgroundColor: rgb(color) } } } } });
    await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
      rule('=REGEXMATCH($E2,"^Approved")', '#d9ead3', 0),
      rule('=$E2="Partially Approved"', '#fff2cc', 1),
      rule('=$E2="Not Approved"', '#f4cccc', 2)
    ] } });
  }
  ready = true;
}

async function appendRecord(row) {
  const s = client();
  if (!s) return { written: false, why: 'GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_B64 not set' };
  const id = process.env.GOOGLE_SHEET_ID;
  await ensure(s, id);
  const r = await s.spreadsheets.values.append({
    spreadsheetId: id, range: `${tab()}!A:G`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[row.clientName, row.companyName, row.requested, row.approved, row.status, row.balance, row.notes]] }
  });
  await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 7 } } }] } });
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
const history = [];
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
  const mk = (key, name, dept) => ({ key, name, username: key + '@onelink.solutions', role: dept, dept, active: true, perms: dept === 'OPERATIONS' ? OPS : [], pw: hash(pw), failCount: 0, lockedUntil: 0, created: new Date().toISOString() });
  return [mk('adnan', 'Adnan', 'MANAGEMENT'), ...['amina', 'anastasiya', 'maram', 'musa', 'wafaa'].map(k => mk(k, k[0].toUpperCase() + k.slice(1), 'OPERATIONS'))];
}
function load() {
  if (!fs.existsSync(FILE)) {
    const pw = process.env.MASTER_ADMIN_PASSWORD;
    if (!pw || pw.length < 12) throw new Error('Set MASTER_ADMIN_PASSWORD (12+ chars) for the first start — it creates the Master Admin account.');
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    save([{ key: 'sven', name: 'Sven', username: (process.env.MASTER_ADMIN_EMAIL || 'sven@onelink.solutions').toLowerCase(), role: 'MASTER_ADMIN', dept: 'FINANCE', active: true, perms: ['*'], pw: hash(pw), failCount: 0, lockedUntil: 0, created: new Date().toISOString() }, ...seedTeam()]);
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function save(users) { const j = JSON.stringify(users, null, 2); fs.writeFileSync(FILE + '.tmp', j); fs.renameSync(FILE + '.tmp', FILE); push('users', j); }
const pub = u => ({ key: u.key, name: u.name, username: u.username, role: u.role, dept: u.dept, active: u.active, perms: u.perms || [], created: u.created, lastLogin: u.lastLogin || '—', locked: (u.lockedUntil || 0) > Date.now() });
const broadcastUsers = () => onEvent({ type: 'accounts', items: load().map(pub) });

function record(kind, who, detail, ip) {
  const e = { at: new Date().toISOString(), kind, who, detail, ip };
  history.unshift(e); history.length = Math.min(history.length, 500);
  fs.appendFile(path.join(path.dirname(FILE), 'login-history.jsonl'), JSON.stringify(e) + '\n', () => {});
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
      save(users);
      return bad(401, left > 0 ? `Email or password is not right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Five wrong passwords — account locked for 15 minutes.', left > 0 ? 'FAILED' : 'LOCKED');
    }
    u.failCount = 0; u.lockedUntil = 0; u.lastLogin = new Date().toISOString(); save(users);
    const t = crypto.randomBytes(32).toString('base64url');
    sessions.set(t, { user: u.key, last: Date.now() });
    s.append('Set-Cookie', `ol_auth=${t}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${IDLE_MS / 1000}`);
    record('SUCCESS', u.name, 'Signed in', q.ip);
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
    u.pw = hash(pw); u.failCount = 0; u.lockedUntil = 0; u.active = true; save(users); kill(u.key);
    record('RESET', u.name, 'Master password reset with the recovery code', q.ip);
    s.json({ ok: true });
  });
  app.post('/api/auth/logout', requireAuth, (q, s) => { sessions.delete(q.token); record('LOGOUT', q.user.name, 'Signed out', q.ip); s.json({ ok: true }); });
  app.get('/api/auth/me', requireAuth, (q, s) => s.json({ ok: true, user: pub(q.user) }));

  app.get('/api/admin/users', requireAuth, requireMaster, (_q, s) => s.json(load().map(pub)));
  app.post('/api/admin/users', requireAuth, requireMaster, (q, s) => {
    const b = q.body || {}, users = load(), username = String(b.username || '').trim().toLowerCase();
    if (!/.+@.+\..+/.test(username) || !b.name || String(b.password || '').length < 8) return s.status(400).json({ ok: false, error: 'Name, work email and an 8+ character password are required.' });
    if (users.some(u => u.username === username)) return s.status(409).json({ ok: false, error: 'An account already uses that email.' });
    const dept = b.dept || 'OPERATIONS';
    const u = { key: keyFor(username, users), name: String(b.name), username, role: b.role || dept, dept, active: b.active !== false, perms: Array.isArray(b.perms) ? b.perms : (dept === 'OPERATIONS' ? OPS : []), pw: hash(String(b.password)), failCount: 0, lockedUntil: 0, created: new Date().toISOString() };
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
    u.pw = hash(pw); u.failCount = 0; u.lockedUntil = 0; save(users); kill(u.key);
    record('PASSWORD_RESET', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true });
  });
  app.delete('/api/admin/users/:key', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key);
    if (!u || isMaster(u)) return s.status(400).json({ ok: false });
    save(users.filter(x => x.key !== u.key)); kill(u.key);
    record('USER_DELETED', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true });
  });
  app.get('/api/admin/login-history', requireAuth, requireMaster, (_q, s) => s.json(history.slice(0, 200)));
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
  if (i >= 0) list[i] = item; else list.unshift(item);
  if (col === 'audit' && list.length > 5000) list.length = 5000;
  db.rev++; persist();
  return prev;
}

function mount(app) {
  app.get('/api/sync/snapshot', requireAuth, (q, s) => {
    const u = q.user, out = { rev: db.rev, me: pub(u), empty: db.requests.length === 0 };
    for (const c of COLS) out[c] = db[c].filter(x => visible(u, c, x));
    out.accounts = loadUsers().map(pub);
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

return { mount };
})();

// ---- server.js ----
const { booksFindContactExact, analyticsFindClientExact, toRecord, exact, col, accessToken, zohoReady } = M_zoho;
const { decide } = M_rules;
const { appendRecord } = M_sheets;
const gate = M_gate;
const auth = M_auth;
const store = M_store;

const E = process.env;
const app = express();
const origins = (E.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o) || origins.includes('*') || /\.onrender\.com$/.test(o)), credentials: true }));
app.use(express.json({ limit: '8mb' }));

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

const MOCK = E.ZOHO_MOCK === '1';
const mockRows = MOCK ? JSON.parse(fs.readFileSync(new URL('./scripts/mock-clients.json', import.meta.url))) : [];
const NOT_FOUND_MSG = 'Client name not found in Zoho Books or Zoho Analytics. Fund request cannot be created.';

async function findExact(name) {
  if (MOCK) {
    const C = col();
    const hit = exact(mockRows, name, r => r[C.client], r => r[C.company]);
    return { books: hit ? { contactId: 'MOCK-' + hit[C.id] } : null, rec: hit ? toRecord(hit) : null };
  }
  const [books, rec] = await Promise.all([booksFindContactExact(name), analyticsFindClientExact(name)]);
  return { books, rec };
}
const zohoErr = (s, e) => s.status(e.code === 'ENV' ? 500 : e.code === 'AUTH' ? 401 : e.code === 'RATE' ? 429 : 502)
  .json({ ok: false, reason: 'ZOHO_UNAVAILABLE', code: e.code, error: e.message });

async function notifySven(text, extra) {
  if (!E.SVEN_WEBHOOK_URL) return false;
  try { await fetch(E.SVEN_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...extra }) }); return true; }
  catch { return false; }
}

app.get('/api/health', async (_q, s) => s.json({ ok: true, mock: MOCK, zoho: MOCK ? 'mock' : await zohoReady, books: !!E.ZOHO_BOOKS_ORG_ID, analytics: !!E.ZOHO_VIEW_ID, time: new Date().toISOString() }));

app.get('/api/zoho/test', async (_q, s) => {
  if (MOCK) return s.json({ ok: true, mock: true });
  try { await accessToken(); s.json({ ok: true, oauth: 'refreshed' }); } catch (e) { zohoErr(s, e); }
});

// STEP 1 — exact client check. One attempt; a miss locks the session.
app.post('/api/zoho/validate-client', async (q, s) => {
  const lk = gate.locked(q.sid);
  if (lk) return s.status(423).json({ found: false, locked: true, reason: 'WORKFLOW_LOCKED', error: NOT_FOUND_MSG, lockedName: lk.name });
  const name = typeof q.body?.clientName === 'string' ? q.body.clientName : '';
  if (!name) return s.status(400).json({ found: false, reason: 'BAD_REQUEST', error: 'clientName required' });

  let found;
  try { found = await findExact(name); } catch (e) { return zohoErr(s, e); }
  const booksHit = !!(found.books && !found.books.skipped), analyticsHit = !!found.rec;

  if (!booksHit && !analyticsHit) {
    gate.lock(q.sid, name);
    await notifySven(`BLOCKED — fund request attempted for "${name}", not in Zoho Books or Zoho Analytics.`, { clientName: name });
    return s.status(422).json({ found: false, locked: true, reason: 'CLIENT_NOT_FOUND', error: NOT_FOUND_MSG });
  }
  const matchedIn = booksHit && analyticsHit ? 'Zoho Books + Analytics' : booksHit ? 'Zoho Books' : 'Zoho Analytics';
  const clientId = found.rec?.clientId || found.books?.contactId || null;
  s.json({ found: true, clientName: name, clientId, matchedIn, token: gate.issue(name, clientId, matchedIn) });
});

// Restart from the beginning — the only way to clear the lock.
app.post('/api/zoho/restart', (q, s) => { gate.unlock(q.sid); s.json({ ok: true }); });

// STEP 2+ — balance, relevance, approval, sheet. Requires the step-1 token.
app.post('/api/zoho/client-funding-check', async (q, s) => {
  const b = q.body || {};
  const req = {
    requestId: String(b.requestId || ''), clientName: typeof b.clientName === 'string' ? b.clientName : '',
    company: String(b.company || ''), purpose: String(b.purpose || ''), requestedAmount: Number(b.requestedAmount)
  };
  if (!req.clientName) return s.status(400).json({ ok: false, reason: 'BAD_REQUEST', error: 'clientName required' });
  if (!(req.requestedAmount > 0)) return s.status(400).json({ ok: false, reason: 'BAD_REQUEST', error: 'requestedAmount must be > 0' });

  // Token proves step 1 passed for this exact name. Legacy requests (created before the gate) re-validate exactly below.
  if (b.validationToken) {
    let v; try { v = gate.verify(b.validationToken, req.clientName); } catch (e) { return zohoErr(s, e); }
    if (!v.ok) return s.status(403).json({ ok: false, reason: 'INVALID_VALIDATION_TOKEN', why: v.why, error: NOT_FOUND_MSG });
  }

  let found;
  try { found = await findExact(req.clientName); } catch (e) { return zohoErr(s, e); }

  // Hard stop: no approval logic, no sheet row, nothing.
  if (!(found.books && !found.books.skipped) && !found.rec) {
    return s.status(422).json({ ok: false, clientMatched: false, reason: 'CLIENT_NOT_FOUND', approvalStatus: 'Not Approved', approvedAmount: 0, flagSven: true, error: NOT_FOUND_MSG, sheet: { written: false, why: 'client not validated' } });
  }

  const d = decide({ req, ...found });
  const validationId = 'ZV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const checkedAt = new Date().toISOString();

  let sheet;
  try {
    sheet = await appendRecord({
      clientName: req.clientName, companyName: d.companyName || req.company,
      requested: req.requestedAmount, approved: d.approvedAmount, status: d.approvalStatus,
      balance: d.available ?? '', notes: `${d.reason} · ${d.notes} · ${req.purpose} · ${req.requestId} · ${validationId} · ${checkedAt}`
    });
  } catch (e) { sheet = { written: false, why: e.message }; }

  const svenSummary = { clientName: req.clientName, requestedAmount: req.requestedAmount, approvedAmount: d.approvedAmount, approvalStatus: d.approvalStatus, flagReason: d.reason === 'VALIDATION_PASSED' ? '' : d.notes };
  const svenNotified = d.flagSven ? await notifySven(`OneLink funding check — ${svenSummary.clientName}: ${svenSummary.approvalStatus}. Requested ${svenSummary.requestedAmount}, approved ${svenSummary.approvedAmount}.${svenSummary.flagReason ? ' Flag: ' + svenSummary.flagReason : ''}`, { summary: svenSummary }) : false;

  s.json({
    ok: d.ok, reason: d.reason, approvalStatus: d.approvalStatus, approvedAmount: d.approvedAmount,
    clientMatched: d.clientMatched, booksMatched: d.booksMatched, analyticsMatched: d.analyticsMatched, relevancePassed: d.relevancePassed,
    clientId: d.clientId || d.booksContactId || null,
    availableBalance: d.available ?? 0, allocatedBalance: d.allocated ?? 0, usedBalance: d.used ?? 0,
    remainingAfterRequest: d.remaining ?? 0, requestedAmount: req.requestedAmount,
    notes: d.notes, flagSven: d.flagSven, svenNotified, svenSummary, sheet,
    source: MOCK ? 'Zoho Analytics · MOCK server' : 'Zoho Books + Zoho Analytics',
    validationId, checkedAt
  });
});

const __html = new URL('./index.html', import.meta.url);
app.get(['/', '/app'], (req, res) => { try { res.type('html').send(fs.readFileSync(__html)); } catch (e) { res.status(404).send('index.html missing'); } });
app.listen(E.PORT || 8787, () => console.log(`OneLink backend on :${E.PORT || 8787}${MOCK ? ' (MOCK)' : ''}`));
