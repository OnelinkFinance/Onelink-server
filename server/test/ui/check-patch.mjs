// UI patch checks: all rules hit, the patched Component class parses, and every {{ binding }} root in the
// markup is returned by renderVals(). Usage: node test/ui/check-patch.mjs [outDir]
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-'));
const { patchPage } = await import(path.join(root, 'client-workflow.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const r = patchPage(html);
console.log('rules:', r.hit, '/', r.total, r.missed || '');
if (r.hit !== r.total) process.exit(1);
const open = '<script type="__bundler/template">', a = r.html.indexOf(open) + open.length, b = r.html.indexOf('</script>', a);
const tpl = JSON.parse(r.html.slice(a, b));
fs.writeFileSync(path.join(out, 'patched-template.html'), tpl);
const sOpen = tpl.indexOf('<script type="text/x-dc"'), sBody = tpl.indexOf('>', sOpen) + 1, sEnd = tpl.indexOf('</script>', sBody);
const src = tpl.slice(sBody, sEnd);
const mjs = path.join(out, 'component.mjs');
fs.writeFileSync(mjs, 'class DCLogic { constructor(p) { this.props = p || {}; } setState() {} }\nconst React = { createRef: () => ({ current: null }) };\n' + src + '\nexport default Component;\n');
execFileSync(process.execPath, ['--check', mjs], { stdio: 'inherit' });
console.log('node --check component: OK');
// binding roots used in the markup vs keys returned by renderVals
const markup = tpl.slice(0, sOpen);
const loopVars = new Set([...markup.matchAll(/as="(\w+)"/g)].map(m => m[1]));
const roots = new Set([...markup.matchAll(/\{\{\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]).filter(n => !loopVars.has(n) && !['true', 'false'].includes(n)));
const ret = src.slice(src.lastIndexOf('    return {\n      userKey: s.userKey'));
const keys = new Set([...ret.matchAll(/^ {6}([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]).concat([...ret.matchAll(/(?:^ {6}|, )([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1])));
const missing = [...roots].filter(n => !keys.has(n));
console.log('markup binding roots:', roots.size, 'missing from renderVals:', missing.length ? missing.join(', ') : 'none');
if (missing.length) process.exit(1);
console.log('out:', out);
