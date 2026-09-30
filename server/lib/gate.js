// Signed proof that a client name passed the exact Zoho check.
// A fund request may only be created / checked when it carries a valid token
// whose name is byte-identical to the request's clientName.
import crypto from 'node:crypto';

const secret = () => {
  const s = process.env.VALIDATION_SECRET;
  if (!s || s.length < 32) throw Object.assign(new Error('VALIDATION_SECRET missing or shorter than 32 chars'), { code: 'ENV' });
  return s;
};
const b64 = b => Buffer.from(b).toString('base64url');
const TTL_MS = 30 * 60 * 1000;

export function issue(clientName, clientId, matchedIn) {
  const body = b64(JSON.stringify({ n: clientName, id: clientId, m: matchedIn, exp: Date.now() + TTL_MS }));
  const sig = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + sig;
}

export function verify(token, clientName) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, why: 'NO_TOKEN' };
  const [body, sig] = token.split('.');
  const want = b64(crypto.createHmac('sha256', secret()).update(body).digest());
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, why: 'BAD_SIGNATURE' };
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (p.exp < Date.now()) return { ok: false, why: 'EXPIRED' };
  if (p.n !== clientName) return { ok: false, why: 'NAME_MISMATCH' };
  return { ok: true, clientId: p.id, matchedIn: p.m };
}

// One attempt per session: a failed name locks the session until it restarts.
const locks = new Map(); // sessionId -> { name, at }
export const lock = (sid, name) => sid && locks.set(sid, { name, at: new Date().toISOString() });
export const locked = sid => (sid && locks.get(sid)) || null;
export const unlock = sid => sid && locks.delete(sid);
