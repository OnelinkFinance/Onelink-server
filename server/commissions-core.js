// Free zone commission dashboard — pure logic, no I/O (tested in test/commissions-core.test.js).
//
// Sources, as they actually look:
//   GP report      monthly Google Sheet "Onelink Solutions GP Report- <Month> <Year>", tab "Summary".
//                  Two header rows ("S.No …" then "0 VISA, With Visa, … Meydan, IFZA, RAKEZ, RAK DAO …").
//                  " Free zone Commission" = commission Onelink earns from the free zone on that deal;
//                  the free zone columns hold the fee paid to that free zone.
//   Renewals       Google Sheet "Renewals", tab "Renewal": Company, Authority, Expiry Date, Date of Renewal,
//                  Status (Active / Renewed / Not Active), Progress (Invoice sent, company cancelled …).
//   Zoho Books     client invoices (INV-xxxxxx on the GP row) and the monthly commission invoices
//                  Onelink raises to each free zone (the free zones are Books customers).
//   Gmail          free zone / client threads (optional).
//   Commission tracker  "Freezone_Commission_Collection_Tracker" — the existing finance workbook and the baseline:
//                  "GP Commission Lines" (one line per deal from May 2026: commission to invoice, Invoiced /
//                  Uninvoiced / Missed / No commission, the commission invoice in Notes) and "Invoice Checklist"
//                  (every commission invoice: RECEIVED / TO COLLECT / CANCELLED).
//
// READ-ONLY: every source is only read. Nothing here or in commissions.js writes to a sheet, Zoho or Gmail;
// all matching, statuses and totals exist only in the dashboard's own output (test/read-only.test.js checks this).

export const ZONES = [
  { code: 'RAKDAO', name: 'RAK DAO', tracked: true, re: /\brak[\s-]*dao\b|\brakdao\b|digital assets oasis|innovation ?city/i, domains: ['rakdao.com', 'innovationcity.com'], booksCustomerId: '7050654000001618001' },
  { code: 'RAKICC', name: 'RAK ICC', tracked: true, re: /\brak[\s-]*icc\b|\brakicc\b|international corporate cent(?:re|er)/i, domains: ['rakicc.com'], booksCustomerId: '7050654000002862001' },
  { code: 'MEYDAN', name: 'Meydan', tracked: true, re: /\bmeydan\b/i, domains: ['meydanfz.ae', 'meydan.ae'], booksCustomerId: '7050654000005341842' },
  { code: 'RAKEZ', name: 'RAKEZ', tracked: true, re: /\brakez\b|ras al khaimah economic zone/i, domains: ['rakez.com'], booksCustomerId: '7050654000000633170' },
  // Not tracked on their own, but recognised so their commission lands in "Other free zones" and totals reconcile.
  { code: 'IFZA', name: 'IFZA', re: /\bifza\b/i, domains: ['ifza.com'] },
  { code: 'DSOUTH', name: 'Dubai South', re: /\bdubai south\b|\bdwc\b/i, domains: ['dubaisouth.ae'] },
  { code: 'DMCC', name: 'DMCC', re: /\bdmcc\b/i, domains: ['dmcc.ae'] },
  { code: 'AJMAN', name: 'Ajman', re: /\bajman\b/i, domains: [] }
];
export const TRACKED = ZONES.filter(z => z.tracked);
export const zoneByCode = code => ZONES.find(z => z.code === code) || null;
export const OTHER = 'OTHER';

export const norm = s => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
export const num = v => typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
const bool = v => v === true || /^true$/i.test(String(v ?? '').trim());
const round2 = n => Math.round(n * 100) / 100;

export function detectZone(text) {
  const t = String(text ?? '');
  for (const z of ZONES) if (z.re.test(t)) return z.code;
  return null;
}
export function zoneFromEmail(from) {
  const d = (/@([a-z0-9.-]+)/i.exec(String(from || '')) || [])[1]?.toLowerCase() || '';
  return d ? (ZONES.find(z => z.domains.some(x => d === x || d.endsWith('.' + x)))?.code || null) : null;
}

export function detectType(text, flags = {}) {
  const t = String(text ?? '');
  if (flags.renewal || /renew/i.test(t)) return 'Renewal';
  if (flags.zeroVisa || flags.withVisa || /set[\s-]?up|start[\s-]?up|incorporat|formation|new (?:company|licen[cs]e)|\b\d+\s*BL\b|(?:^|[\s|-])\d\s*visas?\b/i.test(t)) return 'New';
  return 'Other';
}

// ---- dates (ISO yyyy-mm-dd, Dubai calendar days) ----
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900;
export const monthOf = isoDate => String(isoDate || '').slice(0, 7);
export const addDays = (isoDate, n) => new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number), t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export const monthEnd = month => addDays(addMonths(month, 1) + '-01', -1);

// Sheet cells read with UNFORMATTED_VALUE: a real date is a serial number; anything typed as text stays text.
// Both sheets are en_US. Text with a part > 12 settles the order itself; a dotted date ("28.01.2026") is
// day-first. Otherwise text is month-first, as the GP report writes it ("09/28/2026") — except with
// textDayFirst (Renewals): there a month-first date typed in would have become a real date, so leftover
// text like "11/03/2027" was pasted day-first. It is read that way and flagged as ambiguous.
export function parseSheetDate(v, { textDayFirst = false } = {}) {
  if (v === '' || v == null) return { date: null };
  if (typeof v === 'number' && v > 20000 && v < 80000) return { date: new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10) };
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]) ? { date: iso(+m[1], +m[2], +m[3]) } : { date: null, bad: true };
  m = /^(\d{1,2})[\s-]+([a-z]{3,9})[\s,-]+(\d{4})$/i.exec(s);  // "04 May 2026" (the tracker)
  if (m) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; return mo && valid(+m[3], mo, +m[1]) ? { date: iso(+m[3], mo, +m[1]) } : { date: null, bad: true }; }
  m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2,4})$/.exec(s);
  if (!m) return { date: null, bad: !!s && s !== '-' };
  let [a, b, y] = [+m[1], +m[3], +m[4]];
  if (y < 100) y += 2000;
  let day, mon, ambiguous = false;
  if (m[2] === '.') [day, mon] = [a, b];
  else if (a > 12) [day, mon] = [a, b];
  else if (b > 12) [mon, day] = [a, b];
  else if (textDayFirst) { [day, mon] = [a, b]; ambiguous = a !== b; }
  else [mon, day] = [a, b];
  return valid(y, mon, day) ? { date: iso(y, mon, day), ambiguous } : { date: null, bad: true };
}

