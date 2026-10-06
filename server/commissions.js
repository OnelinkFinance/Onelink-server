// Free zone commission dashboard — loads the live sources and serves /commissions + /api/commissions.
// Logic lives in commissions-core.js; this file only fetches, caches and reports what each source said.
//
// READ-ONLY. Google is reached with *.readonly scopes only and only list/get calls (or through the read-only
// Apps Script bridge in apps-script/); Zoho with SELECT exports from Zoho Analytics and GET from Zoho Books
// (the shared helpers never send a body). Nothing is ever written back to any source.
// test/read-only.test.js fails the build if a write call or a non-readonly scope appears in this file.
//
// Env — Google needs ONE of these two:
//   SHEETS_BRIDGE_URL + SHEETS_BRIDGE_KEY   the free route: the read-only Apps Script in apps-script/, deployed
//                               as a web app by an account that can open the sheets (no Google Cloud, no billing)
//   GOOGLE_SERVICE_ACCOUNT_B64  a Google Cloud service account. Share the GP report shared drive, the tracker
//                               and the Renewals sheet with its client_email (Viewer is enough).
//   GP_REPORT_DRIVE_ID          shared drive holding the monthly GP reports (default: searched in every drive)
//   GP_REPORT_TAB               tab read from each GP report (default "Summary")
//   RENEWALS_SHEET_ID / RENEWALS_TAB   default: the "Renewals" sheet, tab "Renewal"
//   TRACKER_SHEET_ID            default: "Freezone_Commission_Collection_Tracker" (tabs "GP Commission Lines",
//                               "Invoice Checklist") — the existing finance workbook, used as the baseline
//   GMAIL_IMPERSONATE           mailbox to read (e.g. finance@onelink.solutions). Needs domain-wide delegation
//                               of gmail.readonly to the service account. Unset → the email column is skipped.
//   COMMISSION_RENEWAL_WINDOW_DAYS  renewals due within this many days count as pending (default 60)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import * as core from './commissions-core.js';

const E = process.env;
const DEFAULT_RENEWALS = '111d7I-jqSHXAIzA4WFEbXEOOrylJhgPXIITb4JqWox0';
const DEFAULT_TRACKER = '1E0YrI0wkgpGfgwmzbujIcLxM47ct7hZmPeQOS60-v5w';
const TTL = 5 * 60_000;
const short = e => String(e?.errors?.[0]?.message || e?.message || e).slice(0, 300);

function creds() {
  const b64 = E.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('GOOGLE_SERVICE_ACCOUNT_B64 not set');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}
const jwt = (scopes, subject) => { const c = creds(); return new google.auth.JWT({ email: c.client_email, key: c.private_key, scopes, subject }); };
const ro = () => jwt(['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets.readonly']);
const shareHint = () => { if (bridge()) return ''; try { return ` — share it with ${creds().client_email}`; } catch { return ' — set SHEETS_BRIDGE_URL + SHEETS_BRIDGE_KEY (free Apps Script route) or GOOGLE_SERVICE_ACCOUNT_B64'; } };

// The free route: the read-only Apps Script web app (apps-script/Code.gs). GET only.
const bridge = () => !!(E.SHEETS_BRIDGE_URL && E.SHEETS_BRIDGE_KEY);
async function bridgeGet(params) {
  const u = new URL(E.SHEETS_BRIDGE_URL);
  for (const [k, v] of Object.entries({ ...params, key: E.SHEETS_BRIDGE_KEY })) u.searchParams.set(k, v);
  const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(45_000) });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error('Sheets bridge: ' + (j?.error || 'HTTP ' + r.status));
  return j;
}

