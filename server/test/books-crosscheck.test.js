// Unit tests for the Zoho Books cross-verification (finance-rules.js: evaluateBooksCrossCheck, parseDay,
// crossCheckWindow) and the Operations copy of a finance result (financeForOps).
// Run: node --test test/books-crosscheck.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBooksCrossCheck, parseDay, crossCheckWindow, financeForOps, CROSS_CHECKS, BOOKS_FAIL, OPS_INSUFFICIENT } from '../finance-rules.js';

const CFD = 'CFD-ACC', COGS = 'COGS-ACC', DAY = '2026-10-09';
const ok = rows => ({ ok: true, rows, truncated: false });
const down = { ok: false, rows: null, error: 'Zoho Books 503' };
// Analytics: AED 3,000 in CFD; the request is AED 5,000. Books: the two synced lines plus whatever the test adds.
function base(patch = {}) {
  const a = {
    amount: 5000, paid: 'Yes — in full', committed: { amount: 0, count: 0 },
    contact: { contactId: '11', contactName: 'Acme Trading', companyName: 'Acme Trading FZCO', outstanding: 0 },
    rec: { available: 3000, allocated: 4000, used: 1000, status: 'Low', alert: '' },
    split: { cfd: { credits: 4000, debits: 1000, lines: 2, untagged: 0 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } },
    inv: { invoices: 0, invoiced: 0, outstanding: 0, writtenOff: 0, paid: 0, credited: 0 },
    pay: { payments: 1, received: 4000, unapplied: 0, refunded: 0 },
    ids: ['11'], names: ['Acme Trading', 'Acme Trading FZCO'], accounts: { cfd: CFD, cogs: COGS },
    recent: { lines: [
      { customer: '11', account: CFD, entityId: 'E1', txnId: 'T1', type: 'journal', credit: 4000, debit: 0, date: DAY },
      { customer: '11', account: CFD, entityId: 'E2', txnId: 'T2', type: 'expense', credit: 0, debit: 1000, date: DAY },
      { customer: '99', account: CFD, entityId: 'E9', txnId: 'T9', type: 'expense', credit: 7000, debit: 0, date: DAY }
    ], watermark: DAY + ' 09:03' },
    windowStart: '2026-10-07',
    books: {
      cfdTx: ok([
        { transaction_id: 'T1', transaction_type: 'journal', transaction_date: DAY, customer_id: '11', credit_amount: 4000, debit_amount: 0 },
        { transaction_id: 'T2', transaction_type: 'expense', transaction_date: DAY, customer_id: '11', credit_amount: 0, debit_amount: 1000 },
        { transaction_id: 'T9', transaction_type: 'expense', transaction_date: DAY, customer_id: '99', credit_amount: 7000, debit_amount: 0 }
      ]),
      cogsTx: ok([]), creditnotes: ok([]), invoices: ok([]),
      payments: ok([{ payment_id: 'P1', amount: 4000, unused_amount: 0 }]),
      journals: { ok: true, rows: [], truncated: false, details: {} }
    }
  };
  return { ...a, ...patch, books: { ...a.books, ...(patch.books || {}) } };
}
const plus = (extra, patch = {}) => base({ ...patch, books: { cfdTx: ok(base().books.cfdTx.rows.concat(extra)), ...(patch.books || {}) } });
const credit = (id, amount, more = {}) => ({ transaction_id: id, transaction_type: 'deposit', transaction_date: DAY, customer_id: '11', credit_amount: amount, debit_amount: 0, ...more });
const chk = (f, k) => f.checks.find(c => c.key === k);
const AMOUNT_RE = /AED|\d[\d,]*\.\d\d/;

