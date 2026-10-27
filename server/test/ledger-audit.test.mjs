// Unit tests for ledger-audit.js (the client account audit and the chart of accounts review — pure logic).
// Run: node --test test/ledger-audit.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { auditClientAccounts, reviewChartOfAccounts, openEntries, NO_CLIENT, AREAS } from '../ledger-audit.js';

const CFD = '7050654000000685179', COGS = '7050654000000034003', BANK = '7050654000000203700', DOE = '7050654000001129012', STRIPE = '7050654000000314003';

// One clean client (Alpha): funded, invoiced, paid, nothing open. Each test adds one problem.
const clean = () => ({
  accounts: { cfd: CFD, cogs: COGS },
  customers: [{ id: '1', name: 'Alpha LLC' }, { id: '2', name: 'Beta FZE' }],
  balances: [{ clientId: '1', clientName: 'Alpha LLC', available: 0, allocated: 10000, used: 10000, status: 'Settled' }],
  creditNotes: [], cnApplications: [], refunds: [],
  payments: [{ customer: '1', id: 'p1', number: 'PMT-1', date: '2026-10-01', amount: 10000, unused: 0, refunded: 0, applied: 10000, account: BANK, accountName: 'ELITE ONELINK CORPORATE-AED Account', accountType: 'Bank' }],
  invoices: [{ customer: '1', id: 'i1', number: 'INV-1', status: 'Paid', date: '2026-10-01', total: 10000, balance: 0, writeOff: 0, paid: 10000, credited: 0 }],
  ledger: [
    { customer: '1', customerName: 'Alpha LLC', account: CFD, type: 'invoice', entityId: 'i1', txnId: 't1', reference: 'INV-1', date: '01 Oct 2026', debit: 0, credit: 10000, tagged: true },
    { customer: '1', customerName: 'Alpha LLC', account: CFD, type: 'expense', entityId: 'e1', txnId: 't2', reference: 'Visa fees', date: '05 Oct 2026', debit: 10000, credit: 0, tagged: true }
  ],
  counter: [{ txnId: 't2', account: '9', accountName: 'Alaan Main Account', accountType: 'Bank', debit: 0, credit: 10000 }]
});
const run = patch => auditClientAccounts({ ...clean(), ...patch });
const of = (r, id) => r.clients.find(c => c.id === id);
const codes = (r, id) => (of(r, id) || { exceptions: [] }).exceptions.map(e => e.code);

describe('auditClientAccounts — a clean client', () => {
  test('accurate, settled, the settlement traced to the transaction and the account', () => {
    const r = run({});
    const a = of(r, '1');
    assert.equal(a.status, 'ACCURATE');
    assert.equal(a.statusText, 'Accurate');
    assert.deepEqual(a.exceptions, []);
    assert.equal(a.liability.status, 'SETTLED');
    assert.equal(a.liability.settlement.reference, 'Visa fees');
    assert.equal(a.liability.settlement.date, '05 Oct 2026');
    assert.deepEqual(a.liability.settlement.accounts, [{ name: 'Alaan Main Account', type: 'Bank', amount: 10000 }]);
    assert.match(a.liability.settlementText, /Expense Visa fees on 05 Oct 2026, AED 10,000\.00 — paid from Alaan Main Account \(Bank\)/);
    assert.equal(r.summary.clients, 1);
    assert.equal(r.summary.accurate, 1);
    assert.equal(r.summary.exceptions, 0);
    assert.ok(!r.clients.some(c => c.id === ''), 'no empty "No client tag" bucket');
  });
  test('every exception carries the five report fields', () => {
    const r = run({ invoices: [{ customer: '1', id: 'i1', number: 'INV-1', status: 'Paid', date: '2026-10-01', total: 10000, balance: 0, writeOff: 0, paid: 4000, credited: 0 }] });
    const e = of(r, '1').exceptions[0];
    for (const k of ['client', 'type', 'issue', 'rootCause', 'correction']) assert.ok(typeof e[k] === 'string' && e[k].length > 3, k);
    assert.equal(e.client, 'Alpha LLC');
    assert.equal(e.areaLabel, AREAS.INVOICES);
  });
});

