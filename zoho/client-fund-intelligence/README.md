# Client Fund Intelligence — Zoho Books

Controls client funds held in the Customers Fund Disbursement Account (CFDA): what each client holds, what is committed to open payment requests, what is reserved, which refunds are on the way, and whether a payment request is safe to approve. Every payment request, refund and CFDA balance change re-runs the check, writes the result back into Zoho Books, raises alerts and leaves an audit trail.

The rules live in one place: [`server/cfi-engine.js`](../../server/cfi-engine.js), tested in `server/test/cfi-engine.test.js`. The Deluge engine and the dashboard copy them exactly.

## 1. Modules (already created in Zoho Books, org 898300452)

| Module | API name | One row per | Written by |
|---|---|---|---|
| Client Payment Request *(existing)* | `cm_client_payment_request` | payment request | people + existing CFDA check + this engine (new fields) |
| Client CFDA Balance *(existing)* | `cm_client_cfda_balance` | client | existing balance job |
| CFDA Statement Line *(existing)* | `cm_cfda_statement_line` | CFDA entry | existing balance job |
| **Client Fund Intelligence** | `cm_client_fund_intelligence` | client | this engine (Finance sets *Funds Reserved*) |
| **Client Refund** | `cm_client_refund` | expected refund | Finance / Operations |
| **Fund Alert** | `cm_fund_alert` | alert | this engine |
| **Fund Audit Log** | `cm_fund_audit_log` | event | this engine (read-only module) |

### Relationships

Every module links to the Zoho Books **customer** through its `Client` lookup (`cf_client`), so each customer page shows related lists: Client Payment Requests, Client CFDA Balance, Client Fund Intelligence, Client Refunds, Fund Alerts and Fund Audit Log.

```
Customer (Zoho Books contact)
 ├── Client CFDA Balance (1)  ── CFDA Statement Lines (n)
 ├── Client Fund Intelligence (1)   ← computed from the rows below
 ├── Client Payment Requests (n)    ← engine writes Fund Status, Expected Refunds, Projected, Risk, AI Recommendation
 ├── Client Refunds (n)
 ├── Fund Alerts (n)
 └── Fund Audit Log (n)
```

### Fields

**Client Fund Intelligence** — Client (lookup), Client ID (unique), Deposit Received, Total Expenses Used, Total Refunds Received, Current Balance, Upcoming Refunds, Overdue Refunds, Funds Reserved *(set by Finance)*, Open Requests, Open Request Count, Available Balance, Projected Balance, Shortfall, Fund Status, Risk Score, Risk Status, Approval Status, AI Recommendation, Balance Alert, Last Checked, Recalc Requested *(technical)*.

**Client Refund** — Refund Reference (name), Client, Authority, Refund Reason, Expected Amount, Expected Date, Refund Status (Expected · Partly received · Received · Overdue · Written off), Received Amount, Received Date, Linked Request, Receipt Reference, Refund Notes.

**Fund Alert** — Alert (name), Client, Alert Type, Severity, Alert Message, Alert Amount, Request Reference, Email Status, WhatsApp Status, Alert Status (Open · Acknowledged · Resolved), Raised At, Dedupe Key.

**Fund Audit Log** — Event (name), Client, Event Type, Source Record, Event Amount, Available Before, Available After, Status Before, Status After, Performed By, Event Time, Event Details.

**Client Payment Request (new fields)** — Expected Refunds, Projected After Refunds, Fund Status (✅ COVERED · ⏳ PENDING REFUND · ⛔ SHORT), Client Risk Score, AI Recommendation, Duplicate Check, Engine Seen Status *(technical)*. The existing fields (CFDA balance, Committed to other open requests, Available after this request, Covered or Short, Recommendation) stay as they are and are still written by the existing check.

## 2. The rules

```
Current balance   = Client CFDA Balance "Balance AED"  (received − paid out, incl. bills/credit notes on the CFDA)
Open requests     = requests submitted or approved, not paid, not rejected
Available balance = Current balance − Open requests − Funds reserved
Upcoming refunds  = Expected / Partly received / Overdue refunds, not yet received
Projected balance = Available balance + Upcoming refunds
```

