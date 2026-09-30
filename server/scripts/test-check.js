// Rule + gate tests — no network. Run: npm run test:check
import assert from 'node:assert';
import { decide, STATUS } from '../lib/rules.js';
import { exact } from '../lib/zoho.js';

process.env.VALIDATION_SECRET = process.env.VALIDATION_SECRET || 'x'.repeat(40);
const gate = await import('../lib/gate.js');

// Exact identity — no fuzzy, no case folding, no trimming
const list = [{ n: 'Al Saadi Auditing' }];
assert.ok(exact(list, 'Al Saadi Auditing', x => x.n));
assert.equal(exact(list, 'al saadi auditing', x => x.n), null);
assert.equal(exact(list, 'Al Saadi Auditing ', x => x.n), null);
assert.equal(exact(list, 'Al  Saadi Auditing', x => x.n), null);
assert.equal(exact(list, 'Al Saadi', x => x.n), null);

// Token must match the exact name
const t = gate.issue('Al Saadi Auditing', 'C1', 'Zoho Books');
assert.ok(gate.verify(t, 'Al Saadi Auditing').ok);
assert.equal(gate.verify(t, 'block investments LTD').why, 'NAME_MISMATCH');
assert.equal(gate.verify(t.slice(0, -2) + 'xx', 'Al Saadi Auditing').ok, false);

// One attempt then locked
gate.lock('sid1', 'Wrong Name');
assert.ok(gate.locked('sid1'));
gate.unlock('sid1');
assert.equal(gate.locked('sid1'), null);

// Approval rules
const rec = (available, categories = ['Licence renewal']) => ({ clientId: 'C1', clientName: 'Acme', companyName: 'Acme LLC', allocated: 10000, used: 10000 - available, available, categories });
const req = (amt, purpose = 'Licence renewal 1 year', company = 'Acme LLC') => ({ clientName: 'Acme', company, purpose, requestedAmount: amt });
assert.equal(decide({ req: req(100), books: null, rec: null }).reason, 'CLIENT_NOT_FOUND');
assert.equal(decide({ req: req(100), books: { contactId: 'b' }, rec: null }).approvalStatus, STATUS.NOT);
assert.equal(decide({ req: req(100, 'Office rent'), books: null, rec: rec(500) }).reason, 'NOT_RELEVANT');
assert.equal(decide({ req: req(100), books: null, rec: rec(0) }).approvalStatus, STATUS.NOT);
const p = decide({ req: req(900), books: null, rec: rec(500) });
assert.equal(p.approvalStatus, STATUS.PARTIAL); assert.equal(p.approvedAmount, 500);
assert.equal(decide({ req: req(400), books: null, rec: rec(500) }).approvalStatus, STATUS.APPROVED);
console.log('All rule and gate checks passed');