describe('auditClientAccounts — credit notes', () => {
  test('unused credit note while an invoice is open: error, apply it to the oldest invoice', () => {
    const r = run({
      creditNotes: [{ customer: '1', id: 'c1', number: 'CN-1', status: 'Open', date: '2026-10-02', total: 1500, balance: 1500 }],
      invoices: [...clean().invoices, { customer: '1', id: 'i2', number: 'INV-2', status: 'Overdue', date: '2026-10-03', total: 1000, balance: 1000, writeOff: 0, paid: 0, credited: 0 }]
    });
    const e = of(r, '1').exceptions.find(x => x.code === 'CN_UNUSED');
    assert.equal(e.severity, 'error');
    assert.match(e.correction, /Apply AED 1,500\.00 of CN-1: AED 1,000\.00 to INV-2; AED 500\.00 stays as credit/);
    assert.equal(of(r, '1').status, 'CORRECTIONS');
  });
  test('unused credit note with nothing open: review (refund or keep)', () => {
    const r = run({ creditNotes: [{ customer: '1', id: 'c1', number: 'CN-1', status: 'Open', date: '2026-10-02', total: 500, balance: 500 }] });
    const e = of(r, '1').exceptions.find(x => x.code === 'CN_UNUSED');
    assert.equal(e.severity, 'review');
    assert.match(e.correction, /Refund AED 500\.00 to Alpha LLC/);
    assert.equal(of(r, '1').liability.openCredits, 500);
  });
  test('credit note applied to another client’s invoice', () => {
    const r = run({
      creditNotes: [{ customer: '1', id: 'c1', number: 'CN-1', status: 'Closed', date: '2026-10-02', total: 800, balance: 0 }],
      cnApplications: [{ creditNoteId: 'c1', invoiceCustomer: '2', invoice: 'INV-9', amount: 800 }]
    });
    const e = of(r, '1').exceptions.find(x => x.code === 'CN_WRONG_CLIENT');
    assert.equal(e.severity, 'error');
    assert.match(e.issue, /CN-1 is applied to invoice INV-9 of Beta FZE/);
  });
  test('over-applied, closed with a balance, and a duplicate pair', () => {
    const r = run({
      creditNotes: [
        { customer: '1', id: 'c1', number: 'CN-1', status: 'Closed', date: '2026-10-02', total: 300, balance: 0 },
        { customer: '1', id: 'c2', number: 'CN-2', status: 'Closed', date: '2026-10-04', total: 300, balance: 100 }
      ],
      cnApplications: [{ creditNoteId: 'c1', invoiceCustomer: '1', invoice: 'INV-1', amount: 300 }, { creditNoteId: 'c1', invoiceCustomer: '1', invoice: 'INV-1', amount: 300 }]
    });
    const c = codes(r, '1');
    assert.ok(c.includes('CN_OVER_APPLIED'));
    assert.ok(c.includes('CN_STATUS'));
    assert.ok(c.includes('CN_DUPLICATE'));
  });
  test('a void credit note is ignored', () => {
    const r = run({ creditNotes: [{ customer: '1', id: 'c1', number: 'CN-1', status: 'Void', date: '2026-10-02', total: 500, balance: 500 }] });
    assert.deepEqual(codes(r, '1'), []);
  });
});

