// Funding-request workflow patches for the Claude Design export (index.html).
// Applied to the decoded page template as it is served, so index.html stays the untouched export.
//
//   1. Client field is a live Zoho Books type-ahead: 2+ letters → matching clients → pick one.
//      Typed names are never accepted; no match shows "Client not found in Zoho Books. Cannot proceed."
//   2. Picking a client reads its balance from Zoho Analytics straight away, and the amount field
//      compares against it as the user types.
//   3. Send: mandatory fields (company from a dropdown, purpose, amount, "client already paid us?"), then a
//      server pre-check — the client must not already have a request pending Sven's approval, and its Zoho
//      Analytics balance must cover the amount. Operations never see the balance, only the outcome.
//      A request that passes is "Pending Sven Approval"; the server writes the chat export and sheet row.
//   4. Notifications open the request inline, inside the Updates panel — no page or tab change.
//
// Each rule is either [from, to] (exact text, must occur once) or { start, end, to } (replaces the
// text from `start` up to, not including, `end`). If any rule misses, none are applied — a new export
// is served as-is rather than half-patched (the server still refuses typed client names).

const NOT_FOUND = 'Client not found in Zoho Books. Cannot proceed.';
const INSUFFICIENT = 'Client does not have sufficient balance in Zoho Analytics. Flagging Sven for review.';
const PROVISIONAL = 'Pending Sven Approval';
const MANDATORY = 'All mandatory fields must be completed before submitting the request.';

const CLIENT_FIELD_FROM = `              <label>Client name — exactly as it appears in Zoho Books or Zoho Analytics</label>
              <div style="display:flex; gap:8px; flex-wrap:wrap">
                <input class="input" placeholder="Al Saadi Auditing" value="{{ gate.name }}" sc-camel-on-change="{{ gate.onName }}" sc-camel-on-key-down="{{ gate.onKey }}" autocomplete="off" spellcheck="false" style="flex:1; min-width:200px; border-radius:12px; border-color:{{ gate.inputBd }}">`;

const CLIENT_FIELD_TO = `              <label>Client — start typing, then pick the client from Zoho Books</label>
              <div style="position:relative">
                <input class="input" placeholder="Type 2+ letters of the client or company name" value="{{ gate.name }}" sc-camel-on-change="{{ gate.onName }}" sc-camel-on-key-down="{{ gate.onKey }}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="{{ gate.showList }}" disabled="{{ gate.checking }}" style="width:100%; box-sizing:border-box; border-radius:12px; border-color:{{ gate.inputBd }}">
                <sc-if value="{{ gate.showList }}" hint-placeholder-val="{{ false }}">
                  <div role="listbox" style="position:absolute; z-index:30; left:0; right:0; top:calc(100% + 6px); max-height:280px; overflow:auto; border-radius:14px; background:var(--sf); border:1px solid var(--line); box-shadow:0 14px 34px rgba(16,38,66,.16); padding:6px; animation:popIn .18s ease">
                    <sc-for list="{{ gate.suggestions }}" as="sg" hint-placeholder-count="4">
                      <button type="button" role="option" aria-selected="{{ sg.active }}" sc-camel-on-click="{{ sg.pick }}" class="btn" style="width:100%; justify-content:flex-start; text-align:left; gap:10px; padding:9px 11px; border-radius:10px; background:{{ sg.bg }}; border:none; color:var(--ink); min-height:0" style-hover="background:var(--sf2)">
                        <i class="ph ph-buildings" style="font-size:15px; color:var(--mut2)"></i>
                        <span style="display:flex; flex-direction:column; gap:1px; min-width:0">
                          <span style="font-size:13px">{{ sg.name }}</span>
                          <span style="font-size:11px; color:var(--mut3)">{{ sg.sub }}</span>
                        </span>
                      </button>
                    </sc-for>
                  </div>
                </sc-if>
              </div>
              <sc-if value="{{ gate.notFound }}" hint-placeholder-val="{{ false }}">
                <div role="alert" style="display:flex; align-items:center; gap:8px; margin-top:8px; padding:10px 12px; border-radius:12px; background:var(--chipRedBg); border:1px solid var(--chipRedBd); color:var(--fgRedDeep); font-size:12.5px"><i class="ph ph-prohibit" style="font-size:15px"></i>{{ gate.notFoundMsg }}</div>
              </sc-if>
              <div style="display:none">`;

const OK_LINE = `<span style="font-size:11px; color:var(--mut2)">{{ gate.okLine }}</span>`;

const AMOUNT_INPUT = `<input class="input" placeholder="12520" value="{{ form.amount }}" sc-camel-on-change="{{ onForm.amount }}" style="border-radius:12px; text-align:right; border-color:{{ err.amountBd }}">`;

const FAILED_TEXT = `<span style="font-size:13px; color:var(--fgRedDeep); line-height:1.5">Client name not found in Zoho Books or Zoho Analytics. Fund request cannot be created.</span>`;

