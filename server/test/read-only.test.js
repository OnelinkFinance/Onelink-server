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
  assert.ok(!/\bfetch\(/.test(code), 'commissions.js must go through the GET-only books() helper, not fetch');
});

test('the Zoho Books helper it uses is GET-only', () => {
  const s = src('server.js'), start = s.indexOf('async function books('), body = s.slice(start, s.indexOf('\n}\n', start));
  assert.ok(start > 0);
  assert.ok(!/method\s*:|body\s*:/.test(body), 'books() must not send a method or body');
});

test('commissions-core.js does no I/O', () => {
  const code = src('commissions-core.js');
  assert.ok(!/\bimport\b|\bfetch\(|require\(/.test(code.replace(/\/\/.*$/gm, '')));
});
