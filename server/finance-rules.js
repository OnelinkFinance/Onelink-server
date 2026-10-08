// The three financial checks every funding request must pass before it can reach Sven.
// Pure: the caller passes in live Zoho data, this decides. Nothing here talks to Zoho or grants approval.
//
//   A. Customer Fund Disbursement account (Books account 7050654000000685179): the client's CFD balance
//      (Zoho Analytics "CFD Customer Balances") covers the amount.
//   B. Cost of Goods Sold account (Books account 7050654000000034003): the client has paid funds into CFD,
//      the costs booked to COGS for the client are covered by what the client paid, every entry is tagged to
//      the client in Zoho Books, and Analytics raises no negative-balance (COGS) alert.
//   C. Invoice payment verification (Zoho Books): Operations say the client paid, a customer payment is on file,
//      payments are applied to the invoices, no invoice is unpaid or overdue, and no payment was refunded
//      while dues are still open. A deleted or reversed payment re-opens its invoice, so it shows up as a due.
//
// Every check and item carries `message` / `text` that is safe to show Operations (no amounts), and `detail`
// with the figures, which the server strips before anything reaches a restricted Operations user.

export const CHECKS = { CFD: 'Customer Fund Disbursement account', COGS: 'Cost of Goods Sold account', INVOICES: 'Invoice payment verification' };
export const PAID_OK = ['Yes — in full', 'Using existing credits'];
export const OPS_INSUFFICIENT = 'Client does not have sufficient balance to request funds. Please contact Sven.';
const EPS = 0.005;

const aed = n => 'AED ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const item = (label, ok, text, detail) => (detail ? { label, ok, text, detail } : { label, ok, text });

