// A client whose Books contact was merged into (or folded onto) another: the CFD balance shown when the client is picked,
// and when it is re-read, is the canonical contact's balance — not "no balance".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, mkTmp, call, login, MASTER_PW } from './helpers.mjs';
import { fixture } from './fixtures.mjs';

const CANON = '5000', DUP = '5001';
let srv, sven;
before(async () => {
  const fx = fixture();
  fx.contacts.push(
    { contact_id: CANON, contact_name: 'Merged Canonical', company_name: 'Merged Canonical FZCO', status: 'active', outstanding_receivable_amount: 0 },
    { contact_id: DUP, contact_name: 'Merged Duplicate', company_name: 'Merged Canonical FZCO', status: 'active', outstanding_receivable_amount: 0 });
  // Analytics keys the balance by the canonical contact only; the duplicate has no row of its own.
  fx.balances.push({ 'Resolved Customer ID': CANON, 'Resolved Customer Name': 'Merged Canonical', 'Credits AED': '50000', 'Debits AED': '8000', 'Balance AED': '42000', 'Balance Status': 'Positive', 'Balance Alert': '' });
  fx.aliases = [...(fx.aliases || []), { Source: DUP, Canonical: CANON }];
  srv = await startServer({ dir: mkTmp('merged'), fixture: fx });
  sven = await login(srv.base, 'sven', MASTER_PW);
});
after(async () => { if (srv) await srv.stop(); });

test('picking the merged contact shows the canonical contact balance', async () => {
  const r = await call(srv.base, sven, 'POST', '/api/zoho/validate-client', { contactId: DUP });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.balance.found, true, JSON.stringify(r.json.balance));
  assert.equal(r.json.balance.available, 42000);
});

test('re-reading the merged contact balance gives the canonical balance', async () => {
  const r = await call(srv.base, sven, 'GET', '/api/zoho/client-balance?contactId=' + DUP);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.balance.found, true);
  assert.equal(r.json.balance.available, 42000);
});

test('the canonical contact itself still reads its own balance', async () => {
  const r = await call(srv.base, sven, 'GET', '/api/zoho/client-balance?contactId=' + CANON);
  assert.equal(r.json.balance.available, 42000);
});