describe('evaluateBooksCrossCheck — shape and balance', () => {
  test('five checks in order; Analytics alone is short → insufficient, Operations headline', () => {
    const f = evaluateBooksCrossCheck(base());
    assert.deepEqual(f.checks.map(c => c.key), ['CFD', 'COGS', 'NOTES', 'JOURNALS', 'INVOICES']);
    assert.deepEqual(f.checks.map(c => c.label), Object.values(CROSS_CHECKS));
    assert.equal(chk(f, 'CFD').code, 'CFD_INSUFFICIENT');
    assert.equal(f.available, 3000);
    assert.equal(f.opsError, OPS_INSUFFICIENT);
    assert.deepEqual(f.failed.map(x => x.key), ['CFD']);
  });
  test('an unsynced Books credit for the client covers the request → all five pass', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500)]));
    assert.equal(f.ok, true, f.staffError);
    assert.equal(f.available, 5500);
    assert.match(chk(f, 'CFD').items[0].detail, /1 unsynced Books movement AED 2,500\.00/);
  });
  test('a synced entity is compared, never counted twice (found by Transaction ID or by Entity ID)', () => {
    const viaEntity = evaluateBooksCrossCheck(plus([credit('X', 2500, { categorized_transaction_id: 'E9' })]));
    assert.equal(viaEntity.available, 3000, 'E9 is another customer\'s entity in Analytics — never money for this client');
    const same = evaluateBooksCrossCheck(base({ books: { cfdTx: ok(base().books.cfdTx.rows.map(t => ({ ...t, transaction_id: '', categorized_transaction_id: t.transaction_id === 'T1' ? 'E1' : t.transaction_id }))) } }));
    assert.equal(same.available, 3000, 'matched through the Entity ID: unchanged');
    const added = evaluateBooksCrossCheck(plus([credit('T1', 2500)]));
    assert.equal(added.available, 5500, 'a credit line tagged to the client added to a synced entity counts');
  });
  test('a movement tagged to another customer is never this client\'s, whatever its text says', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500, { customer_id: '42', description: 'Payment for Acme Trading' })]));
    assert.equal(f.available, 3000);
    assert.equal(chk(f, 'CFD').ok, false);
  });
  test('an untagged movement matched by name never adds money, counts as untagged, and its debits still count', () => {
    const named = evaluateBooksCrossCheck(plus([credit('T3', 2500, { customer_id: '', description: 'Deposit ACME trading fzco 12/10' })]));
    assert.equal(named.available, 3000, 'credit matched only by name is not counted');
    assert.equal(chk(named, 'COGS').code, 'COGS_UNMAPPED');
    const debit = evaluateBooksCrossCheck(plus([credit('T3', 6000), { transaction_id: 'T4', customer_id: '', payee: 'Acme Trading', transaction_date: DAY, debit_amount: 1500, credit_amount: 0 }]));
    assert.equal(debit.available, 7500, '3,000 + 6,000 tagged − 1,500 name-matched debit');
    const partial = evaluateBooksCrossCheck(plus([credit('T3', 2500, { customer_id: undefined, payee: 'Acme Tradingworks' })]));
    assert.equal(partial.available, 3000, 'no match inside another word');
    const short = evaluateBooksCrossCheck(plus([credit('T3', 2500, { customer_id: '', payee: 'Acme' })], { names: ['Acme'] }));
    assert.equal(short.available, 3000, 'names under five characters never match');
  });
  test('an alias contact of the client counts (ids)', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500, { customer_id: '12' })], { ids: ['11', '12'] }));
    assert.equal(f.available, 5500);
  });
  test('unsynced debits reduce the balance', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 4000), { transaction_id: 'T4', customer_id: '11', transaction_date: DAY, debit_amount: 1500, credit_amount: 0 }]));
    assert.equal(f.available, 5500);
  });
  test('an Analytics line deleted in Books comes off (only within the Books window)', () => {
    const rows = base().books.cfdTx.rows.filter(t => t.transaction_id !== 'T1');
    const f = evaluateBooksCrossCheck(base({ books: { cfdTx: ok(rows.concat(credit('T3', 6000))) } }));
    assert.equal(f.available, 5000, '3,000 − 4,000 deleted + 6,000 unsynced');
    assert.equal(chk(f, 'JOURNALS').code, 'JOURNAL_MISMATCH', 'the deleted line was a journal');
    const old = base({ windowStart: '2026-10-10', books: { cfdTx: ok(rows) } });
    assert.equal(evaluateBooksCrossCheck(old).available, 3000, 'a line older than the window is not judged');
  });
  test('the Analytics ledger is the lower of the balance table and the ledger lines', () => {
    assert.equal(evaluateBooksCrossCheck(base({ rec: { available: 9000, allocated: 9000, used: 0, alert: '' } })).available, 3000);
    assert.equal(evaluateBooksCrossCheck(base({ split: { cfd: { credits: 9000, debits: 0, lines: 1, untagged: 0 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } } })).available, 3000);
  });
  test('no Analytics record: Books movements alone may cover a new client; otherwise CFD_NO_RECORD', () => {
    const none = base({ rec: null, split: null, recent: { lines: [], watermark: null }, books: { cfdTx: ok([]) } });
    assert.equal(chk(evaluateBooksCrossCheck(none), 'CFD').code, 'CFD_NO_RECORD');
    const paidIn = base({ rec: null, split: null, recent: { lines: [], watermark: null }, books: { cfdTx: ok([credit('T3', 6000)]) } });
    const f = evaluateBooksCrossCheck(paidIn);
    assert.equal(chk(f, 'CFD').ok, true);
    assert.equal(chk(f, 'COGS').ok, true, 'the unsynced credit is the payment received');
  });
  test('amounts already approved on the platform are held', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500)], { committed: { amount: 600, count: 1 } }));
    assert.equal(f.available, 4900);
    assert.equal(chk(f, 'CFD').ok, false);
  });
  test('an open credit note adds; one already posted to the ledger does not; a debit note reduces', () => {
    const cn = (id, status = 'open', balance = 2500) => ({ creditnote_id: id, creditnote_number: 'CN-' + id, status, balance, total: balance });
    assert.equal(evaluateBooksCrossCheck(base({ books: { creditnotes: ok([cn('C1')]) } })).available, 5500);
    assert.equal(evaluateBooksCrossCheck(base({ books: { creditnotes: ok([cn('E1')]) } })).available, 3000, 'E1 is an Analytics line — already in the balance');
    assert.equal(evaluateBooksCrossCheck(base({ books: { creditnotes: ok([cn('C1', 'closed')]) } })).available, 3000);
    const byNumber = base({ books: { creditnotes: ok([cn('C1')]), cfdTx: ok(base().books.cfdTx.rows.concat(credit('X7', 2500, { transaction_type: 'creditnote', reference_number: 'cn-c1' }))) } });
    assert.equal(evaluateBooksCrossCheck(byNumber).available, 5500, 'posted to CFD under another id: counted once (as the movement), not again as an open balance');
    assert.equal(evaluateBooksCrossCheck(base({ books: { creditnotes: ok([cn('C1', 'open', 'n/a')]) } })).available, 3000, 'an unknown balance is never added');
    const dn = evaluateBooksCrossCheck(base({ books: { creditnotes: ok([cn('C1', 'open', 4000)]), invoices: ok([{ invoice_id: 'D1', invoice_number: 'DN-1', type: 'debit_note', status: 'sent', balance: 1000 }]) } }));
    assert.equal(dn.available, 6000);
  });
  test('Books amounts missing on an unsynced movement → not completed, never counted', () => {
    const f = evaluateBooksCrossCheck(plus([{ transaction_id: 'T3', customer_id: '11', transaction_date: DAY }]));
    assert.equal(chk(f, 'CFD').code, 'BOOKS_UNAVAILABLE');
    assert.equal(chk(f, 'CFD').message, BOOKS_FAIL + '.');
    assert.equal(f.available, null);
  });
});

