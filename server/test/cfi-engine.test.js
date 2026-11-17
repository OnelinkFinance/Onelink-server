import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClient, isOpen, requestStatus, alertsBetween, aed } from '../cfi-engine.js';

const TODAY = '2026-11-17';

test('worked example: AED 1,144 held + AED 2,339.50 expected refund = AED 3,483.50 projected', () => {
  // Mr. Earl Antonio Joseph Fortes: Client CFDA Balance on 17 Nov 2026
  const r = evaluateClient({
    cfda: { received: 4815, paid: 3671, balance: 1144 },
    refunds: [{ status: 'Expected', expected: 2339.5, received: 0, expectedDate: '2026-12-01' }],
    today: TODAY,
  });
  assert.equal(r.current, 1144);
  assert.equal(r.upcoming, 2339.5);
  assert.equal(r.available, 1144);
  assert.equal(r.projected, 3483.5);
  assert.equal(r.fundStatus, 'Available');
  assert.match(r.recommendation, /AED 1,144\.00/);
});

test('a request covered only by the expected refund is PENDING REFUND, recommended once the refund arrives', () => {
  const r = evaluateClient({
    cfda: { received: 4815, paid: 3671, balance: 1144 },
    requests: [{ id: 'R1', status: 'pending_approval', amount: 3000, created: '2026-11-17' }],
    refunds: [{ status: 'Expected', expected: 2339.5, received: 0, expectedDate: '2026-12-01' }],
    today: TODAY,
  });
  assert.equal(r.available, -1856);
  assert.equal(r.projected, 483.5);
  assert.equal(r.fundStatus, 'Covered after refund');
  assert.equal(r.approvalStatus, 'Available after refund recovery');
  assert.equal(r.requests[0].status, 'PENDING REFUND');
  assert.match(r.requests[0].recommendation, /^✅ AVAILABLE AFTER REFUND RECOVERY/);
});

test('an overdue refund turns the advice into "await refund collection"', () => {
  const r = evaluateClient({
    cfda: { balance: 1144, received: 4815, paid: 3671 },
    requests: [{ id: 'R1', status: 'approved', amount: 3000 }],
    refunds: [{ status: 'Expected', expected: 2339.5, expectedDate: '2026-11-01' }],
    today: TODAY,
  });
  assert.equal(r.overdue, 2339.5);
  assert.equal(r.approvalStatus, 'Await refund collection');
  assert.match(r.requests[0].recommendation, /^⚠ AWAIT REFUND COLLECTION/);
});

test('Tom Ross: client already owes AED 580, a AED 700 request is short by AED 1,280', () => {
  const r = evaluateClient({
    cfda: { received: 7380, paid: 7960, balance: -580 },
    requests: [{ id: 'Stryk', status: 'pending_approval', amount: 700 }],
    today: TODAY,
  });
  assert.equal(r.requests[0].availableAfter, -1280);
  assert.equal(r.requests[0].status, 'SHORT');
  assert.equal(r.fundStatus, 'Short');
  assert.equal(r.shortfall, 1280);
  assert.equal(r.approvalStatus, 'Hold requests');
  assert.ok(r.riskScore >= 50, 'owes money and short: at least High risk');
});

test('two open requests for the same client each count the other as committed', () => {
  const r = evaluateClient({
    cfda: { balance: 0 },
    requests: [{ id: 'A', status: 'approved', amount: 2750 }, { id: 'B', status: 'approved', amount: 3550 }],
    today: TODAY,
  });
  assert.deepEqual(r.requests.map((q) => [q.otherOpen, q.availableAfter]), [[3550, -6300], [2750, -6300]]);
});

test('paid and rejected requests are not open; drafts are not open', () => {
  assert.equal(isOpen({ status: 'approved', paymentStatus: '☑️ Paid' }), false);
  assert.equal(isOpen({ status: 'pending_approval', paymentStatus: 'Rejected' }), false);
  assert.equal(isOpen({ status: 'rejected' }), false);
  assert.equal(isOpen({ status: 'draft' }), false);
  assert.equal(isOpen({ status: 'approved', paymentStatus: '' }), true);
});

test('reserved funds reduce what is available', () => {
  const r = evaluateClient({ cfda: { balance: 5000, received: 5000 }, reserved: 4500, requests: [{ id: 'X', status: 'pending_approval', amount: 400 }], today: TODAY });
  assert.equal(r.available, 100);
  assert.equal(r.approvalStatus, 'Low available balance');
  assert.equal(requestStatus({ current: 5000, reserved: 4500, otherOpen: 0, amount: 400, upcoming: 0 }).status, 'COVERED');
});

test('duplicate: same client, same amount, both open', () => {
  const r = evaluateClient({
    cfda: { balance: 10000, received: 10000 },
    requests: [{ id: 'A', status: 'pending_approval', amount: 1000, created: '2026-11-16' }, { id: 'B', status: 'pending_approval', amount: 1000, created: '2026-11-17' }],
    today: TODAY,
  });
  assert.equal(r.requests[1].duplicateOf, 'A');
});

test('alerts fire on the transition, not on every check', () => {
  const ok = evaluateClient({ cfda: { balance: 5000, received: 5000 }, today: TODAY });
  const short = evaluateClient({ cfda: { balance: 500, received: 5000 }, requests: [{ id: 'A', status: 'approved', amount: 2000 }], today: TODAY });
  assert.deepEqual(alertsBetween(ok, short).map((a) => a.type), ['Client became short', 'High risk client']);
  assert.deepEqual(alertsBetween(short, short), []);
  assert.deepEqual(alertsBetween(ok, ok, { paidIncrease: 12000 }).map((a) => a.type), ['Large expense']);
});

test('a settled client with nothing open holds no funds, and is not low risk', () => {
  const r = evaluateClient({ cfda: { received: 12000, paid: 12000, balance: 0 }, today: TODAY });
  assert.equal(r.fundStatus, 'No funds held');
  assert.equal(r.riskScore, 0);
});

test('money text', () => {
  assert.equal(aed(3483.5), 'AED 3,483.50');
  assert.equal(aed(-1280), '-AED 1,280.00');
});