const GATE_JS = `  verifyClient() {
    const g = this.gate();
    if (g.status === 'ok' || g.status === 'checking' || g.status === 'failed') return;
    const list = g.results || [];
    if (list.length === 1) return this.pickClient(list[0]);
    this.setState({ gate: Object.assign({}, g, { hintErr: list.length ? 'Pick the client from the Zoho Books list.' : 'Type at least two letters, then pick the client from the Zoho Books list.' }) });
  }
  zohoApiUrl(p) { return this.zohoEndpoint().replace(/\\/client-funding-check\\/?$/, p); }
  zohoHeaders(json) { return Object.assign(json ? { 'Content-Type': 'application/json' } : {}, this._token ? { Authorization: 'Bearer ' + this._token } : {}); }
  /* Live Zoho Books type-ahead — debounced, stale answers ignored. */
  typeClient(v) {
    const g = this.gate();
    if (g.status === 'ok' || g.status === 'checking' || g.status === 'failed') return;
    const term = v.trim(), seq = (this._zSeq || 0) + 1;
    this._zSeq = seq;
    clearTimeout(this._zT);
    this.setState({ gate: Object.assign({}, g, { name: v, status: 'idle', results: [], notFound: false, searching: term.length >= 2, active: 0, hintErr: '', error: '', lockMsg: '', lockRef: '' }) });
    if (term.length < 2) return;
    this._zT = setTimeout(() => {
      fetch(this.zohoApiUrl('/clients') + '?q=' + encodeURIComponent(term), { mode: 'cors', credentials: 'include', headers: this.zohoHeaders(false) })
        .then(r => r.json().then(j => ({ st: r.status, j: j })))
        .then(o => {
          if (seq !== this._zSeq) return;
          if (o.st !== 200 || !o.j.ok) throw new Error(o.j.error || 'HTTP ' + o.st);
          const res = o.j.clients || [];
          this.setState({ gate: Object.assign({}, this.gate(), { results: res, notFound: res.length === 0, searching: false, active: 0 }) });
        })
        .catch(err => { if (seq === this._zSeq) this.setState({ gate: Object.assign({}, this.gate(), { status: 'error', searching: false, results: [], error: 'Zoho Books could not be reached (' + err.message + '). Nothing was created — try again when the connection is back.' }) }); });
    }, 250);
  }
  /* A client picked from the list: the server re-reads it from Zoho Books by id and returns its Zoho Analytics balance. */
  pickClient(c) {
    const g = this.gate();
    if (!c || g.status === 'ok' || g.status === 'checking' || g.status === 'failed') return;
    clearTimeout(this._zT); this._zSeq = (this._zSeq || 0) + 1;
    this.setState({ gate: Object.assign({}, g, { name: c.contactName, status: 'checking', results: [], notFound: false, searching: false, hintErr: '' }) });
    fetch(this.zohoApiUrl('/validate-client'), { method: 'POST', mode: 'cors', credentials: 'include', headers: this.zohoHeaders(true), body: JSON.stringify({ contactId: c.contactId }), signal: this.zohoTimeout(30000) })
      .then(r => r.json().then(j => ({ st: r.status, j: j })))
      .then(o => {
        if (o.st === 200 && o.j.found === true) {
          this.logAudit('CLIENT_VALIDATED', o.j.clientName + ' — selected from Zoho Books (' + o.j.clientId + ')', null, o.j.clientName);
          this.setState(s => ({
            gate: { name: o.j.clientName, companyName: o.j.companyName || '', status: 'ok', at: this.now(), clientId: o.j.clientId, matchedIn: o.j.matchedIn, token: o.j.token, balance: o.j.balance || null },
            form: Object.assign({}, s.form || this.blankForm(), { company: o.j.companyName || o.j.clientName })
          }));
          if (o.j.balance && o.j.balance.pending) this.loadBalance(o.j.clientId);
          return;
        }
        if (o.st === 409 && o.j.locked) { // this client already has a request waiting for Sven
          this.logAudit('REQUEST_BLOCKED', '“' + c.contactName + '” — ' + (o.j.pendingId || 'a request') + ' is still pending Sven’s approval', null, c.contactName);
          return this.setState({ gate: { name: '', status: 'idle', results: [], hintErr: '', lockMsg: o.j.error, lockRef: o.j.pendingId || '' } });
        }
        if (o.st === 422 || o.st === 423) {
          this.logAudit('CLIENT_VALIDATION_FAILED', '“' + c.contactName + '” is not an active Zoho Books client — request blocked', null, c.contactName);
          return this.setState({ gate: { name: c.contactName, status: 'failed', at: this.now() }, form: null, formDocs: [], errors: {}, askNoDoc: false });
        }
        throw new Error(o.j.error || 'HTTP ' + o.st);
      })
      .catch(err => this.setState({ gate: Object.assign({}, this.gate(), { status: 'error', error: 'Zoho could not be reached (' + err.message + '). Nothing was created — try again when the connection is back.' }) }));
  }
  zohoTimeout(ms) { return (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined; }
  /* Balance still loading when the client was confirmed: fetch it on its own; the form stays usable meanwhile. */
  loadBalance(contactId) {
    const done = b => { const g = this.gate(); if (g.status === 'ok' && g.clientId === contactId) this.setState({ gate: Object.assign({}, g, { balance: b }) }); };
    fetch(this.zohoApiUrl('/client-balance') + '?contactId=' + encodeURIComponent(contactId), { mode: 'cors', credentials: 'include', headers: this.zohoHeaders(false), signal: this.zohoTimeout(40000) })
      .then(r => r.json().then(j => ({ st: r.status, j: j })))
      .then(o => done(o.st === 200 && o.j.balance ? o.j.balance : { found: false, error: o.j.error || 'HTTP ' + o.st }))
      .catch(err => done({ found: false, error: err.message }));
  }
  /* The selected client's Zoho Analytics balance against the amount being typed. */
  balanceInfo() {
    const g = this.gate();
    if (g.status !== 'ok') return {};
    const b = g.balance, amt = Number((this.state.form || this.blankForm()).amount) || 0, out = {};
    if (b && b.hidden) { // Operations: the balance is checked on the server, never shown
      out.line = 'The Zoho Analytics balance is validated in the background when you send.'; out.fg = 'var(--mut2)';
      return out;
    }
    if (b && b.pending) {
      out.line = 'Reading the balance from Zoho Analytics…'; out.fg = 'var(--mut2)';
      if (amt > 0) { out.amountLine = 'Checking against the Zoho Analytics balance…'; out.amountFg = 'var(--mut2)'; out.amountIcon = 'ph ph-hourglass'; }
      return out;
    }
    if (!b || b.error) {
      out.line = 'Zoho Analytics balance could not be read — it is validated again when the request is sent.'; out.fg = 'var(--fgAmberDeep)';
    } else if (!b.found) {
      out.line = 'No balance for this client in Zoho Analytics (AED 0).'; out.fg = 'var(--fgRed)';
    } else {
      out.line = 'Zoho Analytics balance: ' + this.fmt(b.available) + ' available'; out.fg = b.available > 0 ? 'var(--fgGreen)' : 'var(--fgRed)';
    }
    if (amt > 0) {
      if (!b || b.error) { out.amountLine = 'The balance is validated in Zoho Analytics when you send.'; out.amountFg = 'var(--fgAmberDeep)'; out.amountIcon = 'ph ph-hourglass'; }
      else if (!b.found || b.available <= 0 || b.available < amt) { out.amountLine = '${INSUFFICIENT}'; out.amountFg = 'var(--fgRed)'; out.amountIcon = 'ph ph-flag'; }
      else { out.amountLine = 'Within the Zoho Analytics balance — will be ${PROVISIONAL}.'; out.amountFg = 'var(--fgGreen)'; out.amountIcon = 'ph ph-seal-check'; }
    }
    return out;
  }
  /* Send, step 1: ask the server whether this client is free (no request pending Sven) and whether its Zoho
     Analytics balance covers the amount. It answers with a one-time pass the new request must carry. */
  precheck(force) {
    const g = this.gate(), f = this.state.form || this.blankForm(), amount = Number(f.amount);
    if (this._prechecking) return;
    this._prechecking = true;
    this.setState({ askNoDoc: false });
    this.flash('Checking the client in Zoho Analytics…', null, 'ph ph-hourglass');
    fetch(this.zohoApiUrl('/precheck'), { method: 'POST', mode: 'cors', credentials: 'include', headers: this.zohoHeaders(true), body: JSON.stringify({ validationToken: g.token, clientName: g.name, amount: amount }), signal: this.zohoTimeout(40000) })
      .then(r => r.json().then(j => ({ st: r.status, j: j })))
      .then(o => {
        this._prechecking = false;
        if (o.st === 200 && o.j.ok && o.j.submitToken) { this._pre = { token: g.token, amount: amount, submitToken: o.j.submitToken }; return this.send(force); }
        const msg = o.j.error || ('The balance check failed (HTTP ' + o.st + '). Nothing was sent.');
        this.setState(s => ({ errors: Object.assign({}, s.errors, { summary: msg }), shake: s.shake + 1, askNoDoc: false }));
        this.flash(msg, null, o.j.reason === 'INSUFFICIENT_BALANCE' ? 'ph ph-flag' : 'ph ph-prohibit');
      })
      .catch(err => {
        this._prechecking = false;
        const msg = 'Zoho could not be reached (' + err.message + '). Nothing was sent — try again.';
        this.setState(s => ({ errors: Object.assign({}, s.errors, { summary: msg }) }));
        this.flash(msg, null, 'ph ph-plugs');
      });
  }
  /* The server refused a new request (e.g. another one for this client landed first): take it back off this screen. */
  rejectRequest(id, error) {
    this.setState(s => ({ requests: s.requests.filter(r => r.id !== id), route: s.reqId === id ? 'board' : s.route, reqId: s.reqId === id ? null : s.reqId }));
    this.flash(error || 'The server refused this request — nothing was submitted.', null, 'ph ph-prohibit');
  }
  /* A notification opens its request right inside the Updates panel — the page and tab stay where they are. */
  peekVals(isOps) {
    const s = this.state, back = () => this.setState({ peekId: null, peekMissing: false });
    if (!s.peekId && !s.peekMissing) return { open: false, closed: true };
    const r = s.peekId ? this.reqById(s.peekId) : null;
    if (!r) return { open: true, closed: false, found: false, missing: true, back: back, missingText: 'This request is not on the platform — it was not submitted, or it has been removed.', full: back };
    const u = this.users()[r.by], open = ['NEW', 'ACTION'].indexOf(r.status) >= 0;
    const facts = [
      { label: 'Purpose', value: r.purpose || '—' },
      { label: 'Client already paid us?', value: r.paid || '—' },
      { label: 'Zoho Analytics', value: r.zohoStatus ? r.zohoStatus + (!isOps && typeof r.zohoBalance === 'number' ? ' · balance ' + this.fmt(r.zohoBalance) : '') : 'Not checked yet' },
      { label: 'Freezone', value: r.zone || '—' },
      { label: 'Documents', value: (r.docs || []).length ? (r.docs || []).length + ' attached' : 'None attached' },
      { label: 'Requested on', value: r.date || '—' }
    ].concat(r.notes ? [{ label: 'Notes', value: r.notes }] : []);
    return {
      open: true, closed: false, found: true, missing: false, back: back,
      id: r.id, status: this.statusMeta(r.status).label, company: r.company, client: (r.person && r.person !== '—') ? r.person : r.company,
      by: u ? u.name : r.by, amount: this.fmt(r.requested), facts: facts,
      history: (r.timeline || []).slice(-5).reverse().map(t => ({ at: t.at, text: t.text })),
      canDecide: !isOps && open && this.canApproveReq(r),
      approve: () => this.approveFull(r.id), ask: () => this.openModal('info', r.id), decline: () => this.openModal('decline', r.id),
      full: () => this.open(r.id)
    };
  }
  /* Runs right after a request is sent: live balance check, approval or flag. The server posts the
     result to the group chat, notifies Sven and writes the funding sheet row. */
  autoZohoCheck(req) {
    this.zohoCall(req).then(out => {
      const id = (this._idAlias && this._idAlias[req.id]) || req.id; // the server may have given it a new number
      if (!this.reqById(id)) return;
      const j = out.live ? out.json || {} : null;
      if (j && j.approvalStatus) {
        // The server attaches the result to the request and pushes it to every screen (Sven's included).
        return this.flash(j.notes || j.approvalStatus, null, j.ok ? 'ph ph-seal-check' : 'ph ph-flag');
      }
      const why = j ? (j.error || 'no result') : this.zohoWhy(out.why, out.status)[0];
      this.apply(id, { flagged: true, zohoStatus: 'Not validated' }, 'Zoho balance check could not complete (' + why + ') — not approved, flagged for Sven',
        { to: 'sven', text: 'Zoho balance check could not complete for ' + req.company + ' (' + why + '). Validate before approving.' });
      this.flash('Zoho balance check could not complete — flagged for Sven', null, 'ph ph-warning');
    });
  }
`;

