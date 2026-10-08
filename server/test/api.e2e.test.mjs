// End-to-end tests: the sandbox server with the Zoho stub, driven over HTTP.
// Run: node --test test/api.e2e.test.mjs   (or: node --test test/)
// Tests in this file run in order and share one server (scenario A); reset/restart and the account migration
// use their own servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, mkTmp, call, login, findKeys, TEAM_PW, MASTER_PW, OPS_INSUFFICIENT, sleep } from './helpers.mjs';
import { fixture, C } from './fixtures.mjs';

const PAID = 'Yes — in full';
let srv, dir, T = {};
const api = (who, method, p, body) => call(srv.base, T[who], method, p, body);
const snap = async who => (await api(who, 'GET', '/api/sync/snapshot')).json;
const reqOf = async (who, id) => (await snap(who)).requests.find(r => r.id === id);

async function pick(who, client) {
  const r = await api(who, 'POST', '/api/zoho/validate-client', { contactId: client.id });
  assert.equal(r.status, 200, 'validate-client ' + client.name + ': ' + JSON.stringify(r.json));
  return r.json;
}
async function precheck(who, client, amount = 5000, paid = PAID) {
  const v = await pick(who, client);
  return { v, ...(await api(who, 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount, paid })) };
}
const reqItem = (by, id, client, submitToken, extra = {}) => ({
  id, by, company: client.name + ' FZCO', person: client.name, zohoClient: client.name, zohoClientId: client.id,
  purpose: 'Visa renewal', zone: 'IFZA', requested: 5000, approved: null, credited: 0, status: 'NEW', date: '8 Oct',
  paid: PAID, notes: '', docs: [], timeline: [{ at: '08 Oct · 10:00', text: by + ' requested AED 5,000' }], zohoSubmitToken: submitToken, ...extra
});
const put = (who, item) => api(who, 'POST', '/api/sync/put', { col: 'requests', item });
// Create a request that passes the checks (precheck + put). Returns the stored id.
async function submit(who, client, id, extra) {
  const p = await precheck(who, client);
  assert.equal(p.status, 200, 'precheck ' + client.name + ': ' + JSON.stringify(p.json));
  const r = await put(who, reqItem(who, id, client, p.json.submitToken, extra));
  assert.equal(r.status, 200, 'put ' + id + ': ' + JSON.stringify(r.json));
  return { id: r.json.id, submitToken: p.json.submitToken, v: p.v };
}
async function escalate(who, client, justification = 'Client paid by bank transfer yesterday, receipt attached.') {
  const p = await precheck(who, client);
  assert.equal(p.status, 422, 'expected failing precheck for ' + client.name);
  const r = await api(who, 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: p.v.clientName, justification,
    request: { company: client.name + ' FZCO', person: client.name, purpose: 'Visa renewal', zone: 'IFZA', requested: 5000, paid: PAID, date: '8 Oct', notes: 'n', docs: [] } });
  return { p, ...r };
}
const decide = (who, id, action, note = 'Decision noted for the record') => api(who, 'POST', `/api/requests/${id}/escalation`, { action, note });
const notesFor = async (who, reqId) => (await snap(who)).notifications.filter(n => n.req === reqId && n.to === who);

before(async () => {
  dir = mkTmp('e2e');
  srv = await startServer({ dir, fixture: fixture() });
  for (const u of ['maram', 'anastasiya', 'amina', 'adnan', 'ahmed', 'eduard']) T[u] = await login(srv.base, u, TEAM_PW);
  T.sven = await login(srv.base, 'sven', MASTER_PW);
});
after(async () => { if (srv) await srv.stop(); });

