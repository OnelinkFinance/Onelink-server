// History ledger numbers vs live request numbers (end to end, own ledger file via LEDGER_FILE).
// Production went live with history FR-391..FR-527; live requests then took FR-528, FR-529, … . A newer ledger with history
// FR-528.. must never lose that history, never give one number to two requests, and never bring back purged history.
// Run: node --test test/ledger-numbers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, mkTmp, call, login, TEAM_PW, MASTER_PW } from './helpers.mjs';
import { fixture, C } from './fixtures.mjs';
import { ledgerHash } from '../ledger-hash.js';

const PAID = 'Yes — in full';
const H = (id, extra = {}) => ({ id, by: 'amina', company: 'History Co ' + id, person: 'Person ' + id, purpose: 'Visa', zone: 'IFZA', requested: 1000, approved: 1000, credited: 1000,
  status: 'CREDITED', date: '1 Oct', docs: [], notes: '', paid: 'Yes', timeline: [{ at: '1 Oct · 10:00', text: 'Amina requested AED 1,000 for ' + id }], ...extra });
const LIVE = (id, extra = {}) => ({ id, by: 'maram', company: 'Live Co ' + id, person: 'Live ' + id, purpose: 'Visa', zone: 'IFZA', requested: 2000, approved: null, credited: 0, status: 'NEW', date: '9 Oct',
  docs: [], notes: '', paid: PAID, timeline: [], requestorId: 'maram', clientId: null, createdAt: '2026-10-09T06:00:00.000Z', ...extra });

