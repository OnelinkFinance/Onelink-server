// OneLink GP report automation — bound to a monthly "Onelink Solutions GP Report- <Month> <Year>" sheet
// (Extensions › Apps Script inside the sheet). Unlike ../Code.gs (the dashboard's read-only bridge), this
// script edits the sheet it is bound to, and only that sheet. Zoho Books is only read.
//
// On the Summary tab:
//   • Payment Status column: Paid when Payment Received equals Revenue to the cent, otherwise Pending.
//   • Pending rows are highlighted red and left out of the GP totals (Total Revenue, Total Expenses,
//     Final GP, Accrued Income, Net Cash GP and the column totals). Those are SUMIFS over Paid rows, so
//     they are right even before rows are moved. The Payment Received and Pending Payment column totals
//     still count every row.
//   • Pending rows are moved under a "PENDING PAYMENTS" line at the bottom of the table, and back into the
//     main table once paid in full. Each part is kept in S.No order.
//   • Typing an invoice number links it to that invoice in Zoho Books and fills "Zoho Books Client Name"
//     with the Zoho customer, linked to the contact.
//
// Set up: README.md next to this file.

const TAB = 'Summary';
const ZOHO_ORG = '898300452';                 // ELITE ONELINK CORPORATE SERVICES L.L.C S.O.C
const SEPARATOR = 'PENDING PAYMENTS — not in the GP totals until paid in full';
const SEPARATOR_RE = /^\s*PENDING PAYMENTS/i;
const KEY_HEADER = 'Sort key', STATUS_HEADER = 'Payment Status';
const RED = '#ea9999', GREY = '#d9d9d9';
const NOT_MONEY = ['notes', 'gp vs revenue'];  // columns between Revenue and Pending Payment that are not amounts

// ---- menu and triggers ----

function onOpen() {
  SpreadsheetApp.getUi().createMenu('GP automation')
    .addItem('Move paid / pending rows now', 'arrangeNow')
    .addItem('Fill missing Zoho invoice links', 'fillZohoLinks')
    .addSeparator()
    .addItem('Set up this sheet', 'setUpSheet')
    .addItem('Connect Zoho Books…', 'connectZoho')
    .addItem('Turn on automatic updates', 'turnOnAutomation')
    .addToUi();
  try { withLock_(() => arrange_(summary_())); } catch (err) { /* view-only users cannot move rows */ }
}

// Installable on-edit trigger (Turn on automatic updates). It has to be installable: a simple onEdit
// may not call Zoho.
function onGpEdit(e) {
  const range = e && e.range;
  if (!range || range.getSheet().getName() !== TAB) return;
  withLock_(() => {
    const sheet = range.getSheet(), L = layout_(sheet);
    if (!L) return;
    const r0 = Math.max(range.getRow(), L.start), r1 = Math.min(range.getLastRow(), L.end);
    if (r0 > r1) return;
    const touches = c => c >= range.getColumn() && c <= range.getLastColumn();
    if (touches(L.invoice)) {
      try { linkInvoices_(sheet, L, r0, r1, false); } catch (err) { sheet.getParent().toast(err.message, 'Zoho Books', 10); }
    }
    // Rows move when a payment is entered, or when Revenue changes on a row that already has one.
    // A new row whose Revenue is typed before its payment stays put (red) until then, or until the
    // sheet is next opened.
    const paidIn = () => sheet.getRange(r0, L.received, r1 - r0 + 1, 1).getValues().some(r => r[0] !== '');
    if (touches(L.received) || (touches(L.revenue) && paidIn())) arrange_(sheet);
  });
}

function arrangeNow() {
  const moved = withLock_(() => arrange_(summary_()));
  SpreadsheetApp.getActive().toast(moved ? 'Rows moved.' : 'Already in order.', 'GP automation', 5);
}

