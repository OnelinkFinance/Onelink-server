// Behavioural smoke test for the upgrade patch rules: runs the patched Component class in Node with a fake
// state and a stubbed this.api, then checks that every binding added to the markup resolves in renderVals().
// Usage: node test/ui/smoke.mjs   (run check-patch.mjs first; it writes component.mjs + patched-template.html)
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-'));
execFileSync(process.execPath, [path.join(here, 'check-patch.mjs'), out], { stdio: 'inherit' });
const tpl = fs.readFileSync(path.join(out, 'patched-template.html'), 'utf8');
const Component = (await import(path.join(out, 'component.mjs'))).default;

// ── harness ──
let calls = [], replies = {};
function make(userKey) {
  const c = new Component({});
  c.setState = function (u) { const p = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, p); };
  c.api = (p, o) => { calls.push({ path: p, body: o && o.body }); const r = replies[p] || { ok: true, status: 200, json: { ok: true } }; return Promise.resolve(typeof r === 'function' ? r(o && o.body) : r); };
  c.flash = function (t, undo) { this.lastFlash = t; this.lastUndo = undo || null; };
  c.logAudit = () => {};
  c._token = 't';
  const accts = c.state.accounts.concat([
    { key: 'ahmed', name: 'Ahmed', username: 'ahmed@x', dept: 'MANAGEMENT', role: 'MANAGEMENT', active: true, perms: c.defaultPerms('MANAGEMENT'), title: 'General Manager' },
    { key: 'eduard', name: 'Eduard', username: 'eduard@x', dept: 'MANAGEMENT', role: 'MANAGEMENT', active: true, perms: c.defaultPerms('MANAGEMENT'), title: 'Chief Legal Officer' }
  ]).map(a => a.key === 'adnan' ? Object.assign({}, a, { title: 'CFO' }) : a.key === 'amina' ? Object.assign({}, a, { opsMaster: true }) : a);
  c.setState({ accounts: accts, userKey: userKey, authed: true });
  return c;
}
const tick = () => new Promise(r => setTimeout(r, 0));
const finance = ok => ({
  id: 'FV-1A2B3C4D', atText: '07 Oct · 14:05', amount: 12520, ok: ok, source: 'Zoho Books + Zoho Analytics',
  checks: [
    { key: 'CFD', label: 'Customer Fund Disbursement account', ok: ok, message: ok ? 'Enough in the account' : 'Client does not have sufficient balance', items: [{ label: 'Balance', ok: ok, text: ok ? 'covers' : 'short' }], detail: 'AED 3,000 against AED 12,520' },
    { key: 'COGS', label: 'Cost of Goods Sold account', ok: true, message: 'Fine', items: [] },
    { key: 'INVOICES', label: 'Invoice payment verification', ok: true, message: 'Paid', items: [{ label: 'INV-1', ok: true, text: 'paid' }] }
  ]
});
const escReq = (status, extra) => Object.assign({
  id: 'FR-900', by: 'maram', company: 'Kenenia LTD', person: 'Kenenia LTD', purpose: 'Licence renewal', zone: 'IFZA', requested: 12520,
  approved: null, credited: 0, status: status, date: '7 Oct', paid: 'No — not yet', notes: '', docs: [], timeline: [{ at: '07 Oct · 14:05', text: 'Maram escalated' }],
  finance: finance(false),
  escalation: {
    id: 'ESC-1A2B3C', atText: '07 Oct · 14:06', by: 'maram', byName: 'Maram', justification: 'Client paid in cash today, receipt follows.',
    failed: [{ key: 'CFD', label: 'Customer Fund Disbursement account', message: 'Client does not have sufficient balance' }],
    to: [{ key: 'adnan', name: 'Adnan', title: 'CFO' }, { key: 'ahmed', name: 'Ahmed', title: 'General Manager' }, { key: 'eduard', name: 'Eduard', title: 'Chief Legal Officer' }],
    decision: null, log: [{ atText: '07 Oct · 14:06', who: 'maram', whoName: 'Maram', action: 'CREATED', note: '' }]
  }
}, extra || {});