// Small parallel map so 100 Gmail / Books lookups don't fire at once.
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// ---- Google: GP reports + Renewals ----
let reportList = { at: 0, files: null };
async function gpReports() {
  if (reportList.files && Date.now() - reportList.at < TTL) return reportList.files;
  let files;
  if (bridge()) files = (await bridgeGet({ action: 'reports' })).files || [];
  else {
    const drive = google.drive({ version: 'v3', auth: ro() });
    const r = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and name contains 'GP Report' and trashed=false",
      fields: 'files(id,name,modifiedTime,webViewLink)', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
      ...(E.GP_REPORT_DRIVE_ID ? { corpora: 'drive', driveId: E.GP_REPORT_DRIVE_ID } : { corpora: 'allDrives' })
    });
    files = r.data.files || [];
  }
  const byMonth = {};
  for (const f of files) {
    const m = core.gpReportMonth(f.name);
    if (m && (!byMonth[m] || f.modifiedTime > byMonth[m].modifiedTime)) byMonth[m] = f;
  }
  reportList = { at: Date.now(), files: byMonth };
  return byMonth;
}
async function sheetValues(spreadsheetId, range) {
  if (bridge()) return (await bridgeGet({ action: 'values', id: spreadsheetId, range })).values || [];
  const sheets = google.sheets({ version: 'v4', auth: ro() });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
  return r.data.values || [];
}

// ---- Zoho invoices through Zoho Analytics (the synced "Invoices" table; SELECT only) ----
const sqlStr = v => "'" + String(v).replace(/'/g, "''") + "'";
const money2 = v => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
const zStatus = s => /^closed$/i.test(s) ? 'paid' : String(s || '').toLowerCase();
async function zoneInvoicesAnalytics(analytics, from, to) {
  const ids = core.TRACKED.map(z => sqlStr(z.booksCustomerId)).join(',');
  const rows = await analytics(`select "Invoice ID", "Invoice Number", "Invoice Date", "Invoice Status", "Customer ID", "Purchase Order#", round("Sub Total (BCY)", 2) as sub_total, round("Total (BCY)", 2) as total, round("Balance (BCY)", 2) as balance from "Invoices" where "Customer ID" in (${ids}) and "Invoice Date" >= ${sqlStr(from + '-01')} and "Invoice Date" <= ${sqlStr(core.addDays(core.monthEnd(to), 75))}`);
  return rows.filter(r => !/void/i.test(r['Invoice Status'])).map(r => {
    const zone = core.TRACKED.find(z => z.booksCustomerId === String(r['Customer ID']))?.code;
    const date = core.parseSheetDate(r['Invoice Date']).date;
    const p = core.invoicePeriod({ invoice_number: r['Invoice Number'], reference_number: r['Purchase Order#'], date });
    return { zone, id: r['Invoice ID'], number: String(r['Invoice Number']).toUpperCase(), date, status: zStatus(r['Invoice Status']), period: p.month, periodBasis: p.basis,
      subTotal: money2(r.sub_total), total: money2(r.total), balance: money2(r.balance), reference: r['Purchase Order#'] || '' };
  }).filter(i => i.zone && i.period >= from && i.period <= to);
}
async function clientInvoicesAnalytics(analytics, wanted) {
  const map = new Map(wanted.map(n => [n, null]));
  if (!wanted.length) return map;
  const rows = await analytics(`select "Invoice Number", "Invoice Status", "Invoice Date", round("Total (BCY)", 2) as total, round("Balance (BCY)", 2) as balance from "Invoices" where "Invoice Number" in (${wanted.map(sqlStr).join(',')})`);
  for (const r of rows) map.set(String(r['Invoice Number']).toUpperCase(), { status: zStatus(r['Invoice Status']), total: money2(r.total), balance: money2(r.balance), date: core.parseSheetDate(r['Invoice Date']).date });
  return map;
}

// ---- Zoho Books (fallback when Analytics is not available) ----
const invDetail = new Map(); // invoice_id -> { modified, inv }
async function listInvoices(books, params) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await books('invoices', { ...params, per_page: '200', page: String(page) });
    out.push(...(j?.invoices || []));
    if (!j?.page_context?.has_more_page) break;
  }
  return out;
}
// GP rows carry the client invoice number; look each one up among the month's invoices (± 15 days), then singly.
async function clientInvoices(books, month, wanted) {
  const list = await listInvoices(books, { date_start: core.addDays(month + '-01', -15), date_end: core.addDays(core.monthEnd(month), 15) });
  const map = new Map(list.map(i => [String(i.invoice_number).toUpperCase(), { id: i.invoice_id, status: i.status, total: i.total, balance: i.balance, date: i.date, customer: i.customer_name }]));
  const missing = wanted.filter(n => n && !map.has(n)).slice(0, 25);
  await pool(missing, 4, async n => {
    const j = await books('invoices', { invoice_number: n });
    const i = (j?.invoices || []).find(x => String(x.invoice_number).toUpperCase() === n);
    map.set(n, i ? { id: i.invoice_id, status: i.status, total: i.total, balance: i.balance, date: i.date, customer: i.customer_name } : null);
  });
  for (const n of wanted) if (n && !map.has(n)) map.set(n, null);
  return map;
}
// Commission invoices raised to each tracked free zone, with the month each one bills.
async function zoneInvoices(books, from, to) {
  const out = [];
  for (const z of core.TRACKED) {
    const list = await listInvoices(books, { customer_id: z.booksCustomerId, date_start: from + '-01', date_end: core.addDays(core.monthEnd(to), 75) });
    const live = list.filter(i => !/void|draft/i.test(i.status));
    const details = await pool(live, 4, async i => {
      const hit = invDetail.get(i.invoice_id);
      if (hit && hit.modified === i.last_modified_time) return hit.inv;
      const j = await books('invoices/' + i.invoice_id, {});
      const inv = j?.invoice || i;
      invDetail.set(i.invoice_id, { modified: i.last_modified_time, inv });
      return inv;
    });
    for (const inv of details) {
      const p = core.invoicePeriod(inv);
      out.push({ zone: z.code, id: inv.invoice_id, number: inv.invoice_number, date: inv.date, status: inv.status, period: p.month, periodBasis: p.basis,
        subTotal: Number(inv.sub_total ?? inv.total) || 0, total: Number(inv.total) || 0, balance: Number(inv.balance) || 0, reference: inv.reference_number || '' });
    }
  }
  return out.filter(i => i.period >= from && i.period <= to);
}

