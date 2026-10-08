// Shared harness for the end-to-end tests: sandbox copy of the server, Zoho stub, login + JSON calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
// The server under test: the repository itself, or a copy named in ONELINK_SANDBOX (server.js and finance-rules.js are
// refreshed into the copy before the first run).
export const SANDBOX = process.env.ONELINK_SANDBOX || REPO;
export const STUB = path.join(HERE, 'zoho-stub.mjs');
export const MASTER_PW = 'master-pass-123456';
export const TEAM_PW = 'team-pass-123';
export const SECRET = '0123456789abcdef0123456789abcdef0123';
export const OPS_INSUFFICIENT = 'Client does not have sufficient balance to request funds. Please contact Sven.';

let synced = false;
export function syncSandbox() {
  if (synced || path.resolve(SANDBOX) === REPO) return;
  for (const f of ['server.js', 'finance-rules.js']) fs.copyFileSync(path.join(REPO, f), path.join(SANDBOX, f));
  synced = true;
}

export const mkTmp = tag => fs.mkdtempSync(path.join(os.tmpdir(), 'onelink-' + tag + '-'));
export const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Start the sandbox server with the stub. dir holds users.json, platform.json, backups/, data/files (cwd).
export async function startServer({ dir, fixture, env = {} }) {
  syncSandbox();
  const port = await freePort();
  const fx = path.join(dir, 'fixture.json');
  if (fixture) fs.writeFileSync(fx, JSON.stringify(fixture, null, 1));
  const childEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
    PORT: String(port), MASTER_ADMIN_PASSWORD: MASTER_PW, SEED_TEAM_PASSWORD: TEAM_PW, VALIDATION_SECRET: SECRET,
    USERS_FILE: path.join(dir, 'users.json'), DATA_FILE: path.join(dir, 'platform.json'),
    ZOHO_CLIENT_ID: 'x', ZOHO_CLIENT_SECRET: 'y', ZOHO_REFRESH_TOKEN: 'z',
    ZOHO_STUB_FIXTURE: fx, ZOHO_STUB_LOG: path.join(dir, 'zoho.log'), ...env
  };
  const proc = spawn(process.execPath, ['--import', STUB, path.join(SANDBOX, 'server.js')], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const exited = new Promise(r => proc.on('exit', (code, sig) => r({ code, sig })));
  const up = await Promise.race([
    (async () => { for (let i = 0; i < 200; i++) { if (out.includes('OneLink backend on :' + port)) return true; await sleep(50); } return false; })(),
    exited.then(() => false)
  ]);
  if (!up) { proc.kill('SIGKILL'); throw new Error('server did not start:\n' + out); }
  const base = 'http://127.0.0.1:' + port;
  return {
    base, port, proc, dir, exited,
    out: () => out,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    async stop() { if (proc.exitCode !== null || proc.signalCode !== null) return; await sleep(400); /* let the 150 ms persist debounce land */ proc.kill('SIGTERM'); await exited; }
  };
}

export async function call(base, token, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json; try { json = JSON.parse(t); } catch { json = { _text: t }; }
  return { status: r.status, json };
}

export async function login(base, username, password) {
  const r = await call(base, null, 'POST', '/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`login ${username} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}

// Recursively collect every key path named `name`.
export function findKeys(o, name, p = '$', out = []) {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === name) out.push(p + '.' + k); findKeys(v, name, p + '.' + k, out); }
  return out;
}