describe('auditClientAccounts — refunds', () => {
  const refund = (accountType, customer = '1') => [
    { customer, type: 'creditnote_refund', entityId: 'r1', txnId: 'tr1', account: '3', accountName: accountType === 'Bank' ? 'WIO BANK' : 'Customers Fund Disbursement Account', accountType, date: '2026-10-06', debit: 0, credit: 400, reference: 'RF-1' },
    { customer, type: 'creditnote_refund', entityId: 'r1', txnId: 'tr1', account: '4', accountName: 'Accounts Receivable', accountType: 'Accounts Receivable', date: '2026-10-06', debit: 400, credit: 0, reference: 'RF-1' }
  ];
  const cn = [{ customer: '1', id: 'c1', number: 'CN-1', status: 'Closed', date: '2026-10-02', total: 400, balance: 0 }];
  test('refund paid from a bank against its credit note: nothing to report', () => {
    const r = run({ creditNotes: cn, refunds: refund('Bank') });
    assert.deepEqual(codes(r, '1'), []);
    assert.equal(of(r, '1').figures.refunded, 400);
  });
  test('an exchange difference on the refund is not a mismatch (CN-00002: AED 34,440 refunded as AED 34,764.25)', () => {
    const r = run({
      creditNotes: [{ customer: '1', id: 'c2', number: 'CN-00002', status: 'Closed', date: '20 Jan 2026', total: 34440, balance: 0 }],
      refunds: [
        { customer: '1', type: 'creditnote_refund', entityId: 'r2', txnId: 'tr2', account: BANK, accountName: 'ELITE ONELINK CORPORATE-AED Account', accountType: 'Bank', date: '20 Jan 2026', debit: 0, credit: 34764.25, reference: '' },
        { customer: '1', type: 'creditnote_refund', entityId: 'r2', txnId: 'tr2', account: '364', accountName: 'Accounts Receivable', accountType: 'Accounts Receivable', date: '20 Jan 2026', debit: 34440, credit: 0, reference: '' },
        { customer: '1', type: 'creditnote_refund', entityId: 'r2', txnId: 'tr2', account: '415', accountName: 'Exchange Gain or Loss', accountType: 'Other Expense', date: '20 Jan 2026', debit: 324.25, credit: 0, reference: '' }
      ]
    });
    assert.deepEqual(codes(r, '1'), []);
  });
  test('refund paid out of a non-bank account', () => {
    const r = run({ creditNotes: cn, refunds: refund('Other Current Liability') });
    const e = of(r, '1').exceptions.find(x => x.code === 'REFUND_ACCOUNT');
    assert.equal(e.severity, 'error');
    assert.match(e.issue, /paid out of Customers Fund Disbursement Account \(Other Current Liability\)/);
  });
  test('refund with no client goes to the "No client tag" bucket', () => {
    const r = run({ refunds: refund('Bank', '') });
    assert.ok(codes(r, '').includes('REFUND_NO_CLIENT'));
    assert.equal(of(r, '').name, NO_CLIENT);
    assert.equal(r.clients[0].id, '', 'the untagged bucket is listed first');
  });
  test('credit note refunded on paper with no refund entry in the ledger', () => {
    const r = run({ creditNotes: cn });
    const e = of(r, '1').exceptions.find(x => x.code === 'CN_REFUND_MISSING');
    assert.equal(e.severity, 'review');
    assert.equal(e.amount, 400);
  });
  test('payment refund missing from the ledger', () => {
    const r = run({ payments: [{ ...clean().payments[0], amount: 10500, refunded: 500 }] });
    assert.ok(codes(r, '1').includes('PAYMENT_REFUND_MISSING'));
  });
});

