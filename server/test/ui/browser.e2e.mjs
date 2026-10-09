// Browser end-to-end test: the real server (Zoho stubbed) serving the real patched page, driven in Chromium.
//   node test/ui/browser.e2e.mjs            (from the server directory)
// Covers: Operations submit (all three checks pass) behind the Zoho loader, a failing client escalated to chosen
// managers (recipients picker), Management Requests (management + Sven only, management lands there), management
// approval, Sven's final approval, void, chase invoice, notification peek, management rejection → Rejected by
// Management, brand (logo, title, favicon), Master Control platform reset.
// Screenshots (desktop + phone width) go to $SHOTS when set.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onelink-e2e-'));
const PORT = 8800 + Math.floor(Math.random() * 100), BASE = `http://localhost:${PORT}`;
const CFD = '7050654000000685179', COGS = '7050654000000034003';
const ALPHA = '7050654000000100001', BETA = '7050654000000100002', GAMMA = '7050654000000100003', DELTA = '7050654000000100004';
const OPS_SHORT = 'Client does not have sufficient balance. You may escalate to Management.';
const fixture = {
  contacts: [
    { contact_id: ALPHA, contact_name: 'Alpha Trading LLC', company_name: 'Alpha Trading LLC', status: 'active', outstanding_receivable_amount: 0 },
    { contact_id: BETA, contact_name: 'Beta Holdings FZE', company_name: 'Beta Holdings FZE', status: 'active', outstanding_receivable_amount: 2500 },
    { contact_id: GAMMA, contact_name: 'Gamma Ventures LTD', company_name: 'Gamma Ventures LTD', status: 'active', outstanding_receivable_amount: 0 },
    { contact_id: DELTA, contact_name: 'Delta Logistics FZCO', company_name: 'Delta Logistics FZCO', status: 'active', outstanding_receivable_amount: 0 }
  ],
  balances: [
    { 'Resolved Customer ID': ALPHA, 'Resolved Customer Name': 'Alpha Trading LLC', 'Credits AED': 60000, 'Debits AED': 10000, 'Balance AED': 50000, 'Balance Status': 'Customer Advance', 'Balance Alert': '' },
    { 'Resolved Customer ID': BETA, 'Resolved Customer Name': 'Beta Holdings FZE', 'Credits AED': 3000, 'Debits AED': 2000, 'Balance AED': 1000, 'Balance Status': 'Customer Advance', 'Balance Alert': '' },
    { 'Resolved Customer ID': GAMMA, 'Resolved Customer Name': 'Gamma Ventures LTD', 'Credits AED': 'AED 40.00K', 'Debits AED': 0, 'Balance AED': 40000, 'Balance Status': 'Customer Advance', 'Balance Alert': '' },
    { 'Resolved Customer ID': DELTA, 'Resolved Customer Name': 'Delta Logistics FZCO', 'Credits AED': 500, 'Debits AED': 0, 'Balance AED': 500, 'Balance Status': 'Customer Advance', 'Balance Alert': '' }
  ],
  split: [
    { Customer: ALPHA, Account: CFD, Credits: 60000, Debits: 10000, Lines: 4, Untagged: 0 },
    { Customer: ALPHA, Account: COGS, Credits: 0, Debits: 5000, Lines: 2, Untagged: 0 },
    { Customer: BETA, Account: CFD, Credits: 3000, Debits: 2000, Lines: 2, Untagged: 0 },
    { Customer: GAMMA, Account: CFD, Credits: 40000, Debits: 0, Lines: 1, Untagged: 0 },
    { Customer: DELTA, Account: CFD, Credits: 500, Debits: 0, Lines: 1, Untagged: 0 }
  ],
  invoices: [{ Customer: BETA, Invoice: 'INV-000777', Status: 'Overdue', Due: '01 Oct 2026', Total: 5000, Balance: 2500 }],
  payments: [
    { Customer: ALPHA, Payments: 2, Received: 60000, Unapplied: 0, Refunded: 0, Last: '2026-10-05 00:00:00.0' },
    { Customer: BETA, Payments: 1, Received: 2500, Unapplied: 0, Refunded: 0, Last: '2026-09-20 00:00:00.0' },
    { Customer: GAMMA, Payments: 1, Received: 40000, Unapplied: 0, Refunded: 0, Last: '2026-10-01 00:00:00.0' },
    { Customer: DELTA, Payments: 1, Received: 500, Unapplied: 0, Refunded: 0, Last: '2026-10-02 00:00:00.0' }
  ]
};
fs.writeFileSync(path.join(tmp, 'fixture.json'), JSON.stringify(fixture));