// "Onelink Solutions GP Report- September 2026" → '2026-09'. Copies are ignored.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function gpReportMonth(title) {
  const t = String(title || '').trim();
  if (/^copy of/i.test(t)) return null;
  const m = /gp report\W*([a-z]+)\W*(\d{4})/i.exec(t);
  if (!m) return null;
  const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  return i < 0 ? null : `${m[2]}-${pad(i + 1)}`;
}

// ---- company identity ----
const STOP = new Set(['llc', 'fz', 'fzco', 'fze', 'fzc', 'ltd', 'limited', 'co', 'company', 'soc', 'sole', 'proprietorship', 'inc', 'corp', 'plc', 'the', 'and', 'est', 'establishment', 'dwc', 'llcfz']);
const stem = w => w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w; // Solutions ≈ Solution
export const companyKey = s => norm(s).split(' ').filter(w => w.length > 1 && !STOP.has(w)).map(stem).join(' ');
const distinctive = k => k.includes(' ') || k.length >= 6;
export function sameCompany(a, b) {
  const ka = companyKey(a), kb = companyKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [s, l] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (!distinctive(s)) return false;
  const lt = new Set(l.split(' '));
  return s.split(' ').every(w => lt.has(w));
}
export const mentions = (text, name) => { const k = companyKey(name); return !!k && distinctive(k) && (' ' + companyKey(text) + ' ').includes(' ' + k + ' '); };

// ---- provenance: the cells a record was read from ----
export const colLetter = i => { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
// Non-empty cells of a row as [{ col: 'C', label: 'Invoice', value }] — what the sheet held, untouched.
export const cellsOf = (labels, r) => (r || []).map((v, i) => ({ col: colLetter(i), label: String(labels[i] ?? '').trim(), value: v })).filter(c => c.value !== '' && c.value != null);

// ---- GP report ----
export function parseGpReport(values, month) {
  const rows = values || [];
  const hi = rows.findIndex(r => norm(r?.[0]) === 's no');
  if (hi < 0) return { rows: [], error: 'No "S.No" header row on the GP report tab' };
  const h1 = rows[hi] || [], h2 = rows[hi + 1] || [];
  const labels = Array.from({ length: Math.max(h1.length, h2.length) }, (_, i) => String(typeof h2[i] === 'string' && h2[i].trim() ? h2[i] : (h1[i] ?? '')).trim());
  const names = labels.map(norm);
  const at = (...want) => { for (const w of want) { const i = names.indexOf(w); if (i >= 0) return i; } return -1; };
  const C = {
    sNo: 0, date: at('date'), invoice: at('invoice'), client: at('client name'), company: at('company name'), source: at('source'), agent: at('agent name'),
    zeroVisa: at('0 visa'), withVisa: at('with visa'), renewal: at('renewals'), services: at('package services'), revenue: at('revenue'), expenses: at('expenses'),
    commission: at('free zone commission'), finalGp: at('final gp'), received: at('payment received'), pending: at('pending payment')
  };
  const zoneCols = names.map((n, i) => ({ i, code: detectZone(n) })).filter(x => x.code && x.i > C.commission);
  const missing = ['client', 'services', 'commission'].filter(k => C[k] < 0);
  if (missing.length) return { rows: [], error: 'GP report columns not found: ' + missing.join(', ') };
  const cell = (r, k) => C[k] >= 0 ? r[C[k]] : '';
  const out = [];
  for (let n = hi + 2; n < rows.length; n++) {
    const r = rows[n] || [];
    const client = String(cell(r, 'client') ?? '').trim(), company = String(cell(r, 'company') ?? '').trim(), services = String(cell(r, 'services') ?? '').trim();
    if (!client && !company) continue; // totals, blank rows and the package legend under the table
    const fees = Object.fromEntries(zoneCols.map(z => [z.code, num(r[z.i])]).filter(([, v]) => v));
    let zone = detectZone(services), zoneSource = zone ? 'service' : null;
    if (!zone) { const paid = Object.keys(fees); if (paid.length) { zone = paid[0]; zoneSource = 'fee column'; } }
    const commission = round2(num(cell(r, 'commission'))), fee = zone ? fees[zone] || 0 : 0;
    const d = parseSheetDate(cell(r, 'date'));
    out.push({
      key: `${month}#${n + 1}`, month, sheetRow: n + 1, sNo: String(cell(r, 'sNo') ?? ''), date: d.date, invoice: String(cell(r, 'invoice') ?? '').trim().toUpperCase(),
      client, company, name: company || client, source: String(cell(r, 'source') ?? '').trim(), agent: String(cell(r, 'agent') ?? '').trim(), services,
      type: detectType(services, { renewal: bool(cell(r, 'renewal')), zeroVisa: bool(cell(r, 'zeroVisa')), withVisa: bool(cell(r, 'withVisa')) }),
      zone, zoneSource, fee, commission, commissionPct: fee ? round2(commission / fee * 100) : null,
      revenue: round2(num(cell(r, 'revenue'))), finalGp: round2(num(cell(r, 'finalGp'))), received: round2(num(cell(r, 'received'))), pending: round2(num(cell(r, 'pending'))),
      feeColumn: zone && zoneCols.find(z => z.code === zone) ? colLetter(zoneCols.find(z => z.code === zone).i) : null, commissionColumn: colLetter(C.commission),
      cells: cellsOf(labels, r)
    });
  }
  return { rows: out };
}

// ---- Renewals sheet ----
export function parseRenewals(values) {
  const rows = values || [];
  const head = (rows[0] || []).map(norm);
  const at = (...want) => { for (const w of want) { const i = head.findIndex(h => h === w || h.startsWith(w)); if (i >= 0) return i; } return -1; };
  const C = { company: at('company'), authority: at('authority', 'free zone'), expiry: at('expiry date', 'expiry'), renewedOn: at('date of renewal'), status: at('status'), progress: at('progress'), remarks: at('remarks'), manager: at('account manager') };
  if (C.company < 0 || C.authority < 0 || C.expiry < 0) return { rows: [], error: 'Renewals sheet needs Company, Authority and Expiry Date columns' };
  const cell = (r, k) => C[k] >= 0 ? String(r[C[k]] ?? '').trim() : '';
  const out = [];
  rows.slice(1).forEach((r, i) => {
    const company = cell(r, 'company');
    if (!company) return;
    const exp = parseSheetDate(r[C.expiry], { textDayFirst: true });
    out.push({
      sheetRow: i + 2, company, authority: cell(r, 'authority'), zone: detectZone(cell(r, 'authority')),
      expiry: exp.date, expiryRaw: cell(r, 'expiry'), dateAmbiguous: !!exp.ambiguous, dateBad: !!exp.bad,
      renewedOn: parseSheetDate(C.renewedOn >= 0 ? r[C.renewedOn] : '', { textDayFirst: true }).date, status: cell(r, 'status'), progress: cell(r, 'progress'), remarks: cell(r, 'remarks'), manager: cell(r, 'manager'),
      cells: cellsOf(rows[0] || [], r)
    });
  });
  return { rows: out };
}

// ---- emails ----
export function classifyEmail(m, names) {
  const text = `${m.subject || ''} ${m.snippet || ''}`;
  return {
    ...m,
    zone: zoneFromEmail(m.from) || detectZone(text),
    type: /renew/i.test(text) ? 'Renewal' : /set[\s-]?up|incorporat|new company|business licen[cs]e|formation/i.test(text) ? 'New' : 'Other',
    commission: /commission/i.test(text),
    companies: [...new Set(names.filter(n => mentions(text, n)))]
  };
}

// ---- Commission tracker (existing workbook, read-only) ----
const headerRow = (rows, ...must) => rows.findIndex(r => { const h = (r || []).map(norm); return must.every(m => h.includes(m)); });
const money = v => { if (typeof v === 'number') return v; const t = String(v ?? '').trim(); if (!t) return null; const n = num(t); return /^\(.*\)$/.test(t) ? -Math.abs(n) : n; };
export const normRef = s => String(s ?? '').toUpperCase().replace(/\s+/g, '').replace(/^NV-/, 'INV-');

// "GP Commission Lines": Date | Free zone | INV ref | Client name | Company name | Package / service |
// Free zone commission to invoice (AED) | Status | Notes | Flag
export function parseTrackerLines(values) {
  const rows = values || [], hi = headerRow(rows, 'date', 'free zone', 'inv ref');
  if (hi < 0) return { rows: [], error: 'Header "Date · Free zone · INV ref" not found on GP Commission Lines' };
  const h = rows[hi].map(norm), at = w => h.findIndex(x => x === w || x.startsWith(w));
  const C = { date: at('date'), zone: at('free zone'), ref: at('inv ref'), client: at('client name'), company: at('company name'), service: at('package'), commission: at('free zone commission'), status: at('status'), notes: at('notes'), flag: at('flag') };
  const cell = (r, k) => C[k] >= 0 ? r[C[k]] ?? '' : '';
  const out = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const client = String(cell(r, 'client')).trim(), company = String(cell(r, 'company')).trim(), service = String(cell(r, 'service')).trim();
    if (!client && !company && !service) return;
    const notes = String(cell(r, 'notes')).trim(), d = parseSheetDate(cell(r, 'date'));
    out.push({
      sheetRow: hi + i + 2, date: d.date, month: monthOf(d.date), zone: detectZone(cell(r, 'zone')), zoneText: String(cell(r, 'zone')).trim(),
      ref: normRef(cell(r, 'ref')), client, company, name: company || client, service, type: detectType(service),
      commission: money(cell(r, 'commission')), status: String(cell(r, 'status')).trim(), notes, flag: String(cell(r, 'flag')).trim().replace(/^#REF!$/, ''),
      commissionInvoice: ((/\bINV[\s-]*[A-Z0-9][A-Z0-9-]*\d\b/i.exec(notes) || [])[0] || '').toUpperCase().replace(/\s+/g, '') || null,
      cells: cellsOf(rows[hi], r)
    });
  });
  return { rows: out };
}
// "Invoice Checklist": Date | Free Zone | Invoice / Doc No | Amount (AED) | Status | Received on | Days taken |
// Still to collect (AED) | Days outstanding | … | Notes
export function parseInvoiceChecklist(values) {
  const rows = values || [], hi = headerRow(rows, 'date', 'free zone', 'status');
  if (hi < 0) return { rows: [], error: 'Header "Date · Free Zone · Status" not found on Invoice Checklist' };
  const h = rows[hi].map(norm), at = w => h.findIndex(x => x === w || x.startsWith(w));
  const C = { date: at('date'), zone: at('free zone'), number: at('invoice'), amount: at('amount'), status: at('status'), receivedOn: at('received on'), daysTaken: at('days taken'), toCollect: at('still to collect'), daysOut: at('days outstanding'), notes: at('notes') };
  const cell = (r, k) => C[k] >= 0 ? r[C[k]] ?? '' : '';
  const out = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const number = normRef(cell(r, 'number'));
    if (!number) return;
    out.push({
      sheetRow: hi + i + 2, date: parseSheetDate(cell(r, 'date')).date, zone: detectZone(cell(r, 'zone')), number, amount: money(cell(r, 'amount')) || 0,
      status: String(cell(r, 'status')).trim().toUpperCase(), receivedOn: parseSheetDate(cell(r, 'receivedOn')).date, daysTaken: money(cell(r, 'daysTaken')),
      toCollect: money(cell(r, 'toCollect')) || 0, daysOutstanding: money(cell(r, 'daysOut')), notes: String(cell(r, 'notes')).trim(),
      cells: cellsOf(rows[hi], r)
    });
  });
  return { rows: out };
}