Refunds already received are part of the current balance (they arrive in the CFDA), so they are shown but not added twice.

**Each payment request:** available after it = current − reserved − other open requests − this amount.
✅ COVERED if that is ≥ 0 · ⏳ PENDING REFUND if it is < 0 but ≥ 0 once expected refunds arrive · ⛔ SHORT otherwise.

**Each client:**

| Fund Status | When |
|---|---|
| ✅ Available | available ≥ AED 1,000 |
| ⚠ Low balance | 0 ≤ available < AED 1,000 |
| ⏳ Covered after refund | available < 0, projected ≥ 0 |
| ⛔ Short | projected < 0 |
| ⚪ No funds held | balance 0, nothing open, no refunds due |

| Approval Status | When |
|---|---|
| ✅ Safe to approve | available ≥ AED 1,000 |
| ⚠ Low available balance | 0 ≤ available < AED 1,000 |
| ✅ Available after refund recovery | short now, covered by refunds, none overdue |
| ⚠ Await refund collection | as above, but a refund is overdue |
| ⛔ Hold requests | short even after refunds |

**Risk score (0–100):** client owes money +25 · open requests exceed funds +25 · shortfall +4 per AED 1,000 (max 20) · relies on refunds +5 · short even after refunds +20 · refunds overdue +15 · available below AED 1,000 +10 · 3+ open requests +5. Low < 25 ≤ Medium < 50 ≤ High < 75 ≤ Critical. The audit log records the factors behind each score.

The engine **recommends; it never approves.** Approval stays with the existing approval flow, and approving a SHORT request is logged as a *Manual override* with a Critical alert.

**Worked example** (Mr. Earl Antonio Joseph Fortes, 17 Nov 2026): received AED 4,815, paid AED 3,671 → current AED 1,144. With an expected refund of AED 2,339.50 logged in Client Refunds, projected = AED 3,483.50. A new AED 3,000 request would be ⏳ PENDING REFUND: “✅ AVAILABLE AFTER REFUND RECOVERY … projected balance after this request AED 483.50”.

## 3. How it updates on every request

```
Payment request saved ─┐
Refund saved ──────────┼─► trigger function sets "Recalc Requested" on the client's Client Fund Intelligence row
CFDA balance changed ──┤      (creates the row if the client has none)
Nightly 02:00 ─────────┘
                              │
                              ▼
            cfi_engine (workflow on Client Fund Intelligence)
            reads: CFDA balance · the client's requests · the client's refunds · Funds Reserved
            writes: the client's row · every open request's engine fields · Fund Alerts · Fund Audit Log
            asks the existing CFDA check to re-run ("Recheck requested") on open requests checked before the
            client's CFDA balance last changed, which fixes stale figures like the Stryk Consultancy request
```

No loops: the engine never writes *Recalc Requested*, and the request rule only watches fields people change.

## 4. Install (about 30 minutes, Zoho Books admin)

### 4.1 Connection
Settings → Developer Data → Connections → **Create** → Zoho Books → name **`cfibooks`**, scope `ZohoBooks.fullaccess.all` → Connect.

### 4.2 Custom functions
Settings → Automation → **Custom Functions** → New, once per file, choosing the module shown at the top of the file. Keep the header Zoho generates and paste the body.

| File | Module |
|---|---|
| `deluge/cfi_engine.dg` | Client Fund Intelligence |
| `deluge/wf_cfi_from_request.dg` | Client Payment Request |
| `deluge/wf_cfi_from_refund.dg` | Client Refund |
| `deluge/wf_cfi_from_cfda.dg` | Client CFDA Balance |

In `cfi_engine` and `wf_cfi_from_refund`, set `alertEmails` to the addresses that should get Warning and Critical alerts (blank sends no email).

If Zoho names the record argument differently from `cm_client_fund_intelligence` (etc.), rename the first line that reads it (`cfi = …`, `r = …`, `f = …`, `b = …`).

