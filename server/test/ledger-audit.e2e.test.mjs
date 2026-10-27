// End-to-end: the ledger audit endpoints (client account audit, chart of accounts review) against the Zoho stub.
// Run: node --test test/ledger-audit.e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, mkTmp, call, login, TEAM_PW, MASTER_PW, sleep } from './helpers.mjs';
import { auditFixture as fx, CFD, COGS, DOE, BANK } from './ledger-audit.fixture.mjs';

let srv, T = {};
const api = (who, p) => call(srv.base, T[who], 'GET', p);
const zohoLog = () => fs.readFileSync(path.join(srv.dir, 'zoho.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

before(async () => {
  srv = await startServer({ dir: mkTmp('ledger-audit'), fixture: fx() });
  for (const u of ['amina', 'maram', 'adnan']) T[u] = await login(srv.base, u, TEAM_PW);
  T.sven = await login(srv.base, 'sven', MASTER_PW);
});
after(async () => { if (srv) await srv.stop(); });

test('Operations are refused, and the attempt is in the security log', async () => {
  for (const u of ['amina', 'maram']) for (const p of ['/api/ledger-audit/clients', '/api/ledger-audit/accounts', `/api/ledger-audit/accounts/${DOE}/lines`]) {
    const r = await api(u, p);
    assert.equal(r.status, 403, u + ' ' + p);
    assert.equal(r.json.ok, false);
    assert.equal(JSON.stringify(r.json).includes('Gamma'), false);
  }
  const snap = (await call(srv.base, T.sven, 'GET', '/api/sync/snapshot')).json;
  assert.ok((snap.audit || []).some(a => a.action === 'ACCESS_DENIED' && /ledger audit/.test(a.detail)));
  assert.equal((await call(srv.base, null, 'GET', '/api/ledger-audit/clients')).status, 401);
});

test('client account audit: exceptions with the five report fields, liabilities traced to the account', async () => {
  const r = await api('sven', '/api/ledger-audit/clients');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = r.json.clients.find(c => c.id === '501');
  assert.equal(g.name, 'Gamma Trading LLC');
  assert.equal(g.status, 'CORRECTIONS');
  const cn = g.exceptions.find(e => e.code === 'CN_UNUSED');
  assert.equal(cn.severity, 'error');
  assert.match(cn.correction, /Apply AED 1,500\.00 of CN-00031: AED 1,000\.00 to INV-901/);
  for (const k of ['client', 'type', 'issue', 'rootCause', 'correction']) assert.ok(cn[k], k);
  assert.equal(g.liability.status, 'OPEN');
  assert.equal(g.liability.held, 7350);
  assert.ok(g.exceptions.some(e => e.code === 'LIABILITY_WITH_DUES'));
  const d = r.json.clients.find(c => c.id === '502');
  assert.ok(d.exceptions.some(e => e.code === 'PAYMENT_NO_SOURCE'));
  assert.ok(d.exceptions.some(e => e.code === 'PAYMENT_NO_INVOICE'));
  const none = r.json.clients.find(c => c.id === '');
  assert.ok(none.exceptions.some(e => e.code === 'LEDGER_UNTAGGED' && /JV-12/.test(e.issue)));
  assert.ok(r.json.summary.clients >= 2);
  assert.ok(r.json.atText);
});

test('the settlement trace names the transaction and the bank it was paid from', async () => {
  const r = await api('adnan', '/api/ledger-audit/clients');
  assert.equal(r.status, 200);
  const g = r.json.clients.find(c => c.id === '501');
  // The latest debit is the COGS medical test (07 Oct); its other side is not in the stub's counter rows.
  assert.equal(g.liability.settlement.reference, 'Medical test');
  assert.match(g.liability.settlementText, /not in the ledger/);
});

test('chart of accounts review: zero-balance breach traced, COGS reallocation, untagged CFD lines', async () => {
  const r = await api('adnan', '/api/ledger-audit/accounts');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const doe = r.json.accounts.find(x => x.id === DOE);
  assert.equal(doe.status, 'UNEXPECTED');
  assert.equal(doe.balanceText, 'AED 497.80 Cr');
  assert.match(doe.findings[0].detail, /Likely cause: Invoice INV-951 \(03 Oct 2026\) AED 497\.80 Cr/);
  assert.equal(doe.trace.open[0].client, 'Delta FZE');
  const cogs = r.json.accounts.find(x => x.id === COGS);
  assert.equal(cogs.status, 'UNEXPECTED');
  assert.equal(r.json.reallocation.entries[0].client, 'Gamma Trading LLC');
  assert.match(r.json.reallocation.entries[0].instruction, /Dr Customers Fund Disbursement Account AED 650\.00 \(customer: Gamma Trading LLC\) \/ Cr Cost of Goods Sold-Clients Payments AED 650\.00/);
  const cfd = r.json.accounts.find(x => x.id === CFD);
  assert.equal(cfd.status, 'EXPECTED');
  assert.equal(cfd.balanceText, 'AED 7,700.00 Cr');
  assert.ok(cfd.findings.some(f => f.code === 'MISSING_TAGS'));
  assert.equal(r.json.accounts.find(x => x.name === 'Suspense Clearing Account').status, 'EXPECTED');
  // only the zero-balance account that is not at zero had its lines read
  const lineJobs = zohoLog().filter(e => e.kind === 'auditLines');
  assert.equal(lineJobs.length, 1);
  assert.ok(lineJobs[0].query.CONFIG.includes(DOE) && !lineJobs[0].query.CONFIG.includes(BANK));
});

test('every export is a SELECT, cached for everyone; a refresh is honoured only after two minutes', async () => {
  const before = zohoLog().filter(e => e.kind && e.kind.startsWith('audit')).length;
  assert.equal((await api('sven', '/api/ledger-audit/clients')).status, 200);
  assert.equal((await api('adnan', '/api/ledger-audit/accounts?refresh=1')).status, 200);
  assert.equal(zohoLog().filter(e => e.kind && e.kind.startsWith('audit')).length, before, 'served from the cache');
  for (const e of zohoLog().filter(x => x.kind && x.kind.startsWith('audit') && x.query && x.query.CONFIG)) {
    const sql = JSON.parse(e.query.CONFIG).sqlQuery.trim();
    assert.match(sql, /^(SELECT|WITH)\s/i, sql.slice(0, 60));
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(sql), sql.slice(0, 80));
  }
  assert.ok(zohoLog().every(e => e.method === 'GET' || /oauth/.test(e.path)), 'the ledger audit never writes to Zoho');
});

test('one account’s lines, newest first; a bad id is refused', async () => {
  const r = await api('sven', `/api/ledger-audit/accounts/${DOE}/lines`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.total, 3);
  assert.deepEqual(r.json.lines.map(l => l.reference), ['INV-951', 'INV-950', 'Visa A']);
  assert.equal((await api('sven', '/api/ledger-audit/accounts/abc/lines')).status, 400);
});

test('opening an audit is in the security log, once per person', async () => {
  await sleep(300);
  const snap = (await call(srv.base, T.sven, 'GET', '/api/sync/snapshot')).json;
  const views = (snap.audit || []).filter(a => a.action === 'LEDGER_AUDIT_VIEWED');
  assert.ok(views.some(v => v.userId === 'sven' && /client account audit/.test(v.detail)));
  assert.ok(views.some(v => v.userId === 'adnan' && /chart of accounts/.test(v.detail)));
  assert.equal(views.filter(v => v.userId === 'sven' && /client account audit/.test(v.detail)).length, 1);
});
