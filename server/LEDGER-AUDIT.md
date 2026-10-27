# Ledger Audit — client account audit and chart of accounts review

What the **Ledger Audit** page of OneLink Funds does. The rules are in `ledger-audit.js` (pure, unit-tested in
`test/ledger-audit.test.mjs`); the data loading and the endpoints are the `ledger-audit data` module and the
`/api/ledger-audit` routes in `server.js`.

## 0. Who, where, and the read-only principle

- **Sven and management only** (Mr. Adnan, Mr. Ahmed, Mr. Eduard). The nav item is **Audit** (phone: bottom bar; also
  in the ⌘K palette). Operations get no nav item, and the server refuses them (403). That refusal is in the security
  log, and so is every opening of an audit (at most once per person and audit every 10 minutes).
- **Read-only.** Every source is a `SELECT` export from the Elite Onelink Zoho Analytics workspace. Nothing is written
  to Zoho Books or Analytics. Every *Required correction* is an instruction for finance to carry out in Zoho Books.
  `test/read-only.test.js` fails if the audit module ever calls Books or anything but a `SELECT` / `WITH` export.
- The audit is read **when the page is opened** and on **Refresh from Zoho**, never in the background. The exports
  run two at a time, so the live funding checks keep their share of the Analytics rate limit. A result is kept
  15 minutes (`LEDGER_AUDIT_SECONDS`) and shared by everyone who opens it. Refresh re-reads Zoho once the last read is
  two minutes old.
- Duplicate Books contacts are folded onto their canonical client with the same **CFD Automatic Customer Aliases**
  table the balance checks use.

## 1. Sources (Analytics tables)

| Export | Tables | Used for |
|---|---|---|
| customers | Customers | client names |
| creditnotes, cnapply | Credit Notes, Creditnotes Invoice, Invoices | credit notes and where they were applied |
| payments | Customer Payments, Invoice Payments, Accounts | payments, their deposit account, what is applied / unused / refunded |
| refunds | Accrual Transactions (`creditnote_refund`, `payment_refund`), Accounts | refund entries, both sides |
| invoices | Invoices, Invoice Payments, Creditnotes Invoice | invoice status, balance, payments and credit notes applied |
| ledger | CFD Customer Resolved | every Customers Fund Disbursement and COGS line, its client and whether the client is tagged |
| counter | Accrual Transactions, Accounts | the other side of every disbursement (the bank / wallet it was paid from) |
| balances | CFD Customer Balances | each client's fund balance (the one the funding checks use) |
| coa | Accounts, Accrual Transactions | every account's lines per entry type |
| lines | Accrual Transactions | the lines of the zero-balance accounts that are not at zero, and one account on request |

## 2. Module 1 — Client account accuracy audit

Each client is **Accurate** (no exception), **Review** (only items a person has to look at) or **Requires
corrections**. Entries that resolve to no client are listed first, under **No client tag**. Every exception carries
**Client Name · Account / Transaction Type · Issue Description · Root Cause · Required Correction**, plus severity,
area, reference and amount. *Exceptions CSV* exports exactly these. *Summary CSV* exports one line per client with its
result and liability.

| Area | Check (code) | Severity |
|---|---|---|
| Credit notes | unused while the client has open invoices → apply it, oldest invoice first (`CN_UNUSED`) | correction |
| | unused with nothing open → refund or keep with the client's agreement (`CN_UNUSED`) | review |
| | applied to another client's invoice (`CN_WRONG_CLIENT`) | correction |
| | applied more than its total (`CN_OVER_APPLIED`); balance outside 0…total (`CN_BALANCE_INVALID`); closed with a balance (`CN_STATUS`) | correction |
| | same client, same amount, dated within 3 days (`CN_DUPLICATE`) | review |
| Refunds | refund not tagged to a client (`REFUND_NO_CLIENT`) | correction |
| | refund not paid out of a bank, cash, wallet, card or clearing account (`REFUND_ACCOUNT`) | correction |
| | credit notes say an amount was refunded, but no refund entry is in the ledger (`CN_REFUND_MISSING`); payments show a refund with no payment-refund entry (`PAYMENT_REFUND_MISSING`); refund entries that match no credit note (`REFUND_UNMATCHED`) | review |
| Payments | no deposit account (`PAYMENT_NO_SOURCE`) | correction |
| | deposited to an account that is not a bank, cash, wallet, card or clearing account (the client fund account is accepted) (`PAYMENT_SOURCE`) | review |
| | unapplied while the client has an open invoice (`PAYMENT_UNAPPLIED`); allocated more than its amount (`PAYMENT_OVER_ALLOCATED`) | correction |
| | unused and the client has no invoice at all (`PAYMENT_NO_INVOICE`) | review |
| Invoices & journal entries | settled without a matching payment or credit note, over AED 1 (`INV_UNMATCHED_SETTLEMENT`), or applied twice (`INV_OVER_SETTLED`) | correction |
| | paid / closed with a balance, or a balance outside 0…total (`INV_STATUS`, `INV_BALANCE_INVALID`) | correction |
| | a CFD / COGS entry with no client (`LEDGER_UNTAGGED`) | correction |
| | a CFD / COGS entry matched to the client only by its reference (`LEDGER_REFERENCE_MATCH`) | review |
| Client liabilities | funds held (CFD balance > 0), unused payments and open credit notes are the client's liability. The latest disbursement is traced to its transaction and the account it was paid from (*Settled by* / *Last disbursement*) | — |
| | disbursed more than the client paid in (`LIABILITY_OVERDRAWN`) | correction |
| | funds held while the client has open invoices — settle them from the funds with the client's agreement (`LIABILITY_WITH_DUES`) | review |

