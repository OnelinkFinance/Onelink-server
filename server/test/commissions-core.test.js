import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGpReport, parseRenewals, parseSheetDate, gpReportMonth, detectZone, detectType, sameCompany, companyKey,
  invoicePeriod, classifyEmail, buildDashboard, addMonths, monthEnd
} from '../commissions-core.js';

// Header rows and data rows as the September 2026 GP report "Summary" tab returns them (UNFORMATTED_VALUE).
const H1 = ['S.No', 'Date', 'Invoice', 'Client Name', 'Company Name', 'Source', 'Agent Name', 'Services', '', '', '', '', 'Package Services', 'Revenue', 'Expenses', ' Free zone Commission', 'Upsell', 'GP', 'Adjustment', 'Notes', 'Final GP', 'GP vs Revenue', 52450, 0, 56040, 65129, 29140, 48190, 2250, 26724, 7567, 227248, 636209.27, 27120];
const H2 = ['', '', '', '', '', '', '', '0 VISA', 'With Visa', 'Others', 'Renewals', 'Cross Sell', '', '', '', '', '', '', '', '', '', '', 'Meydan', 'IFZA', 'RAKEZ', 'RAK DAO', 'DUBAI SOUTH', 'MAINLAND', 'REFERRAL', 'Third Party/External Consultants', 'VAT', 'Other', 'Payment Received', 'Pending Payment', 'Mode of Payment', 'Remarks'];
const row = (o) => {
  const r = Array(36).fill('');
  Object.assign(r, { 0: o.n, 1: o.date, 2: o.inv, 3: o.client, 4: o.company || '', 6: o.agent || 'Anastasiya', 7: !!o.zeroVisa, 8: !!o.withVisa, 9: false, 10: !!o.renewal, 11: false, 12: o.services, 13: o.revenue || 0, 15: o.commission ?? '' });
  if (o.fz) r[{ Meydan: 22, IFZA: 23, RAKEZ: 24, 'RAK DAO': 25, 'DUBAI SOUTH': 26, MAINLAND: 27 }[o.fz]] = o.fee;
  return r;
};
const SEPT = [
  ['', 'Total Revenue', '', 663329.27, 'Onelink Solutions - September 2026'], [], H1, H2,
  row({ n: 2, date: 46266, inv: 'INV-000577', client: 'Amresh', company: 'Redacted Group LLC FZ', services: 'Meydan | License Renewal', renewal: true, fz: 'Meydan', fee: 12520, commission: 2504 }),
  row({ n: 14, date: '09/08/2026', inv: 'INV-000589', client: 'Maj', company: 'Hocevar Ventures FZ-LLC', services: 'License Renewal | 1 YEAR | RAKEZ', renewal: true, fz: 'RAKEZ', fee: 12010, commission: 3603 }),
  row({ n: 15, date: '09/09/2026', inv: 'INV-000590', client: 'Grid Systems LTD', company: 'Grid Systems LTD', services: 'License Renewal | 1 YEAR | RAK DAO', fz: 'RAK DAO', fee: 20300, commission: 6090 }),
  row({ n: 29, date: '09/14/2026', inv: 'INV-000604', client: 'Yevgeni Lisenko', services: 'Business Setup | RAK-DAO', withVisa: true, fz: 'RAK DAO', fee: 8470, commission: '' }),
  row({ n: 46, date: '09/28/2026', inv: '', client: 'DUCA ELENA SELASIG PROCREDIT S R L', services: '0 Visa Package | RAK DAO ', zeroVisa: true, fz: 'RAK DAO', fee: 6600, commission: 2970 }),
  row({ n: 8, date: '09/07/2026', inv: 'INV-000583', client: 'Amra', company: 'Masters of Shilajit Official DWC-LLC', services: 'License Renewal | 1 Year | Dubai South', fz: 'DUBAI SOUTH', fee: 12550, commission: 5020 }),
  row({ n: 4, date: '09/02/2026', inv: 'INV-000579', client: 'WILLIAM JOSEPH', company: 'Famous Fox Federation LTD', services: 'Certificate of Incumbency', revenue: 1500 }),
  ['', '', '', '', '', '', '', '0', '', '0', '0', '0', '', 'dh663,329.27', 'dh504,421.00', 'dh53,446.70'],   // totals row
  ['', '', '', '', '', '', '', false, true, false, false, false, 'RAK DAO - 1 Visa', '', '', '', 0]           // package legend
];
const RENEWALS = [
  ['N', 'Company ', 'Authority', 'Expiry Date', 'Date of Renewal', 'Status', 'Progress', 'Remarks', 'Account Manager '],
  [1, 'Hocevar Ventures FZ-LLC', 'RAKEZ', 46273, '', 'Active', '', '', 'Anastasia'],
  [2, 'Shopzen FZ-LLC', 'RAKEZ', 46301, '', 'Active', '', '', 'Amina'],                // expires today
  [3, 'Lince LTD', 'RAK Dao', 46250, '', 'Active', '', '', 'Amina'],                    // expired 2026-08-16, nothing done
  [4, 'Block Media Marketing - FZCO', 'IFZA', 46026, '', 'Not Active ', 'Invoice sent', '', 'Anastasia'], // not tracked
  [5, 'Relentless Enterprise L.L.C-FZ', 'Meydan', 46310, '', 'Active', 'Invoice sent', '', 'Anastasia'],
  [6, 'Old Co', 'RAK Dao', 45700, '', 'Not Active ', 'company cancelled', '', 'Amina'],
  [7, 'ScaleUp Marketing LTD', 'RAK Dao', '16/03/2027', '', 'Active', '', '', 'Anastasia'],
  [8, 'Navision - FZCO', 'RAK ICC', 46700, '28.01.2026', 'Renewed', '', '', 'Amina']
];