describe('auditClientAccounts — payments', () => {
  const pay = patch => run({ payments: [{ ...clean().payments[0], ...patch }] });
  test('no deposit account', () => assert.ok(codes(pay({ account: '', accountName: '', accountType: '' }), '1').includes('PAYMENT_NO_SOURCE')));
  test('deposited to an expense account: review; to the client fund account: fine', () => {
    assert.ok(codes(pay({ account: '77', accountName: 'Office Supplies', accountType: 'Expense' }), '1').includes('PAYMENT_SOURCE'));
    assert.ok(!codes(pay({ account: CFD, accountName: 'Customers Fund Disbursement Account', accountType: 'Other Current Liability' }), '1').includes('PAYMENT_SOURCE'));
    assert.ok(!codes(pay({ account: STRIPE, accountName: 'Stripe Clearing', accountType: 'Payment Clearing' }), '1').includes('PAYMENT_SOURCE'));
  });
  test('unapplied while an invoice is open: misallocated', () => {
    const r = run({
      payments: [{ ...clean().payments[0], amount: 12000, unused: 2000 }],
      invoices: [...clean().invoices, { customer: '1', id: 'i2', number: 'INV-2', status: 'Open', date: '2026-10-09', total: 2000, balance: 2000, writeOff: 0, paid: 0, credited: 0 }]
    });
    const e = of(r, '1').exceptions.find(x => x.code === 'PAYMENT_UNAPPLIED');
    assert.match(e.correction, /Apply AED 2,000\.00 of PMT-1: AED 2,000\.00 to INV-2\./);
  });
  test('payment with no invoice at all', () => {
    const r = run({ invoices: [], payments: [{ ...clean().payments[0], applied: 0, unused: 10000 }] });
    assert.ok(codes(r, '1').includes('PAYMENT_NO_INVOICE'));
    assert.equal(of(r, '1').liability.unusedPayments, 10000);
  });
  test('allocated more than the payment', () => assert.ok(codes(pay({ applied: 10000, unused: 900 }), '1').includes('PAYMENT_OVER_ALLOCATED')));
});

describe('auditClientAccounts — invoices and journal entries', () => {
  const inv = patch => run({ invoices: [{ ...clean().invoices[0], ...patch }] });
  test('settled without a matching payment', () => {
    const e = of(inv({ paid: 6000 }), '1').exceptions.find(x => x.code === 'INV_UNMATCHED_SETTLEMENT');
    assert.equal(e.amount, 4000);
    assert.equal(e.severity, 'error');
  });
  test('a write-off or a credit note counts as settled', () => {
    assert.deepEqual(codes(inv({ paid: 9000, writeOff: 1000 }), '1'), []);
    assert.deepEqual(codes(inv({ paid: 9000, credited: 1000 }), '1'), []);
  });
  test('rounding up to AED 1 is not an error', () => assert.deepEqual(codes(inv({ paid: 9999.4 }), '1'), []));
  test('applied twice', () => assert.ok(codes(inv({ paid: 10000, credited: 5000 }), '1').includes('INV_OVER_SETTLED')));
  test('paid (Analytics: "Closed") with a balance, and open with none', () => {
    assert.ok(codes(inv({ balance: 300, paid: 9700 }), '1').includes('INV_STATUS'));
    assert.ok(codes(inv({ status: 'Closed', balance: 300, paid: 9700 }), '1').includes('INV_STATUS'));
    assert.deepEqual(codes(inv({ status: 'Closed' }), '1'), []);
    assert.ok(codes(inv({ status: 'Overdue' }), '1').includes('INV_STATUS'));
  });
  test('draft and void invoices are skipped', () => assert.deepEqual(codes(inv({ status: 'Void', paid: 0 }), '1'), []));
  test('a CFD journal with no client, and one matched only by reference', () => {
    const r = run({ ledger: [...clean().ledger,
      { customer: '', account: CFD, type: 'journal', entityId: 'j1', txnId: 'tj1', reference: 'JV-7', date: '07 Oct 2026', debit: 250, credit: 0, tagged: false },
      { customer: '1', customerName: 'Alpha LLC', account: CFD, type: 'journal', entityId: 'j2', txnId: 'tj2', reference: 'Alpha LLC adj', date: '08 Oct 2026', debit: 0, credit: 0.01, tagged: false }] });
    const u = of(r, '').exceptions.find(x => x.code === 'LEDGER_UNTAGGED');
    assert.match(u.issue, /Journal JV-7 \(07 Oct 2026\) posts AED 250\.00 debit to Customers Fund Disbursement with no client/);
    assert.ok(codes(r, '1').includes('LEDGER_REFERENCE_MATCH'));
    assert.equal(r.summary.untagged, 1);
  });
});