describe('evaluateBooksCrossCheck — edits after the sync (reviewer scenarios)', () => {
  const B = () => base().books.cfdTx.rows;
  const T3 = credit('T3', 2500);
  test('one untagged row naming two clients passes neither', () => {
    const row = { transaction_id: 'T3', transaction_type: 'deposit', transaction_date: DAY, customer_id: '', description: 'Acme Trading transfer to Beta Global', credit_amount: 2500, debit_amount: 0 };
    const acme = evaluateBooksCrossCheck(base({ books: { cfdTx: ok(B().concat(row)) } }));
    const beta = evaluateBooksCrossCheck(base({ contact: { contactId: '12', contactName: 'Beta Global', companyName: 'Beta Global LLC', outstanding: 0 }, ids: ['12'], names: ['Beta Global'],
      recent: { lines: base().recent.lines.map(l => ({ ...l, customer: l.customer === '11' ? '12' : l.customer })), watermark: DAY }, books: { cfdTx: ok(B().map(t => ({ ...t, customer_id: t.customer_id === '11' ? '12' : t.customer_id })).concat(row)) } }));
    for (const f of [acme, beta]) { assert.equal(f.ok, false); assert.equal(f.available, 3000); }
  });
  test('a synced credit edited down in Books comes off', () => {
    const f = evaluateBooksCrossCheck(base({ books: { cfdTx: ok([{ ...B()[0], credit_amount: 400 }, B()[1], B()[2], T3]) } }));
    assert.equal(f.available, 1900);
    assert.match(chk(f, 'CFD').items[0].detail, /E1: Analytics AED 4,000\.00, Books AED 400\.00, counted AED -3,600\.00/);
  });
  test('a synced credit re-tagged to another customer comes off', () => {
    assert.equal(evaluateBooksCrossCheck(base({ books: { cfdTx: ok([{ ...B()[0], customer_id: '99' }, B()[1], B()[2], T3]) } })).available, 1500);
  });
  test('a debit line added to a synced journal comes off; JOURNALS lists the change', () => {
    const f = evaluateBooksCrossCheck(base({ books: { cfdTx: ok(B().concat({ transaction_id: 'T1', transaction_type: 'journal', transaction_date: DAY, customer_id: '11', credit_amount: 0, debit_amount: 3000 }, T3)) } }));
    assert.equal(f.available, 2500);
    assert.match(chk(f, 'JOURNALS').items[1].detail, /E1 changed/);
  });
  test('an Analytics debit re-tagged to this client from another customer never adds money; an increase partly from a name match is capped', () => {
    const toUs = evaluateBooksCrossCheck(base({ books: { cfdTx: ok(B().map(t => t.transaction_id === 'T9' ? { ...t, customer_id: '11' } : t)) } }));
    assert.equal(toUs.available, 3000, 'E9 belongs to customer 99 in Analytics');
    const mixed = evaluateBooksCrossCheck(base({ books: { cfdTx: ok(B().concat({ transaction_id: 'T1', customer_id: '', payee: 'Acme Trading', transaction_date: DAY, credit_amount: 900, debit_amount: 0 })) } }));
    assert.equal(mixed.available, 3000, 'the extra credit on a synced entity is matched only by name');
  });
  test('an unsynced row with no positive amount on either side is unknown → not completed', () => {
    const f = evaluateBooksCrossCheck(plus([{ transaction_id: 'T4', transaction_type: 'expense', transaction_date: DAY, customer_id: '11', credit_amount: 0, debit_amount: '', amount: 3000 }, T3]));
    assert.equal(chk(f, 'CFD').code, 'BOOKS_UNAVAILABLE');
    assert.equal(f.ok, false);
  });
  test('per-customer lists: rows of another customer are ignored', () => {
    const f = evaluateBooksCrossCheck(base({ books: {
      creditnotes: ok([{ creditnote_id: 'CN9', creditnote_number: 'CN-9', customer_id: '99', status: 'open', total: 2500, balance: 2500 }, { creditnote_id: 'CN8', customer_id: '99', status: 'draft', balance: 1 }]),
      invoices: ok([{ invoice_id: 'I9', customer_id: '99', type: 'invoice', status: 'overdue', balance: 50 }]),
      payments: ok([{ payment_id: 'P1', customer_id: '11', amount: 4000 }, { payment_id: 'P9', customer_id: '99', amount: 1 }]) } }));
    assert.equal(f.available, 3000, 'the other customer\'s credit note is not added');
    assert.equal(chk(f, 'NOTES').ok, true, 'nor its draft');
    assert.equal(chk(f, 'INVOICES').ok, true, 'nor its open invoice');
  });
});