// ---------- a. ops submit flow ----------
let FR1; // maram's Alpha request (FR-9001)
test('a(i) ops: client search, validate, precheck pass, put → finance attached and stripped for ops', async () => {
  const short = await api('maram', 'GET', '/api/zoho/clients?q=A');
  assert.equal(short.json.tooShort, true);
  const list = await api('maram', 'GET', '/api/zoho/clients?q=alpha');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.clients.map(c => c.contactId), [C.alpha.id]);
  const none = await api('maram', 'GET', '/api/zoho/clients?q=nosuchclientxyz');
  assert.equal(none.json.notFound, true);

  assert.equal((await api('maram', 'POST', '/api/zoho/validate-client', { contactId: 'Alpha Pass One' })).status, 400);
  assert.equal((await api('maram', 'POST', '/api/zoho/validate-client', { contactId: C.inactive.id })).status, 422);
  const v = await pick('maram', C.alpha);
  assert.equal(v.clientName, C.alpha.name);
  assert.deepEqual(v.balance, { hidden: true });

  const p = await api('maram', 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount: 5000, paid: PAID });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.ok, true);
  assert.ok(p.json.submitToken);
  assert.equal(p.json.finance.ok, true);
  assert.deepEqual(findKeys(p.json.finance, 'detail'), []);
  // mandatory / token errors
  assert.equal((await api('maram', 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount: 5000 })).status, 422);
  assert.equal((await api('maram', 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: 'Other', amount: 5000, paid: PAID })).status, 403);

  const r = await put('maram', reqItem('maram', 'FR-9001', C.alpha, p.json.submitToken));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  FR1 = r.json.id;
  assert.equal(FR1, 'FR-9001');

  const mine = await reqOf('maram', FR1);
  assert.ok(mine.finance, 'finance attached');
  assert.equal(mine.finance.ok, true);
  assert.deepEqual(mine.finance.checks.map(c => c.key), ['CFD', 'COGS', 'INVOICES']);
  assert.deepEqual(findKeys(mine.finance, 'detail'), [], 'ops copy has no detail');
  assert.ok(!('zohoBalance' in mine));
  assert.ok(!('zohoSubmitToken' in mine), 'submit token not stored');
  const svens = await reqOf('sven', FR1);
  assert.ok(findKeys(svens.finance, 'detail').length > 0, 'Sven sees details');
  assert.equal(svens.requestorId, 'maram');
  assert.equal(svens.clientId, C.alpha.id);
  assert.ok(svens.createdAt);
});

test('a(ii) ops: failing client → 422 FINANCIAL_CHECKS_FAILED, escalate token, no AED anywhere', async () => {
  const p = await precheck('maram', C.kilo);
  assert.equal(p.status, 422);
  assert.equal(p.json.reason, 'FINANCIAL_CHECKS_FAILED');
  assert.equal(p.json.error, OPS_INSUFFICIENT);
  assert.ok(Array.isArray(p.json.failed) && p.json.failed.some(f => f.key === 'CFD'));
  assert.equal(p.json.escalate.allowed, true);
  assert.ok(p.json.escalate.token);
  assert.doesNotMatch(JSON.stringify(p.json), /AED/);
  assert.deepEqual(findKeys(p.json, 'detail'), []);
  // staff get the figures
  const s = await precheck('sven', C.kilo);
  assert.equal(s.status, 422);
  assert.match(s.json.error, /AED 1,200\.00/, 'compact "AED 1.2K" parsed to 1200');
  // non-CFD failure: headline names the check
  const q = await precheck('maram', C.quebec);
  assert.equal(q.status, 422);
  assert.deepEqual(q.json.failed.map(f => f.key), ['INVOICES']);
  assert.match(q.json.error, /Invoice payment verification check failed/);
  assert.doesNotMatch(JSON.stringify(q.json), /AED/);
  // no balance record
  const n = await precheck('maram', C.papa);
  assert.equal(n.status, 422);
  assert.equal(n.json.error, OPS_INSUFFICIENT);
});

