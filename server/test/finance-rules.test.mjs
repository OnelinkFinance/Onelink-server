// Unit tests for finance-rules.js (pure decision logic of the three financial checks).
// Run: node --test test/finance-rules.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFinance, financeForOps, OPS_INSUFFICIENT, CHECKS, PAID_OK } from '../finance-rules.js';

// A client that passes everything; each test breaks one thing.
const good = () => ({
  amount: 5000,
  paid: 'Yes — in full',
  books: { contactId: '1', contactName: 'Alpha', status: 'active', outstanding: 0 },
  rec: { available: 20000, allocated: 30000, used: 10000, status: 'Positive', alert: '' },
  split: { cfd: { credits: 30000, debits: 10000, lines: 4, untagged: 0 }, cogs: { credits: 0, debits: 8000, lines: 3, untagged: 0 } },
  open: [],
  pay: { payments: 2, received: 30000, unapplied: 0, refunded: 0, last: '07 Oct 2026' }
});
const run = patch => evaluateFinance({ inv: { invoices: 1, invoiced: 30000, outstanding: 0, writtenOff: 0, paid: 30000, credited: 0 }, ...good(), ...patch });
// The live Books contact decides whether anything is owed; a test with open invoices gives it a matching receivable.
const owing = n => ({ books: { contactId: '1', contactName: 'Alpha', status: 'active', outstanding: n } });
const chk = (f, key) => f.checks.find(c => c.key === key);
const itm = (f, key, label) => chk(f, key).items.find(i => i.label === label);
const AMOUNT_RE = /AED|\d[\d,]*\.\d\d/;
const walk = (o, fn, p = '') => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { fn(k, v, p + '.' + k); walk(v, fn, p + '.' + k); } };

describe('evaluateFinance — shape', () => {
  test('all pass: three checks in order, ok, no failed, no headline', () => {
    const f = run({});
    assert.deepEqual(f.checks.map(c => c.key), ['CFD', 'COGS', 'INVOICES']);
    assert.deepEqual(f.checks.map(c => c.label), [CHECKS.CFD, CHECKS.COGS, CHECKS.INVOICES]);
    assert.equal(f.ok, true);
    assert.deepEqual(f.failed, []);
    assert.equal(f.opsError, '');
    assert.equal(f.staffError, '');
    assert.equal(f.amount, 5000);
    for (const c of f.checks) { assert.equal(c.ok, true, c.key); assert.ok(c.items.every(i => i.ok), c.key); }
    assert.equal(chk(f, 'CFD').code, 'CFD_OK');
    assert.equal(chk(f, 'COGS').code, 'COGS_OK');
    assert.equal(chk(f, 'INVOICES').code, 'INVOICES_OK');
    assert.match(itm(f, 'INVOICES', 'Customer payment received in Zoho Books').text, /2 payments on file, last on 07 Oct 2026/);
  });
  test('messages and item texts are amount-free; details carry the figures', () => {
    for (const patch of [{}, { rec: null }, { amount: 999999 }, { ...owing(100), open: [{ invoice: 'INV-1', balance: 100, status: 'Overdue' }] }, { pay: null }, { committed: { amount: 19000, count: 1 } }]) {
      const f = run(patch);
      for (const c of f.checks) {
        assert.doesNotMatch(c.message, AMOUNT_RE, c.key + ' message: ' + c.message);
        for (const i of c.items) assert.doesNotMatch(i.text, AMOUNT_RE, c.key + ' / ' + i.label + ': ' + i.text);
        assert.match(c.detail, /AED/);
      }
      for (const x of f.failed) assert.doesNotMatch(x.message, AMOUNT_RE);
      assert.doesNotMatch(f.opsError, AMOUNT_RE);
    }
  });
  test('items without detail carry no detail key', () => {
    const f = run({});
    for (const c of f.checks) for (const i of c.items) if ('detail' in i) assert.ok(i.detail, c.key + '/' + i.label);
    assert.ok(!('detail' in itm(f, 'CFD', 'Client record in the CFD ledger')));
    assert.ok(!('detail' in itm(f, 'COGS', 'No negative-balance alert')));
  });
});