describe('evaluateBooksCrossCheck — fail closed', () => {
  test('a Books source that failed fails exactly the checks that need it, with the ops-safe text', () => {
    const passing = { cfdTx: ok(base().books.cfdTx.rows.concat(credit('T3', 2500))) };
    const cases = { cfdTx: ['CFD', 'COGS', 'JOURNALS'], cogsTx: ['COGS', 'JOURNALS'], creditnotes: ['CFD', 'NOTES'], invoices: ['CFD', 'NOTES', 'INVOICES'], payments: ['INVOICES'], journals: ['JOURNALS'] };
    for (const [src, keys] of Object.entries(cases)) {
      const f = evaluateBooksCrossCheck(base({ books: { ...passing, [src]: down } }));
      assert.deepEqual(f.failed.map(x => x.key), keys, src);
      for (const k of keys) { assert.equal(chk(f, k).code, 'BOOKS_UNAVAILABLE', src + '/' + k); assert.equal(chk(f, k).message, BOOKS_FAIL + '.'); }
      assert.equal(f.ok, false);
      if (keys.includes('CFD')) assert.notEqual(f.opsError, OPS_INSUFFICIENT, 'an unreadable source is not "insufficient"');
    }
  });
  test('no Analytics recent lines → CFD, COGS and JOURNALS cannot be completed', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500)], { recent: null }));
    assert.deepEqual(f.failed.map(x => x.key), ['CFD', 'COGS', 'JOURNALS']);
  });
  test('truncated account transactions (more pages than one check reads) → not completed', () => {
    const f = evaluateBooksCrossCheck(base({ books: { cfdTx: { ...ok(base().books.cfdTx.rows.concat(credit('T3', 2500))), truncated: true } } }));
    assert.equal(chk(f, 'CFD').code, 'BOOKS_UNAVAILABLE');
  });
  test('truncated invoices / credit notes / journals → not completed', () => {
    const passing = base().books.cfdTx.rows.concat(credit('T3', 2500));
    assert.equal(chk(evaluateBooksCrossCheck(base({ books: { cfdTx: ok(passing), invoices: { ...ok([]), truncated: true } } })), 'INVOICES').code, 'BOOKS_UNAVAILABLE');
    assert.equal(chk(evaluateBooksCrossCheck(base({ books: { cfdTx: ok(passing), creditnotes: { ...ok([]), truncated: true } } })), 'NOTES').code, 'BOOKS_UNAVAILABLE');
    assert.equal(chk(evaluateBooksCrossCheck(base({ books: { cfdTx: ok(passing), journals: { ok: true, rows: [], truncated: true, details: {} } } })), 'JOURNALS').code, 'BOOKS_UNAVAILABLE');
  });
  test('a draft journal that was not inspected → not completed', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500)], { books: { journals: { ok: true, rows: [{ journal_id: 'J1', status: 'draft' }], truncated: false, details: {} } } }));
    assert.equal(chk(f, 'JOURNALS').code, 'BOOKS_UNAVAILABLE');
  });
});