const GATE_VALS = `      gate: (() => {
        const bi = this.balanceInfo(), list = g.results || [], typed = (g.name || '').trim(), act = Math.min(g.active || 0, Math.max(0, list.length - 1));
        const nf = g.status === 'idle' && !!g.notFound && typed.length >= 2;
        return {
        name: g.name, status: g.status,
        canEdit: g.status === 'idle' || g.status === 'checking' || g.status === 'error',
        checking: g.status === 'checking', ok: g.status === 'ok', failed: g.status === 'failed',
        locked: g.status !== 'ok',
        lockLine: g.status === 'failed' ? 'Locked — this request cannot continue.' : 'The rest of the request unlocks once a client is picked from Zoho Books.',
        unreachable: g.status === 'error' ? g.error : false,
        showList: g.status === 'idle' && list.length > 0,
        suggestions: list.map((c, i) => ({
          name: c.contactName, sub: (c.pendingId ? 'Request Pending Approval · ' + c.pendingId + ' · ' : '') + (c.companyName && c.companyName !== c.contactName ? c.companyName + ' · ' : '') + 'Zoho Books · ' + c.contactId,
          active: i === act, bg: i === act ? 'var(--sf2)' : 'transparent', pick: () => this.pickClient(c)
        })),
        notFound: nf || !!g.lockMsg, notFoundMsg: g.lockMsg || '${NOT_FOUND}',
        companyOptions: [g.companyName, g.name].filter((v, i, a) => v && a.indexOf(v) === i),
        title: { idle: 'Who is this request for?', checking: 'Confirming in Zoho Books and reading the Zoho Analytics balance…', ok: 'Client selected from Zoho Books', failed: 'Client not found — workflow locked', error: 'Zoho could not be reached' }[g.status],
        icon: { idle: 'ph ph-magnifying-glass', checking: 'ph ph-circle-notch', ok: 'ph ph-seal-check', failed: 'ph ph-prohibit', error: 'ph ph-plugs' }[g.status],
        iconSpin: g.status === 'checking' || g.searching ? 'spin .9s linear infinite' : 'none',
        iconBg: g.status === 'ok' ? 'var(--chipGreenBg)' : g.status === 'failed' || nf ? 'var(--chipRedBg)' : 'var(--chipBlueBg)',
        iconFg: g.status === 'ok' ? 'var(--fgGreen)' : g.status === 'failed' || nf ? 'var(--fgRed)' : 'var(--fgBlue)',
        frame: g.status === 'ok' ? 'var(--fgGreen)' : g.status === 'failed' || nf ? 'var(--fgRed)' : 'var(--line)',
        anim: g.status === 'failed' ? 'none' : 'riseIn .26s ease',
        inputBd: g.hintErr || nf ? 'var(--fgRed)' : 'var(--line)',
        hint: g.hintErr || (g.lockRef ? 'Pending request: ' + g.lockRef + ' — pick another client, or wait for Sven’s approval.' : g.searching ? 'Searching Zoho Books…' : typed.length < 2 ? 'Type at least two letters — matching Zoho Books clients appear below. Typed names are not accepted.' : list.length ? list.length + ' Zoho Books match' + (list.length === 1 ? '' : 'es') + ' — pick one to continue.' : ''),
        hintFg: g.hintErr ? 'var(--fgRed)' : 'var(--mut3)',
        btnLabel: g.status === 'checking' ? 'Checking…' : 'Select',
        btnIcon: g.status === 'checking' ? 'ph ph-circle-notch' : 'ph ph-shield-check',
        source: 'Zoho Books + Analytics · live',
        okLine: (g.clientId || '—') + ' · ' + (g.matchedIn || 'Zoho Books') + ' · ' + (g.at || '') + ' · locked for this request',
        balanceLine: bi.line || '', balanceFg: bi.fg || 'var(--mut2)',
        amountCheck: bi.amountLine || false, amountFg: bi.amountFg || 'var(--mut2)', amountIcon: bi.amountIcon || 'ph ph-info',
        failLine: 'not an active client in Zoho Books · ' + (g.at || ''),
        onName: e => this.typeClient(e.target.value),
        onKey: e => {
          const n = list.length;
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) { e.preventDefault(); this.setState({ gate: Object.assign({}, this.gate(), { active: (act + (e.key === 'ArrowDown' ? 1 : n - 1)) % n }) }); }
          else if (e.key === 'Enter') { e.preventDefault(); if (n) this.pickClient(list[act]); else this.verifyClient(); }
          else if (e.key === 'Escape' && n) this.setState({ gate: Object.assign({}, this.gate(), { results: [] }) });
        },
        verify: () => this.verifyClient(),
        restart: () => this.restartRequest()
        };
      })(),
`;

