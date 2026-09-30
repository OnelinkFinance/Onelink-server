import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { booksFindContactExact, analyticsFindClientExact, toRecord, exact, col, accessToken, zohoReady } from './lib/zoho.js';
import { decide } from './lib/rules.js';
import { appendRecord } from './lib/sheets.js';
import * as gate from './lib/gate.js';
import * as auth from './lib/auth.js';
import * as store from './lib/store.js';

const E = process.env;
const app = express();
const origins = (E.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o) || origins.includes('*')), credentials: true }));
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

app.listen(E.PORT || 8787, () => console.log(`OneLink backend on :${E.PORT || 8787}${MOCK ? ' (MOCK)' : ''}`));
