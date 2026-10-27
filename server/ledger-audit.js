// The two ledger audits of the Customer Fund ledger dashboard (Sven and management only).
// Pure: the server reads Elite OneLink's Zoho Analytics workspace (SELECT exports only) and passes the rows in; this
// decides. Nothing here talks to Zoho and nothing is ever written back — every "required correction" is an instruction
// for the finance team to carry out in Zoho Books.
//
//   Module 1 — Client account accuracy audit (auditClientAccounts). For every client: credit notes, refunds, payments,
//     invoices and the journal entries on the Customer Fund Disbursement (CFD) and COGS ledger, and the client's
//     liabilities (funds held in CFD, unused payments, open credit notes) with the transaction and account that settled
//     them. Every inconsistency is an exception: client, account / transaction type, issue, root cause, correction.
//   Module 2 — Chart of Accounts balance review (reviewChartOfAccounts). For every account: its balance, expected or not,
//     where the balance comes from, the accounts that must always be zero (Disbursements Of Expenses, clearing, suspense,
//     holding, undeposited funds) traced to the entries that keep them open, client costs booked under COGS that belong
//     in Customer Fund Disbursement (with the reallocation journal), and negative balances.
//
// severity: 'error' — wrong in the books, needs the correction; 'review' — not provably wrong, a person has to look.
import { parseDay } from './finance-rules.js';

