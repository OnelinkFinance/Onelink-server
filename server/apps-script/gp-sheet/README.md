# GP report automation (Apps Script inside the GP report)

`Code.gs` runs inside a monthly "Onelink Solutions GP Report- <Month> <Year>" sheet. On the **Summary** tab it:

- Adds a **Payment Status** column (AM): **Paid** when Payment Received equals Revenue to the cent, otherwise **Pending**.
- Highlights pending rows red.
- Leaves pending rows out of Total Revenue, Total Expenses, Final GP, Accrued Income, Net Cash GP and the column totals.
  These become `SUMIFS(…, Payment Status, "Paid")`, so they are right even before any row moves.
  The Payment Received and Pending Payment column totals (AG6, AH6) still count every row.
- Moves pending rows under a grey **PENDING PAYMENTS** line at the bottom of the table, and moves them back up once they are paid in full.
  - When it runs: when a payment is entered, when the sheet is opened, or from the menu.
  - Order: the main table and the pending section are each kept in S.No order.
- Links an invoice number to that invoice in Zoho Books as soon as it is typed in **Invoice** (C).
  It also fills **Zoho Books Client Name** (AK) with the Zoho customer, linked to the contact.
  If the number is not in Zoho, the cell gets a note "Not found in Zoho Books".

It only edits the sheet it sits in, and only reads Zoho Books (scope `ZohoBooks.invoices.READ`).

## Set up (once per file, about 5 minutes)

Do this signed in as **finance@onelink.solutions**.

1. Open the GP report. Go to **Extensions › Apps Script**.
2. Replace the editor contents with `Code.gs`.
3. Show the manifest: ⚙ **Project Settings** › tick **Show "appsscript.json"**. Replace its contents with `appsscript.json`. Save.
4. Back in the sheet, reload the page. A **GP automation** menu appears.
5. Run **GP automation › Set up this sheet**, then allow the permissions.
   It adds the status column, the red highlight, the paid-only totals and the PENDING PAYMENTS line, and moves the rows.
6. Connect Zoho Books, as follows.
   1. In [api-console.zoho.com](https://api-console.zoho.com), open the **Self Client** (the one the server uses is fine).
   2. Go to **Generate Code**. Use scope `ZohoBooks.invoices.READ`, duration 10 minutes, then copy the code.
   3. Run **GP automation › Connect Zoho Books…** and paste the Client ID, the Client Secret and the code.
7. Run **GP automation › Turn on automatic updates**. Only one person needs to do this per file.
8. Optional: run **GP automation › Fill missing Zoho invoice links** to link invoice numbers typed before set-up.

## Each new month

"Make a copy" of the GP report copies the script, the status column and the formulas with it. Two things do not carry over:

- **Turn on automatic updates** must be run again in the new file (Google does not copy triggers).
- **Connect Zoho Books** must be run again if the new file says Zoho Books is not connected.

## Good to know

- **Adding rows:** insert rows inside the table, not directly above the totals row. That keeps them inside the status and totals ranges.
  If rows were added below the range, run **Set up this sheet** again; it refreshes the ranges.
- **Not changed:** these still count every row, paid or pending:
  - the AGENT, COMISSIONS, team, Income by Source and No. of Services tabs;
  - the free zone commission dashboard.
- **Receivables tab:** it still lists the pending rows.
- **Zoho credentials:** the Client ID, Client Secret and refresh token are kept in the script's properties.
  Anyone who can edit the sheet can open them, which is why the token is limited to reading invoices.
- **Other Zoho data centre:** the default is `.com`. For another one, add the script property `ZOHO_DC` (for example `eu`) and change the two addresses in `appsscript.json` to match.
- **Undo:** use **File › Version history**, and remove the script under Extensions › Apps Script.