describe('A — CFD', () => {
  test('no record → fails, CFD_NO_RECORD, both items fail', () => {
    const f = run({ rec: null });
    const c = chk(f, 'CFD');
    assert.equal(c.ok, false); assert.equal(c.code, 'CFD_NO_RECORD');
    assert.equal(itm(f, 'CFD', 'Client record in the CFD ledger').ok, false);
    assert.equal(itm(f, 'CFD', 'Client record in the CFD ledger').text, 'No Customer Fund Disbursement record for this client');
    assert.equal(itm(f, 'CFD', 'Available balance covers the request').ok, false);
    assert.equal(c.message, 'Client does not have sufficient balance to request funds.');
    assert.equal(f.opsError, OPS_INSUFFICIENT);
  });
  test('insufficient → CFD_INSUFFICIENT, opsError is exactly OPS_INSUFFICIENT', () => {
    const f = run({ rec: { available: 4999.99, allocated: 5000, used: 0.01, status: '', alert: '' } });
    const c = chk(f, 'CFD');
    assert.equal(c.ok, false); assert.equal(c.code, 'CFD_INSUFFICIENT');
    assert.equal(itm(f, 'CFD', 'Available balance covers the request').text, 'Not sufficient');
    assert.equal(f.ok, false);
    assert.equal(f.opsError, 'Client does not have sufficient balance to request funds. Please contact Sven.');
    assert.deepEqual(f.failed.map(x => x.key), ['CFD']);
    assert.match(f.staffError, /AED 4,999\.99/);
  });
  test('zero / negative balance fails even for tiny amounts', () => {
    assert.equal(chk(run({ amount: 0.001, rec: { available: 0, allocated: 0, used: 0 } }), 'CFD').ok, false);
    assert.equal(chk(run({ amount: 1, rec: { available: -50, allocated: 0, used: 50 } }), 'CFD').ok, false);
  });
  test('exact amount passes (and within the 0.005 epsilon)', () => {
    assert.equal(chk(run({ amount: 20000 }), 'CFD').ok, true);
    assert.equal(chk(run({ amount: 20000.004 }), 'CFD').ok, true);
    assert.equal(chk(run({ amount: 20000.01 }), 'CFD').ok, false);
  });
  test('CFD failure together with other failures still uses OPS_INSUFFICIENT', () => {
    const f = run({ rec: null, paid: 'No' });
    assert.deepEqual(f.failed.map(x => x.key), ['CFD', 'COGS', 'INVOICES'].filter(k => f.failed.some(x => x.key === k)));
    assert.ok(f.failed.length >= 2);
    assert.equal(f.opsError, OPS_INSUFFICIENT);
  });
});