const EPS = 0.005, TOL = 1; // TOL: settlement differences up to AED 1 are rounding, not an error
const n0 = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = v => Math.round(n0(v) * 100) / 100;
const aed = n => 'AED ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const low = v => String(v ?? '').trim().toLowerCase();
const idk = v => String(v ?? '').trim().replace(/\.0+$/, '');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const sum = (list, f) => r2(list.reduce((a, x) => a + n0(f(x)), 0));
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = v => { const d = parseDay(v); return d ? `${d.slice(8, 10)} ${MO[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : String(v || ''); };
const daysApart = (a, b) => { const x = parseDay(a), y = parseDay(b); return x && y ? Math.abs(Date.parse(x) - Date.parse(y)) / 86_400_000 : Infinity; };
const list = (xs, n = 5) => xs.slice(0, n).join(', ') + (xs.length > n ? ', …' : '');
const by = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); (m.get(k) || m.set(k, []).get(k)).push(r); } return m; };

// Accounts money really comes in through or goes out of (Zoho Books account types).
export const MONEY_TYPES = ['bank', 'cash', 'payment clearing', 'credit card', 'prepaid card'];
const isMoney = type => MONEY_TYPES.includes(low(type));
const ENTITY = { expense: 'Expense', journal: 'Journal', invoice: 'Invoice', creditnote: 'Credit note', invoice_payment: 'Invoice payment', customer_payment: 'Customer payment',
  transfer_fund: 'Transfer', bill: 'Bill', bill_payment: 'Bill payment', vendor_payment: 'Vendor payment', creditnote_refund: 'Credit note refund', payment_refund: 'Payment refund',
  expense_refund: 'Expense refund', vat_balance_journal: 'VAT journal', tax_payment: 'Tax payment', bad_debt: 'Bad debt', owner_drawings: 'Owner drawings',
  owner_contribution: 'Owner contribution', other_income: 'Other income' };
export const entityLabel = t => ENTITY[low(t)] || (t ? String(t).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Entry');
const OPEN_INV = ['open', 'overdue', 'partially paid', 'partially_paid', 'sent', 'unpaid', 'viewed'];
const PAID_INV = ['paid', 'closed']; // Zoho Analytics calls a paid invoice "Closed"

export const AREAS = { CREDIT_NOTES: 'Credit notes', REFUNDS: 'Refunds', PAYMENTS: 'Payments', INVOICES: 'Invoices & journal entries', LIABILITIES: 'Client liabilities' };
export const NO_CLIENT = 'No client tag';
const ex = (area, code, severity, type, reference, amount, issue, rootCause, correction) => ({ area, areaLabel: AREAS[area], code, severity, type, reference: reference || '', amount: r2(amount), issue, rootCause, correction });

// a: {
//   accounts:  { cfd, cogs } — Books account ids of Customers Fund Disbursement and Cost of Goods Sold-Clients Payments
//   customers: [{ id, name }]                                          — client names (ids already folded onto canonical)
//   balances:  [{ clientId, clientName, available, allocated, used, status }] — CFD Customer Balances
//   creditNotes:    [{ customer, id, number, status, date, total, balance }]
//   cnApplications: [{ creditNoteId, invoiceCustomer, invoice, amount, date }]   — credit notes applied to invoices
//   payments:  [{ customer, id, number, date, amount, unused, refunded, applied, account, accountName, accountType }]
//   refunds:   [{ customer, type, entityId, txnId, account, accountName, accountType, date, debit, credit, reference }]
//              — ledger lines of creditnote_refund / payment_refund entries (both sides)
//   invoices:  [{ customer, id, number, status, date, due, total, balance, writeOff, paid, credited }]  — not draft / void
//   ledger:    [{ customer, customerName, account, type, entityId, txnId, reference, date, debit, credit, tagged }]
//              — CFD and COGS lines ("CFD Customer Resolved"); customer '' = no client could be resolved
//   counter:   [{ txnId, account, accountName, accountType, debit, credit }] — the other accounts of those transactions
// }
export function auditClientAccounts(a) {
  const acc = a.accounts || {}, cfdId = idk(acc.cfd), cogsId = idk(acc.cogs);
  const names = new Map();
  const nameIn = (id, n) => { const k = idk(id); if (k && n && !names.has(k)) names.set(k, String(n)); };
  // The canonical name first (the balance table and the ledger use it), then the Books contact list.
  for (const b of a.balances || []) nameIn(b.clientId, b.clientName);
  for (const l of a.ledger || []) nameIn(l.customer, l.customerName);
  for (const c of a.customers || []) nameIn(c.id, c.name);
  const nameOf = id => (idk(id) ? names.get(idk(id)) || 'Client ' + idk(id) : NO_CLIENT);
  const C = new Map();
  const client = id => {
    const k = idk(id);
    if (!C.has(k)) C.set(k, { id: k, name: nameOf(k), exceptions: [], figures: { invoices: 0, openInvoices: 0, outstanding: 0, payments: 0, received: 0, unusedPayments: 0, creditNotes: 0, openCredits: 0, refunds: 0, refunded: 0, ledgerLines: 0 } });
    return C.get(k);
  };
  const add = (id, e) => client(id).exceptions.push(e);

  // ── indexes ──
  const invoices = (a.invoices || []).filter(i => i && !['draft', 'void'].includes(low(i.status)));
  const invBy = by(invoices, i => idk(i.customer));
  const openBy = new Map([...invBy].map(([k, xs]) => [k, xs.filter(i => n0(i.balance) > EPS && !PAID_INV.includes(low(i.status)))
    .sort((x, y) => String(parseDay(x.date) || '').localeCompare(String(parseDay(y.date) || '')))]));
  const openOf = k => openBy.get(k) || [];
  const applyText = (what, amount, k) => {
    const open = openOf(k);
    let left = r2(amount);
    const steps = [];
    for (const i of open) { if (left <= EPS) break; const x = r2(Math.min(left, n0(i.balance))); steps.push(`${aed(x)} to ${i.number || i.id}`); left = r2(left - x); }
    return `Apply ${what}: ${steps.join(', ')}` + (left > EPS ? `; ${aed(left)} stays as credit for the client` : '') + '.';
  };
  const openList = k => list(openOf(k).map(i => `${i.number || i.id} ${aed(i.balance)}`), 3);

  for (const k of invBy.keys()) { const f = client(k).figures, xs = invBy.get(k); f.invoices = xs.length; f.openInvoices = openOf(k).length; f.outstanding = sum(openOf(k), i => i.balance); }

  // ── 1. credit notes ──
  const apps = by(a.cnApplications || [], x => idk(x.creditNoteId));
  const cns = (a.creditNotes || []).filter(c => c && !['void', 'draft'].includes(low(c.status)));
  const cnLeft = new Map(); // client -> { amount, refs } credit-note value neither applied nor left open (should be refunded)
  for (const cn of cns) {
    const k = idk(cn.customer), total = n0(cn.total), bal = n0(cn.balance), st = low(cn.status), ref = cn.number || cn.id, type = 'Credit note · ' + ref;
    const ap = apps.get(idk(cn.id)) || [], applied = sum(ap, x => x.amount);
    const f = client(k).figures; f.creditNotes++;
    for (const x of ap) {
      const other = idk(x.invoiceCustomer);
      if (other && other !== k) add(k, ex('CREDIT_NOTES', 'CN_WRONG_CLIENT', 'error', type, x.invoice, x.amount,
        `${ref} is applied to invoice ${x.invoice || '—'} of ${nameOf(other)} (${aed(x.amount)}).`,
        'Credit note applied to another client’s invoice.',
        `In Zoho Books remove the ${aed(x.amount)} application of ${ref} from ${x.invoice || 'that invoice'}, then apply it to an open invoice of ${nameOf(k)} or refund it to them; ${nameOf(other)}’s invoice goes back to due.`));
    }
    if (applied > total + EPS) add(k, ex('CREDIT_NOTES', 'CN_OVER_APPLIED', 'error', type, ref, applied - total,
      `${ref} of ${aed(total)} has ${aed(applied)} applied to invoices.`, 'Credit note applied more than once (duplicate application).',
      `Remove the duplicate application(s) of ${ref} so no more than ${aed(total)} is applied.`));
    if (bal < -EPS || bal > total + EPS) add(k, ex('CREDIT_NOTES', 'CN_BALANCE_INVALID', 'error', type, ref, bal,
      `${ref} shows a balance of ${aed(bal)} on a total of ${aed(total)}.`, 'Credit note balance is outside its total — the note was edited after it was applied or refunded.',
      `Open ${ref} in Zoho Books, undo the applications / refunds and re-apply them so the balance is between zero and ${aed(total)}.`));
    else if (st === 'closed' && bal > EPS) add(k, ex('CREDIT_NOTES', 'CN_STATUS', 'error', type, ref, bal,
      `${ref} is closed but ${aed(bal)} is still unused.`, 'Status and balance disagree.', `Reopen ${ref} and apply or refund the ${aed(bal)} left.`));
    else if (st === 'open' && bal <= EPS && total > EPS) add(k, ex('CREDIT_NOTES', 'CN_STATUS', 'review', type, ref, 0,
      `${ref} is open with nothing left to use.`, 'Status not updated after it was fully applied or refunded.', `Check ${ref} in Zoho Books; it should be closed.`));
    if (bal > EPS && st !== 'closed' && bal <= total + EPS) {
      f.openCredits = r2(f.openCredits + bal);
      if (openOf(k).length) add(k, ex('CREDIT_NOTES', 'CN_UNUSED', 'error', type, ref, bal,
        `${ref}: ${aed(bal)} unused while ${plural(openOf(k).length, 'invoice is', 'invoices are')} open (${openList(k)}).`,
        'Credit note not applied to the client’s open invoices.', applyText(`${aed(bal)} of ${ref}`, bal, k)));
      else add(k, ex('CREDIT_NOTES', 'CN_UNUSED', 'review', type, ref, bal,
        `${ref}: ${aed(bal)} unused and the client has no open invoice.`, 'Credit owed to the client — neither applied nor refunded.',
        `Refund ${aed(bal)} to ${nameOf(k)} from the bank or wallet the money came in to (Refund on ${ref} in Zoho Books), or keep it for the next invoice with the client’s written agreement.`));
    }
    const left = r2(total - Math.max(0, bal) - applied);
    if (left > TOL) { const e = cnLeft.get(k) || { amount: 0, refs: [] }; e.amount = r2(e.amount + left); e.refs.push(ref); cnLeft.set(k, e); }
  }
  // the same credit raised twice: same client, same amount, dated within 3 days
  for (const [k, xs] of by(cns, c => idk(c.customer))) {
    const s = xs.slice().sort((x, y) => String(parseDay(x.date) || '').localeCompare(String(parseDay(y.date) || '')));
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
      const p = s[i], q = s[j];
      if (n0(p.total) > EPS && Math.abs(n0(p.total) - n0(q.total)) <= EPS && daysApart(p.date, q.date) <= 3)
        add(k, ex('CREDIT_NOTES', 'CN_DUPLICATE', 'review', 'Credit note · ' + (q.number || q.id), q.number || q.id, q.total,
          `${p.number || p.id} and ${q.number || q.id} — both ${aed(q.total)}, dated ${dayText(p.date)} and ${dayText(q.date)}.`,
          'Possibly the same credit raised twice.',
          'Check both against the client file. If one is a duplicate, undo its applications / refund and void it in Zoho Books.'));
    }
  }

  // ── 2. refunds: creditnote_refund / payment_refund entries in the ledger ──
  const refunded = new Map(); // client -> { creditnote, payment }
  for (const [ek, lines] of by((a.refunds || []).filter(l => l && /refund/.test(low(l.type)) && !/expense/.test(low(l.type))), l => idk(l.entityId) || idk(l.txnId))) {
    if (!ek) continue;
    const k = idk((lines.find(l => idk(l.customer)) || {}).customer), t = lines[0].type, kind = /payment/.test(low(t)) ? 'payment' : 'creditnote';
    // amount: what left the bank; settles: what it cleared on the client's side (receivable / advance) — an exchange
    // difference on the refund is in the first, never in the second, so it is the one set against the credit notes.
    const out = lines.filter(l => n0(l.credit) > EPS), amount = sum(out, l => l.credit) || sum(lines, l => l.debit);
    const settles = sum(lines.filter(l => n0(l.debit) > EPS && !isMoney(l.accountType) && !/exchange/i.test(String(l.accountName || ''))), l => l.debit) || amount;
    const date = dayText(lines[0].date), ref = (lines.find(l => l.reference) || {}).reference || '', type = entityLabel(t) + ' · ' + (ref || date);
    const what = ref ? `${entityLabel(t)} ${ref} of ${aed(amount)} (${date})` : `${entityLabel(t)} of ${aed(amount)} on ${date}`, it = ref || `the ${entityLabel(t).toLowerCase()} of ${date}`;
    const f = client(k).figures; f.refunds++; f.refunded = r2(f.refunded + settles);
    const e = refunded.get(k) || { creditnote: 0, payment: 0 }; e[kind] = r2(e[kind] + settles); refunded.set(k, e);
    if (!k) add('', ex('REFUNDS', 'REFUND_NO_CLIENT', 'error', type, ref, amount,
      `${what} is not tagged to a client.`, 'Refund recorded without its client.',
      `Edit ${it} in Zoho Books and select the client it was paid to.`));
    const money = out.filter(l => isMoney(l.accountType));
    if (!money.length) add(k, ex('REFUNDS', 'REFUND_ACCOUNT', 'error', type, ref, amount,
      `${what} is paid out of ${list([...new Set(out.map(l => `${l.accountName || l.account} (${l.accountType || 'unknown type'})`))]) || 'no account'}.`,
      'Refund not matched to a bank or wallet account — the money leaving is not recorded where it left from.',
      `Edit ${it} in Zoho Books and set “Paid through” to the bank, wallet or card account the ${aed(amount)} actually left from.`));
  }
  const payRefund = new Map();
  for (const p of a.payments || []) if (n0(p.refunded) > EPS) payRefund.set(idk(p.customer), r2((payRefund.get(idk(p.customer)) || 0) + n0(p.refunded)));
  for (const [k, want] of payRefund) {
    const have = (refunded.get(k) || {}).payment || 0;
    if (want - have > TOL) add(k, ex('REFUNDS', 'PAYMENT_REFUND_MISSING', 'review', 'Customer payment refund', '', want - have,
      `Customer payments show ${aed(want)} refunded; the ledger has ${aed(have)} of payment refunds for this client.`,
      'A refund on a payment has no matching refund entry (deleted, or booked as an expense or journal instead).',
      `Find the refunded payment(s) of ${nameOf(k)} in Zoho Books and record the ${aed(want - have)} as a payment refund from the bank / wallet it was paid out of; reverse any expense or journal used in its place.`));
  }
  for (const k of new Set([...cnLeft.keys(), ...[...refunded].filter(([, v]) => v.creditnote > EPS).map(([key]) => key)])) {
    const want = (cnLeft.get(k) || { amount: 0 }).amount, have = (refunded.get(k) || {}).creditnote || 0;
    if (want - have > TOL) add(k, ex('REFUNDS', 'CN_REFUND_MISSING', 'review', 'Credit note refund', list(cnLeft.get(k).refs, 3), want - have,
      `${aed(want)} of credit notes (${list(cnLeft.get(k).refs, 3)}) is neither applied to an invoice nor left open; the ledger has ${aed(have)} of credit-note refunds for this client.`,
      'Missing refund entry for a credit note.',
      `Record the ${aed(want - have)} refund on the credit note in Zoho Books from the bank / wallet it was paid from — or, if it was never paid, undo it so the credit is open again.`));
    else if (have - want > TOL) add(k, ex('REFUNDS', 'REFUND_UNMATCHED', 'review', 'Credit note refund', '', have - want,
      `Credit-note refunds of ${aed(have)} are recorded, but the credit notes account for ${aed(want)} refunded.`,
      'Refund matched to the wrong client or credit note.', `Check every credit-note refund of ${nameOf(k)} in Zoho Books against its credit note and client; move any that belong to another client.`));
  }

  // ── 3. payments ──
  for (const p of a.payments || []) {
    if (!p) continue;
    const k = idk(p.customer), amt = n0(p.amount), unused = n0(p.unused), rf = n0(p.refunded), applied = n0(p.applied);
    const ref = p.number || p.id, type = 'Customer payment · ' + ref, date = dayText(p.date);
    const f = client(k).figures; f.payments++; f.received = r2(f.received + amt); if (unused > EPS) f.unusedPayments = r2(f.unusedPayments + unused);
    if (!k) add('', ex('PAYMENTS', 'PAYMENT_NO_CLIENT', 'error', type, ref, amt, `${ref} of ${aed(amt)} (${date}) has no client.`, 'Payment recorded without its client.', `Edit ${ref} in Zoho Books and select the client who paid.`));
    if (!idk(p.account)) add(k, ex('PAYMENTS', 'PAYMENT_NO_SOURCE', 'error', type, ref, amt,
      `${ref} of ${aed(amt)} (${date}) has no deposit account.`, 'Payment not tagged to its source (bank, wallet, card).',
      `Edit ${ref} in Zoho Books and set “Deposit to” to the bank, wallet, card or clearing account the ${aed(amt)} was received in.`));
    else if (!isMoney(p.accountType) && idk(p.account) !== cfdId) add(k, ex('PAYMENTS', 'PAYMENT_SOURCE', 'review', type, ref, amt,
      `${ref} of ${aed(amt)} (${date}) is deposited to ${p.accountName || p.account} (${p.accountType || 'unknown type'}).`,
      'Payment tagged to an account that is not a bank, cash, wallet, card or clearing account.',
      `Confirm where the ${aed(amt)} was received and change “Deposit to” on ${ref} to that bank / wallet account.`));
    if (applied + unused + rf > amt + TOL) add(k, ex('PAYMENTS', 'PAYMENT_OVER_ALLOCATED', 'error', type, ref, applied + unused + rf - amt,
      `${ref} of ${aed(amt)}: ${aed(applied)} applied + ${aed(unused)} unused + ${aed(rf)} refunded.`, 'Payment allocated more than it is worth (duplicate application).',
      `Remove the duplicate invoice application(s) of ${ref} in Zoho Books.`));
    if (unused > EPS) {
      if (openOf(k).length) add(k, ex('PAYMENTS', 'PAYMENT_UNAPPLIED', 'error', type, ref, unused,
        `${ref}: ${aed(unused)} unapplied while ${plural(openOf(k).length, 'invoice is', 'invoices are')} open (${openList(k)}).`,
        'Payment not applied to the client’s open invoice (misallocated).', applyText(`${aed(unused)} of ${ref}`, unused, k)));
      else if (!(invBy.get(k) || []).length) add(k, ex('PAYMENTS', 'PAYMENT_NO_INVOICE', 'review', type, ref, unused,
        `${ref}: ${aed(unused)} received (${date}) and this client has no invoice.`, 'Payment recorded without a corresponding invoice.',
        `Raise the invoice ${ref} pays for and apply it — if it is client funds for disbursements, invoice it to the Customer Fund Disbursement account; if it is not ${nameOf(k)}’s money, move it to the right client or refund it.`));
    }
  }

  // ── 4. invoices and journal entries ──
  for (const i of invoices) {
    const k = idk(i.customer), total = n0(i.total), bal = n0(i.balance), wo = n0(i.writeOff), st = low(i.status), ref = i.number || i.id, type = 'Invoice · ' + ref;
    if (total <= EPS && bal <= EPS) continue;
    if (bal < -EPS || bal > total + EPS) add(k, ex('INVOICES', 'INV_BALANCE_INVALID', 'error', type, ref, bal,
      `${ref} shows a balance of ${aed(bal)} on a total of ${aed(total)}.`, 'Invoice balance is outside its total — edited after payments were applied.',
      `Open ${ref} in Zoho Books, remove and re-apply its payments / credit notes so the balance is correct.`));
    else if (PAID_INV.includes(st) && bal > EPS) add(k, ex('INVOICES', 'INV_STATUS', 'error', type, ref, bal,
      `${ref} is marked ${st} but ${aed(bal)} is still open.`, 'Status and balance disagree (a payment was deleted or edited after the invoice closed).',
      `Re-apply the payment to ${ref} in Zoho Books, or let it reopen so the ${aed(bal)} shows as due.`));
    else if (OPEN_INV.includes(st) && bal <= EPS) add(k, ex('INVOICES', 'INV_STATUS', 'review', type, ref, 0,
      `${ref} shows “${i.status}” with nothing left to pay.`, 'Status not updated after settlement.', `Check ${ref} in Zoho Books; it should be paid.`));
    const settled = r2(total - Math.max(0, bal) - wo), covered = r2(n0(i.paid) + n0(i.credited)), gap = r2(settled - covered);
    if (gap > TOL) add(k, ex('INVOICES', 'INV_UNMATCHED_SETTLEMENT', 'error', type, ref, gap,
      `${ref}: ${aed(settled)} settled, but only ${aed(covered)} of payments and credit notes are applied (${aed(gap)} unmatched).`,
      'Invoice settled without a matching payment or credit note — a journal posted straight to receivables, or a payment deleted.',
      `Record the ${aed(gap)} payment against ${ref} from the bank / wallet it arrived in and reverse any journal that settled it — or, if it was never paid, reverse the settlement so ${aed(gap)} is due again.`));
    else if (gap < -TOL) add(k, ex('INVOICES', 'INV_OVER_SETTLED', 'error', type, ref, -gap,
      `${ref}: ${aed(covered)} of payments and credit notes applied against ${aed(settled)} settled.`, 'Payment or credit note applied twice.',
      `Remove the duplicate application(s) on ${ref} in Zoho Books.`));
  }
  // CFD / COGS ledger entries: every entry must be tagged to its client in Zoho Books
  const acctName = id => (idk(id) === cfdId ? 'Customers Fund Disbursement' : idk(id) === cogsId ? 'Cost of Goods Sold-Clients Payments' : 'account ' + idk(id));
  const ledger = (a.ledger || []).filter(l => l && typeof l === 'object');
  for (const l of ledger) client(idk(l.customer)).figures.ledgerLines++;
  for (const [ek, lines] of by(ledger, l => idk(l.entityId) || idk(l.txnId) || 'line')) {
    const k = idk(lines[0].customer), t = lines[0].type, ref = (lines.find(l => l.reference) || {}).reference || ek;
    const dr = sum(lines, l => l.debit), cr = sum(lines, l => l.credit), amount = Math.max(dr, cr), where = list([...new Set(lines.map(l => acctName(l.account)))], 2);
    const type = entityLabel(t) + ' · ' + ref, date = dayText(lines[0].date);
    if (!k) add('', ex('INVOICES', 'LEDGER_UNTAGGED', 'error', type, ref, amount,
      `${entityLabel(t)} ${ref} (${date}) posts ${dr > EPS ? aed(dr) + ' debit' : ''}${dr > EPS && cr > EPS ? ' / ' : ''}${cr > EPS ? aed(cr) + ' credit' : ''} to ${where} with no client.`,
      'Missing client tag — the entry is in no client’s fund balance.', `Edit ${ref} in Zoho Books and tag the client on the ${where} line.`));
    else if (!lines.some(l => l.tagged)) add(k, ex('INVOICES', 'LEDGER_REFERENCE_MATCH', 'review', type, ref, amount,
      `${entityLabel(t)} ${ref} (${date}) on ${where} is matched to this client only by its reference.`, 'Client not tagged on the entry in Zoho Books.',
      `Tag ${nameOf(k)} on the ${where} line of ${ref} in Zoho Books.`));
  }

  // ── 5. liabilities: client funds held (CFD), unused payments, open credit notes — and what settled them ──
  const counter = by(a.counter || [], x => idk(x.txnId));
  const ledBy = by(ledger.filter(l => idk(l.customer)), l => idk(l.customer));
  const bal = new Map((a.balances || []).filter(b => idk(b.clientId)).map(b => [idk(b.clientId), b]));
  for (const k of bal.keys()) client(k);
  const trace = lines => {
    const debits = lines.filter(l => n0(l.debit) > EPS);
    if (!debits.length) return null;
    const keyOf = l => idk(l.txnId) || idk(l.entityId);
    const last = debits.slice().sort((x, y) => String(parseDay(y.date) || '').localeCompare(String(parseDay(x.date) || '')) || keyOf(y).localeCompare(keyOf(x)))[0];
    const same = debits.filter(l => keyOf(l) === keyOf(last));
    const other = (counter.get(idk(last.txnId)) || []).filter(x => n0(x.credit) > EPS);
    return { date: dayText(last.date), type: entityLabel(last.type), reference: last.reference || keyOf(last), amount: sum(same, l => l.debit), txnId: idk(last.txnId),
      accounts: other.map(x => ({ name: x.accountName || x.account, type: x.accountType || '', amount: r2(x.credit) })) };
  };
  const traceText = t => !t ? '' : `${t.type} ${t.reference} on ${t.date}, ${aed(t.amount)}` + (t.accounts.length ? ' — paid from ' + t.accounts.map(x => `${x.name}${x.type ? ' (' + x.type + ')' : ''} ${aed(x.amount)}`).join(', ') : ' — the other side of the transaction is not in the ledger');
  for (const c of C.values()) {
    if (!c.id) continue;
    const lines = ledBy.get(c.id) || [], rec = bal.get(c.id), f = c.figures;
    const credits = rec ? n0(rec.allocated) : sum(lines, l => l.credit), debits = rec ? n0(rec.used) : sum(lines, l => l.debit);
    const held = rec ? r2(rec.available) : r2(credits - debits);
    const t = trace(lines);
    const status = held > EPS ? 'OPEN' : held < -EPS ? 'OVERDRAWN' : credits > EPS || debits > EPS ? 'SETTLED' : 'NONE';
    c.liability = { held, received: r2(credits), disbursed: r2(debits), unusedPayments: f.unusedPayments, openCredits: f.openCredits,
      total: r2(Math.max(0, held) + f.unusedPayments + f.openCredits), status, settlement: t, settlementText: traceText(t),
      text: status === 'OPEN' ? `${aed(held)} of client funds held in Customer Fund Disbursement — not settled yet.`
        : status === 'OVERDRAWN' ? `Disbursed ${aed(-held)} more than the client paid in.`
        : status === 'SETTLED' ? `Client funds fully settled (${aed(credits)} received, ${aed(debits)} disbursed).` : 'No client funds on file.' };
    if (status === 'OVERDRAWN') add(c.id, ex('LIABILITIES', 'LIABILITY_OVERDRAWN', 'error', 'Customers Fund Disbursement', t ? t.reference : '', -held,
      `${aed(credits)} received, ${aed(debits)} disbursed — ${aed(-held)} paid out for the client that they have not funded.` + (t ? ` Last disbursement: ${traceText(t)}.` : ''),
      'Disbursements exceed the client’s funds: a client payment is missing, or a disbursement is booked to the wrong client.',
      `Invoice and collect ${aed(-held)} from ${c.name} into the Customer Fund Disbursement account — or, if a disbursement belongs to another client, re-tag it to that client.`));
    else if (status === 'OPEN' && f.outstanding > EPS) add(c.id, ex('LIABILITIES', 'LIABILITY_WITH_DUES', 'review', 'Customers Fund Disbursement', '', Math.min(held, f.outstanding),
      `${aed(held)} of the client’s funds are held while ${aed(f.outstanding)} is due on invoices (${openList(c.id)}).`,
      'Liability not settled against the client’s own dues.',
      `With the client’s agreement, settle ${aed(Math.min(held, f.outstanding))} of the open invoices from their funds (journal: Dr Customers Fund Disbursement / Cr Accounts Receivable, tagged to ${c.name}) — or chase the invoices.`));
  }

  // ── result ──
  // The "No client tag" bucket first (when it has anything), then clients needing corrections, review, accurate.
  const rank = { error: 0, review: 1 }, order = c => (!c.id ? -1 : { CORRECTIONS: 0, REVIEW: 1, ACCURATE: 2 }[c.status]);
  const clients = [...C.values()].filter(c => c.id || c.exceptions.length).map(c => {
    c.exceptions.sort((x, y) => rank[x.severity] - rank[y.severity] || y.amount - x.amount);
    const errors = c.exceptions.filter(e => e.severity === 'error').length;
    return { id: c.id, name: c.name, status: errors ? 'CORRECTIONS' : c.exceptions.length ? 'REVIEW' : 'ACCURATE',
      statusText: errors ? 'Requires corrections' : c.exceptions.length ? 'Review' : 'Accurate', errors, reviews: c.exceptions.length - errors,
      figures: c.figures, liability: c.liability || null, exceptions: c.exceptions.map(e => ({ client: c.name, clientId: c.id, ...e })) };
  }).sort((x, y) => order(x) - order(y) || y.errors - x.errors || y.reviews - x.reviews || x.name.localeCompare(y.name));
  const all = clients.flatMap(c => c.exceptions), real = clients.filter(c => c.id);
  const byArea = Object.fromEntries(Object.keys(AREAS).map(k => [k, all.filter(e => e.area === k).length]));
  return {
    summary: { clients: real.length, accurate: real.filter(c => c.status === 'ACCURATE').length, corrections: real.filter(c => c.status === 'CORRECTIONS').length,
      review: real.filter(c => c.status === 'REVIEW').length, exceptions: all.length, errors: all.filter(e => e.severity === 'error').length,
      reviews: all.filter(e => e.severity === 'review').length, untagged: (clients.find(c => !c.id) || { exceptions: [] }).exceptions.length, byArea,
      liabilitiesHeld: sum(real, c => (c.liability && c.liability.held > 0 ? c.liability.held : 0)), overdrawn: real.filter(c => c.liability && c.liability.status === 'OVERDRAWN').length },
    clients, exceptions: all
  };
}

// ── Module 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Accounts that must always come back to zero: money passes through them. The Customer Fund Disbursement account is
// never one of them — its credit balance is the client funds held.
export const ZERO_PATTERN = /disbursements? of expenses|clearing|suspense|holding|temporary|\btemp\b|in transit|undeposited funds/i;
// Contra accounts carry a balance against their base type on purpose (sales returns and discounts on income …).
export const CONTRA_PATTERN = /discount|return|allowance|rebate|contra|accumulated depreciation/i;
const DEBIT_BASE = ['asset', 'expense'];
const zeroKind = (name, type) => /disburse/i.test(name) ? 'disbursement' : /undeposited/i.test(name) ? 'undeposited' : low(type) === 'payment clearing' || /clearing/i.test(name) ? 'clearing' : /suspense/i.test(name) ? 'suspense' : 'holding';

// Pair every debit with a credit of the same amount (nearest date first); what is left keeps the account open.
export function openEntries(lines) {
  const rows = (lines || []).filter(l => l && typeof l === 'object').map(l => ({ ...l, net: r2(n0(l.debit) - n0(l.credit)), day: parseDay(l.date) || '' })).filter(x => Math.abs(x.net) > EPS);
  const open = [];
  for (const [, xs] of by(rows, x => Math.abs(x.net).toFixed(2))) {
    const dr = xs.filter(x => x.net > 0).sort((x, y) => x.day.localeCompare(y.day)), cr = xs.filter(x => x.net < 0).sort((x, y) => x.day.localeCompare(y.day));
    const n = Math.min(dr.length, cr.length);
    open.push(...dr.slice(n), ...cr.slice(n));
  }
  return open.sort((x, y) => y.day.localeCompare(x.day) || Math.abs(y.net) - Math.abs(x.net));
}

const entryText = e => `${entityLabel(e.type)} ${e.reference || e.entityId || e.txnId || ''} (${dayText(e.date)}) ${aed(Math.abs(e.net))} ${e.net > 0 ? 'Dr' : 'Cr'}`.replace(/ {2,}/g, ' ');

// a: {
//   accounts:  [{ id, name, code, type, base, active }]                       — the chart of accounts (Analytics "Accounts")
//   movements: [{ account, type, debit, credit, lines, untagged }]             — every account's lines per entity type
//   lines:     { [accountId]: [{ customer, type, entityId, txnId, reference, date, debit, credit }] } — the zero-balance accounts' lines
//   cogsLines: [{ customer, type, entityId, txnId, reference, date, debit, credit, tagged }] — lines of the COGS client account
//   funded:    { [clientId]: CFD funds received } — clients who paid funds into Customer Fund Disbursement
//   names:     { [clientId]: name }
//   config:    { cfd, cogs, zeroIds: [], notZeroIds: [], zeroPattern: RegExp }
// }
export function reviewChartOfAccounts(a) {
  const cfg = a.config || {}, cfdId = idk(cfg.cfd), cogsId = idk(cfg.cogs);
  const zeroIds = new Set((cfg.zeroIds || []).map(idk)), notZero = new Set([cfdId, ...(cfg.notZeroIds || []).map(idk)]), pattern = cfg.zeroPattern || ZERO_PATTERN;
  const names = a.names || {}, funded = a.funded || {};
  const nameOf = id => (idk(id) ? names[idk(id)] || 'Client ' + idk(id) : NO_CLIENT);
  const acctById = new Map((a.accounts || []).map(x => [idk(x.id), x]));
  const cfdName = (acctById.get(cfdId) || {}).name || 'Customers Fund Disbursement Account', cogsName = (acctById.get(cogsId) || {}).name || 'Cost of Goods Sold-Clients Payments';
  const mov = by((a.movements || []).filter(m => m && idk(m.account)), m => idk(m.account));

  // COGS vs Customer Fund Disbursement: a client's cost booked under COGS belongs in CFD when the client funded it.
  const cogsDebits = (a.cogsLines || []).filter(l => l && n0(l.debit) - n0(l.credit) > EPS);
  const realloc = [], unfunded = [], untaggedCogs = [];
  for (const l of cogsDebits) {
    const k = idk(l.customer), amount = r2(n0(l.debit) - n0(l.credit)), ref = l.reference || l.entityId || l.txnId || '';
    const row = { clientId: k, client: nameOf(k), type: entityLabel(l.type), reference: ref, date: dayText(l.date), amount, tagged: !!l.tagged };
    if (!k) untaggedCogs.push({ ...row, instruction: `Tag the client on ${row.type} ${ref} (${row.date}, ${aed(amount)}) in Zoho Books; if it was paid from the client’s funds, reallocate it to ${cfdName}.` });
    else if (n0(funded[k]) > EPS) realloc.push({ ...row, instruction: `Journal dated ${row.date}: Dr ${cfdName} ${aed(amount)} (customer: ${row.client}) / Cr ${cogsName} ${aed(amount)} (customer: ${row.client}) — reference ${ref}.` });
    else unfunded.push({ ...row, instruction: `${row.client} has no funds in ${cfdName}: confirm whether ${row.type} ${ref} is a recoverable disbursement (invoice it to the client through ${cfdName}) or a true cost of the company (leave it in COGS).` });
  }
  const perClient = [...by(realloc, x => x.clientId)].map(([k, xs]) => ({ clientId: k, client: nameOf(k), count: xs.length, amount: sum(xs, x => x.amount) })).sort((x, y) => y.amount - x.amount);

  const accounts = (a.accounts || []).filter(x => x && idk(x.id)).map(x => {
    const id = idk(x.id), base = low(x.base), m = mov.get(id) || [];
    const debits = sum(m, r => r.debit), credits = sum(m, r => r.credit), lines = m.reduce((s, r) => s + n0(r.lines), 0), untagged = m.reduce((s, r) => s + n0(r.untagged), 0);
    const debitNatural = DEBIT_BASE.includes(base), balance = r2(debitNatural ? debits - credits : credits - debits);
    const side = Math.abs(debits - credits) <= EPS ? '' : debits > credits ? 'Dr' : 'Cr';
    const sources = m.map(r => ({ type: r.type || '', label: entityLabel(r.type), debit: r2(r.debit), credit: r2(r.credit), net: r2(debitNatural ? n0(r.debit) - n0(r.credit) : n0(r.credit) - n0(r.debit)), lines: n0(r.lines), untagged: n0(r.untagged) }))
      .sort((p, q) => Math.abs(q.net) - Math.abs(p.net));
    const zeroRequired = !notZero.has(id) && (zeroIds.has(id) || low(x.type) === 'payment clearing' || pattern.test(String(x.name || '')));
    const contra = CONTRA_PATTERN.test(String(x.name || ''));
    const findings = [];
    const src = !lines ? 'No transactions.' : sources.slice(0, 3).map(s => `${s.label} ${aed(Math.abs(s.net))} ${(s.net >= 0) === debitNatural ? 'Dr' : 'Cr'} (${plural(s.lines, 'line', 'lines')})`).join(' · ') + (sources.length > 3 ? ` · ${sources.length - 3} more` : '');
    let trace = null;

    if (zeroRequired && Math.abs(balance) > EPS) {
      const kind = zeroKind(x.name, x.type), open = a.lines && a.lines[id] ? openEntries(a.lines[id]) : null, net = r2(debits - credits);
      const likely = open ? open.filter(e => Math.abs(Math.abs(e.net) - Math.abs(net)) <= EPS) : [];
      const untaggedOpen = open ? open.filter(e => !idk(e.customer)) : [];
      const journals = open ? open.filter(e => /journal/.test(low(e.type))) : [];
      const cause = Math.abs(net) < TOL ? 'Rounding difference'
        : open && untaggedOpen.length && Math.abs(sum(untaggedOpen, e => e.net) - net) <= TOL && untaggedOpen.length < open.length ? 'Incorrect tagging'
        : open && journals.length && Math.abs(sum(journals, e => e.net) - net) <= TOL ? 'Misallocation' : 'Missing settlement';
      const dir = net > 0 ? 'Dr' : 'Cr', amt = aed(Math.abs(net));
      const fix = cause === 'Rounding difference' ? `Clear the ${amt} rounding difference with a journal to Exchange Gain or Loss.`
        : kind === 'disbursement' ? (net > 0 ? `${amt} paid out for clients has not been recharged: invoice it to the client(s) on ${x.name}, or reclassify it to the company’s own expense account if it is not rechargeable.`
          : `${amt} more was recharged than was paid out: a recharge was booked here without its expense (misallocation) — move it to the right income / client account, or record the missing expense.`)
        : kind === 'clearing' ? (net > 0 ? `${amt} received in ${x.name} has not been transferred out: record the payout to the bank and the fees to their expense account.`
          : `${amt} more was paid out of ${x.name} than came in: record the missing receipt, or move the payout / transfer to the account it belongs to.`)
        : kind === 'undeposited' ? (net > 0 ? `${amt} of receipts are still undeposited: record the deposit into the bank account they went to.` : `${amt} more was deposited than received: remove the duplicate deposit.`)
        : `Reclassify every open entry to its correct account until ${x.name} is back to zero.`;
      trace = open ? { open: open.slice(0, 25).map(e => ({ client: nameOf(e.customer), clientId: idk(e.customer), type: entityLabel(e.type), reference: e.reference || e.entityId || e.txnId || '', date: dayText(e.date), amount: r2(Math.abs(e.net)), side: e.net > 0 ? 'Dr' : 'Cr', likely: likely.includes(e) })),
        openCount: open.length, openDebits: sum(open.filter(e => e.net > 0), e => e.net), openCredits: sum(open.filter(e => e.net < 0), e => -e.net), untagged: untaggedOpen.length, likely: likely.length } : null;
      findings.push({ code: 'ZERO_BALANCE', issue: `Must be zero but holds ${amt} ${dir}.`, cause,
        detail: !open ? 'The transactions behind it could not be read.' : likely.length ? 'Likely cause: ' + list(likely.map(entryText), 3) + '.'
          : `${plural(open.length, 'entry has', 'entries have')} no opposite entry of the same amount` + (open.length ? ' — latest: ' + list(open.map(entryText), 3) : '') + '.' + (untaggedOpen.length ? ` ${plural(untaggedOpen.length, 'open entry has', 'open entries have')} no client tag.` : ''),
        fix });
    }
    if (id === cogsId && (realloc.length || untaggedCogs.length || unfunded.length)) {
      if (realloc.length) findings.push({ code: 'COGS_CLIENT_COSTS', issue: `${plural(realloc.length, 'client cost', 'client costs')} of ${aed(sum(realloc, r => r.amount))} for ${plural(perClient.length, 'client', 'clients')} booked under COGS.`,
        cause: 'Misallocation — costs paid from client funds belong in ' + cfdName + '.', detail: list(perClient.map(p => `${p.client} ${aed(p.amount)}`), 5) + '.', fix: `Reallocate each entry with a journal: Dr ${cfdName} / Cr ${cogsName}, tagged to the client (see the list).` });
      if (untaggedCogs.length) findings.push({ code: 'COGS_UNTAGGED', issue: `${plural(untaggedCogs.length, 'COGS entry has', 'COGS entries have')} no client tag (${aed(sum(untaggedCogs, r => r.amount))}).`, cause: 'Incorrect tagging.',
        detail: list(untaggedCogs.map(r => `${r.type} ${r.reference} (${r.date}) ${aed(r.amount)}`), 3) + '.', fix: 'Tag the client on each entry in Zoho Books, then reallocate the ones paid from client funds.' });
      if (unfunded.length) findings.push({ code: 'COGS_UNFUNDED', issue: `${plural(unfunded.length, 'client-tagged cost', 'client-tagged costs')} of ${aed(sum(unfunded, r => r.amount))} for clients with no funds in ${cfdName}.`, cause: 'Review — recoverable disbursement or true cost.',
        detail: list(unfunded.map(r => `${r.client} ${r.reference} ${aed(r.amount)}`), 3) + '.', fix: 'Invoice the client for the recoverable ones; leave genuine costs of the company in COGS.' });
    }
    if (balance < -EPS && !contra && !findings.some(f => f.code === 'ZERO_BALANCE')) {
      const against = sources.filter(s => s.net < -EPS).slice(0, 2).map(s => `${s.label} ${aed(-s.net)}`).join(', ');
      const fix = -balance < TOL ? `Clear the ${aed(-balance)} rounding difference with a journal to Exchange Gain or Loss.`
        : ['bank', 'cash', 'credit card', 'prepaid card'].includes(low(x.type)) ? `Reconcile ${x.name} with its statement: record the missing transfer in, or move the payment(s) to the account the money really left from.`
        : base === 'asset' ? `Credits exceed debits by ${aed(-balance)}: a receipt or settlement booked here belongs to another account (often income, a liability or another group company) — reclassify it.`
        : base === 'liability' || base === 'equity' ? `Debits exceed credits by ${aed(-balance)}: a payment was booked against ${x.name} without the bill / accrual it settles — record it, or move the payment to the right account.`
        : base === 'income' ? `Debits exceed credits by ${aed(-balance)}: returns, discounts or reversed invoices are booked to income — move them to a contra account or check the reversed invoices.`
        : `Credits exceed debits by ${aed(-balance)}: refunds or recharges booked here exceed the cost — reclassify them to income or the right expense account.`;
      findings.push({ code: 'NEGATIVE', issue: `Negative balance: ${aed(-balance)} ${side} on ${/^[aeiou]/.test(base) ? 'an' : 'a'} ${base || 'unknown'} account.`,
        cause: -balance < TOL ? 'Rounding difference' : 'Postings on the wrong side or to the wrong account.', detail: against ? 'Mostly from ' + against + '.' : '', fix });
    }
    const active = !(low(x.active) === 'no' || low(x.active) === 'false' || x.active === false);
    if (!active && Math.abs(balance) > EPS) findings.push({ code: 'INACTIVE_BALANCE', issue: `Inactive account carries ${aed(Math.abs(balance))} ${side}.`, cause: 'Balance left on an account no longer in use.', detail: '', fix: `Move the balance to the account that replaced ${x.name} with a journal.` });
    // Every line on the client fund account must name its client (COGS has its own finding above).
    if (id === cfdId && untagged > 0) findings.push({ code: 'MISSING_TAGS', issue: `${plural(untagged, 'line has', 'lines have')} no client tag.`, cause: 'Incorrect tagging.', detail: 'Listed per entry in the client account audit (No client tag).', fix: 'Tag the client on each line in Zoho Books.' });

    // A finding that needs no balance change (missing tags, a cost to confirm) leaves the balance expected.
    const unexpected = findings.some(f => f.code !== 'MISSING_TAGS' && f.code !== 'COGS_UNFUNDED');
    return { id, name: x.name || id, code: x.code || '', type: x.type || '', base: x.base || '', active,
      debits, credits, balance, side, balanceText: Math.abs(balance) <= EPS ? aed(0) : `${aed(Math.abs(debits - credits))} ${side}`, lines, untagged,
      zeroRequired, contra, status: unexpected ? 'UNEXPECTED' : 'EXPECTED', statusText: unexpected ? 'Unexpected' : 'Expected',
      source: src, sources, findings, corrections: findings.map(f => f.fix).join(' '), trace,
      realloc: id === cogsId ? { entries: realloc, perClient, untagged: untaggedCogs, unfunded } : null };
  }).sort((p, q) => (p.status === 'UNEXPECTED' ? 0 : 1) - (q.status === 'UNEXPECTED' ? 0 : 1) || Math.abs(q.balance) - Math.abs(p.balance) || p.name.localeCompare(q.name));

  const zero = accounts.filter(x => x.zeroRequired);
  return {
    summary: { accounts: accounts.length, withActivity: accounts.filter(x => x.lines > 0).length, unexpected: accounts.filter(x => x.status === 'UNEXPECTED').length,
      zeroAccounts: zero.length, zeroBreached: zero.filter(x => Math.abs(x.balance) > EPS).length, negative: accounts.filter(x => x.findings.some(f => f.code === 'NEGATIVE')).length,
      cogsRealloc: { count: realloc.length, amount: sum(realloc, r => r.amount), clients: perClient.length }, cogsUntagged: untaggedCogs.length },
    accounts,
    reallocation: { entries: realloc, perClient, untagged: untaggedCogs, unfunded }
  };
}