Analytics names a paid invoice **Closed**; both *Closed* and *Paid* count as paid. An exchange difference on a refund
(an "Exchange Gain or Loss" line) is not a mismatch: refunds are matched on the receivable side.

## 3. Module 2 — Chart of Accounts balance review

Every account in Analytics' **Accounts** table, with:

- **Current Balance** on the account's natural side (assets and expenses: debit; liabilities, equity and income:
  credit), shown as `AED x Dr` / `AED x Cr`.
- **Expected / Unexpected.** Unexpected when one of the findings below applies, except a missing client tag or a
  client cost to confirm.
- **Source of Balance:** the entry types behind it (expense, invoice, journal …) with debits, credits and line counts.
  *Show transactions* lists the account's newest 500 lines.
- **Corrections Needed:** the fix of every finding. *Accounts CSV* exports these five columns plus type, code and
  whether the account must be zero.

| Finding | Rule |
|---|---|
| `ZERO_BALANCE` | Accounts that must always be zero: names matching `disbursements of expenses`, `clearing`, `suspense`, `holding`, `temporary`, `in transit`, `undeposited funds`, and every *Payment Clearing* account, never Customers Fund Disbursement. When one is not at zero its lines are read: every debit is paired with a credit of the same amount (nearest date first), and what is left is listed as **open entries**. An open entry equal to the balance is marked **Likely cause**. The cause is *Rounding difference* (under AED 1), *Incorrect tagging* (the untagged open entries explain it), *Misallocation* (journals explain it) or *Missing settlement*. The correction depends on the kind of account (disbursement, clearing, undeposited, suspense). |
| `COGS_CLIENT_COSTS` | COGS vs Customer Fund Disbursement: a debit on *Cost of Goods Sold-Clients Payments* tagged to a client who has paid funds into CFD is a client cost booked under COGS. Each gets its reallocation journal (*Dr Customers Fund Disbursement Account / Cr Cost of Goods Sold-Clients Payments, tagged to the client*). *Reallocation CSV* exports them. Untagged COGS entries (`COGS_UNTAGGED`) are to be tagged first. Client-tagged costs of clients with no funds (`COGS_UNFUNDED`) are listed to confirm: a recoverable disbursement, or a true cost. |
| `NEGATIVE` | A balance against its natural side, except contra accounts (discount, return, allowance, rebate, accumulated depreciation). The correction depends on the account type (bank / wallet, asset, liability or equity, income, expense); under AED 1 it is a rounding difference. |
| `INACTIVE_BALANCE` | An inactive account that still carries a balance. |
| `MISSING_TAGS` | Lines on Customers Fund Disbursement with no client (listed per entry in Module 1). |

## 4. Settings (environment)

| Variable | Default | Effect |
|---|---|---|
| `LEDGER_AUDIT_SECONDS` | 900 | how long an audit result is kept and shared |
| `LEDGER_ZERO_ACCOUNT_IDS` | — | comma-separated Books account ids that must also be zero |
| `LEDGER_NOT_ZERO_ACCOUNT_IDS` | — | account ids taken out of the zero-balance rule |
| `LEDGER_ZERO_NAME_PATTERN` | see above | a regular expression replacing the default name pattern |
| `ZOHO_CFD_ACCOUNT_ID`, `ZOHO_COGS_ACCOUNT_ID` | Elite OneLink's | the same accounts the funding checks use |

## 5. Endpoints

- `GET /api/ledger-audit/clients[?refresh=1]` — Module 1: `{ summary, clients[], exceptions[] }`
- `GET /api/ledger-audit/accounts[?refresh=1]` — Module 2: `{ summary, accounts[], reallocation }`
- `GET /api/ledger-audit/accounts/:id/lines` — one account's newest 500 lines

All three need a signed-in Sven or management session.