// ---- commission invoices → the month they bill ----
// A free zone commission invoice is raised after the month it covers ("Commission invoice - August 2026",
// sent in September). The month is read from the invoice text; failing that it is the month before the invoice date.
export function invoicePeriod(inv, lagMonths = 1) {
  const text = [inv.reference_number, inv.subject_content, inv.notes, ...(inv.line_items || []).flatMap(l => [l.name, l.description])].filter(Boolean).join(' ');
  const invMonth = monthOf(inv.date);
  const coded = /INV-[A-Z]+-(\d{2})(\d{4})\b/i.exec(inv.invoice_number || inv.number || '');   // INV-RAKDAO-072026
  if (coded && +coded[1] >= 1 && +coded[1] <= 12) return { month: `${coded[2]}-${coded[1]}`, basis: 'invoice number' };
  const re = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[\s,'-]*(\d{4}|\d{2})?/i;
  const m = re.exec(text);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    let y = m[2] ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) : +invMonth.slice(0, 4);
    if (!m[2] && `${y}-${pad(mo)}` > invMonth) y--;
    return { month: `${y}-${pad(mo)}`, basis: 'invoice text' };
  }
  return { month: addMonths(invMonth, -lagMonths), basis: `assumed: month before invoice date` };
}

// ---- the dashboard ----
const isTracked = code => !!zoneByCode(code)?.tracked;
const bucket = code => isTracked(code) ? code : OTHER;
const TOL = 1; // AED

export function classifyRenewal(r, { today, windowDays, gpMatch, emailMatch }) {
  const st = norm(r.status), pr = norm(`${r.progress} ${r.remarks}`);
  if (/cancel|liquidat|struck off|company expired|closed/.test(pr)) return 'Closed';
  if (gpMatch) return 'Completed';
  if (st.includes('renewed')) return 'Completed';
  if (!r.expiry) return 'Check date';
  const days = daysBetween(today, r.expiry);
  const working = /invoice (?:sent|paid|raised)|in progress|submitted|awaiting|pending/.test(pr) || !!emailMatch;
  if (days > windowDays) return 'Not due';
  if (working) return 'In progress';
  if (st.includes('not active') && days < -90) return 'Lapsed';
  return days < 0 ? 'Overdue' : 'Not started';
}

