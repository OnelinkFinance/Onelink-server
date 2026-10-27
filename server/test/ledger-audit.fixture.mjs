// Zoho stub rows for the ledger audit (client account audit, chart of accounts review): one client with an unused credit
// note while an invoice is open, one payment with no deposit account and no invoice, an untagged CFD journal, a client
// cost under COGS, and Disbursements Of Expenses left AED 497.80 Cr. Used by ledger-audit.e2e.test.mjs and for screenshots.
import { fixture } from './fixtures.mjs';

export const CFD = '7050654000000685179', COGS = '7050654000000034003', DOE = '7050654000001129012', BANK = '7050654000000203700';
export const audit = () => ({
  auditCustomers: [{ Customer: '501', Name: 'Gamma Trading LLC' }, { Customer: '502', Name: 'Delta FZE' }],
  auditCreditNotes: [{ Customer: '501', ID: 'c1', Number: 'CN-00031', Status: 'Open', Date: '02 Oct 2026', Total: '1500', Balance: '1500' }],
  auditCnApply: [],
  auditPayments: [
    { Customer: '501', ID: 'p1', Number: 'PMT-77', Date: '01 Oct 2026', Amount: '20000', Unused: '0', Refunded: '0', Applied: '20000', 'Deposit Account': BANK, 'Account Name': 'ELITE ONELINK CORPORATE-AED Account', 'Account Type': 'Bank' },
    { Customer: '502', ID: 'p2', Number: 'PMT-78', Date: '03 Oct 2026', Amount: '900', Unused: '900', Refunded: '0', Applied: '0', 'Deposit Account': '', 'Account Name': '', 'Account Type': '' }
  ],
  auditRefunds: [],
  auditInvoices: [
    { Customer: '501', ID: 'i1', Number: 'INV-900', Status: 'Paid', Date: '01 Oct 2026', Due: '01 Oct 2026', Total: '20000', Balance: '0', 'Write Off': '0', Paid: '20000', Credited: '0' },
    { Customer: '501', ID: 'i2', Number: 'INV-901', Status: 'Overdue', Date: '04 Oct 2026', Due: '10 Oct 2026', Total: '1000', Balance: '1000', 'Write Off': '0', Paid: '0', Credited: '0' }
  ],
  auditLedger: [
    { Customer: '501', 'Customer Name': 'Gamma Trading LLC', Account: CFD, 'Entity Type': 'invoice', 'Entity ID': 'i1', 'Transaction ID': 't1', Reference: 'INV-900', Date: '01 Oct 2026', Debit: '0', Credit: '20000', 'Tag Status': 'Customer Tagged' },
    { Customer: '501', 'Customer Name': 'Gamma Trading LLC', Account: CFD, 'Entity Type': 'expense', 'Entity ID': 'e1', 'Transaction ID': 't2', Reference: 'Golden visa', Date: '06 Oct 2026', Debit: '12000', Credit: '0', 'Tag Status': 'Customer Tagged' },
    { Customer: '501', 'Customer Name': 'Gamma Trading LLC', Account: COGS, 'Entity Type': 'expense', 'Entity ID': 'e2', 'Transaction ID': 't3', Reference: 'Medical test', Date: '07 Oct 2026', Debit: '650', Credit: '0', 'Tag Status': 'Customer Tagged' },
    { Customer: '', 'Customer Name': 'Unassigned Customer - Review Required', Account: CFD, 'Entity Type': 'journal', 'Entity ID': 'j1', 'Transaction ID': 't4', Reference: 'JV-12', Date: '08 Oct 2026', Debit: '300', Credit: '0', 'Tag Status': 'Customer Not Tagged' }
  ],
  auditCounter: [{ 'Transaction ID': 't2', Account: '7050654000000117004', 'Account Name': 'Alaan Main Account', 'Account Type': 'Bank', Debit: '0', Credit: '12000' }],
  auditCoa: [
    { Account: CFD, Name: 'Customers Fund Disbursement Account', Code: '', Type: 'Other Current Liability', Base: 'Liability', Active: 'Yes', 'Entity Type': 'invoice', Debits: '0', Credits: '20000', Lines: '1', 'Untagged Lines': '0' },
    { Account: CFD, Name: 'Customers Fund Disbursement Account', Code: '', Type: 'Other Current Liability', Base: 'Liability', Active: 'Yes', 'Entity Type': 'expense', Debits: '12300', Credits: '0', Lines: '2', 'Untagged Lines': '1' },
    { Account: COGS, Name: 'Cost of Goods Sold-Clients Payments', Code: '', Type: 'Cost Of Goods Sold', Base: 'Expense', Active: 'Yes', 'Entity Type': 'expense', Debits: '650', Credits: '0', Lines: '1', 'Untagged Lines': '0' },
    { Account: DOE, Name: 'Disbursements Of Expenses', Code: '', Type: 'Expense', Base: 'Expense', Active: 'Yes', 'Entity Type': 'expense', Debits: '5000', Credits: '0', Lines: '2', 'Untagged Lines': '2' },
    { Account: DOE, Name: 'Disbursements Of Expenses', Code: '', Type: 'Expense', Base: 'Expense', Active: 'Yes', 'Entity Type': 'invoice', Debits: '0', Credits: '5497.8', Lines: '2', 'Untagged Lines': '0' },
    { Account: BANK, Name: 'ELITE ONELINK CORPORATE-AED Account', Code: '', Type: 'Bank', Base: 'Asset', Active: 'Yes', 'Entity Type': 'invoice_payment', Debits: '20000', Credits: '12000', Lines: '2', 'Untagged Lines': '0' },
    { Account: '7050654000005697708', Name: 'Suspense Clearing Account', Code: '', Type: 'Other Current Liability', Base: 'Liability', Active: 'Yes', 'Entity Type': '', Debits: '0', Credits: '0', Lines: '0', 'Untagged Lines': '0' }
  ],
  auditLines: [
    { Customer: '', Account: DOE, 'Entity Type': 'expense', 'Entity ID': 'x1', 'Transaction ID': 'tx1', Reference: 'Visa A', Date: '01 Oct 2026', Debit: '5000', Credit: '0' },
    { Customer: '501', Account: DOE, 'Entity Type': 'invoice', 'Entity ID': 'x2', 'Transaction ID': 'tx2', Reference: 'INV-950', Date: '02 Oct 2026', Debit: '0', Credit: '5000' },
    { Customer: '502', Account: DOE, 'Entity Type': 'invoice', 'Entity ID': 'x3', 'Transaction ID': 'tx3', Reference: 'INV-951', Date: '03 Oct 2026', Debit: '0', Credit: '497.8' },
    { Customer: '501', Account: BANK, 'Entity Type': 'invoice_payment', 'Entity ID': 'x4', 'Transaction ID': 'tx4', Reference: 'PMT-77', Date: '01 Oct 2026', Debit: '20000', Credit: '0' }
  ]
});

// The funding-check fixture plus the audit rows and Gamma's CFD balance.
export const auditFixture = () => {
  const f = { ...fixture(), ...audit() };
  f.balances = [...(f.balances || []), { 'Resolved Customer ID': '501', 'Resolved Customer Name': 'Gamma Trading LLC', 'Credits AED': '20000', 'Debits AED': '12650', 'Balance AED': '7350', 'Balance Status': 'Customer Advance', 'Balance Alert': '' }];
  return f;
};
