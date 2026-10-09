// Platform reset / restore across restarts, and the management-account migration on boot.
// Run: node --test test/reset.e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, mkTmp, call, login, TEAM_PW, MASTER_PW, REPO } from './helpers.mjs';
import { fixture, C } from './fixtures.mjs';

const PAID = 'Yes — in full';
const numOf = id => Number(String(id).replace(/\D/g, '')) || 0;
// The history in ledger.json (its size changes whenever the ledger is refreshed).
const HIST = JSON.parse(fs.readFileSync(path.join(REPO, 'ledger.json'), 'utf8')).requests.length;
let srv, dir, T = {};
const api = (who, method, p, body) => call(srv.base, T[who], method, p, body);
const snap = async who => (await api(who, 'GET', '/api/sync/snapshot')).json;
async function signIn() { T = {}; for (const u of ['maram', 'adnan']) T[u] = await login(srv.base, u, TEAM_PW); T.sven = await login(srv.base, 'sven', MASTER_PW); }
async function restart() { await srv.stop(); srv = await startServer({ dir }); await signIn(); }
async function precheck(who, client) {
  const v = (await api(who, 'POST', '/api/zoho/validate-client', { contactId: client.id })).json;
  return { v, ...(await api(who, 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount: 5000, paid: PAID })) };
}
const item = (id, client, tok) => ({ id, by: 'maram', company: client.name, person: client.name, zohoClient: client.name, zohoClientId: client.id, purpose: 'Visa', zone: 'IFZA',
  requested: 5000, approved: null, credited: 0, status: 'NEW', date: '8 Oct', paid: PAID, notes: '', docs: [], timeline: [], zohoSubmitToken: tok });
