// Zoho fixture for the e2e tests: one Books contact per scenario (the server locks a client while a request is open
// and caches Analytics for 60 s, so scenarios use different clients instead of mutating one).
import fs from 'node:fs';
export const CFD = '7050654000000685179';
export const COGS = '7050654000000034003';

// The open history request that locks a Books client by exact name (whichever ledger.json holds first).
const OPEN = ['NEW', 'ACTION', 'ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED'];
const nameKey = v => String(v || '').trim().toLowerCase();
const LEDGER = (() => { try { return JSON.parse(fs.readFileSync(new URL('../ledger.json', import.meta.url), 'utf8')); } catch { return { requests: [] }; } })();
const histOpen = (LEDGER.requests || []).find(r => OPEN.includes(r.status) && !r.zohoClientId && nameKey(r.company) && nameKey(r.company) !== '—');
const histCompany = histOpen ? histOpen.company : 'Blue IT Solutions FZ-LLC';
const histPending = (LEDGER.requests || []).find(r => OPEN.includes(r.status) && !r.zohoClientId && [r.person, r.company, r.zohoClient].some(v => nameKey(v) === nameKey(histCompany)));

const PASS = {
  '2001': 'Alpha Pass One', '2002': 'Bravo Pass Two', '2003': 'Charlie Pass Three', '2004': 'Delta Pass Four',
  '2005': 'Echo Pass Five', '2006': 'Foxtrot Pass Six', '2007': 'Golf Pass Seven', '2008': 'Hotel Pass Eight',
  '2009': 'India Pass Nine', '2010': 'Juliet Pass Ten', '2011': 'Uniform Pass Eleven', '2012': 'Xray Pass Twelve', '2013': 'Yankee Pass Thirteen'
};
// CFD fails (balance below the amount used in the tests, 5000). Compact currency on purpose: 'AED 1.2K' = 1200.
const LOW = { '3001': 'Kilo Low Balance', '3002': 'Lima Low Balance', '3003': 'Mike Low Balance', '3004': 'November Low Balance', '3008': 'Sierra Low Balance' };
export const C = {
  ...Object.fromEntries(Object.entries({ ...PASS, ...LOW }).map(([id, n]) => [n.split(' ')[0].toLowerCase(), { id, name: n }])),
  oscar: { id: '3005', name: 'Oscar Cogs Fail' },        // CFD ok ('AED 35.06K'), COGS exceeds payments
  papa: { id: '3006', name: 'Papa No Record' },          // no CFD Customer Balances row at all
  quebec: { id: '3007', name: 'Quebec Open Invoices' },  // only invoices fail (open invoice + Books receivable)
  romeo: { id: '3009', name: 'Romeo Cogs Fail' },        // like Oscar (second scenario)
  victor: { id: '3010', name: 'Victor Mismatch' },       // invoices marked paid without a matching payment
  whiskey: { id: '3011', name: 'Whiskey Contact', pending: histPending ? histPending.id : 'FR-518' }, // Books company = an open history request's company
  // Zoho Books cross-verification scenarios: the Zoho Analytics CFD balance is short; Books decides.
  bk1: { id: '4001', name: 'Books Unsynced Credit' },     // an unsynced Books credit covers the request → passes (5 checks)
  bk2: { id: '4002', name: 'Books Draft Journal' },       // as bk1, plus a draft journal for the client → JOURNALS fails
  bk3: { id: '4003', name: 'Books Draft Notes' },         // as bk1, plus a draft credit note → NOTES fails
  bk4: { id: '4004', name: 'Books Deleted Line' },        // an Analytics credit deleted in Books → insufficient
  bk5: { id: '4005', name: 'Books Credit Note' },         // an open credit note (not in the ledger) covers the request
  bk6: { id: '4006', name: 'Books Other Customer' },      // the unsynced credit belongs to another customer → insufficient
  bk7: { id: '4007', name: 'Books Unpaid Invoice' },      // unsynced credit, but a live open invoice in Books
  bk8: { id: '4008', name: 'Books Deleted Payment' },     // unsynced credit, but Books has fewer payments than Analytics
  inactive: { id: '9999', name: 'Zulu Inactive Client' }
};