function fillZohoLinks() {
  const sheet = summary_(), L = need_(layout_(sheet));
  const res = withLock_(() => linkInvoices_(sheet, L, L.start, L.end, true));
  SpreadsheetApp.getUi().alert(`Looked up ${res.looked} invoice(s) in Zoho Books.` +
    (res.missing.length ? `\n\nNot found in Zoho Books (a note is on the cell): ${res.missing.join(', ')}` : ''));
}

function turnOnAutomation() {
  const ss = SpreadsheetApp.getActive();
  if (!ScriptApp.getUserTriggers(ss).some(t => t.getHandlerFunction() === 'onGpEdit'))
    ScriptApp.newTrigger('onGpEdit').forSpreadsheet(ss).onEdit().create();
  SpreadsheetApp.getUi().alert('Automatic updates are on for this file. Rows move when a payment is entered, and invoice numbers are linked to Zoho Books as they are typed.');
}

// ---- set-up: status column, red rows, paid-only totals ----

function setUpSheet() {
  const ui = SpreadsheetApp.getUi(), sheet = summary_(), L = need_(layout_(sheet));
  const ours = v => v === '' || typeof v === 'number' || [KEY_HEADER, STATUS_HEADER, 'Paid', 'Pending'].includes(v);
  const used = sheet.getRange(1, L.key, L.totals, 2).getValues().flat().filter(v => !ours(v));
  if (used.length) {
    ui.alert(`Columns ${col_(L.key)} and ${col_(L.status)} must be empty for the status column, but hold: ${used.slice(0, 5).join(', ')}. Nothing was changed.`);
    return;
  }
  const changed = withLock_(() => {
    sheet.getRange(L.start, L.key, L.end - L.start + 1, 1).clearContent();
    sheet.getRange(L.start - 1, L.key).setValue(KEY_HEADER);
    sheet.hideColumns(L.key);
    sheet.getRange(L.start - 1, L.status).setFormula(statusFormula_(L)).setFontWeight('bold');

    const ctx = totalsContext_(L);
    let n = 0;
    for (const row of [...Array(L.start - 1).keys()].map(i => i + 1).concat(L.totals)) {
      const cells = sheet.getRange(row, 1, 1, L.status).getFormulas()[0];
      cells.forEach((f, i) => {
        const g = f && paidOnly_(f, col_(i + 1), ctx);
        if (g && g !== f) { sheet.getRange(row, i + 1).setFormula(g); n++; }
      });
    }
    // Headline cells on automatic format took it from their SUM; SUMIFS does not pass it on.
    const head = sheet.getRange(1, 1, L.start - 1, L.status), formats = head.getNumberFormats();
    head.getFormulas().forEach((r, i) => r.forEach((f, j) => {
      if (f && ['', 'General', '0.###############'].includes(formats[i][j])) sheet.getRange(i + 1, j + 1).setNumberFormat('#,##0.00');
    }));

    const recv = '$' + col_(L.received) + L.start, st = '$' + col_(L.status) + L.start;
    const rules = sheet.getConditionalFormatRules().filter(rule => {
      const c = rule.getBooleanCondition();
      if (!c || c.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) return true;
      const f = String(c.getCriteriaValues()[0]);
      return !f.includes(recv) && !f.includes(st);       // drop the old "unpaid" highlight and our own
    });
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=${st}="Pending"`).setBackground(RED)
      .setRanges([sheet.getRange(L.start, 1, L.end - L.start + 1, L.status)]).build());
    sheet.setConditionalFormatRules(rules);

    SpreadsheetApp.flush();                                 // the status column has to show before rows move
    arrange_(sheet);
    return n;
  });
  ui.alert(`Set up done. ${changed} total(s) now count fully paid rows only. Pending rows are red and listed under "PENDING PAYMENTS".`);
}

// ={"Payment Status"; …} in the header row above the table, so rows inserted inside the table are covered.
function statusFormula_(L) {
  const r = c => `${col_(c)}${L.start}:${col_(c)}${L.end}`;
  return `={"${STATUS_HEADER}";ARRAYFORMULA(IF(${r(L.revenue)}="",,IF(IFERROR(ROUND(${r(L.received)},2)=ROUND(${r(L.revenue)},2),FALSE),"Paid","Pending")))}`;
}

function totalsContext_(L) {
  const money = [], payment = [col_(L.received), col_(L.pending)];
  for (let c = L.revenue; c <= L.pending; c++) if (!NOT_MONEY.includes(L.names[c - 1])) money.push(col_(c));
  return { start: L.start, end: L.end, status: col_(L.status), money, payment };
}

// =SUM(N8:N71) → =SUMIFS(N8:N73,$AM$8:$AM$73,"Paid") for every amount column of the table, wherever the
// SUM sits (D1, D4, the rows above the table, the totals row). The Payment Received / Pending Payment
// total in its own column keeps counting every row, over the whole table. Running it again only refreshes
// the row range.
const SUM_RE = /\bSUM(IFS)?\(\s*\$?([A-Z]{1,3})\$?(\d+)\s*:\s*\$?([A-Z]{1,3})\$?(\d+)\s*(,\s*\$?[A-Z]{1,3}\$?\d+\s*:\s*\$?[A-Z]{1,3}\$?\d+\s*,\s*"Paid"\s*)?\)/gi;
function paidOnly_(formula, cellCol, ctx) {
  return formula.replace(SUM_RE, (m, ifs, c1, r1, c2, r2, crit) => {
    const c = c1.toUpperCase();
    if ((ifs && !crit) || c !== c2.toUpperCase() || +r1 !== ctx.start || !ctx.money.includes(c)) return m;
    const rows = `${c}${ctx.start}:${c}${ctx.end}`;
    if (ctx.payment.includes(c) && c === cellCol) return `SUM(${rows})`;
    return `SUMIFS(${rows},$${ctx.status}$${ctx.start}:$${ctx.status}$${ctx.end},"Paid")`;
  });
}

// ---- moving rows ----

// Returns true when rows moved. The sort runs on columns A to the hidden sort key column, which carries
// each row's new position for that one sort and is cleared afterwards; formats, links and checkboxes move
// with their row.
function arrange_(sheet) {
  let L = layout_(sheet);
  if (!L || !L.ready) return false;
  let rows = rows_(sheet, L);
  if (!rows.some(r => r.separator)) {
    const spare = rows.filter(r => r.empty).pop();
    let at;
    if (spare) at = L.start + spare.i;
    else { sheet.insertRowBefore(L.end); at = L.end; L = layout_(sheet); }
    const line = sheet.getRange(at, 1, 1, L.zohoName);
    line.clearContent().clearDataValidations().setFontWeight('bold').setBackground(GREY);
    sheet.getRange(at, L.date).setValue(SEPARATOR);
    rows = rows_(sheet, L);
  }
  const order = arrangeOrder_(rows);
  if (order.every((r, k) => r.i === k)) return false;
  const keys = [];
  order.forEach((r, k) => { keys[r.i] = [k + 1]; });
  const keyCol = sheet.getRange(L.start, L.key, keys.length, 1);
  keyCol.setValues(keys);
  sheet.getRange(L.start, 1, keys.length, L.key).sort({ column: L.key, ascending: true });
  keyCol.clearContent();
  return true;
}

function rows_(sheet, L) {
  const typed = [L.date, L.invoice, L.client, L.company, L.services, L.revenue, L.received].filter(c => c > 0);
  return sheet.getRange(L.start, 1, L.end - L.start + 1, L.status).getValues().map((r, i) => ({
    i, sNo: r[0], status: String(r[L.status - 1]),
    separator: SEPARATOR_RE.test(String(r[L.date - 1])),
    empty: typed.every(c => r[c - 1] === '')
  }));
}

// Main table (paid rows, and rows still being typed in) first, then the spare rows, the PENDING PAYMENTS
// line and the pending rows. Paid and pending rows are in S.No order; everything else keeps its order.
function arrangeOrder_(rows) {
  const group = r => r.separator ? 3 : r.status === 'Pending' ? 4 : r.empty ? 2 : 1;
  const sNo = r => {
    const s = String(r.sNo).trim();
    return s !== '' && isFinite(s) ? Number(s) : Infinity;
  };
  return rows.slice().sort((a, b) => {
    const g = group(a) - group(b);
    if (g) return g;
    const n = group(a) === 1 || group(a) === 4 ? sNo(a) - sNo(b) : 0;
    return n || a.i - b.i;   // Infinity - Infinity is NaN, which falls through too
  });
}

// ---- Zoho Books ----

function linkInvoices_(sheet, L, r0, r1, onlyMissing) {
  const n = r1 - r0 + 1, p = props_(), inv = sheet.getRange(r0, L.invoice, n, 1);
  const text = inv.getDisplayValues(), rich = inv.getRichTextValues();   // rich is null for a number
  const names = sheet.getRange(r0, L.zohoName, n, 1).getValues();
  const res = { looked: 0, missing: [] };
  for (let k = 0; k < n; k++) {
    const number = text[k][0].trim(), linked = rich[k][0] && rich[k][0].getLinkUrl();
    if (!number || SEPARATOR_RE.test(number) || (onlyMissing && linked && names[k][0] !== '')) continue;
    if (res.looked++) Utilities.sleep(700);               // Zoho allows 100 calls a minute
    const found = zohoInvoice_(number), cell = sheet.getRange(r0 + k, L.invoice);
    if (!found) { cell.setNote('Not found in Zoho Books'); res.missing.push(number); continue; }
    const url = zohoLinks_(found, p.org, p.dc), name = found.customer_name || found.company_name || '';
    cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(number).setLinkUrl(url.invoice).build()).clearNote();
    if (name) sheet.getRange(r0 + k, L.zohoName).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(name).setLinkUrl(url.contact).build());
  }
  return res;
}

function zohoLinks_(invoice, org, dc) {
  const app = `https://books.zoho.${dc || 'com'}/app/${org || ZOHO_ORG}#/`;
  return { invoice: app + 'invoices/' + invoice.invoice_id, contact: app + 'contacts/' + invoice.customer_id };
}

function zohoInvoice_(number) {
  const want = number.toUpperCase();
  const j = zoho_('invoices', { invoice_number: want });
  return (j.invoices || []).find(i => String(i.invoice_number).toUpperCase() === want) || null;
}

function zoho_(path, params) {
  const p = props_();
  const q = Object.entries(Object.assign({ organization_id: p.org }, params)).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  for (let retry = false; ; retry = true) {
    const res = UrlFetchApp.fetch(`https://www.zohoapis.${p.dc}/books/v3/${path}?${q}`,
      { headers: { Authorization: 'Zoho-oauthtoken ' + accessToken_(retry) }, muteHttpExceptions: true });
    if (res.getResponseCode() === 401 && !retry) continue;
    const j = json_(res);
    if (res.getResponseCode() !== 200 || j.code !== 0) throw new Error('Zoho Books: ' + (j.message || 'HTTP ' + res.getResponseCode()));
    return j;
  }
}

function accessToken_(fresh) {
  const cache = CacheService.getScriptCache();
  const cached = !fresh && cache.get('zoho_token');
  if (cached) return cached;
  const p = props_();
  if (!p.refresh) throw new Error('Zoho Books is not connected. Use GP automation › Connect Zoho Books.');
  const j = token_(p, { refresh_token: p.refresh, grant_type: 'refresh_token' });
  if (!j.access_token) throw new Error(`Zoho sign-in failed (${j.error || 'no token'}). Use GP automation › Connect Zoho Books again.`);
  cache.put('zoho_token', j.access_token, Math.max(60, (j.expires_in || 3600) - 300));
  return j.access_token;
}

function connectZoho() {
  const ui = SpreadsheetApp.getUi();
  const ask = (step, text) => {
    const r = ui.prompt(`Connect Zoho Books (${step}/3)`, text, ui.ButtonSet.OK_CANCEL);
    return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : '';
  };
  const id = ask(1, 'Client ID of your Zoho Self Client (api-console.zoho.com):'); if (!id) return;
  const secret = ask(2, 'Client Secret of the same Self Client:'); if (!secret) return;
  const code = ask(3, 'Grant code: Self Client › Generate Code, scope ZohoBooks.invoices.READ, then paste it here within its time limit:'); if (!code) return;
  const p = Object.assign(props_(), { id, secret });
  const j = token_(p, { code, grant_type: 'authorization_code' });
  if (!j.refresh_token) { ui.alert(`Zoho did not accept the code (${j.error || 'no refresh token'}). Generate a new code and try again.`); return; }
  PropertiesService.getScriptProperties().setProperties({ ZOHO_CLIENT_ID: id, ZOHO_CLIENT_SECRET: secret, ZOHO_REFRESH_TOKEN: j.refresh_token });
  CacheService.getScriptCache().remove('zoho_token');
  ui.alert('Zoho Books is connected. Use "Turn on automatic updates" if you have not yet.');
}

function token_(p, params) {
  const q = Object.entries(Object.assign({ client_id: p.id, client_secret: p.secret }, params)).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  return json_(UrlFetchApp.fetch(`https://accounts.zoho.${p.dc}/oauth/v2/token?${q}`, { method: 'post', muteHttpExceptions: true }));
}

// Script properties: set by Connect Zoho Books. ZOHO_DC (default com) and ZOHO_ORG can be added by hand.
function props_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  return { id: p.ZOHO_CLIENT_ID, secret: p.ZOHO_CLIENT_SECRET, refresh: p.ZOHO_REFRESH_TOKEN, dc: p.ZOHO_DC || 'com', org: p.ZOHO_ORG || ZOHO_ORG };
}

// ---- sheet layout ----

// Columns are found by their header text, as the dashboard does. The table runs from two rows under the
// "S.No" header to the row above the totals row (the first row whose Revenue cell sums the table).
// The hidden sort key and the Payment Status columns sit right of "Zoho Books Client Name".
function layout_(sheet) {
  if (!sheet) return null;
  const width = sheet.getMaxColumns(), top = sheet.getRange(1, 1, Math.min(12, sheet.getMaxRows()), width).getDisplayValues();
  const h = top.findIndex(r => norm_(r[0]) === 's no');
  if (h < 0 || !top[h + 1]) return null;
  const names = top[h].map((v, i) => norm_(String(top[h + 1][i]).trim() ? top[h + 1][i] : v));
  const col = name => names.indexOf(name) + 1;
  const L = {
    names, start: h + 3, date: col('date'), invoice: col('invoice'), client: col('client name'), company: col('company name'),
    services: col('package services'), revenue: col('revenue'), received: col('payment received'), pending: col('pending payment'),
    zohoName: col('zoho books client name')
  };
  if (!L.date || !L.invoice || !L.revenue || !L.received || !L.pending || !L.zohoName) return null;
  L.key = L.zohoName + 1;
  L.status = L.zohoName + 2;
  if (L.status > width) return null;
  const sumOfTable = new RegExp(`^=\\s*SUM(IFS)?\\(\\s*\\$?${col_(L.revenue)}\\$?${L.start}\\b`, 'i');
  const t = sheet.getRange(L.start, L.revenue, sheet.getMaxRows() - L.start + 1, 1).getFormulas().findIndex(r => sumOfTable.test(r[0]));
  if (t < 1) return null;
  L.totals = L.start + t;
  L.end = L.totals - 1;
  L.ready = norm_(sheet.getRange(L.start - 1, L.status).getDisplayValue()) === norm_(STATUS_HEADER);
  return L;
}

function need_(L) {
  if (!L) throw new Error(`The ${TAB} tab does not look like a GP report: no "S.No" header, a needed column, or the totals row.`);
  return L;
}

function summary_() { return SpreadsheetApp.getActive().getSheetByName(TAB); }

function withLock_(fn) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('The sheet is busy; try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(res) { try { return JSON.parse(res.getContentText()); } catch (err) { return {}; } }
function norm_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function col_(n) { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