// One transaction per deal and month: a commission tracker line (the baseline) joined to its GP report row,
// plus GP report free zone rows the tracker does not have. Join: same client invoice no. (INV ref), else same
// company, same free zone, dates within 7 days.
export function mergeMonth(m, trackerLines, gpRows) {
  const gps = gpRows || [], used = new Set();
  const close = (a, b) => !a || !b || Math.abs(daysBetween(a, b)) <= 7;
  const same = (g, l) => [g.name, g.client].some(x => x && [l.name, l.client].some(y => y && sameCompany(x, y)));
  const out = [];
  for (const l of trackerLines.filter(l => l.month === m && l.zone)) {
    const byRef = (/^INV-\d/.test(l.ref) && gps.find(g => g.invoice === l.ref)) || null;
    const g = byRef || gps.find(g => !used.has(g) && g.zone === l.zone && same(g, l) && close(g.date, l.date)) || null;
    if (g) used.add(g);
    const joinedBy = !g ? null : byRef ? `Same client invoice no. ${l.ref} on both` : `Same company/client (${g.name || g.client} ≈ ${l.name || l.client}), same free zone, dates ${g.date} and ${l.date} within 7 days`;
    out.push({
      month: m, name: l.name || g?.name || '', client: l.client || g?.client || '', zone: l.zone, type: g && g.type !== 'Other' ? g.type : l.type, date: l.date || g?.date,
      services: l.service || g?.services || '', agent: g?.agent || '', onTracker: true, onGp: !!g,
      trackerRow: l.sheetRow, trackerStatus: l.status, trackerNotes: l.notes, trackerFlag: l.flag, commissionInvoice: l.commissionInvoice,
      gpRow: g?.sheetRow || null, invoice: (g?.invoice || l.ref || '').toUpperCase(), fee: g?.fee || 0,
      gpCommission: g ? g.commission : null, trackerCommission: l.commission, commission: round2(l.commission ?? g?.commission ?? 0),
      commissionFrom: l.commission != null ? 'tracker' : g ? 'GP report' : null, line: l, gp: g, joinedBy
    });
  }
  for (const g of gps) {
    if (used.has(g) || !g.zone || (g.type === 'Other' && !g.commission)) continue;
    out.push({
      month: m, name: g.name, client: g.client, zone: g.zone, type: g.type, date: g.date, services: g.services, agent: g.agent, onTracker: false, onGp: true,
      trackerRow: null, trackerStatus: '', trackerNotes: '', trackerFlag: '', commissionInvoice: null,
      gpRow: g.sheetRow, invoice: g.invoice, fee: g.fee, gpCommission: g.commission, trackerCommission: null, commission: g.commission,
      commissionFrom: 'GP report', line: null, gp: g, joinedBy: null
    });
  }
  return out;
}

const STATUS_ORDER = ['Commission missed', 'Pending invoice', 'Pending GP', 'Pending commission invoice', 'Not on tracker', 'Awaiting payment', 'No commission', 'Completed'];

