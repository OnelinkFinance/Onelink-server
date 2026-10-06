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
  if (flags.zeroVisa || flags.withVisa || /set[\s-]?up|incorporat|formation|new (?:company|licen[cs]e)|\b\d+\s*BL\b|0 visa package/i.test(t)) return 'New';
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

// ---- GP report ----
export function parseGpReport(values, month) {
  const rows = values || [];
  const hi = rows.findIndex(r => norm(r?.[0]) === 's no');
  if (hi < 0) return { rows: [], error: 'No "S.No" header row on the GP report tab' };
  const h1 = rows[hi] || [], h2 = rows[hi + 1] || [];
  const names = Array.from({ length: Math.max(h1.length, h2.length) }, (_, i) => norm(typeof h2[i] === 'string' && h2[i].trim() ? h2[i] : h1[i]));
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
      revenue: round2(num(cell(r, 'revenue'))), finalGp: round2(num(cell(r, 'finalGp'))), received: round2(num(cell(r, 'received'))), pending: round2(num(cell(r, 'pending')))
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
      renewedOn: parseSheetDate(C.renewedOn >= 0 ? r[C.renewedOn] : '', { textDayFirst: true }).date, status: cell(r, 'status'), progress: cell(r, 'progress'), remarks: cell(r, 'remarks'), manager: cell(r, 'manager')
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

// ---- commission invoices → the month they bill ----
// A free zone commission invoice is raised after the month it covers ("Commission invoice - August 2026",
// sent in September). The month is read from the invoice text; failing that it is the month before the invoice date.
export function invoicePeriod(inv, lagMonths = 1) {
  const text = [inv.reference_number, inv.subject_content, inv.notes, ...(inv.line_items || []).flatMap(l => [l.name, l.description])].filter(Boolean).join(' ');
  const invMonth = monthOf(inv.date);
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

// in: { month, months[], gp: {month: rows[]}, renewals: rows[], clientInvoices: Map|null, zoneInvoices: [] | null,
//       emails: [] | null, today, windowDays }
export function buildDashboard(input) {
  const { month, months, today, windowDays = 60 } = input;
  const gpAll = months.flatMap(m => input.gp[m] || []);
  const renewals = (input.renewals || []).filter(r => isTracked(r.zone));
  const zoneInv = input.zoneInvoices;
  const names = [...new Set([...gpAll.map(g => g.name), ...gpAll.map(g => g.client), ...renewals.map(r => r.company)].filter(Boolean))];
  const emails = input.emails ? input.emails.map(e => classifyEmail(e, names)) : null;
  const emailsFor = (name, zone) => !emails ? null : emails.filter(e => e.companies.some(c => sameCompany(c, name)) && (!zone || !e.zone || e.zone === zone));

  // View 1 — monthly commissions by free zone
  const cell = () => ({ newCount: 0, newCommission: 0, renewalCount: 0, renewalCommission: 0, otherCount: 0, otherCommission: 0, commission: 0, invoiced: 0, invoiceTotal: 0, outstanding: 0, invoices: [] });
  const summary = months.map(m => {
    const zones = Object.fromEntries([...TRACKED.map(z => z.code), OTHER].map(c => [c, cell()]));
    for (const g of input.gp[m] || []) {
      if (!g.zone || (!g.commission && g.type === 'Other')) continue;
      const c = zones[bucket(g.zone)], k = g.type === 'New' ? 'new' : g.type === 'Renewal' ? 'renewal' : 'other';
      c[k + 'Count']++; c[k + 'Commission'] += g.commission; c.commission += g.commission;
    }
    for (const inv of zoneInv || []) if (inv.period === m) {
      const c = zones[inv.zone]; c.invoiced += inv.subTotal; c.invoiceTotal += inv.total; c.outstanding += inv.balance; c.invoices.push(inv.number);
    }
    for (const c of Object.values(zones)) for (const k of Object.keys(c)) if (typeof c[k] === 'number') c[k] = round2(c[k]);
    const total = cell();
    for (const c of Object.values(zones)) for (const k of Object.keys(total)) if (typeof total[k] === 'number') total[k] = round2(total[k] + c[k]);
    return { month: m, hasReport: !!input.gp[m], zones, total };
  });
  const sel = summary.find(s => s.month === month);
  const zoneState = code => {
    if (!zoneInv || code === OTHER) return null;
    const c = sel?.zones[code];
    if (!c || (!c.commission && !c.invoiced)) return null;
    if (c.commission && !c.invoiced) return 'Not invoiced';
    if (Math.abs(c.invoiced - c.commission) <= TOL) return c.outstanding > TOL ? 'Invoiced · unpaid' : 'Invoiced · paid';
    return c.invoiced < c.commission ? 'Partly invoiced' : 'Invoiced more than GP';
  };

  // View 2 — work status, one line per tracked deal or due renewal
  const work = [];
  const usedRenewals = new Set();
  const gpMatchFor = r => gpAll.find(g => g.zone === r.zone && g.type === 'Renewal' && (sameCompany(g.name, r.company) || sameCompany(g.client, r.company))
    && (!r.expiry || !g.date || Math.abs(daysBetween(r.expiry, g.date)) <= 150));
  for (const g of input.gp[month] || []) {
    if (!g.zone || !isTracked(g.zone)) continue;
    if (g.type === 'Other' && !g.commission) continue;
    const ren = g.type === 'Renewal' ? renewals.find(r => r.zone === g.zone && (sameCompany(r.company, g.name) || sameCompany(r.company, g.client))) : null;
    if (ren) usedRenewals.add(ren.sheetRow);
    const inv = input.clientInvoices ? input.clientInvoices.get(g.invoice) || null : undefined;
    const mail = emails ? [...new Set([...emailsFor(g.name, g.zone), ...(g.client && g.client !== g.name ? emailsFor(g.client, g.zone) : [])])] : null;
    const missing = [];
    if (!g.invoice) missing.push('No invoice no. on GP report');
    else if (inv === null) missing.push(`${g.invoice} not found in Zoho Books`);
    else if (inv && /void|draft/i.test(inv.status)) missing.push(`${g.invoice} is ${inv.status} in Zoho Books`);
    if (!g.commission && g.type !== 'Other') missing.push('No free zone commission on GP report');
    const zs = g.commission ? zoneState(g.zone) : null;
    if (zs === 'Not invoiced' || zs === 'Partly invoiced') missing.push(`${zoneByCode(g.zone).name} commission for ${month} ${zs.toLowerCase()}`);
    const status = missing.some(x => /invoice no\.|not found|is (void|draft)/i.test(x)) ? 'Missing invoice'
      : missing.some(x => /commission .* (not|partly) invoiced/.test(x)) ? 'Commission not invoiced'
      : missing.some(x => /No free zone commission/.test(x)) ? 'No commission'
      : 'Completed';
    work.push({
      source: 'GP report', name: g.name, client: g.client, zone: g.zone, type: g.type, date: g.date, services: g.services, agent: g.agent,
      gp: true, invoice: g.invoice || null, invoiceStatus: inv ? inv.status : inv === null ? 'not found' : null, commission: g.commission, fee: g.fee, commissionPct: g.commissionPct,
      commissionInvoiced: zs, email: mail ? mail.length > 0 : null, emails: (mail || []).slice(0, 3).map(e => ({ subject: e.subject, date: e.date, url: e.url })),
      renewalStatus: ren ? (ren.status || '—') : null, status, missing
    });
  }
  const renewalView = renewals.map(r => {
    const gpMatch = gpMatchFor(r), mail = emailsFor(r.company, r.zone);
    return { ...r, state: classifyRenewal(r, { today, windowDays, gpMatch, emailMatch: mail && mail.length }), daysLeft: r.expiry ? daysBetween(today, r.expiry) : null,
      gpMonth: gpMatch?.month || null, gpInvoice: gpMatch?.invoice || null, email: mail ? mail.length > 0 : null, emails: (mail || []).slice(0, 3).map(e => ({ subject: e.subject, date: e.date, url: e.url })) };
  });
  for (const r of renewalView) {
    if (usedRenewals.has(r.sheetRow) || !['Not started', 'In progress', 'Overdue'].includes(r.state)) continue;
    const missing = ['No GP report entry'];
    if (r.email === false) missing.push('No email found');
    work.push({ source: 'Renewals sheet', name: r.company, client: '', zone: r.zone, type: 'Renewal', date: r.expiry, services: `Renewal due ${r.expiry}${r.daysLeft < 0 ? ` (${-r.daysLeft} days ago)` : ` (in ${r.daysLeft} days)`}`, agent: r.manager,
      gp: false, invoice: null, invoiceStatus: null, commission: 0, fee: 0, commissionPct: null, commissionInvoiced: null, email: r.email, emails: r.emails,
      renewalStatus: [r.status, r.progress].filter(Boolean).join(' · ') || '—', status: r.state === 'In progress' ? 'In progress' : r.state === 'Overdue' ? 'Overdue' : 'Not started', missing });
  }

  // View 3 — exceptions
  const ex = [];
  const add = (severity, kind, detail, extra = {}) => ex.push({ severity, kind, detail, ...extra });
  for (const w of work.filter(w => w.source === 'GP report')) {
    if (w.status === 'Missing invoice') add('high', 'GP deal without Zoho invoice', `${w.name} · ${zoneByCode(w.zone).name} ${w.type} · ${w.missing.filter(x => !/commission/i.test(x)).join('; ')}`, { zone: w.zone, amount: w.commission });
    if (w.status === 'No commission') add('medium', 'Free zone deal with no commission', `${w.name} · ${w.services} · ${w.fee ? `fee AED ${w.fee.toLocaleString('en-US')} paid to ${zoneByCode(w.zone).name}, commission 0` : `no ${zoneByCode(w.zone).name} fee or commission on the GP report`}`, { zone: w.zone });
  }
  if (sel && zoneInv) for (const z of TRACKED) {
    const c = sel.zones[z.code];
    if (c.commission && !c.invoiced) add('high', 'Commission not invoiced', `${z.name} ${month}: AED ${c.commission.toLocaleString('en-US')} commission on the GP report, no commission invoice in Zoho Books`, { zone: z.code, amount: c.commission });
    else if (!c.commission && c.invoiced) add('medium', 'Invoice without GP commission', `${z.name} ${month}: invoiced AED ${c.invoiced.toLocaleString('en-US')} (${c.invoices.join(', ')}) but the GP report shows no commission`, { zone: z.code, amount: c.invoiced });
    else if (c.commission && Math.abs(c.invoiced - c.commission) > TOL) add('medium', 'Commission amount mismatch', `${z.name} ${month}: GP report AED ${c.commission.toLocaleString('en-US')} vs invoiced AED ${c.invoiced.toLocaleString('en-US')} (${c.invoices.join(', ')})`, { zone: z.code, amount: round2(c.commission - c.invoiced) });
  }
  for (const inv of zoneInv || []) {
    if (inv.balance > TOL && inv.date && daysBetween(inv.date, today) > 30) add('medium', 'Commission invoice unpaid > 30 days', `${zoneByCode(inv.zone).name} · ${inv.number} (${inv.period}) · AED ${inv.balance.toLocaleString('en-US')} outstanding since ${inv.date}`, { zone: inv.zone, amount: inv.balance });
    if (!months.includes(inv.period) && inv.period >= months[0]) add('low', 'Commission invoice for a month with no GP report', `${zoneByCode(inv.zone).name} · ${inv.number} bills ${inv.period}`, { zone: inv.zone });
  }
  for (const r of renewalView) {
    if (r.state === 'Overdue') add('high', 'Renewal overdue, not started', `${r.company} · ${zoneByCode(r.zone).name} · expired ${r.expiry} (${-r.daysLeft} days ago) · no GP renewal${r.email === false ? ', no email' : ''}`, { zone: r.zone });
    else if (r.state === 'Not started' && r.daysLeft <= 30) add('medium', 'Renewal due ≤ 30 days, not started', `${r.company} · ${zoneByCode(r.zone).name} · expires ${r.expiry} (in ${r.daysLeft} days)`, { zone: r.zone });
    if (r.dateAmbiguous && r.state !== 'Closed') add('low', 'Renewal date unclear', `${r.company} · Renewals row ${r.sheetRow}: "${r.expiryRaw}" is typed as text — read as ${r.expiry}; please re-enter it as a date`, { zone: r.zone });
    if (r.dateBad) add('low', 'Renewal date unreadable', `${r.company} · Renewals row ${r.sheetRow}: "${r.expiryRaw}"`, { zone: r.zone });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  ex.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const count = (list, f) => list.filter(f).length;
  const rsel = renewalView.filter(r => r.state !== 'Closed');
  return {
    month, months, today, windowDays,
    zones: [...TRACKED.map(z => ({ code: z.code, name: z.name })), { code: OTHER, name: 'Other free zones' }],
    kpis: {
      commission: sel?.total.commission || 0, invoiced: zoneInv ? sel?.total.invoiced || 0 : null, outstanding: zoneInv ? sel?.total.outstanding || 0 : null,
      deals: count(work, w => w.source === 'GP report'), completed: count(work, w => w.source === 'GP report' && w.status === 'Completed'), pending: count(work, w => w.source === 'GP report' && w.status !== 'Completed'),
      renewalsDue: count(rsel, r => ['Not started', 'Overdue', 'In progress'].includes(r.state)), renewalsOverdue: count(rsel, r => r.state === 'Overdue'), exceptions: ex.length
    },
    // Open renewals, plus the ones completed in the selected month.
    summary, work, renewals: renewalView.filter(r => ['Not started', 'Overdue', 'In progress', 'Check date'].includes(r.state) || (r.state === 'Completed' && (r.gpMonth === month || monthOf(r.renewedOn) === month)))
      .sort((a, b) => (a.expiry || '9') < (b.expiry || '9') ? -1 : 1),
    renewalCounts: Object.fromEntries(['Not started', 'Overdue', 'In progress', 'Completed', 'Not due', 'Lapsed', 'Closed', 'Check date'].map(s => [s, count(renewalView, r => r.state === s)])),
    zoneInvoices: zoneInv, exceptions: ex,
    emails: emails ? emails.filter(e => e.zone || e.companies.length).slice(0, 100) : null
  };
}