describe('B — COGS', () => {
  test('no payment into CFD → COGS_NO_PAYMENT', () => {
    const f = run({ split: { cfd: { credits: 0, debits: 0, lines: 0, untagged: 0 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } } });
    const c = chk(f, 'COGS');
    assert.equal(c.ok, false); assert.equal(c.code, 'COGS_NO_PAYMENT');
    assert.equal(c.message, 'No client payment recorded in the CFD account.');
  });
  test('no split entries falls back to the balance record credits', () => {
    const f = run({ split: null });
    assert.equal(itm(f, 'COGS', 'Client payment received').ok, true);
    assert.equal(itm(f, 'COGS', 'COGS entries on file').text, 'No COGS entry yet — first disbursement for this client');
    const g = run({ split: null, rec: null });
    assert.equal(chk(g, 'COGS').code, 'COGS_NO_PAYMENT');
  });
  test('COGS exceeds payments → COGS_EXCEEDS_PAYMENTS', () => {
    const f = run({ split: { cfd: { credits: 30000, debits: 0, lines: 1, untagged: 0 }, cogs: { credits: 100, debits: 30100.01, lines: 2, untagged: 0 } } });
    const c = chk(f, 'COGS');
    assert.equal(c.ok, false); assert.equal(c.code, 'COGS_EXCEEDS_PAYMENTS');
    assert.equal(c.message, 'Costs booked to COGS exceed what the client paid.');
    // exactly covered passes
    assert.equal(chk(run({ split: { cfd: { credits: 30000, debits: 0, lines: 1, untagged: 0 }, cogs: { credits: 0, debits: 30000, lines: 2, untagged: 0 } } }), 'COGS').ok, true);
  });
  test('untagged entries → COGS_UNMAPPED with singular/plural wording', () => {
    const one = run({ split: { cfd: { credits: 30000, debits: 0, lines: 1, untagged: 1 }, cogs: { credits: 0, debits: 10, lines: 1, untagged: 0 } } });
    assert.equal(chk(one, 'COGS').code, 'COGS_UNMAPPED');
    assert.equal(chk(one, 'COGS').message, '1 entry is matched only by reference — not tagged to the client in Zoho Books.');
    const three = run({ split: { cfd: { credits: 30000, debits: 0, lines: 1, untagged: 1 }, cogs: { credits: 0, debits: 10, lines: 1, untagged: 2 } } });
    assert.match(chk(three, 'COGS').message, /^3 entries are matched only by reference/);
  });
  test('negative-balance alert → COGS_ALERT, alert only in detail', () => {
    const f = run({ rec: { available: 20000, allocated: 30000, used: 10000, status: 'Negative', alert: 'NEGATIVE BALANCE AED -500' } });
    const c = chk(f, 'COGS');
    assert.equal(c.ok, false); assert.equal(c.code, 'COGS_ALERT');
    const i = itm(f, 'COGS', 'No negative-balance alert');
    assert.equal(i.text, 'Zoho Analytics flags a negative balance for this client');
    assert.equal(i.detail, 'NEGATIVE BALANCE AED -500');
  });
  test('first disbursement (no COGS lines) passes', () => {
    const f = run({ split: { cfd: { credits: 30000, debits: 0, lines: 1, untagged: 0 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } } });
    assert.equal(chk(f, 'COGS').ok, true);
    assert.equal(itm(f, 'COGS', 'COGS entries on file').text, 'No COGS entry yet — first disbursement for this client');
    assert.equal(itm(run({}), 'COGS', 'COGS entries on file').text, '3 COGS entries for this client');
  });
  test('opsError for a COGS-only failure names the check, no OPS_INSUFFICIENT', () => {
    const f = run({ split: { cfd: { credits: 0, debits: 0, lines: 0, untagged: 0 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } } });
    assert.deepEqual(f.failed.map(x => x.key), ['COGS']);
    assert.equal(f.opsError, 'The request cannot be submitted — Cost of Goods Sold account check failed. You can escalate it to management.');
  });
});