test('history under a number a live request took is imported under a fresh number; restarts are idempotent; tombstones respected', async () => {
  const dir = mkTmp('ledger-no'), lf = path.join(dir, 'ledger.json');
  const ledger = { requests: ['FR-525', 'FR-526', 'FR-527', 'FR-528', 'FR-529', 'FR-530', 'FR-531', 'FR-532'].map(id => H(id)), chat: [], notifications: [], audit: [] };
  fs.writeFileSync(lf, JSON.stringify(ledger));
  // The production server as the previous version left it: history ..527 (FR-526 purged in a reset), live FR-528 / FR-529,
  // and live FR-530 removed by that reset — tombstones without live/history information.
  fs.writeFileSync(path.join(dir, 'platform.json'), JSON.stringify({ rev: 9, resetAt: '2026-10-09T07:00:00.000Z', floorNo: 530, purged: ['FR-526', 'FR-530'],
    requests: [LIVE('FR-529'), LIVE('FR-528', { status: 'APPROVED', approved: 2000 }), H('FR-527'), H('FR-525')], chat: [], notifications: [], audit: [] }));
  const env = { LEDGER_FILE: lf };
  let srv = await startServer({ dir, fixture: fixture(), env });
  try {
    const out = srv.out();
    assert.match(out, /Ledger: FR-528 is taken by a live request — imported the history as FR-533\./);
    assert.match(out, /Ledger: FR-529 is taken by a live request — imported the history as FR-534\./);
    assert.match(out, /Ledger: FR-530 is taken by a live request removed in a reset — imported the history as FR-535\./);
    assert.match(out, /Ledger: 2 earlier reset tombstones classified — 1 live \(above FR-527\), 1 history\./);
    let sv = await login(srv.base, 'sven', MASTER_PW);
    const snap = async () => (await call(srv.base, sv, 'GET', '/api/sync/snapshot')).json;
    let s = await snap();
    const ids = s.requests.map(r => r.id);
    assert.equal(new Set(ids).size, ids.length, 'no number used twice');
    assert.deepEqual([...ids].sort(), ['FR-525', 'FR-527', 'FR-528', 'FR-529', 'FR-531', 'FR-532', 'FR-533', 'FR-534', 'FR-535']);
    const by = id => s.requests.find(r => r.id === id);
    assert.equal(by('FR-528').company, 'Live Co FR-528', 'the live request keeps its number and data');
    assert.equal(by('FR-528').status, 'APPROVED');
    assert.equal(by('FR-529').createdAt, '2026-10-09T06:00:00.000Z');
    assert.equal(by('FR-533').company, 'History Co FR-528', 'the history of FR-528 is kept, as FR-533');
    assert.equal(by('FR-534').company, 'History Co FR-529');
    assert.equal(by('FR-535').company, 'History Co FR-530', 'a live tombstone does not drop the history with its number');
    assert.equal(by('FR-526'), undefined, 'purged history stays gone');
    const pv = (await call(srv.base, sv, 'GET', '/api/admin/reset/preview')).json;
    assert.deepEqual(pv.live.map(r => r.id).sort(), ['FR-528', 'FR-529'], 'only the live requests count as live');
    assert.equal(pv.history.requests, 7);

    // new numbers never collide with the ledger: a browser number held by history is renamed above every ledger number
    const mt = await login(srv.base, 'maram', TEAM_PW);
    const v = (await call(srv.base, mt, 'POST', '/api/zoho/validate-client', { contactId: C.alpha.id })).json;
    const p = await call(srv.base, mt, 'POST', '/api/zoho/precheck', { validationToken: v.token, clientName: v.clientName, amount: 5000, paid: PAID });
    assert.equal(p.status, 200, JSON.stringify(p.json).slice(0, 200));
    const put = await call(srv.base, mt, 'POST', '/api/sync/put', { col: 'requests', item: { id: 'FR-530', by: 'maram', company: C.alpha.name + ' FZCO', person: C.alpha.name, zohoClient: C.alpha.name, zohoClientId: C.alpha.id,
      purpose: 'Visa', zone: 'IFZA', requested: 5000, approved: null, credited: 0, status: 'NEW', date: '9 Oct', paid: PAID, notes: '', docs: [], timeline: [], zohoSubmitToken: p.json.submitToken } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.id, 'FR-536', 'a freed live number is not handed out again');

    // a reset (new version) removes live FR-528: its tombstone is marked live
    const r = await call(srv.base, sv, 'POST', '/api/admin/reset', { ids: ['FR-528'], clearNotifications: false, reason: 'remove the test request', confirm: 'RESET' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await srv.stop();
    let saved = JSON.parse(fs.readFileSync(path.join(dir, 'platform.json'), 'utf8'));
    assert.deepEqual(saved.ledgerIds, { 'FR-528': 'FR-533', 'FR-529': 'FR-534', 'FR-530': 'FR-535' });
    assert.ok(saved.purgedLive.includes('FR-528') && saved.purgedLive.includes('FR-530'));
    assert.ok(!saved.purgedLive.includes('FR-526'));

    // restart with a ledger that also updates the history of FR-528 (now FR-533): same numbers, update applied through the map
    const oldEntry = ledger.requests.find(x => x.id === 'FR-528');
    const newEntry = { ...oldEntry, status: 'PAID', timeline: oldEntry.timeline.concat([{ at: '5 Oct · 09:00', text: 'Paid' }]) };
    fs.writeFileSync(lf, JSON.stringify({ ...ledger, requests: ledger.requests.map(x => x.id === 'FR-528' ? newEntry : x), previous: { 'FR-528': ledgerHash(oldEntry) } }));
    srv = await startServer({ dir, env });
    assert.doesNotMatch(srv.out(), /imported the history as/, 'no new numbers on restart');
    assert.match(srv.out(), /Ledger: updated 1 history requests \(0 left as edited on the platform\)\./);
    sv = await login(srv.base, 'sven', MASTER_PW);
    s = await snap();
    const ids2 = s.requests.map(r => r.id);
    assert.equal(new Set(ids2).size, ids2.length);
    assert.deepEqual([...ids2].sort(), ['FR-525', 'FR-527', 'FR-529', 'FR-531', 'FR-532', 'FR-533', 'FR-534', 'FR-535', 'FR-536']);
    assert.equal(s.requests.find(x => x.id === 'FR-533').status, 'PAID', 'the update reached the renumbered history');
    assert.equal(s.requests.find(x => x.id === 'FR-533').company, 'History Co FR-528');
    await srv.stop();

    // a third start changes nothing
    srv = await startServer({ dir, env });
    assert.match(srv.out(), /Ledger: server already up to date\./);
    assert.match(srv.out(), /Ledger: updated 0 history requests/);
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'platform.json'), 'utf8'));
    assert.equal(saved.requests.length, 9);
  } finally { await srv.stop(); }
});