// ---- Gmail (optional) ----
async function gmailMessages(from, to) {
  const gmail = google.gmail({ version: 'v1', auth: jwt(['https://www.googleapis.com/auth/gmail.readonly'], E.GMAIL_IMPERSONATE) });
  const domains = core.ZONES.flatMap(z => z.domains).map(d => 'from:' + d).join(' ');
  const q = `after:${from.replace(/-/g, '/')} before:${to.replace(/-/g, '/')} ({${domains}} OR "RAK DAO" OR "RAK ICC" OR Meydan OR RAKEZ OR "business license" OR "company setup" OR incorporation OR renewal)`;
  const ids = [];
  let pageToken;
  do {
    const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    ids.push(...(r.data.messages || []).map(m => m.id));
    pageToken = r.data.nextPageToken;
  } while (pageToken && ids.length < 300);
  return pool(ids, 8, async id => {
    const m = (await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })).data;
    const h = n => (m.payload?.headers || []).find(x => x.name.toLowerCase() === n)?.value || '';
    return { id, subject: h('subject'), from: h('from'), date: new Date(Number(m.internalDate)).toISOString().slice(0, 10), snippet: m.snippet || '', url: `https://mail.google.com/mail/u/0/#all/${m.threadId}` };
  });
}

// ---- assemble ----
const dubaiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
const cache = new Map(); // key -> { at, data }
const gpCache = new Map(); // fileId -> { modified, parsed }