describe('auditClientAccounts — liabilities', () => {
  test('funds held: open liability, last movement traced', () => {
    const r = run({ balances: [{ clientId: '1', clientName: 'Alpha LLC', available: 2500, allocated: 12500, used: 10000 }] });
    const l = of(r, '1').liability;
    assert.equal(l.status, 'OPEN');
    assert.equal(l.held, 2500);
    assert.match(l.text, /AED 2,500\.00 of client funds held/);
    assert.equal(r.summary.liabilitiesHeld, 2500);
  });
  test('funds held while invoices are due: review — settle the dues from the funds', () => {
    const r = run({
      balances: [{ clientId: '1', clientName: 'Alpha LLC', available: 2500, allocated: 12500, used: 10000 }],
      invoices: [...clean().invoices, { customer: '1', id: 'i2', number: 'INV-2', status: 'Overdue', date: '2026-10-09', total: 900, balance: 900, writeOff: 0, paid: 0, credited: 0 }]
    });
    const e = of(r, '1').exceptions.find(x => x.code === 'LIABILITY_WITH_DUES');
    assert.equal(e.amount, 900);
    assert.match(e.correction, /Dr Customers Fund Disbursement \/ Cr Accounts Receivable/);
  });
  test('overdrawn: disbursed more than received', () => {
    const r = run({ balances: [{ clientId: '1', clientName: 'Alpha LLC', available: -700, allocated: 10000, used: 10700 }] });
    const e = of(r, '1').exceptions.find(x => x.code === 'LIABILITY_OVERDRAWN');
    assert.equal(e.amount, 700);
    assert.match(e.issue, /Last disbursement: Expense Visa fees on 05 Oct 2026/);
    assert.equal(r.summary.overdrawn, 1);
  });
  test('without a balance record the ledger lines decide', () => {
    const r = run({ balances: [] });
    assert.equal(of(r, '1').liability.status, 'SETTLED');
    assert.equal(of(r, '1').liability.received, 10000);
  });
});

