// The GP report Apps Script (apps-script/gp-sheet/Code.gs): its pure parts, run in a VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../apps-script/gp-sheet/Code.gs', import.meta.url), 'utf8');
const gs = vm.createContext({});
vm.runInContext(code, gs);

// The October 2026 GP report Summary: table rows 8–73, totals on row 74, Payment Status in AM.
const ctx = {
  start: 8, end: 73, status: 'AM', payment: ['AG', 'AH'],
  money: ['N', 'O', 'P', 'Q', 'R', 'S', 'U', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH']
};
const paid = c => `SUMIFS(${c}8:${c}73,$AM$8:$AM$73,"Paid")`;

test('GP totals count fully paid rows only', () => {
  const cases = [
    ['D', '=SUM(N8:N71)', `=${paid('N')}`],                                   // Total Revenue
    ['D', '=SUM(P8:P73)+SUM(AH8:AH73)', `=${paid('P')}+${paid('AH')}`],        // Accrued Income
    ['X', '=SUM(X8:X68)', `=${paid('X')}`],                                   // uneven ranges become the whole table
    ['N', '=SUM(N8:N68)', `=${paid('N')}`],
    ['AG', '=SUM(AG8:AG68)', '=SUM(AG8:AG73)'],                               // Payment Received total: every row
    ['AH', '=SUM(AH8:AH68)', '=SUM(AH8:AH73)'],                               // Pending Payment total: every row
    ['D', '=AG74', '=AG74'],                                                  // Total Expenses = the totals row
    ['D', '=SUM(D1,-D2)+P74', '=SUM(D1,-D2)+P74'],                            // Final GP
    ['AG', '=SUM(W74:AF74)', '=SUM(W74:AF74)'],                               // not the table
    ['V', '=SUM(V8:V44)/100', '=SUM(V8:V44)/100'],                            // GP vs Revenue is a ratio
    ['V', '=U3/N3', '=U3/N3'],
    ['T', '=SUMPRODUCT(N8:N70)', '=SUMPRODUCT(N8:N70)'],
    ['D', '=SUMIFS(N8:N71,F8:F71,"Self")', '=SUMIFS(N8:N71,F8:F71,"Self")']    // someone else's SUMIFS
  ];
  for (const [col, before, after] of cases) assert.equal(gs.paidOnly_(before, col, ctx), after, before);
});

test('running set-up again only refreshes the row range', () => {
  const once = gs.paidOnly_('=SUM(N8:N71)', 'D', ctx);
  assert.equal(gs.paidOnly_(once, 'D', ctx), once);
  assert.equal(gs.paidOnly_(once, 'D', { ...ctx, end: 80 }), '=SUMIFS(N8:N80,$AM$8:$AM$80,"Paid")');
  assert.equal(gs.paidOnly_('=SUM(AG8:AG73)', 'AG', { ...ctx, end: 80 }), '=SUM(AG8:AG80)');
});

test('Payment Status is Paid only when Payment Received equals Revenue to the cent', () => {
  const L = { start: 8, end: 73, revenue: 14, received: 33 };
  assert.equal(gs.statusFormula_(L),
    '={"Payment Status";ARRAYFORMULA(IF(N8:N73="",,IF(IFERROR(ROUND(AG8:AG73,2)=ROUND(N8:N73,2),FALSE),"Paid","Pending")))}');
});

test('paid rows stay in the main table, pending rows go under the PENDING PAYMENTS line', () => {
  const r = (i, sNo, status, extra = {}) => ({ i, sNo, status, separator: false, empty: false, ...extra });
  const rows = [
    r(0, 1, 'Paid'),
    r(1, 7, 'Pending'),                            // partly paid → pending section
    r(2, 3, 'Paid'),
    r(3, 42, 'Paid'), r(4, 41, 'Paid'),            // main table in S.No order
    r(5, '', ''),                                  // being typed in, no Revenue yet → stays in the main table
    r(6, '', '', { empty: true }),
    r(7, '', '', { separator: true }),
    r(8, 45, 'Pending'),
    r(9, 2, 'Paid'),                               // paid in full → back into the main table
    r(10, '', '', { empty: true })
  ];
  assert.deepEqual(Array.from(gs.arrangeOrder_(rows), x => x.i), [0, 9, 2, 4, 3, 5, 6, 10, 7, 1, 8]);
  const settled = gs.arrangeOrder_(rows).map((x, k) => ({ ...x, i: k }));
  assert.deepEqual(Array.from(gs.arrangeOrder_(settled), x => x.i), settled.map(x => x.i), 'a second pass moves nothing');
});

test('Zoho Books links match the ones already in the GP report', () => {
  const links = gs.zohoLinks_({ invoice_id: '7050654000009746046', customer_id: '7050654000009422017' }, '898300452', 'com');
  assert.equal(links.invoice, 'https://books.zoho.com/app/898300452#/invoices/7050654000009746046');
  assert.equal(links.contact, 'https://books.zoho.com/app/898300452#/contacts/7050654000009422017');
});

test('column letters', () => {
  assert.deepEqual([1, 26, 27, 37, 39, 52, 703].map(gs.col_), ['A', 'Z', 'AA', 'AK', 'AM', 'AZ', 'AAA']);
});

test('the script only reads Zoho Books and only fetches Zoho', () => {
  const plain = code.replace(/(^|\s)\/\/.*$/gm, '$1');   // comments, not the // in URLs
  const fetches = [...plain.matchAll(/UrlFetchApp\.fetch\(`([^`]*)`/g)].map(m => m[1]);
  assert.equal(fetches.length, 2);
  assert.ok(fetches.every(u => /^https:\/\/(www\.zohoapis|accounts\.zoho)\.\$\{p\.dc\}\//.test(u)), fetches.join(' '));
  assert.equal((plain.match(/method:/g) || []).length, 1, 'the only POST is the Zoho OAuth token call');
  assert.match(plain, /accounts\.zoho\.\$\{p\.dc\}\/oauth\/v2\/token\?\$\{q\}`, \{ method: 'post'/);
  const manifest = JSON.parse(fs.readFileSync(new URL('../apps-script/gp-sheet/appsscript.json', import.meta.url), 'utf8'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.currentonly'));
  assert.ok(!manifest.oauthScopes.some(s => /\/drive|\/spreadsheets$|gmail|mail/.test(s)), 'no access beyond the sheet it is bound to');
});