export const TEMPLATE_RULES = [
  // markup — client field becomes a type-ahead; the old Verify button and hint are hidden in a display:none wrapper
  [CLIENT_FIELD_FROM, CLIENT_FIELD_TO],
  [OK_LINE, OK_LINE + `\n                <span style="font-size:12px; color:{{ gate.balanceFg }}">{{ gate.balanceLine }}</span>`],
  [AMOUNT_INPUT, AMOUNT_INPUT + `
            <sc-if value="{{ gate.amountCheck }}" hint-placeholder-val="{{ false }}">
              <div style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:{{ gate.amountFg }}; margin-top:5px"><i class="{{ gate.amountIcon }}" style="font-size:13px"></i>{{ gate.amountCheck }}</div>
            </sc-if>`],
  [FAILED_TEXT, FAILED_TEXT.replace('Client name not found in Zoho Books or Zoho Analytics. Fund request cannot be created.', NOT_FOUND)],

  // behaviour
  { start: '  verifyClient() {\n    const g = this.gate();', end: '  restartRequest() {', to: GATE_JS },
  { start: '      gate: {\n        name: g.name, status: g.status,\n', end: '      err: {\n        company: s.errors.company', to: GATE_VALS },
  ["return this.flash('Client name not found in Zoho Books or Zoho Analytics. Fund request cannot be created.', null, 'ph ph-prohibit');",
   `return this.flash('${NOT_FOUND}', null, 'ph ph-prohibit');`],
  ["    this.flash('Sent to finance — ' + id, null, 'ph ph-paper-plane-tilt');",
   "    this.flash('Sent to finance — ' + id + ' · checking the Zoho Analytics balance…', null, 'ph ph-paper-plane-tilt');\n    this.autoZohoCheck(req);"],
  // Sven's check uses the server's own wording; no mock fallback — no live answer means no approval
  { start: "            result.message = result.reason === 'VALIDATION_PASSED'", end: '            const w = this.zohoWhy(out.why, out.status);',
    to: "            result.message = result.notes || ('Zoho returned ' + result.reason + '.');\n          } else {\n" },
  ["    return reason === 'VALIDATION_PASSED' ? 'Approved (Pending Sven Final Check)' : reason === 'PARTIAL_BALANCE' ? 'Partially Approved' : 'Not Approved';",
   `    return reason === 'VALIDATION_PASSED' ? '${PROVISIONAL}' : (reason === 'INSUFFICIENT_BALANCE' || reason === 'NO_ANALYTICS_RECORD' || reason === 'NOT_RELEVANT') ? 'Flagged – Sven review' : 'Not Approved';`],
  ["zr.reason === 'CLIENT_NOT_FOUND' ? 'client not found in Zoho Books or Analytics'", "zr.reason === 'CLIENT_NOT_FOUND' ? 'client not found in Zoho Books'"],
  ["zr.reason === 'ZOHO_UNAVAILABLE' ? 'Zoho unreachable' : 'zero available client balance'),", "zr.reason === 'ZOHO_UNAVAILABLE' ? 'Zoho unreachable' : 'client does not have sufficient balance in Zoho Analytics'),"],

  // live balances only — the prototype's built-in balance book (zohoLookup) is no longer shown or used for decisions
  { start: '      const rec = this.zohoLookup(r.company);\n      const avail = rec.missing', end: '    }\n\n    const forced = this.p(\'layout\', \'Auto\');',
    to: `      const known = typeof r.zohoBalance === 'number', avail = known ? r.zohoBalance : 0;
      detail.zeroBalance = openStates.indexOf(r.status) >= 0 && known && avail < r.requested;
      detail.zeroLine = '${INSUFFICIENT} Requested ' + this.fmt(r.requested) + ' · Zoho Analytics balance ' + this.fmt(avail) + '.';
      detail.flagged = !!r.flagged;
      detail.flag = () => this.flagForSven(r.id, 'client does not have sufficient balance in Zoho Analytics');
      detail.balanceLine = known && !isOps ? 'Zoho Analytics balance ' + this.fmt(avail) + (r.zohoStatus ? ' · ' + r.zohoStatus : '') : r.zohoStatus ? 'Zoho Analytics check · ' + r.zohoStatus : 'Zoho Analytics balance not checked yet';
` },
  { start: '    const zeroList = s.requests.filter(', end: '      go: () => this.open(z.r.id)\n    }));',
    to: `    const zeroList = s.requests.filter(x => openStates.indexOf(x.status) >= 0 && typeof x.zohoBalance === 'number' && x.zohoBalance < x.requested)
      .map(x => ({ r: x, rec: {}, available: x.zohoBalance })); // rec kept: Master Control's tiles still read z.rec.missing
    const zeroAlerts = zeroList.slice(0, 6).map(z => ({
      client: z.r.person && z.r.person !== '—' ? z.r.person : z.r.company,
      company: z.r.company, by: uAll[z.r.by] ? uAll[z.r.by].name : z.r.by, amount: this.fmt(z.r.requested),
      balance: this.fmt(z.available),
      at: z.r.timeline[z.r.timeline.length - 1].at,
      reason: 'INSUFFICIENT_BALANCE',
      flagged: !!z.r.flagged,
      flag: () => this.flagForSven(z.r.id, 'client does not have sufficient balance in Zoho Analytics'),
` },
  ["      const bal = this.zohoLookup(r.company);\n      if (!bal.missing && amt > (Number(bal.available) || 0))",
   "      if (typeof r.zohoBalance !== 'number') return err('Run the Zoho check first — no approval without a balance validated in Zoho Analytics.');\n      const bal = { available: r.zohoBalance };\n      if (amt > (Number(bal.available) || 0))"],
  // approval and credit always need a live Zoho check (the Master Controls toggle can no longer switch it off)
  ["    if (this.state.settings.requireZohoBeforeApprove && !validated) return this.runZoho(id, 'approve');",
   `    if (!validated) return this.runZoho(id, 'approve');\n    if (validated.ok !== true || validated.partialOnly) return this.flash('${INSUFFICIENT}', null, 'ph ph-flag');`],
  ["    if (this.state.settings.recheckBeforeRelease && !validated) return this.runZoho(id, 'credit');",
   "    if (!validated) return this.runZoho(id, 'credit');"],
  ["      zeroLine: zeroList.length + (zeroList.length === 1 ? ' open request has no client balance in Zoho' : ' open requests have no client balance in Zoho'),",
   "      zeroLine: zeroList.length + (zeroList.length === 1 ? ' open request does not have sufficient balance in Zoho Analytics' : ' open requests do not have sufficient balance in Zoho Analytics'),"],
  // Master Control: accounts and sign-ins update instantly and survive a reload
  ["    return this.normAcct({ key: u.key, name: u.name, username: u.username, dept: u.dept, role: u.role, active: u.active, perms: u.perms || [], created: u.created, lastLogin: u.lastLogin || '—', locked: u.locked, pwHash: 'server' });",
   "    return this.normAcct({ key: u.key, name: u.name, username: u.username, dept: u.dept, role: u.role, active: u.active, perms: u.perms || [], created: u.created, lastLogin: u.lastLogin || '—', locked: u.locked, online: !!u.online, passwordSet: u.passwordSet || '—', pwHash: 'server' });"],
  ["      this._prevAccounts = next.accounts;\n      this.setState(next);\n    });\n  }",
   "      this._prevAccounts = next.accounts;\n      this.setState(next);\n      this._rev = Math.max(this._rev || 0, j.rev || 0);\n      if (isM) { this.loadLoginLog(); if (!this._revT) this._revT = setInterval(() => this.revCheck(), 20000); }\n    });\n  }\n  /* Safety net for the Master view: if the server holds changes this screen never received, reload them. */\n  revCheck() {\n    if (!this.state.authed || !this._token) return;\n    this.api('/api/sync/health').then(o => { if (o.ok && o.json.rev > (this._rev || 0)) this.liveLoad(false); }).catch(() => {});\n  }\n  /* Sign-in history from the server — Master Control shows it straight after a reload, not only new events. */\n  loadLoginLog() {\n    this.api('/api/admin/login-history').then(o => {\n      if (!o.ok || !Array.isArray(o.json)) return;\n      this.setState({ loginLog: o.json.map(x => ({ at: new Date(x.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), kind: x.kind, who: x.who, detail: x.detail })) });\n    }).catch(() => {});\n  }"],
  ["      this.flash(uf.mode === 'add' ? uf.name.trim() + ' can now sign in from any device' : 'Saved on the live server', null, 'ph ph-cloud-check');",
   "      this.flash(uf.mode === 'add' ? uf.name.trim() + ' can now sign in from any device' : 'Saved on the live server', null, 'ph ph-cloud-check');\n      this.liveLoad(false);"],
  ["    if (this.isLive()) return this.api('/api/admin/users/' + key + '/active', { method: 'POST', body: { active: on } }).then(o => this.flash(o.ok ? (this.users()[key].name + (on ? ' reactivated' : ' deactivated — signed out everywhere')) : 'The server refused the change', null, o.ok ? 'ph ph-cloud-check' : 'ph ph-prohibit'));",
   "    if (this.isLive()) return this.api('/api/admin/users/' + key + '/active', { method: 'POST', body: { active: on } }).then(o => { this.flash(o.ok ? (this.users()[key].name + (on ? ' reactivated' : ' deactivated — signed out everywhere')) : 'The server refused the change', null, o.ok ? 'ph ph-cloud-check' : 'ph ph-prohibit'); if (o.ok) this.liveLoad(false); });"],
  ["      if (this.isLive()) this.api('/api/admin/users/' + m.id, { method: 'DELETE' }).catch(() => {});",
   "      if (this.isLive()) this.api('/api/admin/users/' + m.id, { method: 'DELETE' }).then(() => this.liveLoad(false)).catch(() => {});"],
  ["          lastLogin: a.lastLogin, permCount:",
   "          lastLogin: a.lastLogin, liveLine: a.locked ? 'Locked — wrong passwords' : a.online ? '● Online now' : '', liveFg: a.locked ? 'var(--fgRed)' : 'var(--fgGreen)', pwSet: a.passwordSet || '—', permCount:"],
  ['<span style="width:118px; display:flex; flex-direction:column; gap:1px">\n                      <span style="font-size:11.5px; color:var(--ink3)">{{ ur.permCount }}</span>\n                      <span style="font-size:10.5px; color:var(--mut3)">seen {{ ur.lastLogin }}</span>',
   '<span style="width:150px; display:flex; flex-direction:column; gap:1px">\n                      <span style="font-size:11.5px; color:var(--ink3)">{{ ur.permCount }}</span>\n                      <span style="font-size:10.5px; color:{{ ur.liveFg }}">{{ ur.liveLine }}</span>\n                      <span style="font-size:10.5px; color:var(--mut3)">last sign-in {{ ur.lastLogin }}</span>\n                      <span style="font-size:10.5px; color:var(--mut3)">password set {{ ur.pwSet }}</span>'],
  // request numbers: follow the server when it had to give a new request a free number
  ["        this.api('/api/sync/put', { method: 'POST', body: { col: col, item: item } }).then(o => {",
   "        this.api('/api/sync/put', { method: 'POST', body: { col: col, item: item } }).then(o => {\n          if (col === 'requests' && o.json && o.json.renamed) this.renameRequest(item.id, o.json.renamed);"],
  ["  liveEvent(m) {\n",
   `  /* The server saved a new request under a free number (the one picked here already belonged to someone else). */
  renameRequest(oldId, newId) {
    this._idAlias = Object.assign({}, this._idAlias, { [oldId]: newId });
    // Only this screen's copy is renamed; the server already re-pointed everything else to the new number.
    this.setState(s => {
      const has = s.requests.some(r => r.id === newId);
      const requests = has ? s.requests.filter(r => r.id !== oldId) : s.requests.map(r => r.id === oldId ? Object.assign({}, r, { id: newId }) : r);
      return { requests: requests, reqId: s.reqId === oldId ? newId : s.reqId };
    });
    this.flash('Sent to finance — ' + newId, null, 'ph ph-paper-plane-tilt');
  }
  liveEvent(m) {
    if (m && typeof m.rev === 'number') this._rev = Math.max(this._rev || 0, m.rev);
`],
  // mandatory fields: company from a dropdown (the picked Zoho Books client), purpose, amount, "already paid?"
  ['            <label>Company name</label>\n            <input class="input" placeholder="Tiger Enterprises FZ-LLC" value="{{ form.company }}" sc-camel-on-change="{{ onForm.company }}" style="border-radius:12px; border-color:{{ err.companyBd }}">',
   '            <label>Company name * — from Zoho Books</label>\n            <sc-raw-select class="input" value="{{ form.company }}" sc-camel-on-change="{{ onForm.company }}" style="border-radius:12px; border-color:{{ err.companyBd }}">\n              <sc-for list="{{ gate.companyOptions }}" as="co" hint-placeholder-count="1"><option value="{{ co }}">{{ co }}</option></sc-for>\n            </sc-raw-select>'],
  ['<label>Purpose of payment</label>', '<label>Purpose of payment *</label>'],
  ['<label>Amount required (AED)</label>', '<label>Amount required (AED) *</label>'],
  ['            <label>Client already paid us?</label>\n            <sc-raw-select class="input" value="{{ form.paid }}" sc-camel-on-change="{{ onForm.paid }}" style="border-radius:12px">\n              <sc-for list="{{ paidOptions }}" as="p" hint-placeholder-count="4"><option value="{{ p }}">{{ p }}</option></sc-for>\n            </sc-raw-select>',
   '            <label>Client already paid us? *</label>\n            <sc-raw-select class="input" value="{{ form.paid }}" sc-camel-on-change="{{ onForm.paid }}" style="border-radius:12px; border-color:{{ err.paidBd }}">\n              <option value="">Select…</option>\n              <sc-for list="{{ paidOptions }}" as="p" hint-placeholder-count="4"><option value="{{ p }}">{{ p }}</option></sc-for>\n            </sc-raw-select>\n            <sc-if value="{{ err.paid }}" hint-placeholder-val="{{ false }}">\n              <div style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--fgRed); margin-top:5px"><i class="ph ph-warning-circle" style="font-size:13px"></i>{{ err.paid }}</div>\n            </sc-if>'],
  // "Already paid?" must be chosen; the date starts at today (the export had 17 Sep 2026 frozen in)
  ["paid: 'Yes — in full', date: '2026-09-17', notes: '' };", "paid: '', date: new Date().toISOString().slice(0, 10), notes: '' };"],
  // live "company → status" toast read statusMeta()[0], which is undefined (statusMeta returns an object)
  ["else if (col === 'requests') this.flash(item.company + ' → ' + this.statusMeta(item.status)[0], null, 'ph ph-arrows-clockwise');",
   "else if (col === 'requests') this.flash(item.company + ' → ' + this.statusMeta(item.status).label, null, 'ph ph-arrows-clockwise');"],
  { start: '  validate() {\n    const f = this.state.form || this.blankForm(), e = {};', end: '  send(force) {',
    to: `  validate() {
    const f = this.state.form || this.blankForm(), e = {};
    if (!String(f.company || '').trim()) e.company = 'Pick the company from the Zoho Books list.';
    if (!f.purpose.trim()) e.purpose = 'Say what the payment is for.';
    if (!f.amount.toString().trim()) e.amount = 'Enter the amount you need on the card.';
    else if (!Number(f.amount) || Number(f.amount) <= 0) e.amount = 'Use digits only, for example 12520.';
    if (!String(f.paid || '').trim()) e.paid = 'Choose whether the client has already paid us.';
    if (Object.keys(e).length) e.summary = '${MANDATORY}';
    return e;
  }
` },
  ["        company: s.errors.company || false, purpose: s.errors.purpose || false, amount: s.errors.amount || false,",
   "        company: s.errors.company || false, purpose: s.errors.purpose || false, amount: s.errors.amount || false, paid: s.errors.paid || false, paidBd: s.errors.paid ? 'var(--danger)' : 'var(--line)',"],
  // Send: balance pre-check first; the new request carries the server's one-time pass
  ["      return this.setState({ errors: {}, askNoDoc: true });\n    }\n    const f = this.state.form || this.blankForm(), me = this.me();",
   "      return this.setState({ errors: {}, askNoDoc: true });\n    }\n    const pre = this._pre, f0 = this.state.form || this.blankForm();\n    if (!pre || pre.token !== g.token || pre.amount !== Number(f0.amount)) return this.precheck(force);\n    this._pre = null;\n    const f = this.state.form || this.blankForm(), me = this.me();"],
  ["zohoClientId: g.clientId, zohoToken: g.token, purpose: f.purpose.trim(),", "zohoClientId: g.clientId, zohoToken: g.token, zohoSubmitToken: pre.submitToken, purpose: f.purpose.trim(),"],
  ["          if (col === 'requests' && o.json && o.json.renamed) this.renameRequest(item.id, o.json.renamed);",
   "          if (col === 'requests' && o.json && o.json.renamed) this.renameRequest(item.id, o.json.renamed);\n          if (col === 'requests' && o.json && o.json.reject) this.rejectRequest(item.id, o.json.error);"],
  // notifications open the request inline (Updates panel) — no route change, no tab switch
  ["          if (nn.req && this.reqById(nn.req)) this.open(nn.req);\n          else this.go('board', { tab: isOps ? 'tasks' : 'tasks' });",
   "          this.setState({ peekId: nn.req || null, peekMissing: !(nn.req && this.reqById(nn.req)) });"],
  ["      notifOpen: s.notifOpen, toggleNotif: () => this.setState({ notifOpen: !s.notifOpen }),",
   "      notifOpen: s.notifOpen, toggleNotif: () => this.setState({ notifOpen: !s.notifOpen, peekId: null, peekMissing: false }),"],
  ["go: () => this.setState({ userMenu: false, notifOpen: true }) }", "go: () => this.setState({ userMenu: false, notifOpen: true, peekId: null, peekMissing: false }) }"],
  ["      notifsEmpty: mineNotifs.length === 0,", "      notifsEmpty: mineNotifs.length === 0, peek: this.peekVals(isOps),"],
  ['        <div style="flex:1; overflow:auto; padding:12px">\n          <sc-for list="{{ notifs }}" as="n" hint-placeholder-count="3">',
   `        <sc-if value="{{ peek.open }}" hint-placeholder-val="{{ false }}">
          <div style="flex:1; overflow:auto; padding:14px 18px 18px; display:flex; flex-direction:column; gap:12px; animation:riseIn .2s ease">
            <button type="button" sc-camel-on-click="{{ peek.back }}" class="btn btn-ghost" style="align-self:flex-start; font-size:12px; padding-left:0"><i class="ph ph-arrow-left" style="font-size:14px"></i>All updates</button>
            <sc-if value="{{ peek.missing }}" hint-placeholder-val="{{ false }}">
              <div role="alert" style="padding:14px; border-radius:14px; background:var(--chipAmberBg); border:1px solid var(--chipAmberBd); color:var(--fgAmberDeep); font-size:12.5px; line-height:1.5">{{ peek.missingText }}</div>
            </sc-if>
            <sc-if value="{{ peek.found }}" hint-placeholder-val="{{ false }}">
              <div style="display:flex; flex-direction:column; gap:3px">
                <span style="font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; color:var(--mut3)">{{ peek.id }} · {{ peek.status }}</span>
                <span style="font-family:var(--font-heading); font-size:18px; letter-spacing:-0.01em; color:var(--ink)">{{ peek.company }}</span>
                <span style="font-size:12px; color:var(--mut)">{{ peek.client }} · requested by {{ peek.by }}</span>
              </div>
              <div style="font-size:24px; letter-spacing:-0.02em; color:var(--ink)">{{ peek.amount }}</div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px">
                <sc-for list="{{ peek.facts }}" as="pf" hint-placeholder-count="4">
                  <div style="padding:9px 11px; border-radius:12px; background:var(--sf2); border:1px solid var(--line2); min-width:0">
                    <div style="font-size:10px; letter-spacing:0.06em; text-transform:uppercase; color:var(--mut3)">{{ pf.label }}</div>
                    <div style="font-size:12.5px; color:var(--ink2); margin-top:2px; overflow-wrap:anywhere">{{ pf.value }}</div>
                  </div>
                </sc-for>
              </div>
              <sc-if value="{{ peek.canDecide }}" hint-placeholder-val="{{ false }}">
                <div style="display:flex; gap:8px; flex-wrap:wrap">
                  <button type="button" sc-camel-on-click="{{ peek.approve }}" class="btn" style="border-radius:12px; color:#fff; background:linear-gradient(140deg,#3b82f6,#1d4ed8); box-shadow:0 6px 16px rgba(29,99,230,.26)"><i class="ph ph-check-circle" style="font-size:15px"></i>Check and approve</button>
                  <button type="button" sc-camel-on-click="{{ peek.ask }}" class="btn" style="border-radius:12px; background:var(--sf2); border:1px solid var(--line3); color:var(--ink2)"><i class="ph ph-question" style="font-size:15px"></i>Ask for information</button>
                  <button type="button" sc-camel-on-click="{{ peek.decline }}" class="btn" style="border-radius:12px; background:var(--sf); border:1px solid var(--chipRedBd); color:var(--fgRed)"><i class="ph ph-prohibit" style="font-size:15px"></i>Not approved</button>
                </div>
              </sc-if>
              <div style="display:flex; flex-direction:column; gap:8px; padding-top:4px; border-top:1px solid var(--line2)">
                <span style="font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; color:var(--mut3); margin-top:8px">History</span>
                <sc-for list="{{ peek.history }}" as="ph" hint-placeholder-count="3">
                  <div style="display:flex; flex-direction:column; gap:1px">
                    <span style="font-size:10.5px; color:var(--mut3)">{{ ph.at }}</span>
                    <span style="font-size:12px; color:var(--ink2); line-height:1.45">{{ ph.text }}</span>
                  </div>
                </sc-for>
              </div>
              <button type="button" sc-camel-on-click="{{ peek.full }}" class="btn btn-ghost" style="align-self:flex-start; font-size:11.5px; padding-left:0; color:var(--mut2)"><i class="ph ph-arrow-square-out" style="font-size:13px"></i>Open the full request page</button>
            </sc-if>
          </div>
        </sc-if>
        <sc-if value="{{ peek.closed }}" hint-placeholder-val="{{ true }}">
        <div style="flex:1; overflow:auto; padding:12px">
          <sc-for list="{{ notifs }}" as="n" hint-placeholder-count="3">`],
  ['          </sc-if>\n        </div>\n      </aside>', '          </sc-if>\n        </div>\n        </sc-if>\n      </aside>']
];