export async function loadDashboard({ books, analytics, month, span = 6, refresh = false }) {
  const key = `${month}|${span}`, hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };
  if (refresh) reportList.at = 0;
  const today = dubaiToday();
  const months = Array.from({ length: span }, (_, i) => core.addMonths(month, i - span + 1));
  const sources = {};
  const gp = {}, reports = {};

  try {
    const files = await gpReports();
    await Promise.all(months.map(async m => {
      const f = files[m];
      if (!f) return;
      reports[m] = { name: f.name, url: f.webViewLink };
      const c = gpCache.get(f.id);
      if (c && c.modified === f.modifiedTime) { gp[m] = c.rows; return; }
      const parsed = core.parseGpReport(await sheetValues(f.id, `'${E.GP_REPORT_TAB || 'Summary'}'!A1:AP2000`), m);
      if (parsed.error) { reports[m].error = parsed.error; return; }
      gpCache.set(f.id, { modified: f.modifiedTime, rows: parsed.rows });
      gp[m] = parsed.rows;
    }));
    const found = months.filter(m => gp[m]);
    sources.gp = { ok: true, detail: found.length ? `${found.length} monthly report${found.length > 1 ? 's' : ''} read` : `No GP report found for ${months[0]} – ${month}`, reports };
    if (!gp[month]) sources.gp.warning = `No GP report for ${month}`;
  } catch (e) { sources.gp = { ok: false, detail: 'GP reports not readable: ' + short(e) + shareHint() }; }

  let renewals = [];
  try {
    const id = E.RENEWALS_SHEET_ID || DEFAULT_RENEWALS;
    const parsed = core.parseRenewals(await sheetValues(id, `'${E.RENEWALS_TAB || 'Renewal'}'!A1:AH3000`));
    if (parsed.error) throw new Error(parsed.error);
    renewals = parsed.rows;
    sources.renewals = { ok: true, detail: `${renewals.length} rows`, url: `https://docs.google.com/spreadsheets/d/${id}/edit` };
  } catch (e) { sources.renewals = { ok: false, detail: 'Renewals sheet not readable: ' + short(e) + shareHint() }; }

  let tracker = null;
  try {
    const id = E.TRACKER_SHEET_ID || DEFAULT_TRACKER;
    const [l, c] = await Promise.all([sheetValues(id, "'GP Commission Lines'!A1:J3000"), sheetValues(id, "'Invoice Checklist'!A1:L3000")]);
    const lines = core.parseTrackerLines(l), checklist = core.parseInvoiceChecklist(c);
    if (lines.error) throw new Error(lines.error);
    if (checklist.error) throw new Error(checklist.error);
    tracker = { lines: lines.rows, checklist: checklist.rows };
    sources.tracker = { ok: true, detail: `${lines.rows.length} commission lines, ${checklist.rows.length} commission invoices`, url: `https://docs.google.com/spreadsheets/d/${id}/edit` };
  } catch (e) { sources.tracker = { ok: false, detail: 'Commission tracker not readable: ' + short(e) + shareHint() }; }

  let clientInv = null, zoneInv = null;
  try {
    const refs = [...(gp[month] || []).filter(g => g.zone).map(g => g.invoice), ...(tracker?.lines || []).filter(l => l.month === month).map(l => l.ref)];
    const wanted = [...new Set(refs.filter(r => /^INV-\d/.test(r)))];
    let via = 'Zoho Analytics';
    try { clientInv = await clientInvoicesAnalytics(analytics, wanted); zoneInv = await zoneInvoicesAnalytics(analytics, months[0], month); }
    catch (e) { console.error('Commission dashboard: Analytics invoices failed, trying Zoho Books —', short(e)); via = 'Zoho Books'; clientInv = await clientInvoices(books, month, wanted); zoneInv = await zoneInvoices(books, months[0], month); }
    sources.zoho = { ok: true, detail: `${zoneInv.length} free zone commission invoice${zoneInv.length === 1 ? '' : 's'}; client invoices checked for ${month} (${via})` };
  } catch (e) {
    sources.zoho = { ok: false, detail: 'Zoho Books invoices not readable: ' + short(e) + (/401|403|57/.test(String(e.message)) ? ' — the Zoho refresh token needs the ZohoBooks.invoices.READ scope' : '') };
    clientInv = null; zoneInv = null;
  }

  let emails = null;
  if (!E.GMAIL_IMPERSONATE) sources.gmail = { ok: false, off: true, detail: 'Not connected — set GMAIL_IMPERSONATE (domain-wide delegation, gmail.readonly) to match emails' };
  else try {
    emails = await gmailMessages(core.addDays(month + '-01', -30), core.addDays(core.monthEnd(month), 1));
    sources.gmail = { ok: true, detail: `${emails.length} messages scanned (${E.GMAIL_IMPERSONATE})` };
  } catch (e) { sources.gmail = { ok: false, detail: 'Gmail not readable: ' + short(e) }; }

  const windowDays = Number(E.COMMISSION_RENEWAL_WINDOW_DAYS) || 60;
  const data = { ...core.buildDashboard({ month, months, gp, tracker, renewals, clientInvoices: clientInv, zoneInvoices: zoneInv, emails, today, windowDays }), sources, generatedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), data });
  return data;
}