// books: live Zoho Books contact { contactId, contactName, status, outstanding }
// rec:   its "CFD Customer Balances" row { available, allocated (credits), used (debits), status, alert } — null = none
// split: per-account totals for the client { cfd: { credits, debits, lines, untagged }, cogs: { ... } } — null = no entries
// open:  the client's unpaid invoices [{ invoice, status, due, total, balance }]
// pay:   the client's customer payments { payments, received, unapplied, refunded, last } — null = none
export function evaluateFinance({ amount, paid, books, rec, split, open, pay }) {
  amount = n0(amount);
  const cfd = (split && split.cfd) || { credits: 0, debits: 0, lines: 0, untagged: 0 };
  const cogs = (split && split.cogs) || { credits: 0, debits: 0, lines: 0, untagged: 0 };
  open = Array.isArray(open) ? open : [];
  const checks = [];

  // A — Customer Fund Disbursement account
  {
    const avail = rec ? n0(rec.available) : 0;
    const items = [
      item('Client record in the CFD ledger', !!rec, rec ? 'Found in Zoho Analytics (CFD Customer Balances)' : 'No Customer Fund Disbursement record for this client'),
      item('Available balance covers the request', !!rec && avail > 0 && avail + EPS >= amount, !!rec && avail > 0 && avail + EPS >= amount ? 'Sufficient' : 'Not sufficient',
        `Available ${aed(avail)} · requested ${aed(amount)}` + (rec ? ` · credits ${aed(rec.allocated)} · debits ${aed(rec.used)}` + (rec.status ? ` · ${rec.status}` : '') : ''))
    ];
    const ok = items.every(i => i.ok);
    checks.push({ key: 'CFD', label: CHECKS.CFD, ok, code: !rec ? 'CFD_NO_RECORD' : ok ? 'CFD_OK' : 'CFD_INSUFFICIENT',
      message: ok ? 'Client funds are available in the Customer Fund Disbursement account.' : 'Client does not have sufficient balance to request funds.',
      detail: `CFD balance ${aed(avail)} against ${aed(amount)} requested.`, items });
  }

  // B — Cost of Goods Sold account
  {
    const received = split ? n0(cfd.credits) : (rec ? n0(rec.allocated) : 0);
    const cogsNet = n0(cogs.debits) - n0(cogs.credits);
    const untagged = n0(cfd.untagged) + n0(cogs.untagged);
    const items = [
      item('Client payment received', received > EPS, received > EPS ? 'Client funds received into the CFD account' : 'No client payment recorded in the CFD account', `Received ${aed(received)}`),
      item('Costs booked to COGS are covered', cogsNet <= received + EPS, cogsNet <= received + EPS ? 'Covered by what the client paid' : 'Costs booked to COGS exceed what the client paid', `COGS ${aed(cogsNet)} against ${aed(received)} received`),
      item('Entries mapped to the client in Zoho Books', untagged === 0, untagged === 0 ? 'Every CFD and COGS entry is tagged to this client' : plural(untagged, 'entry is', 'entries are') + ' matched only by reference — not tagged to the client in Zoho Books'),
      item('No negative-balance alert', !(rec && rec.alert), rec && rec.alert ? 'Zoho Analytics flags a negative balance for this client' : 'No alert in Zoho Analytics', rec && rec.alert ? String(rec.alert) : ''),
      item('COGS entries on file', true, n0(cogs.lines) ? plural(n0(cogs.lines), 'COGS entry', 'COGS entries') + ' for this client' : 'No COGS entry yet — first disbursement for this client')
    ];
    const ok = items.every(i => i.ok);
    const code = !items[0].ok ? 'COGS_NO_PAYMENT' : !items[1].ok ? 'COGS_EXCEEDS_PAYMENTS' : !items[2].ok ? 'COGS_UNMAPPED' : !items[3].ok ? 'COGS_ALERT' : 'COGS_OK';
    checks.push({ key: 'COGS', label: CHECKS.COGS, ok, code,
      message: ok ? 'Client payment received and the costs booked to COGS are covered.' : items.find(i => !i.ok).text + '.',
      detail: `CFD credits ${aed(cfd.credits)}, debits ${aed(cfd.debits)} · COGS debits ${aed(cogs.debits)}, credits ${aed(cogs.credits)}.`, items });
  }

  // C — Invoice payment verification
  {
    const answer = String(paid || '').trim();
    const outstanding = open.reduce((a, i) => a + n0(i.balance), 0);
    const liveDue = books ? n0(books.outstanding) : 0;
    const p = pay || { payments: 0, received: 0, unapplied: 0, refunded: 0, last: '' };
    const dues = open.length > 0 || liveDue > EPS;
    const nums = open.slice(0, 5).map(i => i.invoice).filter(Boolean).join(', ') + (open.length > 5 ? ', …' : '');
    const items = [
      item('Operations: client already paid us?', PAID_OK.includes(answer), answer ? `Operations answered “${answer}”` : 'Operations did not answer'),
      item('Customer payment received in Zoho Books', n0(p.payments) > 0 && n0(p.received) > EPS,
        n0(p.payments) > 0 && n0(p.received) > EPS ? plural(n0(p.payments), 'payment', 'payments') + ' on file' + (p.last ? ', last on ' + p.last : '') : 'No customer payment recorded in Zoho Books',
        `Received ${aed(p.received)}`),
      item('Payments applied to the invoices', !(n0(p.unapplied) > EPS && dues), n0(p.unapplied) > EPS && dues ? 'A payment is recorded but not applied to the open invoice' : 'Payments are applied to the client’s invoices',
        n0(p.unapplied) > EPS ? `Unapplied ${aed(p.unapplied)}` : ''),
      item('No outstanding dues', !dues,
        open.length ? plural(open.length, 'invoice is', 'invoices are') + ' unpaid or overdue (' + nums + ')' : liveDue > EPS ? 'Zoho Books shows an outstanding receivable for this client' : 'No unpaid or overdue invoices',
        dues ? `Outstanding ${aed(Math.max(outstanding, liveDue))}` + (open.length ? ' · ' + open.slice(0, 5).map(i => `${i.invoice} ${aed(i.balance)}${i.status ? ' (' + i.status + ')' : ''}`).join(', ') : '') : ''),
      item('No reversed or deleted payments', !(n0(p.refunded) > EPS && dues), n0(p.refunded) > EPS && dues ? 'A refund was recorded while invoices are still unpaid' : 'None found — a deleted or reversed payment re-opens its invoice',
        n0(p.refunded) > EPS ? `Refunded ${aed(p.refunded)}` : '')
    ];
    const ok = items.every(i => i.ok);
    // The most specific failure names the check: a refund while dues are open is a reversal, not just a due.
    const order = [[0, 'DECLARED_UNPAID'], [1, 'NO_CUSTOMER_PAYMENT'], [4, 'PAYMENT_REVERSED'], [2, 'PAYMENT_NOT_APPLIED'], [3, 'OUTSTANDING_DUES']];
    const first = order.find(([i]) => !items[i].ok);
    const code = first ? first[1] : 'INVOICES_OK';
    checks.push({ key: 'INVOICES', label: CHECKS.INVOICES, ok, code,
      message: ok ? 'Payment received, applied to the invoices, and no dues outstanding.' : items[first[0]].text + '.',
      detail: `Payments ${n0(p.payments)} · received ${aed(p.received)} · unapplied ${aed(p.unapplied)} · refunded ${aed(p.refunded)} · open invoices ${open.length} (${aed(outstanding)}) · Books receivable ${aed(liveDue)}.`, items });
  }

  for (const c of checks) for (const i of c.items) if (!i.detail) delete i.detail;
  const failed = checks.filter(c => !c.ok);
  return {
    ok: failed.length === 0, amount, checks,
    failed: failed.map(c => ({ key: c.key, label: c.label, message: c.message })),
    // Headline. Operations never see amounts; when the CFD check fails they get the exact wording Sven asked for.
    opsError: !failed.length ? '' : failed.some(c => c.key === 'CFD') ? OPS_INSUFFICIENT
      : `The request cannot be submitted — ${failed.map(c => c.label).join(' and ')} check${failed.length > 1 ? 's' : ''} failed. You can escalate it to management.`,
    staffError: !failed.length ? '' : failed.map(c => `${c.label}: ${c.message} ${c.detail}`).join(' ')
  };
}

// The copy a restricted Operations user may receive: no detail lines, no figures.
export function financeForOps(f) {
  if (!f || typeof f !== 'object') return f;
  const strip = o => { const { detail, ...rest } = o; return rest; };
  return { ...f, checks: (f.checks || []).map(c => ({ ...strip(c), items: (c.items || []).map(strip) })) };
}
