// Regression tests for the findings of the adversarial review (each test names the defect it guards).
// Run: node --test test/review.e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, mkTmp, call, login, TEAM_PW, MASTER_PW } from './helpers.mjs';
import { fixture, C } from './fixtures.mjs';

const PAID = 'Yes — in full';
let srv, T = {};
const api = (who, method, p, body) => call(srv.base, T[who], method, p, body);
const snap = async who => (await api(who, 'GET', '/api/sync/snapshot')).json;
const reqOf = async (who, id) => (await snap(who)).requests.find(r => r.id === id);
const pick = async (who, client) => (await api(who, 'POST', '/api/zoho/validate-client', { contactId: client.id })).json;
async function precheck(who, client, amount = 5000) {
  const v = await pick(who, client);
  return { v, ...(await api(who, 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount, paid: PAID })) };
}
const item = (by, id, client, token, extra = {}) => ({ id, by, company: client.name + ' FZCO', person: client.name, zohoClient: client.name, zohoClientId: client.id,
  purpose: 'Visa renewal', zone: 'IFZA', requested: 5000, approved: null, credited: 0, status: 'NEW', date: '8 Oct', paid: PAID, notes: '', docs: [],
  timeline: [{ at: '8 Oct · 10:00', text: by + ' requested' }], zohoSubmitToken: token, ...extra });
