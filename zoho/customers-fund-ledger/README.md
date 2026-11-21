# Customers Fund Ledger — P&L review

The "P&L review" tab of the Customers Fund Ledger page (Claude artifact). Two files, served beside the page's `index.html`:

| File | What it does |
|---|---|
| `pnl-engine.js` | Pure logic, no page or network access. `PNLEngine.analyse()` builds the P&L by account and month and runs the checks; `PNLEngine.statement()` totals a chosen set of months. Runs in Node for testing. |
| `pnl.js` | The screen. Reads the ledger lines and the chart of accounts from Zoho Analytics, and each expense's description, receipt and supplier from Zoho Books (`list_expenses`, 200 a page). |

## Checks

| Priority | Check |
|---|---|
| Must fix | Entry in a holding account (Uncategorized, clearing) · Entry dated after today |
| Check | Probably in the wrong account (same supplier or wording is booked elsewhere nearly every time) · Client cost booked as overhead · Cost of sale with no client · Posted on the wrong side · Income booked by journal · Possible duplicates · Monthly cost missing or doubled · Unusually large for its account · Entered long after its date · Same kind of cost in two sections · Posted to a group account · Vague account · No reference · No description in Zoho Books · No receipt attached |
| Tidy up | Accounts used once or twice · Accounts never used |

## Views

| View | What it shows |
|---|---|
| Every entry | `PNLEngine.review()`: each income and cost entry of the period with a verdict (Justified, Reference only, To check, Must fix), what is wrong, what supports it (precedent: how the same supplier, merchant or reference wording is booked elsewhere) and what to do. |
| Month pack | `PNLEngine.monthPack()`: a month against the previous month and its three-month average, the accounts that moved and the entries behind them, and regular costs with nothing booked. |
| Change log | `PNLEngine.changes()`: entries entered or edited in the period by Zoho's timestamps, marking those that changed a month after it ended. Old and new values (account, amount, date, deletions) of cost-of-sales and disbursement entries come from a snapshot kept in the viewer's browser at each refresh. |
| Overview | The checks list and the P&L by period. |

## Privacy

The page is shared by link, so no P&L data is stored in it or in its shared database. Each viewer reads the figures with their own Zoho access; they are cached only in that viewer's browser (ledger lines for the tab session, Books descriptions for 12 hours).

## Publishing

Upload both files to the artifact with `publish_files` (mode `patch`). `index.html` loads them with `<script src>` just before the `glass-ui` script, and holds the tab button (`data-t="pnl"`) and `<section id="p-pnl"><div id="pnlRoot"></div></section>`.

# Fund requests tab

`cfi.js` shows every Client Payment Request (`cm_client_payment_request`, read live with `list_custom_module_records`) as a glass card with an analysis of the request: whether the client's CFDA funds cover it, what is committed to the client's other open requests, whether Zoho's own check is still current, possible duplicates, waiting time and the client's request history. `cfi-engine.js` is a browser copy of `server/cfi-engine.js`.

The client's balance comes from `cm_client_cfda_balance`, and the client's latest CFDA entries (`cm_cfda_statement_line`) are read when a request is opened. Expected refunds and reserved funds are taken as zero. The background (six choices) is remembered in the viewer's browser.

Each request shows who created it (the Zoho Books user behind `created_by_id`; names come from `list_users`, with a built-in list as fallback) and the tab can be filtered to one creator.

# Page-wide glass theme

`ol-theme.css` and `ol-theme.js` put the whole page on a chosen background (Aurora, Emerald, Dusk, Ocean, Sand, Mist) with glass cards, header and sidebar. The switcher sits in the page header; "Original" turns the theme off. The choice is kept in the viewer's browser (`ol.bg`). The stylesheet only overrides colour tokens and surface styles, so it must load after `onelink-redesign.css`.