// ---------- b. one open request per client ----------
test('b. one open request per client: precheck / validate / escalate → 409', async () => {
  const v = await api('maram', 'POST', '/api/zoho/validate-client', { contactId: C.alpha.id });
  assert.equal(v.status, 409);
  assert.equal(v.json.pendingId, FR1);
  const list = await api('maram', 'GET', '/api/zoho/clients?q=alpha');
  assert.equal(list.json.clients[0].pendingId, FR1);
  // a validation token obtained before the request existed is still refused at precheck
  const tok = (await api('sven', 'POST', '/api/zoho/validate-client', { contactId: C.bravo.id })).json; // unrelated client, sanity
  assert.ok(tok.token);

  // two escalation passes for Mike, then escalate twice
  const p1 = await precheck('maram', C.mike), p2 = await precheck('maram', C.mike);
  assert.equal(p1.status, 422); assert.equal(p2.status, 422);
  const body = t => ({ escalateToken: t, clientName: C.mike.name, justification: 'Client paid in cash at the office today.',
    request: { company: C.mike.name + ' FZCO', person: C.mike.name, purpose: 'Visa', zone: 'IFZA', requested: 5000, paid: PAID, date: '8 Oct', notes: '', docs: [] } });
  const e1 = await api('maram', 'POST', '/api/requests/escalate', body(p1.json.escalate.token));
  assert.equal(e1.status, 200, JSON.stringify(e1.json));
  const e2 = await api('maram', 'POST', '/api/requests/escalate', body(p2.json.escalate.token));
  assert.equal(e2.status, 409);
  const p3 = await pick('maram', C.mike).catch(e => e);
  assert.ok(p3 instanceof Error, 'validate-client for a locked client is 409');
  // precheck with an old validation token for a now-locked client
  const pre = await api('maram', 'POST', '/api/zoho/precheck', { validationToken: p1.v.token, clientName: p1.v.clientName, amount: 5000, paid: PAID });
  assert.equal(pre.status, 409);
  assert.equal(pre.json.reason, 'REQUEST_PENDING');
});

// ---------- c. escalation ----------
let ESC1; // Kilo, escalated by maram
test('c. escalation: create, notifications, justification, single use, token kinds', async () => {
  const p = await precheck('maram', C.kilo);
  const req = { company: C.kilo.name + ' FZCO', person: C.kilo.name, purpose: 'Visa renewal', zone: 'IFZA', requested: 5000, paid: PAID, date: '8 Oct', notes: 'urgent', docs: [] };
  const short = await api('maram', 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: C.kilo.name, justification: 'too short', request: req });
  assert.equal(short.status, 422);
  const changed = await api('maram', 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: C.kilo.name, justification: 'Client paid by bank transfer yesterday.', request: { ...req, requested: 9000 } });
  assert.equal(changed.status, 422);
  // someone else's pass
  const other = await api('anastasiya', 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: C.kilo.name, justification: 'Client paid by bank transfer yesterday.', request: req });
  assert.equal(other.status, 403);

  const ok = await api('maram', 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: C.kilo.name, justification: 'Client paid by bank transfer yesterday.', request: req });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  ESC1 = ok.json.id;
  const it = ok.json.item;
  assert.equal(it.status, 'ESCALATED');
  assert.equal(it.zohoClientId, C.kilo.id);
  assert.equal(it.finance.ok, false);
  assert.deepEqual(findKeys(it, 'detail'), [], 'ops response stripped');
  assert.deepEqual(it.escalation.to.map(t => [t.key, t.title]), [['adnan', 'CFO'], ['ahmed', 'General Manager'], ['eduard', 'Chief Legal Officer']]);
  assert.deepEqual(it.escalation.failed.map(f => f.key), ['CFD']);
  assert.equal(it.escalation.decision, null);
  assert.equal(it.escalation.log[0].action, 'CREATED');
  assert.match(it.escalation.id, /^ESC-[0-9A-F]{6}$/);
  for (const u of ['adnan', 'ahmed', 'eduard', 'sven']) assert.ok((await notesFor(u, ESC1)).length >= 1, 'notification for ' + u);
  assert.equal((await notesFor('maram', ESC1)).length, 0, 'requester not notified of own escalation');
  const svens = await reqOf('sven', ESC1);
  assert.ok(findKeys(svens.finance, 'detail').length > 0);
  assert.ok((await snap('sven')).audit.some(a => a.action === 'ESCALATION_CREATED' && a.req === ESC1));

  // single use
  const again = await api('maram', 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: C.kilo.name, justification: 'Client paid by bank transfer yesterday.', request: req });
  assert.equal(again.status, 409);

  // a submit pass is not an escalation pass
  const pass = await precheck('maram', C.golf);
  assert.equal(pass.status, 200);
  const wrong = await api('maram', 'POST', '/api/requests/escalate', { escalateToken: pass.json.submitToken, clientName: C.golf.name, justification: 'Client paid by bank transfer yesterday.', request: { ...req, company: 'Golf' } });
  assert.equal(wrong.status, 403);
  // an escalation pass is not a submit pass
  const esc = await precheck('maram', C.november);
  const viaPut = await put('maram', reqItem('maram', 'FR-9050', C.november, esc.json.escalate.token));
  assert.ok(viaPut.status >= 400 && viaPut.status < 500, 'escalate token refused as zohoSubmitToken: ' + viaPut.status);
  assert.equal(await reqOf('sven', 'FR-9050'), undefined);
});