// in: { month, months[], gp: {month: rows[]}, tracker: { lines, checklist } | null, renewals: rows[],
//       clientInvoices: Map|null, zoneInvoices: [] | null, emails: [] | null, today, windowDays }
export function buildDashboard(input) {
  const { month, months, today, windowDays = 60 } = input;
  const lines = input.tracker?.lines || [];
  const checklist = new Map((input.tracker?.checklist || []).map(c => [c.number, c]));
  const trackerFrom = lines.reduce((a, l) => l.month && (!a || l.month < a) ? l.month : a, null);
  const trackerCovers = m => !!input.tracker && !!trackerFrom && m >= trackerFrom;
  const zoneInv = input.zoneInvoices;
  const zohoByNumber = new Map((zoneInv || []).map(i => [i.number, i]));
  const renewals = (input.renewals || []).filter(r => isTracked(r.zone));

  const tx = Object.fromEntries(months.map(m => [m, mergeMonth(m, lines, input.gp[m])]));
  const txAll = months.flatMap(m => tx[m]);
  const names = [...new Set([...txAll.map(t => t.name), ...txAll.map(t => t.client), ...renewals.map(r => r.company)].filter(Boolean))];
  const emails = input.emails ? input.emails.map(e => classifyEmail(e, names)) : null;
  const emailsFor = (name, zone) => !emails || !name ? [] : emails.filter(e => e.companies.some(c => sameCompany(c, name)) && (!zone || !e.zone || e.zone === zone));

  // Zoho fallback (no tracker): did the free zone get a commission invoice for this month?
  const zohoMonth = (m, code) => {
    if (!zoneInv) return null;
    const list = zoneInv.filter(i => i.period === m && i.zone === code);
    const due = tx[m].filter(t => t.zone === code).reduce((a, t) => a + t.commission, 0);
    const inv = list.reduce((a, i) => a + i.subTotal, 0), bal = list.reduce((a, i) => a + i.balance, 0);
    if (!due) return null;
    if (!inv) return 'Not invoiced';
    if (inv + TOL < due) return 'Partly invoiced';
    return bal > TOL ? 'Invoiced · unpaid' : 'Invoiced · paid';
  };

  // Status of one transaction — the first rule that applies, in STATUS_ORDER. Every check is recorded
  // (rule, passed true/false or null = not applicable, what was seen) so the page can show its working.
  function judge(t) {
    const flags = new Set(), missing = [], checks = [], st = norm(t.trackerStatus);
    const ck = (rule, ok, detail) => checks.push({ rule, ok, detail });
    const zName = zoneByCode(t.zone)?.name || t.zone;
    const inv = input.clientInvoices && t.invoice ? input.clientInvoices.get(t.invoice) : undefined;
    const notes = t.trackerNotes ? ` — note: "${t.trackerNotes}"` : '';

    if (st === 'missed') { flags.add('Commission missed'); missing.push(`Tracker: commission missed${notes}`); ck('Commission not marked "Missed" on the tracker', false, `Tracker row ${t.trackerRow} status is "Missed"${notes}`); }
    else ck('Commission not marked "Missed" on the tracker', t.onTracker ? true : null, t.onTracker ? `Tracker row ${t.trackerRow} status is "${t.trackerStatus || 'blank'}"` : 'Not on the tracker');

    const invRule = 'Client invoice is a Zoho invoice and exists in Zoho';
    if (!/^INV-\d/.test(t.invoice)) { flags.add('Pending invoice'); missing.push(t.invoice ? `Client invoice "${t.invoice}" is not a Zoho invoice no.` : 'No client invoice no.'); ck(invRule, false, t.invoice ? `"${t.invoice}" is not an INV-number` : 'No invoice number on the GP report or the tracker'); }
    else if (inv === null) { flags.add('Pending invoice'); missing.push(`${t.invoice} not found in Zoho Books`); ck(invRule, false, `${t.invoice} is not in Zoho (Analytics "Invoices" table)`); }
    else if (inv && /void|draft/i.test(inv.status)) { flags.add('Pending invoice'); missing.push(`${t.invoice} is ${inv.status} in Zoho Books`); ck(invRule, false, `${t.invoice} is ${inv.status} in Zoho`); }
    else ck(invRule, inv ? true : null, inv ? `${t.invoice} · ${inv.status} · total AED ${inv.total} · balance AED ${inv.balance}` : `${t.invoice} (Zoho not checked)`);

    if (!t.onGp && input.gp[t.month]) { flags.add('Pending GP'); missing.push(`Not on the ${t.month} GP report`); ck(`On the ${t.month} GP report`, false, 'No matching row (by invoice no., or company + free zone + date)'); }
    else ck(`On the ${t.month} GP report`, t.onGp ? true : null, t.onGp ? `Row ${t.gpRow}${t.joinedBy ? ' · matched: ' + t.joinedBy : ''}` : `No GP report loaded for ${t.month}`);

    if (!t.onTracker && trackerCovers(t.month) && (t.commission || t.type !== 'Other')) { flags.add('Not on tracker'); missing.push('Not on the commission tracker (GP Commission Lines)'); ck('On the commission tracker', false, 'No line in GP Commission Lines for this deal'); }
    else ck('On the commission tracker', t.onTracker ? true : null, t.onTracker ? `GP Commission Lines row ${t.trackerRow}` : `The tracker starts ${trackerFrom || '—'}; ${t.month} is not covered`);

    if (t.onTracker && t.onGp && t.trackerCommission != null) {
      const same = Math.abs((t.trackerCommission || 0) - (t.gpCommission || 0)) <= TOL;
      if (!same) missing.push(`Commission differs: tracker ${t.trackerCommission} vs GP report ${t.gpCommission}`);
      ck('Tracker commission equals the GP report (± AED 1)', same, `Tracker AED ${t.trackerCommission} · GP report AED ${t.gpCommission}`);
    }

    let ciStatus = null, ciRecord = null;
    const ciRule = `Commission invoiced to ${zName}`, paidRule = 'Commission invoice paid';
    if (t.commission > 0) {
      if (st === 'invoiced') {
        const ci = t.commissionInvoice ? checklist.get(t.commissionInvoice) : null;
        const z = t.commissionInvoice ? zohoByNumber.get(t.commissionInvoice) : null;
        ciRecord = { checklist: ci || null, zoho: z || null };
        ciStatus = ci ? ci.status : z ? (z.balance > TOL ? 'TO COLLECT' : 'RECEIVED') : t.commissionInvoice ? 'not in Invoice Checklist' : 'invoice no. not recorded';
        ck(ciRule, ciStatus !== 'CANCELLED', `Tracker says Invoiced${t.commissionInvoice ? ' · ' + t.commissionInvoice : ' · no invoice no. in Notes'}${ci ? ` · Invoice Checklist row ${ci.sheetRow}: ${ci.status}` : ''}${z ? ` · Zoho: ${z.status}, balance AED ${z.balance}` : ''}`);
        if (ciStatus === 'TO COLLECT') flags.add('Awaiting payment');
        if (ciStatus === 'CANCELLED') { flags.add('Pending commission invoice'); missing.push(`${t.commissionInvoice} was cancelled by credit note`); }
        ck(paidRule, ciStatus === 'RECEIVED' ? true : ciStatus === 'TO COLLECT' ? false : null, ci ? `Invoice Checklist: ${ci.status}${ci.receivedOn ? ' on ' + ci.receivedOn : ''}${ci.toCollect ? ` · AED ${ci.toCollect} to collect` : ''}` : z ? `Zoho balance AED ${z.balance}` : 'Unknown — not on the Invoice Checklist');
      } else if (t.onTracker && st !== 'missed') {
        flags.add('Pending commission invoice'); missing.push(`Commission AED ${t.commission.toLocaleString('en-US')} not yet invoiced to ${zName}${notes}`); ciStatus = t.trackerStatus || 'blank on tracker';
        ck(ciRule, false, `Tracker status "${t.trackerStatus || 'blank'}" for AED ${t.commission}${notes}`);
      } else if (!t.onTracker) {
        const zs = zohoMonth(t.month, t.zone); ciStatus = zs;
        if (zs === 'Not invoiced' || zs === 'Partly invoiced') { flags.add('Pending commission invoice'); missing.push(`${zName} commission for ${t.month} ${zs.toLowerCase()} in Zoho Books`); }
        if (zs === 'Invoiced · unpaid') flags.add('Awaiting payment');
        ck(ciRule, zs == null ? null : !/not|partly/i.test(zs), zs ? `No tracker line; Zoho invoices to ${zName} for ${t.month}: ${zs}` : 'No tracker line and no Zoho data');
      }
    } else if (st === 'no commission') { flags.add('No commission'); ck('Commission due', null, `Tracker says "No commission"${notes}`); }
    else if (t.type !== 'Other' && st !== 'missed') { flags.add('No commission'); if (!t.onTracker) missing.push('No free zone commission recorded'); ck('Commission due', false, `A ${t.type} deal with no free zone commission on the ${t.onTracker ? 'tracker' : 'GP report'}`); }
    const status = STATUS_ORDER.find(s => flags.has(s)) || 'Completed';
    return { status, flags: [...flags], missing, checks, decidedBy: status === 'Completed' ? 'All checks passed' : `"${status}" is the first rule in the status order that applies`,
      invoiceStatus: inv ? inv.status : inv === null ? 'not found' : null, clientInvoiceRecord: inv || null, commissionInvoiceStatus: ciStatus, commissionInvoiceRecord: ciRecord };
  }
  for (const t of txAll) Object.assign(t, judge(t));

  // View 1 — monthly commissions by free zone (tracker figures where the tracker covers the month)
  const cell = () => ({ count: 0, newCount: 0, newCommission: 0, renewalCount: 0, renewalCommission: 0, otherCount: 0, otherCommission: 0, fees: 0, commission: 0,
    gpCommission: 0, trackerCommission: 0, invoicedLines: 0, uninvoiced: 0, missed: 0, invoiced: 0, invoiceTotal: 0, outstanding: 0, invoices: [] });
  const summary = months.map(m => {
    const zones = Object.fromEntries([...TRACKED.map(z => z.code), OTHER].map(c => [c, cell()]));
    for (const t of tx[m]) {
      const c = zones[bucket(t.zone)], k = t.type === 'New' ? 'new' : t.type === 'Renewal' ? 'renewal' : 'other';
      c.count++; c[k + 'Count']++; c[k + 'Commission'] += t.commission; c.commission += t.commission; c.fees += t.fee;
      c.gpCommission += t.gpCommission || 0; c.trackerCommission += t.trackerCommission || 0;
      if (norm(t.trackerStatus) === 'invoiced') c.invoicedLines += t.commission;
      if (t.flags.includes('Pending commission invoice')) c.uninvoiced += t.commission;
      if (t.flags.includes('Commission missed')) c.missed += t.commission;
    }
    for (const inv of zoneInv || []) if (inv.period === m) {
      const c = zones[inv.zone]; c.invoiced += inv.subTotal; c.invoiceTotal += inv.total; c.outstanding += inv.balance; c.invoices.push(inv.number);
    }
    for (const c of Object.values(zones)) for (const k of Object.keys(c)) if (typeof c[k] === 'number') c[k] = round2(c[k]);
    const total = cell();
    for (const c of Object.values(zones)) for (const k of Object.keys(total)) if (typeof total[k] === 'number') total[k] = round2(total[k] + c[k]);
    const open = tx[m].filter(t => t.commission && ['Commission missed', 'Pending invoice', 'Pending GP', 'Pending commission invoice', 'Not on tracker'].includes(t.status)).length;
    const reconciled = !input.gp[m] || !trackerCovers(m) || Math.abs(total.gpCommission - total.trackerCommission) <= TOL;
    const state = !tx[m].length && !input.gp[m] ? 'No data' : trackerCovers(m) && !open && reconciled ? 'Finalized' : 'Under review';
    return { month: m, hasReport: !!input.gp[m], onTracker: trackerCovers(m), baseline: trackerCovers(m) ? 'Commission tracker' : input.gp[m] ? 'GP report' : null, state, open, reconciled, zones, total };
  });
  const sel = summary.find(s => s.month === month);

  // View 2 — transaction log for the month (tracked free zones) + renewals due and not processed
  const usedRenewals = new Set();
  const renewalFor = t => t.type === 'Renewal' ? renewals.find(r => r.zone === t.zone && [t.name, t.client].some(n => n && sameCompany(r.company, n))) : null;
  const toWork = t => {
    const ren = renewalFor(t); if (ren && t.month === month) usedRenewals.add(ren.sheetRow);
    const mail = emails ? [...new Set([...emailsFor(t.name, t.zone), ...(t.client !== t.name ? emailsFor(t.client, t.zone) : [])])] : null;
    return {
      source: t.onTracker && t.onGp ? 'Tracker + GP report' : t.onTracker ? 'Tracker only' : 'GP report only', month: t.month,
      name: t.name, client: t.client, zone: t.zone, type: t.type, date: t.date, services: t.services, agent: t.agent,
      trackerRow: t.trackerRow, trackerStatus: t.trackerStatus || null, gpRow: t.gpRow, gp: t.onGp, onTracker: t.onTracker,
      invoice: t.invoice || null, invoiceStatus: t.invoiceStatus, fee: t.fee, commission: t.commission, commissionPct: t.fee ? round2(t.commission / t.fee * 100) : null,
      commissionFrom: t.commissionFrom, commissionInvoice: t.commissionInvoice, commissionInvoiceStatus: t.commissionInvoiceStatus,
      email: mail ? mail.length > 0 : null, emails: (mail || []).slice(0, 3).map(e => ({ subject: e.subject, date: e.date, url: e.url, from: e.from })),
      renewalStatus: ren ? [ren.status, ren.progress].filter(Boolean).join(' · ') || '—' : null, renewal: ren || null, status: t.status, missing: t.missing,
      line: t.line, gpRecord: t.gp, joinedBy: t.joinedBy, checks: t.checks, decidedBy: t.decidedBy, clientInvoiceRecord: t.clientInvoiceRecord, commissionInvoiceRecord: t.commissionInvoiceRecord
    };
  };
  const workAll = txAll.filter(t => isTracked(t.zone)).map(toWork);
  const work = workAll.filter(w => w.month === month);
  const renewalMatch = r => txAll.find(t => t.zone === r.zone && t.type === 'Renewal' && [t.name, t.client].some(n => n && sameCompany(n, r.company))
    && (!r.expiry || !t.date || Math.abs(daysBetween(r.expiry, t.date)) <= 150));
  const renewalView = renewals.map(r => {
    const m = renewalMatch(r), mail = emails ? emailsFor(r.company, r.zone) : null;
    const state = classifyRenewal(r, { today, windowDays, gpMatch: m, emailMatch: mail && mail.length }), daysLeft = r.expiry ? daysBetween(today, r.expiry) : null;
    const reason = state === 'Closed' ? `Progress/remarks say the company is closed: "${[r.progress, r.remarks].filter(Boolean).join(' · ')}"`
      : state === 'Completed' ? (m ? `Renewal found on the ${m.onTracker ? 'tracker' : 'GP report'} (${m.month}${m.trackerRow ? ', tracker row ' + m.trackerRow : ''}${m.gpRow ? ', GP row ' + m.gpRow : ''}) within 150 days of expiry` : 'Sheet status is "Renewed"')
      : state === 'Check date' ? `Expiry "${r.expiryRaw}" could not be read as a date`
      : state === 'Not due' ? `Expires in ${daysLeft} days — more than the ${windowDays}-day window`
      : state === 'In progress' ? (mail && mail.length ? `${mail.length} matching email(s) found` : `Progress note: "${[r.progress, r.remarks].filter(Boolean).join(' · ')}"`)
      : state === 'Lapsed' ? `Sheet says Not Active and the expiry passed ${-daysLeft} days ago`
      : state === 'Overdue' ? `Expired ${-daysLeft} days ago; no renewal on the GP report or tracker, no progress note${emails ? ', no email' : ''}`
      : `Expires in ${daysLeft} days (within ${windowDays}); no renewal on the GP report or tracker, no progress note${emails ? ', no email' : ''}`;
    return { ...r, state, reason, match: m ? { month: m.month, trackerRow: m.trackerRow, gpRow: m.gpRow, invoice: m.invoice } : null, daysLeft,
      gpMonth: m?.month || null, gpInvoice: m?.invoice || null, email: mail ? mail.length > 0 : null, emails: (mail || []).slice(0, 3).map(e => ({ subject: e.subject, date: e.date, url: e.url })) };
  });
  for (const r of renewalView) {
    if (usedRenewals.has(r.sheetRow) || !['Not started', 'In progress', 'Overdue'].includes(r.state)) continue;
    const missing = ['No GP report or tracker entry'];
    if (r.email === false) missing.push('No email found');
    work.push({ source: 'Renewals sheet', name: r.company, client: '', zone: r.zone, type: 'Renewal', date: r.expiry, services: `Renewal due ${r.expiry}${r.daysLeft < 0 ? ` (${-r.daysLeft} days ago)` : ` (in ${r.daysLeft} days)`}`, agent: r.manager,
      trackerRow: null, trackerStatus: null, gpRow: null, gp: false, onTracker: false, invoice: null, invoiceStatus: null, fee: 0, commission: 0, commissionPct: null,
      commissionInvoice: null, commissionInvoiceStatus: null, email: r.email, emails: r.emails, renewalSheetRow: r.sheetRow,
      renewalStatus: [r.status, r.progress].filter(Boolean).join(' · ') || '—', status: r.state === 'In progress' ? 'In progress' : r.state === 'Overdue' ? 'Overdue' : 'Renewal not started', missing,
      renewal: r, month, checks: [{ rule: 'Renewal state', ok: r.state === 'In progress' ? null : false, detail: r.reason }], decidedBy: r.reason });
  }

  for (const w of work) if (w.source === 'Renewals sheet') workAll.push(w);

  // View 3 — exceptions
  const ex = [];
  const add = (severity, kind, detail, extra = {}) => ex.push({ severity, kind, detail, ...extra });
  const zn = c => zoneByCode(c)?.name || c;
  const where = t => [t.trackerRow && `tracker row ${t.trackerRow}`, t.gpRow && `GP ${t.month} row ${t.gpRow}`].filter(Boolean).join(', ');
  const aed = n => 'AED ' + Number(n).toLocaleString('en-US');
  for (const t of txAll.filter(t => isTracked(t.zone))) {
    const addT = (sev, kind, detail, extra) => add(sev, kind, detail, { ...extra, ref: { kind: 'deal', month: t.month, name: t.name, trackerRow: t.trackerRow, gpRow: t.gpRow } });
    const at = `${t.name} · ${zn(t.zone)} ${t.type} · ${t.month}`;
    if (t.status === 'Commission missed') addT('high', 'Commission missed', `${at} · ${aed(t.commission)} · ${where(t)}${t.trackerNotes ? ' · ' + t.trackerNotes : ''}`, { zone: t.zone, amount: t.commission, month: t.month });
    if (t.missing.some(x => /client invoice|not found in Zoho|is (void|draft)/i.test(x))) addT('high', 'Pending invoice (client)', `${at} · ${t.missing.filter(x => /client invoice|Zoho/i.test(x)).join('; ')} · ${where(t)}`, { zone: t.zone, amount: t.commission, month: t.month });
    if (t.missing.some(x => /^Not on the .* GP report/.test(x))) addT('medium', 'Pending GP (on tracker, not on GP report)', `${at} · ${where(t)}`, { zone: t.zone, amount: t.commission, month: t.month });
    if (t.missing.some(x => /^Not on the commission tracker/.test(x))) addT('medium', 'On GP report, not on commission tracker', `${at} · ${t.services} · ${t.commission ? aed(t.commission) + ' commission' : `no commission on the GP report${t.fee ? ` (fee ${aed(t.fee)} paid to ${zn(t.zone)})` : ''} — add it to the tracker as No commission or with the amount due`} · ${where(t)}`, { zone: t.zone, amount: t.commission, month: t.month });
    const diff = t.missing.find(x => /^Commission differs/.test(x));
    if (diff) addT('medium', 'Commission differs: tracker vs GP report', `${at} · ${diff.replace('Commission differs: ', '')} · ${where(t)}`, { zone: t.zone, amount: round2((t.trackerCommission || 0) - (t.gpCommission || 0)), month: t.month });
    if (t.missing.includes('No free zone commission recorded') && !trackerCovers(t.month)) addT('medium', 'Free zone deal with no commission', `${at} · ${t.services} · ${t.fee ? `fee ${aed(t.fee)} paid to ${zn(t.zone)}, commission 0` : 'no fee or commission on the GP report'} · ${where(t)}`, { zone: t.zone, month: t.month });
  }
  // Commission still to invoice, grouped by free zone and month
  const groups = new Map();
  for (const t of txAll) if (isTracked(t.zone) && t.flags.includes('Pending commission invoice')) {
    const k = `${t.zone}|${t.month}`, g = groups.get(k) || { zone: t.zone, month: t.month, n: 0, amount: 0, oldest: t.date, rows: [] };
    g.n++; g.amount += t.commission; if (t.date && t.date < g.oldest) g.oldest = t.date; if (t.trackerRow) g.rows.push(t.trackerRow); groups.set(k, g);
  }
  for (const g of groups.values()) {
    const age = g.oldest ? daysBetween(g.oldest, today) : 0;
    add(age > 60 ? 'high' : 'medium', 'Commission not yet invoiced', `${zn(g.zone)} · ${g.month}: ${g.n} deal${g.n > 1 ? 's' : ''}, ${aed(round2(g.amount))} to invoice · oldest ${g.oldest} (${age} days)${g.rows.length ? ' · tracker rows ' + g.rows.join(', ') : ''}`, { zone: g.zone, amount: round2(g.amount), month: g.month, ref: { kind: 'group', zone: g.zone, month: g.month, trackerRows: g.rows } });
  }
  // Collections: the tracker's Invoice Checklist is the record; Zoho Books cross-checks it
  const checklistRows = input.tracker?.checklist || [];
  for (const c of checklistRows) if (c.status === 'TO COLLECT') {
    const days = c.daysOutstanding ?? (c.date ? daysBetween(c.date, today) : 0);
    if (days > 30) add(days > 90 ? 'high' : 'medium', 'Commission invoice unpaid > 30 days', `${zn(c.zone)} · ${c.number} · ${aed(c.toCollect || c.amount)} outstanding · ${days} days (Invoice Checklist row ${c.sheetRow})`, { zone: c.zone, amount: c.toCollect || c.amount, ref: { kind: 'checklist', row: c.sheetRow, number: c.number } });
  }
  if (zoneInv) {
    if (input.tracker) for (const z of zoneInv) {
      const c = checklist.get(z.number);
      if (/draft/i.test(z.status)) add('medium', 'Commission invoice still a draft in Zoho', `${zn(z.zone)} · ${z.number} · ${aed(z.total)} — never sent${c ? `; the tracker counts it as ${c.status}` : ''}`, { zone: z.zone, amount: z.total , ref: { kind: 'zoho', number: z.number, checklistRow: c ? c.sheetRow : null } });
      if (c && c.status !== 'CANCELLED' && Math.abs((c.amount || 0) - z.total) > TOL) add('low', 'Commission invoice amount differs: tracker vs Zoho', `${zn(z.zone)} · ${z.number} · tracker ${aed(c.amount)} vs Zoho ${aed(z.total)}`, { zone: z.zone, amount: round2((c.amount || 0) - z.total) , ref: { kind: 'zoho', number: z.number, checklistRow: c ? c.sheetRow : null } });
      if (!c) add('low', 'Zoho commission invoice not in tracker', `${zn(z.zone)} · ${z.number} · ${z.date} · ${aed(z.total)} — not on the Invoice Checklist / Register`, { zone: z.zone, amount: z.total , ref: { kind: 'zoho', number: z.number, checklistRow: c ? c.sheetRow : null } });
      else if (c.status === 'RECEIVED' && z.balance > TOL) add('low', 'Paid per tracker, open in Zoho', `${zn(z.zone)} · ${z.number} · Zoho balance ${aed(z.balance)}`, { zone: z.zone, amount: z.balance , ref: { kind: 'zoho', number: z.number, checklistRow: c ? c.sheetRow : null } });
      else if (c.status === 'TO COLLECT' && z.balance <= TOL && z.total > 0) add('low', 'Paid in Zoho, open on tracker', `${zn(z.zone)} · ${z.number} · Zoho shows it paid; the tracker still lists ${aed(c.toCollect)} to collect`, { zone: z.zone, amount: c.toCollect , ref: { kind: 'zoho', number: z.number, checklistRow: c ? c.sheetRow : null } });
    }
    else for (const inv of zoneInv) if (inv.balance > TOL && inv.date && daysBetween(inv.date, today) > 30)
      add('medium', 'Commission invoice unpaid > 30 days', `${zn(inv.zone)} · ${inv.number} (${inv.period}) · ${aed(inv.balance)} outstanding since ${inv.date}`, { zone: inv.zone, amount: inv.balance , ref: { kind: 'zoho', number: inv.number } });
  }
  for (const r of renewalView) {
    if (r.state === 'Overdue') add('high', 'Renewal overdue, not started', `${r.company} · ${zn(r.zone)} · expired ${r.expiry} (${-r.daysLeft} days ago) · no GP or tracker renewal${r.email === false ? ', no email' : ''} · Renewals row ${r.sheetRow}`, { zone: r.zone , ref: { kind: 'renewal', row: r.sheetRow, name: r.company } });
    else if (r.state === 'Not started' && r.daysLeft <= 30) add('medium', 'Renewal not started, due ≤ 30 days', `${r.company} · ${zn(r.zone)} · expires ${r.expiry} (in ${r.daysLeft} days) · Renewals row ${r.sheetRow}`, { zone: r.zone , ref: { kind: 'renewal', row: r.sheetRow, name: r.company } });
    if (r.dateAmbiguous && r.state !== 'Closed') add('low', 'Renewal date unclear', `${r.company} · Renewals row ${r.sheetRow}: "${r.expiryRaw}" is typed as text — read as ${r.expiry}; worth re-entering as a date`, { zone: r.zone , ref: { kind: 'renewal', row: r.sheetRow, name: r.company } });
    if (r.dateBad) add('low', 'Renewal date unreadable', `${r.company} · Renewals row ${r.sheetRow}: "${r.expiryRaw}"`, { zone: r.zone , ref: { kind: 'renewal', row: r.sheetRow, name: r.company } });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  ex.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount || 0) - (a.amount || 0));

  // Commission invoices: the tracker's Invoice Checklist, joined to Zoho Books by invoice number
  const commissionInvoices = [
    ...checklistRows.map(c => { const z = zohoByNumber.get(c.number); return { ...c, inTracker: true, zoho: z ? { status: z.status, balance: z.balance, total: z.total, period: z.period, periodBasis: z.periodBasis } : null }; }),
    ...(zoneInv || []).filter(z => !checklist.has(z.number)).map(z => ({ number: z.number, zone: z.zone, date: z.date, amount: z.total, status: null, inTracker: false, zoho: { status: z.status, balance: z.balance, total: z.total, period: z.period, periodBasis: z.periodBasis } }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const count = (list, f) => list.filter(f).length;
  const deals = work.filter(w => w.source !== 'Renewals sheet');
  const rsel = renewalView.filter(r => r.state !== 'Closed');
  const toCollect = checklistRows.filter(c => c.status === 'TO COLLECT');
  return {
    month, months, today, windowDays, baseline: sel?.baseline || null, trackerFrom,
    zones: [...TRACKED.map(z => ({ code: z.code, name: z.name })), { code: OTHER, name: 'Other free zones' }],
    kpis: {
      commission: sel?.total.commission || 0, uninvoiced: sel?.total.uninvoiced || 0, missed: sel?.total.missed || 0,
      uninvoicedAll: round2(txAll.filter(t => t.flags.includes('Pending commission invoice')).reduce((a, t) => a + t.commission, 0)),
      toCollect: input.tracker ? round2(toCollect.reduce((a, c) => a + (c.toCollect || 0), 0)) : zoneInv ? round2(zoneInv.reduce((a, i) => a + i.balance, 0)) : null,
      toCollectCount: input.tracker ? toCollect.length : zoneInv ? zoneInv.filter(i => i.balance > TOL).length : null, toCollectSource: input.tracker ? 'Invoice Checklist' : zoneInv ? 'Zoho Books' : null,
      deals: deals.length, completed: count(deals, w => ['Completed', 'No commission', 'Awaiting payment'].includes(w.status)), pending: count(deals, w => !['Completed', 'No commission', 'Awaiting payment'].includes(w.status)),
      renewalsDue: count(rsel, r => ['Not started', 'Overdue', 'In progress'].includes(r.state)), renewalsOverdue: count(rsel, r => r.state === 'Overdue'), exceptions: ex.length
    },
    // Open renewals, plus the ones completed in the selected month.
    summary, work, renewals: renewalView.filter(r => ['Not started', 'Overdue', 'In progress', 'Check date'].includes(r.state) || (r.state === 'Completed' && (r.gpMonth === month || monthOf(r.renewedOn) === month)))
      .sort((a, b) => (a.expiry || '9') < (b.expiry || '9') ? -1 : 1),
    renewalCounts: Object.fromEntries(['Not started', 'Overdue', 'In progress', 'Completed', 'Not due', 'Lapsed', 'Closed', 'Check date'].map(s => [s, count(renewalView, r => r.state === s)])),
    workAll, zoneInvoices: zoneInv, commissionInvoices, exceptions: ex,
    rules: { statusOrder: STATUS_ORDER, toleranceAed: TOL, windowDays, trackerFrom, zones: ZONES.map(z => ({ code: z.code, name: z.name, tracked: !!z.tracked, pattern: String(z.re), domains: z.domains, booksCustomerId: z.booksCustomerId || null })) },
    emails: emails ? emails.filter(e => e.zone || e.companies.length).slice(0, 100) : null
  };
}
