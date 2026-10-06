import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGpReport, parseRenewals, parseSheetDate, gpReportMonth, detectZone, detectType, sameCompany, companyKey,
  invoicePeriod, classifyEmail, buildDashboard, addMonths, monthEnd, parseTrackerLines, parseInvoiceChecklist, normRef
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
  assert.equal(parseSheetDate('04 May 2026').date, '2026-05-04');
  assert.equal(parseSheetDate('1 Sep 2026').date, '2026-09-01');
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
  assert.equal(detectType('RAK DAO - 1 Visa'), 'New');
  assert.equal(detectType('RAKEZ -0 VISA'), 'New');
  assert.equal(detectType('Dependent Visa'), 'Other');
  assert.equal(detectType('Visa Renewal'), 'Renewal');
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
  assert.deepEqual(invoicePeriod({ date: '2026-09-02', invoice_number: 'INV-RAKDAO-082026' }), { month: '2026-08', basis: 'invoice number' });
});

test('emails link to zone by sender and to company by name', () => {
  const e = classifyEmail({ subject: 'Renewal Invoice Submission - Hocevar Ventures', from: 'R Akkas <r.akkas@rakez.com>' }, ['Hocevar Ventures FZ-LLC', 'Grid']);
  assert.equal(e.zone, 'RAKEZ'); assert.equal(e.type, 'Renewal'); assert.deepEqual(e.companies, ['Hocevar Ventures FZ-LLC']);
});

// "GP Commission Lines" and "Invoice Checklist" from Freezone_Commission_Collection_Tracker, as the sheet shows them.
const LINES = [[], [], [], [], ['Date', 'Free zone', 'INV ref', 'Client name', 'Company name', 'Package / service', 'Free zone commission to invoice (AED)', 'Status', 'Notes', 'Flag'],
  ['20 Aug 2026', 'RAKEZ', 'INV-000549', 'Arman Dossymbekov', 'Nova Oil LLC FZ', 'License Renewal - 1 Year | RAKEZ', '8,103.00', 'Uninvoiced'],          // row 6
  ['11 Aug 2026', 'Meydan', 'INV-000535', 'Alan Bonner', 'First Principle Strategy Partners', 'Meydan - Company Formation - 1 Visa', '2,870.00', 'Invoiced', 'INV-MEYDAN-082026'],
  ['14 Aug 2026', 'RAK DAO', 'INV-000545', 'VIDAL MACHADO RAFAEL JORGE', 'Play Solana LTD', 'RAK DAO - Renewal', '5,517.30', 'Invoiced', 'INV-RAKDAO-082026'],
  ['12 Aug 2026', 'RAK DAO', 'INV-000539', 'Harrison', '', '1 Visa Package - RAK DAO', '', 'No commission', 'As per Innovation agreement we net off the expense'],
  ['1 Sep 2026', 'Meydan', 'INV-000577', 'Amresh', 'Redacted Group LLC FZ', 'Meydan | License Renewal', '2,504.00', 'Invoiced', 'INV-000630'],          // row 10
  ['8 Sep 2026', 'RAKEZ', 'INV-000589', 'Maj', 'Hocevar Ventures FZ-LLC', 'License Renewal | 1 YEAR | RAKEZ', '3,603.00', 'Uninvoiced'],
  ['9 Sep 2026', 'RAK DAO', 'INV-000590', 'Grid Systems LTD', 'Grid Systems LTD', 'License Renewal | 1 YEAR | RAK DAO', '6,000.00', 'Uninvoiced'],
  ['14 Sep 2026', 'RAK DAO', 'INV-000604', 'Yevgeni Lisenko', '', 'Business Setup | RAK-DAO', '', 'No commission', 'As per Innovation agreement we net off the expense'],
  ['28 Sep 2026', 'RAK DAO', '', 'DUCA ELENA SELASIG PROCREDIT S R L', 'SELASIG PROCREDIT S R L', '0 Visa Package | RAK DAO', '2,970.00', 'Uninvoiced'],
  ['20 Sep 2026', 'Meydan', 'INV-000699', 'Ghost Client', 'Ghost Trading L.L.C - FZ', 'Meydan- Renewal', '2,870.00', 'Missed', 'TO CHECK'],              // row 15: not on GP
  ['12 May 2026', 'RAK DAO', 'INV-000387', 'Travel and tourism agency', 'Travel and tourism agency', 'RAK Dao-1 Visa', '(10,147.50)']
];
const CHECKLIST = [['INVOICE CHECKLIST'], ['One line per invoice'], [],
  ['Date', 'Free Zone', 'Invoice / Doc No', 'Amount (AED)', 'Status', 'Received on', 'Days taken', 'Still to collect (AED)', 'Days outstanding', '1', '0', 'Notes'],
  ['03 Apr 2026', 'RAKEZ', 'INV-000327', '3,780.00', 'TO COLLECT', '', '', '3,780.00', '186', '43', '1'],
  ['02 Sep 2026', 'RAK DAO', 'INV-RAKDAO-082026', '33,925.82', 'TO COLLECT', '', '', '33,925.82', '34', '71', '5'],
  ['07 Sep 2026', 'Meydan', 'INV-MEYDAN-082026', '5,638.50', 'TO COLLECT', '', '', '5,638.50', '29', '72', '6'],
  ['11 Aug 2026', 'Meydan', 'INV-000534', '3,013.50', 'RECEIVED', '17 Aug 2026', '6', '', '', '67', '0'],
  ['', '', '', '', '', '', '', '', '', '', '0']
];