// ---------- d. management decisions ----------
test('d. management decisions: INFO → reply → APPROVE → Sven final approval; REJECT unlocks', async () => {
  assert.equal((await decide('maram', ESC1, 'APPROVE')).status, 403);
  assert.equal((await decide('sven', ESC1, 'APPROVE')).status, 403);
  assert.equal((await decide('amina', ESC1, 'APPROVE')).status, 403);
  assert.equal((await decide('adnan', ESC1, 'MAYBE')).status, 400);
  assert.equal((await decide('adnan', ESC1, 'APPROVE', 'ok')).status, 422);
  assert.equal((await decide('adnan', FR1, 'APPROVE')).status, 409, 'not escalated');

  const info = await decide('adnan', ESC1, 'INFO', 'Send the bank transfer proof');
  assert.equal(info.status, 200);
  assert.equal(info.json.item.status, 'MGMT_INFO');
  assert.equal(info.json.item.escalation.decision.action, 'INFO');
  assert.ok((await notesFor('maram', ESC1)).some(n => /Management needs more information/.test(n.text)));

  assert.equal((await api('anastasiya', 'POST', `/api/requests/${ESC1}/escalation/reply`, { note: 'Here it is' })).status, 403);
  assert.equal((await api('maram', 'POST', `/api/requests/${FR1}/escalation/reply`, { note: 'Here it is' })).status, 409);
  const reply = await api('maram', 'POST', `/api/requests/${ESC1}/escalation/reply`, { note: 'Proof uploaded to the request' });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.item.status, 'ESCALATED');
  assert.equal(reply.json.item.escalation.decision, null);
  assert.equal(reply.json.item.escalation.log.at(-1).action, 'REPLY');

  const appr = await decide('ahmed', ESC1, 'APPROVE', 'Proceed, client is reliable');
  assert.equal(appr.status, 200);
  assert.equal(appr.json.item.status, 'MGMT_APPROVED');
  assert.deepEqual([appr.json.item.escalation.decision.by, appr.json.item.escalation.decision.title], ['ahmed', 'General Manager']);
  assert.ok((await notesFor('sven', ESC1)).some(n => /Management approved/.test(n.text)));
  assert.equal((await decide('eduard', ESC1, 'REJECT')).status, 409, 'already decided');

  // ops cannot give the final approval; Sven can
  const cur = await reqOf('maram', ESC1);
  assert.equal((await put('maram', { ...cur, status: 'APPROVED' })).status, 403);
  const sv = await reqOf('sven', ESC1);
  const fin = await put('sven', { ...sv, status: 'APPROVED', approved: sv.requested });
  assert.equal(fin.status, 200, JSON.stringify(fin.json));
  assert.equal((await reqOf('sven', ESC1)).status, 'APPROVED');
  assert.ok((await reqOf('sven', ESC1)).escalation.decision, 'escalation kept');

  // REJECT path
  const e = await escalate('maram', C.lima);
  assert.equal(e.status, 200);
  const rej = await decide('eduard', e.json.id, 'REJECT', 'Client still owes us');
  assert.equal(rej.status, 200);
  assert.equal(rej.json.item.status, 'DECLINED');
  assert.equal(rej.json.item.approved, 0);
  const again = await precheck('maram', C.lima);
  assert.equal(again.status, 422, 'client unlocked after reject (fails checks, but not 409)');
});

