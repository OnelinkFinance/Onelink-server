# Free Zone Master Commission Dashboard — read-only spec

What `/commissions` does, written so it can also be pasted as a Claude Design project description.
The rules match the code in `commissions-core.js` / `commissions.js`.

## 1. Read-only principle

Never modify, overwrite or delete anything in these sources. Only read them.

- **Freezone_Commission_Collection_Tracker** (the existing finance workbook — all tabs, including the May–Sept data)
- **GP report folder**: the monthly "Onelink Solutions GP Report- <Month> <Year>" sheets
- **Zoho Books**: ELITE ONELINK CORPORATE SERVICES L.L.C S.O.C
- **Renewals** Google Sheet
- **Gmail** (optional)

Every match, status, flag and total exists only in the dashboard's own output, never in a source sheet.

How the code enforces this:
- Google is reached with `drive.readonly`, `spreadsheets.readonly` and `gmail.readonly` scopes only.
- Zoho Books is called with GET only.
- `test/read-only.test.js` fails if a write call or a non-readonly scope is ever added.

## 2. Sources and the columns used

| Source | Tab | Columns read |
|---|---|---|
| Commission tracker (**baseline**) | GP Commission Lines | Date · Free zone · INV ref · Client name · Company name · Package / service · Free zone commission to invoice (AED) · Status (Invoiced / Uninvoiced / Missed / No commission) · Notes (holds the commission invoice no.) · Flag |
| Commission tracker | Invoice Checklist | Date · Free Zone · Invoice / Doc No · Amount (AED) · Status (RECEIVED / TO COLLECT / CANCELLED) · Received on · Days taken · Still to collect · Days outstanding · Notes |
| GP report (one per month) | Summary | S.No · Date · Invoice · Client Name · Company Name · Agent Name · service flags (0 VISA, With Visa, Renewals) · Package Services · Free zone Commission · free zone fee columns (Meydan, IFZA, RAKEZ, RAK DAO, Dubai South…) |
| Zoho Books | Invoices | Client invoices by number (status). Commission invoices to the four free zone customers (number, date, ex-VAT, total, balance, line text). |
| Renewals sheet | Renewal | Company · Authority · Expiry Date · Date of Renewal · Status · Progress · Remarks · Account Manager |
| Gmail (optional) | — | Subject, sender, date of free zone and renewal emails |

The free zones tracked are RAK DAO, RAK ICC, Meydan and RAKEZ. Dubai South, IFZA and the rest are summed as "Other free zones", so the totals still match the GP report.

None of the sources has a licence number column. Matching therefore uses the client invoice number, company name, free zone and date.

## 3. Matching

| Join | Rule |
|---|---|
| Tracker line ↔ GP report row | Same client invoice no. (INV ref = GP "Invoice"). Otherwise: same company or client name, same free zone, and dates within 7 days. |
| Deal ↔ Zoho client invoice | The invoice number exists in Zoho Books and is not void or draft. |
| Tracker line ↔ commission invoice | Invoice no. in the tracker's Notes → that row on the Invoice Checklist → the same number in Zoho Books. |
| Zoho commission invoice → month it bills | The month in the number (INV-RAKDAO-082026 = Aug 2026), else a month named in the invoice text, else the month before the invoice date. |
| Renewals row ↔ deal | Same free zone, same company, a renewal deal within ~5 months of expiry. |
| Email ↔ deal | Company name in the subject or snippet. Free zone from the sender's domain. |

Company names are compared without legal suffixes (LLC, FZ, FZCO, LTD, L.L.C…), punctuation or plurals. "Redacted Group LLC FZ" therefore matches "Redacted Group L.L.C - FZ".

## 4. Status of each transaction (first rule that applies)

1. **Commission missed**: the tracker says Missed.
2. **Pending invoice**: no client invoice no., or it isn't in Zoho Books, or it is void or draft.
3. **Pending GP**: on the tracker, but not on that month's GP report.
4. **Pending commission invoice**: there is commission, and the tracker says Uninvoiced or is blank, or the commission invoice was cancelled.
5. **Not on tracker**: on the GP report, but missing from GP Commission Lines (from the first month the tracker covers).
6. **Awaiting payment**: commission invoiced, and the Invoice Checklist says TO COLLECT.
7. **No commission**: the tracker says No commission (e.g. Innovation City net-off). This is not treated as an exception.
8. **Completed**: everything is present and the commission was received.

Renewals that are due within 60 days or overdue, with no GP or tracker entry, show as **Renewal not started**, **Overdue** or **In progress**. In progress means a Progress note such as "Invoice sent", or a matching email.

## 5. Views

1. **Monthly commission summary** (by month × free zone)
   - Transactions, with New and Renewal counts and commission for each.
   - Gross fees (free zone fee on the GP report).
   - Total commission, Invoiced, Not yet invoiced, Missed.
   - GP report commission, as a cross-check.
   - Status: **Finalized** means every commission line is invoiced or confirmed, and tracker = GP report. Otherwise **Under review**.
   - Baseline: tracker figures where the tracker covers the month (May 2026 onward), else the GP report.
2. **Transaction log** (selected month), one row per deal:
   - Date, client / company, free zone, type, service, agent.
   - Source rows (tracker row, GP row, Renewals row).
   - GP entry, tracker status, client invoice and its Zoho status.
   - Gross fee, commission, commission %.
   - Commission invoice and its collection status.
   - Renewals sheet status, email, overall status and what is missing.
   - Downloads as CSV.
3. **Exceptions**:
   - Commission missed.
   - Client invoice missing.
   - On the tracker but not on the GP report, or the reverse.
   - Commission differs between the tracker and the GP report.
   - Commission not yet invoiced, grouped by free zone and month, with the age of the oldest deal.
   - Commission invoices unpaid for more than 30 days.
   - Zoho and tracker disagree on an invoice.
   - Renewals overdue, or due within 30 days and not started.
   - Unclear dates.
4. **Renewals**: due within 60 days or overdue, with their state.
5. **Commission invoices**: the Invoice Checklist exactly as the sheet computes it, checked against Zoho Books.

## 6. Totals the dashboard must reproduce (checked 6 Oct 2026)

- Still to collect: **AED 80,474.95 across 6 invoices**. This matches the tracker's COMMISSION INVOICED DASHBOARD.
- September 2026 free zone commission: **AED 53,446.70**. This matches the GP report Summary and the tracker lines.