test('tracker tabs parse as the sheet shows them', () => {
  const { rows } = parseTrackerLines(LINES);
  assert.equal(rows.length, 11);
  assert.deepEqual([rows[0].sheetRow, rows[0].date, rows[0].zone, rows[0].ref, rows[0].commission, rows[0].status], [6, '2026-08-20', 'RAKEZ', 'INV-000549', 8103, 'Uninvoiced']);
  assert.equal(rows[1].commissionInvoice, 'INV-MEYDAN-082026');
  assert.equal(rows[3].commission, null);
  assert.equal(rows[10].commission, -10147.5);
  assert.equal(normRef('INV -000360'), 'INV-000360');
  assert.equal(normRef('NV-000467'), 'INV-000467');
  const c = parseInvoiceChecklist(CHECKLIST).rows;
  assert.equal(c.length, 4);
  assert.deepEqual([c[1].number, c[1].status, c[1].toCollect, c[1].daysOutstanding], ['INV-RAKDAO-082026', 'TO COLLECT', 33925.82, 34]);
});

function dashboard(over = {}) {
  const kenenia = row({ n: 21, date: '09/10/2026', inv: 'INV-000596', client: 'Veysel Kavun', company: 'Kenenia LTD', services: 'License Renewal | RAK DAO', renewal: true, fz: 'RAK DAO', fee: 22099, commission: 6629.7 });
  const gp = { '2026-09': parseGpReport([...SEPT, kenenia], '2026-09').rows };
  const clientInvoices = new Map([['INV-000596', { status: 'paid' }], ['INV-000577', { status: 'paid' }], ['INV-000589', { status: 'paid' }], ['INV-000590', { status: 'paid' }], ['INV-000604', { status: 'paid' }], ['INV-000583', { status: 'paid' }]]);
  const zoneInvoices = [
    { zone: 'MEYDAN', number: 'INV-000630', date: '2026-10-03', period: '2026-09', subTotal: 2504, total: 2629.2, balance: 2629.2 },
    { zone: 'RAKDAO', number: 'INV-RAKDAO-082026', date: '2026-09-02', period: '2026-08', subTotal: 32310.3, total: 33925.82, balance: 0 }
  ];
  const tracker = { lines: parseTrackerLines(LINES).rows, checklist: parseInvoiceChecklist(CHECKLIST).rows };
  return buildDashboard({ month: '2026-09', months: ['2026-08', '2026-09'], gp, tracker, renewals: parseRenewals(RENEWALS).rows, clientInvoices, zoneInvoices, emails: null, today: '2026-10-06', ...over });
}

test('transactions: tracker line joined to its GP report row; baseline is the tracker', () => {
  const d = dashboard(), by = n => d.work.find(w => w.name === n);
  assert.equal(by('Grid Systems LTD').source, 'Tracker + GP report');
  assert.equal(by('Grid Systems LTD').commission, 6000);                         // tracker figure, not the GP 6,090
  assert.ok(by('Grid Systems LTD').missing.some(x => /tracker 6000 vs GP report 6090/.test(x)));
  assert.equal(by('SELASIG PROCREDIT S R L').source, 'Tracker + GP report');    // no INV ref → joined by name + zone + date
  assert.equal(by('Kenenia LTD').source, 'GP report only');
  assert.equal(by('Ghost Trading L.L.C - FZ').source, 'Tracker only');
  assert.equal(by('Masters of Shilajit Official DWC-LLC'), undefined);         // Dubai South not tracked
});