// ---------- e. write rules ----------
let FR_B; // maram's Bravo request
test('e. write rules on /api/sync/put', async () => {
  // ESCALATED → NEW by ops
  const e = await escalate('maram', C.november);
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const esc = await reqOf('maram', e.json.id);
  assert.equal((await put('maram', { ...esc, status: 'NEW' })).status, 403);
  assert.equal((await put('sven', { ...(await reqOf('sven', e.json.id)), status: 'APPROVED' })).status, 403, 'Sven cannot skip management');

  // status changes on a NEW request
  const base = await reqOf('maram', FR1);
  for (const st of ['VOID', 'ESCALATED', 'MGMT_APPROVED', 'APPROVED', 'CREDITED']) assert.equal((await put('maram', { ...base, status: st })).status, 403, 'ops → ' + st);
  assert.equal((await put('sven', { ...(await reqOf('sven', FR1)), status: 'MGMT_APPROVED' })).status, 403);
  assert.equal((await put('sven', { ...(await reqOf('sven', FR1)), status: 'VOID' })).status, 403);

  // money / client fields silently restored
  const svBefore = await reqOf('sven', FR1);
  const edit = await put('maram', { ...base, requested: 99999, approved: 99999, credited: 99999, zohoClientId: C.bravo.id, zohoClient: C.bravo.name, notes: 'edited by ops',
    finance: { id: 'FV-FAKE', ok: true, checks: [] }, escalation: { id: 'ESC-FAKE' }, voided: { by: 'x' }, createdAt: 'x' });
  assert.equal(edit.status, 200);
  const after = await reqOf('sven', FR1);
  assert.equal(after.requested, 5000); assert.equal(after.approved, null); assert.equal(after.credited, 0);
  assert.equal(after.zohoClientId, C.alpha.id); assert.equal(after.zohoClient, C.alpha.name);
  assert.equal(after.notes, 'edited by ops');
  assert.equal(after.finance.id, svBefore.finance.id);
  assert.ok(!after.escalation && !after.voided);
  assert.equal(after.createdAt, svBefore.createdAt);

  // a new request must start at NEW
  const p = await precheck('maram', C.bravo);
  assert.equal((await put('maram', reqItem('maram', 'FR-9100', C.bravo, p.json.submitToken, { status: 'ACTION' }))).status, 403);
  assert.equal((await put('maram', reqItem('maram', 'FR-9100', C.bravo, p.json.submitToken, { status: 'ESCALATED' }))).status, 403);
  const ok = await put('maram', reqItem('maram', 'FR-9100', C.bravo, p.json.submitToken));
  assert.equal(ok.status, 200);
  FR_B = ok.json.id;

  // NEW → ACTION → NEW by ops; Sven approves + credits; ops CREDITED → PAID
  let r = await reqOf('maram', FR_B);
  assert.equal((await put('maram', { ...r, status: 'ACTION' })).status, 200);
  r = await reqOf('maram', FR_B);
  assert.equal((await put('maram', { ...r, status: 'NEW' })).status, 200);
  let s = await reqOf('sven', FR_B);
  assert.equal((await put('sven', { ...s, status: 'APPROVED', approved: 5000 })).status, 200);
  r = await reqOf('maram', FR_B);
  assert.equal((await put('maram', { ...r, status: 'CREDITED' })).status, 403, 'ops cannot credit');
  s = await reqOf('sven', FR_B);
  assert.equal((await put('sven', { ...s, status: 'CREDITED', credited: 5000 })).status, 200);
  r = await reqOf('maram', FR_B);
  assert.equal((await put('maram', { ...r, status: 'PAID' })).status, 200);
  assert.equal((await reqOf('sven', FR_B)).status, 'PAID');

  // another ops user cannot touch maram's request
  assert.equal((await put('anastasiya', { ...r, status: 'PAID', notes: 'x' })).status, 403);
});