// ── binding resolution: every {{ path }} added by the patch must resolve to something defined ──
const orig = JSON.parse(fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/)[1]);
const markupOf = t => t.slice(0, t.indexOf('<script type="text/x-dc"'));
const bindRe = /\{\{\s*([A-Za-z_$][\w$.]*)\s*\}\}/g;
// baseline = bindings already present before this upgrade (the committed client-workflow.js), so only new ones are checked
const basePath = path.join(out, 'client-workflow.base.mjs');
let baseTpl = orig;
try {
  fs.writeFileSync(basePath, execFileSync('git', ['show', 'HEAD:server/client-workflow.js'], { cwd: root, encoding: 'utf8' }));
  const base = await import(basePath), r0 = base.applyTemplateRules(orig);
  if (r0.hit === r0.total) baseTpl = r0.text;
} catch (e) { console.log('(no git baseline — checking every binding added since the export)'); }
const origBindings = new Set([...markupOf(baseTpl).matchAll(bindRe)].map(m => m[1]));
function resolveAll(markup, vm, seen) {
  // walk tags, keeping a stack of sc-for scopes (loop var → first item of its list)
  const stack = [{}];
  const get = (p, scope) => { const [h, ...rest] = p.split('.'); let v = h in scope ? scope[h] : vm[h]; for (const k of rest) { if (v == null) return undefined; v = v[k]; } return v; };
  const scopeNow = () => Object.assign({}, ...stack);
  const re = /<(\/?)(sc-for)\b([^>]*)>|\{\{\s*([A-Za-z_$][\w$.]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(markup))) {
    if (m[2]) {
      if (m[1]) { stack.pop(); continue; }
      const list = (m[3].match(/list="\{\{\s*([\w$.]+)\s*\}\}"/) || [])[1], as = (m[3].match(/as="(\w+)"/) || [])[1];
      const arr = get(list, scopeNow());
      stack.push({ [as]: Array.isArray(arr) && arr.length ? arr[0] : undefined, ['__empty_' + as]: !(Array.isArray(arr) && arr.length) });
      continue;
    }
    const p = m[4], sc = scopeNow(), head = p.split('.')[0];
    if (origBindings.has(p)) continue;
    if (sc['__empty_' + head]) { if (!seen.has(p)) seen.set(p, 'empty-list'); continue; }
    const v = get(p, sc);
    if (v !== undefined) seen.set(p, 'ok'); else if (!seen.has(p)) seen.set(p, 'undefined');
  }
}

// ── scenario 1: Sven, request page of a MGMT_APPROVED request, peek open, chase modal, reset pane, failed form ──
const seen = new Map();
{
  const c = make('sven');
  const r = escReq('MGMT_APPROVED');
  r.escalation.decision = { action: 'APPROVE', by: 'adnan', byName: 'Adnan', title: 'CFO', atText: '07 Oct · 15:00', note: 'Go ahead' };
  r.escalation.log.push({ atText: '07 Oct · 15:00', who: 'adnan', whoName: 'Adnan', action: 'APPROVE', note: 'Go ahead' });
  c.setState({ requests: [r].concat(c.state.requests), reqId: 'FR-900', route: 'detail', peekId: 'FR-900', masterTab: 'reset', notifOpen: true });
  c.setState({ gate: { name: 'Kenenia LTD', status: 'ok', token: 'vt', clientId: 'c1' }, form: Object.assign(c.blankForm(), { company: 'Kenenia LTD', purpose: 'Renewal', amount: '12520', paid: 'No — not yet' }), formDocs: [] });
  c.setState({ finFail: { failed: r.escalation.failed, finance: finance(false), token: 'esc-tok', allowed: true, error: 'Client does not have sufficient balance to request funds. Please contact Sven.', clientName: 'Kenenia LTD', amount: 12520, open: true, justification: 'short', sendError: 'Write at least 15 characters so management can decide.' } });
  c.setState({ reset: { data: { ok: true, live: [{ id: 'FR-900', company: 'Kenenia LTD', by: 'maram', byName: 'Maram', status: 'ESCALATED', requested: 12520, date: '7 Oct' }], history: { requests: 268 }, notifications: 40, audit: 120, chat: 300, backups: [{ id: 'BK-1', atText: '06 Oct · 10:00', by: 'Sven', reason: 'test', counts: { requests: 3, chat: 2, notifications: 9, audit: 4 } }] }, sel: { 'FR-900': true }, clearNotifs: true, includeHistory: true, reason: 'x', confirm: 'RESET', result: { ok: true, backupId: 'BK-2', removed: { requests: 1, chat: 0, notifications: 3, audit: 2 }, kept: { requests: 268, chat: 300, notifications: 0, audit: 118 } } } });
  c.openModal('chase', 'FR-900');
  c.setState({ modal: Object.assign({}, c.state.modal, { files: [{ key: 'k1', name: 'inv.pdf', size: 2048, type: 'Invoice', status: 'done', fileId: 'F1' }] }) });
  const vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  // spot checks
  assert.equal(vm.detail.st.label, 'Management Approved – Proceed');
  assert.equal(vm.detail.actLabel, 'Final approval');
  assert.equal(vm.detail.fin.chip, '1 of 3 checks failed');
  assert.equal(vm.detail.fin.checks[0].detail, 'AED 3,000 against AED 12,520');
  assert.match(vm.detail.esc.decisionLine, /^Approved & proceed — Mr\. Adnan \(CFO\)/);
  assert.equal(vm.detail.esc.to, 'Mr. Adnan (CFO) · Mr. Ahmed (General Manager) · Mr. Eduard (Chief Legal Officer)');
  assert.equal(vm.detail.canVoid, true);
  assert.equal(vm.detail.canChase, true);
  assert.equal(vm.detail.showDecide, true, 'decisions on MGMT_APPROVED for Sven');
  assert.equal(vm.peek.approveLabel, 'Final approval');
  assert.equal(vm.peek.canDecide, true);
  assert.ok(vm.peek.facts.some(f => f.label === 'Financial checks' && f.value === '1 of 3 failed'));
  assert.ok(vm.peek.facts.some(f => f.label === 'Escalation' && /Approved by Mr\. Adnan \(CFO\)/.test(f.value)));
  assert.equal(vm.finFail.show, true);
  assert.equal(vm.master.m_reset, true);
  assert.equal(vm.master.reset.historyLabel, 'Also remove the March–September history (268 requests)');
  assert.equal(vm.master.reset.disabled, false);
  assert.ok(vm.master.nav.some(n => n.label === 'Platform reset' && n.icon === 'ph ph-broom'));
  assert.equal(vm.modal.files.length, 1);
  assert.equal(vm.modal.confirmText, 'Send chase');
  const st = vm.sections; // tab 'tasks' for Sven
  c.setState({ tab: 'tasks' });
  assert.ok(c.renderVals().sections.some(sc => sc.title === 'Final approval — management approved'));
  for (const k of ['NEW', 'ACTION', 'APPROVED', 'CREDITED', 'PAID', 'DECLINED', 'ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED', 'VOID']) assert.notEqual(c.statusMeta(k).label, '—', k);
  assert.equal(c.statusMeta('NEW').label, 'Pending Sven Approval');
  assert.equal(JSON.stringify(c.zohoDirectory()), '[]');
  assert.deepEqual(c.zohoLookup('CCXT LTD'), { missing: true, available: 0, allocated: 0, used: 0 });
  void st;
}

// ── scenario 2: Adnan (management), ESCALATED request: decide buttons, modal flow merges item without echo ──
{
  const c = make('adnan');
  const r = escReq('ESCALATED');
  c.setState({ requests: [r].concat(c.state.requests), reqId: 'FR-900', route: 'detail', peekId: 'FR-900' });
  c._sync = { requests: c.state.requests };
  let vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  assert.equal(vm.detail.esc.canDecide, true);
  assert.equal(vm.detail.esc.decisionLine, 'Waiting for a management decision');
  assert.equal(vm.peek.mgmtDecide, true);
  assert.equal(vm.detail.showDecide, false, 'management: no Sven decisions on ESCALATED');
  assert.equal(vm.peek.canDecide, false);
  assert.equal(vm.detail.canVoid, true);
  c.setState({ route: 'board', tab: 'tasks' });
  vm = c.renderVals();
  const row = vm.sections.flatMap(sc => sc.rows).find(x => x.num === 'FR-900');
  assert.equal(row.actLabel, 'Decide escalation');
  assert.equal(vm.sections[0].title, 'Your decision — escalated to management');
  // approve via modal
  c.openModal('mgmtApprove', 'FR-900');
  c.setState({ modal: Object.assign({}, c.state.modal, { value: 'ok' }) });
  c.confirmModal();
  assert.equal(c.state.modal.error, 'Write a short note — at least 3 characters.');
  const item = Object.assign({}, r, { status: 'MGMT_APPROVED', escalation: Object.assign({}, r.escalation, { decision: { action: 'APPROVE', by: 'adnan', byName: 'Adnan', title: 'CFO', atText: 'now', note: 'Approved, paid by transfer' } }) });
  replies['/api/requests/FR-900/escalation'] = { ok: true, status: 200, json: { ok: true, item: item } };
  c.setState({ modal: Object.assign({}, c.state.modal, { value: 'Approved, paid by transfer', error: '' }) });
  c.confirmModal();
  assert.equal(c.state.modal.busy, true);
  c.confirmModal(); // double click ignored
  await tick(); await tick();
  assert.equal(calls.filter(x => x.path === '/api/requests/FR-900/escalation').length, 1);
  assert.deepEqual(calls.at(-1).body, { action: 'APPROVE', note: 'Approved, paid by transfer' });
  assert.equal(c.state.modal, null);
  assert.equal(c.reqById('FR-900').status, 'MGMT_APPROVED');
  assert.equal(c._sync.requests, c.state.requests, '_sync kept in step — livePush will not echo');
  // management does not get Sven's final approval
  vm = c.renderVals();
  assert.equal(vm.sections.flatMap(sc => sc.rows).find(x => x.num === 'FR-900').actNote, 'With Sven');
  // void with the server refusing
  replies['/api/requests/FR-900/void'] = { ok: false, status: 409, json: { ok: false, error: 'Locked' } };
  c.openModal('void', 'FR-900');
  c.setState({ modal: Object.assign({}, c.state.modal, { value: 'dup' }) });
  c.confirmModal();
  assert.equal(c.state.modal.error, 'Give a reason — at least 5 characters.');
  c.setState({ modal: Object.assign({}, c.state.modal, { value: 'Duplicate request', error: '' }) });
  c.confirmModal(); await tick(); await tick();
  assert.equal(c.state.modal.error, 'Locked');
  assert.equal(c.state.modal.busy, false);
}

// ── scenario 3: Maram (restricted Operations), MGMT_INFO: reply, no detail text, no void; then VOID locks the page ──
{
  const c = make('maram');
  const r = escReq('MGMT_INFO');
  delete r.finance.checks[0].detail; // the server strips it for Operations
  r.finance.checks[0].detail = 'should never show';
  r.escalation.decision = { action: 'INFO', by: 'ahmed', byName: 'Ahmed', title: 'General Manager', atText: '07 Oct · 16:00', note: 'Send the bank slip' };
  c.setState({ requests: [r].concat(c.state.requests), reqId: 'FR-900', route: 'detail', peekId: 'FR-900' });
  let vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  assert.equal(vm.detail.fin.checks[0].hasDetail, false, 'restricted Operations never see check detail');
  assert.equal(vm.detail.esc.canReply, true);
  assert.equal(vm.detail.esc.canDecide, false);
  assert.equal(vm.detail.canVoid, false);
  assert.equal(vm.peek.canVoid, false);
  assert.equal(vm.peek.canReply, true);
  assert.match(vm.detail.esc.decisionLine, /^More information requested — Mr\. Ahmed \(General Manager\)/);
  c.setState({ route: 'board', tab: 'tasks' });
  vm = c.renderVals();
  assert.equal(vm.sections.flatMap(sc => sc.rows).find(x => x.num === 'FR-900').actLabel, 'Reply to management');
  // voided
  const v = Object.assign({}, r, { status: 'VOID', voided: { by: 'sven', byName: 'Sven', atText: '08 Oct · 09:00', reason: 'Duplicate', prevStatus: 'MGMT_INFO' } });
  c.setState({ requests: c.state.requests.map(x => x.id === 'FR-900' ? v : x), route: 'detail' });
  vm = c.renderVals();
  assert.equal(vm.detail.locked, true);
  assert.equal(vm.detail.editable, false);
  assert.equal(vm.detail.canChase, false);
  assert.equal(vm.detail.voidLine, 'Voided by Sven on 08 Oct · 09:00 — Duplicate');
  assert.equal(vm.detail.nextText, 'Voided. This request is locked — nothing can be changed.');
  assert.equal(vm.detail.esc.decisionLine, 'Closed — voided before a management decision');
  assert.equal(vm.detail.esc.hasNote, false);
  assert.ok(vm.peek.facts.some(f => f.label === 'Escalation' && f.value === 'Closed — voided before a management decision · ESC-1A2B3C'));
  // voided while ESCALATED (no decision yet)
  const v2 = Object.assign({}, v, { escalation: Object.assign({}, r.escalation, { decision: null }), voided: Object.assign({}, v.voided, { prevStatus: 'ESCALATED' }) });
  c.setState({ requests: c.state.requests.map(x => x.id === 'FR-900' ? v2 : x) });
  vm = c.renderVals();
  assert.equal(vm.detail.esc.decisionLine, 'Closed — voided before a management decision');
  assert.ok(!/Waiting for/.test(c.escSummary(v2)), c.escSummary(v2));
  c.setState({ route: 'board', tab: 'done' });
  assert.ok(c.renderVals().sections.some(sc => sc.title === 'Voided'));
  c.openModal('chase', 'FR-900');
  assert.equal(c.state.modal, null, 'no modal on a voided request');
}

// ── scenario 4: form — precheck fails, escalate, form resets and opens the new request ──
{
  const c = make('maram');
  c.setState({ route: 'new', gate: { name: 'Kenenia LTD', status: 'ok', token: 'vt', clientId: 'c1' }, form: Object.assign(c.blankForm(), { company: 'Kenenia LTD', purpose: 'Renewal', amount: '12520', paid: 'No — not yet', date: '2026-10-07' }), formDocs: [{ key: 'f1', name: 'inv.pdf', size: 10, type: 'Invoice', status: 'done', fileId: 'F9' }] });
  const realFetch = globalThis.fetch;
  let preBody = null;
  globalThis.fetch = (u, o) => { preBody = JSON.parse(o.body); return Promise.resolve({ status: 422, json: () => Promise.resolve({ ok: false, reason: 'FINANCIAL_CHECKS_FAILED', error: 'Client does not have sufficient balance to request funds. Please contact Sven.', failed: [{ key: 'CFD', label: 'Customer Fund Disbursement account', message: 'Not enough' }], finance: finance(false), escalate: { allowed: true, token: 'esc-tok' } }) }); };
  c.send(true);
  await tick(); await tick(); await tick();
  globalThis.fetch = realFetch;
  assert.equal(preBody.paid, 'No — not yet', 'precheck sends paid');
  assert.equal(c.state.errors.summary, null, 'the failed-checks panel carries the message, not the summary box');
  assert.equal(c.state.finFail.error, 'Client does not have sufficient balance to request funds. Please contact Sven.');
  let vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  assert.equal(vm.finFail.show, true);
  assert.equal(vm.finFail.canStart, true);
  assert.equal(vm.finFail.rows[0].label, 'Customer Fund Disbursement account');
  vm.finFail.start();
  vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  assert.equal(vm.finFail.open, true);
  vm.finFail.onJustification({ target: { value: 'too short' } });
  c.sendEscalation();
  assert.equal(c.state.finFail.sendError, 'Write at least 15 characters so management can decide.');
  c.setFinFail({ justification: 'Client paid in cash today, receipt follows Monday.' });
  const item = escReq('ESCALATED', { id: 'FR-901' });
  replies['/api/requests/escalate'] = { ok: true, status: 200, json: { ok: true, id: 'FR-901', item: item } };
  c._sync = { requests: c.state.requests };
  c.sendEscalation();
  await tick(); await tick();
  const body = calls.filter(x => x.path === '/api/requests/escalate').at(-1).body;
  assert.equal(body.escalateToken, 'esc-tok');
  assert.equal(body.request.requested, 12520);
  assert.equal(body.request.person, 'Kenenia LTD');
  assert.equal(body.request.date, '7 Oct');
  assert.deepEqual(body.request.docs, [{ name: 'inv.pdf', type: 'Invoice', size: 10, fileId: 'F9' }]);
  assert.equal(c.state.route, 'detail');
  assert.equal(c.state.reqId, 'FR-901');
  assert.equal(c.state.form, null);
  assert.equal(c.state.finFail, null);
  assert.equal(c.state.gate.status, 'idle');
  assert.equal(c.lastFlash, 'Escalated to management — FR-901');
  assert.equal(c._sync.requests, c.state.requests);
  // amount change clears a stale result
  c.setState({ finFail: { clientName: 'x', amount: 1 } });
  c.setForm('amount', '5');
  assert.equal(c.state.finFail, null);
}

// ── scenario 5: Sven final approval with management override skips the Zoho gate; credit too ──
{
  const c = make('sven');
  const r = escReq('MGMT_APPROVED');
  r.escalation.decision = { action: 'APPROVE', by: 'adnan', byName: 'Adnan', title: 'CFO', atText: 'now', note: 'ok' };
  c.setState({ requests: [r].concat(c.state.requests) });
  let ran = 0; c.runZoho = () => { ran++; };
  c.approveFull('FR-900');
  assert.equal(ran, 0);
  assert.equal(c.reqById('FR-900').status, 'APPROVED');
  assert.match(c.reqById('FR-900').timeline.at(-1).text, /management override by Mr\. Adnan \(CFO\)$/);
  assert.equal(c.lastUndo, null, 'no Undo after the final approval of an overridden request');
  c.creditNow('FR-900');
  assert.equal(ran, 0);
  assert.equal(c.reqById('FR-900').status, 'CREDITED');
  assert.equal(typeof c.lastUndo, 'function', 'credit after a management approval keeps its Undo (status before was APPROVED)');
  // undoable() looks only at the status before the change
  for (const st of ['MGMT_APPROVED', 'ESCALATED', 'MGMT_INFO']) assert.equal(c.undoable(Object.assign({}, r, { status: st })), false, st);
  for (const st of ['NEW', 'ACTION', 'APPROVED', 'CREDITED']) assert.equal(c.undoable(Object.assign({}, r, { status: st })), true, st + ' (overridden escalation)');
  // without an override the gate still runs
  const plain = Object.assign({}, r, { id: 'FR-902', status: 'NEW', escalation: null });
  c.setState({ requests: [plain].concat(c.state.requests) });
  c.approveFull('FR-902');
  assert.equal(ran, 1);
  c.approveFull('FR-902', { ok: true, available: 50000, validationId: 'ZV-1' });
  assert.equal(c.reqById('FR-902').status, 'APPROVED');
  assert.equal(typeof c.lastUndo, 'function', 'a plain approval keeps its Undo');
  // reset: preview → run
  replies['/api/admin/reset/preview'] = { ok: true, status: 200, json: { ok: true, live: [{ id: 'FR-900', company: 'K', by: 'maram', status: 'CREDITED', requested: 1, date: '7 Oct' }, { id: 'FR-903', company: 'L', by: 'musa', status: 'NEW', requested: 2, date: '7 Oct' }], history: { requests: 268 }, notifications: 5, audit: 6, chat: 7, backups: [] } };
  c.liveLoad = () => Promise.resolve();
  c.loadReset(); await tick(); await tick();
  let vm = c.renderVals();
  assert.equal(vm.master.reset.selLine, '2 of 2 selected');
  assert.equal(vm.master.reset.disabled, true);
  vm.master.reset.rows[1].toggle();
  c.renderVals().master.reset.onReason({ target: { value: 'Test data' } });
  c.renderVals().master.reset.onConfirm({ target: { value: 'reset' } });
  vm = c.renderVals();
  assert.equal(vm.master.reset.disabled, false);
  replies['/api/admin/reset'] = { ok: true, status: 200, json: { ok: true, backupId: 'BK-9', removed: { requests: 1, chat: 0, notifications: 5, audit: 2 }, kept: { requests: 268, chat: 7, notifications: 0, audit: 4 } } };
  vm.master.reset.run(); await tick(); await tick();
  const rb = calls.filter(x => x.path === '/api/admin/reset').at(-1).body;
  assert.deepEqual(rb, { ids: ['FR-900'], includeHistory: false, clearNotifications: true, reason: 'Test data', confirm: 'RESET' });
  vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  assert.equal(vm.master.reset.resultLine, 'Backup BK-9 taken, then the reset ran.');
  // restore modal
  c.openModal('restore', 'BK-9');
  c.setState({ modal: Object.assign({}, c.state.modal, { value: 'nope' }) });
  c.confirmModal();
  assert.equal(c.state.modal.error, 'Type RESTORE to confirm.');
  c.setState({ modal: Object.assign({}, c.state.modal, { value: 'RESTORE', error: '' }) });
  c.confirmModal(); await tick(); await tick();
  assert.deepEqual(calls.filter(x => x.path === '/api/admin/reset/restore').at(-1).body, { backupId: 'BK-9', confirm: 'RESTORE' });
  assert.equal(c.state.modal, null);
}

// ── scenario 6: chase from Operations with an upload ──
{
  const c = make('wafaa');
  const r = escReq('CREDITED', { by: 'wafaa', escalation: null });
  c.setState({ requests: [r].concat(c.state.requests), reqId: 'FR-900' });
  c.uploadDoc = () => Promise.resolve('F77');
  c.openModal('chase', 'FR-900');
  c.takeFiles([{ name: 'receipt.pdf', size: 900 }], 'chase');
  assert.equal(c.renderVals().modal.confirmDisabled, true);
  await tick(); await tick();
  assert.equal(c.state.modal.files[0].status, 'done');
  replies['/api/requests/FR-900/chase'] = { ok: true, status: 200, json: { ok: true, item: Object.assign({}, r, { timeline: r.timeline.concat([{ at: 'now', text: 'chased' }]) }) } };
  c.confirmModal(); await tick(); await tick();
  assert.deepEqual(calls.filter(x => x.path === '/api/requests/FR-900/chase').at(-1).body, { note: '', docs: [{ name: 'receipt.pdf', type: 'Receipt', size: 900, fileId: 'F77' }] });
  assert.equal(c.lastFlash, 'Invoice chase sent to finance');
}

// ── scenario 7: management never gets Sven's decision buttons (NEW, ACTION, MGMT_APPROVED); info modal refused ──
{
  const c = make('adnan');
  const ovr = { action: 'APPROVE', by: 'ahmed', byName: 'Ahmed', title: 'General Manager', atText: 'now', note: 'ok' };
  const reqs = [
    escReq('NEW', { id: 'FR-910', escalation: null, finance: finance(true) }),
    escReq('ACTION', { id: 'FR-911', escalation: null, finance: finance(true) }),
    escReq('MGMT_APPROVED', { id: 'FR-912' })
  ];
  reqs[2].escalation.decision = ovr;
  c.setState({ requests: reqs.concat(c.state.requests), route: 'detail' });
  for (const r of reqs) {
    c.setState({ reqId: r.id, peekId: r.id });
    const vm = c.renderVals();
    resolveAll(markupOf(tpl), vm, seen);
    assert.equal(vm.detail.showDecide, false, 'management: no decisions on ' + r.status);
    assert.equal(vm.detail.decisions.length, 0, r.status);
    assert.equal(vm.peek.canDecide, false, 'management: no peek decisions on ' + r.status);
  }
  c.setState({ route: 'board', tab: 'tasks' });
  const rows = c.renderVals().sections.flatMap(sc => sc.rows);
  assert.notEqual(rows.find(x => x.num === 'FR-910').actLabel, 'Check and approve');
  assert.notEqual(rows.find(x => x.num === 'FR-912').actLabel, 'Final approval');
  for (const kind of ['info', 'decline', 'partial']) {
    c.openModal(kind, 'FR-910');
    c.setState({ modal: Object.assign({}, c.state.modal, { value: kind === 'partial' ? '100' : 'Please send the slip' }) });
    c.confirmModal();
    assert.equal(c.reqById('FR-910').status, 'NEW', 'management ' + kind + ' refused');
    assert.match(c.lastFlash, /needs the/);
    c.setState({ modal: null });
  }
  // Sven may still ask for information
  const s = make('sven');
  s.setState({ requests: [escReq('NEW', { id: 'FR-910', escalation: null })].concat(s.state.requests) });
  s.openModal('info', 'FR-910');
  s.setState({ modal: Object.assign({}, s.state.modal, { value: 'Send the estimate' }) });
  s.confirmModal();
  assert.equal(s.reqById('FR-910').status, 'ACTION');
}

// ── scenario 8: Sven's lower amount — override skips the balance; otherwise the balance gate stays ──
{
  const c = make('sven');
  const o = escReq('MGMT_APPROVED');
  o.escalation.decision = { action: 'APPROVE', by: 'adnan', byName: 'Adnan', title: 'CFO', atText: 'now', note: 'ok' };
  const plain = escReq('NEW', { id: 'FR-920', escalation: null });
  c.setState({ requests: [o, plain].concat(c.state.requests) });
  const partial = (id, val) => { c.openModal('partial', id); c.setState({ modal: Object.assign({}, c.state.modal, { value: val }) }); c.confirmModal(); };
  partial('FR-900', '20000');
  assert.equal(c.state.modal.error, 'Cannot approve more than the requested AED 12,520.'.replace('AED 12,520', c.fmt(12520)));
  partial('FR-900', '0');
  assert.equal(c.state.modal.error, 'Enter an amount.');
  partial('FR-900', '5000');
  assert.equal(c.reqById('FR-900').status, 'APPROVED');
  assert.equal(c.reqById('FR-900').approved, 5000);
  assert.match(c.reqById('FR-900').timeline.at(-1).text, /approved .* — management override by Mr\. Adnan \(CFO\)$/);
  // no override: the live server check decides, capped at the net balance (what can still be approved)
  let zc = 0, zReply = null;
  c.zohoCall = rr => { zc++; assert.equal(rr.id, 'FR-920'); return Promise.resolve(zReply); };
  zReply = { offline: true, why: 'TIMEOUT', ms: 8000 };
  partial('FR-920', '5000');
  assert.equal(c.state.modal.busy, true, 'busy while the live check runs');
  let mv = c.renderVals().modal;
  assert.equal(mv.confirmText, 'Checking the live balance…');
  assert.equal(mv.confirmDisabled, true);
  assert.equal(mv.cancelDisabled, true, 'Cancel disabled while busy');
  mv.cancel();
  assert.ok(c.state.modal, 'Cancel ignored while busy');
  c.confirmModal(); // double click ignored
  await tick(); await tick(); await tick();
  assert.equal(zc, 1);
  assert.match(c.state.modal.error, /^The live Zoho check could not complete \(Timed out/);
  assert.equal(c.state.modal.busy, false);
  assert.equal(c.reqById('FR-920').status, 'NEW');
  zReply = { live: true, status: 200, json: { ok: false, reason: 'INSUFFICIENT_BALANCE', availableBalance: 3000, notes: 'Client does not have sufficient balance for the full amount.', validationId: 'ZV-1' } };
  partial('FR-920', '5000'); await tick(); await tick(); await tick();
  assert.equal(c.state.modal.error, 'Client does not have sufficient balance for the full amount. — Approval cannot exceed what can still be approved for this client: ' + c.fmt(3000) + '.');
  assert.equal(c.reqById('FR-920').status, 'NEW');
  zReply = { live: true, status: 422, json: { ok: false, clientMatched: false, reason: 'CLIENT_NOT_FOUND', error: 'Client not found in Zoho Books. Cannot proceed.', notes: 'Client not found in Zoho Books. Cannot proceed.' } };
  partial('FR-920', '2500'); await tick(); await tick(); await tick();
  assert.equal(c.state.modal.error, 'Client not found in Zoho Books. Cannot proceed.', 'server notes are the error');
  zReply = { live: true, status: 409, json: { ok: false, reason: 'REQUEST_VOID', error: 'This request has been voided.' } };
  partial('FR-920', '2500'); await tick(); await tick(); await tick();
  assert.equal(c.state.modal.error, 'This request has been voided.');
  assert.equal(c.reqById('FR-920').status, 'NEW');
  // the old local zohoBalance no longer decides: the live net balance does
  c.setState({ requests: c.state.requests.map(x => x.id === 'FR-920' ? Object.assign({}, x, { zohoBalance: 99999 }) : x) });
  zReply = { live: true, status: 200, json: { ok: false, reason: 'INSUFFICIENT_BALANCE', availableBalance: 3000, notes: 'Short.', validationId: 'ZV-2' } };
  partial('FR-920', '4000'); await tick(); await tick(); await tick();
  assert.match(c.state.modal.error, /cannot exceed/);
  partial('FR-920', '2500'); await tick(); await tick(); await tick();
  assert.equal(c.state.modal, null);
  assert.equal(c.reqById('FR-920').status, 'APPROVED');
  assert.equal(c.reqById('FR-920').approved, 2500);
  assert.match(c.reqById('FR-920').timeline.at(-1).text, /approved .*2,500 of .* — live Zoho balance AED 3,000 available · ZV-2$/);
  assert.ok(!/override/.test(c.reqById('FR-920').timeline.at(-1).text));
  // the dialog replaced while the check runs: nothing approved, result reported with a flash
  const p2 = escReq('NEW', { id: 'FR-921', escalation: null });
  c.setState({ requests: [p2].concat(c.state.requests) });
  c.zohoCall = () => Promise.resolve({ live: true, status: 200, json: { ok: true, availableBalance: 50000, validationId: 'ZV-3' } });
  partial('FR-921', '1000');
  c.setState({ modal: null }); c.openModal('chase', 'FR-921');
  await tick(); await tick(); await tick();
  assert.equal(c.reqById('FR-921').status, 'NEW');
  assert.equal(c.state.modal.kind, 'chase');
  assert.match(c.lastFlash, /^Not approved — the dialog was closed/);
  c.setState({ modal: null });
  assert.equal(zc, 6, 'override path never calls the live check');
}

// ── scenario 9: CREDITED board action opens the chase modal; refused sync shows the server's reason and reloads; paid in the Zoho payload ──
{
  const c = make('sven');
  const r = escReq('CREDITED', { escalation: null, finance: finance(true) });
  c.setState({ requests: [r].concat(c.state.requests), route: 'board', tab: 'await' });
  const row = c.renderVals().sections.flatMap(sc => sc.rows).find(x => x.num === 'FR-900');
  assert.equal(row.actLabel, 'Chase invoice');
  row.act();
  assert.equal(c.state.modal && c.state.modal.kind, 'chase');
  c.setState({ route: 'detail', reqId: 'FR-900', modal: null });
  assert.equal(c.renderVals().detail.actLabel, 'Chase invoice');
  c.renderVals().detail.act();
  assert.equal(c.state.modal && c.state.modal.kind, 'chase');
  assert.equal(c.zohoPayload(r).paid, 'No — not yet');
  // livePush 403
  let loads = 0;
  c.isLive = () => true; c.liveLoad = () => { loads++; return Promise.resolve(); };
  c._sync = { requests: c.state.requests, chat: c.state.chat, notifications: c.state.notifications, audit: c.state.audit };
  replies['/api/sync/put'] = { ok: false, status: 403, json: { ok: false, error: 'Only Sven can change the status of this request.' } };
  c.setState({ requests: c.state.requests.map(x => x.id === 'FR-900' ? Object.assign({}, x, { status: 'PAID' }) : x) });
  c.livePush(); await tick(); await tick();
  assert.equal(c.lastFlash, 'Only Sven can change the status of this request.');
  assert.equal(loads, 1);
  // any other refusal of a request write (409, 503, 400) also shows the reason and reloads once
  const bump = (status, json) => {
    replies['/api/sync/put'] = { ok: false, status: status, json: json };
    c.setState({ requests: c.state.requests.map(x => x.id === 'FR-900' ? Object.assign({}, x, { notes: 'n' + status }) : x) });
    c.livePush();
    return tick().then(tick);
  };
  await bump(409, { ok: false, reason: 'REQUEST_PENDING', error: 'FR-1 is already open for this client — FR-900 cannot be re-opened.' });
  assert.equal(c.lastFlash, 'FR-1 is already open for this client — FR-900 cannot be re-opened.');
  assert.equal(loads, 2);
  await bump(503, {});
  assert.equal(c.lastFlash, 'The server refused that change — not permitted for your account');
  assert.equal(loads, 3);
  await bump(400, { ok: false, error: 'Bad request' });
  assert.equal(c.lastFlash, 'Bad request');
  assert.equal(loads, 4);
  // a rejected NEW request is handled by rejectRequest (no reload); 401 ends the session (no reload)
  const nr0 = escReq('NEW', { id: 'FR-931', escalation: null, finance: null });
  replies['/api/sync/put'] = { ok: false, status: 409, json: { ok: false, reject: true, error: 'Another request for this client landed first.' } };
  c.setState({ requests: [nr0].concat(c.state.requests) });
  c.livePush(); await tick(); await tick();
  assert.equal(c.lastFlash, 'Another request for this client landed first.');
  assert.equal(c.reqById('FR-931'), undefined);
  assert.equal(loads, 4);
  let ended = 0; c.endSession = () => { ended++; };
  await bump(401, { ok: false, error: 'Sign in' });
  assert.equal(ended, 1);
  assert.equal(loads, 4);
  // after the server stored a NEW request, its one-time submit pass is dropped in place (sent object and state copy)
  let sentPass = null;
  replies['/api/sync/put'] = b => { if (b.item.id === 'FR-930') sentPass = b.item.zohoSubmitToken; return { ok: true, status: 200, json: { ok: true, rev: 9, id: b.item.id } }; };
  const nr = Object.assign(escReq('NEW', { id: 'FR-930', escalation: null, finance: null }), { zohoSubmitToken: 'pass-1' });
  c.setState({ requests: [nr].concat(c.state.requests) });
  c.livePush();
  const sentItem = calls.filter(x => x.path === '/api/sync/put').at(-1).body.item;
  assert.equal(sentItem, nr, 'livePush sends the state object itself');
  const edited = Object.assign({}, nr, { notes: 'edited while the first write was in flight' }); // copies the pass
  c.setState({ requests: c.state.requests.map(x => x.id === 'FR-930' ? edited : x) });
  await tick(); await tick();
  assert.equal(sentPass, 'pass-1');
  assert.equal('zohoSubmitToken' in nr, false, 'removed from the object livePush sent');
  assert.equal('zohoSubmitToken' in c.reqById('FR-930'), false, 'removed from the state copy');
  sentPass = 'unset';
  c.livePush(); await tick(); await tick();
  assert.equal(sentPass, undefined, 'the later edit does not re-send the expired pass');
  delete replies['/api/sync/put'];
}

// ── scenario 10: finance's latest re-check is the main result; submission-time checks stay below (restricted: stripped) ──
{
  const latest = Object.assign(finance(true), { id: 'FV-9Z9Z9Z9Z', atText: '08 Oct · 09:00' });
  latest.checks[0].detail = 'AED 20,000 available against AED 12,520';
  const r = escReq('NEW', { escalation: null, finance: finance(false), financeLatest: latest });
  const c = make('sven');
  c.setState({ requests: [r].concat(c.state.requests), reqId: 'FR-900', route: 'detail', peekId: 'FR-900' });
  let vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  assert.equal(vm.detail.hasFin, true);
  assert.equal(vm.detail.fin.sub, 'Latest re-check · 08 Oct · 09:00 · FV-9Z9Z9Z9Z');
  assert.equal(vm.detail.fin.chip, 'All three checks passed');
  assert.equal(vm.detail.fin.checks[0].detail, 'AED 20,000 available against AED 12,520');
  assert.equal(vm.detail.hasFinAt, true);
  assert.equal(vm.detail.finAt.sub, '07 Oct · 14:05 · FV-1A2B3C4D');
  assert.equal(vm.detail.finAt.chip, '1 of 3 checks failed');
  assert.equal(vm.detail.finAt.checkLine.length, 3);
  assert.equal(vm.detail.finAt.checkLine[0].text, 'Customer Fund Disbursement account — Client does not have sufficient balance');
  assert.ok(vm.peek.facts.some(f => f.label === 'Financial checks · latest re-check' && f.value === 'All 3 passed'));
  assert.ok(!vm.peek.facts.some(f => f.label === 'Financial checks'));
  // only the submission-time result: shown as before, no "At submission" block
  c.setState({ requests: c.state.requests.map(x => x.id === 'FR-900' ? Object.assign({}, x, { financeLatest: undefined }) : x) });
  vm = c.renderVals();
  assert.equal(vm.detail.fin.sub, '07 Oct · 14:05 · FV-1A2B3C4D');
  assert.equal(vm.detail.hasFinAt, false);
  assert.ok(vm.peek.facts.some(f => f.label === 'Financial checks' && f.value === '1 of 3 failed'));
  // restricted Operations: never the detail text (the server strips amounts too)
  const m = make('maram');
  m.setState({ requests: [Object.assign({}, r, { by: 'maram' })].concat(m.state.requests), reqId: 'FR-900', route: 'detail', peekId: 'FR-900' });
  vm = m.renderVals();
  assert.equal(vm.detail.fin.sub, 'Latest re-check · 08 Oct · 09:00 · FV-9Z9Z9Z9Z');
  assert.equal(vm.detail.fin.checks[0].hasDetail, false);
  assert.equal(vm.detail.finAt.checks[0].hasDetail, false);
  assert.ok(!JSON.stringify(vm.detail.finAt.checkLine).includes('AED'));
}

// ── scenario 11: Undo after "Paid — close": Sven yes, Operations no (the server refuses PAID → CREDITED for them) ──
{
  for (const [who, undo] of [['sven', 'function'], ['maram', 'object']]) {
    const c = make(who);
    c.setState({ requests: [escReq('CREDITED', { by: 'maram', escalation: null, credited: 12520 })].concat(c.state.requests) });
    c.markPaid('FR-900');
    assert.equal(c.reqById('FR-900').status, 'PAID');
    assert.equal(typeof c.lastUndo, undo, who);
  }
}

// ── scenario 12: modalCall race — the answer only updates the modal it was sent from ──
{
  const setup = () => {
    const c = make('adnan');
    c.setState({ requests: [escReq('ESCALATED'), escReq('ESCALATED', { id: 'FR-905' })].concat(c.state.requests), reqId: 'FR-900', route: 'detail' });
    c._sync = { requests: c.state.requests };
    let release;
    replies['/api/requests/FR-900/escalation'] = () => new Promise(res => { release = res; });
    c.openModal('mgmtApprove', 'FR-900');
    c.setState({ modal: Object.assign({}, c.state.modal, { value: 'Approved after the call' }) });
    c.confirmModal();
    return { c, release: o => release(o) };
  };
  // failure while a different kind is open: flash, the other modal is untouched
  let { c, release } = setup();
  let mv = c.renderVals().modal;
  assert.equal(mv.cancelDisabled, true);
  mv.cancel();
  assert.equal(c.state.modal.kind, 'mgmtApprove', 'Cancel disabled while busy');
  c.setState({ modal: null }); c.openModal('chase', 'FR-900');
  release({ ok: false, status: 409, json: { ok: false, error: 'Already decided by Mr. Ahmed (General Manager)' } });
  await tick(); await tick();
  assert.equal(c.state.modal.kind, 'chase');
  assert.equal(c.state.modal.error, '');
  assert.equal(c.lastFlash, 'Already decided by Mr. Ahmed (General Manager)');
  // success while the same kind is open for another request: item merged, that modal stays open, flash
  ({ c, release } = setup());
  c.setState({ modal: null }); c.openModal('mgmtApprove', 'FR-905');
  const item = Object.assign(escReq('MGMT_APPROVED'), { escalation: Object.assign(escReq('MGMT_APPROVED').escalation, { decision: { action: 'APPROVE', by: 'adnan', byName: 'Adnan', title: 'CFO', note: 'ok' } }) });
  release({ ok: true, status: 200, json: { ok: true, item: item } });
  await tick(); await tick();
  assert.equal(c.state.modal.kind, 'mgmtApprove');
  assert.equal(c.state.modal.id, 'FR-905');
  assert.equal(c.state.modal.busy, false);
  assert.equal(c.reqById('FR-900').status, 'MGMT_APPROVED');
  assert.equal(c.lastFlash, 'Approved by management — Sven makes the final approval');
  // the same modal still open: error stays in it
  ({ c, release } = setup());
  release({ ok: false, status: 400, json: { ok: false, error: 'Note too short' } });
  await tick(); await tick();
  assert.equal(c.state.modal.error, 'Note too short');
  assert.equal(c.state.modal.busy, false);
  assert.equal(c.renderVals().modal.cancelDisabled, false);
  delete replies['/api/requests/FR-900/escalation'];
}

// ── scenario 13: management wording — Sven decides NEW; management's tasks are escalations ──
{
  const c = make('adnan');
  const extra = [escReq('ESCALATED'), escReq('ESCALATED', { id: 'FR-906', requested: 1000 }), escReq('MGMT_INFO', { id: 'FR-907' })];
  c.setState({ requests: extra.concat(c.state.requests), route: 'board', tab: 'tasks' });
  let vm = c.renderVals();
  resolveAll(markupOf(tpl), vm, seen);
  const titles = vm.sections.map(sc => sc.title);
  assert.ok(titles.includes('With Sven'), titles.join(' | '));
  assert.ok(!titles.includes('Decide now'));
  const rows = vm.sections.flatMap(sc => sc.rows);
  assert.ok(!rows.some(x => x.actLabel === 'Ask again'), 'no Ask again for management');
  const act = rows.find(x => c.reqById(x.num) && c.reqById(x.num).status === 'ACTION');
  assert.equal(act.actNote, 'Waiting on operations');
  assert.equal(vm.homeCards[0].title, '2 things need you');
  assert.match(vm.homeCards[0].sub, /^Escalations waiting on your decision · 1 waiting on operations/);
  assert.equal(vm.homeStats[0].label, 'waiting on your decision');
  assert.equal(vm.homeStats[0].value, c.short(13520));
  assert.equal(vm.homeSub, '2 escalations are waiting on your decision — ' + c.fmt(13520) + ' in total. 1 is waiting on operations.');
  const firstNew = c.state.requests.find(x => x.status === 'NEW'), firstApp = c.state.requests.find(x => x.status === 'APPROVED');
  c.setState({ route: 'detail', reqId: firstNew.id });
  assert.equal(c.renderVals().detail.nextText, 'With Sven for approval.');
  c.setState({ reqId: firstApp.id });
  assert.equal(c.renderVals().detail.nextText, 'Approved — Sven tops up the card.');
  // Sven keeps his wording and counts
  const s = make('sven');
  s.setState({ route: 'board', tab: 'tasks' });
  vm = s.renderVals();
  assert.ok(vm.sections.some(sc => sc.title === 'Decide now'));
  assert.equal(vm.homeStats[0].value, s.short(s.state.requests.filter(x => x.status === 'NEW').reduce((a, x) => a + x.requested, 0)));
}

const bad = [...seen].filter(([, s]) => s !== 'ok');
console.log('new bindings checked:', seen.size, '· unresolved:', bad.length ? bad.map(([p, s]) => p + ' (' + s + ')').join(', ') : 'none');
if (bad.length) process.exit(1);
console.log('smoke: all scenarios passed');