test('statuses follow the spec: Completed / Pending invoice / Pending GP / Pending commission invoice / missed', () => {
  const d = dashboard(), st = n => d.work.find(w => w.name === n)?.status;
  assert.equal(st('Redacted Group LLC FZ'), 'Awaiting payment');                // INV-000630: not on the checklist, open in Zoho
  assert.equal(st('Hocevar Ventures FZ-LLC'), 'Pending commission invoice');
  assert.equal(st('SELASIG PROCREDIT S R L'), 'Pending invoice');               // no client invoice no.
  assert.equal(st('Ghost Trading L.L.C - FZ'), 'Commission missed');
  assert.ok(d.work.find(w => w.name === 'Ghost Trading L.L.C - FZ').missing.includes('Not on the 2026-09 GP report'));
  assert.equal(st('Yevgeni Lisenko'), 'No commission');                         // tracker: net off per Innovation agreement — not an exception
  assert.equal(st('Kenenia LTD'), 'Pending commission invoice');                // GP only; no RAK DAO Sept invoice in Zoho
  assert.ok(d.work.find(w => w.name === 'Kenenia LTD').missing.some(x => /^Not on the commission tracker/.test(x)));
  assert.equal(st('Lince LTD'), 'Overdue');
  assert.equal(st('Shopzen FZ-LLC'), 'Renewal not started');
  const aug = dashboard({ month: '2026-08' }), sa = n => aug.work.find(w => w.name === n)?.status;
  assert.equal(sa('First Principle Strategy Partners'), 'Awaiting payment');     // INV-MEYDAN-082026 TO COLLECT
  assert.equal(sa('Nova Oil LLC FZ'), 'Pending commission invoice');
  assert.equal(sa('Play Solana LTD'), 'Awaiting payment');
});

test('monthly summary: tracker baseline, GP cross-check, Finalized vs Under review', () => {
  const d = dashboard(), s = d.summary.find(x => x.month === '2026-09');
  assert.equal(s.baseline, 'Commission tracker');
  assert.equal(s.state, 'Under review');
  assert.equal(s.zones.MEYDAN.commission, 2504 + 2870);                         // Redacted + Ghost (missed)
  assert.equal(s.zones.MEYDAN.missed, 2870);
  assert.equal(s.zones.RAKEZ.uninvoiced, 3603);
  assert.equal(s.zones.RAKDAO.renewalCount, 2);
  assert.equal(s.zones.OTHER.commission, 5020);
  assert.equal(d.summary.find(x => x.month === '2026-08').hasReport, false);
});

test('renewals link to tracker/GP renewals', () => {
  const d = dashboard(), st = n => d.renewals.find(r => r.company === n)?.state;
  assert.equal(st('Hocevar Ventures FZ-LLC'), 'Completed');
  assert.equal(st('Lince LTD'), 'Overdue');
  assert.equal(st('Shopzen FZ-LLC'), 'Not started');
  assert.equal(st('Relentless Enterprise L.L.C-FZ'), 'In progress');
  assert.equal(d.renewalCounts.Closed, 1);
});

test('exceptions and collections mirror the tracker', () => {
  const d = dashboard(), kinds = d.exceptions.map(e => e.kind);
  for (const k of ['Commission missed', 'Pending invoice (client)', 'Pending GP (on tracker, not on GP report)', 'On GP report, not on commission tracker',
    'Commission differs: tracker vs GP report', 'Commission not yet invoiced', 'Commission invoice unpaid > 30 days', 'Zoho commission invoice not in tracker',
    'Paid in Zoho, open on tracker', 'Renewal overdue, not started']) assert.ok(kinds.includes(k), k);
  assert.ok(!d.exceptions.some(e => /Lisenko/.test(e.detail)));                  // tracker says no commission
  assert.equal(d.kpis.toCollect, 3780 + 33925.82 + 5638.5);
  assert.equal(d.kpis.toCollectSource, 'Invoice Checklist');
  assert.equal(d.commissionInvoices.find(c => c.number === 'INV-RAKDAO-082026').zoho.balance, 0);
});

test('without the tracker, Zoho or Gmail the dashboard still builds from the GP report', () => {
  const d = dashboard({ tracker: null, clientInvoices: null, zoneInvoices: null });
  assert.equal(d.kpis.toCollect, null);
  assert.equal(d.summary.find(x => x.month === '2026-09').baseline, 'GP report');
  assert.equal(d.work.find(w => w.name === 'Redacted Group LLC FZ').status, 'Completed');
  assert.equal(d.work.find(w => w.name === 'DUCA ELENA SELASIG PROCREDIT S R L').status, 'Pending invoice');
  assert.equal(d.work.find(w => w.name === 'Yevgeni Lisenko').status, 'No commission');
});
