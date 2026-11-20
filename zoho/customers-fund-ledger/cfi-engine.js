// Client Fund Intelligence engine — copied unchanged from server/cfi-engine.js in the Onelink-server repo (tested there).
(function () {
// Client Fund Intelligence — the balance engine, as pure functions (tested in test/cfi-engine.test.js).
//
// The same rules run in three places and must stay identical:
//   1. here (reference + tests),
//   2. zoho/client-fund-intelligence/deluge/cfi_engine.dg (writes the Zoho Books records),
//   3. the Client Fund Intelligence dashboard (draws the live figures).
//
// Inputs are plain numbers and strings read from Zoho Books:
//   cfda      Client CFDA Balance record: received, paid, balance (balance is authoritative; it also carries
//             the bills / credit notes / invoices booked to the CFDA).
//   requests  Client Payment Request records for the client.
//   refunds   Client Refund records for the client.
//   reserved  Funds Reserved, set by Finance on the Client Fund Intelligence record.

const LOW_BALANCE = 1000;      // AED: below this an available balance is "low"
const VERY_LOW_BALANCE = 500;  // AED: second alert threshold
const LARGE_EXPENSE = 10000;   // AED: one rise in paid-out at least this big raises an alert
const DUPLICATE_DAYS = 30;     // same client, same amount, both open, created within this many days

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const num = (x) => { const n = Number(String(x ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };

/* ---------- requests ---------- */
// Open = submitted for approval or approved, and neither paid nor rejected.
function isPaid(r) { return /paid/i.test(String(r.paymentStatus || '')); }
function isRejected(r) { return r.status === 'rejected' || /reject/i.test(String(r.paymentStatus || '')); }
function isOpen(r) { return (r.status === 'pending_approval' || r.status === 'approved') && !isPaid(r) && !isRejected(r); }

/* ---------- refunds ---------- */
const OPEN_REFUND = new Set(['Expected', 'Partly received', 'Overdue']);
function refundOutstanding(f) {
  if (!OPEN_REFUND.has(f.status)) return 0;
  return r2(Math.max(0, num(f.expected) - num(f.received)));
}
function refundIsOverdue(f, today) {
  return refundOutstanding(f) > 0 && !!f.expectedDate && f.expectedDate < today;
}

/* ---------- money text ---------- */
function aed(x) {
  const v = r2(x), s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-' : '') + 'AED ' + s;
}

/* ---------- one request ---------- */
// Balance status rules: covered now = COVERED, covered only once expected refunds arrive = PENDING REFUND,
// not covered even then = SHORT. "Other open requests" follows the existing CFDA check: every other open
// request for the client, whatever its date.
function requestStatus({ current, reserved, otherOpen, amount, upcoming }) {
  const availableAfter = r2(current - reserved - otherOpen - amount);
  const projectedAfter = r2(availableAfter + upcoming);
  const status = availableAfter >= 0 ? 'COVERED' : projectedAfter >= 0 ? 'PENDING REFUND' : 'SHORT';
  return { availableAfter, projectedAfter, status };
}

function requestRecommendation(x) {
  const held = aed(x.current), after = aed(x.availableAfter);
  const parts = ['Client holds ' + held + (x.otherOpen ? ', ' + aed(x.otherOpen) + ' already committed to other open requests' : '') + (x.reserved ? ', ' + aed(x.reserved) + ' reserved' : '') + '.'];
  if (x.status === 'COVERED') {
    return '✅ APPROVE: ' + parts[0] + ' After this request of ' + aed(x.amount) + ', ' + after + ' remains available.';
  }
  if (x.status === 'PENDING REFUND') {
    const lead = x.overdue > 0 ? '⚠ AWAIT REFUND COLLECTION: ' : '✅ AVAILABLE AFTER REFUND RECOVERY: ';
    return lead + parts[0] + ' Expected refunds of ' + aed(x.upcoming) + ' bring the projected balance after this request to ' + aed(x.projectedAfter) + '.' +
      (x.overdue > 0 ? ' ' + aed(x.overdue) + ' of those refunds is overdue: collect before paying.' : ' Pay once the refund is in, or approve now as an override.');
  }
  return '⛔ HOLD: ' + parts[0] + ' Client is short by ' + aed(-x.availableAfter) + ' for this request of ' + aed(x.amount) +
    (x.upcoming > 0 ? ', and still short by ' + aed(-x.projectedAfter) + ' after expected refunds of ' + aed(x.upcoming) : '') + '. Collect funds first, or approve as an override.';
}

/* ---------- risk ---------- */
function riskOf({ current, available, projected, overdue, openCount, hasFunds }) {
  const factors = [];
  const add = (pts, why) => { if (pts > 0) factors.push({ pts, why }); };
  if (current < 0) add(25, 'Client owes Elite Onelink (' + aed(current) + ')');
  if (available < 0) add(25, 'Open requests exceed funds held');
  if (available < 0) add(Math.min(20, Math.ceil(-available / 1000) * 4), 'Short by ' + aed(-available));
  if (available < 0 && projected >= 0) add(5, 'Relies on expected refunds');
  if (projected < 0) add(20, 'Short even after expected refunds');
  if (overdue > 0) add(15, 'Refunds overdue (' + aed(overdue) + ')');
  if (available >= 0 && available < LOW_BALANCE && hasFunds) add(10, 'Available balance below ' + aed(LOW_BALANCE));
  if (openCount >= 3) add(5, openCount + ' open requests');
  const score = Math.min(100, factors.reduce((s, f) => s + f.pts, 0));
  const status = score >= 75 ? 'Critical' : score >= 50 ? 'High' : score >= 25 ? 'Medium' : 'Low';
  return { score, status, factors };
}

/* ---------- one client ---------- */
function evaluateClient({ cfda = {}, requests = [], refunds = [], reserved = 0, today }) {
  const received = r2(num(cfda.received)), paid = r2(num(cfda.paid));
  const current = r2(cfda.balance === undefined || cfda.balance === '' ? received - paid : num(cfda.balance));
  reserved = r2(num(reserved));

  const refundsReceived = r2(refunds.filter((f) => f.status === 'Received' || f.status === 'Partly received').reduce((s, f) => s + num(f.received), 0));
  const upcoming = r2(refunds.reduce((s, f) => s + refundOutstanding(f), 0));
  const overdue = r2(refunds.filter((f) => refundIsOverdue(f, today)).reduce((s, f) => s + refundOutstanding(f), 0));

  const open = requests.filter(isOpen);
  const openTotal = r2(open.reduce((s, r) => s + num(r.amount), 0));
  const available = r2(current - openTotal - reserved);
  const projected = r2(available + upcoming);
  const shortfall = r2(Math.max(0, -available));

  // a settled client (nothing held, nothing open, nothing due back) holds no funds; it is not "low"
  const fundStatus = current === 0 && !open.length && upcoming === 0 ? 'No funds held'
    : available < 0 ? (projected >= 0 ? 'Covered after refund' : 'Short')
    : available < LOW_BALANCE ? 'Low balance' : 'Available';
  const approvalStatus = !open.length ? 'No open requests'
    : available >= LOW_BALANCE ? 'Safe to approve'
    : available >= 0 ? 'Low available balance'
    : projected >= 0 ? (overdue > 0 ? 'Await refund collection' : 'Available after refund recovery')
    : 'Hold requests';

  const risk = riskOf({ current, available, projected, overdue, openCount: open.length, hasFunds: current > 0 });

  const reqs = open.map((r) => {
    const amount = r2(num(r.amount));
    const otherOpen = r2(openTotal - amount);
    const s = requestStatus({ current, reserved, otherOpen, amount, upcoming });
    const dup = open.find((o) => o !== r && Math.abs(num(o.amount) - amount) <= 1 &&
      Math.abs(Date.parse(o.created || 0) - Date.parse(r.created || 0)) <= DUPLICATE_DAYS * 864e5);
    return { id: r.id, amount, otherOpen, ...s, duplicateOf: dup ? dup.id : null,
      recommendation: requestRecommendation({ current, reserved, otherOpen, amount, upcoming, overdue, ...s }) };
  });

  let recommendation;
  if (approvalStatus === 'No open requests') {
    recommendation = (current < 0 ? '⛔ Client owes Elite Onelink ' + aed(-current) + '. Collect before any new payment. '
      : 'Client holds ' + aed(current) + '. ') + (upcoming > 0 ? 'Expected refunds: ' + aed(upcoming) + '. ' : '') + 'No open payment requests.';
  } else if (approvalStatus === 'Safe to approve' || approvalStatus === 'Low available balance') {
    recommendation = (approvalStatus === 'Safe to approve' ? '✅ Safe to approve: ' : '⚠ Low available balance: ') +
      'client holds ' + aed(current) + ', open requests total ' + aed(openTotal) + (reserved ? ', ' + aed(reserved) + ' reserved' : '') + ', leaving ' + aed(available) + ' available.';
  } else if (approvalStatus === 'Hold requests') {
    recommendation = '⛔ Hold requests: client is short by ' + aed(shortfall) + ' (holds ' + aed(current) + ', open requests ' + aed(openTotal) + ')' +
      (upcoming > 0 ? ' and still short by ' + aed(-projected) + ' after expected refunds of ' + aed(upcoming) : '') + '.';
  } else {
    recommendation = (approvalStatus === 'Await refund collection' ? '⚠ Await refund collection: ' : '✅ Available after refund recovery: ') +
      'client currently holds ' + aed(current) + ' and has expected refunds of ' + aed(upcoming) + '. Projected balance after recovery equals ' + aed(projected) +
      (openTotal ? ' after open requests of ' + aed(openTotal) : '') + '.' + (overdue > 0 ? ' ' + aed(overdue) + ' of the refunds is overdue.' : '');
  }

  return {
    deposits: received, expenses: paid, current, refundsReceived, upcoming, overdue, reserved,
    openTotal, openCount: open.length, available, projected, shortfall,
    fundStatus, approvalStatus, riskScore: risk.score, riskStatus: risk.status, riskFactors: risk.factors,
    recommendation, requests: reqs,
  };
}

/* ---------- alerts from one evaluation to the next ---------- */
// prev / next are evaluateClient results (prev may be null for a first check).
function alertsBetween(prev, next, { paidIncrease = 0 } = {}) {
  const out = [];
  const was = prev || { available: Infinity, fundStatus: '', riskStatus: 'Low' };
  if (next.available < VERY_LOW_BALANCE && next.available >= 0 && !(was.available < VERY_LOW_BALANCE)) out.push({ type: 'Balance below AED 500', severity: 'Warning', amount: next.available });
  else if (next.available < LOW_BALANCE && next.available >= 0 && !(was.available < LOW_BALANCE)) out.push({ type: 'Balance below AED 1,000', severity: 'Warning', amount: next.available });
  if (next.fundStatus === 'Short' && was.fundStatus !== 'Short') out.push({ type: 'Client became short', severity: 'Critical', amount: next.shortfall });
  if ((next.riskStatus === 'High' || next.riskStatus === 'Critical') && !(was.riskStatus === 'High' || was.riskStatus === 'Critical')) out.push({ type: 'High risk client', severity: next.riskStatus === 'Critical' ? 'Critical' : 'Warning', amount: next.riskScore });
  if (paidIncrease >= LARGE_EXPENSE) out.push({ type: 'Large expense', severity: 'Warning', amount: paidIncrease });
  return out;
}
window.CFI = { LOW_BALANCE, VERY_LOW_BALANCE, LARGE_EXPENSE, DUPLICATE_DAYS, isPaid, isRejected, isOpen, refundOutstanding, refundIsOverdue, aed, requestStatus, requestRecommendation, riskOf, evaluateClient, alertsBetween };
})();
