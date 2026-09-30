// Zoho OAuth refresh + Books contact lookup + Analytics balance row.
// Client identity is EXACT-match only: spelling, spacing, punctuation and case.
import { kvGet, kvSet } from './cloud.js';
const E = process.env;
const dc = () => E.ZOHO_DC || 'com';
let token = null, tokenExp = 0, rt = E.ZOHO_REFRESH_TOKEN || null;

// One-time bootstrap: exchange a 10-minute Self Client code (ZOHO_GRANT_CODE) for a permanent
// refresh token, kept in Upstash so it survives restarts. Never logged.
export const zohoReady = (async () => {
  if (rt) return 'env';
  try { rt = await kvGet('onelink:zoho_rt'); } catch {}
  if (rt) return 'stored';
  if (!E.ZOHO_GRANT_CODE || !E.ZOHO_CLIENT_ID || !E.ZOHO_CLIENT_SECRET) return 'none';
  const q = new URLSearchParams({ code: E.ZOHO_GRANT_CODE, client_id: E.ZOHO_CLIENT_ID, client_secret: E.ZOHO_CLIENT_SECRET, grant_type: 'authorization_code' });
  try {
    const j = await (await fetch(`https://accounts.zoho.${dc()}/oauth/v2/token?${q}`, { method: 'POST' })).json();
    if (j.refresh_token) { rt = j.refresh_token; await kvSet('onelink:zoho_rt', rt).catch(() => {}); console.log('Zoho: grant code exchanged, refresh token stored.'); return 'exchanged'; }
    console.error('Zoho: grant code exchange failed —', j.error || 'no refresh_token (code expired or already used?)');
  } catch (e) { console.error('Zoho: grant code exchange error —', e.message); }
  return 'failed';
})();

export async function accessToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  await zohoReady;
  const need = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'].filter(k => !E[k]);
  if (!rt) need.push('ZOHO_REFRESH_TOKEN (or a fresh ZOHO_GRANT_CODE)');
  if (need.length) throw Object.assign(new Error('Missing env: ' + need.join(', ')), { code: 'ENV' });
  const q = new URLSearchParams({ refresh_token: rt, client_id: E.ZOHO_CLIENT_ID, client_secret: E.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' });
  const res = await fetch(`https://accounts.zoho.${dc()}/oauth/v2/token?${q}`, { method: 'POST' });
  const j = await res.json();
  if (!j.access_token) throw Object.assign(new Error('Zoho OAuth refresh failed: ' + (j.error || res.status)), { code: 'AUTH' });
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// Strict equality — no trimming, no case folding, no fuzzy matching, no guessing.
export const exact = (list, name, ...getters) => list.find(x => getters.some(g => g(x) === name)) || null;

// Loose normaliser — used ONLY for the relevance check, never for identity.
export const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function booksFindContactExact(name) {
  if (!E.ZOHO_BOOKS_ORG_ID) return { skipped: true };
  const t = await accessToken();
  const q = new URLSearchParams({ organization_id: E.ZOHO_BOOKS_ORG_ID, search_text: name, per_page: '200' });
  const res = await fetch(`https://www.zohoapis.${dc()}/books/v3/contacts?${q}`, { headers: { Authorization: 'Zoho-oauthtoken ' + t } });
  if (!res.ok) throw Object.assign(new Error('Zoho Books ' + res.status), { code: 'BOOKS' });
  const j = await res.json();
  const hit = exact(j.contacts || [], name, c => c.contact_name, c => c.company_name);
  return hit ? { contactId: hit.contact_id, contactName: hit.contact_name, companyName: hit.company_name } : null;
}

export async function analyticsFindClientExact(name) {
  if (!E.ZOHO_VIEW_ID) return null; // balance table not shared yet — Books alone validates identity
  const need = ['ZOHO_ORG_ID', 'ZOHO_WORKSPACE_ID', 'ZOHO_VIEW_ID'].filter(k => !E[k]);
  if (need.length) throw Object.assign(new Error('Missing env: ' + need.join(', ')), { code: 'ENV' });
  const t = await accessToken();
  const C = col();
  const esc = s => String(s).replace(/'/g, "''");
  const crit = `("${C.client}" = '${esc(name)}' or "${C.company}" = '${esc(name)}')`;
  const config = JSON.stringify({ responseFormat: 'json', criteria: crit });
  const url = `https://analyticsapi.zoho.${dc()}/restapi/v2/workspaces/${E.ZOHO_WORKSPACE_ID}/views/${E.ZOHO_VIEW_ID}/data?CONFIG=${encodeURIComponent(config)}`;
  const res = await fetch(url, { headers: { Authorization: 'Zoho-oauthtoken ' + t, 'ZANALYTICS-ORGID': E.ZOHO_ORG_ID } });
  if (res.status === 429) throw Object.assign(new Error('Zoho Analytics rate limit'), { code: 'RATE' });
  if (!res.ok) throw Object.assign(new Error('Zoho Analytics ' + res.status + ' ' + (await res.text()).slice(0, 200)), { code: 'ANALYTICS' });
  const j = await res.json();
  const rows = j.data || (j.response && j.response.result && j.response.result.rows) || [];
  // Analytics criteria can be case-insensitive — re-check strictly here.
  const hit = exact(rows, name, r => r[C.client], r => r[C.company]);
  return hit ? toRecord(hit) : null;
}

export function col() {
  return {
    client: E.ZA_COL_CLIENT || 'Client Name', company: E.ZA_COL_COMPANY || 'Company Name', id: E.ZA_COL_CLIENT_ID || 'Client ID',
    allocated: E.ZA_COL_ALLOCATED || 'Allocated', used: E.ZA_COL_USED || 'Used',
    available: E.ZA_COL_AVAILABLE || 'Available Balance', categories: E.ZA_COL_CATEGORIES || 'Categories'
  };
}
const num = v => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
export function toRecord(r) {
  const C = col();
  return {
    clientId: r[C.id] || null, clientName: r[C.client] || '', companyName: r[C.company] || '',
    allocated: num(r[C.allocated]), used: num(r[C.used]),
    available: r[C.available] !== undefined ? num(r[C.available]) : num(r[C.allocated]) - num(r[C.used]),
    categories: String(r[C.categories] || '').split(',').map(s => s.trim()).filter(Boolean)
  };
}
