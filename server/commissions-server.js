// Free zone commission dashboard — its OWN web service, separate from the funding platform (server.js).
// Run with `npm run start:commissions`. It shares no process, port or deploy with the funding platform.
//
// READ-ONLY everywhere:
//   - sign-in is by email address only (no password): an allowed address opens a session that lives only
//     in this service's memory. Allowed = COMMISSIONS_ALLOWED_EMAILS (comma list of addresses and/or
//     @domains), default "@onelink.solutions".
//   - Zoho: Analytics SELECT exports and Books GETs only; the stored Zoho refresh token is read, never replaced.
//   - Google: through commissions.js (read-only scopes or the read-only Apps Script bridge).
//
// Env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN (or UPSTASH_REDIS_REST_URL + _TOKEN, where
// the funding platform stores it). Optional: COMMISSIONS_ALLOWED_EMAILS, ZOHO_DC, ZOHO_ORG_ID,
// ZOHO_WORKSPACE_ID, plus the Google settings listed in commissions.js.
import crypto from 'node:crypto';
import 'dotenv/config';
import express from 'express';
import { mountCommissions } from './commissions.js';

const E = process.env;
const dc = () => E.ZOHO_DC || 'com';
const BOOKS_ORG = '898300452';                               // ELITE ONELINK CORPORATE SERVICES L.L.C S.O.C
const zaOrg = () => E.ZOHO_ORG_ID || '926340534';
const zaWs = () => E.ZOHO_WORKSPACE_ID || '3241925000000011002';

// ---- Upstash, read only ----
async function kvGet(key) {
  if (!E.UPSTASH_REDIS_REST_URL || !E.UPSTASH_REDIS_REST_TOKEN) return null;
  const r = await fetch(`${E.UPSTASH_REDIS_REST_URL.replace(/\/$/, '')}/get/${encodeURIComponent(key)}`, { headers: { Authorization: 'Bearer ' + E.UPSTASH_REDIS_REST_TOKEN }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error('Upstash ' + r.status);
  return (await r.json()).result ?? null;
}

// ---- Zoho, read only ----
let token = null, tokenExp = 0, rt = E.ZOHO_REFRESH_TOKEN || null;
async function accessToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  if (!rt) { try { rt = await kvGet('onelink:zoho_rt'); } catch {} }
  const need = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'].filter(k => !E[k]);
  if (!rt) need.push('ZOHO_REFRESH_TOKEN (or UPSTASH_REDIS_REST_URL/TOKEN)');
  if (need.length) throw Object.assign(new Error('Missing env: ' + need.join(', ')), { code: 'ENV' });
  const q = new URLSearchParams({ refresh_token: rt, client_id: E.ZOHO_CLIENT_ID, client_secret: E.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' });
  const res = await fetch(`https://accounts.zoho.${dc()}/oauth/v2/token?${q}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }); // OAuth sign-in, not a data write
  const j = await res.json();
  if (!j.access_token) throw new Error('Zoho OAuth refresh failed: ' + (j.error || res.status));
  token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

async function books(p, params) {
  const t = await accessToken();
  const res = await fetch(`https://www.zohoapis.${dc()}/books/v3/${p}?${new URLSearchParams({ organization_id: BOOKS_ORG, ...params })}`, { headers: { Authorization: 'Zoho-oauthtoken ' + t }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Zoho Books ' + res.status);
  return res.json();
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
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

// Zoho Analytics SQL (SELECT) through an export job.
async function analyticsSql(sql) {
  const h = { headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken(), 'ZANALYTICS-ORGID': zaOrg() }, signal: AbortSignal.timeout(15_000) };
  const base = `https://analyticsapi.zoho.${dc()}/restapi/v2/bulk/workspaces/${zaWs()}`;
  const get = async (url, what) => { const r = await fetch(url, h); if (!r.ok) throw new Error(`Zoho Analytics ${what} ${r.status}`); return r; };
  const jobId = (await (await get(`${base}/data?CONFIG=${encodeURIComponent(JSON.stringify({ sqlQuery: sql, responseFormat: 'csv' }))}`, 'export')).json())?.data?.jobId;
  if (!jobId) throw new Error('Zoho Analytics returned no export job');
  for (let t0 = Date.now(), wait = 300; Date.now() - t0 < 30_000; wait = Math.min(wait * 1.4, 1500)) {
    await new Promise(r => setTimeout(r, wait));
    const code = String((await (await get(`${base}/exportjobs/${jobId}`, 'job')).json())?.data?.jobCode || '');
    if (code === '1003' || code === '1005') throw new Error('Zoho Analytics export job failed (' + code + ')');
    if (code === '1004') return parseCsv(await (await get(`${base}/exportjobs/${jobId}/data`, 'download')).text());
  }
  throw new Error('Zoho Analytics export did not finish within 30 s');
}

// ---- Sign-in by email address (no password) ----
const IDLE_MS = 8 * 60 * 60 * 1000;          // a working day
const sessions = new Map();                 // token -> { email, last }
const allowList = () => (E.COMMISSIONS_ALLOWED_EMAILS || '@onelink.solutions').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const allowed = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && allowList().some(a => a.startsWith('@') ? email.endsWith(a) : email === a);
const tokenOf = q => (/^Bearer\s+([A-Za-z0-9_-]{32,})$/.exec(q.headers.authorization || '') || [])[1]
  || (/(?:^|;\s*)ol_cdash=([A-Za-z0-9_-]{32,})/.exec(q.headers.cookie || '') || [])[1];
function requireAuth(q, s, next) {
  const t = tokenOf(q), sess = t && sessions.get(t);
  if (!sess || Date.now() - sess.last > IDLE_MS || !allowed(sess.email)) { if (t) sessions.delete(t); return s.status(401).json({ ok: false, reason: 'LOGIN_REQUIRED' }); }
  sess.last = Date.now(); q.user = { email: sess.email }; next();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.post('/api/auth/login', (q, s) => {
  const email = String(q.body?.email || q.body?.username || '').trim().toLowerCase();
  if (!allowed(email)) return s.status(403).json({ ok: false, error: 'This email address does not have access to the commission dashboard.' });
  const t = crypto.randomBytes(32).toString('base64url');
  sessions.set(t, { email, last: Date.now() });
  console.log('Commission dashboard: signed in', email);
  s.append('Set-Cookie', `ol_cdash=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${IDLE_MS / 1000}`);
  s.json({ ok: true, token: t, email });
});
app.post('/api/auth/logout', (q, s) => { const t = tokenOf(q); if (t) sessions.delete(t); s.append('Set-Cookie', 'ol_cdash=; Path=/; Max-Age=0'); s.json({ ok: true }); });
app.get('/', (_q, s) => s.redirect('/commissions'));
app.get('/health', (_q, s) => s.json({ ok: true, service: 'commission-dashboard', time: new Date().toISOString() }));
mountCommissions(app, { requireAuth, books, analytics: analyticsSql });
setInterval(() => { for (const [t, v] of sessions) if (Date.now() - v.last > IDLE_MS) sessions.delete(t); }, 60_000).unref();

app.listen(E.PORT || 8788, () => console.log(`Commission dashboard on :${E.PORT || 8788}`));