export function fixture() {
  const contacts = [], balances = [], split = [], invoices = [], payments = [], settlement = [];
  const contact = (id, name, outstanding = 0, status = 'active') => contacts.push({ contact_id: id, contact_name: name, company_name: name + ' FZCO', status, outstanding_receivable_amount: outstanding });
  const customerpayments = [];
  // Analytics: two payments of AED 30,000; the live Books API has the same two payments.
  const pay = id => {
    payments.push({ Customer: id, Payments: 2, Received: '60000.00', Unapplied: '0', Refunded: '0', Last: '2026-10-07 00:00:00.0' });
    customerpayments.push({ payment_id: id + '01', payment_number: 'PAY-' + id + '-1', customer_id: id, amount: 30000, unused_amount: 0, date: '2026-09-01' },
      { payment_id: id + '02', payment_number: 'PAY-' + id + '-2', customer_id: id, amount: 30000, unused_amount: 0, date: '2026-10-07' });
  };
  for (const [id, name] of Object.entries(PASS)) {
    contact(id, name);
    balances.push({ 'Resolved Customer ID': id, 'Resolved Customer Name': name, 'Credits AED': '60000.00', 'Debits AED': '10000.00', 'Balance AED': '50000.00', 'Balance Status': 'Positive', 'Balance Alert': '' });
    split.push({ Customer: id, Account: CFD, Credits: '40000.00', Debits: '10000.00', Lines: 3, Untagged: 0 });
    split.push({ Customer: id + '.0', Account: CFD, Credits: '20000.00', Debits: '0', Lines: 1, Untagged: 0 }); // second row folds onto the same client
    split.push({ Customer: id, Account: COGS, Credits: '0', Debits: '8000.00', Lines: 2, Untagged: 0 });
    pay(id);
  }
  for (const [id, name] of Object.entries(LOW)) {
    contact(id, name);
    balances.push({ 'Resolved Customer ID': id, 'Resolved Customer Name': name, 'Credits AED': 'AED 11.2K', 'Debits AED': 'AED 10K', 'Balance AED': 'AED 1.2K', 'Balance Status': 'Low', 'Balance Alert': '' });
    split.push({ Customer: id, Account: CFD, Credits: '11200.00', Debits: '10000.00', Lines: 2, Untagged: 0 });
    split.push({ Customer: id, Account: COGS, Credits: '0', Debits: '1000.00', Lines: 1, Untagged: 0 });
    pay(id);
  }
  for (const k of ['oscar', 'romeo']) {
    const { id, name } = C[k];
    contact(id, name);
    balances.push({ 'Resolved Customer ID': id, 'Resolved Customer Name': name, 'Credits AED': 'AED 40K', 'Debits AED': 'AED 4.94K', 'Balance AED': 'AED 35.06K', 'Balance Status': 'Positive', 'Balance Alert': '' });
    split.push({ Customer: id, Account: CFD, Credits: '40000.00', Debits: '4940.00', Lines: 2, Untagged: 0 });
    split.push({ Customer: id, Account: COGS, Credits: '0', Debits: 'AED 91.5K', Lines: 6, Untagged: 0 });
    pay(id);
  }
  contact(C.papa.id, C.papa.name); pay(C.papa.id);
  contact(C.quebec.id, C.quebec.name, 750);
  balances.push({ 'Resolved Customer ID': C.quebec.id, 'Resolved Customer Name': C.quebec.name, 'Credits AED': '60000', 'Debits AED': '0', 'Balance AED': '60000', 'Balance Status': 'Positive', 'Balance Alert': '' });
  split.push({ Customer: C.quebec.id, Account: CFD, Credits: '60000', Debits: '0', Lines: 1, Untagged: 0 });
  invoices.push({ Customer: C.quebec.id, Invoice: 'INV-000750', Status: 'Overdue', Due: '2026-09-30', Total: '750.00', Balance: '750.00' });
  pay(C.quebec.id);
  contact(C.inactive.id, C.inactive.name, 0, 'inactive');
  // Victor: funds fine, but AED 5,000 of settled invoices has no payment or credit note behind it.
  contact(C.victor.id, C.victor.name);
  balances.push({ 'Resolved Customer ID': C.victor.id, 'Resolved Customer Name': C.victor.name, 'Credits AED': '60000', 'Debits AED': '0', 'Balance AED': '60000', 'Balance Status': 'Positive', 'Balance Alert': '' });
  split.push({ Customer: C.victor.id, Account: CFD, Credits: '60000', Debits: '0', Lines: 1, Untagged: 0 });
  pay(C.victor.id);
  settlement.push({ Customer: C.victor.id, Invoices: 2, Invoiced: '10000.00', Outstanding: '0', 'Written off': '0', Paid: '5000.00', Credited: '0' });
  settlement.push({ Customer: C.alpha.id, Invoices: 3, Invoiced: '60000.00', Outstanding: '0', 'Written off': '0', Paid: '58000.00', Credited: '2000.00' }); // matched, with a credit note
  contacts.push({ contact_id: C.whiskey.id, contact_name: C.whiskey.name, company_name: histCompany, status: 'active', outstanding_receivable_amount: 0 });

  // Zoho Books cross-verification. Analytics: AED 3,000 in CFD (synced up to 8 Oct); every scenario asks for AED 5,000.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const recent = [], transactions = { [CFD]: [], [COGS]: [] }, creditnotes = [], booksInvoices = [], journals = [], journalDetails = {};
  for (const k of ['bk1', 'bk2', 'bk3', 'bk4', 'bk5', 'bk6', 'bk7', 'bk8']) {
    const { id, name } = C[k];
    contact(id, name, k === 'bk7' ? 2500 : 0);
    balances.push({ 'Resolved Customer ID': id, 'Resolved Customer Name': name, 'Credits AED': '4000', 'Debits AED': '1000', 'Balance AED': '3000', 'Balance Status': 'Low', 'Balance Alert': '' });
    split.push({ Customer: id, Account: CFD, Credits: '4000', Debits: '1000', Lines: 2, Untagged: 0 });
    pay(id);
    // The Analytics lines of the window: a credit (synced, in Books too) and a debit.
    recent.push({ Customer: id, Account: CFD, 'Entity ID': id + '501', 'Transaction ID': id + '601', 'Entity Type': 'journal', Credit: '4000', Debit: '0', Date: today });
    recent.push({ Customer: id, Account: CFD, 'Entity ID': id + '502', 'Transaction ID': id + '602', 'Entity Type': 'expense', Credit: '0', Debit: '1000', Date: today });
    if (k !== 'bk4') transactions[CFD].push({ transaction_id: id + '601', categorized_transaction_id: '', transaction_type: 'journal', transaction_date: today, customer_id: id, payee: name, credit_amount: 4000, debit_amount: 0 });
    transactions[CFD].push({ transaction_id: id + '602', transaction_type: 'expense', transaction_date: today, customer_id: id, payee: name, credit_amount: 0, debit_amount: 1000 });
    // Not yet in Analytics: a credit of AED 2,500 (bk6: tagged to another customer whose name mentions this client).
    if (['bk1', 'bk2', 'bk3', 'bk7', 'bk8'].includes(k)) transactions[CFD].push({ transaction_id: id + '603', transaction_type: 'deposit', transaction_date: today, customer_id: id, payee: name, credit_amount: 2500, debit_amount: 0, reference_number: 'DEP-' + id });
    if (k === 'bk6') transactions[CFD].push({ transaction_id: id + '603', transaction_type: 'deposit', transaction_date: today, customer_id: '9998', payee: name, description: 'Transfer for ' + name, credit_amount: 2500, debit_amount: 0 });
  }
  journals.push({ journal_id: '4002900', entry_number: 'JE-900', journal_date: today, status: 'draft', total: 700 });
  journalDetails['4002900'] = { journal_id: '4002900', status: 'draft', line_items: [{ customer_id: C.bk2.id, debit_or_credit: 'debit', amount: 700 }, { customer_id: '', debit_or_credit: 'credit', amount: 700 }] };
  journals.push({ journal_id: '4999900', entry_number: 'JE-901', journal_date: today, status: 'published', total: 50 });
  creditnotes.push({ creditnote_id: C.bk3.id + '700', creditnote_number: 'CN-00070', customer_id: C.bk3.id, status: 'draft', total: 300, balance: 300, date: today });
  creditnotes.push({ creditnote_id: C.bk5.id + '700', creditnote_number: 'CN-00071', customer_id: C.bk5.id, status: 'open', total: 2500, balance: 2500, date: today });
  booksInvoices.push({ invoice_id: C.bk7.id + '800', invoice_number: 'INV-00800', customer_id: C.bk7.id, type: 'invoice', status: 'overdue', total: 2500, balance: 2500 });
  booksInvoices.push({ invoice_id: C.bk1.id + '800', invoice_number: 'INV-00801', customer_id: C.bk1.id, type: 'invoice', status: 'paid', total: 900, balance: 0 });
  // bk8: Books has only one of the two payments Analytics has (one was deleted in Books).
  const i8 = customerpayments.findIndex(p => p.customer_id === C.bk8.id);
  customerpayments.splice(i8, 1);
  return { contacts, balances, split, invoices, payments, settlement, recent, watermark: [{ Watermark: today + ' 09:03:00' }],
    books: { transactions, creditnotes, invoices: booksInvoices, customerpayments, journals, journalDetails } };
}
