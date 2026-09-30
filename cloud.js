// Free-tier persistence: mirrors data/*.json to Upstash Redis (free plan) so nothing is lost
// when a free host (Render free) restarts or sleeps. Optional — without the two env vars it does nothing.
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.env.UPSTASH_REDIS_REST_URL, TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
export const enabled = !!(URL_ && TOK);
const files = {
  users: path.resolve(process.env.USERS_FILE || './data/users.json'),
  platform: path.resolve(process.env.DATA_FILE || './data/platform.json')
};
async function cmd(args) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error('Upstash ' + r.status);
  return (await r.json()).result;
}
// Restore on boot, before auth/store read their files.
if (enabled) {
  for (const [k, f] of Object.entries(files)) {
    if (fs.existsSync(f)) continue;
    try {
      const v = await cmd(['GET', 'onelink:' + k]);
      if (v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); console.log('Restored', k, 'from Upstash'); }
    } catch (e) { console.error('Upstash restore failed:', k, e.message); }
  }
} else console.warn('UPSTASH_REDIS_REST_URL/TOKEN not set — data lives only on local disk.');

export const kvGet = k => enabled ? cmd(['GET', k]) : Promise.resolve(null);
export const kvSet = (k, v) => enabled ? cmd(['SET', k, v]) : Promise.resolve(null);

const timers = {};
export function push(k, json) {
  if (!enabled) return;
  clearTimeout(timers[k]);
  timers[k] = setTimeout(() => cmd(['SET', 'onelink:' + k, json]).catch(e => console.error('Upstash backup failed:', k, e.message)), 400);
}