test('dates: serials, en_US text, dotted day-first, ambiguous text', () => {
  assert.equal(parseSheetDate(46266).date, '2026-09-01');
  assert.equal(parseSheetDate('09/28/2026').date, '2026-09-28');
  assert.equal(parseSheetDate('09/08/2026').date, '2026-09-08');
  assert.equal(parseSheetDate('16/03/2027', { textDayFirst: true }).date, '2027-03-16');
  assert.equal(parseSheetDate('28.01.2026').date, '2026-01-28');
  assert.deepEqual(parseSheetDate('11/03/2027', { textDayFirst: true }), { date: '2027-03-11', ambiguous: true });
  assert.equal(parseSheetDate('20.22.2025').date, null);
  assert.equal(parseSheetDate('-').date, null);
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(monthEnd('2026-02'), '2026-02-28');
});

test('GP report titles map to months; copies are skipped', () => {
  assert.equal(gpReportMonth('Onelink Solutions GP Report- September 2026'), '2026-09');
  assert.equal(gpReportMonth(' Onelink Solutions GP Report- Dec 2025'), '2025-12');
  assert.equal(gpReportMonth('Copy of Onelink Solutions GP Report- July 2026'), null);
  assert.equal(gpReportMonth('Elite Onelink - Live Sales GP Dashboard'), null);
});

test('zones, types and company identity', () => {
  assert.equal(detectZone('Business Setup | RAK-DAO'), 'RAKDAO');
  assert.equal(detectZone('RAK International Corporate Centre'), 'RAKICC');
  assert.equal(detectZone('Ras Al Khaimah Economic Zone Authority'), 'RAKEZ');
  assert.equal(detectZone('Meydan City Corporation'), 'MEYDAN');
  assert.equal(detectZone('Mainland License'), null);
  assert.equal(detectType('License Renewal | 1 YEAR | RAK DAO'), 'Renewal');
  assert.equal(detectType('RAK DAO | 1BL + 1V'), 'New');
  assert.equal(detectType('License Amendment'), 'Other');
  assert.ok(sameCompany('ADA ENTERPRISE L.L.C - FZ', 'ADA Enterprise LLC FZ'));
  assert.ok(sameCompany('Grid Systems', 'Grid Systems LTD'));
  assert.ok(sameCompany('NEXT IT SOLUTIONS LLC-FZ', 'NEXT IT SOLUTION '));
  assert.ok(sameCompany('Redacted Group LLC FZ', 'Redacted Group L.L.C - FZ'));
  assert.ok(!sameCompany('Grid', 'Grid Systems LTD'));
  assert.ok(!sameCompany('Grid Systems LTD', 'The Grid FZ-LLC'));
  assert.equal(companyKey('Hocevar Ventures FZ-LLC'), 'hocevar venture');
});