test('purged history removed by a reset under this version stays gone, also when renumbered', async () => {
  const dir = mkTmp('ledger-no2'), lf = path.join(dir, 'ledger.json');
  fs.writeFileSync(lf, JSON.stringify({ requests: ['FR-527', 'FR-528', 'FR-529'].map(id => H(id)), chat: [], notifications: [], audit: [] }));
  fs.writeFileSync(path.join(dir, 'platform.json'), JSON.stringify({ rev: 1, requests: [LIVE('FR-528'), H('FR-527')], chat: [], notifications: [], audit: [] }));
  const env = { LEDGER_FILE: lf };
  let srv = await startServer({ dir, fixture: fixture(), env });
  try {
    assert.match(srv.out(), /FR-528 is taken by a live request — imported the history as FR-530\./);
    const sv = await login(srv.base, 'sven', MASTER_PW);
    const r = await call(srv.base, sv, 'POST', '/api/admin/reset', { ids: [], includeHistory: true, clearNotifications: false, reason: 'drop the history', confirm: 'RESET' });
    assert.equal(r.status, 200);
    assert.equal(r.json.removed.requests, 3, 'FR-527, FR-529 and FR-530 (the renumbered FR-528 history)');
    await srv.stop();
    srv = await startServer({ dir, env });
    const s = (await call(srv.base, await login(srv.base, 'sven', MASTER_PW), 'GET', '/api/sync/snapshot')).json;
    assert.deepEqual(s.requests.map(x => x.id), ['FR-528'], 'only the live request; purged history never comes back');
  } finally { await srv.stop(); }
});

test('an open history request already raised again on the platform is imported voided (duplicate), others are not', async () => {
  const dir = mkTmp('ledger-dup'), lf = path.join(dir, 'ledger.json');
  const open = (id, company, requested, status = 'NEW', date = '8 Oct') => H(id, { company, person: company + ' Person', requested, approved: null, credited: 0, status, date });
  fs.writeFileSync(lf, JSON.stringify({ requests: [H('FR-527'), open('FR-541', 'Nova Brands', 14010), open('FR-542', 'ETD Global', 1000), open('FR-543', 'Noble One', 700, 'ACTION'), open('FR-544', 'ETD Global', 1400, 'ACTION', '9 Oct')], chat: [], notifications: [], audit: [] }));
  fs.writeFileSync(path.join(dir, 'platform.json'), JSON.stringify({ rev: 1, requests: [
    LIVE('FR-528', { company: 'NOVA BRANDS', requested: 14010, createdAt: '2026-10-09T05:30:00.000Z' }),     // re-entered today → FR-541 duplicate
    LIVE('FR-529', { company: 'ETD Global', requested: 999, createdAt: '2026-10-09T05:40:00.000Z' }),         // other amount → FR-542 stays open
    LIVE('FR-530', { company: 'Other', person: 'x', zohoClient: 'Noble One', requested: 700, createdAt: '2026-10-07T05:00:00.000Z' }), // created before the history day → stays
    LIVE('FR-531', { company: 'ETD Global', requested: 1400, createdAt: '2026-10-09T08:00:00.000Z', status: 'VOID' }), // voided live → FR-544 stays
    H('FR-527')], chat: [], notifications: [], audit: [] }));
  const env = { LEDGER_FILE: lf };
  let srv = await startServer({ dir, fixture: fixture(), env });
  try {
    assert.match(srv.out(), /Ledger: FR-541 \(Nova Brands, 14010\) is already on the platform as FR-528 — imported as voided\./);
    assert.match(srv.out(), /\(1 voided as duplicates of live requests\)/);
    const s = (await call(srv.base, await login(srv.base, 'sven', MASTER_PW), 'GET', '/api/sync/snapshot')).json, by = id => s.requests.find(r => r.id === id);
    assert.equal(by('FR-541').status, 'VOID');
    assert.deepEqual(by('FR-541').voided, { ...by('FR-541').voided, by: 'system', byName: 'System', reason: 'Duplicate — raised again on the platform as FR-528', prevStatus: 'NEW' });
    assert.match(by('FR-541').timeline.at(-1).text, /Voided by the system — Duplicate — raised again on the platform as FR-528/);
    assert.equal(by('FR-542').status, 'NEW');
    assert.equal(by('FR-543').status, 'ACTION');
    assert.equal(by('FR-544').status, 'ACTION');
    assert.equal(by('FR-528').status, 'NEW', 'the live request is untouched');
    await srv.stop();
    srv = await startServer({ dir, env });
    assert.match(srv.out(), /Ledger: server already up to date\./);
    const s2 = (await call(srv.base, await login(srv.base, 'sven', MASTER_PW), 'GET', '/api/sync/snapshot')).json;
    assert.equal(s2.requests.find(r => r.id === 'FR-541').status, 'VOID', 'stays voided after a restart');
  } finally { await srv.stop(); }
});
