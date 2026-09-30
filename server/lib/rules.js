// The approval rules, in one pure function so they can be unit-tested.
import { norm } from './zoho.js';

export const STATUS = {
  APPROVED: 'Approved (Pending Sven Final Check)',
  PARTIAL: 'Partially Approved',
  NOT: 'Not Approved'
};

// Relevance: the purpose must fall in a category the client's MCP ledger covers,
// and the request's company must belong to the matched client record.
export function relevance(req, rec) {
  const p = norm(req.purpose);
  const catOk = !rec.categories.length || rec.categories.some(c => { const n = norm(c); return n && (p.includes(n) || n.includes(p)); });
  const co = norm(req.company), rc = norm(rec.companyName), rn = norm(rec.clientName);
  const coOk = !co || !rc || co.includes(rc) || rc.includes(co) || co.includes(rn) || rn.includes(co);
  return { ok: catOk && coOk, catOk, coOk };
}

export function decide({ req, books, rec }) {
  const requested = Number(req.requestedAmount) || 0;
  const booksMatched = !!(books && !books.skipped);
  const analyticsMatched = !!rec;
  const base = { requested, booksMatched, analyticsMatched, booksContactId: booksMatched ? books.contactId : null };

  // 1. Client name must exist in Zoho Books OR Zoho Analytics.
  if (!booksMatched && !analyticsMatched) return { ...base, ok: false, clientMatched: false, relevancePassed: false, reason: 'CLIENT_NOT_FOUND', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: 'Client name not found in Zoho Books or Zoho Analytics — rejected.' };
  // Balance only lives in Analytics; a Books-only match has no balance to release against.
  if (!analyticsMatched) return { ...base, ok: false, clientMatched: true, relevancePassed: false, available: 0, reason: 'NO_ANALYTICS_RECORD', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: 'Client exists in Zoho Books but has no balance record in Zoho Analytics.' };

  const out = { ...base, clientMatched: true, clientId: rec.clientId, companyName: rec.companyName || req.company, available: rec.available, allocated: rec.allocated, used: rec.used };

  // 3. Relevance to the client's MCP data.
  const rel = relevance(req, rec);
  if (!rel.ok) return { ...out, ok: false, relevancePassed: false, remaining: rec.available, reason: 'NOT_RELEVANT', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: !rel.catOk ? `Purpose "${req.purpose}" is not a category on the client's ledger (${rec.categories.join(', ')}).` : `Company "${req.company}" does not belong to this client record.` };

  // 2/4/5. Balance.
  if (rec.available <= 0) return { ...out, ok: false, relevancePassed: true, remaining: 0, reason: 'ZERO_AVAILABLE_BALANCE', approvalStatus: STATUS.NOT, approvedAmount: 0, flagSven: true, notes: 'Zero client balance in Zoho Analytics.' };
  if (rec.available < requested) return { ...out, ok: true, partialOnly: true, relevancePassed: true, remaining: 0, reason: 'PARTIAL_BALANCE', approvalStatus: STATUS.PARTIAL, approvedAmount: rec.available, flagSven: true, notes: `Capped at available balance ${rec.available}; ${requested - rec.available} short. Needs Sven final confirmation.` };
  return { ...out, ok: true, relevancePassed: true, remaining: rec.available - requested, reason: 'VALIDATION_PASSED', approvalStatus: STATUS.APPROVED, approvedAmount: requested, flagSven: true, notes: 'Full balance available. Pending Sven final check.' };
}