// Returns { text, hit, total }. All-or-nothing: if any rule does not match exactly once, the input is returned unchanged.
export function applyTemplateRules(text, rules = TEMPLATE_RULES) {
  let out = text, hit = 0;
  for (const r of rules) {
    if (Array.isArray(r)) {
      const [from, to] = r, i = out.indexOf(from);
      if (i < 0 || out.indexOf(from, i + 1) >= 0) return { text, hit: 0, total: rules.length, missed: from.slice(0, 80) };
      out = out.slice(0, i) + to + out.slice(i + from.length);
    } else {
      const i = out.indexOf(r.start), j = i < 0 ? -1 : out.indexOf(r.end, i + r.start.length);
      if (i < 0 || j < 0 || out.indexOf(r.start, i + 1) >= 0) return { text, hit: 0, total: rules.length, missed: r.start.slice(0, 80) };
      out = out.slice(0, i) + r.to + out.slice(j);
    }
    hit++;
  }
  return { text: out, hit, total: rules.length };
}

// The page template sits JSON-encoded inside <script type="__bundler/template">. Decode, patch, re-encode
// the same way the bundler does ('</' written as '</' so the script tag cannot be closed early).
export function patchPage(html) {
  const open = '<script type="__bundler/template">', i = html.indexOf(open);
  if (i < 0) return { html, hit: 0, total: TEMPLATE_RULES.length, missed: 'no __bundler/template' };
  const a = i + open.length, b = html.indexOf('</script>', a);
  const raw = html.slice(a, b), lead = raw.match(/^\s*/)[0], tail = raw.match(/\s*$/)[0];
  let tpl;
  try { tpl = JSON.parse(raw); } catch { return { html, hit: 0, total: TEMPLATE_RULES.length, missed: 'template not JSON' }; }
  const r = applyTemplateRules(tpl);
  if (!r.hit) return { html, ...r };
  const enc = JSON.stringify(r.text).replace(/<\//g, '<\\u002F');
  return { html: html.slice(0, a) + lead + enc + tail + html.slice(b), hit: r.hit, total: r.total };
}
