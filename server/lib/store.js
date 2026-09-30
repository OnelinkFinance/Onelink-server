// Shared, persistent platform data + real-time push (Server-Sent Events).
// Every signed-in browser reads the same data and receives every change the moment it happens.
import fs from 'node:fs';
import path from 'node:path';
import { push } from './cloud.js';
import { requireAuth, isMaster, setBroadcast, load as loadUsers, pub } from './auth.js';

const FILE = path.resolve(process.env.DATA_FILE || './data/platform.json');
const COLS = ['requests', 'chat', 'notifications', 'audit'];
let db = { rev: 0, requests: [], chat: [], notifications: [], audit: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
let saveT = null;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); push('platform', JSON.stringify(db)); }, 150); };

const clients = new Set(); // { res, user }
const ops = u => u.dept === 'OPERATIONS' && !isMaster(u);
// What each user may see
function visible(u, col, item) {
  if (isMaster(u)) return true;
  if (col === 'requests') return !ops(u) || item.by === u.key;
  if (col === 'notifications') return item.to === u.key;
  if (col === 'audit') return u.dept === 'MANAGEMENT';
  return true; // chat: shared group thread
}
function send(c, ev) { c.res.write(`data: ${JSON.stringify(ev)}\n\n`); }
function broadcast(ev, col, item) {
  for (const c of clients) {
    if (ev.type === 'login' && !isMaster(c.user)) continue;
    if (ev.type === 'accounts' && !isMaster(c.user)) continue;
    if (col && item && !visible(c.user, col, item)) continue;
    send(c, ev);
  }
}
setBroadcast(ev => {
  if (ev.type === 'reset-request') {
    const item = { id: 'r' + Date.now().toString(36), to: 'sven', text: 'Password reset requested by ' + ev.user.name + ' (' + ev.user.username + '). Set a temporary password in Users.', at: new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), read: false, req: null };
    upsert('notifications', item);
    return broadcast({ type: 'put', col: 'notifications', item, rev: db.rev, by: 'system' }, 'notifications', item);
  }
  broadcast(ev);
});

// Write rules — enforced here, not in the browser
function mayWrite(u, col, item, prev) {
  if (isMaster(u)) return true;
  if (col === 'requests') {
    if (ops(u)) return item.by === u.key && (!prev || prev.by === u.key) && (!prev || prev.status === item.status || ['NEW', 'ACTION'].includes(item.status) || (prev.status === 'CREDITED' && item.status === 'PAID'));
    return (u.perms || []).some(p => ['APPROVE_REQUEST', 'DECLINE_REQUEST', 'CREDIT_FUNDS', 'RELEASE_FUNDS', 'PARTIAL_APPROVE_REQUEST'].includes(p)) || u.dept === 'MANAGEMENT' || u.dept === 'FINANCE';
  }
  if (col === 'chat') return !prev && item.who === u.key;
  if (col === 'notifications') return !prev || prev.to === u.key; // create for anyone, mark own as read
  if (col === 'audit') return !prev;
  return false;
}

function upsert(col, item) {
  const list = db[col], i = list.findIndex(x => x.id === item.id);
  const prev = i >= 0 ? list[i] : null;
  if (i >= 0) list[i] = item; else list.unshift(item);
  if (col === 'audit' && list.length > 5000) list.length = 5000;
  db.rev++; persist();
  return prev;
}

export function mount(app) {
  app.get('/api/sync/snapshot', requireAuth, (q, s) => {
    const u = q.user, out = { rev: db.rev, me: pub(u), empty: db.requests.length === 0 };
    for (const c of COLS) out[c] = db[c].filter(x => visible(u, c, x));
    out.accounts = loadUsers().map(pub);
    s.json(out);
  });

  // First Master Admin sign-in uploads the existing workbook when the server is empty.
  app.post('/api/sync/bootstrap', requireAuth, (q, s) => {
    if (!isMaster(q.user)) return s.status(403).json({ ok: false });
    if (db.requests.length) return s.status(409).json({ ok: false, error: 'Server already has data' });
    for (const c of COLS) if (Array.isArray(q.body?.[c])) db[c] = q.body[c];
    db.rev++; persist();
    broadcast({ type: 'reload' });
    s.json({ ok: true, rev: db.rev });
  });

  app.post('/api/sync/put', requireAuth, (q, s) => {
    const { col, item } = q.body || {};
    if (!COLS.includes(col) || !item || typeof item.id !== 'string') return s.status(400).json({ ok: false, error: 'col + item.id required' });
    const prev = db[col].find(x => x.id === item.id) || null;
    if (!mayWrite(q.user, col, item, prev)) return s.status(403).json({ ok: false, error: 'Not permitted' });
    upsert(col, item);
    broadcast({ type: 'put', col, item, rev: db.rev, by: q.user.key }, col, item);
    s.json({ ok: true, rev: db.rev });
  });

  app.get('/api/sync/stream', requireAuth, (q, s) => {
    s.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    s.flushHeaders();
    const c = { res: s, user: q.user };
    clients.add(c);
    send(c, { type: 'hello', rev: db.rev, online: clients.size });
    const hb = setInterval(() => s.write(`: hb ${Date.now()}\n\n`), 20000);
    q.on('close', () => { clearInterval(hb); clients.delete(c); });
  });

  app.get('/api/sync/health', (_q, s) => s.json({ ok: true, rev: db.rev, online: clients.size }));
}