describe('evaluateBooksCrossCheck — notes, journals, invoices', () => {
  const passing = extra => plus([credit('T3', 2500)], extra);
  test('a draft or pending credit / debit note fails NOTES', () => {
    const f = evaluateBooksCrossCheck(passing({ books: { creditnotes: ok([{ creditnote_id: 'C1', creditnote_number: 'CN-1', status: 'draft', balance: 10 }]) } }));
    assert.equal(chk(f, 'NOTES').code, 'NOTES_PENDING');
    assert.equal(chk(f, 'NOTES').message, '1 credit note in draft / pending approval.');
    const d = evaluateBooksCrossCheck(passing({ books: { invoices: ok([{ invoice_id: 'D1', type: 'debit_note', status: 'pending_approval', balance: 10 }]) } }));
    assert.equal(chk(d, 'NOTES').code, 'NOTES_PENDING');
    assert.equal(d.opsError, 'The request cannot be submitted — Credit notes / debit notes check failed. You can escalate it to management.');
  });
  test('a draft journal with a line for the client fails JOURNALS; one for someone else does not', () => {
    const j = (cust, desc) => ({ ok: true, rows: [{ journal_id: 'J1', entry_number: 'JE-1', status: 'draft' }], truncated: false, details: { J1: [{ customer_id: cust, description: desc }] } });
    assert.equal(chk(evaluateBooksCrossCheck(passing({ books: { journals: j('11') } })), 'JOURNALS').code, 'JOURNAL_PENDING');
    assert.equal(chk(evaluateBooksCrossCheck(passing({ books: { journals: j('', 'Accrual for Acme Trading') } })), 'JOURNALS').code, 'JOURNAL_PENDING');
    assert.equal(chk(evaluateBooksCrossCheck(passing({ books: { journals: j('42', 'Accrual for Acme Trading') } })), 'JOURNALS').ok, true);
  });
  test('unsynced journal movements are listed and pass', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500, { transaction_type: 'journal' })]));
    const it = chk(f, 'JOURNALS').items.find(i => i.label === 'Journal movements not yet in Zoho Analytics');
    assert.equal(it.text, '1 journal movement is counted from Zoho Books');
    assert.equal(chk(f, 'JOURNALS').ok, true);
  });
  test('a live open invoice fails CFD (unpaid disbursements) and INVOICES; a typeless row counts as an invoice', () => {
    for (const row of [{ invoice_id: 'I1', invoice_number: 'INV-1', type: 'invoice', status: 'overdue', balance: 100 }, { invoice_id: 'I1', invoice_number: 'INV-1', status: 'sent', balance: 100 }, { invoice_id: 'I1', invoice_number: 'INV-1', type: 'invoice', status: 'sent' }]) {
      const f = evaluateBooksCrossCheck(passing({ books: { invoices: ok([row]) } }));
      assert.equal(chk(f, 'CFD').code, 'CFD_UNPAID', JSON.stringify(row));
      assert.equal(chk(f, 'INVOICES').code, 'OUTSTANDING_DUES');
      assert.equal(chk(f, 'INVOICES').message, '1 invoice is unpaid or overdue (INV-1).');
    }
    for (const st of ['draft', 'void', 'paid']) assert.equal(evaluateBooksCrossCheck(passing({ books: { invoices: ok([{ invoice_id: 'I1', type: 'invoice', status: st, balance: 100 }]) } })).ok, true, st);
  });
  test('the live receivable on the contact counts as a due; unknown receivable fails closed', () => {
    assert.equal(chk(evaluateBooksCrossCheck(passing({ contact: { contactId: '11', contactName: 'Acme Trading', outstanding: 5 } })), 'INVOICES').code, 'OUTSTANDING_DUES');
    assert.equal(chk(evaluateBooksCrossCheck(passing({ contact: null })), 'INVOICES').ok, false);
  });
  test('fewer Books payments than Analytics → a payment was deleted (unless the list was truncated)', () => {
    const f = evaluateBooksCrossCheck(passing({ pay: { payments: 2, received: 8000, unapplied: 0, refunded: 0 } }));
    assert.equal(chk(f, 'INVOICES').code, 'PAYMENT_REVERSED');
    assert.match(chk(f, 'INVOICES').message, /a payment was deleted/);
    const t = evaluateBooksCrossCheck(passing({ pay: { payments: 2, received: 8000, unapplied: 0, refunded: 0 }, books: { payments: { ...ok([{ payment_id: 'P1', amount: 4000 }]), truncated: true } } }));
    assert.equal(chk(t, 'INVOICES').ok, true);
  });
  test('no payment in Books / declared unpaid / unapplied payment with dues', () => {
    assert.equal(chk(evaluateBooksCrossCheck(passing({ pay: null, books: { payments: ok([]) } })), 'INVOICES').code, 'NO_CUSTOMER_PAYMENT');
    assert.equal(chk(evaluateBooksCrossCheck(passing({ paid: 'No' })), 'INVOICES').code, 'DECLARED_UNPAID');
    const u = evaluateBooksCrossCheck(passing({ books: { payments: ok([{ payment_id: 'P1', amount: 4000, unused_amount: 50 }]), invoices: ok([{ invoice_id: 'I1', type: 'invoice', status: 'sent', balance: 50 }]) } }));
    assert.equal(chk(u, 'INVOICES').code, 'PAYMENT_NOT_APPLIED');
  });
  test('COGS: unsynced COGS debits beyond what was received fail; untagged entries still fail as in round 1', () => {
    const big = evaluateBooksCrossCheck(passing({ books: { cogsTx: ok([{ transaction_id: 'G1', customer_id: '11', transaction_date: DAY, debit_amount: 9000, credit_amount: 0 }]) } }));
    assert.equal(chk(big, 'COGS').code, 'COGS_EXCEEDS_PAYMENTS');
    const untagged = evaluateBooksCrossCheck(passing({ split: { cfd: { credits: 4000, debits: 1000, lines: 2, untagged: 1 }, cogs: { credits: 0, debits: 0, lines: 0, untagged: 0 } } }));
    assert.equal(chk(untagged, 'COGS').code, 'COGS_UNMAPPED');
  });
  test('messages and item texts carry no amounts; details do', () => {
    const variants = [base(), plus([credit('T3', 2500)]), base({ books: { cfdTx: down } }),
      passing({ books: { invoices: ok([{ invoice_id: 'I1', invoice_number: 'INV-1', type: 'invoice', status: 'sent', balance: 100 }]), creditnotes: ok([{ creditnote_id: 'C1', creditnote_number: 'CN-1', status: 'draft', balance: 10 }]) } })];
    for (const v of variants) {
      const f = evaluateBooksCrossCheck(v);
      for (const c of f.checks) {
        assert.doesNotMatch(c.message, AMOUNT_RE, c.key + ': ' + c.message);
        for (const i of c.items) assert.doesNotMatch(i.text, AMOUNT_RE, c.key + '/' + i.label + ': ' + i.text);
      }
      assert.doesNotMatch(f.opsError, AMOUNT_RE);
    }
  });
});