async function submit(client, id) {
  const p = await precheck('maram', client);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const r = await api('maram', 'POST', '/api/sync/put', { col: 'requests', item: item(id, client, p.json.submitToken) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}
async function escalate(client) {
  const p = await precheck('maram', client);
  assert.equal(p.status, 422);
  const r = await api('maram', 'POST', '/api/requests/escalate', { escalateToken: p.json.escalate.token, clientName: p.v.clientName, justification: 'Client paid by bank transfer yesterday.',
    request: { company: client.name, person: client.name, purpose: 'Visa', zone: 'IFZA', requested: 5000, paid: PAID, date: '8 Oct', notes: '', docs: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id;
}

before(async () => { dir = mkTmp('reset'); srv = await startServer({ dir, fixture: fixture() }); await signIn(); });
after(async () => { if (srv) await srv.stop(); });

let L1, L2, BK1, BK2, N1, N2;
test('i. preview lists only live-created requests; permissions; confirm', async () => {
  L1 = (await submit(C.alpha, 'FR-600')).id;
  L2 = await escalate(C.kilo);
  assert.equal((await api('maram', 'POST', '/api/sync/put', { col: 'chat', item: { id: 'c-test-1', who: 'maram', kind: 'msg', req: L1, text: 'about my request', day: '8 Oct', at: '10:00' } })).status, 200);
  const pv = await api('sven', 'GET', '/api/admin/reset/preview');
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.json.live.map(r => r.id).sort(), [L1, L2].sort());
  assert.equal(pv.json.history.requests, HIST);
  assert.equal(pv.json.live.find(r => r.id === L1).byName, 'Maram');
  assert.equal((await api('maram', 'GET', '/api/admin/reset/preview')).status, 403);
  assert.equal((await api('adnan', 'GET', '/api/admin/reset/preview')).status, 403);
  assert.equal((await api('maram', 'POST', '/api/admin/reset', { ids: [L1], reason: 'Remove test data', confirm: 'RESET' })).status, 403);
  assert.equal((await api('sven', 'POST', '/api/admin/reset', { ids: [L1], reason: 'Remove test data', confirm: 'reset' })).status, 422);
  assert.equal((await api('sven', 'POST', '/api/admin/reset', { ids: [L1], reason: 'x', confirm: 'RESET' })).status, 422);
  assert.equal((await api('sven', 'POST', '/api/sync/bootstrap', { requests: [] })).status, 409);
  assert.equal((await api('maram', 'POST', '/api/admin/reset/restore', { backupId: 'BK-20260101T000000-ABCD', confirm: 'RESTORE' })).status, 403);
});

test('i. reset selected live requests: backup, removal of tied records, audit kept, numbers not reused', async () => {
  const before = await snap('sven');
  assert.ok(before.notifications.some(n => n.req === L2) && before.audit.some(a => a.req === L1));
  const r = await api('sven', 'POST', '/api/admin/reset', { ids: [L1, L2, 'FR-527'], includeHistory: false, clearNotifications: false, reason: 'Remove test data', confirm: 'RESET' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  BK1 = r.json.backupId;
  assert.match(BK1, /^BK-/);
  assert.equal(r.json.removed.requests, 2, 'history id FR-527 ignored without includeHistory');
  assert.equal(r.json.kept.requests, HIST);
  assert.ok(fs.existsSync(path.join(dir, 'backups', BK1 + '.json')), 'backup file written');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backups', BK1 + '.json'), 'utf8')).db.requests.length, HIST + 2);
  const s = await snap('sven');
  const ids = new Set(s.requests.map(x => x.id));
  assert.ok(!ids.has(L1) && !ids.has(L2) && ids.has('FR-527'));
  assert.ok(!s.notifications.some(n => n.req === L1 || n.req === L2), 'tied notifications removed');
  assert.ok(!s.audit.some(a => a.req === L1 || a.req === L2), 'tied audit removed');
  assert.ok(!s.chat.some(c => c.id === 'c-test-1'), 'tied chat removed');
  assert.ok(s.audit.some(a => a.action === 'PLATFORM_RESET'), 'PLATFORM_RESET audit kept');
  const pv = await api('sven', 'GET', '/api/admin/reset/preview');
  assert.ok(pv.json.backups.some(b => b.id === BK1));

  // numbers are not reused: the browser's old number is renamed, escalations get a higher one
  const floor = Math.max(numOf(L1), numOf(L2));
  const p = await submit(C.alpha, L1);
  N1 = p.id;
  assert.ok(p.renamed, 'reused number renamed');
  assert.ok(numOf(N1) > floor, `${N1} > FR-${floor}`);
  N2 = await escalate(C.kilo);
  assert.ok(numOf(N2) > floor, `${N2} > FR-${floor}`);
});

test('i. restart: removed requests do not come back from ledger.json', async () => {
  await restart();
  const s = await snap('sven');
  const ids = new Set(s.requests.map(x => x.id));
  assert.ok(!ids.has(L1), 'old L1 not resurrected');
  assert.ok(!ids.has(L2));
  assert.ok(ids.has(N1) && ids.has(N2));
  assert.equal(s.requests.length, HIST + 2);
});

test('i. includeHistory: history gone, stays gone after restart, snapshot not empty; restore brings it back', async () => {
  const r = await api('sven', 'POST', '/api/admin/reset', { ids: [], includeHistory: true, clearNotifications: true, reason: 'Remove the history too', confirm: 'RESET' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  BK2 = r.json.backupId;
  assert.equal(r.json.removed.requests, HIST);
  assert.equal(r.json.kept.requests, 2);
  let s = await snap('sven');
  assert.deepEqual(s.requests.map(x => x.id).sort(), [N1, N2].sort());
  assert.equal(s.empty, false);
  assert.equal(s.notifications.length, 0);
  assert.equal((await api('sven', 'GET', '/api/admin/reset/preview')).json.history.requests, 0);

  await restart();
  s = await snap('sven');
  assert.deepEqual(s.requests.map(x => x.id).sort(), [N1, N2].sort(), 'history stays gone after restart');
  assert.equal(s.empty, false);

  // reset everything → empty, still not "empty" (not a first start), and a restart does not reload the ledger
  const all = await api('sven', 'POST', '/api/admin/reset', { ids: [N1, N2], includeHistory: true, clearNotifications: true, reason: 'Everything goes', confirm: 'RESET' });
  assert.equal(all.status, 200);
  await restart();
  s = await snap('sven');
  assert.equal(s.requests.length, 0);
  assert.equal(s.empty, false);

  assert.equal((await api('sven', 'POST', '/api/admin/reset/restore', { backupId: BK2, confirm: 'restore' })).status, 422);
  assert.equal((await api('sven', 'POST', '/api/admin/reset/restore', { backupId: 'BK-nope', confirm: 'RESTORE' })).status, 404);
  const rs = await api('sven', 'POST', '/api/admin/reset/restore', { backupId: BK2, confirm: 'RESTORE' });
  assert.equal(rs.status, 200, JSON.stringify(rs.json));
  s = await snap('sven');
  assert.equal(s.requests.length, HIST + 2);
  assert.ok(s.requests.some(x => x.id === 'FR-527'));
  assert.ok(s.audit.some(a => a.action === 'PLATFORM_RESTORED'));
  await restart();
  s = await snap('sven');
  assert.equal(s.requests.length, HIST + 2, 'restored data persisted');
  // after a restore the old numbers are still not handed out again
  const p = await precheck('maram', C.bravo);
  const put = await api('maram', 'POST', '/api/sync/put', { col: 'requests', item: item(L2, C.bravo, p.json.submitToken) });
  assert.equal(put.status, 200);
  assert.ok(numOf(put.json.id) > Math.max(numOf(N1), numOf(N2)), 'new number after restore: ' + put.json.id);
});

test('j. management account migration on boot', async () => {
  const d = mkTmp('migrate');
  const hash = pw => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(d, 'users.json'), JSON.stringify([
    { key: 'sven', name: 'Sven', username: 'sven@onelink.solutions', role: 'MASTER_ADMIN', dept: 'FINANCE', active: true, perms: ['*'], pw: hash(MASTER_PW), pwSetAt: now, failCount: 0, lockedUntil: 0, created: now },
    { key: 'adnan', name: 'Adnan', username: 'adnan@onelink.solutions', role: 'MANAGEMENT', dept: 'MANAGEMENT', active: true, perms: [], pw: hash(TEAM_PW), pwSetAt: now, failCount: 0, lockedUntil: 0, created: now }
  ], null, 2));
  const m = await startServer({ dir: d, fixture: fixture() });
  try {
    const users = JSON.parse(fs.readFileSync(path.join(d, 'users.json'), 'utf8'));
    const by = k => users.find(u => u.key === k);
    assert.equal(by('adnan').title, 'CFO');
    assert.equal(by('adnan').active, true);
    for (const [k, t] of [['ahmed', 'General Manager'], ['eduard', 'Chief Legal Officer']]) {
      assert.ok(by(k), k + ' added');
      assert.equal(by(k).active, false);
      assert.equal(by(k).pw, null);
      assert.equal(by(k).dept, 'MANAGEMENT');
      assert.equal(by(k).title, t);
    }
    assert.equal(users.length, 4, 'nothing else added');
    const l = await call(m.base, null, 'POST', '/api/auth/login', { username: 'ahmed', password: '' });
    assert.ok(l.status === 403 || l.status === 401, 'inactive, no password: ' + l.status);
    const l2 = await call(m.base, null, 'POST', '/api/auth/login', { username: 'eduard', password: 'null' });
    assert.ok(l2.status >= 400);
    const sv = await login(m.base, 'sven', MASTER_PW);
    const acc = (await call(m.base, sv, 'GET', '/api/sync/snapshot')).json.accounts;
    assert.equal(acc.find(a => a.key === 'adnan').title, 'CFO');
    // Sven activates Ahmed without setting a password: still cannot sign in
    assert.equal((await call(m.base, sv, 'POST', '/api/admin/users/ahmed/active', { active: true })).status, 200);
    const l3 = await call(m.base, null, 'POST', '/api/auth/login', { username: 'ahmed', password: 'anything-at-all' });
    assert.equal(l3.status, 401);
    assert.ok(m.alive(), 'server survived a login against a null password hash');
  } finally { await m.stop(); }
});