const put = (who, it) => api(who, 'POST', '/api/sync/put', { col: 'requests', item: it });
async function submit(who, client, id, amount = 5000) {
  const p = await precheck(who, client, amount);
  assert.equal(p.status, 200, 'precheck ' + client.name + ' ' + JSON.stringify(p.json));
  const r = await put(who, item(who, id, client, p.json.submitToken, { requested: amount }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id;
}
async function escalate(who, client) {
  const p = await precheck(who, client);
  assert.equal(p.status, 422);
  const r = await api(who, 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: p.v.clientName, justification: 'Client paid in cash at the office today.',
    request: { company: client.name + ' FZCO', purpose: 'Visa renewal', zone: 'IFZA', requested: 5000, paid: PAID, date: '8 Oct', notes: '', docs: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id;
}
const decide = (who, id, action) => api(who, 'POST', `/api/requests/${id}/escalation`, { action, note: 'Noted for the record' });

before(async () => {
  srv = await startServer({ dir: mkTmp('review'), fixture: fixture() });
  for (const u of ['maram', 'anastasiya', 'amina', 'adnan', 'ahmed', 'eduard']) T[u] = await login(srv.base, u, TEAM_PW);
  T.sven = await login(srv.base, 'sven', MASTER_PW);
});
after(async () => { if (srv) await srv.stop(); });

test('the client type-ahead never carries the Zoho Books receivable', async () => {
  const r = await api('maram', 'GET', '/api/zoho/clients?q=quebec');
  assert.equal(r.status, 200);
  assert.ok(r.json.clients.length >= 1);
  for (const c of r.json.clients) assert.equal('outstanding' in c, false, JSON.stringify(c));
});

test('management cannot change the amount, the client, the notes or the history of a request; lines they add stay away from Operations', async () => {
  const id = await escalate('maram', C.kilo);
  assert.equal((await decide('ahmed', id, 'APPROVE')).status, 200);
  const r = await reqOf('adnan', id);
  const w = await put('adnan', { ...r, requested: 95000, approved: 95000, zohoClientId: C.alpha.id, notes: 'Seen by Adnan', timeline: [] });
  assert.equal(w.status, 200);
  const after = await reqOf('sven', id);
  assert.equal(after.requested, 5000);
  assert.equal(after.approved, null);
  assert.equal(after.zohoClientId, C.kilo.id);
  assert.equal(after.notes, r.notes, 'notes go through the escalation endpoints');
  assert.ok(after.timeline.length >= r.timeline.length, 'history lines were dropped');
  const line = await put('adnan', { ...after, timeline: after.timeline.concat([{ at: '9 Oct · 12:00', text: 'Board view: credit risk MN-42' }]) });
  assert.equal(line.status, 200);
  assert.ok((await reqOf('sven', id)).timeline.some(t => /MN-42/.test(t.text)), 'kept, signed');
  for (const who of ['maram', 'amina']) assert.doesNotMatch(JSON.stringify(await reqOf(who, id)), /MN-42/, who + ' sees a management line');
  assert.equal((await api('maram', 'POST', '/api/zoho/validate-client', { contactId: C.kilo.id })).status, 409, 'Kilo must stay locked');
});

test('a funding check on a stored request uses that request\'s own client and amount', async () => {
  const id = await submit('maram', C.alpha, 'FR-9401');
  const other = await pick('maram', C.bravo);
  const mism = await api('maram', 'POST', '/api/zoho/client-funding-check', { requestId: id, clientName: other.clientName, validationToken: other.token, company: 'x', purpose: 'y', requestedAmount: 10 });
  assert.equal(mism.status, 200, 'a stored request is checked against its own client, whatever token is sent');
  assert.equal(mism.json.clientId, C.alpha.id);
  assert.equal(mism.json.requestedAmount, 5000);
  const own = await pick('sven', C.alpha);
  const ok = await api('sven', 'POST', '/api/zoho/client-funding-check', { requestId: id, clientName: own.clientName, validationToken: own.token, company: 'x', purpose: 'y', requestedAmount: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.requestedAmount, 5000, 'the stored amount is checked, not the one sent');
});

test('Sven can check a stored request without a (30-minute) pick token', async () => {
  const id = await submit('maram', C.india, 'FR-9410');
  const r = await api('sven', 'POST', '/api/zoho/client-funding-check', { requestId: id, clientName: C.india.name, validationToken: 'expired.token', company: 'x', purpose: 'y', requestedAmount: 5000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.clientId, C.india.id);
});

test('a re-check (financeLatest) reaches restricted Operations without figures', async () => {
  const id = await submit('maram', C.juliet, 'FR-9411');
  const v = await api('sven', 'POST', '/api/zoho/client-funding-check', { requestId: id, clientName: C.juliet.name, company: 'x', purpose: 'y', requestedAmount: 5000 });
  assert.equal(v.status, 200);
  const mine = await reqOf('maram', id);
  assert.ok(mine.financeLatest, 'maram sees that a re-check ran');
  const text = JSON.stringify(mine);
  assert.doesNotMatch(text, /"detail"/);
  assert.doesNotMatch(text, /AED [\d,]+\.\d\d/);
  assert.match(JSON.stringify((await reqOf('sven', id)).financeLatest), /"detail"/);
});

test('Operations cannot rewrite or delete stored history lines, change "already paid", or clear the flag', async () => {
  const id = await submit('maram', C.uniform, 'FR-9412');
  const r = await reqOf('maram', id);
  const w = await put('maram', { ...r, paid: 'No — not yet', flagged: false, zohoStatus: 'Pending Sven Approval', timeline: [{ at: '8 Oct · 11:00', text: 'Maram: forged line' }] });
  assert.equal(w.status, 200);
  const after = await reqOf('sven', id);
  assert.equal(after.paid, PAID);
  assert.equal(after.zohoStatus, undefined);
  for (const t of r.timeline) assert.ok(after.timeline.some(x => x.at === t.at && x.text === t.text), 'lost: ' + t.text);
  assert.equal(after.timeline[after.timeline.length - 1].text, 'Maram: forged line', 'new lines are appended after the stored ones');
});

test('a restricted user cannot probe a balance with many different amounts', async () => {
  let last;
  for (const amount of [100, 200, 300, 400, 500, 600, 700]) last = await precheck('anastasiya', C.oscar, amount);
  assert.equal(last.status, 429);
  assert.equal(last.json.reason, 'TOO_MANY_AMOUNTS');
  assert.ok((await snap('sven')).audit.some(a => a.action === 'BALANCE_PROBE_BLOCKED'));
});

test('the submission checks stay on the request; a re-check is kept beside them', async () => {
  const id = await escalate('maram', C.lima);
  const before = (await reqOf('sven', id)).finance;
  const v = await pick('sven', C.lima);
  await api('sven', 'POST', '/api/zoho/client-funding-check', { requestId: id, clientName: v.clientName, validationToken: v.token, company: 'x', purpose: 'y', requestedAmount: 5000 });
  const r = await reqOf('sven', id);
  assert.equal(r.finance.id, before.id);
  assert.ok(r.financeLatest && r.financeLatest.id !== before.id);
});

test('audit entries shown to restricted Operations carry no amounts', async () => {
  const id = await submit('maram', C.charlie, 'FR-9402');
  await api('sven', 'POST', '/api/sync/put', { col: 'audit', item: { id: 'a-test-1', at: '8 Oct · 10:00', user: 'Sven', userId: 'sven', dept: 'FINANCE', action: 'ZOHO_FAILED',
    detail: 'Charlie — release blocked, balance moved to AED 3,000 against an approved AED 5,000', req: id, client: '' } });
  const a = (await snap('maram')).audit.find(x => x.id === 'a-test-1');
  assert.ok(a, 'maram sees the audit entry of her request');
  assert.doesNotMatch(a.detail, /3,000|5,000/);
  assert.match((await snap('sven')).audit.find(x => x.id === 'a-test-1').detail, /AED 3,000/);
});

test('a management user cannot decide an escalation they raised', async () => {
  const id = await escalate('adnan', C.mike);
  assert.equal((await decide('adnan', id, 'APPROVE')).status, 403);
  assert.equal((await decide('eduard', id, 'APPROVE')).status, 200);
});

test('Sven cannot answer management on the requester\'s behalf', async () => {
  const id = await escalate('maram', C.november);
  assert.equal((await decide('ahmed', id, 'INFO')).status, 200);
  assert.equal((await api('sven', 'POST', `/api/requests/${id}/escalation/reply`, { note: 'answering for her' })).status, 403);
  assert.equal((await api('maram', 'POST', `/api/requests/${id}/escalation/reply`, { note: 'Receipt uploaded' })).status, 200);
});

test('merge adds history only: no server-owned fields, no client lock', async () => {
  const r = await api('sven', 'POST', '/api/sync/merge', { col: 'requests', items: [{ id: 'FR-77777', by: 'maram', company: 'Sierra', status: 'NEW', date: '1 Oct', zohoClientId: C.sierra.id,
    requested: 90000, finance: { ok: true }, escalation: { decision: { action: 'APPROVE', by: 'adnan' } }, timeline: [] }] });
  assert.equal(r.status, 200);
  const m = await reqOf('sven', 'FR-77777');
  assert.equal(m.finance, undefined);
  assert.equal(m.escalation, undefined);
  assert.equal(m.zohoClientId, undefined);
  assert.notEqual((await precheck('maram', C.sierra)).status, 409, 'merged history must not lock the client');
});

test('re-opening a request respects the one-open-request-per-client lock', async () => {
  const first = await submit('maram', C.delta, 'FR-9403');
  const r1 = await reqOf('sven', first);
  assert.equal((await put('sven', { ...r1, status: 'APPROVED', approved: 5000 })).status, 200);
  const second = await submit('anastasiya', C.delta, 'FR-9404');
  assert.ok(second);
  const r2 = await reqOf('sven', first);
  const back = await put('sven', { ...r2, status: 'NEW' });
  assert.equal(back.status, 409);
  assert.equal(back.json.reason, 'REQUEST_PENDING');
});

test('amounts already approved for a client are held against its CFD balance', async () => {
  const id = await submit('maram', C.echo, 'FR-9405', 46000); // CFD balance 50,000
  const r = await reqOf('sven', id);
  assert.equal((await put('sven', { ...r, status: 'APPROVED', approved: 46000 })).status, 200);
  const p = await precheck('anastasiya', C.echo, 5000);         // 50,000 − 46,000 = 4,000 < 5,000
  assert.equal(p.status, 422);
  assert.ok(p.json.failed.some(f => f.key === 'CFD'), JSON.stringify(p.json.failed));
});

test('a refused, renumbered request does not re-point its notification at someone else\'s request', async () => {
  const theirs = await submit('amina', C.golf, 'FR-9406');
  const bad = await put('maram', item('maram', theirs, C.hotel, 'not-a-token'));
  assert.equal(bad.status, 422);
  const n = await api('maram', 'POST', '/api/sync/put', { col: 'notifications', item: { id: 'n-test-9406', to: 'sven', text: 'Maram requested AED 5,000 for Hotel.', at: '8 Oct · 10:00', read: false, req: theirs } });
  assert.equal(n.status, 200);
  const stored = (await snap('sven')).notifications.find(x => x.id === 'n-test-9406');
  assert.equal(stored.req, null, 'still points at ' + stored.req);
  assert.match(stored.text, /^Not submitted/);
});

test('a new request under the number of the same user\'s escalation gets a new number; resending it does not duplicate it', async () => {
  const escId = await escalate('maram', C.papa);                 // numbered by the server
  const p = await precheck('maram', C.hotel);
  assert.equal(p.status, 200);
  const first = await put('maram', item('maram', escId, C.hotel, p.json.submitToken)); // browser had not seen the escalation yet
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.notEqual(first.json.id, escId);
  assert.equal((await reqOf('sven', escId)).status, 'ESCALATED', 'the escalation was overwritten');
  const again = await put('maram', item('maram', escId, C.hotel, p.json.submitToken)); // the same request sent twice
  assert.equal(again.status, 200);
  assert.equal(again.json.id, first.json.id);
  assert.equal((await snap('sven')).requests.filter(r => r.zohoClientId === C.hotel.id).length, 1);
});

test('invoices marked paid without a matching payment fail the COGS check (Operations see no amounts)', async () => {
  const p = await precheck('maram', C.victor);
  assert.equal(p.status, 422);
  const cogs = p.json.finance.checks.find(c => c.key === 'COGS');
  assert.equal(cogs.ok, false);
  assert.equal(cogs.code, 'INVOICE_PAYMENT_MISMATCH');
  assert.doesNotMatch(JSON.stringify(p.json), /AED/);
});

test('an open request from the history locks its client by exact Books name', async () => {
  const open = (await snap('sven')).requests.find(r => !r.zohoClientId && ['NEW', 'ACTION'].includes(r.status));
  assert.ok(open, 'the ledger has open history requests');
  const r = await api('maram', 'POST', '/api/zoho/validate-client', { contactId: C.whiskey.id });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.pendingId, C.whiskey.pending);
});

test('browser-written audit rows and notifications carry the real author; Operations notify only finance', async () => {
  await api('maram', 'POST', '/api/sync/put', { col: 'audit', item: { id: 'forged-a1', user: 'Sven', userId: 'sven', dept: 'FINANCE', action: 'REQUEST_APPROVED', detail: 'forged', by: 'server' } });
  const a = (await snap('sven')).audit.find(x => x.id === 'forged-a1');
  assert.equal(a.user, 'Maram'); assert.equal(a.userId, 'maram'); assert.equal(a.by, 'browser');
  await api('maram', 'POST', '/api/sync/put', { col: 'notifications', item: { id: 'forged-n1', to: 'sven', text: 'Management approved — your final approval is needed.', read: false } });
  const n = (await snap('sven')).notifications.find(x => x.id === 'forged-n1');
  assert.match(n.text, /^Maram: /);
  assert.equal((await api('maram', 'POST', '/api/sync/put', { col: 'notifications', item: { id: 'forged-n2', to: 'anastasiya', text: 'hi', read: false } })).status, 403);
});

test('an oversized or deeply nested entry is refused and the server keeps running', async () => {
  let deep = []; for (let i = 0; i < 50; i++) deep = [deep];
  const r = await api('maram', 'POST', '/api/sync/put', { col: 'chat', item: { id: 'deep-1', who: 'maram', kind: 'msg', text: 'hi', x: deep } });
  assert.equal(r.status, 413);
  await new Promise(res => setTimeout(res, 400));
  assert.ok(srv.alive(), 'server still running');
});

test('an uploaded file is never served as a page', async () => {
  const up = await api('maram', 'POST', '/api/files', { name: 'invoice.pdf', mime: 'text/html', data: Buffer.from('<script>alert(1)</script>').toString('base64') });
  assert.equal(up.status, 200);
  const r = await fetch(srv.base + '/api/files/' + up.json.id, { headers: { Authorization: 'Bearer ' + T.maram } });
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
});

test('crediting records the time and ledger baseline once; an undo of "paid" does not reset them', async () => {
  const id = await submit('maram', C.xray, 'FR-9420');
  let r = await reqOf('sven', id);
  assert.equal((await put('sven', { ...r, status: 'APPROVED', approved: 5000 })).status, 200);
  r = await reqOf('sven', id);
  assert.equal((await put('sven', { ...r, status: 'CREDITED', credited: 5000 })).status, 200);
  const credited = await reqOf('sven', id);
  assert.ok(credited.creditedAt);
  assert.equal(typeof credited.ledgerDebitsAtCredit, 'number');
  assert.equal((await put('maram', { ...(await reqOf('maram', id)), status: 'PAID' })).status, 200);
  await new Promise(res => setTimeout(res, 20));
  assert.equal((await put('sven', { ...(await reqOf('sven', id)), status: 'CREDITED' })).status, 200);
  assert.equal((await reqOf('sven', id)).creditedAt, credited.creditedAt);
});

test('Operations cannot check a history request (no Books client) against a client of their choosing', async () => {
  const hist = (await snap('maram')).requests.find(r => !r.zohoClientId && r.by === 'maram');
  assert.ok(hist, 'maram has history requests');
  const r = await api('maram', 'POST', '/api/zoho/client-funding-check', { requestId: hist.id, clientName: C.kilo.name, company: 'x', purpose: 'y', requestedAmount: 100 });
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, 'NO_ZOHO_CLIENT');
});

test('funding checks outside finance are throttled per request', async () => {
  const own = await submit('anastasiya', C.yankee, 'FR-9430');
  const body = { requestId: own, clientName: 'x', company: 'x', purpose: 'y', requestedAmount: 5000 };
  const first = await api('anastasiya', 'POST', '/api/zoho/client-funding-check', body);
  const second = await api('anastasiya', 'POST', '/api/zoho/client-funding-check', body);
  assert.notEqual(first.status, 429);
  assert.equal(second.status, 429);
  assert.equal(second.json.reason, 'CHECKED_RECENTLY');
});

test('a notification can only be marked read by its recipient — not rewritten or re-addressed', async () => {
  const n = (await snap('maram')).notifications.find(x => x.to === 'maram');
  assert.ok(n, 'maram has a notification');
  const w = await api('maram', 'POST', '/api/sync/put', { col: 'notifications', item: { ...n, to: 'sven', text: 'Management approved — your final approval is needed.', read: true } });
  assert.equal(w.status, 200);
  const stored = (await snap('sven')).notifications.find(x => x.id === n.id); // Sven (Master) sees every notification
  assert.equal(stored.to, 'maram', 'it must not be re-addressed');
  assert.equal(stored.text, n.text, 'its text must not change');
  const mine = (await snap('maram')).notifications.find(x => x.id === n.id);
  assert.equal(mine.text, n.text);
  assert.equal(mine.read, true);
});

test('history lines Operations add are signed and never marked as the server\'s', async () => {
  const r = (await snap('maram')).requests.find(x => x.by === 'maram' && x.zohoClientId && x.status !== 'VOID');
  const w = await put('maram', { ...r, timeline: r.timeline.concat([{ at: '8 Oct · 15:00', text: 'Mr. Adnan (CFO) approved the escalation — proceed', srv: true }]) });
  assert.equal(w.status, 200);
  const last = (await reqOf('sven', r.id)).timeline.slice(-1)[0];
  assert.equal(last.srv, undefined);
  assert.equal(last.by, 'maram');
  assert.match(last.text, /^Maram: Mr\. Adnan/);
});

test('request ids are short; an oversized id is refused without being remembered', async () => {
  const r = await put('maram', item('maram', 'FR-' + 'x'.repeat(100), C.alpha, 'nope'));
  assert.equal(r.status, 400);
});

test('restore keeps a backup of what it replaces and never reissues request numbers', async () => {
  const pre = (await api('sven', 'GET', '/api/admin/reset/preview')).json;
  const r = await api('sven', 'POST', '/api/admin/reset', { ids: pre.live.map(x => x.id), clearNotifications: false, reason: 'test reset', confirm: 'RESET' });
  assert.equal(r.status, 200);
  const created = await submit('maram', C.foxtrot, 'FR-1');
  const restore = await api('sven', 'POST', '/api/admin/reset/restore', { backupId: r.json.backupId, confirm: 'RESTORE' });
  assert.equal(restore.status, 200);
  assert.match(restore.json.safetyBackupId, /^BK-/);
  const backups = (await api('sven', 'GET', '/api/admin/reset/preview')).json.backups.map(b => b.id);
  assert.ok(backups.includes(restore.json.safetyBackupId));
  assert.equal(await reqOf('sven', created), undefined, 'restored to the state before ' + created);
  const again = await submit('anastasiya', C.foxtrot, created); // same number as the request the restore removed
  assert.notEqual(again, created, 'request number ' + created + ' was handed out twice');
});

test('a failed invoice-settlement read decides nothing (Zoho unavailable), it is not a failed check', async () => {
  const fx = fixture(); fx.fail = { settlement: 503 };
  const other = await startServer({ dir: mkTmp('inv-fail'), fixture: fx });
  try {
    const t = await login(other.base, 'maram', TEAM_PW);
    const v = (await call(other.base, t, 'POST', '/api/zoho/validate-client', { contactId: C.alpha.id })).json;
    const p = await call(other.base, t, 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount: 5000, paid: PAID });
    assert.ok(p.status >= 500, 'expected a 5xx, got ' + p.status + ' ' + JSON.stringify(p.json).slice(0, 200));
    assert.equal(p.json.reason, 'ZOHO_UNAVAILABLE');
  } finally { await other.stop(); }
});