### 4.3 Workflow rules
Settings → Automation → **Workflow Rules** → New:

| Rule | Module | When | Action |
|---|---|---|---|
| Client Fund Intelligence — engine | Client Fund Intelligence | Created, **or** Edited when *Recalc Requested* is updated | Custom function `cfi_engine` |
| Client Payment Request — fund check | Client Payment Request | Created, **or** Edited when any of *Client, Amount (AED), Payment Status, Recheck requested* is updated. Also add the approval/rejection trigger if your plan shows one. | `wf_cfi_from_request` |
| Client Refund — fund check | Client Refund | Created or Edited (any field) | `wf_cfi_from_refund` |
| Client CFDA Balance — fund check | Client CFDA Balance | Created, **or** Edited when *Balance AED* is updated | `wf_cfi_from_cfda` |

### 4.4 Schedule
Settings → Automation → **Schedules** → New → Daily 02:00 → paste `deluge/sch_cfi_nightly.dg`. It marks overdue refunds and backfills client rows (BATCH clients a night).

### 4.5 Optional, for scale: custom views
In Client Payment Requests create a view **Open payment requests** (Payment Status *is empty*, Approval status *is not* Rejected); in Client Refunds a view **Open refunds** (Refund Status *is* Expected, Partly received or Overdue). Put their IDs (from the view's URL) in `openRequestView` / `openRefundView` in `cfi_engine.dg`. Without them the engine reads the 600 most recent requests and 200 most recent refunds, which is plenty today.

### 4.6 Check it
Edit any open payment request (e.g. re-save Stryk Consultancy LTD - Tom). Within a minute: the request shows Fund Status and AI Recommendation; Tom Ross has a Client Fund Intelligence row; the Fund Audit Log has a *Request checked* event.

## 5. Notifications

| Alert | Raised when | Severity | Channels |
|---|---|---|---|
| Balance below AED 1,000 / 500 | available balance crosses the line | Warning | dashboard, email |
| Client became short | fund status turns ⛔ Short | Critical | dashboard, email, WhatsApp queue |
| Refund received | refund set to Received / Partly received | Info | dashboard |
| Refund overdue | expected date passed (nightly) | Warning | dashboard, email |
| New payment request | the engine first sees a request | Info | dashboard |
| High risk client | risk turns High or Critical | Warning / Critical | dashboard, email (+ WhatsApp if Critical) |
| Large expense | ≥ AED 10,000 paid out since the last check | Warning | dashboard, email |
| Duplicate request | same client and amount, both open, within 30 days | Warning | dashboard, email |
| Approved while short | a SHORT request is approved | Critical | dashboard, email, WhatsApp queue |

Each alert is raised once (per client, type and day, or per request/refund). **WhatsApp:** Critical alerts are written with *WhatsApp Status = Queued*. Zoho Books cannot send WhatsApp itself; whoever runs your WhatsApp sender (Zoho Flow, a WhatsApp Business integration, or a person) works from the *Queued* list and sets it to *Sent*.

## 6. Scale (10,000+ clients)

* Work is per client and event-driven: one request touches one client, about 10 API calls.
* With the two custom views (4.5) the engine reads only open requests and open refunds, so its cost does not grow with history.
* The backfill is batched; raise `BATCH` to match your plan's daily API allowance.
* The dashboard (Claude artifact "Client Fund Intelligence") reads the source modules live — CFDA balances, payment requests, refunds, Funds Reserved, alerts and audit log, 200 records per call — and works the figures out with the same rules, so it is correct before the Deluge is installed. It reads up to 600 clients and the 400 newest requests today; add pages to its datasets as the book grows.

## 7. Known limits

* **Freshness of the CFDA balance.** The engine trusts *Client CFDA Balance*, which the existing balance job maintains. If that job runs late, every figure here is as late as it is.
* **The existing CFDA check is not in this repository.** It still writes the original request fields. The engine adds to it and asks it to re-run when the balance moved; it does not replace it.
* **No automatic approval.** The engine flags; people approve.
