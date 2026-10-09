// Guard: the commission dashboard must never write to any source (sheets, Drive, Zoho Books, Gmail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('commissions.js only uses read-only Google scopes', () => {
  const scopes = [...src('commissions.js').matchAll(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g)].map(m => m[0]);
  assert.ok(scopes.length >= 3);
  for (const s of scopes) assert.match(s, /\.readonly$/, s);
});

test('commissions.js makes no write calls', () => {
  const code = src('commissions.js').replace(/\/\/.*$/gm, '');
  for (const w of ['.update(', '.append(', '.batchUpdate(', '.create(', '.delete(', '.insert(', '.send(', '.modify(', '.trash(', '.copy(', '.patch(', 'method:', 'body:'])
    assert.ok(!code.includes(w), `write-like call "${w}" found in commissions.js`);
  const fetches = [...code.matchAll(/\bfetch\(/g)];
  assert.ok(fetches.length <= 1, 'only the Apps Script bridge may call fetch (GET) directly');
});

test('Zoho Analytics is only queried with SELECT', () => {
  const code = src('commissions.js');
  const sql = [...code.matchAll(/analytics\(`([^`]*)`/g)].map(m => m[1].trim());
  assert.ok(sql.length >= 2);
  for (const q of sql) assert.match(q, /^select\s/i, q.slice(0, 60));

});

test('the Apps Script bridge asks Google only for read-only scopes', () => {
  const m = JSON.parse(src('apps-script/appsscript.json'));
  assert.ok(m.oauthScopes.length >= 2);
  for (const sc of m.oauthScopes) assert.match(sc, /\.readonly$/, sc);
  const gs = src('apps-script/Code.gs').replace(/\/\/.*$/gm, '');
  for (const w of ['setValue', 'setValues', 'appendRow', 'insert', 'delete', 'clear', 'createFile', 'setContent', 'UrlFetchApp', 'GmailApp', 'MailApp'])
    assert.ok(!gs.includes(w), `${w} in Code.gs`);
  assert.match(gs, /const KEY = 'PASTE-/, 'the committed script must not contain a real key');
});

const fn = (file, name) => { const s = src(file), start = s.indexOf(name); assert.ok(start >= 0, name + ' not found'); return s.slice(start, s.indexOf('\n}\n', start)); };

test('the dashboard service only reads Zoho and Upstash', () => {
  for (const name of ['async function books(', 'async function analyticsSql(', 'async function kvGet('])
    assert.ok(!/method\s*:|body\s*:/.test(fn('commissions-server.js', name)), name + ' must only GET');
  const code = src('commissions-server.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\/set\/|'SET'|"SET"|writeFile|appendFile/.test(code), 'no writes to Upstash or disk');
  const raw = src('commissions-server.js');
  assert.equal((raw.match(/method:/g) || []).length, 1, 'the only non-GET call is the Zoho OAuth token refresh');
  assert.match(raw, /fetch\(`https:\/\/accounts\.zoho\.\$\{dc\(\)\}\/oauth\/v2\/token\?\$\{q\}`, \{ method: 'POST'/);
});

test('the funding platform server does not load the dashboard', () => {
  assert.ok(!/commissions/i.test(src('server.js')), 'server.js must stay independent of the commission dashboard');
});

test('commissions-core.js does no I/O', () => {
  const code = src('commissions-core.js');
  assert.ok(!/\bimport\b|\bfetch\(|require\(/.test(code.replace(/\/\/.*$/gm, '')));
});