test('GP report rows: zone, type, fee, commission', () => {
  const { rows, error } = parseGpReport(SEPT, '2026-09');
  assert.equal(error, undefined);
  assert.equal(rows.length, 7);
  const m = rows[0];
  assert.deepEqual([m.date, m.invoice, m.zone, m.type, m.fee, m.commission, m.commissionPct], ['2026-09-01', 'INV-000577', 'MEYDAN', 'Renewal', 12520, 2504, 20]);
  assert.equal(rows[2].type, 'Renewal');                       // Renewals flag FALSE, service text says renewal
  assert.deepEqual([rows[3].zone, rows[3].type, rows[3].commission], ['RAKDAO', 'New', 0]);
  assert.equal(rows[5].zone, 'DSOUTH');
  assert.equal(rows[6].zone, null);
});

test('commission invoice period: from text, else month before', () => {
  assert.deepEqual(invoicePeriod({ date: '2026-09-07', line_items: [{ description: 'Referral commission - August 2026' }] }), { month: '2026-08', basis: 'invoice text' });
  assert.equal(invoicePeriod({ date: '2026-01-05', reference_number: 'Dec commission' }).month, '2025-12');
  assert.equal(invoicePeriod({ date: '2026-09-07' }).month, '2026-08');
});

test('emails link to zone by sender and to company by name', () => {
  const e = classifyEmail({ subject: 'Renewal Invoice Submission - Hocevar Ventures', from: 'R Akkas <r.akkas@rakez.com>' }, ['Hocevar Ventures FZ-LLC', 'Grid']);
  assert.equal(e.zone, 'RAKEZ'); assert.equal(e.type, 'Renewal'); assert.deepEqual(e.companies, ['Hocevar Ventures FZ-LLC']);
});

function dashboard(over = {}) {
  const gp = { '2026-09': parseGpReport(SEPT, '2026-09').rows };
  const clientInvoices = new Map([['INV-000577', { status: 'paid' }], ['INV-000589', { status: 'paid' }], ['INV-000590', { status: 'paid' }], ['INV-000604', { status: 'paid' }], ['INV-000583', { status: 'paid' }]]);
  const zoneInvoices = [
    { zone: 'MEYDAN', number: 'INV-000630', date: '2026-10-03', period: '2026-09', subTotal: 2504, total: 2629.2, balance: 2629.2 },
    { zone: 'RAKDAO', number: 'INV-000631', date: '2026-10-03', period: '2026-09', subTotal: 6090, total: 6394.5, balance: 0 },
    { zone: 'RAKICC', number: 'INV-000500', date: '2026-08-01', period: '2026-07', subTotal: 900, total: 945, balance: 945 }
  ];
  return buildDashboard({ month: '2026-09', months: ['2026-08', '2026-09'], gp, renewals: parseRenewals(RENEWALS).rows, clientInvoices, zoneInvoices, emails: null, today: '2026-10-06', ...over });
}