// Sign-in is the host's job (requireAuth); pages and API also carry noindex so search engines skip them.
export function mountCommissions(app, { requireAuth = (_q, _s, next) => next(), books, analytics }) {
  app.use((_q, s, next) => { s.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
  const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commissions.html');
  app.get('/commissions', (_q, s) => s.set('Cache-Control', 'no-cache').sendFile(page));
  app.get('/robots.txt', (_q, s) => s.type('text/plain').end('User-agent: *\nDisallow: /\n'));
  app.get('/api/commissions', requireAuth, async (q, s) => {
    const now = dubaiToday().slice(0, 7);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.query.month || '') ? q.query.month : now;
    const span = Math.min(12, Math.max(1, Number(q.query.months) || 6));
    try { s.json({ ok: true, ...(await loadDashboard({ books, analytics, month, span, refresh: q.query.refresh === '1' })) }); }
    catch (e) { console.error('Commission dashboard failed:', e); s.status(500).json({ ok: false, error: short(e) }); }
  });
  // Once after start: log which sources the dashboard can read (and the service account to share sheets with).
  setTimeout(() => selfCheck(books, analytics).catch(e => console.error('Commission dashboard self-check failed:', short(e))), 8000).unref();
}

async function selfCheck(books, analytics) {
  let who = 'GOOGLE_SERVICE_ACCOUNT_B64 not set';
  try { who = creds().client_email; } catch {}
  console.log('Commission dashboard: Google via', bridge() ? 'Apps Script bridge (' + new URL(E.SHEETS_BRIDGE_URL).host + ')' : 'service account = ' + who);
  const check = async (name, fn) => { try { console.log(`Commission dashboard: ${name} OK — ${await fn()}`); } catch (e) { console.log(`Commission dashboard: ${name} NOT readable — ${short(e)}`); } };
  await check('GP reports', async () => Object.keys(await gpReports()).sort().join(', ') || 'none found');
  await check('Commission tracker', async () => (await sheetValues(E.TRACKER_SHEET_ID || DEFAULT_TRACKER, "'Invoice Checklist'!A1:A2")).length + ' rows sampled');
  await check('Renewals sheet', async () => (await sheetValues(E.RENEWALS_SHEET_ID || DEFAULT_RENEWALS, `'${E.RENEWALS_TAB || 'Renewal'}'!A1:A2`)).length + ' rows sampled');
  await check('Zoho invoices (Analytics)', async () => (await zoneInvoicesAnalytics(analytics, core.addMonths(dubaiToday().slice(0, 7), -3), dubaiToday().slice(0, 7))).length + ' free zone commission invoices in the last 3 months');
}
