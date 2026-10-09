// Fingerprint of a history request as ledger.json wrote it. A request still carrying the fingerprint of the ledger
// entry it was imported from has not been touched on the platform, so a newer ledger may replace it on start-up.
import crypto from 'node:crypto';

export const LEDGER_KEYS = ['id', 'by', 'company', 'person', 'purpose', 'zone', 'requested', 'approved', 'credited', 'status', 'date', 'docs', 'notes', 'paid', 'timeline'];
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v);
export const ledgerHash = r => crypto.createHash('sha256').update(canon(LEDGER_KEYS.map(k => r[k]))).digest('hex').slice(0, 20);