// ── Module 2 ──
const acct = (id, name, type, base, active = 'Yes') => ({ id, name, type, base, active, code: '' });
const mv = (account, type, debit, credit, lines = 1, untagged = 0) => ({ account, type, debit, credit, lines, untagged });
const coa = patch => reviewChartOfAccounts({
  accounts: [
    acct(CFD, 'Customers Fund Disbursement Account', 'Other Current Liability', 'Liability'),
    acct(COGS, 'Cost of Goods Sold-Clients Payments', 'Cost Of Goods Sold', 'Expense'),
    acct(DOE, 'Disbursements Of Expenses', 'Expense', 'Expense'),
    acct(STRIPE, 'Stripe Clearing', 'Payment Clearing', 'Asset'),
    acct(BANK, 'ELITE ONELINK CORPORATE-AED Account', 'Bank', 'Asset'),
    acct('w1', 'Alaan-Admin Wallet-Carmen Card', 'Bank', 'Asset'),
    acct('d1', 'Discount', 'Income', 'Income'),
    acct('s1', 'Suspense Clearing Account', 'Other Current Liability', 'Liability'),
    acct('o1', 'Old Petty Cash', 'Cash', 'Asset', 'No')
  ],
  movements: [
    mv(CFD, 'invoice', 0, 6000, 10), mv(CFD, 'expense', 5300, 0, 8, 1),
    mv(COGS, 'expense', 900, 0, 3),
    mv(DOE, 'expense', 5000, 0, 3, 3), mv(DOE, 'invoice', 0, 5497.8, 3),
    mv(STRIPE, 'invoice_payment', 2000, 0, 2), mv(STRIPE, 'transfer_fund', 0, 2000, 1),
    mv(BANK, 'invoice_payment', 90000, 20000, 40),
    mv('w1', 'expense', 0, 642558.12, 500), mv('w1', 'transfer_fund', 642504.79, 0, 400),
    mv('d1', 'invoice', 97046.22, 0, 24),
    mv('o1', 'expense', 50, 0, 1)
  ],
  lines: {
    [DOE]: [
      { customer: '', type: 'expense', entityId: 'e1', reference: 'Visa A', date: '01 Oct 2026', debit: 2000, credit: 0 },
      { customer: '', type: 'expense', entityId: 'e2', reference: 'Visa B', date: '02 Oct 2026', debit: 3000, credit: 0 },
      { customer: '1', type: 'invoice', entityId: 'i1', reference: 'INV-1', date: '03 Oct 2026', debit: 0, credit: 2000 },
      { customer: '2', type: 'invoice', entityId: 'i2', reference: 'INV-2', date: '04 Oct 2026', debit: 0, credit: 3000 },
      { customer: '2', type: 'invoice', entityId: 'i3', reference: 'INV-3', date: '05 Oct 2026', debit: 0, credit: 497.8 }
    ],
    [STRIPE]: [
      { customer: '1', type: 'invoice_payment', entityId: 'p1', date: '01 Oct 2026', debit: 2000, credit: 0 },
      { customer: '', type: 'transfer_fund', entityId: 'x1', date: '02 Oct 2026', debit: 0, credit: 2000 }
    ]
  },
  cogsLines: [
    { customer: '1', type: 'expense', entityId: 'g1', reference: 'EXP-1', date: '06 Oct 2026', debit: 500, credit: 0, tagged: true },
    { customer: '2', type: 'expense', entityId: 'g2', reference: 'EXP-2', date: '07 Oct 2026', debit: 300, credit: 0, tagged: true },
    { customer: '', type: 'expense', entityId: 'g3', reference: 'EXP-3', date: '08 Oct 2026', debit: 100, credit: 0, tagged: false }
  ],
  funded: { 1: 6000 }, names: { 1: 'Alpha LLC', 2: 'Beta FZE' },
  config: { cfd: CFD, cogs: COGS },
  ...patch
});
const A = (r, id) => r.accounts.find(x => x.id === id);
const F = (r, id, code) => A(r, id).findings.find(f => f.code === code);

