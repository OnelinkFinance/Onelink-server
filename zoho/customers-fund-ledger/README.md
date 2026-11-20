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

## Privacy

The page is shared by link, so no P&L data is stored in it or in its shared database. Each viewer reads the figures with their own Zoho access; they are cached only in that viewer's browser (ledger lines for the tab session, Books descriptions for 12 hours).

## Publishing

Upload both files to the artifact with `publish_files` (mode `patch`). `index.html` loads them with `<script src>` just before the `glass-ui` script, and holds the tab button (`data-t="pnl"`) and `<section id="p-pnl"><div id="pnlRoot"></div></section>`.

# Fund intelligence tab

`cfi.js` reads four Zoho Books custom modules live (`list_custom_module_records`, 200 a page) and `cfi-engine.js` (a browser copy of `server/cfi-engine.js`) works out each client's position:

| Module | Used for |
|---|---|
| `cm_client_cfda_balance` | received, paid out and balance per client |
| `cm_client_payment_request` | open requests, and whether each is covered or short |
| `cm_cfda_statement_line` | newest lines, and every line of a client when it is opened |
| `cm_deal_submission` | listed as entered; fields are shown as they come |

The Client Refund, Client Fund Intelligence, Fund Alert and Fund Audit Log modules described in `zoho/client-fund-intelligence/` are not read here; expected refunds and reserved funds are therefore taken as zero.
