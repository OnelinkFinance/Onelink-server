// Server-side authentication — the real enforcement layer.
// Users persist in data/users.json until the Master Admin deletes or deactivates them.
// Passwords: scrypt + per-user salt. Sessions: bearer token (also accepted as HttpOnly cookie), 30-min idle expiry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { push } from './cloud.js';

const FILE = path.resolve(process.env.USERS_FILE || './data/users.json');
const IDLE_MS = 30 * 60 * 1000, LOCK_AFTER = 5, LOCK_MS = 15 * 60 * 1000;
const sessions = new Map();           // token -> { user, last }
const history = [];
let onEvent = () => {};               // set by sync layer for live broadcast
export const setBroadcast = fn => { onEvent = fn; };

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const check = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  const a = Buffer.from(h || '', 'hex'), b = crypto.scryptSync(pw, salt || '', 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const OPS = ['VIEW_DASHBOARD', 'VIEW_OPERATIONS_DASHBOARD', 'VIEW_OWN_REQUESTS', 'CREATE_REQUEST', 'EDIT_REQUEST', 'UPLOAD_DOCUMENTS', 'REQUEST_APPROVAL', 'VIEW_ACTIVITY'];
function seedTeam() {
  const pw = process.env.SEED_TEAM_PASSWORD;
  if (!pw || pw.length < 8) return [];
  const mk = (key, name, dept) => ({ key, name, username: key + '@onelink.solutions', role: dept, dept, active: true, perms: dept === 'OPERATIONS' ? OPS : [], pw: hash(pw), failCount: 0, lockedUntil: 0, created: new Date().toISOString() });
  return [mk('adnan', 'Adnan', 'MANAGEMENT'), ...['amina', 'anastasiya', 'maram', 'musa', 'wafaa'].map(k => mk(k, k[0].toUpperCase() + k.slice(1), 'OPERATIONS'))];
}
export function load() {
  if (!fs.existsSync(FILE)) {
    const pw = process.env.MASTER_ADMIN_PASSWORD;
    if (!pw || pw.length < 12) throw new Error('Set MASTER_ADMIN_PASSWORD (12+ chars) for the first start — it creates the Master Admin account.');
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    save([{ key: 'sven', name: 'Sven', username: (process.env.MASTER_ADMIN_EMAIL || 'sven@onelink.solutions').toLowerCase(), role: 'MASTER_ADMIN', dept: 'FINANCE', active: true, perms: ['*'], pw: hash(pw), failCount: 0, lockedUntil: 0, created: new Date().toISOString() }, ...seedTeam()]);
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function save(users) { const j = JSON.stringify(users, null, 2); fs.writeFileSync(FILE + '.tmp', j); fs.renameSync(FILE + '.tmp', FILE); push('users', j); }
export const pub = u => ({ key: u.key, name: u.name, username: u.username, role: u.role, dept: u.dept, active: u.active, perms: u.perms || [], created: u.created, lastLogin: u.lastLogin || '—', locked: (u.lockedUntil || 0) > Date.now() });
const broadcastUsers = () => onEvent({ type: 'accounts', items: load().map(pub) });

function record(kind, who, detail, ip) {
  const e = { at: new Date().toISOString(), kind, who, detail, ip };
  history.unshift(e); history.length = Math.min(history.length, 500);
  fs.appendFile(path.join(path.dirname(FILE), 'login-history.jsonl'), JSON.stringify(e) + '\n', () => {});
  onEvent({ type: 'login', item: e });
}

const tokenOf = q => {
  const b = /^Bearer\s+([A-Za-z0-9_-]{32,})$/.exec(q.headers.authorization || '');
  if (b) return b[1];
  if (typeof q.query?.t === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(q.query.t)) return q.query.t; // EventSource cannot set headers
  return (/(?:^|;\s*)ol_auth=([A-Za-z0-9_-]{32,})/.exec(q.headers.cookie || '') || [])[1];
};

export function requireAuth(q, s, next) {
  const t = tokenOf(q), sess = t && sessions.get(t);
  if (!sess || Date.now() - sess.last > IDLE_MS) { if (t) sessions.delete(t); return s.status(401).json({ ok: false, reason: 'LOGIN_REQUIRED' }); }
  const u = load().find(x => x.key === sess.user);
  if (!u || !u.active) { sessions.delete(t); return s.status(401).json({ ok: false, reason: 'ACCOUNT_INACTIVE' }); }
  sess.last = Date.now(); q.user = u; q.token = t; next();
}
export const isMaster = u => u?.role === 'MASTER_ADMIN' || (u?.perms || []).includes('*');
const requireMaster = (q, s, next) => isMaster(q.user) ? next() : s.status(403).json({ ok: false, reason: 'MASTER_ADMIN_ONLY' });
const kill = key => { for (const [t, v] of sessions) if (v.user === key) sessions.delete(t); };
const keyFor = (username, users) => {
  const base = username.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  let k = base, i = 2; while (users.some(u => u.key === k)) k = base + i++;
  return k;
};

export function mount(app) {
  app.post('/api/auth/login', (q, s) => {
    const id = String(q.body?.username || '').trim().toLowerCase(), pw = String(q.body?.password || '');
    const users = load(), u = users.find(x => x.username === id || x.key === id);
    const bad = (code, msg, kind = 'FAILED') => { record(kind, u ? u.name : id, msg, q.ip); s.status(code).json({ ok: false, error: msg }); };
    if (!u) return bad(401, 'Email or password is not right.');
    if ((u.lockedUntil || 0) > Date.now()) return bad(423, 'Account locked after five wrong passwords. Try again in 15 minutes or ask Sven to reset it.', 'LOCKED');
    if (!u.active) return bad(403, 'Account deactivated by the Master Administrator.', 'BLOCKED');
    if (!check(pw, u.pw)) {
      u.failCount = (u.failCount || 0) + 1;
      const left = LOCK_AFTER - u.failCount;
      if (u.failCount >= LOCK_AFTER) { u.failCount = 0; u.lockedUntil = Date.now() + LOCK_MS; }
      save(users);
      return bad(401, left > 0 ? `Email or password is not right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Five wrong passwords — account locked for 15 minutes.', left > 0 ? 'FAILED' : 'LOCKED');
    }
    u.failCount = 0; u.lockedUntil = 0; u.lastLogin = new Date().toISOString(); save(users);
    const t = crypto.randomBytes(32).toString('base64url');
    sessions.set(t, { user: u.key, last: Date.now() });
    s.append('Set-Cookie', `ol_auth=${t}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${IDLE_MS / 1000}`);
    record('SUCCESS', u.name, 'Signed in', q.ip);
    s.json({ ok: true, token: t, user: pub(u) });
  });
  // Operations user forgot their password → Sven is notified live (response never reveals whether the account exists)
  const resetHits = new Map();
  app.post('/api/auth/reset-request', (q, s) => {
    const id = String(q.body?.username || '').trim().toLowerCase(), now = Date.now();
    const last = resetHits.get(q.ip) || 0; resetHits.set(q.ip, now);
    const u = load().find(x => x.username === id || x.key === id);
    if (u && now - last > 10000) { record('RESET_REQUEST', u.name, 'Asked the Master Administrator for a password reset', q.ip); onEvent({ type: 'reset-request', user: pub(u) }); }
    s.json({ ok: true });
  });
  // Master Admin recovery with the RECOVERY_CODE env value
  app.post('/api/auth/recover', (q, s) => {
    const code = String(q.body?.code || ''), pw = String(q.body?.password || ''), want = process.env.RECOVERY_CODE || '';
    const users = load(), u = users.find(x => isMaster(x));
    const ok = want.length >= 12 && code.length === want.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(want));
    if (!ok) { record('FAILED', u ? u.name : 'master', 'Wrong recovery code', q.ip); return s.status(403).json({ ok: false, error: 'That recovery code is not right.' }); }
    if (pw.length < 12) return s.status(400).json({ ok: false, error: 'Use at least twelve characters.' });
    u.pw = hash(pw); u.failCount = 0; u.lockedUntil = 0; u.active = true; save(users); kill(u.key);
    record('RESET', u.name, 'Master password reset with the recovery code', q.ip);
    s.json({ ok: true });
  });
  app.post('/api/auth/logout', requireAuth, (q, s) => { sessions.delete(q.token); record('LOGOUT', q.user.name, 'Signed out', q.ip); s.json({ ok: true }); });
  app.get('/api/auth/me', requireAuth, (q, s) => s.json({ ok: true, user: pub(q.user) }));

  app.get('/api/admin/users', requireAuth, requireMaster, (_q, s) => s.json(load().map(pub)));
  app.post('/api/admin/users', requireAuth, requireMaster, (q, s) => {
    const b = q.body || {}, users = load(), username = String(b.username || '').trim().toLowerCase();
    if (!/.+@.+\..+/.test(username) || !b.name || String(b.password || '').length < 8) return s.status(400).json({ ok: false, error: 'Name, work email and an 8+ character password are required.' });
    if (users.some(u => u.username === username)) return s.status(409).json({ ok: false, error: 'An account already uses that email.' });
    const dept = b.dept || 'OPERATIONS';
    const u = { key: keyFor(username, users), name: String(b.name), username, role: b.role || dept, dept, active: b.active !== false, perms: Array.isArray(b.perms) ? b.perms : (dept === 'OPERATIONS' ? OPS : []), pw: hash(String(b.password)), failCount: 0, lockedUntil: 0, created: new Date().toISOString() };
    users.push(u); save(users); record('USER_CREATED', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true, user: pub(u) });
  });
  app.patch('/api/admin/users/:key', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key), b = q.body || {};
    if (!u) return s.status(404).json({ ok: false });
    if (b.name) u.name = String(b.name);
    if (b.username && /.+@.+\..+/.test(b.username)) u.username = String(b.username).toLowerCase();
    if (!isMaster(u)) { if (b.dept) u.dept = b.dept; if (b.role) u.role = b.role; if (Array.isArray(b.perms)) u.perms = b.perms; }
    save(users); broadcastUsers(); s.json({ ok: true, user: pub(u) });
  });
  app.post('/api/admin/users/:key/active', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key);
    if (!u || isMaster(u)) return s.status(400).json({ ok: false });
    u.active = !!q.body?.active; save(users);
    if (!u.active) kill(u.key);
    record(u.active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true, user: pub(u) });
  });
  app.post('/api/admin/users/:key/password', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key), pw = String(q.body?.password || '');
    if (!u || pw.length < 8) return s.status(400).json({ ok: false });
    u.pw = hash(pw); u.failCount = 0; u.lockedUntil = 0; save(users); kill(u.key);
    record('PASSWORD_RESET', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true });
  });
  app.delete('/api/admin/users/:key', requireAuth, requireMaster, (q, s) => {
    const users = load(), u = users.find(x => x.key === q.params.key);
    if (!u || isMaster(u)) return s.status(400).json({ ok: false });
    save(users.filter(x => x.key !== u.key)); kill(u.key);
    record('USER_DELETED', q.user.name, u.name, q.ip); broadcastUsers(); s.json({ ok: true });
  });
  app.get('/api/admin/login-history', requireAuth, requireMaster, (_q, s) => s.json(history.slice(0, 200)));
}