describe('reviewChartOfAccounts', () => {
  test('balances on the natural side, with Dr / Cr', () => {
    const r = coa({});
    assert.equal(A(r, CFD).balance, 700);
    assert.equal(A(r, CFD).balanceText, 'AED 700.00 Cr');
    assert.equal(A(r, BANK).balance, 70000);
    assert.equal(A(r, BANK).status, 'EXPECTED');
    assert.equal(A(r, DOE).balance, -497.8);
    assert.equal(A(r, DOE).balanceText, 'AED 497.80 Cr');
  });
  test('Disbursements Of Expenses must be zero: traced to the one open entry', () => {
    const r = coa({}), d = A(r, DOE), f = F(r, DOE, 'ZERO_BALANCE');
    assert.equal(d.zeroRequired, true);
    assert.equal(d.status, 'UNEXPECTED');
    assert.match(f.issue, /Must be zero but holds AED 497\.80 Cr/);
    assert.match(f.detail, /Likely cause: Invoice INV-3 \(05 Oct 2026\) AED 497\.80 Cr/);
    assert.equal(f.cause, 'Missing settlement');
    assert.match(f.fix, /more was recharged than was paid out/);
    assert.equal(d.trace.openCount, 1);
    assert.equal(d.trace.open[0].client, 'Beta FZE');
    assert.equal(d.trace.open[0].likely, true);
    assert.ok(!F(r, DOE, 'NEGATIVE'), 'a zero-balance breach is not reported twice as negative');
  });
  test('a cleared clearing account and the client fund account are expected', () => {
    const r = coa({});
    assert.equal(A(r, STRIPE).zeroRequired, true);
    assert.equal(A(r, STRIPE).status, 'EXPECTED');
    assert.equal(A(r, CFD).zeroRequired, false, 'Customers Fund Disbursement is never a zero-balance account');
    assert.ok(F(r, CFD, 'MISSING_TAGS'), 'an untagged CFD line is listed');
    assert.equal(A(r, CFD).status, 'EXPECTED');
    assert.equal(A(r, 's1').zeroRequired, true);
    assert.equal(A(r, 's1').status, 'EXPECTED');
  });
  test('client costs under COGS: reallocation journal for funded clients, review for the rest', () => {
    const r = coa({}), c = A(r, COGS);
    assert.equal(c.status, 'UNEXPECTED');
    assert.equal(r.summary.cogsRealloc.count, 1);
    assert.equal(r.summary.cogsRealloc.amount, 500);
    assert.equal(r.reallocation.entries[0].instruction, 'Journal dated 06 Oct 2026: Dr Customers Fund Disbursement Account AED 500.00 (customer: Alpha LLC) / Cr Cost of Goods Sold-Clients Payments AED 500.00 (customer: Alpha LLC) — reference EXP-1.');
    assert.equal(r.reallocation.unfunded[0].client, 'Beta FZE');
    assert.equal(r.reallocation.untagged.length, 1);
    assert.ok(F(r, COGS, 'COGS_UNTAGGED'));
  });
  test('negative balances: a bank wallet is flagged, a contra income account is not', () => {
    const r = coa({}), w = F(r, 'w1', 'NEGATIVE');
    assert.match(w.issue, /Negative balance: AED 53\.33 Cr on an asset account/);
    assert.match(w.fix, /Reconcile Alaan-Admin Wallet-Carmen Card with its statement/);
    assert.equal(A(r, 'd1').contra, true);
    assert.equal(A(r, 'd1').status, 'EXPECTED');
    assert.equal(r.summary.negative, 1);
  });
  test('an inactive account with a balance', () => assert.ok(F(coa({}), 'o1', 'INACTIVE_BALANCE')));
  test('a negative balance under AED 1 is a rounding difference (MEYDAN REFERRAL −0.21)', () => {
    const r = coa({ accounts: [acct('m1', 'MEYDAN REFERRAL', 'Other Current Asset', 'Asset')], movements: [mv('m1', 'journal', 12054, 12054.21, 6)] });
    const f = F(r, 'm1', 'NEGATIVE');
    assert.equal(f.cause, 'Rounding difference');
    assert.match(f.fix, /Clear the AED 0\.21 rounding difference/);
  });
  test('configured zero accounts and exclusions', () => {
    assert.equal(A(coa({ config: { cfd: CFD, cogs: COGS, zeroIds: [BANK] } }), BANK).status, 'UNEXPECTED');
    assert.equal(A(coa({ config: { cfd: CFD, cogs: COGS, notZeroIds: [DOE] } }), DOE).zeroRequired, false);
  });
  test('summary and order: unexpected accounts first', () => {
    const r = coa({});
    assert.equal(r.summary.accounts, 9);
    assert.equal(r.summary.zeroBreached, 1);
    assert.ok(r.accounts.findIndex(x => x.status === 'EXPECTED') > r.accounts.findLastIndex(x => x.status === 'UNEXPECTED'));
  });
});

describe('openEntries', () => {
  test('pairs equal debits and credits, nearest date first', () => {
    const open = openEntries([
      { date: '01 Oct 2026', debit: 100, credit: 0 }, { date: '02 Oct 2026', debit: 100, credit: 0 },
      { date: '03 Oct 2026', debit: 0, credit: 100 }, { date: '04 Oct 2026', debit: 0, credit: 40 }
    ]);
    assert.deepEqual(open.map(e => [e.date, e.net]), [['04 Oct 2026', -40], ['02 Oct 2026', 100]]);
  });
});