describe('C — invoices', () => {
  test('declared unpaid / partial / blank → DECLARED_UNPAID', () => {
    for (const paid of ['No', 'Partially', 'Partial payment', '']) {
      const f = run({ paid });
      assert.equal(chk(f, 'INVOICES').code, 'DECLARED_UNPAID', paid);
      assert.equal(chk(f, 'INVOICES').ok, false);
    }
    assert.equal(itm(run({ paid: '' }), 'INVOICES', 'Operations: client already paid us?').text, 'Operations did not answer');
    for (const paid of PAID_OK) assert.equal(chk(run({ paid }), 'INVOICES').ok, true, paid);
    assert.equal(chk(run({ paid: '  Yes — in full  ' }), 'INVOICES').ok, true);
  });
  test('no customer payment → NO_CUSTOMER_PAYMENT', () => {
    assert.equal(chk(run({ pay: null }), 'INVOICES').code, 'NO_CUSTOMER_PAYMENT');
    assert.equal(chk(run({ pay: { payments: 1, received: 0, unapplied: 0, refunded: 0 } }), 'INVOICES').code, 'NO_CUSTOMER_PAYMENT');
    assert.equal(chk(run({ pay: null }), 'INVOICES').message, 'No customer payment recorded in Zoho Books.');
  });
  test('unapplied payment with dues → PAYMENT_NOT_APPLIED; without dues passes', () => {
    const f = run({ ...owing(500), pay: { payments: 2, received: 30000, unapplied: 500, refunded: 0 }, open: [{ invoice: 'INV-9', balance: 500, status: 'Sent' }] });
    assert.equal(chk(f, 'INVOICES').code, 'PAYMENT_NOT_APPLIED');
    assert.equal(chk(f, 'INVOICES').message, 'A payment is recorded but not applied to the open invoice.');
    assert.equal(chk(run({ pay: { payments: 2, received: 30000, unapplied: 500, refunded: 0 } }), 'INVOICES').ok, true);
  });
  test('outstanding open invoices → OUTSTANDING_DUES, list capped at five numbers', () => {
    const open = Array.from({ length: 7 }, (_, i) => ({ invoice: 'INV-' + (i + 1), balance: 10, status: 'Overdue' }));
    const f = run({ ...owing(70), open });
    assert.equal(chk(f, 'INVOICES').code, 'OUTSTANDING_DUES');
    assert.equal(chk(f, 'INVOICES').message, '7 invoices are unpaid or overdue (INV-1, INV-2, INV-3, INV-4, INV-5, …).');
    const one = run({ ...owing(10), open: [{ invoice: 'INV-1', balance: 10 }] });
    assert.equal(chk(one, 'INVOICES').message, '1 invoice is unpaid or overdue (INV-1).');
  });
  test('live Books receivable only → OUTSTANDING_DUES', () => {
    const f = run({ books: { contactId: '1', contactName: 'Alpha', status: 'active', outstanding: 12.5 } });
    assert.equal(chk(f, 'INVOICES').code, 'OUTSTANDING_DUES');
    assert.equal(chk(f, 'INVOICES').message, 'Zoho Books shows an outstanding receivable for this client.');
    assert.match(itm(f, 'INVOICES', 'No outstanding dues').detail, /AED 12\.50/);
  });
  test('refund without dues passes', () => {
    assert.equal(chk(run({ pay: { payments: 2, received: 30000, unapplied: 0, refunded: 400 } }), 'INVOICES').ok, true);
  });
  test('refund with dues: the refund item fails', () => {
    const f = run({ ...owing(400), pay: { payments: 2, received: 30000, unapplied: 0, refunded: 400 }, open: [{ invoice: 'INV-3', balance: 400 }] });
    assert.equal(chk(f, 'INVOICES').ok, false);
    assert.equal(itm(f, 'INVOICES', 'No reversed or deleted payments').ok, false);
    assert.equal(itm(f, 'INVOICES', 'No reversed or deleted payments').text, 'A refund was recorded while invoices are still unpaid');
  });
  test('refund with dues is reported as PAYMENT_REVERSED (code is reachable)', () => {
    const f = run({ ...owing(400), pay: { payments: 2, received: 30000, unapplied: 0, refunded: 400 }, open: [{ invoice: 'INV-3', balance: 400 }] });
    assert.equal(chk(f, 'INVOICES').code, 'PAYMENT_REVERSED');
    assert.equal(chk(f, 'INVOICES').message, 'A refund was recorded while invoices are still unpaid.');
  });
  test('stale Analytics invoice but the live Books receivable is 0 → paid, passes', () => {
    const f = run({ open: [{ invoice: 'INV-1', balance: 750, status: 'Overdue' }] }); // good() has outstanding 0 live
    assert.equal(chk(f, 'INVOICES').ok, true);
    assert.equal(itm(f, 'INVOICES', 'No outstanding dues').text, 'No unpaid or overdue invoices');
  });
  test('invoices marked paid without a matching payment or credit note → INVOICE_PAYMENT_MISMATCH', () => {
    const inv = { invoices: 2, invoiced: 10000, outstanding: 0, writtenOff: 0, paid: 5000, credited: 0 };
    const f = run({ inv });
    assert.equal(chk(f, 'COGS').code, 'INVOICE_PAYMENT_MISMATCH');
    assert.equal(chk(f, 'COGS').message, 'Invoices are marked paid without a matching payment in Zoho Books.');
    assert.match(itm(f, 'COGS', 'Invoices match payments').detail, /unmatched AED 5,000\.00/);
    assert.equal(chk(run({ inv: { ...inv, credited: 5000 } }), 'COGS').ok, true);          // a credit note covers it
    assert.equal(chk(run({ inv: { ...inv, outstanding: 5000 } }), 'COGS').ok, true);       // still open → a due, not a mismatch
    assert.equal(chk(run({ inv: { ...inv, writtenOff: 4999.5 } }), 'COGS').ok, true);      // within AED 1
    assert.equal(chk(run({ inv: null }), 'COGS').ok, false);                               // could not be read → not passed
    assert.equal(itm(run({ inv: { invoices: 0, invoiced: 0, outstanding: 0, writtenOff: 0, paid: 0, credited: 0 } }), 'COGS', 'Invoices match payments').text, 'No invoices for this client yet');
  });
  test('a contact in a duplicate group: invoices of the other contacts count even when its own receivable is 0', () => {
    const open = [{ invoice: 'INV-5002', balance: 4200, status: 'Overdue' }];
    assert.equal(chk(run({ open, grouped: true }), 'INVOICES').code, 'OUTSTANDING_DUES');
    assert.equal(chk(run({ open, grouped: false }), 'INVOICES').ok, true); // single contact: the live receivable (0) decides
  });
  test('no live Books contact → the Analytics invoice list decides', () => {
    assert.equal(chk(run({ books: null, open: [{ invoice: 'INV-1', balance: 750 }] }), 'INVOICES').code, 'OUTSTANDING_DUES');
    assert.equal(chk(run({ books: null, open: [] }), 'INVOICES').ok, true);
  });
  test('amounts already approved on the platform are held against the CFD balance', () => {
    assert.equal(chk(run({ committed: { amount: 15000, count: 1 } }), 'CFD').ok, true);       // 20,000 − 15,000 = 5,000 ≥ 5,000
    const f = run({ committed: { amount: 15001, count: 2 } });
    assert.equal(chk(f, 'CFD').ok, false);
    assert.equal(chk(f, 'CFD').code, 'CFD_INSUFFICIENT');
    assert.match(itm(f, 'CFD', 'Available balance covers the request').detail, /ledger AED 20,000\.00 less AED 15,001\.00 already approved on 2 requests/);
    assert.equal(f.opsError, OPS_INSUFFICIENT);
  });
  test('opsError for two non-CFD failures uses "checks" plural', () => {
    const f = run({ paid: 'No', split: { cfd: { credits: 0, debits: 0, lines: 0, untagged: 0 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } } });
    assert.equal(f.opsError, 'The request cannot be submitted — Cost of Goods Sold account and Invoice payment verification checks failed. You can escalate it to management.');
    assert.deepEqual(f.failed.map(x => x.key), ['COGS', 'INVOICES']);
    assert.match(f.staffError, /^Cost of Goods Sold account: .*Invoice payment verification: /);
  });
});

describe('financeForOps', () => {
  test('strips every detail (check and item level) and keeps messages', () => {
    const f = run({ rec: { available: 100, allocated: 30000, used: 10000, alert: 'ALERT AED 5' }, open: [{ invoice: 'I1', balance: 5 }], pay: { payments: 1, received: 1, unapplied: 3, refunded: 2 } });
    const o = financeForOps(f);
    walk(o.checks, (k, v, p) => assert.notEqual(k, 'detail', 'detail left at ' + p));
    assert.deepEqual(o.checks.map(c => c.message), f.checks.map(c => c.message));
    assert.deepEqual(o.checks.map(c => c.items.map(i => i.text)), f.checks.map(c => c.items.map(i => i.text)));
    walk(o.checks, (k, v, p) => { if (typeof v === 'string') assert.doesNotMatch(v, /AED/, p); });
    // the input is not mutated
    assert.ok(f.checks[0].detail);
  });
  test('passes through null / non-objects', () => {
    assert.equal(financeForOps(null), null);
    assert.equal(financeForOps(undefined), undefined);
  });
});
