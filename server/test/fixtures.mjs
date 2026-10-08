// Zoho fixture for the e2e tests: one Books contact per scenario (the server locks a client while a request is open
// and caches Analytics for 60 s, so scenarios use different clients instead of mutating one).
export const CFD = '7050654000000685179';
export const COGS = '7050654000000034003';

const PASS = {
  '2001': 'Alpha Pass One', '2002': 'Bravo Pass Two', '2003': 'Charlie Pass Three', '2004': 'Delta Pass Four',
  '2005': 'Echo Pass Five', '2006': 'Foxtrot Pass Six', '2007': 'Golf Pass Seven', '2008': 'Hotel Pass Eight',
  '2009': 'India Pass Nine', '2010': 'Juliet Pass Ten', '2011': 'Uniform Pass Eleven', '2012': 'Xray Pass Twelve'
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
  whiskey: { id: '3011', name: 'Whiskey Contact', pending: 'FR-518' }, // Books company = an open history request's company
  inactive: { id: '9999', name: 'Zulu Inactive Client' }
};

export function fixture() {
  const contacts = [], balances = [], split = [], invoices = [], payments = [], settlement = [];
  const contact = (id, name, outstanding = 0, status = 'active') => contacts.push({ contact_id: id, contact_name: name, company_name: name + ' FZCO', status, outstanding_receivable_amount: outstanding });
  const pay = id => payments.push({ Customer: id, Payments: 2, Received: '60000.00', Unapplied: '0', Refunded: '0', Last: '2026-10-07 00:00:00.0' });
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
  contacts.push({ contact_id: C.whiskey.id, contact_name: C.whiskey.name, company_name: 'Blue IT Solutions FZ-LLC', status: 'active', outstanding_receivable_amount: 0 });
  return { contacts, balances, split, invoices, payments, settlement };
}