// ---------- f. void ----------
test('f. void: permissions, reason, lock, unlock', async () => {
  const { id } = await submit('maram', C.charlie, 'FR-9200');
  assert.equal((await api('maram', 'POST', `/api/requests/${id}/void`, { reason: 'Duplicate request' })).status, 403);
  assert.equal((await api('amina', 'POST', `/api/requests/${id}/void`, { reason: 'Duplicate request' })).status, 403);
  assert.equal((await api('sven', 'POST', `/api/requests/${id}/void`, { reason: 'dup' })).status, 422);
  const v = await api('sven', 'POST', `/api/requests/${id}/void`, { reason: 'Duplicate request' });
  assert.equal(v.status, 200);
  assert.equal(v.json.item.status, 'VOID');
  assert.deepEqual([v.json.item.voided.by, v.json.item.voided.prevStatus, v.json.item.voided.reason], ['sven', 'NEW', 'Duplicate request']);
  assert.ok((await notesFor('maram', id)).some(n => /voided/.test(n.text)));
  assert.equal((await api('sven', 'POST', `/api/requests/${id}/void`, { reason: 'Duplicate request' })).status, 409);

  const m = await reqOf('maram', id);
  assert.equal((await put('maram', { ...m, notes: 'try edit' })).status, 403);
  assert.equal((await put('sven', { ...(await reqOf('sven', id)), status: 'APPROVED' })).status, 403);
  assert.equal((await put('sven', { ...(await reqOf('sven', id)), notes: 'x' })).status, 403);
  assert.equal((await api('maram', 'POST', `/api/requests/${id}/chase`, { note: 'chasing' })).status, 409);
  assert.equal((await api('sven', 'POST', `/api/requests/${id}/chase`, { note: 'chasing' })).status, 409);
  const fc = await api('sven', 'POST', '/api/zoho/client-funding-check', { requestId: id, clientName: C.charlie.name, company: 'Charlie', purpose: 'Visa', requestedAmount: 5000 });
  assert.equal(fc.status, 409);
  assert.equal(fc.json.reason, 'REQUEST_VOID');
  // unlocked
  assert.equal((await precheck('maram', C.charlie)).status, 200);

  // management can void too (escalated request)
  const e = await escalate('maram', C.sierra);
  assert.equal(e.status, 200);
  const mv = await api('adnan', 'POST', `/api/requests/${e.json.id}/void`, { reason: 'Client withdrew the request' });
  assert.equal(mv.status, 200);
  assert.equal(mv.json.item.voided.prevStatus, 'ESCALATED');
  assert.equal((await decide('ahmed', e.json.id, 'APPROVE')).status, 409);
  assert.equal((await api('maram', 'POST', `/api/requests/${e.json.id}/escalation/reply`, { note: 'more info' })).status, 409);
});

// ---------- g. chase ----------
test('g. chase invoice: docs, timeline, audit, notifications, validation, access', async () => {
  const up = await api('maram', 'POST', '/api/files', { name: 'INV-1.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') });
  assert.equal(up.status, 200);
  const fileId = up.json.id;
  const before = await reqOf('sven', FR_B);
  const c = await api('maram', 'POST', `/api/requests/${FR_B}/chase`, { note: 'Client paid, invoice attached',
    docs: [{ name: 'INV-1.pdf', type: 'Invoice', size: 13, fileId }, { name: 'bogus.pdf', type: 'Invoice', size: 1, fileId: '00000000-0000-0000-0000-000000000000' }, { name: 'evil', fileId: '../../etc/passwd' }] });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const it = c.json.item;
  assert.equal(it.docs.length, (before.docs || []).length + 1, 'bogus file ids dropped');
  assert.equal(it.docs.at(-1).fileId, fileId);
  assert.match(it.timeline.at(-1).text, /chased the invoice — attached INV-1\.pdf: Client paid, invoice attached/);
  assert.ok((await snap('sven')).audit.some(a => a.action === 'INVOICE_CHASED' && a.req === FR_B));
  assert.ok((await notesFor('sven', FR_B)).some(n => /Invoice chase/.test(n.text)));
  assert.equal((await notesFor('maram', FR_B)).filter(n => /Invoice chase/.test(n.text)).length, 0, 'chaser not notified');

  const s = await api('sven', 'POST', `/api/requests/${FR_B}/chase`, { note: 'Please send the receipt' });
  assert.equal(s.status, 200);
  assert.ok((await notesFor('maram', FR_B)).some(n => /Invoice chase/.test(n.text) && /Please send the receipt/.test(n.text)), 'requester notified');

  assert.equal((await api('maram', 'POST', `/api/requests/${FR_B}/chase`, { note: '', docs: [{ name: 'x', fileId: '00000000-0000-0000-0000-000000000000' }] })).status, 422);
  assert.equal((await api('maram', 'POST', `/api/requests/${FR_B}/chase`, {})).status, 422);
  assert.equal((await api('anastasiya', 'POST', `/api/requests/${FR_B}/chase`, { note: 'hi there' })).status, 403);
  assert.equal((await api('maram', 'POST', '/api/requests/FR-NOPE/chase', { note: 'hi there' })).status, 404);
  // Amina (ops master) may chase anyone's
  assert.equal((await api('amina', 'POST', `/api/requests/${FR_B}/chase`, { note: 'chasing for maram' })).status, 200);
});

