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
//      B also requires every settled invoice to be covered by a payment or credit note (no invoice/payment mismatch).
// Every check and item carries `message` / `text` that is safe to show Operations (no amounts), and `detail`
// with the figures, which the server strips before anything reaches a restricted Operations user.

export const CHECKS = { CFD: 'Customer Fund Disbursement account', COGS: 'Cost of Goods Sold account', INVOICES: 'Invoice payment verification' };
// 'Client already paid us?' is Yes / No; the older answers on requests from before count as Yes.
export const PAID_OK = ['Yes', 'Yes — in full', 'Using existing credits'];
// Operations-facing headline when the balance is insufficient (Zoho Analytics, and Zoho Books cross-verification).
export const OPS_INSUFFICIENT = 'Client does not have sufficient balance. You may escalate to Management.';
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
// committed: { amount, count } already approved or credited for this client on the platform and not yet booked in the
//            ledger — it comes off the CFD balance, so two requests cannot both be approved against the same funds.
// grouped: the contact is one of several Books contacts folded onto one client — its own live receivable does not
//          cover the others' invoices, so the Analytics list counts too.
// inv:   the client's invoice settlement { invoices, invoiced, outstanding, writtenOff, paid, credited } — null = could not be read
export function evaluateFinance({ amount, paid, books, rec, split, open, pay, committed, grouped, inv }) {
  amount = n0(amount);
  const held = committed ? n0(committed.amount) : 0, heldN = committed ? n0(committed.count) : 0;
  const cfd = (split && split.cfd) || { credits: 0, debits: 0, lines: 0, untagged: 0 };
  const cogs = (split && split.cogs) || { credits: 0, debits: 0, lines: 0, untagged: 0 };
  open = Array.isArray(open) ? open : [];
  const checks = [];

  // A — Customer Fund Disbursement account
  {
    const ledger = rec ? n0(rec.available) : 0, avail = ledger - held;
    const items = [
      item('Client record in the CFD ledger', !!rec, rec ? 'Found in Zoho Analytics (CFD Customer Balances)' : 'No Customer Fund Disbursement record for this client'),
      item('Available balance covers the request', !!rec && avail > 0 && avail + EPS >= amount, !!rec && avail > 0 && avail + EPS >= amount ? 'Sufficient' : 'Not sufficient',
        `Available ${aed(avail)}` + (held ? ` (ledger ${aed(ledger)} less ${aed(held)} already approved on ${plural(heldN, 'request', 'requests')})` : '') + ` · requested ${aed(amount)}`
          + (rec ? ` · credits ${aed(rec.allocated)} · debits ${aed(rec.used)}` + (rec.status ? ` · ${rec.status}` : '') : ''))
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
      // Invoices marked paid must be covered by payments or credit notes applied to them (write-offs and open balances aside).
      (() => {
        if (!inv) return item('Invoices match payments', false, 'Invoice settlement could not be read from Zoho Analytics');
        const settled = n0(inv.invoiced) - n0(inv.outstanding) - n0(inv.writtenOff), covered = n0(inv.paid) + n0(inv.credited), gap = settled - covered;
        return item('Invoices match payments', gap <= 1, !n0(inv.invoices) ? 'No invoices for this client yet' : gap <= 1 ? 'Every settled invoice has a matching payment or credit note' : 'Invoices are marked paid without a matching payment in Zoho Books',
          `Settled ${aed(settled)} · payments ${aed(inv.paid)} · credit notes ${aed(inv.credited)}` + (gap > 1 ? ` · unmatched ${aed(gap)}` : ''));
      })(),
      item('No negative-balance alert', !(rec && rec.alert), rec && rec.alert ? 'Zoho Analytics flags a negative balance for this client' : 'No alert in Zoho Analytics', rec && rec.alert ? String(rec.alert) : ''),
      item('COGS entries on file', true, n0(cogs.lines) ? plural(n0(cogs.lines), 'COGS entry', 'COGS entries') + ' for this client' : 'No COGS entry yet — first disbursement for this client')
    ];
    const ok = items.every(i => i.ok);
    const code = !items[0].ok ? 'COGS_NO_PAYMENT' : !items[1].ok ? 'COGS_EXCEEDS_PAYMENTS' : !items[2].ok ? 'COGS_UNMAPPED' : !items[3].ok ? 'INVOICE_PAYMENT_MISMATCH' : !items[4].ok ? 'COGS_ALERT' : 'COGS_OK';
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
    // The live Books contact decides whether anything is owed (Analytics syncs from Books with a delay: an invoice paid
    // a minute ago can still look open there). The Analytics invoice list only names the invoices — unless the contact is
    // one of a group of duplicates, whose other members' invoices its own receivable does not include.
    const dues = books && !grouped ? liveDue > EPS : open.length > 0 || liveDue > EPS;
    if (!dues) open = [];
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

// ---------------------------------------------------------------------------------------------------------------
// Zoho Books cross-verification. Runs only when the Zoho Analytics CFD check did not cover the request (no record,
// zero, or insufficient): the live Zoho Books ledger may hold movements Analytics has not synced yet. Five checks,
// all of which must pass. Missing or unreadable Books data never passes a check and never counts as money.
export const CROSS_CHECKS = { CFD: CHECKS.CFD, COGS: CHECKS.COGS, NOTES: 'Credit notes / debit notes', JOURNALS: 'Journals', INVOICES: CHECKS.INVOICES };
export const BOOKS_FAIL = 'Zoho Books cross-verification could not be completed';
const PENDING = ['draft', 'pending_approval', 'submitted'];
const low = v => String(v ?? '').trim().toLowerCase();
const idk = v => String(v ?? '').trim().replace(/\.0+$/, '');
// A Books amount: a number, or null when the field is missing / not a number (unknown — never counted as available).
const amt = v => { if (v === null || v === undefined || String(v).trim() === '') return null; const x = Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : null; };
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sum = (list, f) => Math.round(list.reduce((a, x) => a + (Number(f(x)) || 0), 0) * 100) / 100;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// 'YYYY-MM-DD' from the date formats Zoho exports ('2026-10-07 09:03:00', '07 Oct 2026', 'Oct 07, 2026'); null if unknown.
export function parseDay(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return ymd(m[1], m[2], m[3]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ ,-]+(\d{4})/.exec(s);
  if (m && MON[m[2].toLowerCase()]) return ymd(m[3], MON[m[2].toLowerCase()], m[1]);
  m = /^([A-Za-z]{3})[A-Za-z]* (\d{1,2}),? (\d{4})/.exec(s);
  if (m && MON[m[1].toLowerCase()]) return ymd(m[3], MON[m[1].toLowerCase()], m[2]);
  return null;
}
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Books window: the day of the Analytics watermark (newest "Last Modified Time") less two days, at most 45 days back.
export function crossCheckWindow(watermark, today) {
  const floor = addDays(today, -45), w = parseDay(watermark);
  if (!w) return floor;
  const start = addDays(w, -2);
  return start < floor ? floor : start > today ? addDays(today, -2) : start;
}

// a: {
//   amount, paid, committed, rec, split, inv, pay   — as evaluateFinance (Zoho Analytics)
//   contact:  live Books contact { contactId, contactName, companyName, outstanding }
//   ids:      every Books contact id that is this client (picked, canonical, aliases of the canonical one)
//   names:    the client's contact / company names (matched as whole words, names of 5+ characters)
//   accounts: { cfd, cogs } Books account ids
//   recent:   { lines: [{ customer, account, entityId, txnId, type, credit, debit, date }], watermark } | null — Analytics
//             "CFD Customer Resolved" lines of the last 45 days (every customer), customer already canonical
//   windowStart: 'YYYY-MM-DD' — the Books transactions below start here
//   books: { cfdTx, cogsTx, creditnotes, invoices, payments: { ok, rows, truncated }, journals: { ok, rows, truncated, details: { id: line_items } } }
// }
export function evaluateBooksCrossCheck(a) {
  const amount = n0(a.amount), since = a.windowStart || '0000-00-00';
  const { paid, contact, rec, split, inv, pay, committed } = a;
  const held = committed ? n0(committed.amount) : 0, heldN = committed ? n0(committed.count) : 0;
  const zero = { credits: 0, debits: 0, lines: 0, untagged: 0 };
  const cfdA = (split && split.cfd) || zero, cogsA = (split && split.cogs) || zero;
  const ids = new Set((a.ids || []).map(idk).filter(Boolean));
  const names = [...new Set((a.names || []).map(words).filter(n => n.length >= 5))];
  const acc = a.accounts || {}, src = a.books || {};
  const readable = s => !!(s && s.ok && Array.isArray(s.rows));
  const lines = a.recent && Array.isArray(a.recent.lines) ? a.recent.lines : null;
  const checks = [];

  // A Books row is this client's when its customer is one of the client's contacts. Only a row with no customer at all
  // is matched by name (payee / reference / description) — a row tagged to another customer is never this client's.
  const belongs = t => {
    if (!t || typeof t !== 'object') return false;
    const c = idk(t.customer_id);
    if (c) return ids.has(c);
    if (!names.length) return false;
    const text = ' ' + words([t.payee, t.reference_number, t.description].join(' ')) + ' ';
    return names.some(n => text.includes(' ' + n + ' '));
  };
  const ledgerIds = new Set();
  for (const l of lines || []) for (const x of [l.entityId, l.txnId]) if (idk(x)) ledgerIds.add(idk(x));
  const txIds = t => [idk(t.transaction_id), idk(t.categorized_transaction_id)].filter(Boolean);
  const cr = t => Math.max(0, amt(t.credit_amount) || 0), dr = t => Math.max(0, amt(t.debit_amount) || 0);

  // One account (CFD or COGS): Books movements Analytics has not synced, and Analytics lines Books no longer has.
  function account(s, accountId) {
    if (!lines) return { ok: false, why: 'the Zoho Analytics ledger lines could not be read' };
    if (!readable(s)) return { ok: false, why: 'the Zoho Books account transactions could not be read' + (s && s.error ? ' (' + s.error + ')' : '') };
    if (s.truncated) return { ok: false, why: 'Zoho Books returned more transactions than one check reads — deletions and unsynced movements cannot be confirmed' };
    const mine = s.rows.filter(belongs);
    const unsynced = mine.filter(t => !txIds(t).some(x => ledgerIds.has(x)));
    const unknown = unsynced.filter(t => amt(t.credit_amount) === null && amt(t.debit_amount) === null);
    if (unknown.length) return { ok: false, why: plural(unknown.length, 'unsynced transaction has', 'unsynced transactions have') + ' no amount in Zoho Books' };
    const inBooks = new Set(s.rows.flatMap(t => (t && typeof t === 'object' ? txIds(t) : [])));
    let undated = 0;
    const deleted = lines.filter(l => idk(l.account) === idk(accountId) && ids.has(idk(l.customer))).filter(l => {
      const d = parseDay(l.date);
      if (!d) { undated++; return false; }
      if (d < since) return false;
      const own = [idk(l.entityId), idk(l.txnId)].filter(Boolean);
      return own.length > 0 && !own.some(x => inBooks.has(x));
    });
    return { ok: true, mine, unsynced, deleted, undated,
      inU: sum(unsynced, cr), outU: sum(unsynced, dr), inD: sum(deleted, l => Math.max(0, n0(l.credit))), outD: sum(deleted, l => Math.max(0, n0(l.debit))) };
  }
  const unavailable = (key, why) => ({ key, label: CROSS_CHECKS[key], ok: false, code: 'BOOKS_UNAVAILABLE', message: BOOKS_FAIL + '.', detail: why, items: [item('Zoho Books cross-verification', false, BOOKS_FAIL, why)] });

  const C = account(src.cfdTx, acc.cfd), G = account(src.cogsTx, acc.cogs);
  const cnOk = readable(src.creditnotes) && !src.creditnotes.truncated, ivOk = readable(src.invoices) && !src.invoices.truncated, pyOk = readable(src.payments);
  // Credit notes already posted to the CFD / COGS ledger (Analytics, or the Books window) are in the balance — never added twice.
  const posted = new Set([...ledgerIds, ...(readable(src.cfdTx) ? src.cfdTx.rows.flatMap(t => (t ? txIds(t) : [])) : []), ...(readable(src.cogsTx) ? src.cogsTx.rows.flatMap(t => (t ? txIds(t) : [])) : [])]);
  const cns = cnOk ? src.creditnotes.rows.filter(x => x && typeof x === 'object') : [];
  const cnOpenAll = cns.filter(c => low(c.status) === 'open' && (amt(c.balance) || 0) > EPS);
  const cnPosted = cnOpenAll.filter(c => posted.has(idk(c.creditnote_id)));
  const cnOpenRows = cnOpenAll.filter(c => !posted.has(idk(c.creditnote_id)));
  const cnOpen = sum(cnOpenRows, c => amt(c.balance));
  const cnPending = cns.filter(c => PENDING.includes(low(c.status)));
  const ivs = ivOk ? src.invoices.rows.filter(x => x && typeof x === 'object') : [];
  const isDN = r => low(r.type) === 'debit_note';
  const dns = ivs.filter(isDN), invs = ivs.filter(r => !isDN(r)); // a row without a type counts as an invoice (a due), never as a note
  const dnPending = dns.filter(r => PENDING.includes(low(r.status)));
  const dnLive = dns.filter(r => !PENDING.includes(low(r.status)) && !['void', 'paid'].includes(low(r.status)));
  const dnUnknown = dnLive.filter(r => amt(r.balance) === null).length;
  const dnOpenRows = dnLive.filter(r => (amt(r.balance) || 0) > EPS), dnOpen = sum(dnOpenRows, r => amt(r.balance));
  // Live open invoices: not draft / pending / void / paid, and a balance above zero (an unknown balance counts as open).
  const openInv = invs.filter(r => { const st = low(r.status); if (PENDING.includes(st) || ['void', 'paid'].includes(st)) return false; const b = amt(r.balance); return b === null || b > EPS; });
  const receivable = contact ? amt(contact.outstanding) : null;
  const dues = openInv.length > 0 || receivable === null || receivable > EPS;
  const nums = list => list.slice(0, 5).map(r => r.invoice_number || r.creditnote_number || '').filter(Boolean).join(', ') + (list.length > 5 ? ', …' : '');

  // A — Customer Fund Disbursement account, Books live
  let available = null;
  {
    const ready = C.ok && cnOk && ivOk && !dnUnknown;
    if (!ready) checks.push(unavailable('CFD', !C.ok ? 'CFD account: ' + C.why : !cnOk ? 'Credit notes could not be read from Zoho Books.' : !ivOk ? 'Invoices / debit notes could not be read from Zoho Books.' : 'A debit note has no balance in Zoho Books.'));
    else {
      // The Analytics ledger balance: the lower of the balance table and the ledger lines read with the recent lines
      // (the same snapshot), so a movement synced in between is never counted from Analytics and Books both.
      const splitNet = n0(cfdA.credits) - n0(cfdA.debits), ledger = Math.min(rec ? n0(rec.available) : 0, splitNet);
      const net = Math.round((ledger + (C.inU - C.outU) - (C.inD - C.outD) + cnOpen - dnOpen - held) * 100) / 100;
      available = net;
      const enough = net > 0 && net + EPS >= amount;
      const disb = n0(cfdA.debits) + C.outU;
      const items = [
        item('Funds available (Zoho Books live)', enough, enough ? 'Sufficient' : 'Not sufficient',
          `Available ${aed(net)} = Analytics ledger ${aed(ledger)}` + (rec ? '' : ' (no CFD Customer Balances record)') + ` + ${plural(C.unsynced.length, 'unsynced Books movement', 'unsynced Books movements')} ${aed(C.inU - C.outU)}`
          + ` − ${plural(C.deleted.length, 'Analytics line', 'Analytics lines')} deleted in Books ${aed(C.inD - C.outD)} + open credit notes ${aed(cnOpen)} − open debit notes ${aed(dnOpen)}`
          + (held ? ` − ${aed(held)} already approved on ${plural(heldN, 'request', 'requests')}` : '') + ` · requested ${aed(amount)}`
          + (rec && Math.abs(n0(rec.available) - splitNet) > EPS ? ` · balance table ${aed(rec.available)}, ledger lines ${aed(splitNet)}` : '')
          + (C.undated ? ` · ${plural(C.undated, 'Analytics line', 'Analytics lines')} without a readable date skipped for deletion checks` : '')),
        item('Disbursements made for the client', true, disb > EPS ? 'Disbursements are recorded for this client' : 'No disbursement recorded yet',
          `Debits ${aed(cfdA.debits)} in Zoho Analytics + ${aed(C.outU)} not yet synced`),
        item('No unpaid disbursements', !dues, !dues ? 'Zoho Books shows no outstanding receivable' : 'Zoho Books shows an outstanding receivable for this client',
          `Books receivable ${receivable === null ? 'unknown' : aed(receivable)} · ${plural(openInv.length, 'open invoice', 'open invoices')}`)
      ];
      const code = !enough ? (!rec && !C.unsynced.length ? 'CFD_NO_RECORD' : 'CFD_INSUFFICIENT') : dues ? 'CFD_UNPAID' : 'CFD_OK';
      checks.push({ key: 'CFD', label: CROSS_CHECKS.CFD, ok: code === 'CFD_OK', code,
        message: code === 'CFD_OK' ? 'Client funds are available in the Customer Fund Disbursement account (Zoho Books live).' : !enough ? 'Client does not have sufficient balance to request funds.' : 'Zoho Books shows unpaid disbursements for this client.',
        detail: `Zoho Books live CFD balance ${aed(net)} against ${aed(amount)} requested.`, items });
    }
  }

  // B — Cost of Goods Sold account, with the unsynced Books movements
  if (!(C.ok && G.ok)) checks.push(unavailable('COGS', !C.ok ? 'CFD account: ' + C.why : 'COGS account: ' + G.why));
  else {
    const received = (split ? n0(cfdA.credits) : rec ? n0(rec.allocated) : 0) + C.inU - C.inD;
    const cogsNet = n0(cogsA.debits) - n0(cogsA.credits) + (G.outU - G.inU) - (G.outD - G.inD);
    const untagged = n0(cfdA.untagged) + n0(cogsA.untagged);
    const items = [
      item('Client paid for the goods / services', received > EPS, received > EPS ? 'Client funds received into the CFD account' : 'No client payment recorded in the CFD account', `Received ${aed(received)} (incl. ${aed(C.inU)} not yet synced)`),
      (() => {
        if (!inv) return item('COGS entries match invoices', false, 'Invoice settlement could not be read from Zoho Analytics');
        const settled = n0(inv.invoiced) - n0(inv.outstanding) - n0(inv.writtenOff), covered = n0(inv.paid) + n0(inv.credited), gap = settled - covered;
        return item('COGS entries match invoices', gap <= 1, !n0(inv.invoices) ? 'No invoices for this client yet' : gap <= 1 ? 'Every settled invoice has a matching payment or credit note' : 'Invoices are marked paid without a matching payment in Zoho Books',
          `Settled ${aed(settled)} · payments ${aed(inv.paid)} · credit notes ${aed(inv.credited)}` + (gap > 1 ? ` · unmatched ${aed(gap)}` : ''));
      })(),
      item('No COGS entry indicating an unpaid obligation', cogsNet <= received + EPS, cogsNet <= received + EPS ? 'Costs booked to COGS are covered by what the client paid' : 'Costs booked to COGS exceed what the client paid',
        `COGS ${aed(cogsNet)} (incl. ${aed(G.outU - G.inU)} not yet synced) against ${aed(received)} received`),
      item('Entries mapped to the client in Zoho Books', untagged === 0, untagged === 0 ? 'Every CFD and COGS entry is tagged to this client' : plural(untagged, 'entry is', 'entries are') + ' matched only by reference — not tagged to the client in Zoho Books'),
      item('No negative-balance alert', !(rec && rec.alert), rec && rec.alert ? 'Zoho Analytics flags a negative balance for this client' : 'No alert in Zoho Analytics', rec && rec.alert ? String(rec.alert) : '')
    ];
    const order = [[0, 'COGS_NO_PAYMENT'], [2, 'COGS_EXCEEDS_PAYMENTS'], [3, 'COGS_UNMAPPED'], [1, 'INVOICE_PAYMENT_MISMATCH'], [4, 'COGS_ALERT']];
    const first = order.find(([i]) => !items[i].ok);
    checks.push({ key: 'COGS', label: CROSS_CHECKS.COGS, ok: !first, code: first ? first[1] : 'COGS_OK',
      message: !first ? 'Client payment received and the costs booked to COGS are covered (Zoho Books live).' : items[first[0]].text + '.',
      detail: `CFD credits ${aed(received)} · COGS net ${aed(cogsNet)} · unsynced COGS movements ${G.unsynced.length}, deleted ${G.deleted.length}.`, items });
  }

  // C — credit notes / debit notes
  if (!cnOk || !ivOk) checks.push(unavailable('NOTES', !cnOk ? 'Credit notes could not be read from Zoho Books' + (src.creditnotes && src.creditnotes.truncated ? ' (more than one check reads)' : '') + '.' : 'Invoices / debit notes could not be read from Zoho Books' + (src.invoices && src.invoices.truncated ? ' (more than one check reads)' : '') + '.'));
  else {
    const pend = cnPending.length + dnPending.length;
    const items = [
      item('Open credit notes', true, cnOpenRows.length ? plural(cnOpenRows.length, 'open credit note adds', 'open credit notes add') + ' to the balance' : 'No open credit note to add',
        `Open ${aed(cnOpen)}` + (cnOpenRows.length ? ' (' + cnOpenRows.slice(0, 5).map(c => `${c.creditnote_number || c.creditnote_id} ${aed(amt(c.balance))}`).join(', ') + ')' : '') + (cnPosted.length ? ` · ${plural(cnPosted.length, 'credit note', 'credit notes')} already in the CFD ledger, not added again` : '')),
      item('Open debit notes', true, dnOpenRows.length ? plural(dnOpenRows.length, 'open debit note reduces', 'open debit notes reduce') + ' the balance' : 'No open debit note',
        dnOpenRows.length ? `Open ${aed(dnOpen)} (` + dnOpenRows.slice(0, 5).map(r => `${r.invoice_number || r.invoice_id} ${aed(amt(r.balance))}`).join(', ') + ')' : ''),
      item('No credit or debit note awaiting approval', pend === 0, pend === 0 ? 'No draft or pending credit / debit note for this client'
        : [cnPending.length ? plural(cnPending.length, 'credit note', 'credit notes') : '', dnPending.length ? plural(dnPending.length, 'debit note', 'debit notes') : ''].filter(Boolean).join(' and ') + ' in draft / pending approval',
        pend ? [...cnPending, ...dnPending].slice(0, 5).map(r => r.creditnote_number || r.invoice_number || r.creditnote_id || r.invoice_id).join(', ') : '')
    ];
    checks.push({ key: 'NOTES', label: CROSS_CHECKS.NOTES, ok: pend === 0, code: pend ? 'NOTES_PENDING' : 'NOTES_OK',
      message: pend ? items[2].text + '.' : 'No credit or debit note is waiting for approval.',
      detail: `Credit notes ${cns.length} (open ${aed(cnOpen)}) · debit notes ${dns.length} (open ${aed(dnOpen)}).`, items });
  }

  // D — journals
  {
    const J = src.journals;
    const jRows = readable(J) ? J.rows.filter(x => x && typeof x === 'object') : [];
    const pend = jRows.filter(j => PENDING.includes(low(j.status)));
    const details = (J && J.details) || {};
    const unread = pend.filter(j => !Array.isArray(details[idk(j.journal_id)]));
    if (!readable(J) || J.truncated) checks.push(unavailable('JOURNALS', 'Journals could not be read from Zoho Books' + (J && J.truncated ? ' (more than one check reads)' : '') + '.'));
    else if (unread.length) checks.push(unavailable('JOURNALS', `${plural(unread.length, 'draft journal', 'draft journals')} could not be inspected in Zoho Books.`));
    else if (!(C.ok && G.ok)) checks.push(unavailable('JOURNALS', !C.ok ? 'CFD account: ' + C.why : 'COGS account: ' + G.why));
    else {
      const affecting = pend.filter(j => details[idk(j.journal_id)].some(belongs));
      const isJ = v => /journal/i.test(String(v || ''));
      const delJ = [...C.deleted, ...G.deleted].filter(l => isJ(l.type));
      const unsyncedJ = [...C.unsynced, ...G.unsynced].filter(t => isJ(t.transaction_type));
      const items = [
        item('No journal awaiting approval', !affecting.length, affecting.length ? plural(affecting.length, 'journal for this client is', 'journals for this client are') + ' in draft / pending approval' : 'No draft or pending journal for this client',
          affecting.length ? affecting.slice(0, 5).map(j => j.entry_number || j.journal_id).join(', ') : ''),
        item('Journals match Zoho Analytics', !delJ.length, delJ.length ? 'A journal line in Zoho Analytics was deleted or reversed in Zoho Books' : 'No journal difference left unexplained',
          delJ.length ? delJ.slice(0, 5).map(l => `${l.entityId || l.txnId} credit ${aed(l.credit)} debit ${aed(l.debit)}`).join(', ') : ''),
        item('Journal movements not yet in Zoho Analytics', true, unsyncedJ.length ? plural(unsyncedJ.length, 'journal movement is', 'journal movements are') + ' counted from Zoho Books' : 'None',
          unsyncedJ.length ? unsyncedJ.slice(0, 5).map(t => `${t.reference_number || t.transaction_id} ${t.transaction_date || ''} credit ${aed(cr(t))} debit ${aed(dr(t))}`).join(', ') : '')
      ];
      const code = affecting.length ? 'JOURNAL_PENDING' : delJ.length ? 'JOURNAL_MISMATCH' : 'JOURNALS_OK';
      checks.push({ key: 'JOURNALS', label: CROSS_CHECKS.JOURNALS, ok: code === 'JOURNALS_OK', code,
        message: code === 'JOURNALS_OK' ? 'Journals for this client match Zoho Analytics.' : (affecting.length ? items[0].text : items[1].text) + '.',
        detail: `Journals since ${since}: ${jRows.length} (${pend.length} draft / pending) · unsynced journal movements ${unsyncedJ.length} · deleted journal lines ${delJ.length}.`, items });
    }
  }

  // E — invoice payment verification, Books live
  if (!ivOk || !pyOk) checks.push(unavailable('INVOICES', !ivOk ? 'Invoices could not be read from Zoho Books.' : 'Customer payments could not be read from Zoho Books.'));
  else {
    const answer = String(paid || '').trim();
    const pays = src.payments.rows.filter(x => x && typeof x === 'object');
    const bCount = pays.length, bReceived = sum(pays, p => Math.max(0, amt(p.amount) || 0)), bUnused = sum(pays, p => Math.max(0, amt(p.unused_amount) || 0));
    const aCount = pay ? n0(pay.payments) : 0, refunded = pay ? n0(pay.refunded) : 0;
    const deletedPay = !src.payments.truncated && bCount < aCount;
    const owed = sum(openInv, r => Math.max(0, amt(r.balance) || 0));
    const items = [
      item('Operations: client already paid us?', PAID_OK.includes(answer), answer ? `Operations answered “${answer}”` : 'Operations did not answer'),
      item('Customer payment received in Zoho Books', bCount > 0 && bReceived > EPS, bCount > 0 && bReceived > EPS ? plural(bCount, 'payment', 'payments') + (src.payments.truncated ? '+' : '') + ' on file in Zoho Books' : 'No customer payment recorded in Zoho Books', `Received ${aed(bReceived)}`),
      item('Payments applied to the invoices', !(bUnused > EPS && dues), bUnused > EPS && dues ? 'A payment is recorded but not applied to the open invoice' : 'Payments are applied to the client’s invoices', bUnused > EPS ? `Unapplied ${aed(bUnused)}` : ''),
      item('No outstanding dues', !dues, openInv.length ? plural(openInv.length, 'invoice is', 'invoices are') + ' unpaid or overdue (' + nums(openInv) + ')' : dues ? 'Zoho Books shows an outstanding receivable for this client' : 'No unpaid or overdue invoices',
        dues ? `Outstanding ${aed(Math.max(owed, receivable || 0))}` + (openInv.length ? ' · ' + openInv.slice(0, 5).map(r => `${r.invoice_number || r.invoice_id} ${amt(r.balance) === null ? 'balance unknown' : aed(amt(r.balance))}`).join(', ') : '') : ''),
      item('No reversed or deleted payments', !deletedPay && !(refunded > EPS && dues),
        deletedPay ? 'Zoho Books has fewer payments than Zoho Analytics — a payment was deleted' : refunded > EPS && dues ? 'A refund was recorded while invoices are still unpaid' : 'None found',
        `Books payments ${bCount}${src.payments.truncated ? '+' : ''} · Analytics payments ${aCount}` + (refunded > EPS ? ` · refunded ${aed(refunded)}` : ''))
    ];
    const order = [[0, 'DECLARED_UNPAID'], [1, 'NO_CUSTOMER_PAYMENT'], [4, 'PAYMENT_REVERSED'], [2, 'PAYMENT_NOT_APPLIED'], [3, 'OUTSTANDING_DUES']];
    const first = order.find(([i]) => !items[i].ok);
    checks.push({ key: 'INVOICES', label: CROSS_CHECKS.INVOICES, ok: !first, code: first ? first[1] : 'INVOICES_OK',
      message: !first ? 'Payment received, applied to the invoices, and no dues outstanding (Zoho Books live).' : items[first[0]].text + '.',
      detail: `Books payments ${bCount} · received ${aed(bReceived)} · unapplied ${aed(bUnused)} · open invoices ${openInv.length} (${aed(owed)}) · Books receivable ${receivable === null ? 'unknown' : aed(receivable)}.`, items });
  }

  for (const c of checks) for (const i of c.items) if (!i.detail) delete i.detail;
  const failed = checks.filter(c => !c.ok);
  return {
    ok: failed.length === 0, amount, checks, available,
    failed: failed.map(c => ({ key: c.key, label: c.label, message: c.message })),
    opsError: !failed.length ? '' : failed.some(c => c.key === 'CFD' && ['CFD_INSUFFICIENT', 'CFD_NO_RECORD'].includes(c.code)) ? OPS_INSUFFICIENT
      : `The request cannot be submitted — ${failed.map(c => c.label).join(' and ')} check${failed.length > 1 ? 's' : ''} failed. You can escalate it to management.`,
    staffError: !failed.length ? '' : failed.map(c => `${c.label}: ${c.message} ${c.detail}`).join(' ')
  };
}

// The copy a restricted Operations user (and Master Operations Control) may receive: only the ops-safe fields, by
// whitelist — no detail lines, no figures, no Books document amounts, no Analytics balance (primary carries text only).
export function financeForOps(f) {
  if (!f || typeof f !== 'object') return f;
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && typeof o === 'object' && o[k] !== undefined).map(k => [k, o[k]]));
  const out = pick(f, ['id', 'at', 'atText', 'amount', 'ok', 'source', 'route']);
  if (f.connections && typeof f.connections === 'object') out.connections = pick(f.connections, ['analytics', 'books', 'atText']);
  if (f.primary && typeof f.primary === 'object') out.primary = pick(f.primary, ['ok', 'code', 'text']);
  if (Array.isArray(f.failed)) out.failed = f.failed.map(x => pick(x, ['key', 'label', 'message']));
  out.checks = (Array.isArray(f.checks) ? f.checks : []).map(c => ({ ...pick(c, ['key', 'label', 'ok', 'code', 'message']), items: (Array.isArray(c && c.items) ? c.items : []).map(i => pick(i, ['label', 'ok', 'text'])) }));
  return out;
}