const env = { ...process.env, PORT: String(PORT), MASTER_ADMIN_PASSWORD: 'master-pass-123456', SEED_TEAM_PASSWORD: 'team-pass-123',
  VALIDATION_SECRET: '0123456789abcdef0123456789abcdef0123', USERS_FILE: path.join(tmp, 'users.json'), DATA_FILE: path.join(tmp, 'platform.json'),
  ZOHO_CLIENT_ID: 'x', ZOHO_CLIENT_SECRET: 'y', ZOHO_REFRESH_TOKEN: 'z', ZOHO_STUB_FIXTURE: path.join(tmp, 'fixture.json'),
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', SVEN_WEBHOOK_URL: '', GOOGLE_SHEET_ID: '' };
const srv = spawn(process.execPath, ['--import', path.join(root, 'test/zoho-stub.mjs'), path.join(root, 'server.js')], { cwd: tmp, env });
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; }); srv.stderr.on('data', d => { srvLog += d; });
for (let i = 0; i < 60 && !srvLog.includes('OneLink backend on'); i++) await new Promise(r => setTimeout(r, 200));
if (!/Zoho client workflow: applied (\d+) of \1 rules/.test(srvLog)) {
  await fetch(BASE + '/').catch(() => {}); await new Promise(r => setTimeout(r, 300));
}

const results = [];
let failed = 0;
async function step(name, fn, soft) {
  try { await fn(); results.push('  ✓ ' + name); }
  catch (e) { failed++; results.push('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').slice(0, 6).join('\n      ')); if (!soft) throw e; }
}
const soft = (name, fn) => step(name, fn, true);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function session(user, password) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => { results.push(`  ! page error (${user}): ${e.message}`); failed++; });
  // The export talks to the production backend by default — point it at this server.
  await page.route(BASE + '/', async route => {
    const r = await route.fetch();
    route.fulfill({ response: r, body: (await r.text()).split('https://onelink-funding-backend.onrender.com').join(BASE) });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com|unpkg\.com|cdn\.jsdelivr\.net/, r => r.abort());
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="you@onelink.solutions"]:visible').fill(user + '@onelink.solutions');
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('input[autocomplete="current-password"]').press('Enter');
  await page.getByText('Signed in as', { exact: false }).first().waitFor({ timeout: 15000 });
  return { ctx, page };
}
const api = async (token, p, body) => {
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const login = async u => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: u === 'sven' ? 'master-pass-123456' : 'team-pass-123' }) })).json()).token;
const shots = process.env.SHOTS || tmp;
fs.mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { const f = path.join(shots, name + '.png'); await page.screenshot({ path: f, fullPage: /^\d/.test(name) }); return f; };
const PHONE = { width: 390, height: 844 }, DESK = { width: 1360, height: 900 };

// In-app navigation through the command palette (a page reload would sign the user out).
async function palette(page, label) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('button', { name: new RegExp(label) }).first().click();
}
async function newRequest(page, { client, purpose, amount, paid, loaderShot }) {
  await palette(page, 'Raise a funds request');
  const box = page.getByPlaceholder('Type 2+ letters of the client or company name');
  await box.fill(client.slice(0, 5));
  await page.getByRole('option').filter({ hasText: client }).first().click();
  await page.getByText('Client selected from Zoho Books').waitFor({ timeout: 15000 });
  await page.locator('label:has-text("Purpose of payment") + *').first().fill(purpose);
  await page.locator('input[placeholder="12520"]').fill(String(amount));
  await page.locator('label:has-text("Client already paid us?") + *').first().selectOption(paid);
  await page.getByRole('button', { name: 'Send to finance' }).click();
  const anyway = page.getByRole('button', { name: 'Send without it' });
  await anyway.waitFor({ timeout: 5000 }); await anyway.click();
  // the Zoho loader: progress bar, step list, rotating line — never a figure
  const loader = page.locator('[role="status"][aria-live="polite"]').filter({ hasText: 'Checking with Zoho' });
  await loader.waitFor({ timeout: 3000 });
  const txt = await loader.innerText();
  expect(/Verifying Zoho connections/.test(txt) && /Reading Zoho Analytics balance/.test(txt) && /Cross-checking Zoho Books/.test(txt) && /Final decision/.test(txt), 'loader steps missing: ' + txt);
  expect(!/AED|\d,\d{3}/.test(txt), 'loader shows a figure: ' + txt);
  if (loaderShot) await shot(page, loaderShot);
  await loader.waitFor({ state: 'detached', timeout: 60000 });
}