// ---------- k. client-funding-check ----------
test('k. client-funding-check: passing request ok + finance; failing client → FINANCIAL_CHECKS_FAILED, ops notes amount-free', async () => {
  // Alpha is locked by FR1 (validate-client → 409), so the request's own check uses the name-only path (exact Books match)
  const r = await api('maram', 'POST', '/api/zoho/client-funding-check', { requestId: FR1, clientName: C.alpha.name, company: 'Alpha Pass One FZCO', purpose: 'Visa renewal', requestedAmount: 5000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.reason, 'VALIDATION_PASSED');
  assert.ok(r.json.finance && r.json.finance.ok);
  assert.deepEqual(findKeys(r.json.finance, 'detail'), []);
  for (const k of ['availableBalance', 'allocatedBalance', 'usedBalance', 'remainingAfterRequest', 'svenSummary', 'exported']) assert.ok(!(k in r.json), k + ' hidden from ops');
  assert.equal(r.json.attachedToRequest, true);
  const mine = await reqOf('maram', FR1);
  assert.equal(mine.zohoStatus, 'Pending Sven Approval');
  assert.ok(!('zohoBalance' in mine), 'ops copy has no zohoBalance');
  assert.equal((await reqOf('sven', FR1)).zohoBalance, 50000);

  // Operations cannot run a free-form check (no submitted request): it would let them probe a balance amount by amount.
  const o = await pick('maram', C.oscar);
  const f = await api('maram', 'POST', '/api/zoho/client-funding-check', { validationToken: o.token, clientName: o.clientName, company: 'Oscar', purpose: 'Visa', requestedAmount: 5000, paid: PAID });
  assert.equal(f.status, 409);
  assert.equal(f.json.reason, 'REQUEST_NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(f.json), /AED/);
  const fs_ = await api('sven', 'POST', '/api/zoho/client-funding-check', { validationToken: (await pick('sven', C.oscar)).token, clientName: C.oscar.name, company: 'Oscar', purpose: 'Visa', requestedAmount: 5000, paid: PAID });
  assert.equal(fs_.json.reason, 'FINANCIAL_CHECKS_FAILED');
  assert.match(fs_.json.notes, /AED/, 'staff notes carry the figures');
});

test('k2. Sven\'s funding check on an escalated request does not leak figures to the Operations requester (chat)', async () => {
  const e = await escalate('maram', C.romeo);
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const id = e.json.id;
  const r = await api('sven', 'POST', '/api/zoho/client-funding-check', { requestId: id, clientName: C.romeo.name, company: 'Romeo', purpose: 'Visa renewal', requestedAmount: 5000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.reason, 'FINANCIAL_CHECKS_FAILED');
  const s = await snap('maram');
  const chat = s.chat.filter(c => c.req === id);
  assert.ok(chat.length >= 1, 'requester sees the Zoho chat record of her own request');
  for (const c of chat) assert.doesNotMatch(c.text, /AED [\d,]+\.\d\d/, 'chat text shown to ops: ' + c.text);
  const mine = s.requests.find(x => x.id === id);
  assert.deepEqual(findKeys(mine.finance, 'detail'), []);
  for (const t of mine.timeline) assert.doesNotMatch(t.text, /CFD credits|COGS debits/, t.text);
});

test('k3. a restricted Operations user cannot run a funding check against someone else\'s request', async () => {
  const r = await api('anastasiya', 'POST', '/api/zoho/client-funding-check', { requestId: FR1, clientName: C.alpha.name, company: 'Alpha', purpose: 'Visa', requestedAmount: 5000 });
  assert.equal(r.status, 403, 'got ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 300));
});

// ---------- h. Amina ----------
test('h. Amina (Master Operations Control): sees all ops requests but — as Operations — no balances; cannot decide or void', async () => {
  const s = await snap('amina');
  const ids = s.requests.map(r => r.id);
  for (const id of [FR1, FR_B, ESC1]) assert.ok(ids.includes(id), id);
  const fr1 = s.requests.find(r => r.id === FR1);
  assert.equal(fr1.zohoBalance, undefined, 'no balance for Operations');
  assert.deepEqual(findKeys(fr1.finance, 'detail'), [], 'no finance figures for Operations');
  assert.equal((await api('amina', 'GET', `/api/zoho/client-balance?contactId=${C.bravo.id}`)).status, 403);
  assert.equal((await api('maram', 'GET', `/api/zoho/client-balance?contactId=${C.bravo.id}`)).status, 403);
  assert.ok((await snap('sven')).requests.find(r => r.id === FR1).zohoBalance === 50000, 'Sven still sees it');
  const mikeId = (await snap('sven')).requests.find(r => r.zohoClientId === C.mike.id && r.status === 'ESCALATED').id;
  assert.equal((await decide('amina', mikeId, 'APPROVE')).status, 403);
  assert.equal((await api('amina', 'POST', `/api/requests/${mikeId}/void`, { reason: 'Not allowed to void' })).status, 403);
  // restricted ops does not see others' requests
  const a = await snap('anastasiya');
  assert.ok(!a.requests.some(r => r.by === 'maram'));
});

// ---------- probes for gaps found while reading the code ----------
test('probe: a submit pass cannot be reused for a second request after the first is voided', async () => {
  const { id, submitToken } = await submit('maram', C.delta, 'FR-9300');
  assert.equal((await api('sven', 'POST', `/api/requests/${id}/void`, { reason: 'Voided for the reuse test' })).status, 200);
  const again = await put('maram', reqItem('maram', 'FR-9301', C.delta, submitToken));
  assert.ok(again.status >= 400, 'reused submit pass accepted: ' + again.status + ' ' + JSON.stringify(again.json));
});

test('probe: a new request from Operations cannot carry approved/credited/Zoho result fields', async () => {
  const p = await precheck('maram', C.foxtrot);
  const r = await put('maram', reqItem('maram', 'FR-9400', C.foxtrot, p.json.submitToken, {
    approved: 5000, credited: 5000, zohoStatus: 'Pending Sven Approval', zohoBalance: 999999, zohoValidationId: 'ZV-FAKE', override: { by: 'adnan' }, zohoClient: 'Somebody Else LLC' }));
  assert.equal(r.status, 200);
  const s = await reqOf('sven', r.json.id);
  const bad = {};
  if (s.approved !== null && s.approved !== undefined) bad.approved = s.approved;
  if (s.credited) bad.credited = s.credited;
  for (const k of ['zohoStatus', 'zohoBalance', 'zohoValidationId', 'override']) if (s[k] !== undefined) bad[k] = s[k];
  if (s.zohoClient !== C.foxtrot.name) bad.zohoClient = s.zohoClient;
  assert.deepEqual(bad, {}, 'client-supplied server fields stored on a new request');
});

test('probe: management cannot give Sven\'s final approval on MGMT_APPROVED via /api/sync/put', async () => {
  // fresh escalation on Papa (no CFD record)
  const p = await escalate('maram', C.papa);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await decide('adnan', p.json.id, 'APPROVE', 'Go ahead with it')).status, 200);
  const cur = await reqOf('adnan', p.json.id);
  const r = await put('adnan', { ...cur, status: 'APPROVED', approved: cur.requested });
  assert.equal(r.status, 403, 'management moved MGMT_APPROVED → APPROVED itself');
});

test('probe: the request must carry the "client already paid" answer the checks ran with', async () => {
  const p = await precheck('maram', C.golf, 5000, PAID);
  assert.equal(p.status, 200);
  const r = await put('maram', reqItem('maram', 'FR-9500', C.golf, p.json.submitToken, { paid: 'No' }));
  const s = r.status === 200 ? await reqOf('sven', r.json.id) : null;
  assert.ok(r.status >= 400, `accepted with paid "No" although the checks ran with "${PAID}" (finance item says: ${s && s.finance.checks[2].items[0].text})`);
});

test('probe: management cannot approve a NEW request directly via /api/sync/put (bypassing Sven)', async () => {
  const { id } = await submit('maram', C.hotel, 'FR-9600');
  const cur = await reqOf('adnan', id);
  const r = await put('adnan', { ...cur, status: 'APPROVED', approved: 5000 });
  assert.equal(r.status, 403, 'management approved a NEW request');
});

test('probe: a malformed escalate token does not crash the server', async () => {
  const bad = 'eyJ4IjoxfQ.' + 'é'.repeat(43); // same length as a real signature, multi-byte
  const r = await call(srv.base, T.maram, 'POST', '/api/requests/escalate', { escalateToken: bad, justification: 'x'.repeat(20), request: {} }).catch(e => ({ status: 0, json: { error: e.message } }));
  await sleep(300);
  assert.ok(srv.alive(), 'server process died:\n' + srv.out().split('\n').slice(-15).join('\n'));
  assert.ok(r.status >= 400 && r.status < 500, 'status ' + r.status);
});