test('monthly summary by free zone reconciles with the GP report', () => {
  const d = dashboard(), s = d.summary.find(x => x.month === '2026-09');
  assert.equal(s.zones.MEYDAN.renewalCommission, 2504);
  assert.equal(s.zones.RAKDAO.commission, 6090 + 2970);
  assert.equal(s.zones.RAKDAO.newCount, 2);                  // Lisenko (0 commission) + Duca
  assert.equal(s.zones.RAKEZ.commission, 3603);
  assert.equal(s.zones.OTHER.commission, 5020);              // Dubai South
  assert.equal(s.total.commission, 2504 + 6090 + 2970 + 3603 + 5020);
  assert.equal(s.zones.MEYDAN.invoiced, 2504);
  assert.equal(d.summary.find(x => x.month === '2026-08').hasReport, false);
});

test('work status: completed, missing invoice, no commission, commission not invoiced', () => {
  const d = dashboard(), by = n => d.work.find(w => w.name === n);
  assert.equal(by('Redacted Group LLC FZ').status, 'Completed');
  assert.equal(by('Redacted Group LLC FZ').commissionInvoiced, 'Invoiced · unpaid');
  assert.equal(by('DUCA ELENA SELASIG PROCREDIT S R L').status, 'Missing invoice');
  assert.equal(by('Yevgeni Lisenko').status, 'No commission');
  assert.equal(by('Hocevar Ventures FZ-LLC').status, 'Commission not invoiced');   // RAKEZ September not billed
  assert.equal(by('Grid Systems LTD').status, 'Commission not invoiced');          // RAK DAO billed 6,090 of 9,060
  assert.equal(by('Grid Systems LTD').commissionInvoiced, 'Partly invoiced');
  assert.equal(by('Masters of Shilajit Official DWC-LLC'), undefined);             // Dubai South not tracked
  assert.equal(by('Famous Fox Federation LTD'), undefined);                         // no free zone
});

test('renewals: GP match completes, overdue, in progress, closed, untracked', () => {
  const d = dashboard(), st = n => d.renewals.find(r => r.company === n)?.state;
  assert.equal(st('Hocevar Ventures FZ-LLC'), 'Completed');
  assert.equal(st('Lince LTD'), 'Overdue');
  assert.equal(st('Shopzen FZ-LLC'), 'Not started');
  assert.equal(st('Relentless Enterprise L.L.C-FZ'), 'In progress');
  assert.equal(st('Block Media Marketing - FZCO'), undefined);
  assert.equal(d.renewalCounts.Closed, 1);
  assert.equal(d.renewalCounts['Not due'], 1);                 // ScaleUp (text date 16/03/2027)
  assert.equal(st('Navision - FZCO'), undefined);               // Renewed → Completed, not listed (not this month)
  assert.equal(d.renewalCounts.Completed, 2);
  const w = d.work.filter(x => x.source === 'Renewals sheet').map(x => [x.name, x.status]);
  assert.deepEqual(w.sort(), [['Lince LTD', 'Overdue'], ['Relentless Enterprise L.L.C-FZ', 'In progress'], ['Shopzen FZ-LLC', 'Not started']]);
});

test('exceptions cover the leaks', () => {
  const kinds = dashboard().exceptions.map(e => e.kind);
  for (const k of ['GP deal without Zoho invoice', 'Free zone deal with no commission', 'Commission not invoiced', 'Commission amount mismatch', 'Commission invoice unpaid > 30 days', 'Renewal overdue, not started', 'Renewal due ≤ 30 days, not started'])
    assert.ok(kinds.includes(k), k);
  assert.equal(dashboard().exceptions[0].severity, 'high');
});

test('without Zoho or Gmail the dashboard still builds from the sheets', () => {
  const d = dashboard({ clientInvoices: null, zoneInvoices: null });
  assert.equal(d.kpis.invoiced, null);
  assert.equal(d.work.find(w => w.name === 'Redacted Group LLC FZ').status, 'Completed');
  assert.equal(d.work.find(w => w.name === 'DUCA ELENA SELASIG PROCREDIT S R L').status, 'Missing invoice');
  assert.ok(!d.exceptions.some(e => e.kind === 'Commission not invoiced'));
});