let ok = false;
try {
  const ops = await session('maram', 'team-pass-123');

  await soft('Brand: OneLink logo in the header, tab title "OneLink Funds", favicon links in the head', async () => {
    const logo = ops.page.locator('header img[alt="OneLink"]');
    await logo.waitFor({ timeout: 5000 });
    expect(await logo.getAttribute('src') === '/brand/logo.png', 'logo src');
    const box = await logo.boundingBox();
    expect(box && Math.round(box.width) === 30 && Math.round(box.height) === 30, 'logo box ' + JSON.stringify(box));
    expect(await ops.page.title() === 'OneLink Funds', 'title is ' + await ops.page.title());
    const icons = await ops.page.evaluate(() => [...document.querySelectorAll('head link[rel~="icon"]')].map(l => l.getAttribute('href')));
    expect(icons.includes('/brand/icon-32.png') && icons.includes('/favicon.ico'), 'icon links: ' + icons.join(', '));
    const nat = await logo.evaluate(i => i.naturalWidth);
    expect(nat > 0, 'logo image did not load (is /brand/logo.png served?)');
    await shot(ops.page, 'header-logo-desktop');
  });

  await step('Operations: no Management Requests nav item or page', async () => {
    expect(await ops.page.getByRole('button', { name: /Management Requests/ }).count() === 0, 'Operations see the Management Requests nav');
  });

  await step('Operations: client passing all three checks is sent as Pending Sven Approval with the checks on it (Zoho loader shown)', async () => {
    await newRequest(ops.page, { client: 'Alpha Trading LLC', purpose: 'Licence renewal', amount: 12000, paid: 'Yes', loaderShot: 'ops-loader-desktop' });
    await ops.page.getByText('Financial validation', { exact: true }).first().waitFor({ timeout: 15000 });
    await ops.page.getByText(/All (three|five) checks passed/).first().waitFor({ timeout: 10000 });
    expect(await ops.page.getByText('Pending Sven Approval').count() > 0, 'status label missing');
    const body = await ops.page.locator('body').innerText();
    expect(!/AED 50,000|50,000\.00|Available AED/.test(body), 'Operations can see the CFD balance');
  });

  await step('Operations: failing client is blocked with the failed checks and can escalate to chosen managers', async () => {
    await newRequest(ops.page, { client: 'Beta Holdings FZE', purpose: 'Visa fines', amount: 4000, paid: 'Yes' });
    await ops.page.getByText(OPS_SHORT).first().waitFor({ timeout: 15000 });
    expect(await ops.page.getByText('Invoice payment verification').count() > 0, 'invoice check not listed');
    const body = await ops.page.locator('body').innerText();
    expect(!/AED 1,000|2,500/.test(body), 'Operations can see amounts on the failed checks');
    await ops.page.getByRole('button', { name: 'Escalate to Management' }).click();
    // recipients picker: All management by default; pick Mr. Adnan and Mr. Eduard
    const group = ops.page.getByRole('group', { name: 'Send to' });
    await group.waitFor({ timeout: 5000 });
    expect(await group.getByRole('button', { name: 'All management' }).getAttribute('aria-pressed') === 'true', 'All management is not the default');
    expect(await group.getByRole('button').count() === 4, 'expected All management + three managers, got ' + await group.getByRole('button').count());
    await group.getByRole('button', { name: 'Mr. Adnan (CFO)' }).click();
    await group.getByRole('button', { name: 'Mr. Eduard (Chief Legal Officer)' }).click();
    expect(await group.getByRole('button', { name: 'All management' }).getAttribute('aria-pressed') === 'false', 'All management still on');
    await ops.page.getByText('Only Mr. Adnan (CFO), Mr. Eduard (Chief Legal Officer) are notified and can decide.').waitFor({ timeout: 3000 });
    await ops.page.locator('textarea').last().fill('Client paid in cash at the office today; receipt follows.');
    await shot(ops.page, '1-ops-failed-checks');
    await shot(ops.page, 'escalation-picker-desktop');
    await ops.page.getByRole('button', { name: 'Send to management' }).click();
    await ops.page.getByText('Awaiting Management Decision').first().waitFor({ timeout: 15000 });
    await ops.page.getByText('Waiting for management', { exact: true }).first().waitFor({ timeout: 5000 });
    await ops.page.getByText('Mr. Adnan (CFO)', { exact: false }).first().waitFor({ timeout: 5000 });
    await shot(ops.page, '2-ops-escalated');
    await shot(ops.page, 'ops-waiting-card-desktop');
  });

  const tSven = await login('sven');
  const snap = (await api(tSven, '/api/sync/snapshot')).json;
  const histCount = snap.requests.filter(r => !r.createdAt).length;
  const esc = snap.requests.find(r => r.status === 'ESCALATED');
  const alpha = snap.requests.find(r => r.zohoClientId === ALPHA);
  await step('Server holds the escalation with failed checks, and the passing request with its finance record', async () => {
    expect(esc && esc.escalation && esc.escalation.failed.length >= 2, 'no escalation on the server');
    expect(alpha && alpha.finance && alpha.finance.ok === true && alpha.status === 'NEW', 'passing request missing finance/NEW');
    expect(snap.notifications.some(n => n.to === 'sven' && /Escalated to management/.test(n.text)), 'Sven not notified');
  });
  await soft('Server: the escalation went only to the chosen managers (escalation.to / routing)', async () => {
    const keys = (esc.escalation.to || []).map(t => t.key).sort().join(',');
    expect(keys === 'adnan,eduard', 'escalation.to = ' + keys);
    expect(esc.escalation.routing === 'SELECTED', 'routing = ' + esc.escalation.routing);
  });

  const mgmt = await session('adnan', 'team-pass-123');
  await step('Management: Mr. Adnan lands on Management Requests with the escalation awaiting his decision', async () => {
    await mgmt.page.getByRole('heading', { name: 'Management Requests' }).waitFor({ timeout: 5000 });
    expect(await mgmt.page.getByRole('button', { name: /Management Requests/ }).count() === 1, 'nav item missing');
    await mgmt.page.getByText('Awaiting decision', { exact: true }).first().waitFor({ timeout: 5000 });
    const row = mgmt.page.getByRole('button').filter({ hasText: 'Beta Holdings FZE' }).first();
    await row.waitFor({ timeout: 5000 });
    expect(/Your decision/.test(await row.innerText()), 'row not marked as his decision');
    await shot(mgmt.page, 'mgmt-requests-desktop');
    await mgmt.page.setViewportSize(PHONE); await mgmt.page.waitForTimeout(400);
    await shot(mgmt.page, 'mgmt-requests-phone');
    await shot(mgmt.page, 'header-logo-phone');
    await mgmt.page.setViewportSize(DESK); await mgmt.page.waitForTimeout(300);
  }).catch(async e => { await shot(mgmt.page, 'mgmt-landing'); throw e; });
  await step('Management: Mr. Adnan opens the escalation and approves & proceeds', async () => {
    await mgmt.page.getByRole('button').filter({ hasText: 'Beta Holdings FZE' }).first().click();
    await mgmt.page.getByText('Escalation to management', { exact: false }).first().waitFor({ timeout: 5000 });
    await mgmt.page.getByText('Mr. Adnan (CFO), Mr. Eduard (Chief Legal Officer)', { exact: false }).first().waitFor({ timeout: 5000 }).catch(() => {});
    await shot(mgmt.page, '3-mgmt-escalation');
    await shot(mgmt.page, 'detail-escalation-desktop');
    await mgmt.page.setViewportSize(PHONE); await mgmt.page.waitForTimeout(400);
    await mgmt.page.getByText('Escalation to management', { exact: false }).first().scrollIntoViewIfNeeded();
    await shot(mgmt.page, 'detail-escalation-phone');
    await mgmt.page.setViewportSize(DESK); await mgmt.page.waitForTimeout(300);
    await mgmt.page.getByRole('button', { name: 'Approve & proceed' }).first().click();
    await mgmt.page.locator('textarea:visible, input.input:visible').last().fill('Cash receipt seen; proceed.');
    await mgmt.page.getByRole('button', { name: /^(Approve|Approve & proceed|Confirm)$/ }).last().click();
    await mgmt.page.getByText('Management Approved – Proceed').first().waitFor({ timeout: 10000 });
  }).catch(async e => { await shot(mgmt.page, 'mgmt'); throw e; });

  const svenUI = await session('sven', 'master-pass-123456');
  await step('Sven: Management Requests is in his nav and lists the escalation', async () => {
    await svenUI.page.getByRole('button', { name: /Management Requests/ }).first().click();
    await svenUI.page.getByRole('heading', { name: 'Management Requests' }).waitFor({ timeout: 5000 });
    await svenUI.page.getByText('Approved – waiting for Sven', { exact: true }).first().waitFor({ timeout: 5000 });
    await svenUI.page.getByRole('button').filter({ hasText: 'Beta Holdings FZE' }).first().waitFor({ timeout: 5000 });
  }).catch(async e => { await shot(svenUI.page, 'sven-mgmt'); throw e; });
  await step('Sven: a notification opens its request inside the Updates panel — no tab change, no reload', async () => {
    await palette(svenUI.page, 'View pending approvals');
    const before = await svenUI.page.locator('h3').first().innerText().catch(() => '');
    await svenUI.page.locator('button:has(i.ph-bell), button:has(i.ph-bell-simple), button:has(i.ph-bell-ringing)').first().click();
    await svenUI.page.getByText('Management approved — your final approval is needed', { exact: false }).first().click();
    await svenUI.page.getByRole('button', { name: 'All updates' }).waitFor({ timeout: 5000 });
    await svenUI.page.getByRole('button', { name: 'Final approval' }).first().waitFor({ timeout: 5000 });
    await shot(svenUI.page, '4-sven-peek');
    const after = await svenUI.page.locator('h3').first().innerText().catch(() => '');
    expect(before === after, 'the page behind the panel changed: ' + before + ' → ' + after);
    await svenUI.page.getByRole('button', { name: 'All updates' }).click();
    await svenUI.page.keyboard.press('Escape');
  }).catch(async e => { await shot(svenUI.page, 'peek'); throw e; });
  await step('Sven: final approval of the management-approved request without a Zoho balance gate', async () => {
    await palette(svenUI.page, 'View pending approvals');
    await svenUI.page.getByText('Beta Holdings FZE').first().click();
    await svenUI.page.getByRole('button', { name: 'Final approval' }).first().click();
    await svenUI.page.waitForTimeout(1500);
    const r = (await api(tSven, '/api/sync/snapshot')).json.requests.find(x => x.id === esc.id);
    expect(r.status === 'APPROVED', 'expected APPROVED, got ' + r.status);
    expect(r.timeline.some(t => /management override by Mr\. Adnan/.test(t.text)), 'override not in history');
    await shot(svenUI.page, '5-sven-approved');
  }).catch(async e => { await shot(svenUI.page, 'sven-final'); throw e; });

  await step('Sven: "Check and approve" runs the live check on the stored request and approves the full amount', async () => {
    await palette(svenUI.page, 'View pending approvals');
    await svenUI.page.getByText('Alpha Trading LLC').first().click();
    await svenUI.page.getByRole('button', { name: 'Check and approve' }).first().click();
    await svenUI.page.getByRole('button', { name: 'Approve the full amount' }).first().click({ timeout: 20000 });
    await svenUI.page.waitForTimeout(1200);
    const r = (await api(tSven, '/api/sync/snapshot')).json.requests.find(x => x.zohoClientId === ALPHA);
    expect(r.status === 'APPROVED', 'expected APPROVED, got ' + r.status);
    expect(r.financeLatest && r.financeLatest.ok === true, 'the re-check is not kept on the request');
  }).catch(async e => { await shot(svenUI.page, 'sven-check-approve'); throw e; });

  await step('Sven: chase invoice with a file from the request page', async () => {
    await palette(svenUI.page, 'View pending approvals');
    await svenUI.page.getByRole('button', { name: /To credit/ }).first().click(); // Alpha is approved now
    await svenUI.page.getByText('Alpha Trading LLC').first().click();
    await svenUI.page.getByRole('button', { name: 'Chase invoice' }).first().click();
    const f = path.join(tmp, 'INV-1234 receipt.pdf'); fs.writeFileSync(f, '%PDF-1.4 test');
    const chooser = svenUI.page.waitForEvent('filechooser');
    await svenUI.page.getByRole('button', { name: /Attach invoice/ }).first().click();
    await (await chooser).setFiles(f);
    await svenUI.page.getByText('INV-1234 receipt.pdf').first().waitFor({ timeout: 10000 });
    await shot(svenUI.page, '6-chase-modal');
    await svenUI.page.locator('textarea:visible').last().fill('Please upload the stamped receipt too.');
    await svenUI.page.waitForTimeout(800);
    await svenUI.page.getByRole('button', { name: /Send to finance|Send chase|Chase/ }).last().click();
    await svenUI.page.waitForTimeout(1200);
    const r = (await api(tSven, '/api/sync/snapshot')).json.requests.find(x => x.zohoClientId === ALPHA);
    expect(r.docs.some(d => d.name === 'INV-1234 receipt.pdf' && d.fileId), 'chased file not on the request');
    expect(r.timeline.some(t => /chased the invoice/.test(t.text)), 'chase not in history');
  }).catch(async e => { await shot(svenUI.page, 'chase'); throw e; });

  await step('Operations sees the chase notification for their request', async () => {
    const tMaram = await login('maram');
    const n = (await api(tMaram, '/api/sync/snapshot')).json.notifications;
    expect(n.some(x => /Invoice chase/.test(x.text)), 'requester not notified of the chase');
  });

  await step('Sven: void request — locked, client unlocked, Operations cannot change it', async () => {
    await svenUI.page.getByRole('button', { name: 'Void request' }).first().click();
    await svenUI.page.locator('textarea:visible, input.input:visible').last().fill('Duplicate of an email request');
    await svenUI.page.getByRole('button', { name: /^(Void|Void request|Confirm)$/ }).last().click();
    await svenUI.page.getByText('Voided by', { exact: false }).first().waitFor({ timeout: 10000 });
    await shot(svenUI.page, '7-voided');
    expect(await svenUI.page.getByRole('button', { name: 'Chase invoice' }).count() === 0, 'chase still offered on a voided request');
    const tMaram = await login('maram');
    const r = (await api(tMaram, '/api/sync/snapshot')).json.requests.find(x => x.zohoClientId === ALPHA);
    const put = await api(tMaram, '/api/sync/put', { col: 'requests', item: { ...r, notes: 'edit after void' } });
    expect(put.status === 403, 'edit after void allowed: ' + put.status);
  }).catch(async e => { await shot(svenUI.page, 'void'); throw e; });

  await step('Operations (phone width): another failing client is escalated to Mr. Ahmed only', async () => {
    await ops.page.setViewportSize(PHONE); await ops.page.waitForTimeout(400);
    await newRequest(ops.page, { client: 'Delta Logistics FZCO', purpose: 'Customs deposit', amount: 3000, paid: 'Yes', loaderShot: 'ops-loader-phone' });
    await ops.page.getByText(OPS_SHORT).first().waitFor({ timeout: 15000 });
    await ops.page.getByRole('button', { name: 'Escalate to Management' }).click();
    const group = ops.page.getByRole('group', { name: 'Send to' });
    await group.getByRole('button', { name: 'Mr. Ahmed (General Manager)' }).click();
    await ops.page.locator('textarea').last().fill('Client wired the funds this morning; confirmation attached later.');
    await group.scrollIntoViewIfNeeded();
    await shot(ops.page, 'escalation-picker-phone');
    await ops.page.getByRole('button', { name: 'Send to management' }).click();
    await ops.page.getByText('Waiting for management', { exact: true }).first().waitFor({ timeout: 15000 });
    await ops.page.getByText('Waiting for management', { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(ops.page, 'ops-waiting-card-phone');
    await ops.page.setViewportSize(DESK); await ops.page.waitForTimeout(300);
  }).catch(async e => { await shot(ops.page, 'delta-escalate'); throw e; });
  const delta = (await api(tSven, '/api/sync/snapshot')).json.requests.find(r => r.zohoClientId === DELTA || r.company === 'Delta Logistics FZCO');
  await soft('Management: Mr. Adnan cannot decide an escalation sent only to Mr. Ahmed', async () => {
    expect(delta && delta.status === 'ESCALATED', 'Delta not escalated: ' + (delta && delta.status));
    await palette(mgmt.page, 'Management Requests');
    await mgmt.page.getByRole('button').filter({ hasText: 'Delta Logistics FZCO' }).first().click();
    await mgmt.page.getByText('Escalation to management', { exact: false }).first().waitFor({ timeout: 5000 });
    expect(await mgmt.page.getByRole('button', { name: 'Reject escalation' }).count() === 0, 'Mr. Adnan is offered the decision');
  });
  await soft('Management: Mr. Ahmed rejects → Rejected by Management, the client is unlocked', async () => {
    const ahmed = await session('ahmed', 'team-pass-123');
    await ahmed.page.getByRole('heading', { name: 'Management Requests' }).waitFor({ timeout: 5000 });
    await ahmed.page.getByRole('button').filter({ hasText: 'Delta Logistics FZCO' }).first().click();
    await ahmed.page.getByRole('button', { name: 'Reject escalation' }).first().click();
    await ahmed.page.locator('textarea:visible, input.input:visible').last().fill('The client has to pay in full first.');
    await ahmed.page.getByRole('button', { name: /^Reject escalation$/ }).last().click();
    await ahmed.page.getByText('Rejected by Management').first().waitFor({ timeout: 10000 });
    await shot(ahmed.page, 'mgmt-rejected-desktop');
    const r = (await api(tSven, '/api/sync/snapshot')).json.requests.find(x => x.id === delta.id);
    expect(r.status === 'MGMT_REJECTED', 'expected MGMT_REJECTED, got ' + r.status);
    // Operations see the status, never the management note
    await palette(ops.page, 'View pending approvals');
    await ops.page.getByText('Delta Logistics FZCO').first().click();
    await ops.page.getByText('Rejected by Management').first().waitFor({ timeout: 10000 });
    expect(!/pay in full first/.test(await ops.page.locator('body').innerText()), 'Operations can read the management note');
    await ahmed.ctx.close();
  });

  await step('Master Control → Platform reset lists live requests and resets with a backup', async () => {
    await palette(svenUI.page, 'Manage permissions');
    await svenUI.page.getByText('Platform reset', { exact: true }).first().click();
    await svenUI.page.getByText(esc.id, { exact: false }).first().waitFor({ timeout: 10000 });
    await svenUI.page.getByPlaceholder('Removing test requests before go-live').first().fill('Clearing test data before go-live');
    await svenUI.page.getByPlaceholder('RESET', { exact: true }).first().fill('RESET');
    await svenUI.page.getByRole('button', { name: 'Back up and reset' }).click();
    await svenUI.page.getByText(/BK-\d{8}T\d{6}-[0-9A-F]{4}/).first().waitFor({ timeout: 15000 });
    const s2 = (await api(tSven, '/api/sync/snapshot')).json;
    expect(!s2.requests.some(r => r.createdAt), 'live requests still present after reset');
    expect(s2.requests.length === histCount, 'history should be kept (' + histCount + '), have ' + s2.requests.length);
    expect(s2.audit.some(a => a.action === 'PLATFORM_RESET'), 'reset not audited');
  }).catch(async e => { await shot(svenUI.page, 'reset'); throw e; });
  ok = failed === 0;
} catch (e) {
  // step() already recorded it
} finally {
  await browser.close().catch(() => {});
  srv.kill();
  console.log(results.join('\n'));
  console.log(ok ? '\nbrowser e2e: all steps passed' : `\nbrowser e2e: FAILED (${failed}) — screenshots and server log in ${tmp}`);
  fs.writeFileSync(path.join(tmp, 'server.log'), srvLog);
  process.exit(ok ? 0 : 1);
}