describe('dates', () => {
  test('parseDay reads the Zoho formats', () => {
    assert.equal(parseDay('2026-10-09 09:03:00'), '2026-10-09');
    assert.equal(parseDay('09 Oct 2026 09:03:00'), '2026-10-09');
    assert.equal(parseDay('9 October, 2026'), '2026-10-09');
    assert.equal(parseDay('Oct 9, 2026'), '2026-10-09');
    assert.equal(parseDay(''), null);
    assert.equal(parseDay('yesterday'), null);
  });
  test('crossCheckWindow: watermark − 2 days, at most 45 days back', () => {
    assert.equal(crossCheckWindow('2026-10-09 09:03:00', '2026-10-09'), '2026-10-07');
    assert.equal(crossCheckWindow('2026-01-01', '2026-10-09'), '2026-08-25');
    assert.equal(crossCheckWindow(null, '2026-10-09'), '2026-08-25');
    assert.equal(crossCheckWindow('2027-01-01', '2026-10-09'), '2026-10-07', 'a watermark in the future is capped');
  });
});

describe('financeForOps (round 2)', () => {
  test('whitelist: no detail, no primary detail, no Books figures, no unknown fields', () => {
    const f = evaluateBooksCrossCheck(plus([credit('T3', 2500)]));
    const full = { id: 'FV-1', at: 'x', atText: 'y', amount: 5000, ok: f.ok, source: 's', route: 'BOOKS_CROSSCHECK',
      connections: { analytics: true, books: true, atText: '09 Oct · 10:00', error: 'secret' },
      primary: { ok: false, code: 'CFD_INSUFFICIENT', text: 'Client does not have sufficient balance to request funds.', detail: 'CFD balance AED 3,000.00' },
      checks: f.checks, available: f.available, staffError: f.staffError, failed: f.failed, booksAvailable: 5500 };
    const o = financeForOps(full);
    const s = JSON.stringify(o);
    assert.doesNotMatch(s, /"detail"/);
    assert.doesNotMatch(s, /AED/);
    assert.doesNotMatch(s, /secret/);
    for (const k of ['available', 'staffError', 'booksAvailable']) assert.ok(!(k in o), k);
    assert.deepEqual(o.primary, { ok: false, code: 'CFD_INSUFFICIENT', text: 'Client does not have sufficient balance to request funds.' });
    assert.equal(o.route, 'BOOKS_CROSSCHECK');
    assert.equal(o.checks.length, 5);
    assert.deepEqual(o.checks.map(c => c.message), f.checks.map(c => c.message));
    assert.ok(full.primary.detail, 'input not mutated');
  });
});
