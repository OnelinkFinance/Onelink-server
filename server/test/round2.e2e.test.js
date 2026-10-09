// Round 2, end to end (sandbox server + Zoho stub): connection verification, Analytics → Books routing, escalation
// routing / permissions / Rejected by Management / information requests / note redaction, brand, ledger refresh,
// Analytics retry and single logging.
// Run: node --test test/round2.e2e.test.js
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, mkTmp, call, login, findKeys, TEAM_PW, MASTER_PW, OPS_INSUFFICIENT, SECRET, sleep } from './helpers.mjs';
import { fixture, C } from './fixtures.mjs';
import { ledgerHash } from '../ledger-hash.js';

const PAID = 'Yes — in full';
const zlog = dir => { try { return fs.readFileSync(path.join(dir, 'zoho.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
function client(srv, T) {
  const api = (who, method, p, body) => call(srv.base, T[who], method, p, body);
  const snap = async who => (await api(who, 'GET', '/api/sync/snapshot')).json;
  const pick = async (who, c) => (await api(who, 'POST', '/api/zoho/validate-client', { contactId: c.id })).json;
  const precheck = async (who, c, amount = 5000) => { const v = await pick(who, c); return { v, ...(await api(who, 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount, paid: PAID })) }; };
  return { api, snap, pick, precheck };
}
async function signIn(srv, T, users = ['maram', 'anastasiya', 'amina', 'adnan', 'ahmed', 'eduard']) {
  for (const u of users) T[u] = await login(srv.base, u, TEAM_PW);
  T.sven = await login(srv.base, 'sven', MASTER_PW);
}

// ---------------------------------------------------------------------------------------------------------------
describe('routing: Zoho Analytics first, Zoho Books cross-verification second', () => {
  let srv, dir, T = {}, A;
  before(async () => { dir = mkTmp('r2-route'); srv = await startServer({ dir, fixture: fixture() }); await signIn(srv, T); A = client(srv, T); });
  after(async () => { if (srv) await srv.stop(); });

  test('Analytics covers the request → route ANALYTICS, three checks, connections, no Books cross-check calls', async () => {
    const p = await A.precheck('maram', C.alpha);
    assert.equal(p.status, 200, JSON.stringify(p.json));
    const f = p.json.finance;
    assert.equal(f.route, 'ANALYTICS');
    assert.deepEqual(f.checks.map(c => c.key), ['CFD', 'COGS', 'INVOICES']);
    assert.equal(f.connections.analytics, true);
    assert.equal(f.connections.books, true);
    assert.match(f.connections.atText, /\d\d [A-Z][a-z]{2} · \d\d:\d\d/);
    assert.deepEqual(Object.keys(f.primary).sort(), ['code', 'ok', 'text']);
    assert.equal(f.primary.ok, true);
    const kinds = zlog(dir).map(e => e.kind);
    assert.ok(kinds.includes('workspace') && kinds.includes('booksProbe'), 'both connections probed');
    for (const k of ['transactions', 'creditnotes', 'booksInvoices', 'customerpayments', 'journals']) assert.ok(!kinds.includes(k), k + ' must not be called on the Analytics route');
  });

  test('an unsynced Books credit covers the request → BOOKS_CROSSCHECK, five checks pass; Operations see no figures', async () => {
    const p = await A.precheck('maram', C.bk1);
    assert.equal(p.status, 200, JSON.stringify(p.json));
    const f = p.json.finance;
    assert.equal(f.route, 'BOOKS_CROSSCHECK');
    assert.deepEqual(f.checks.map(c => c.key), ['CFD', 'COGS', 'NOTES', 'JOURNALS', 'INVOICES']);
    assert.ok(f.checks.every(c => c.ok), JSON.stringify(f.checks.filter(c => !c.ok)));
    assert.deepEqual(f.primary, { ok: false, code: 'CFD_INSUFFICIENT', text: 'Client does not have sufficient balance to request funds.' });
    assert.deepEqual(findKeys(p.json, 'detail'), []);
    assert.doesNotMatch(JSON.stringify(p.json), /AED|INV-00801|DEP-4001/);
    // the request carries the cross-check; Sven sees the figures
    const put = await A.api('maram', 'POST', '/api/sync/put', { col: 'requests', item: { id: 'FR-9701', by: 'maram', company: C.bk1.name + ' FZCO', person: C.bk1.name, zohoClient: C.bk1.name, zohoClientId: C.bk1.id,
      purpose: 'Visa', zone: 'IFZA', requested: 5000, approved: null, credited: 0, status: 'NEW', date: '9 Oct', paid: PAID, notes: '', docs: [], timeline: [], zohoSubmitToken: p.json.submitToken } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const sv = (await A.snap('sven')).requests.find(r => r.id === put.json.id);
    assert.equal(sv.finance.route, 'BOOKS_CROSSCHECK');
    assert.equal(sv.finance.checks.length, 5);
    assert.match(sv.finance.primary.detail, /AED 3,000/);
    assert.match(sv.finance.checks[0].items[0].detail, /unsynced Books movement AED 2,500\.00/);
    const mine = (await A.snap('maram')).requests.find(r => r.id === put.json.id);
    assert.deepEqual(findKeys(mine.finance, 'detail'), []);
    assert.doesNotMatch(JSON.stringify(mine.finance), /AED/);
    const amina = (await A.snap('amina')).requests.find(r => r.id === put.json.id);
    assert.doesNotMatch(JSON.stringify(amina.finance), /AED|"detail"/);
  });

  test('each failing cross-check scenario fails the right check with the right Operations headline', async () => {
    const cases = [
      [C.bk2, ['JOURNALS'], false], [C.bk3, ['NOTES'], false], [C.bk4, ['CFD', 'COGS', 'JOURNALS'], true],
      [C.bk6, ['CFD'], true], [C.bk7, ['CFD', 'INVOICES'], false], [C.bk8, ['INVOICES'], false]
    ];
    for (const [c, keys, insufficient] of cases) {
      const p = await A.precheck('sven', c);
      assert.equal(p.status, 422, c.name + ' ' + JSON.stringify(p.json).slice(0, 300));
      assert.equal(p.json.finance.route, 'BOOKS_CROSSCHECK', c.name);
      assert.deepEqual(p.json.failed.map(f => f.key), keys, c.name);
      assert.equal(p.json.escalate.allowed, true);
      const o = await A.precheck('anastasiya', c);
      assert.equal(o.status, 422);
      if (insufficient) assert.equal(o.json.error, OPS_INSUFFICIENT, c.name);
      else { assert.notEqual(o.json.error, OPS_INSUFFICIENT, c.name); assert.match(o.json.error, /check(s)? failed\. You can escalate it to management\./); }
      assert.doesNotMatch(JSON.stringify(o.json), /AED/, c.name);
    }
    assert.equal((await A.precheck('sven', C.bk8)).json.finance.checks.find(x => x.key === 'INVOICES').code, 'PAYMENT_REVERSED');
    assert.equal((await A.precheck('sven', C.bk5)).status, 200, 'an open credit note covers it');
  });

  test('Books calls stay within budget: shared sources are cached for 60 s', async () => {
    const log = zlog(dir);
    const tx = log.filter(e => e.kind === 'transactions');
    assert.equal(tx.length, 2, 'CFD and COGS transactions read once for all the checks above: ' + tx.length);
    assert.equal(log.filter(e => e.kind === 'journals').length, 1);
    assert.equal(log.filter(e => e.kind === 'journal').length, 1, 'the one draft journal opened once');
    assert.equal(log.filter(e => e.kind === 'creditnotes' && e.query.customer_id === C.bk2.id).length, 1, 'bk2 was checked twice, its lists read once');
  });

  test('client-funding-check: Sven\'s check of a client Books covers passes on the Books route', async () => {
    const v = await A.pick('sven', C.bk5);
    const r = await A.api('sven', 'POST', '/api/zoho/client-funding-check', { validationToken: v.token, clientName: v.clientName, company: C.bk5.name + ' FZCO', purpose: 'Visa', requestedAmount: 5000, paid: PAID });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 400));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.reason, 'VALIDATION_PASSED');
    assert.equal(r.json.route, 'BOOKS_CROSSCHECK');
    assert.equal(r.json.booksAvailable, 5500);
    const v2 = await A.pick('sven', C.bk2);
    const f = await A.api('sven', 'POST', '/api/zoho/client-funding-check', { validationToken: v2.token, clientName: v2.clientName, company: C.bk2.name + ' FZCO', purpose: 'Visa', requestedAmount: 5000, paid: PAID });
    assert.equal(f.json.reason, 'FINANCIAL_CHECKS_FAILED');
    assert.match(f.json.notes, /Journals/);
  });

  test('/api/health reports the last connection verification without error text', async () => {
    const h = await call(srv.base, null, 'GET', '/api/health');
    assert.equal(h.json.connections.ok, true);
    assert.deepEqual(Object.keys(h.json.connections.books).sort(), ['ms', 'ok']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('fail closed: a Books failure during the cross-check never lets a request pass', () => {
  test('rate-limited account transactions and failing journals → checks fail, never pass, no 5xx', async () => {
    const fx = fixture(); fx.fail = { transactions: 429, journal: 500 };
    const srv = await startServer({ dir: mkTmp('r2-booksfail'), fixture: fx });
    try {
      const T = {}; await signIn(srv, T, ['maram']); const A = client(srv, T);
      const p = await A.precheck('maram', C.bk1);
      assert.equal(p.status, 422, JSON.stringify(p.json).slice(0, 300));
      assert.deepEqual(p.json.failed.map(f => f.key), ['CFD', 'COGS', 'JOURNALS']);
      for (const c of p.json.finance.checks.filter(x => !x.ok)) assert.equal(c.message, 'Zoho Books cross-verification could not be completed.');
      assert.notEqual(p.json.error, OPS_INSUFFICIENT);
      // the Analytics route does not need Books lists at all
      assert.equal((await A.precheck('maram', C.bravo)).status, 200);
    } finally { await srv.stop(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('connection verification', () => {
  test('either connection failing blocks precheck and funding check (503), notifies Sven once, recovers, caches success', async () => {
    const dir = mkTmp('r2-conn'), fx = fixture(); fx.fail = { booksProbe: 503 };
    const srv = await startServer({ dir, fixture: fx });
    const write = f => fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(f));
    try {
      const T = {}; await signIn(srv, T, ['maram']); const A = client(srv, T);
      const p = await A.precheck('maram', C.alpha);
      assert.equal(p.status, 503);
      assert.equal(p.json.reason, 'ZOHO_CONNECTION_FAILED');
      assert.equal(p.json.error, 'Zoho Analytics and Zoho Books could not both be verified — the request is blocked and Sven has been notified.');
      assert.equal(p.json.connections.analytics.ok, true);
      assert.equal(p.json.connections.books.ok, false);
      assert.deepEqual(findKeys(p.json, 'error').filter(k => k !== '$.error'), [], 'Operations get no error text');
      assert.ok(!('escalate' in p.json));
      const s = await A.precheck('sven', C.alpha);
      assert.equal(s.status, 503);
      assert.match(s.json.connections.books.error, /Zoho Books/, 'Sven sees why');
      const fc = await A.api('sven', 'POST', '/api/zoho/client-funding-check', { validationToken: s.v.token, clientName: s.v.clientName, company: 'x', purpose: 'y', requestedAmount: 5000, paid: PAID });
      assert.equal(fc.status, 503);
      assert.equal(fc.json.reason, 'ZOHO_CONNECTION_FAILED');
      // now Analytics fails too: still blocked, no second notification within 30 minutes
      write({ ...fx, fail: { workspace: 500 } });
      assert.equal((await A.precheck('maram', C.alpha)).status, 503);
      const notes = (await A.snap('sven')).notifications.filter(n => /^Zoho connection check failed/.test(n.text));
      assert.equal(notes.length, 1, 'one notification per 30 minutes');
      assert.equal(notes[0].text, 'Zoho connection check failed (Analytics: OK, Books: FAILED) — funding checks are blocked until it recovers.');
      assert.equal((await call(srv.base, null, 'GET', '/api/health')).json.connections.ok, false);
      // a failure is never cached: the next check passes as soon as both answer
      write(fixture());
      const ok = await A.precheck('maram', C.alpha);
      assert.equal(ok.status, 200, JSON.stringify(ok.json).slice(0, 300));
      assert.equal(ok.json.finance.connections.books, true);
      // a success is cached for 60 s
      write({ ...fixture(), fail: { workspace: 500, booksProbe: 500 } });
      const cached = await A.precheck('sven', C.bravo);
      assert.equal(cached.status, 200);
      assert.equal(zlog(dir).filter(e => e.kind === 'workspace' && e.status === 500).length, 1, 'no new probe while the success is fresh');
    } finally { await srv.stop(); }
  });
  test('an OAuth failure fails both connections (and nothing is decided)', async () => {
    const fx = fixture(); fx.fail = { oauth: 1 };
    const srv = await startServer({ dir: mkTmp('r2-oauth'), fixture: fx });
    try {
      const sv = await login(srv.base, 'sven', MASTER_PW);
      // a pick token as the server issues it (validate-client itself needs Zoho, which is down)
      const b64 = x => Buffer.from(x).toString('base64url');
      const body = b64(JSON.stringify({ n: C.alpha.name, id: C.alpha.id, m: 'Zoho Books', exp: Date.now() + 60_000 }));
      const token = body + '.' + b64(crypto.createHmac('sha256', SECRET).update(body).digest());
      const r = await call(srv.base, sv, 'POST', '/api/zoho/precheck', { validationToken: token, clientName: C.alpha.name, amount: 5000, paid: PAID });
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.equal(r.json.reason, 'ZOHO_CONNECTION_FAILED');
      assert.equal(r.json.connections.analytics.ok, false);
      assert.equal(r.json.connections.books.ok, false);
      const n = (await call(srv.base, sv, 'GET', '/api/sync/snapshot')).json.notifications.filter(x => /^Zoho connection check failed/.test(x.text));
      assert.deepEqual(n.map(x => x.text), ['Zoho connection check failed (Analytics: FAILED, Books: FAILED) — funding checks are blocked until it recovers.']);
    } finally { await srv.stop(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('management escalation (round 2)', () => {
  let srv, T = {}, A;
  before(async () => { srv = await startServer({ dir: mkTmp('r2-esc'), fixture: fixture() }); await signIn(srv, T); A = client(srv, T); });
  after(async () => { if (srv) await srv.stop(); });
  const req = c => ({ company: c.name + ' FZCO', person: c.name, purpose: 'Visa renewal', zone: 'IFZA', requested: 5000, paid: PAID, date: '9 Oct', notes: 'urgent', docs: [] });
  async function escalate(who, c, to, justification = 'Client paid by bank transfer this morning.') {
    const p = await A.precheck(who, c);
    assert.equal(p.status, 422, 'expected failing precheck for ' + c.name);
    return A.api(who, 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: p.v.clientName, justification, request: req(c), ...(to === undefined ? {} : { to }) });
  }
  const decide = (who, id, action, note) => A.api(who, 'POST', `/api/requests/${id}/escalation`, { action, note });
  const notesFor = async (who, id) => (await A.snap(who)).notifications.filter(n => n.req === id && n.to === who);

  test('recipients: validation, ALL by default, only the chosen managers are notified and may decide', async () => {
    assert.equal((await escalate('maram', C.kilo, ['nobody'])).status, 422);
    assert.equal((await escalate('maram', C.kilo, [])).status, 422);
    assert.equal((await escalate('maram', C.kilo, 'adnan')).status, 422);
    assert.equal((await escalate('adnan', C.kilo, ['adnan'])).status, 422, 'a manager cannot send it only to himself');
    const all = await escalate('maram', C.lima);
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.item.escalation.routing, 'ALL');
    assert.deepEqual(all.json.item.escalation.to.map(t => t.key), ['adnan', 'ahmed', 'eduard']);

    const e = await escalate('maram', C.kilo, ['adnan', 'eduard']);
    assert.equal(e.status, 200, JSON.stringify(e.json));
    const id = e.json.id;
    assert.equal(e.json.item.escalation.routing, 'SELECTED');
    assert.deepEqual(e.json.item.escalation.to, [{ key: 'adnan', name: 'Adnan', title: 'CFO' }, { key: 'eduard', name: 'Eduard', title: 'Chief Legal Officer' }]);
    assert.equal((await notesFor('adnan', id)).length, 1);
    assert.equal((await notesFor('eduard', id)).length, 1);
    assert.equal((await notesFor('ahmed', id)).length, 0, 'not a recipient');
    assert.ok((await notesFor('sven', id)).length >= 1);
    const no = await decide('ahmed', id, 'APPROVE', 'I approve this');
    assert.equal(no.status, 403);
    assert.equal(no.json.error, 'This escalation was sent to Mr. Adnan (CFO) and Mr. Eduard (Chief Legal Officer).');
    // management still sees every escalated request
    assert.ok((await A.snap('ahmed')).requests.some(r => r.id === id));
  });

  let RID;
  test('INFO keeps Awaiting Management Decision; the requester sees the question and replies; decisions stay possible', async () => {
    const e = await escalate('maram', C.mike, ['adnan', 'ahmed']);
    assert.equal(e.status, 200);
    RID = e.json.id;
    const info = await decide('adnan', RID, 'INFO', 'Which bank account did the client pay from?');
    assert.equal(info.status, 200);
    assert.equal(info.json.item.status, 'ESCALATED');
    assert.deepEqual([info.json.item.escalation.infoRequest.by, info.json.item.escalation.infoRequest.title], ['adnan', 'CFO']);
    const mine = (await A.snap('maram')).requests.find(r => r.id === RID);
    assert.equal(mine.escalation.infoRequest.note, 'Which bank account did the client pay from?');
    assert.ok((await notesFor('maram', RID)).some(n => /Which bank account/.test(n.text)));
    assert.equal((await A.api('sven', 'POST', `/api/requests/${RID}/escalation/reply`, { note: 'for her' })).status, 403);
    const rep = await A.api('maram', 'POST', `/api/requests/${RID}/escalation/reply`, { note: 'Emirates NBD, statement uploaded' });
    assert.equal(rep.status, 200);
    assert.equal(rep.json.item.escalation.infoRequest, undefined);
    assert.ok((await notesFor('ahmed', RID)).some(n => /Emirates NBD/.test(n.text)), 'recipients hear the answer');
    assert.ok((await notesFor('sven', RID)).some(n => /Emirates NBD/.test(n.text)));
    // a second question, then a decision while it is open
    assert.equal((await decide('ahmed', RID, 'INFO', 'And the transfer date?')).status, 200);
  });

  const SECRET_NOTE = 'Board minute 7731: client is a credit risk';
  test('REJECT → Rejected by Management: unlocks the client, locks the request, and the note never reaches Operations', async () => {
    const rej = await decide('adnan', RID, 'REJECT', SECRET_NOTE);
    assert.equal(rej.status, 200, JSON.stringify(rej.json));
    assert.equal(rej.json.item.status, 'MGMT_REJECTED');
    assert.equal(rej.json.item.approved, 0);
    assert.equal(rej.json.item.escalation.infoRequest, undefined);
    assert.equal(rej.json.item.escalation.decision.note, SECRET_NOTE, 'management sees the note');
    assert.equal((await decide('ahmed', RID, 'APPROVE', 'too late now')).status, 409);
    // Operations: requester and Master Operations Control
    for (const who of ['maram', 'amina']) {
      const s = await A.snap(who);
      assert.doesNotMatch(JSON.stringify(s), /Board minute 7731/, who + ' received the management note');
      const r = s.requests.find(x => x.id === RID);
      assert.equal(r.status, 'MGMT_REJECTED');
      assert.equal(r.escalation.decision.action, 'REJECT');
      assert.ok(!('note' in r.escalation.decision));
      for (const l of r.escalation.log) if (l.who !== who) assert.ok(!('note' in l), who + ' sees ' + l.action + ' note');
      assert.ok(r.timeline.some(t => t.text === 'Mr. Adnan (CFO) rejected the escalation'));
    }
    const m = (await A.snap('maram')).requests.find(x => x.id === RID);
    assert.equal(m.escalation.log.find(l => l.action === 'REPLY').note, 'Emirates NBD, statement uploaded', 'her own note stays');
    assert.ok((await notesFor('maram', RID)).some(n => /rejected the escalation\. The client is free/.test(n.text)));
    assert.ok((await A.snap('maram')).audit.some(a => a.req === RID && a.action === 'ESCALATION_REJECTED'), 'she sees the audit row (without the note)');
    // Sven and the other recipient get the note
    assert.ok((await notesFor('sven', RID)).some(n => n.text.includes(SECRET_NOTE)));
    assert.ok((await notesFor('ahmed', RID)).some(n => n.text.includes(SECRET_NOTE)));
    assert.ok((await A.snap('sven')).audit.some(a => a.req === RID && a.action === 'ESCALATION_REJECTED' && a.detail.includes(SECRET_NOTE)));
    // locked: no status change through the browser path, by anyone
    const sv = (await A.snap('sven')).requests.find(x => x.id === RID);
    assert.equal((await A.api('sven', 'POST', '/api/sync/put', { col: 'requests', item: { ...sv, status: 'APPROVED', approved: 5000 } })).status, 403);
    assert.equal((await A.api('maram', 'POST', '/api/sync/put', { col: 'requests', item: { ...m, status: 'NEW' } })).status, 403);
    // the client is free again
    const again = await A.precheck('maram', C.mike);
    assert.notEqual(again.status, 409);
  });

  test('APPROVE → MGMT_APPROVED; the approval note stays with management; Sven gives the final approval', async () => {
    const e = await escalate('maram', C.november, ['eduard']);
    const ap = await decide('eduard', e.json.id, 'APPROVE', 'Approved per legal review LR-55');
    assert.equal(ap.status, 200);
    assert.equal(ap.json.item.status, 'MGMT_APPROVED');
    const s = await A.snap('maram');
    assert.doesNotMatch(JSON.stringify(s), /LR-55/);
    assert.ok((await notesFor('sven', e.json.id)).some(n => /final approval is needed/.test(n.text) && /LR-55/.test(n.text)));
    const sv = (await A.snap('sven')).requests.find(x => x.id === e.json.id);
    assert.equal((await A.api('sven', 'POST', '/api/sync/put', { col: 'requests', item: { ...sv, status: 'APPROVED', approved: 5000 } })).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('brand', () => {
  test('page head carries the OneLink title, icons and theme colour; brand files are served with a day of cache', async () => {
    const srv = await startServer({ dir: mkTmp('r2-brand'), fixture: fixture() });
    try {
      const html = await (await fetch(srv.base + '/')).text();
      const head = html.slice(0, html.indexOf('</head>'));
      assert.match(head, /<title>OneLink Funds<\/title>/);
      assert.doesNotMatch(head, /Bundled Page/);
      assert.match(head, /<link rel="icon" type="image\/png" sizes="32x32" href="\/brand\/icon-32\.png">/);
      assert.match(head, /<link rel="icon" href="\/favicon\.ico" sizes="any">/);
      assert.match(head, /<link rel="apple-touch-icon" href="\/brand\/apple-touch-icon\.png">/);
      assert.match(head, /<meta name="theme-color" content="#1f6bff">/);
      assert.equal((head.match(/OneLink Funds/g) || []).length, 1);
      const fav = await fetch(srv.base + '/favicon.ico');
      assert.equal(fav.status, 200);
      for (const f of ['logo.png', 'icon-32.png', 'icon-192.png', 'apple-touch-icon.png']) {
        const r = await fetch(srv.base + '/brand/' + f);
        assert.equal(r.status, 200, f);
        assert.match(r.headers.get('cache-control'), /max-age=86400/, f);
      }
      assert.equal((await fetch(srv.base + '/brand/nope.png')).status, 404);
      assert.equal((await fetch(srv.base + '/brand/../server.js')).status, 404);
    } finally { await srv.stop(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('history ledger refresh on boot, and legacy escalations', () => {
  test('untouched history requests take the new ledger version; edited ones stay; legacy MGMT_INFO still works and hides notes', async () => {
    const dir = mkTmp('r2-ledger');
    const H = (id, extra = {}) => ({ id, by: 'maram', company: 'Co ' + id, person: 'P ' + id, purpose: 'Visa', zone: 'IFZA', requested: 1000, approved: null, credited: 0, status: 'NEW', date: '1 Oct', docs: [], notes: '', paid: 'Yes', timeline: [{ at: '1 Oct · 10:00', text: 'Maram requested AED 1,000' }], ...extra });
    const old = { 'FR-901': H('FR-901'), 'FR-902': H('FR-902'), 'FR-903': H('FR-903'), 'FR-904': H('FR-904'), 'FR-905': H('FR-905'), 'FR-906': H('FR-906', { status: 'APPROVED', approved: 1000 }) };
    const next = id => ({ ...old[id], status: 'APPROVED', approved: 1000, timeline: old[id].timeline.concat([{ at: '5 Oct · 09:00', text: 'Sven approved AED 1,000' }]) });
    const ledger = { requests: ['FR-901', 'FR-902', 'FR-903', 'FR-904', 'FR-905', 'FR-906'].map(next).concat([H('FR-907')]), chat: [], notifications: [], audit: [],
      previous: Object.fromEntries(['FR-901', 'FR-902', 'FR-903', 'FR-904', 'FR-905', 'FR-906', 'FR-999'].map(id => [id, ledgerHash(old[id] || H(id))])) };
    // FR-906 is already the new version
    ledger.requests[5] = { ...old['FR-906'], timeline: old['FR-906'].timeline };
    ledger.previous['FR-906'] = ledgerHash({ ...old['FR-906'], status: 'NEW', approved: null });
    const legacy = {
      id: 'FR-950', by: 'maram', company: 'Kilo Low Balance FZCO', person: C.kilo.name, zohoClient: C.kilo.name, zohoClientId: C.kilo.id, purpose: 'Visa', zone: 'IFZA', requested: 5000, approved: null, credited: 0,
      status: 'MGMT_INFO', date: '7 Oct', docs: [], notes: 'Escalation rejected by Mr. Ahmed (General Manager) — legacy secret LS-4', paid: PAID, createdAt: '2026-10-07T10:00:00.000Z', requestorId: 'maram', clientId: C.kilo.id, flagged: true,
      timeline: [{ at: '7 Oct · 10:00', text: 'Mr. Ahmed (General Manager) rejected the escalation — legacy secret LS-1', srv: true }],
      escalation: { id: 'ESC-ABC123', at: '2026-10-07T10:00:00.000Z', atText: '07 Oct · 14:00', by: 'maram', byName: 'Maram', justification: 'Client paid in cash today.', failed: [{ key: 'CFD', label: 'Customer Fund Disbursement account', message: 'x' }],
        to: [{ key: 'adnan', name: 'Adnan', title: 'CFO' }, { key: 'ahmed', name: 'Ahmed', title: 'General Manager' }, { key: 'eduard', name: 'Eduard', title: 'Chief Legal Officer' }],
        decision: { action: 'INFO', by: 'adnan', byName: 'Adnan', title: 'CFO', at: '2026-10-07T11:00:00.000Z', atText: '07 Oct · 15:00', note: 'Send proof LS-2' },
        log: [{ at: '2026-10-07T10:00:00.000Z', atText: '07 Oct · 14:00', who: 'maram', whoName: 'Maram', action: 'CREATED', note: 'Client paid in cash today.' }, { at: '2026-10-07T11:00:00.000Z', atText: '07 Oct · 15:00', who: 'adnan', whoName: 'Adnan', action: 'INFO', note: 'Send proof LS-2' }] }
    };
    const platform = { rev: 5, purged: ['FR-904'], requests: [
      old['FR-901'], { ...old['FR-902'], notes: 'edited on the platform' }, { ...old['FR-903'], createdAt: '2026-10-01T00:00:00.000Z' }, { ...old['FR-905'], financeLatest: { id: 'FV-1' } }, ledger.requests[5], legacy
    ], chat: [], notifications: [{ id: 'n-legacy', to: 'maram', text: 'FR-950 · Kilo: Mr. Ahmed (General Manager) rejected the escalation — legacy secret LS-3', at: '07 Oct · 16:00', read: false, req: 'FR-950' }], audit: [] };
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger));
    fs.writeFileSync(path.join(dir, 'platform.json'), JSON.stringify(platform));
    const srv = await startServer({ dir, fixture: fixture(), env: { LEDGER_FILE: path.join(dir, 'ledger.json') } });
    try {
      assert.match(srv.out(), /Ledger: updated 1 history requests \(2 left as edited on the platform\)\./);
      const T = {}; await signIn(srv, T, ['maram', 'amina', 'adnan']); const A = client(srv, T);
      const rs = (await A.snap('sven')).requests, by = id => rs.find(r => r.id === id);
      assert.equal(by('FR-901').status, 'APPROVED', 'untouched → new ledger version');
      assert.equal(by('FR-901').timeline.length, 2);
      assert.equal(by('FR-902').status, 'NEW', 'edited on the platform → kept');
      assert.equal(by('FR-902').notes, 'edited on the platform');
      assert.equal(by('FR-903').status, 'NEW', 'a live request is never replaced');
      assert.equal(by('FR-904'), undefined, 'purged stays purged');
      assert.equal(by('FR-905').status, 'NEW', 'a record carrying platform fields counts as edited');
      assert.ok(by('FR-907'), 'new ledger requests are still added');
      await srv.stop();
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'platform.json'), 'utf8'));
      assert.equal(saved.requests.find(r => r.id === 'FR-901').status, 'APPROVED', 'persisted');
      // legacy notes hidden from Operations
      const srv2 = await startServer({ dir, env: { LEDGER_FILE: path.join(dir, 'ledger.json') } });
      try {
        assert.match(srv2.out(), /Ledger: updated 0 history requests/);
        const T2 = {}; await signIn(srv2, T2, ['maram', 'amina', 'adnan']); const B = client(srv2, T2);
        for (const who of ['maram', 'amina']) {
          const s = JSON.stringify(await B.snap(who));
          assert.doesNotMatch(s, /LS-1|LS-3|LS-4/, who + ': legacy rejection notes');
          const r = (await B.snap(who)).requests.find(x => x.id === 'FR-950');
          assert.equal(r.escalation.decision.note, 'Send proof LS-2', who + ': the legacy question stays visible');
          assert.ok(!('note' in r.escalation.log.find(l => l.action === 'INFO')), who + ': log notes of others are hidden');
        }
        assert.match(JSON.stringify(await B.snap('sven')), /LS-1/);
        // her browser saves the request back as she received it: no duplicated history line, the stored note survives
        const before = (await B.snap('sven')).requests.find(x => x.id === 'FR-950');
        const hers = (await B.snap('maram')).requests.find(x => x.id === 'FR-950');
        assert.equal((await B.api('maram', 'POST', '/api/sync/put', { col: 'requests', item: hers })).status, 200);
        const after = (await B.snap('sven')).requests.find(x => x.id === 'FR-950');
        assert.equal(after.timeline.length, before.timeline.length, JSON.stringify(after.timeline));
        assert.equal(after.notes, before.notes);
        // legacy MGMT_INFO: the requester can still answer; management can still decide
        const rep = await B.api('maram', 'POST', '/api/requests/FR-950/escalation/reply', { note: 'Receipt uploaded today' });
        assert.equal(rep.status, 200, JSON.stringify(rep.json));
        assert.equal(rep.json.item.status, 'ESCALATED');
        assert.equal(rep.json.item.escalation.decision, null);
        const ap = await B.api('adnan', 'POST', '/api/requests/FR-950/escalation', { action: 'APPROVE', note: 'Fine by me' });
        assert.equal(ap.status, 200);
        assert.equal(ap.json.item.status, 'MGMT_APPROVED');
      } finally { await srv2.stop(); }
    } finally { await srv.stop(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Zoho Analytics resilience', () => {
  test('a 5xx on an export is retried once and the refresh succeeds', async () => {
    const dir = mkTmp('r2-flaky'), fx = fixture(); fx.flaky = { split: 1, workspace: 0 };
    const srv = await startServer({ dir, fixture: fx });
    try {
      const T = {}; T.sven = await login(srv.base, 'sven', MASTER_PW); const A = client(srv, T);
      const p = await A.precheck('sven', C.alpha);
      assert.equal(p.status, 200, JSON.stringify(p.json).slice(0, 300));
      const split = zlog(dir).filter(e => e.kind === 'split' && e.path.endsWith('/data'));
      assert.equal(split[0].status, 503);
      assert.equal(split[1].status, 200);
      assert.match(srv.out(), /retrying once/);
      assert.doesNotMatch(srv.out(), /finance refresh failed/);
    } finally { await srv.stop(); }
  });
  test('a failed refresh is logged once, not once per waiting caller', async () => {
    const dir = mkTmp('r2-logonce'), fx = fixture(); fx.fail = { split: 503 }; fx.delay = { split: 250 };
    const srv = await startServer({ dir, fixture: fx });
    try {
      const t = await login(srv.base, 'maram', TEAM_PW);
      await Promise.all(['alp', 'bra', 'cha', 'del', 'ech', 'fox'].map(q => call(srv.base, t, 'GET', '/api/zoho/clients?q=' + q)));
      await sleep(2500); // the boot pre-load (1.5 s) has run too
      const fails = (srv.out().match(/Zoho Analytics finance refresh failed/g) || []).length;
      const attempts = zlog(dir).filter(e => e.kind === 'split' && e.path.endsWith('/data')).length;
      assert.ok(fails >= 1 && fails <= 2, 'six concurrent pre-loads share one refresh: ' + fails + ' failure lines');
      assert.equal(attempts, fails * 2, 'every refresh tried the export twice (one retry)');
      assert.doesNotMatch(srv.out(), /pre-load failed/);
    } finally { await srv.stop(); }
  });
});
