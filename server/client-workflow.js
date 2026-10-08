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
    this.setState({ finFail: null, gate: Object.assign({}, g, { name: v, status: 'idle', results: [], notFound: false, searching: term.length >= 2, active: 0, hintErr: '', error: '', lockMsg: '', lockRef: '' }) });
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
    this.setState({ finFail: null, gate: Object.assign({}, g, { name: c.contactName, status: 'checking', results: [], notFound: false, searching: false, hintErr: '' }) });
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
    fetch(this.zohoApiUrl('/precheck'), { method: 'POST', mode: 'cors', credentials: 'include', headers: this.zohoHeaders(true), body: JSON.stringify({ validationToken: g.token, clientName: g.name, amount: amount, paid: f.paid }), signal: this.zohoTimeout(40000) })
      .then(r => r.json().then(j => ({ st: r.status, j: j })))
      .then(o => {
        this._prechecking = false;
        if (o.st === 200 && o.j.ok && o.j.submitToken) { this._pre = { token: g.token, amount: amount, submitToken: o.j.submitToken }; this.setState({ finFail: null }); return this.send(force); }
        const msg = o.j.error || ('The balance check failed (HTTP ' + o.st + '). Nothing was sent.');
        // The three financial checks failed: keep the result and the one-time escalation pass the server issued
        const esc = o.j.escalate || {};
        const ff = o.j.reason === 'FINANCIAL_CHECKS_FAILED' ? { failed: o.j.failed || [], finance: o.j.finance || null, token: esc.token || '', allowed: !!esc.allowed, error: msg, clientName: g.name, amount: amount, open: false, justification: '', sendError: '', busy: false } : null;
        // Failed financial checks: the panel below carries the message — no second copy in the summary box.
        this.setState(s => ({ errors: Object.assign({}, s.errors, { summary: ff ? null : msg }), shake: s.shake + 1, askNoDoc: false, finFail: ff }));
        this.flash(msg, null, o.j.reason === 'INSUFFICIENT_BALANCE' || ff ? 'ph ph-flag' : 'ph ph-prohibit');
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
    if (!r) return { open: true, closed: false, found: false, missing: true, back: back, missingText: isOps ? 'No access — request not created by you (or it was not submitted).' : 'This request is not on the platform — it was not submitted, or it has been removed.', full: back };
    const u = this.users()[r.by], me = this.me(), mgmt = this.isMgmt(me), st = r.status;
    const open = !mgmt && (['NEW', 'ACTION'].indexOf(st) >= 0 || st === 'MGMT_APPROVED'); // management decides escalations only
    const mgmtDecide = mgmt && (st === 'ESCALATED' || st === 'MGMT_INFO'), canReply = st === 'MGMT_INFO' && (r.by === me.key || this.isOpsMaster(me));
    const canChase = st !== 'VOID', canVoid = st !== 'VOID' && (this.isSven(me) || mgmt);
    const facts = [
      { label: 'Purpose', value: r.purpose || '—' },
      { label: 'Client already paid us?', value: r.paid || '—' },
      { label: 'Zoho Analytics', value: r.zohoStatus ? r.zohoStatus + (!isOps && typeof r.zohoBalance === 'number' ? ' · balance ' + this.fmt(r.zohoBalance) : '') : 'Not checked yet' },
      { label: 'Freezone', value: r.zone || '—' },
      { label: 'Documents', value: (r.docs || []).length ? (r.docs || []).length + ' attached' : 'None attached' },
      { label: 'Requested on', value: r.date || '—' },
      { label: 'Financial checks', value: this.finSummary(r.finance) }
    ].concat(r.escalation ? [{ label: 'Escalation', value: this.escSummary(r) }] : [])
      .concat(r.voided ? [{ label: 'Voided', value: (r.voided.byName || this.nameOf(r.voided.by)) + (r.voided.reason ? ' — ' + r.voided.reason : '') }] : [])
      .concat(r.notes ? [{ label: 'Notes', value: r.notes }] : []);
    return {
      open: true, closed: false, found: true, missing: false, back: back,
      id: r.id, status: this.statusMeta(r.status).label, company: r.company, client: (r.person && r.person !== '—') ? r.person : r.company,
      by: u ? u.name : r.by, amount: this.fmt(r.requested), facts: facts,
      history: (r.timeline || []).slice(-5).reverse().map(t => ({ at: t.at, text: t.text })),
      canDecide: !isOps && !mgmt && open && this.canApproveReq(r), approveLabel: st === 'MGMT_APPROVED' ? 'Final approval' : 'Check and approve',
      approve: () => this.approveFull(r.id), ask: () => this.openModal('info', r.id), decline: () => this.openModal('decline', r.id),
      mgmtDecide: mgmtDecide, mApprove: () => this.openModal('mgmtApprove', r.id), mReject: () => this.openModal('mgmtReject', r.id), mInfo: () => this.openModal('mgmtInfo', r.id),
      canReply: canReply, reply: () => this.openModal('mgmtReply', r.id),
      canChase: canChase, chase: () => this.openModal('chase', r.id), canVoid: canVoid, voidGo: () => this.openModal('void', r.id),
      hasMore: mgmtDecide || canReply || canChase || canVoid,
      full: () => this.open(r.id)
    };
  }
  /* Master Operations Control (Amina by default — set on the server) sees and acts on every Operations request. */
  isOpsMaster(u) { return !!(u && u.opsMaster); }
  /* Opening a request is logged on the server (security log); someone else's request is refused there. */
  logView(id) {
    if (!id || !this.isLive() || !this._token) return;
    this._viewed = this._viewed || {};
    if (Date.now() - (this._viewed[id] || 0) < 60000) return;
    this._viewed[id] = Date.now();
    this.api('/api/audit/view', { method: 'POST', body: { req: id } }).then(o => { if (o.status === 403) this.flash(o.json.error || 'No access — request not created by you', null, 'ph ph-lock-simple'); }).catch(() => {});
  }
  escalate(id) {
    const r = this.reqById(id), me = this.me(), why = (this.state.draft || '').trim();
    if (!r) return;
    this.apply(id, { flagged: true, escalatedBy: me.key }, me.name + ' escalated this to Sven' + (why ? ' — ' + why : ''),
      { to: 'sven', text: 'ESCALATED by ' + me.name + ' — ' + r.id + ' · ' + r.company + ' · ' + this.fmt(r.requested) + (why ? ': ' + why : '') });
    this.setState({ draft: '' });
    this.flash('Escalated to Sven — ' + r.id, null, 'ph ph-arrow-fat-line-up');
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

// ─── Upgrade: triple financial check, management escalation, void, chase invoice, platform reset ───
//   A. A request whose three financial checks fail (CFD, COGS, invoices) can be escalated to management.
//   B. The request page shows the financial validation, the escalation ticket, Void and Chase invoice.
//   C. The board has a place for every new status (ESCALATED, MGMT_INFO, MGMT_APPROVED, VOID).
//   D. The inline notification peek shows the checks and offers the same actions.
//   E. Master Control → Platform reset (backup first, restorable).
//   F. The prototype's built-in client directory and balance book are gone.
// Every change goes through its own server endpoint; the returned item is merged into state.requests and
// this._sync.requests, so livePush() never sends the server's own copy back.

const STATUS_META_FROM = `      DECLINED: ['Not approved', 'var(--fgRed)', 'var(--chipRedBg)', 'var(--chipRedBd)']
    };`;
const STATUS_META_TO = `      DECLINED: ['Not approved', 'var(--fgRed)', 'var(--chipRedBg)', 'var(--chipRedBd)'],
      ESCALATED: ['Awaiting Management Decision', 'var(--fgAmberDeep)', 'var(--chipAmberBg)', 'var(--chipAmberBd)'],
      MGMT_INFO: ['Management needs info', 'var(--fgAmber)', 'var(--chipAmberBg)', 'var(--chipAmberBd)'],
      MGMT_APPROVED: ['Management Approved – Proceed', 'var(--fgGreen)', 'var(--chipGreenBg)', 'var(--chipGreenBd)'],
      VOID: ['Voided', 'var(--mut)', 'var(--tint)', 'var(--line)']
    };`;

const FLOW_JS = `  /* ═══ ESCALATION · VOID · CHASE · RESET ═══════════════
     Each action calls its own server endpoint. The item in the answer is merged in place, and into
     this._sync, so livePush() does not send the server's own copy straight back. */
  isMgmt(u) { return !!(u && u.dept === 'MANAGEMENT'); }
  isSven(u) { return !!u && ((u.perms || []).indexOf('*') >= 0 || u.key === 'sven'); }
  nameOf(key) { const u = this.users()[key]; return u ? u.name : (key || '—'); }
  acctTitle(key) { const a = this.accounts().filter(x => x.key === key)[0]; return (a && a.title) || ''; }
  mgmtName(name, title) { return 'Mr. ' + (name || 'Management') + (title ? ' (' + title + ')' : ''); }
  mgmtPeople() {
    return this.accounts().filter(a => a.dept === 'MANAGEMENT' && a.active !== false).map(a => this.mgmtName(a.name, a.title));
  }
  /* Management approved the escalation: Sven's final approval and the credit skip the balance gate. */
  overridden(r) { return !!(r && r.escalation && r.escalation.decision && r.escalation.decision.action === 'APPROVE'); }
  overrideBy(r) {
    const d = (r && r.escalation && r.escalation.decision) || {};
    return this.mgmtName(d.byName || this.nameOf(d.by), d.title || this.acctTitle(d.by));
  }
  /* The server refuses to roll a request back into the escalation flow, so no Undo is offered for one
     that was overridden by management or whose status before the change was an escalation status. */
  undoable(r) { return !!r && !this.overridden(r) && ['ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED'].indexOf(r.status) < 0; }
  /* Voided while still with management (escalated, or waiting on an answer for management). */
  voidedBeforeDecision(r) {
    const d = r && r.escalation && r.escalation.decision;
    return !!r && r.status === 'VOID' && (!d || d.action === 'INFO');
  }
  withReq(list, item) {
    const cur = list || [], i = cur.findIndex(x => x.id === item.id);
    return i >= 0 ? cur.map(x => (x.id === item.id ? item : x)) : [item].concat(cur);
  }
  mergeReq(item, extra) {
    if (!item || !item.id) { if (extra) this.setState(extra); return; }
    const next = this.withReq(this.state.requests, item);
    this._sync = Object.assign({}, this._sync, { requests: next });
    this.setState(Object.assign({ requests: next }, extra || {}));
  }
  /* One modal action → one endpoint. Busy while in flight; the server's error stays in the modal. */
  modalCall(path, body, okText, icon) {
    const m = this.state.modal;
    if (!m || m.busy) return Promise.resolve(null);
    const fail = t => { this.setState(s => (s.modal && s.modal.kind === m.kind ? { modal: Object.assign({}, s.modal, { busy: false, error: t }) } : {})); return null; };
    this.setState({ modal: Object.assign({}, m, { busy: true, error: '' }) });
    return this.api(path, { method: 'POST', body: body }).then(o => {
      if (o.status === 401) { this.endSession('Your live session ended. Sign in again.'); return null; }
      if (!o.ok || o.json.ok === false) return fail(o.json.error || 'The server refused this (HTTP ' + o.status + '). Nothing was changed.');
      this.mergeReq(o.json.item, { modal: null });
      this.flash(okText, null, icon);
      return o.json;
    }).catch(() => fail('The live server could not be reached. Nothing was changed.'));
  }
  finSummary(fin) {
    if (!fin || !Array.isArray(fin.checks) || !fin.checks.length) return 'Not run';
    const n = fin.checks.length, bad = fin.checks.filter(c => !c.ok).length;
    return bad ? bad + ' of ' + n + ' failed' : 'All ' + n + ' passed';
  }
  escSummary(r) {
    const esc = r.escalation, d = esc && esc.decision;
    if (!esc) return '';
    if (this.voidedBeforeDecision(r)) return 'Closed — voided before a management decision' + (esc.id ? ' · ' + esc.id : '');
    if (r.status === 'ESCALATED' || !d) return 'Waiting for management' + (esc.id ? ' · ' + esc.id : '');
    const who = this.mgmtName(d.byName || this.nameOf(d.by), d.title || this.acctTitle(d.by));
    return ({ APPROVE: 'Approved by ', REJECT: 'Rejected by ', INFO: 'More information asked by ' }[d.action] || 'Decided by ') + who;
  }

  /* ── A. escalation from the new-request form ─────────── */
  setFinFail(p) { this.setState(s => (s.finFail ? { finFail: Object.assign({}, s.finFail, p) } : {})); }
  finFailVals() {
    const ff = this.state.finFail, g = this.gate(), f = this.state.form || this.blankForm();
    if (!ff || g.status !== 'ok' || ff.clientName !== g.name || ff.amount !== Number(f.amount)) return { show: false, rows: [] };
    const fin = ff.finance || {};
    let failed = ff.failed || [];
    if (!failed.length && Array.isArray(fin.checks)) failed = fin.checks.filter(c => !c.ok);
    const n = (ff.justification || '').trim().length, people = this.mgmtPeople();
    return {
      show: true, error: ff.error || 'The financial checks failed. Nothing was sent.',
      sub: ['Checked in ' + (fin.source || 'Zoho Books + Zoho Analytics'), fin.atText, fin.id].filter(Boolean).join(' · '),
      rows: failed.map(x => ({ label: x.label || x.key || 'Check', message: x.message || 'Did not pass.' })),
      canStart: !!ff.allowed && !!ff.token && !ff.open, open: !!ff.open,
      noEscalate: !ff.allowed || !ff.token,
      recipients: 'Goes to ' + (people.length ? people.join(', ') : 'management') + '. Sven is kept informed.',
      start: () => this.setFinFail({ open: true, sendError: '' }),
      cancel: () => this.setFinFail({ open: false, sendError: '' }),
      justification: ff.justification || '',
      onJustification: e => this.setFinFail({ justification: e.target.value, sendError: '' }),
      hint: n >= 15 ? n + ' characters — ready to send' : n + ' of 15 characters minimum',
      hintFg: n >= 15 ? 'var(--fgGreen)' : 'var(--mut2)',
      sendError: ff.sendError || false, busy: !!ff.busy,
      sendLabel: ff.busy ? 'Sending…' : 'Send to management',
      send: () => this.sendEscalation()
    };
  }
  sendEscalation() {
    const ff = this.state.finFail, g = this.gate(), f = this.state.form || this.blankForm();
    if (!ff || ff.busy) return;
    const why = (ff.justification || '').trim();
    if (why.length < 15) return this.setFinFail({ sendError: 'Write at least 15 characters so management can decide.' });
    if (!ff.token) return this.setFinFail({ sendError: 'This check has expired — send the request again to re-run the financial checks.' });
    if (this.state.formDocs.some(d => d.status !== 'done')) return this.setFinFail({ sendError: 'Hold on — the upload is still finishing.' });
    const d0 = new Date(f.date || Date.now()), d = isNaN(d0.getTime()) ? new Date() : d0, mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const body = {
      escalateToken: ff.token, clientName: ff.clientName || g.name, justification: why,
      request: {
        company: String(f.company || '').trim() || g.name, person: g.name, purpose: f.purpose.trim(), zone: f.zone,
        requested: Number(f.amount), paid: f.paid, date: d.getDate() + ' ' + mo[d.getMonth()], notes: f.notes,
        docs: this.state.formDocs.filter(x => x.status === 'done').map(x => ({ name: x.name, type: x.type, size: x.size, fileId: x.fileId }))
      }
    };
    this.setFinFail({ busy: true, sendError: '' });
    this.api('/api/requests/escalate', { method: 'POST', body: body }).then(o => {
      if (!o.ok || o.json.ok === false || !o.json.id) return this.setFinFail({ busy: false, sendError: o.json.error || 'The server refused the escalation (HTTP ' + o.status + '). Nothing was sent.' });
      const id = o.json.id;
      this._pre = null;
      this.mergeReq(o.json.item, { form: null, formDocs: [], errors: {}, askNoDoc: false, gate: { name: '', status: 'idle', hintErr: '' }, finFail: null, route: 'detail', prev: 'board', reqId: id, modal: null, notifOpen: false });
      this.flash('Escalated to management — ' + id, null, 'ph ph-arrow-fat-line-up');
    }).catch(() => this.setFinFail({ busy: false, sendError: 'The live server could not be reached. Nothing was sent — try again.' }));
  }

  /* ── B. request page: financial validation, escalation, void, chase ── */
  finVals(fin, restricted) {
    if (!fin) return { checks: [] };
    const checks = (fin.checks || []).map(c => {
      const ok = !!c.ok, detail = !restricted && c.detail ? String(c.detail) : '';
      const items = (c.items || []).map(it => ({ label: it.label || '', text: it.text || '', icon: it.ok ? 'ph ph-check' : 'ph ph-x', fg: it.ok ? 'var(--fgGreen)' : 'var(--fgRed)' }));
      return {
        label: c.label || c.key || 'Check', message: c.message || '', detail: detail, hasDetail: !!detail, bad: !ok,
        icon: ok ? 'ph ph-check-circle' : 'ph ph-x-circle', fg: ok ? 'var(--fgGreen)' : 'var(--fgRed)',
        bg: ok ? 'var(--sf2)' : 'var(--chipRedBg)', bd: ok ? 'var(--line)' : 'var(--chipRedBd)',
        items: items, hasItems: items.length > 0
      };
    });
    const n = checks.length, bad = checks.filter(c => c.bad).length;
    return {
      sub: [fin.atText, fin.id].filter(Boolean).join(' · '),
      source: fin.source || 'Zoho Books + Zoho Analytics',
      chip: !n ? 'No checks recorded' : bad ? bad + ' of ' + n + ' checks failed' : n === 3 ? 'All three checks passed' : 'All ' + n + ' checks passed',
      chipIcon: bad || !n ? 'ph ph-warning-octagon' : 'ph ph-seal-check',
      chipFg: bad || !n ? 'var(--fgRedDeep)' : 'var(--fgGreen)', chipBg: bad || !n ? 'var(--chipRedBg)' : 'var(--chipGreenBg)', chipBd: bad || !n ? 'var(--chipRedBd)' : 'var(--chipGreenBd)',
      checks: checks
    };
  }
  escVals(r, me) {
    const esc = r.escalation;
    if (!esc) return { failed: [], log: [] };
    const d = esc.decision, st = r.status, closed = this.voidedBeforeDecision(r), waiting = !closed && (st === 'ESCALATED' || !d), act = waiting || closed ? '' : d.action;
    const ACT = { APPROVE: 'Approved & proceed', REJECT: 'Escalation rejected', INFO: 'More information requested' };
    const LOG = { CREATED: 'escalated to management', APPROVE: 'approved & proceed', REJECT: 'rejected the escalation', INFO: 'asked for more information', REPLY: 'replied to management' };
    const failed = (esc.failed || []).map(x => ({ label: x.label || x.key || 'Check', message: x.message || '' }));
    const log = (esc.log || []).slice().reverse().map(l => ({ at: l.atText || '', text: (l.whoName || this.nameOf(l.who)) + ' ' + (LOG[l.action] || String(l.action || '').toLowerCase()) + (l.note ? ' — ' + l.note : '') }));
    return {
      id: esc.id || '—',
      raised: 'Raised by ' + (esc.byName || this.nameOf(esc.by)) + (esc.atText ? ' · ' + esc.atText : ''),
      justification: esc.justification || '—',
      failed: failed, hasFailed: failed.length > 0,
      to: (esc.to || []).map(t => this.mgmtName(t.name || this.nameOf(t.key), t.title || this.acctTitle(t.key))).join(' · ') || 'Management',
      decisionLine: closed ? 'Closed — voided before a management decision' : waiting ? 'Waiting for a management decision' : (ACT[act] || 'Decided') + ' — ' + this.mgmtName(d.byName || this.nameOf(d.by), d.title || this.acctTitle(d.by)) + (d.atText ? ' · ' + d.atText : ''),
      decisionNote: !waiting && !closed && d.note ? d.note : '', hasNote: !waiting && !closed && !!d.note,
      toneIcon: closed ? 'ph ph-lock-simple' : waiting ? 'ph ph-hourglass' : act === 'APPROVE' ? 'ph ph-seal-check' : act === 'REJECT' ? 'ph ph-prohibit' : 'ph ph-question',
      toneFg: closed ? 'var(--mut)' : act === 'APPROVE' ? 'var(--fgGreen)' : act === 'REJECT' ? 'var(--fgRedDeep)' : 'var(--fgAmberDeep)',
      toneBg: closed ? 'var(--tint)' : act === 'APPROVE' ? 'var(--chipGreenBg)' : act === 'REJECT' ? 'var(--chipRedBg)' : 'var(--chipAmberBg)',
      toneBd: closed ? 'var(--line)' : act === 'APPROVE' ? 'var(--chipGreenBd)' : act === 'REJECT' ? 'var(--chipRedBd)' : 'var(--chipAmberBd)',
      log: log, hasLog: log.length > 0,
      canDecide: this.isMgmt(me) && (st === 'ESCALATED' || st === 'MGMT_INFO'),
      approve: () => this.openModal('mgmtApprove', r.id), reject: () => this.openModal('mgmtReject', r.id), info: () => this.openModal('mgmtInfo', r.id),
      canReply: st === 'MGMT_INFO' && (r.by === me.key || this.isOpsMaster(me)),
      reply: () => this.openModal('mgmtReply', r.id)
    };
  }
  detailExtra(r, me, isOps) {
    const restricted = isOps && !this.isOpsMaster(me), locked = r.status === 'VOID', vd = r.voided || {};
    const who = vd.byName || (vd.by ? this.nameOf(vd.by) : '');
    const out = {
      editable: !locked, locked: locked,
      voidLine: locked ? 'Voided' + (who ? ' by ' + who : '') + (vd.atText ? ' on ' + vd.atText : '') + (vd.reason ? ' — ' + vd.reason : '') : '',
      canChase: !locked, chase: () => this.openModal('chase', r.id),
      canVoid: !locked && (this.isSven(me) || this.isMgmt(me)), voidGo: () => this.openModal('void', r.id),
      hasFin: !!r.finance, fin: this.finVals(r.finance, restricted),
      hasEsc: !!r.escalation, esc: this.escVals(r, me)
    };
    // a voided request is locked: no uploads, notes, decisions, overrides, Zoho checks or chases
    if (locked) Object.assign(out, { canOverride: false, canZoho: false, canEscalate: false, zeroBalance: false, showDecide: false, decisions: [], hasAction: false });
    return out;
  }
  /* Chase invoice: files are uploaded first (POST /api/files) and listed inside the modal. */
  takeChaseFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []), MAX = 7340032;
    if (!files.length || !this.state.modal || this.state.modal.kind !== 'chase') return;
    const ok = files.filter(f => f.size <= MAX), big = files.length - ok.length;
    const stamped = ok.map((f, i) => ({ key: 'c' + Date.now() + i, name: f.name, size: f.size, type: this.typeFor(f.name), status: 'uploading' }));
    const upd = fn => this.setState(s => (s.modal && s.modal.kind === 'chase' ? { modal: Object.assign({}, s.modal, { files: fn(s.modal.files || []), error: '' }) } : {}));
    const mark = (key, extra) => upd(l => l.map(d => (d.key === key ? Object.assign({}, d, extra) : d)));
    upd(l => l.concat(stamped));
    if (big) this.flash(big + (big === 1 ? ' file is' : ' files are') + ' over 7 MB — attach a smaller copy', null, 'ph ph-warning');
    ok.forEach((f, i) => this.uploadDoc(f).then(
      fileId => mark(stamped[i].key, fileId ? { status: 'done', fileId: fileId } : { status: 'failed' }),
      () => mark(stamped[i].key, { status: 'failed' })));
  }
  removeChaseFile(key) {
    this.setState(s => (s.modal ? { modal: Object.assign({}, s.modal, { files: (s.modal.files || []).filter(d => d.key !== key) }) } : {}));
  }

  /* ── E. Master Control → Platform reset ─────────────── */
  resetCount(x) { return typeof x === 'number' ? x : Array.isArray(x) ? x.length : (x && typeof x.count === 'number') ? x.count : 0; }
  resetCounts(c) {
    if (!c) return '';
    return [['requests', 'requests'], ['chat', 'chat messages'], ['notifications', 'notifications'], ['audit', 'audit entries']]
      .filter(k => c[k[0]] !== undefined).map(k => this.resetCount(c[k[0]]) + ' ' + k[1]).join(' · ');
  }
  setReset(p) { this.setState(s => ({ reset: Object.assign({}, s.reset, p) })); }
  loadReset() {
    if (!this.isMaster()) return;
    this.setState(s => ({ reset: Object.assign({ sel: {}, clearNotifs: true, includeHistory: false, reason: '', confirm: '' }, s.reset, { loading: true, error: '' }) }));
    this.api('/api/admin/reset/preview').then(o => {
      if (!o.ok || o.json.ok === false) throw new Error(o.json.error || 'HTTP ' + o.status);
      const sel = {};
      (o.json.live || []).forEach(x => { sel[x.id] = true; });
      this.setReset({ loading: false, data: o.json, sel: sel });
    }).catch(err => this.setReset({ loading: false, error: 'The reset preview could not be loaded (' + err.message + ').' }));
  }
  resetSelected() {
    const st = this.state.reset || {}, live = (st.data && st.data.live) || [];
    return live.filter(x => st.sel && st.sel[x.id]).map(x => x.id);
  }
  resetValid() {
    const st = this.state.reset || {};
    return !!st.data && !st.busy && !!String(st.reason || '').trim() && st.confirm === 'RESET'
      && (this.resetSelected().length > 0 || !!st.includeHistory || st.clearNotifs !== false);
  }
  runReset() {
    const st = this.state.reset;
    if (!st || st.busy) return;
    if (!this.resetValid()) return this.setReset({ error: 'Pick what to remove, give a reason and type RESET to confirm.' });
    const body = { ids: this.resetSelected(), includeHistory: !!st.includeHistory, clearNotifications: st.clearNotifs !== false, reason: String(st.reason).trim(), confirm: 'RESET' };
    this.setReset({ busy: true, error: '' });
    this.api('/api/admin/reset', { method: 'POST', body: body }).then(o => {
      if (!o.ok || o.json.ok === false) return this.setReset({ busy: false, error: o.json.error || 'The server refused the reset (HTTP ' + o.status + '). Nothing was removed.' });
      this.setReset({ busy: false, result: o.json, reason: '', confirm: '', includeHistory: false });
      this.flash('Backed up and reset — backup ' + (o.json.backupId || ''), null, 'ph ph-broom');
      this.loadReset();
      this.liveLoad(false);
    }).catch(() => this.setReset({ busy: false, error: 'The live server could not be reached. Nothing was removed.' }));
  }
  resetVals() {
    const st = this.state.reset || {}, d = st.data || null, live = (d && d.live) || [], sel = st.sel || {}, uAll = this.users();
    const histN = d && d.history ? this.resetCount(d.history.requests) : 0, nSel = live.filter(x => sel[x.id]).length;
    const valid = this.resetValid(), res = st.result || null;
    const tick = on => this.setReset({ sel: live.reduce((a, x) => { a[x.id] = on; return a; }, {}) });
    return {
      intro: 'Removes requests created on the live platform (test data) together with their chat records, notifications and audit entries. A full backup is taken first and can be restored. The March–September history rebuilt from the Alaan Card Invoices group is kept unless you tick the box. Balances are always read live from Zoho Books + Zoho Analytics.',
      loading: !!st.loading, ready: !!d, error: st.error || false,
      refresh: () => this.loadReset(),
      nowLine: d ? 'On the platform now: ' + live.length + ' live requests · ' + histN + ' history requests · ' + this.resetCount(d.notifications) + ' notifications · ' + this.resetCount(d.audit) + ' audit entries · ' + this.resetCount(d.chat) + ' chat messages' : '',
      rows: live.map(x => {
        const sm = this.statusMeta(x.status);
        return {
          id: x.id, company: x.company || '—', by: x.byName || (uAll[x.by] ? uAll[x.by].name : x.by || '—'), date: x.date || '',
          amount: this.fmt(x.requested), status: sm.label, stFg: sm.fg, stBg: sm.bg,
          checked: !!sel[x.id], toggle: () => this.setReset({ sel: Object.assign({}, sel, { [x.id]: !sel[x.id] }) })
        };
      }),
      noRows: !!d && live.length === 0,
      selLine: nSel + ' of ' + live.length + ' selected',
      selectAll: () => tick(true), selectNone: () => tick(false),
      clearNotifs: st.clearNotifs !== false, toggleNotifs: () => this.setReset({ clearNotifs: st.clearNotifs === false }),
      includeHistory: !!st.includeHistory, toggleHistory: () => this.setReset({ includeHistory: !st.includeHistory }),
      historyLabel: 'Also remove the March–September history (' + histN + ' requests)',
      historyWarn: st.includeHistory ? 'The March–September ledger will be deleted too. It is in the backup, but the board starts empty.' : false,
      reason: st.reason || '', onReason: e => this.setReset({ reason: e.target.value, error: '' }),
      confirm: st.confirm || '', onConfirm: e => this.setReset({ confirm: e.target.value.trim().toUpperCase(), error: '' }),
      disabled: !valid, btnLabel: st.busy ? 'Backing up…' : 'Back up and reset',
      btnBg: valid ? 'linear-gradient(140deg,#ef4444,#b91c1c)' : 'var(--sf2)', btnFg: valid ? '#fff' : 'var(--mut3)',
      run: () => this.runReset(),
      hasResult: !!res,
      resultLine: res ? 'Backup ' + (res.backupId || '—') + ' taken, then the reset ran.' : '',
      removedLine: res ? 'Removed: ' + (this.resetCounts(res.removed) || 'nothing') : '',
      keptLine: res ? 'Kept: ' + (this.resetCounts(res.kept) || 'nothing') : '',
      backups: ((d && d.backups) || []).map(b => ({
        id: b.id, at: b.atText || b.at || '', by: b.by || '—', reason: b.reason || '', counts: this.resetCounts(b.counts),
        restore: () => this.openModal('restore', b.id)
      })),
      noBackups: !!d && !((d.backups || []).length)
    };
  }

`;

// openModal: one definition per kind, built only for the kind asked for (restore has no request).
const OPEN_MODAL_JS = `  openModal(kind, id) {
    const r = this.reqById(id), who = r && this.users()[r.by] ? this.users()[r.by].name : 'the requester';
    if (kind !== 'restore' && !r) return this.flash('This request is no longer on the platform.', null, 'ph ph-warning');
    if (r && r.status === 'VOID') return this.flash(r.id + ' is voided — it cannot be changed.', null, 'ph ph-lock-simple');
    const to = () => {
      const t = (r.escalation && r.escalation.to) || [];
      return t.length ? t.map(x => this.mgmtName(x.name || this.nameOf(x.key), x.title || this.acctTitle(x.key))).join(', ') : 'management';
    };
    const M = {
      decline: () => ({ title: 'Not approved', body: 'Tell ' + who + ' why. It goes straight into the request history.', confirmLabel: 'Send', field: { k: 'reason', label: 'Reason', type: 'area', ph: 'Client has not paid the full amount' } }),
      partial: () => ({ title: 'Approve a lower amount', body: who + ' asked for ' + this.fmt(r.requested) + '.', confirmLabel: 'Approve', field: { k: 'amount', label: 'Amount to approve (AED)', type: 'text', ph: String(r.requested) } }),
      info: () => ({ title: 'Ask for information', body: 'The request moves to Needs info until ' + who + ' replies.', confirmLabel: 'Ask', field: { k: 'note', label: 'What do you need?', type: 'area', ph: 'Please send the request by email with the estimate attached' } }),
      mgmtApprove: () => ({ title: 'Approve & proceed', body: 'Management approves ' + r.id + ' although the financial checks failed. Sven then makes the final approval and the credit.', confirmLabel: 'Approve & proceed', field: { k: 'note', label: 'Decision note *', type: 'area', ph: 'Approved — the client paid by bank transfer on Monday' } }),
      mgmtReject: () => ({ title: 'Reject escalation', body: r.id + ' is closed as Not approved and ' + who + ' is told why.', confirmLabel: 'Reject escalation', field: { k: 'note', label: 'Reason *', type: 'area', ph: 'The client has to pay in full first' }, danger: true }),
      mgmtInfo: () => ({ title: 'Request more information', body: who + ' is asked to reply before management decides.', confirmLabel: 'Send question', field: { k: 'note', label: 'What do you need? *', type: 'area', ph: 'Send the bank confirmation for the client payment' } }),
      mgmtReply: () => ({ title: 'Reply to management', body: 'Your answer goes to ' + to() + ' and the request goes back to them for a decision.', confirmLabel: 'Send reply', field: { k: 'note', label: 'Your reply *', type: 'area', ph: 'Bank confirmation attached to the request' } }),
      void: () => ({ title: 'Void request', body: r.id + ' will be locked for good — nothing can be changed afterwards. The reason goes into the history and the audit log.', confirmLabel: 'Void request', field: { k: 'reason', label: 'Reason *', type: 'area', ph: 'Duplicate — raised twice by mistake' }, danger: true }),
      chase: () => ({ title: 'Chase invoice', body: 'Sven, the finance team and ' + who + ' are notified. Add a note, attach the invoice or receipt, or both.', confirmLabel: 'Send chase', field: { k: 'note', label: 'Note', type: 'area', ph: 'Invoice attached — please reconcile' }, files: true }),
      restore: () => ({ title: 'Restore backup', body: 'Everything goes back to how it was when backup ' + id + ' was taken. Anything changed since then is lost.', confirmLabel: 'Restore', field: { k: 'confirm', label: 'Type RESTORE to confirm', type: 'text', ph: 'RESTORE' }, danger: true })
    };
    if (!M[kind]) return;
    const def = M[kind]();
    this.setState({ modal: { kind: kind, id: id, title: def.title, body: def.body, confirmLabel: def.confirmLabel, field: def.field, value: '', error: '', busy: false, danger: !!def.danger, hasFiles: !!def.files, files: [] } });
  }

`;

const CONFIRM_NEW_KINDS = `    if (m.busy) return;
    const rid = encodeURIComponent(m.id || '');
    if (m.kind === 'mgmtApprove' || m.kind === 'mgmtReject' || m.kind === 'mgmtInfo') {
      if (v.length < 3) return err('Write a short note — at least 3 characters.');
      const action = { mgmtApprove: 'APPROVE', mgmtReject: 'REJECT', mgmtInfo: 'INFO' }[m.kind];
      const ok = { APPROVE: ['Approved by management — Sven makes the final approval', 'ph ph-seal-check'], REJECT: ['Escalation rejected — ' + m.id, 'ph ph-prohibit'], INFO: ['Question sent — ' + m.id, 'ph ph-question'] }[action];
      return this.modalCall('/api/requests/' + rid + '/escalation', { action: action, note: v }, ok[0], ok[1]);
    }
    if (m.kind === 'mgmtReply') {
      if (v.length < 3) return err('Write your reply — at least 3 characters.');
      return this.modalCall('/api/requests/' + rid + '/escalation/reply', { note: v }, 'Reply sent to management', 'ph ph-chat-circle-text');
    }
    if (m.kind === 'void') {
      if (v.length < 5) return err('Give a reason — at least 5 characters.');
      return this.modalCall('/api/requests/' + rid + '/void', { reason: v }, 'Voided — ' + m.id, 'ph ph-prohibit');
    }
    if (m.kind === 'chase') {
      const files = m.files || [];
      if (files.some(x => x.status === 'uploading')) return err('Hold on — the upload is still finishing.');
      const docs = files.filter(x => x.status === 'done').map(x => ({ name: x.name, type: x.type, size: x.size, fileId: x.fileId }));
      if (!v && !docs.length) return err('Add a note or attach at least one file.');
      return this.modalCall('/api/requests/' + rid + '/chase', { note: v, docs: docs }, 'Invoice chase sent to finance', 'ph ph-paperclip');
    }
    if (m.kind === 'restore') {
      if (v.toUpperCase() !== 'RESTORE') return err('Type RESTORE to confirm.');
      return this.modalCall('/api/admin/reset/restore', { backupId: m.id, confirm: 'RESTORE' }, 'Backup restored — reloading the platform', 'ph ph-clock-counter-clockwise')
        .then(j => { if (j) { this.setReset({ result: null }); this.loadReset(); this.liveLoad(false); } });
    }
`;

// Sven's final approval and the credit: skip the Zoho gate when management approved the escalation.
const APPROVE_FULL_JS = `  approveFull(id, validated) {
    const r = this.reqById(id), me = this.me();
    if (!r) return;
    if (r.status === 'VOID') return this.flash(r.id + ' is voided — it cannot be changed.', null, 'ph ph-lock-simple');
    if (!this.canApproveReq(r)) {
      return this.deny(r.by === me.key
        ? 'You cannot approve your own request — self-approval is switched off in Master Controls.'
        : 'Approving a request needs the APPROVE_REQUEST permission.');
    }
    // Management approved the escalation: no Zoho re-check and no balance comparison
    const ovr = this.overridden(r), by = ovr ? this.overrideBy(r) : '';
    if (!ovr && !validated) return this.runZoho(id, 'approve');
    if (!ovr && (validated.ok !== true || validated.partialOnly)) return this.flash('${INSUFFICIENT}', null, 'ph ph-flag');
    const v = !ovr && validated && validated.available !== undefined ? validated : null;
    const before = this.apply(id, { status: 'APPROVED', approved: r.requested, flagged: false },
      me.name + ' approved ' + this.fmt(r.requested) + (v ? ' — Zoho balance ' + this.fmt(v.available) + ' verified ' + v.validationId : '') + (ovr ? ' — management override by ' + by : ''),
      { to: r.by, text: this.fmt(r.requested) + ' approved for ' + r.company + '. Waiting on the card top-up.' });
    this.logAudit('REQUEST_APPROVED', r.company + ' — ' + this.fmt(r.requested) + (v ? ' · validation ' + v.validationId : '') + (ovr ? ' · management override by ' + by : ''), r.id, r.company);
    this.setState({ zoho: null });
    this.flash('Approved ' + this.fmt(r.requested) + ' — ' + r.company, this.undoable(r) ? () => this.undoTo(before) : null);
  }
`;

const CREDIT_NOW_JS = `  creditNow(id, validated) {
    const r = this.reqById(id), me = this.me();
    if (!r) return;
    if (r.status === 'VOID') return this.flash(r.id + ' is voided — it cannot be changed.', null, 'ph ph-lock-simple');
    if (!this.can('CREDIT_FUNDS')) return this.deny('Crediting the card needs the CREDIT_FUNDS permission.');
    const ovr = this.overridden(r), by = ovr ? this.overrideBy(r) : '';
    if (!ovr && !validated) return this.runZoho(id, 'credit');
    const amt = r.approved || r.requested;
    const v = !ovr && validated && validated.available !== undefined ? validated : null;
    if (v && v.available < amt) {
      this.logAudit('ZOHO_FAILED', r.company + ' — release blocked, balance moved to ' + this.fmt(v.available) + ' against an approved ' + this.fmt(amt), r.id, r.company);
      return this.setState(s => ({ zoho: Object.assign({}, s.zoho, { blocked: 'Funding availability has changed since approval. Please review the request again.' }) }));
    }
    const before = this.apply(id, { status: 'CREDITED', credited: amt },
      me.name + ' credited ' + this.fmt(amt) + ' to the card' + (v ? ' — re-validated at ' + this.fmt(v.available) + ' available' : '') + (ovr ? ' — management override by ' + by : ''),
      { to: r.by, text: this.fmt(amt) + ' credited for ' + r.company + '. You can pay now.' });
    this.logAudit('FUNDS_CREDITED', r.company + ' — ' + this.fmt(amt) + (v ? ' · re-validated ' + v.validationId : '') + (ovr ? ' · management override by ' + by : ''), r.id, r.company);
    this.setState({ zoho: null });
    this.flash('Credited ' + this.fmt(amt) + ' — ' + r.company, this.undoable(r) ? () => this.undoTo(before) : null);
  }
`;

// Sven's decisions in the modal (Not approved / Approve a lower amount / Ask for information). Management never
// gets these — they decide escalations through their own endpoint. A lower amount on a management-approved
// request skips the Zoho balance gate, like the final approval does.
const DECIDE_JS = `    if (m.kind === 'decline') {
      if (this.isMgmt(me) || !this.can('DECLINE_REQUEST')) return this.deny('Declining a request needs the DECLINE_REQUEST permission.');
      if (!v) return err('A reason is required.');
      this.apply(m.id, { status: 'DECLINED', approved: 0, notes: v }, me.name + ' did not approve — ' + v,
        { to: r.by, text: r.company + ' ' + this.fmt(r.requested) + ' not approved: ' + v });
      this.logAudit('REQUEST_DECLINED', r.company + ' — ' + this.fmt(r.requested) + ' — ' + v, r.id, r.company);
      return this.flash('Not approved — ' + r.company, null, 'ph ph-prohibit');
    }
    if (m.kind === 'partial') {
      const amt = Number(v), ovr = this.overridden(r), by = ovr ? this.overrideBy(r) : '';
      if (this.isMgmt(me) || !this.can('PARTIAL_APPROVE_REQUEST')) return this.deny('Partial approval needs the PARTIAL_APPROVE_REQUEST permission.');
      if (!amt || amt <= 0) return err('Enter an amount.');
      if (amt > r.requested) return err('Cannot approve more than the requested ' + this.fmt(r.requested) + '.');
      // management approved the escalation: no Zoho balance needed and no balance cap
      if (!ovr) {
        if (typeof r.zohoBalance !== 'number') return err('Run the Zoho check first — no approval without a balance validated in Zoho Analytics.');
        if (amt > (Number(r.zohoBalance) || 0)) return err('The validated Zoho balance for this client is ' + this.fmt(Number(r.zohoBalance) || 0) + ' — approval cannot exceed it.');
      }
      this.apply(m.id, { status: 'APPROVED', approved: amt }, me.name + ' approved ' + this.fmt(amt) + ' of ' + this.fmt(r.requested) + (ovr ? ' — management override by ' + by : ''),
        { to: r.by, text: this.fmt(amt) + ' of ' + this.fmt(r.requested) + ' approved for ' + r.company + '.' });
      this.logAudit('REQUEST_PARTIALLY_APPROVED', r.company + ' — ' + this.fmt(amt) + ' of ' + this.fmt(r.requested) + (ovr ? ' · management override by ' + by : ''), r.id, r.company);
      return this.flash('Approved ' + this.fmt(amt));
    }
    if (m.kind === 'info') {
      if (this.isMgmt(me) || !(this.can('DECLINE_REQUEST') || this.can('APPROVE_REQUEST'))) return this.deny('Asking for information needs the DECLINE_REQUEST or APPROVE_REQUEST permission.');
      if (!v) return err('Say what you need.');
      this.apply(m.id, { status: 'ACTION' }, me.name + ' asked for information — ' + v,
        { to: r.by, text: r.company + ' needs info: ' + v });
      return this.flash('Sent to ' + this.users()[r.by].name, null, 'ph ph-question');
    }
  }

`;

// Board: every status has a tab and a section, for Operations and for finance / management.
const TAB_DEF_JS = `    const mgmtMe = this.isMgmt(me);
    const tabDef = isOps
      ? [['tasks', 'Your tasks', ['CREDITED', 'ACTION', 'MGMT_INFO', 'DECLINED']], ['pending', 'Pending accounting', ['NEW', 'ESCALATED', 'MGMT_APPROVED']], ['await', 'Awaiting payment', ['APPROVED']], ['done', 'Completed', ['PAID', 'VOID']]]
      : [['tasks', 'Your tasks', ['NEW', 'ACTION', 'ESCALATED', 'MGMT_INFO', 'MGMT_APPROVED']], ['pending', 'To credit', ['APPROVED']], ['await', 'Awaiting invoice', ['CREDITED']], ['done', 'Completed', ['PAID', 'DECLINED', 'VOID']]];

`;

const SEC_DEF_JS = `    const secDef = isOps
      ? { tasks: [['Pay now — money is on the card', ['CREDITED'], 'var(--fgGreen)'], ['Finance needs something from you', ['ACTION'], 'var(--fgAmber)'], ['Management needs something from you', ['MGMT_INFO'], 'var(--fgAmber)'], ['Not approved', ['DECLINED'], 'var(--fgRed)']],
          pending: [['Waiting on Sven', ['NEW'], 'var(--fgPurple)'], ['Management approved — with Sven', ['MGMT_APPROVED'], 'var(--fgGreen)'], ['With management', ['ESCALATED'], 'var(--fgAmberDeep)']],
          await: [['Approved — waiting on the card top-up', ['APPROVED'], 'var(--fgBlue)']],
          done: [['Paid and closed', ['PAID'], 'var(--mut)'], ['Voided', ['VOID'], 'var(--mut)']] }
      : { tasks: mgmtMe
            ? [['Your decision — escalated to management', ['ESCALATED'], 'var(--fgAmberDeep)'], ['Management needs info — waiting on operations', ['MGMT_INFO'], 'var(--fgAmber)'], ['Management approved — with Sven', ['MGMT_APPROVED'], 'var(--fgGreen)'], ['Decide now', ['NEW'], 'var(--fgPurple)'], ['Waiting on operations', ['ACTION'], 'var(--fgAmber)']]
            : [['Final approval — management approved', ['MGMT_APPROVED'], 'var(--fgGreen)'], ['Decide now', ['NEW'], 'var(--fgPurple)'], ['Awaiting management decision', ['ESCALATED'], 'var(--fgAmberDeep)'], ['Waiting on operations', ['ACTION', 'MGMT_INFO'], 'var(--fgAmber)']],
          pending: [['Approved — top up the card', ['APPROVED'], 'var(--fgBlue)']],
          await: [['Credited — invoice outstanding', ['CREDITED'], 'var(--fgGreen)']],
          done: [['Paid and closed', ['PAID'], 'var(--mut)'], ['Not approved', ['DECLINED'], 'var(--fgRed)'], ['Voided', ['VOID'], 'var(--mut)']] };

`;

const ACTION_FOR_JS = `    const actionFor = r => {
      if (r.status === 'VOID') return { note: 'Voided' };
      if (mgmtMe && r.status === 'ESCALATED') return { label: 'Decide escalation', go: () => this.open(r.id), primary: true, nav: true };
      if (isOps) {
        if (r.status === 'CREDITED') return { label: 'Paid — close', go: () => this.markPaid(r.id), primary: true };
        if (r.status === 'ACTION') return { label: 'Reply to Sven', go: () => this.open(r.id), primary: true, nav: true };
        if (r.status === 'MGMT_INFO') return { label: 'Reply to management', go: () => this.open(r.id), primary: true, nav: true };
        if (r.status === 'DECLINED') return { label: 'See reason', go: () => this.open(r.id), nav: true };
        if (r.status === 'NEW') return { note: 'With Sven' };
        if (r.status === 'ESCALATED') return { note: 'With management' };
        if (r.status === 'MGMT_APPROVED') return { note: 'With Sven' };
        if (r.status === 'APPROVED') return { note: 'Awaiting top-up' };
        return { note: 'Closed' };
      }
      if (r.status === 'MGMT_APPROVED') return this.canApproveReq(r) && !mgmtMe
        ? { label: 'Final approval', go: () => this.approveFull(r.id), primary: true }
        : { note: r.by === me.key ? 'Your own request' : 'With Sven' };
      if (r.status === 'ESCALATED') return { note: 'With management' };
      if (r.status === 'MGMT_INFO') return { note: 'Waiting on operations' };
      if (r.status === 'NEW') return this.canApproveReq(r) && !mgmtMe
        ? { label: 'Check and approve', go: () => this.approveFull(r.id), primary: true }
        : { note: r.by === me.key ? 'Your own request' : 'With finance' };
      if (r.status === 'APPROVED') return this.can('CREDIT_FUNDS')
        ? { label: 'Validate and credit', go: () => this.creditNow(r.id), primary: true }
        : { note: 'Awaiting the credit' };
      if (r.status === 'CREDITED') return { label: 'Chase invoice', go: () => this.openModal('chase', r.id) };
      if (r.status === 'ACTION') return { label: 'Ask again', go: () => this.remind(r.id) };
      return { note: 'Closed' };
    };

`;

const NEXT_TEXT_FROM = `        DECLINED: 'Not approved. The reason is in the history.'
      }[r.status];
      const nextIcon = { NEW: 'ph ph-hourglass', ACTION: 'ph ph-warning', APPROVED: 'ph ph-bank', CREDITED: 'ph ph-hand-coins', PAID: 'ph ph-check-circle', DECLINED: 'ph ph-prohibit' }[r.status];`;
const NEXT_TEXT_TO = `        DECLINED: 'Not approved. The reason is in the history.',
        ESCALATED: isOps ? 'With management. Nothing for you to do yet.' : mgmtMe ? 'Escalated to management — your decision is needed.' : 'Escalated to management — waiting for their decision.',
        MGMT_INFO: isOps ? 'Management needs more information. Reply to them below.' : 'Management asked ' + uAll[r.by].name + ' for more information.',
        MGMT_APPROVED: isOps ? 'Management approved. Sven makes the final approval.' : mgmtMe ? 'Management approved — waiting for Sven’s final approval.' : 'Management approved — the final approval is yours.',
        VOID: 'Voided. This request is locked — nothing can be changed.'
      }[r.status] || '';
      const nextIcon = { NEW: 'ph ph-hourglass', ACTION: 'ph ph-warning', APPROVED: 'ph ph-bank', CREDITED: 'ph ph-hand-coins', PAID: 'ph ph-check-circle', DECLINED: 'ph ph-prohibit', ESCALATED: 'ph ph-arrow-fat-line-up', MGMT_INFO: 'ph ph-question', MGMT_APPROVED: 'ph ph-seal-check', VOID: 'ph ph-lock-simple' }[r.status] || 'ph ph-info';`;

const ST_TAB_FROM = `        ? ({ NEW: 'pending', ACTION: 'tasks', APPROVED: 'await', CREDITED: 'tasks', PAID: 'done', DECLINED: 'tasks' })[r.status]
        : ({ NEW: 'tasks', ACTION: 'tasks', APPROVED: 'pending', CREDITED: 'await', PAID: 'done', DECLINED: 'done' })[r.status];`;
const ST_TAB_TO = `        ? ({ NEW: 'pending', ACTION: 'tasks', APPROVED: 'await', CREDITED: 'tasks', PAID: 'done', DECLINED: 'tasks', ESCALATED: 'pending', MGMT_INFO: 'tasks', MGMT_APPROVED: 'pending', VOID: 'done' })[r.status] || 'tasks'
        : ({ NEW: 'tasks', ACTION: 'tasks', APPROVED: 'pending', CREDITED: 'await', PAID: 'done', DECLINED: 'done', ESCALATED: 'tasks', MGMT_INFO: 'tasks', MGMT_APPROVED: 'tasks', VOID: 'done' })[r.status] || 'tasks';`;

const MODAL_VALS_FROM = `        hasError: !!m.error, error: m.error,
        cancel: () => this.setState({ modal: null }), confirm: () => this.confirmModal()
      } : { open: false, fields: [] },`;
const MODAL_VALS_TO = `        hasError: !!m.error, error: m.error,
        hasFiles: !!m.hasFiles, pickFiles: () => this.pick('chase'),
        files: (m.files || []).map(d => ({
          name: d.name, icon: this.docIcon(d.name), uploading: d.status === 'uploading', failed: d.status === 'failed', done: d.status === 'done',
          meta: d.status === 'failed' ? 'Upload failed — remove it and try again' : (d.size ? this.sizeText(d.size) + ' · ' : '') + d.type,
          metaFg: d.status === 'failed' ? 'var(--fgRed)' : 'var(--mut3)',
          remove: () => this.removeChaseFile(d.key)
        })),
        noFiles: !(m.files || []).length,
        confirmDisabled: !!m.busy || (m.files || []).some(d => d.status === 'uploading'),
        confirmText: m.busy ? 'Sending…' : (m.files || []).some(d => d.status === 'uploading') ? 'Uploading…' : m.confirmLabel,
        confirmBg: m.danger ? 'linear-gradient(140deg,#ef4444,#b91c1c)' : 'linear-gradient(140deg,#3b82f6,#1d4ed8)',
        confirmSh: m.danger ? '0 6px 16px rgba(220,38,38,.24)' : '0 6px 16px rgba(29,99,230,.26)',
        cancel: () => this.setState({ modal: null }), confirm: () => this.confirmModal()
      } : { open: false, fields: [], files: [] },`;

// ── markup ──────────────────────────────────────────────

const BTN_SOFT = 'class="btn" style="font-size:12.5px; border-radius:11px; background:var(--sf2); border:1px solid var(--line3); color:var(--ink2)" style-hover="background:var(--sf3)"';

// A. new-request form: the failed financial checks, and the escalation to management
const FINFAIL_MARKUP = `          <sc-if value="{{ finFail.show }}" hint-placeholder-val="{{ false }}">
            <div role="alert" style="grid-column:{{ L.span }}; display:flex; flex-direction:column; gap:10px; padding:15px 17px; border-radius:16px; background:var(--chipRedBg); border:1px solid var(--chipRedBd); animation:riseIn .26s ease">
              <div style="display:flex; align-items:flex-start; gap:10px">
                <i class="ph ph-shield-warning" style="font-size:19px; color:var(--fgRed); flex:none; margin-top:1px"></i>
                <div style="display:flex; flex-direction:column; gap:2px; min-width:0">
                  <span style="font-family:var(--font-heading); font-size:13.5px; line-height:1.45; color:var(--fgRedDeep)">{{ finFail.error }}</span>
                  <span style="font-size:11px; color:var(--fgRedDeep)">{{ finFail.sub }}</span>
                </div>
              </div>
              <div style="display:flex; flex-direction:column; gap:6px">
                <sc-for list="{{ finFail.rows }}" as="fr" hint-placeholder-count="2">
                  <div style="display:flex; align-items:flex-start; gap:9px; padding:9px 11px; border-radius:12px; background:var(--sf); border:1px solid var(--chipRedBd)">
                    <i class="ph ph-x-circle" style="font-size:15px; color:var(--fgRed); flex:none; margin-top:1px"></i>
                    <span style="display:flex; flex-direction:column; gap:1px; min-width:0">
                      <span style="font-size:12.5px; color:var(--ink2)">{{ fr.label }}</span>
                      <span style="font-size:11.5px; color:var(--mut); line-height:1.45">{{ fr.message }}</span>
                    </span>
                  </div>
                </sc-for>
              </div>
              <sc-if value="{{ finFail.canStart }}" hint-placeholder-val="{{ true }}">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
                  <button type="button" sc-camel-on-click="{{ finFail.start }}" class="btn" style="border-radius:12px; background:var(--chipAmberBg); border:1px solid var(--chipAmberBd); color:var(--fgAmberDeep)" style-hover="transform:translateY(-1px)"><i class="ph ph-arrow-fat-line-up" style="font-size:15px"></i>Escalate to Management</button>
                  <span style="flex:1; min-width:180px; font-size:11.5px; color:var(--fgRedDeep); line-height:1.45">{{ finFail.recipients }}</span>
                </div>
              </sc-if>
              <sc-if value="{{ finFail.noEscalate }}" hint-placeholder-val="{{ false }}">
                <span style="font-size:11.5px; color:var(--fgRedDeep)">This request cannot be escalated. Contact Sven.</span>
              </sc-if>
              <sc-if value="{{ finFail.open }}" hint-placeholder-val="{{ false }}">
                <div style="display:flex; flex-direction:column; gap:8px; padding:12px; border-radius:13px; background:var(--sf); border:1px solid var(--chipRedBd)">
                  <label style="font-size:12px; color:var(--ink2)">Why should management approve this request? *</label>
                  <textarea class="input" placeholder="The client paid in cash today; the receipt will be in Zoho Books by Monday." value="{{ finFail.justification }}" sc-camel-on-change="{{ finFail.onJustification }}" style="border-radius:12px; min-height:84px; background:var(--sf2)"></textarea>
                  <span style="font-size:11px; color:{{ finFail.hintFg }}">{{ finFail.hint }}</span>
                  <sc-if value="{{ finFail.sendError }}" hint-placeholder-val="{{ false }}">
                    <div style="display:flex; align-items:center; gap:7px; font-size:12px; color:var(--fgRedDeep)"><i class="ph ph-warning-circle" style="font-size:14px"></i>{{ finFail.sendError }}</div>
                  </sc-if>
                  <div style="display:flex; justify-content:flex-end; gap:9px; flex-wrap:wrap">
                    <button type="button" sc-camel-on-click="{{ finFail.cancel }}" class="btn" style="border-radius:12px; background:var(--sf); border:1px solid var(--line3); color:var(--ink2)" style-hover="background:var(--sf2)">Cancel</button>
                    <button type="button" sc-camel-on-click="{{ finFail.send }}" disabled="{{ finFail.busy }}" class="btn" style="border-radius:12px; color:#fff; background:linear-gradient(140deg,#f59e0b,#b45309); box-shadow:0 6px 16px rgba(180,83,9,.24)"><i class="ph ph-paper-plane-tilt" style="font-size:15px"></i>{{ finFail.sendLabel }}</button>
                  </div>
                </div>
              </sc-if>
            </div>
          </sc-if>

`;

// B3. voided banner, under the "what happens next" strip
const VOID_BANNER = `
          <sc-if value="{{ detail.locked }}" hint-placeholder-val="{{ false }}">
            <div role="status" style="display:flex; align-items:center; gap:10px; margin-top:12px; padding:12px 15px; border-radius:14px; background:var(--tint); border:1px solid var(--line); color:var(--mut); font-size:12.5px; line-height:1.5"><i class="ph ph-lock-simple" style="font-size:16px; flex:none"></i>{{ detail.voidLine }}</div>
          </sc-if>
`;

// B3/B4. Chase invoice (every status but VOID) and Void request (Sven and management)
const DETAIL_ACTIONS = `          <sc-if value="{{ detail.editable }}" hint-placeholder-val="{{ true }}">
            <div style="display:flex; gap:9px; margin-top:16px; flex-wrap:wrap">
              <sc-if value="{{ detail.canChase }}" hint-placeholder-val="{{ true }}">
                <button type="button" sc-camel-on-click="{{ detail.chase }}" ${BTN_SOFT}><i class="ph ph-paperclip" style="font-size:15px"></i>Chase invoice</button>
              </sc-if>
              <sc-if value="{{ detail.canVoid }}" hint-placeholder-val="{{ false }}">
                <button type="button" sc-camel-on-click="{{ detail.voidGo }}" class="btn" style="margin-left:auto; font-size:12.5px; border-radius:11px; background:var(--sf); border:1px solid var(--chipRedBd); color:var(--fgRed)" style-hover="background:var(--chipRedBg)"><i class="ph ph-x-circle" style="font-size:15px"></i>Void request</button>
              </sc-if>
            </div>
          </sc-if>
`;

const CARD = 'margin-top:16px; border-radius:24px; background:var(--sf); box-shadow:0 4px 16px rgba(16,38,66,.06), 0 0 0 1px var(--line); padding:20px 22px';
const LABEL = 'font-size:10px; letter-spacing:0.08em; text-transform:uppercase; color:var(--mut3)';

// B1. financial validation, B2. escalation ticket
const DETAIL_CARDS = `
        <sc-if value="{{ detail.hasFin }}" hint-placeholder-val="{{ false }}">
          <section style="${CARD}">
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px">
              <h6 style="color:var(--mut); margin:0">Financial validation</h6>
              <span style="font-size:11.5px; color:var(--mut3)">{{ detail.fin.sub }}</span>
              <span style="margin-left:auto; display:inline-flex; align-items:center; gap:6px; font-size:11.5px; padding:4px 10px; border-radius:9px; background:{{ detail.fin.chipBg }}; border:1px solid {{ detail.fin.chipBd }}; color:{{ detail.fin.chipFg }}"><i class="{{ detail.fin.chipIcon }}" style="font-size:14px"></i>{{ detail.fin.chip }}</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px">
              <sc-for list="{{ detail.fin.checks }}" as="fc" hint-placeholder-count="3">
                <div style="display:flex; align-items:flex-start; gap:11px; padding:12px 14px; border-radius:14px; background:{{ fc.bg }}; border:1px solid {{ fc.bd }}">
                  <i class="{{ fc.icon }}" style="font-size:18px; color:{{ fc.fg }}; flex:none; margin-top:1px"></i>
                  <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:3px">
                    <span style="font-size:13px; color:var(--ink2)">{{ fc.label }}</span>
                    <span style="font-size:12px; color:var(--mut); line-height:1.45">{{ fc.message }}</span>
                    <sc-if value="{{ fc.hasDetail }}" hint-placeholder-val="{{ false }}">
                      <span style="font-size:11.5px; color:var(--mut2); line-height:1.45">{{ fc.detail }}</span>
                    </sc-if>
                    <sc-if value="{{ fc.hasItems }}" hint-placeholder-val="{{ false }}">
                      <div style="display:flex; flex-direction:column; gap:3px; margin-top:4px">
                        <sc-for list="{{ fc.items }}" as="fi" hint-placeholder-count="2">
                          <div style="display:flex; align-items:flex-start; gap:7px; font-size:11.5px; line-height:1.45">
                            <i class="{{ fi.icon }}" style="font-size:12px; color:{{ fi.fg }}; flex:none; margin-top:2px"></i>
                            <span style="color:var(--ink3)">{{ fi.label }}</span>
                            <span style="color:var(--mut2); overflow-wrap:anywhere">{{ fi.text }}</span>
                          </div>
                        </sc-for>
                      </div>
                    </sc-if>
                  </div>
                </div>
              </sc-for>
            </div>
            <div style="font-size:11px; color:var(--mut3); margin-top:10px">Source: {{ detail.fin.source }}</div>
          </section>
        </sc-if>

        <sc-if value="{{ detail.hasEsc }}" hint-placeholder-val="{{ false }}">
          <section style="${CARD}">
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px">
              <h6 style="color:var(--mut); margin:0">Escalation to management</h6>
              <span style="font-size:11.5px; color:var(--mut3)">{{ detail.esc.id }} · {{ detail.esc.raised }}</span>
            </div>
            <div style="display:flex; align-items:flex-start; gap:10px; padding:12px 14px; border-radius:14px; background:{{ detail.esc.toneBg }}; border:1px solid {{ detail.esc.toneBd }}">
              <i class="{{ detail.esc.toneIcon }}" style="font-size:18px; color:{{ detail.esc.toneFg }}; flex:none; margin-top:1px"></i>
              <div style="display:flex; flex-direction:column; gap:3px; min-width:0">
                <span style="font-size:13px; color:{{ detail.esc.toneFg }}">{{ detail.esc.decisionLine }}</span>
                <sc-if value="{{ detail.esc.hasNote }}" hint-placeholder-val="{{ false }}">
                  <span style="font-size:12px; color:var(--ink2); line-height:1.45">{{ detail.esc.decisionNote }}</span>
                </sc-if>
              </div>
            </div>
            <div style="display:grid; grid-template-columns:{{ L.grid2 }}; gap:12px 22px; margin-top:14px">
              <div>
                <div style="${LABEL}">Justification</div>
                <div style="font-size:13px; color:var(--ink2); margin-top:3px; line-height:1.5; overflow-wrap:anywhere">{{ detail.esc.justification }}</div>
              </div>
              <div>
                <div style="${LABEL}">Sent to</div>
                <div style="font-size:13px; color:var(--ink2); margin-top:3px; line-height:1.5">{{ detail.esc.to }}</div>
              </div>
            </div>
            <sc-if value="{{ detail.esc.hasFailed }}" hint-placeholder-val="{{ false }}">
              <div style="margin-top:14px">
                <div style="${LABEL}">Failed checks</div>
                <div style="display:flex; flex-direction:column; gap:5px; margin-top:6px">
                  <sc-for list="{{ detail.esc.failed }}" as="ef" hint-placeholder-count="1">
                    <div style="display:flex; align-items:flex-start; gap:8px; font-size:12px; line-height:1.45">
                      <i class="ph ph-x-circle" style="font-size:14px; color:var(--fgRed); flex:none; margin-top:1px"></i>
                      <span><span style="color:var(--ink2)">{{ ef.label }}</span> — <span style="color:var(--mut)">{{ ef.message }}</span></span>
                    </div>
                  </sc-for>
                </div>
              </div>
            </sc-if>
            <sc-if value="{{ detail.esc.canDecide }}" hint-placeholder-val="{{ false }}">
              <div style="display:flex; gap:9px; flex-wrap:wrap; margin-top:16px">
                <button type="button" sc-camel-on-click="{{ detail.esc.approve }}" class="btn" style="border-radius:12px; color:#fff; background:linear-gradient(140deg,#22c55e,#15803d); box-shadow:0 6px 16px rgba(21,128,61,.24)"><i class="ph ph-seal-check" style="font-size:15px"></i>Approve & proceed</button>
                <button type="button" sc-camel-on-click="{{ detail.esc.reject }}" class="btn" style="border-radius:12px; background:var(--sf); border:1px solid var(--chipRedBd); color:var(--fgRed)" style-hover="background:var(--chipRedBg)"><i class="ph ph-prohibit" style="font-size:15px"></i>Reject escalation</button>
                <button type="button" sc-camel-on-click="{{ detail.esc.info }}" class="btn" style="border-radius:12px; background:var(--sf2); border:1px solid var(--line3); color:var(--ink2)" style-hover="background:var(--sf3)"><i class="ph ph-question" style="font-size:15px"></i>Request more information</button>
              </div>
            </sc-if>
            <sc-if value="{{ detail.esc.canReply }}" hint-placeholder-val="{{ false }}">
              <div style="display:flex; gap:9px; flex-wrap:wrap; margin-top:16px">
                <button type="button" sc-camel-on-click="{{ detail.esc.reply }}" class="btn" style="border-radius:12px; color:#fff; background:linear-gradient(140deg,#3b82f6,#1d4ed8); box-shadow:0 6px 16px rgba(29,99,230,.26)"><i class="ph ph-chat-circle-text" style="font-size:15px"></i>Reply to management</button>
              </div>
            </sc-if>
            <sc-if value="{{ detail.esc.hasLog }}" hint-placeholder-val="{{ false }}">
              <div style="display:flex; flex-direction:column; gap:8px; margin-top:16px; padding-top:14px; border-top:1px solid var(--line2)">
                <div style="${LABEL}">Escalation log</div>
                <sc-for list="{{ detail.esc.log }}" as="el" hint-placeholder-count="2">
                  <div style="display:flex; flex-direction:column; gap:1px">
                    <span style="font-size:10.5px; color:var(--mut3)">{{ el.at }}</span>
                    <span style="font-size:12.5px; color:var(--ink2); line-height:1.45">{{ el.text }}</span>
                  </div>
                </sc-for>
              </div>
            </sc-if>
          </section>
        </sc-if>
`;

// D. notification peek: management decision, reply, chase and void — without leaving the Updates panel
const PEEK_MORE = `              <sc-if value="{{ peek.hasMore }}" hint-placeholder-val="{{ false }}">
                <div style="display:flex; gap:8px; flex-wrap:wrap">
                  <sc-if value="{{ peek.mgmtDecide }}" hint-placeholder-val="{{ false }}">
                    <button type="button" sc-camel-on-click="{{ peek.mApprove }}" class="btn" style="border-radius:12px; color:#fff; background:linear-gradient(140deg,#22c55e,#15803d); box-shadow:0 6px 16px rgba(21,128,61,.24)"><i class="ph ph-seal-check" style="font-size:15px"></i>Approve & proceed</button>
                    <button type="button" sc-camel-on-click="{{ peek.mReject }}" class="btn" style="border-radius:12px; background:var(--sf); border:1px solid var(--chipRedBd); color:var(--fgRed)"><i class="ph ph-prohibit" style="font-size:15px"></i>Reject escalation</button>
                    <button type="button" sc-camel-on-click="{{ peek.mInfo }}" class="btn" style="border-radius:12px; background:var(--sf2); border:1px solid var(--line3); color:var(--ink2)"><i class="ph ph-question" style="font-size:15px"></i>Request more information</button>
                  </sc-if>
                  <sc-if value="{{ peek.canReply }}" hint-placeholder-val="{{ false }}">
                    <button type="button" sc-camel-on-click="{{ peek.reply }}" class="btn" style="border-radius:12px; color:#fff; background:linear-gradient(140deg,#3b82f6,#1d4ed8)"><i class="ph ph-chat-circle-text" style="font-size:15px"></i>Reply to management</button>
                  </sc-if>
                  <sc-if value="{{ peek.canChase }}" hint-placeholder-val="{{ true }}">
                    <button type="button" sc-camel-on-click="{{ peek.chase }}" class="btn" style="border-radius:12px; background:var(--sf2); border:1px solid var(--line3); color:var(--ink2)"><i class="ph ph-paperclip" style="font-size:15px"></i>Chase invoice</button>
                  </sc-if>
                  <sc-if value="{{ peek.canVoid }}" hint-placeholder-val="{{ false }}">
                    <button type="button" sc-camel-on-click="{{ peek.voidGo }}" class="btn" style="border-radius:12px; background:var(--sf); border:1px solid var(--chipRedBd); color:var(--fgRed)"><i class="ph ph-x-circle" style="font-size:15px"></i>Void request</button>
                  </sc-if>
                </div>
              </sc-if>
`;

// global modal: files for "Chase invoice"
const MODAL_FILES = `        <sc-if value="{{ modal.hasFiles }}" hint-placeholder-val="{{ false }}">
          <div style="display:flex; flex-direction:column; gap:8px">
            <button type="button" sc-camel-on-click="{{ modal.pickFiles }}" class="btn" style="align-self:flex-start; font-size:12.5px; border-radius:11px; background:var(--sf3); border:1px solid var(--line3); color:var(--fgBlue)"><i class="ph ph-paperclip" style="font-size:15px"></i>Attach invoice / receipt</button>
            <sc-for list="{{ modal.files }}" as="mf" hint-placeholder-count="1">
              <div style="display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:12px; background:var(--sf2); border:1px solid var(--line)">
                <i class="{{ mf.icon }}" style="font-size:17px; color:var(--fgBlue); flex:none"></i>
                <span style="flex:1; min-width:0; display:flex; flex-direction:column; gap:1px">
                  <span style="font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ mf.name }}</span>
                  <span style="font-size:11px; color:{{ mf.metaFg }}">{{ mf.meta }}</span>
                </span>
                <sc-if value="{{ mf.uploading }}" hint-placeholder-val="{{ false }}">
                  <span style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--fgBlue)"><i class="ph ph-circle-notch" style="font-size:14px; animation:spin .9s linear infinite"></i>Uploading</span>
                </sc-if>
                <sc-if value="{{ mf.done }}" hint-placeholder-val="{{ false }}">
                  <i class="ph ph-check-circle" style="font-size:16px; color:var(--fgGreen)"></i>
                </sc-if>
                <button type="button" sc-camel-on-click="{{ mf.remove }}" class="btn" title="Remove" style="flex:none; width:28px; height:28px; padding:0; border-radius:9px; color:var(--mut2)" style-hover="background:var(--chipRedBg); color:var(--fgRed)"><i class="ph ph-trash" style="font-size:13px"></i></button>
              </div>
            </sc-for>
          </div>
        </sc-if>
`;

const MODAL_CONFIRM_FROM = `          <button type="button" sc-camel-on-click="{{ modal.confirm }}" class="btn" style="border-radius:12px; padding:9px 18px; color:#fff; background:linear-gradient(140deg,#3b82f6,#1d4ed8); box-shadow:0 6px 16px rgba(29,99,230,.26)">{{ modal.confirmLabel }}</button>`;
const MODAL_CONFIRM_TO = `          <button type="button" sc-camel-on-click="{{ modal.confirm }}" disabled="{{ modal.confirmDisabled }}" class="btn" style="border-radius:12px; padding:9px 18px; color:#fff; background:{{ modal.confirmBg }}; box-shadow:{{ modal.confirmSh }}">{{ modal.confirmText }}</button>`;

// E. Master Control → Platform reset
const RESET_PANE = `            <sc-if value="{{ master.m_reset }}" hint-placeholder-val="{{ false }}">
              <div style="display:flex; flex-direction:column; gap:14px; animation:fadeIn .22s ease">
                <section style="border-radius:18px; border:1px solid var(--chipAmberBd); background:var(--chipAmberBg); padding:16px 18px; display:flex; align-items:flex-start; gap:10px">
                  <i class="ph ph-broom" style="font-size:19px; color:var(--fgAmberDeep); flex:none; margin-top:1px"></i>
                  <p style="margin:0; font-size:12.5px; color:var(--fgAmberDeep); line-height:1.55; max-width:78ch">{{ master.reset.intro }}</p>
                </section>
                <sc-if value="{{ master.reset.error }}" hint-placeholder-val="{{ false }}">
                  <div role="alert" style="display:flex; align-items:center; gap:8px; font-size:12.5px; padding:11px 13px; border-radius:13px; background:var(--chipRedBg); border:1px solid var(--chipRedBd); color:var(--fgRedDeep)"><i class="ph ph-warning-circle" style="font-size:15px"></i>{{ master.reset.error }}</div>
                </sc-if>
                <sc-if value="{{ master.reset.hasResult }}" hint-placeholder-val="{{ false }}">
                  <section style="border-radius:18px; border:1px solid var(--chipGreenBd); background:var(--chipGreenBg); padding:14px 18px; display:flex; flex-direction:column; gap:4px">
                    <span style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fgGreen)"><i class="ph ph-check-circle" style="font-size:16px"></i>{{ master.reset.resultLine }}</span>
                    <span style="font-size:12px; color:var(--ink2)">{{ master.reset.removedLine }}</span>
                    <span style="font-size:12px; color:var(--mut)">{{ master.reset.keptLine }}</span>
                  </section>
                </sc-if>
                <section style="border-radius:18px; background:var(--sf); border:1px solid var(--line); overflow:hidden">
                  <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:14px 18px">
                    <h6 style="margin:0; color:var(--mut)">Requests created on the live platform</h6>
                    <span style="font-size:11.5px; color:var(--mut3)">{{ master.reset.selLine }}</span>
                    <span style="margin-left:auto; display:flex; gap:6px; flex-wrap:wrap">
                      <button type="button" sc-camel-on-click="{{ master.reset.selectAll }}" class="btn btn-ghost" style="font-size:12px">Select all</button>
                      <button type="button" sc-camel-on-click="{{ master.reset.selectNone }}" class="btn btn-ghost" style="font-size:12px">None</button>
                      <button type="button" sc-camel-on-click="{{ master.reset.refresh }}" ${BTN_SOFT}><i class="ph ph-arrows-clockwise" style="font-size:14px"></i>Refresh</button>
                    </span>
                  </div>
                  <sc-if value="{{ master.reset.loading }}" hint-placeholder-val="{{ false }}">
                    <div style="display:flex; align-items:center; gap:8px; padding:12px 18px; border-top:1px solid var(--line2); font-size:12.5px; color:var(--mut2)"><i class="ph ph-circle-notch" style="font-size:15px; animation:spin .9s linear infinite"></i>Loading from the live server…</div>
                  </sc-if>
                  <sc-if value="{{ master.reset.noRows }}" hint-placeholder-val="{{ false }}">
                    <div style="padding:12px 18px; border-top:1px solid var(--line2); font-size:12.5px; color:var(--mut3)">No requests have been created on the live platform.</div>
                  </sc-if>
                  <sc-for list="{{ master.reset.rows }}" as="rr" hint-placeholder-count="3">
                    <label style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:10px 18px; border-top:1px solid var(--line2); cursor:pointer">
                      <input type="checkbox" checked="{{ rr.checked }}" sc-camel-on-change="{{ rr.toggle }}" style="accent-color:var(--fgRed)">
                      <span style="width:70px; flex:none; font-size:12px; color:var(--ink3); font-variant-numeric:tabular-nums">{{ rr.id }}</span>
                      <span style="flex:1; min-width:160px; display:flex; flex-direction:column; gap:1px">
                        <span style="font-size:12.5px; color:var(--ink2)">{{ rr.company }}</span>
                        <span style="font-size:11px; color:var(--mut3)">{{ rr.by }} · {{ rr.date }}</span>
                      </span>
                      <span style="font-size:12px; color:var(--ink2); font-variant-numeric:tabular-nums">{{ rr.amount }}</span>
                      <span style="font-size:10.5px; padding:3px 9px; border-radius:8px; background:{{ rr.stBg }}; color:{{ rr.stFg }}">{{ rr.status }}</span>
                    </label>
                  </sc-for>
                </section>
                <section style="border-radius:18px; background:var(--sf); border:1px solid var(--line); padding:16px 18px; display:flex; flex-direction:column; gap:12px">
                  <span style="font-size:11.5px; color:var(--mut3)">{{ master.reset.nowLine }}</span>
                  <label style="display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--ink2); cursor:pointer">
                    <input type="checkbox" checked="{{ master.reset.clearNotifs }}" sc-camel-on-change="{{ master.reset.toggleNotifs }}" style="accent-color:var(--fgBlue)">Clear every notification
                  </label>
                  <label style="display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--fgRed); cursor:pointer">
                    <input type="checkbox" checked="{{ master.reset.includeHistory }}" sc-camel-on-change="{{ master.reset.toggleHistory }}" style="accent-color:var(--fgRed)">{{ master.reset.historyLabel }}
                  </label>
                  <sc-if value="{{ master.reset.historyWarn }}" hint-placeholder-val="{{ false }}">
                    <div role="alert" style="display:flex; align-items:center; gap:8px; font-size:12px; padding:10px 12px; border-radius:12px; background:var(--chipRedBg); border:1px solid var(--chipRedBd); color:var(--fgRedDeep)"><i class="ph ph-warning" style="font-size:15px"></i>{{ master.reset.historyWarn }}</div>
                  </sc-if>
                  <div class="field" style="margin:0">
                    <label>Reason *</label>
                    <input class="input" placeholder="Removing test requests before go-live" value="{{ master.reset.reason }}" sc-camel-on-change="{{ master.reset.onReason }}" style="border-radius:12px">
                  </div>
                  <div class="field" style="margin:0">
                    <label>Type RESET to confirm *</label>
                    <input class="input" placeholder="RESET" value="{{ master.reset.confirm }}" sc-camel-on-change="{{ master.reset.onConfirm }}" autocomplete="off" spellcheck="false" style="border-radius:12px; max-width:220px">
                  </div>
                  <button type="button" sc-camel-on-click="{{ master.reset.run }}" disabled="{{ master.reset.disabled }}" class="btn" style="align-self:flex-start; border-radius:12px; padding:10px 18px; background:{{ master.reset.btnBg }}; color:{{ master.reset.btnFg }}; border:1px solid var(--line)"><i class="ph ph-broom" style="font-size:16px"></i>{{ master.reset.btnLabel }}</button>
                </section>
                <section style="border-radius:18px; background:var(--sf); border:1px solid var(--line); overflow:hidden">
                  <div style="padding:14px 18px"><h6 style="margin:0; color:var(--mut)">Backups</h6></div>
                  <sc-if value="{{ master.reset.noBackups }}" hint-placeholder-val="{{ false }}">
                    <div style="padding:12px 18px; border-top:1px solid var(--line2); font-size:12.5px; color:var(--mut3)">No backups yet — one is taken automatically before every reset.</div>
                  </sc-if>
                  <sc-for list="{{ master.reset.backups }}" as="bk" hint-placeholder-count="2">
                    <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:11px 18px; border-top:1px solid var(--line2)">
                      <span style="flex:1; min-width:200px; display:flex; flex-direction:column; gap:1px">
                        <span style="font-size:12.5px; color:var(--ink2)">{{ bk.id }} · {{ bk.at }} · {{ bk.by }}</span>
                        <span style="font-size:11px; color:var(--mut3)">{{ bk.reason }}</span>
                        <span style="font-size:11px; color:var(--mut3)">{{ bk.counts }}</span>
                      </span>
                      <button type="button" sc-camel-on-click="{{ bk.restore }}" ${BTN_SOFT}><i class="ph ph-clock-counter-clockwise" style="font-size:14px"></i>Restore</button>
                    </div>
                  </sc-for>
                </section>
              </div>
            </sc-if>
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
      detail.canEscalate = isOps && this.isOpsMaster(me) && ['NEW', 'ACTION', 'APPROVED'].indexOf(r.status) >= 0;
      detail.escalate = () => this.escalate(r.id);
      detail.balanceLine = known && !(isOps && !this.isOpsMaster(me)) ? 'Zoho Analytics balance ' + this.fmt(avail) + (r.zohoStatus ? ' · ' + r.zohoStatus : '') : r.zohoStatus ? 'Zoho Analytics check · ' + r.zohoStatus : 'Zoho Analytics balance not checked yet';
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
  // Sven's decisions: management never; a lower amount needs the live balance unless management approved the escalation
  { start: "    if (m.kind === 'decline') {\n      if (!this.can('DECLINE_REQUEST'))", end: '  post() {', to: DECIDE_JS },
  // approval and credit always need a live Zoho check (the Master Controls toggle can no longer switch it off)
  ["    if (this.state.settings.requireZohoBeforeApprove && !validated) return this.runZoho(id, 'approve');",
   `    if (!validated) return this.runZoho(id, 'approve');\n    if (validated.ok !== true || validated.partialOnly) return this.flash('${INSUFFICIENT}', null, 'ph ph-flag');`],
  ["    if (this.state.settings.recheckBeforeRelease && !validated) return this.runZoho(id, 'credit');",
   "    if (!validated) return this.runZoho(id, 'credit');"],
  ["      zeroLine: zeroList.length + (zeroList.length === 1 ? ' open request has no client balance in Zoho' : ' open requests have no client balance in Zoho'),",
   "      zeroLine: zeroList.length + (zeroList.length === 1 ? ' open request does not have sufficient balance in Zoho Analytics' : ' open requests do not have sufficient balance in Zoho Analytics'),"],
  // Master Control: accounts and sign-ins update instantly and survive a reload
  ["    return this.normAcct({ key: u.key, name: u.name, username: u.username, dept: u.dept, role: u.role, active: u.active, perms: u.perms || [], created: u.created, lastLogin: u.lastLogin || '—', locked: u.locked, pwHash: 'server' });",
   "    return this.normAcct({ key: u.key, name: u.name, username: u.username, dept: u.dept, role: u.role, active: u.active, perms: u.perms || [], created: u.created, lastLogin: u.lastLogin || '—', locked: u.locked, online: !!u.online, passwordSet: u.passwordSet || '—', opsMaster: !!u.opsMaster, title: u.title || '', pwHash: 'server' });"],
  ["      this._prevAccounts = next.accounts;\n      this.setState(next);\n    });\n  }",
   "      this._prevAccounts = next.accounts;\n      this.setState(next);\n      this._rev = Math.max(this._rev || 0, j.rev || 0);\n      if (isM) { this.loadServerLoginLog(); if (!this._revT) this._revT = setInterval(() => this.revCheck(), 20000); }\n    });\n  }\n  /* Safety net for the Master view: if the server holds changes this screen never received, reload them. */\n  revCheck() {\n    if (!this.state.authed || !this._token) return;\n    this.api('/api/sync/health').then(o => { if (o.ok && o.json.rev > (this._rev || 0)) this.liveLoad(false); }).catch(() => {});\n  }\n  /* Sign-in history from the server — Master Control shows it straight after a reload, not only new events.\n     (Its own name: the export's loadLoginLog(), defined later in the class, reads browser storage and would win.) */\n  loadServerLoginLog() {\n    this.api('/api/admin/login-history').then(o => {\n      if (!o.ok || !Array.isArray(o.json)) return;\n      this.setState({ loginLog: o.json.map(x => ({ at: new Date(x.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), kind: x.kind, who: x.who, detail: x.detail })) });\n    }).catch(() => {});\n  }"],
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
   "          this.setState({ peekId: nn.req || null, peekMissing: !(nn.req && this.reqById(nn.req)) });\n          if (nn.req && this.reqById(nn.req)) this.logView(nn.req);"],
  ["      notifOpen: s.notifOpen, toggleNotif: () => this.setState({ notifOpen: !s.notifOpen }),",
   "      notifOpen: s.notifOpen, toggleNotif: () => this.setState({ notifOpen: !s.notifOpen, peekId: null, peekMissing: false }),"],
  ["go: () => this.setState({ userMenu: false, notifOpen: true }) }", "go: () => this.setState({ userMenu: false, notifOpen: true, peekId: null, peekMissing: false }) }"],
  ["      notifsEmpty: mineNotifs.length === 0,", "      notifsEmpty: mineNotifs.length === 0, peek: this.peekVals(isOps && !this.isOpsMaster(me)),"],
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
                  <button type="button" sc-camel-on-click="{{ peek.approve }}" class="btn" style="border-radius:12px; color:#fff; background:linear-gradient(140deg,#3b82f6,#1d4ed8); box-shadow:0 6px 16px rgba(29,99,230,.26)"><i class="ph ph-check-circle" style="font-size:15px"></i>{{ peek.approveLabel }}</button>
                  <button type="button" sc-camel-on-click="{{ peek.ask }}" class="btn" style="border-radius:12px; background:var(--sf2); border:1px solid var(--line3); color:var(--ink2)"><i class="ph ph-question" style="font-size:15px"></i>Ask for information</button>
                  <button type="button" sc-camel-on-click="{{ peek.decline }}" class="btn" style="border-radius:12px; background:var(--sf); border:1px solid var(--chipRedBd); color:var(--fgRed)"><i class="ph ph-prohibit" style="font-size:15px"></i>Not approved</button>
                </div>
              </sc-if>
${PEEK_MORE}              <div style="display:flex; flex-direction:column; gap:8px; padding-top:4px; border-top:1px solid var(--line2)">
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
  ['          </sc-if>\n        </div>\n      </aside>', '          </sc-if>\n        </div>\n        </sc-if>\n      </aside>'],
  // Operations see only their own requests — except Master Operations Control, who sees all of them
  ["    const scoped = s.requests.filter(r => isOps ? r.by === me.key : true);",
   "    const scoped = s.requests.filter(r => isOps && !this.isOpsMaster(me) ? r.by === me.key : true);"],
  ["  open(id) { this.go('detail', { reqId: id }); }", "  open(id) { this.go('detail', { reqId: id }); this.logView(id); }"],
  ['            <button type="button" sc-camel-on-click="{{ detail.post }}" class="btn" style="flex:none; border-radius:12px; background:var(--sf3); border:1px solid var(--line3); color:var(--fgBlue); transition:all .18s ease" style-hover="background:var(--sf3)">Send</button>',
   '            <button type="button" sc-camel-on-click="{{ detail.post }}" class="btn" style="flex:none; border-radius:12px; background:var(--sf3); border:1px solid var(--line3); color:var(--fgBlue); transition:all .18s ease" style-hover="background:var(--sf3)">Send</button>\n            <sc-if value="{{ detail.canEscalate }}" hint-placeholder-val="{{ false }}">\n              <button type="button" sc-camel-on-click="{{ detail.escalate }}" class="btn" title="Flag for Sven, with the note as the reason" style="flex:none; border-radius:12px; background:var(--chipAmberBg); border:1px solid var(--chipAmberBd); color:var(--fgAmberDeep)"><i class="ph ph-arrow-fat-line-up" style="font-size:15px"></i>Escalate to Sven</button>\n            </sc-if>'],

  // ── upgrade: statuses ──────────────────────────────────
  ["      NEW: ['Requested', 'var(--fgPurple)'", "      NEW: ['" + PROVISIONAL + "', 'var(--fgPurple)'"],
  [STATUS_META_FROM, STATUS_META_TO],
  // F. no built-in client directory or balance book — Zoho Books / Analytics are the only source
  { start: '  zohoLookup(company) {', end: '\n  runZoho(id, mode) {',
    to: "  zohoLookup(company) {\n    return { missing: true, available: 0, allocated: 0, used: 0 }; // no built-in balance book — balances come from Zoho Analytics only\n  }\n" },
  { start: '  zohoDirectory() {', end: '  zohoValidateUrl() {',
    to: "  zohoDirectory() { return []; } // no built-in client list — clients come from Zoho Books only\n" },
  // B5. management override for Sven's final approval and the credit
  { start: '  approveFull(id, validated) {', end: '  approveAvailable(id, amount, v) {', to: APPROVE_FULL_JS },
  { start: '  creditNow(id, validated) {', end: '  markPaid(id) {', to: CREDIT_NOW_JS },
  ["    this.flash('Approved ' + this.fmt(amt) + ' — the available balance', () => this.undoTo(before));",
   "    this.flash('Approved ' + this.fmt(amt) + ' — the available balance', this.undoable(r) ? () => this.undoTo(before) : null);"],
  // 5c. a refused sync write shows the server's reason, then the screen goes back to the server's copy
  ["          if (o.status === 403) this.flash('The server refused that change — not permitted for your account', null, 'ph ph-prohibit');",
   "          if (o.status === 403) { this.flash((o.json && o.json.error) || 'The server refused that change — not permitted for your account', null, 'ph ph-prohibit'); this.liveLoad(false); }"],
  // 6. the automatic check after Send also evaluates the "client already paid us?" answer
  ["      company: r.company, purpose: r.purpose, requestedAmount: r.requested, zone: r.zone, validationToken:",
   "      company: r.company, purpose: r.purpose, requestedAmount: r.requested, zone: r.zone, paid: r.paid, validationToken:"],
  // modal kinds: mgmtApprove, mgmtReject, mgmtInfo, mgmtReply, void, chase, restore
  { start: '  openModal(kind, id) {', end: '  confirmModal() {', to: OPEN_MODAL_JS },
  ["    const r = this.reqById(m.id);\n    if (m.kind === 'override') {", CONFIRM_NEW_KINDS + "    const r = this.reqById(m.id);\n    if (m.kind === 'override') {"],
  // chase files go into the modal, not onto the request
  ["  takeFiles(fileList, target) {\n", "  takeFiles(fileList, target) {\n    if (target === 'chase') return this.takeChaseFiles(fileList);\n"],
  // A. changing the amount or "already paid?" voids the failed-check result and its escalation pass
  ["      errors: Object.assign({}, s.errors, { [k]: null, summary: null })\n    }));",
   "      errors: Object.assign({}, s.errors, { [k]: null, summary: null }),\n      finFail: k === 'amount' || k === 'paid' ? null : s.finFail\n    }));"],
  ["  restartRequest() {\n", FLOW_JS + "  restartRequest() {\n"],

  // C. board
  { start: '    const tabDef = isOps\n', end: '    const inTab = k => {', to: TAB_DEF_JS },
  { start: '    const actionFor = r => {\n', end: '    const rowVM = r => {', to: ACTION_FOR_JS },
  ["        amountColor: r.status === 'DECLINED' ? 'var(--mut4)' : 'var(--ink)',", "        amountColor: r.status === 'DECLINED' || r.status === 'VOID' ? 'var(--mut4)' : 'var(--ink)',"],
  { start: '    const secDef = isOps\n', end: '    const sections = secDef', to: SEC_DEF_JS },
  ["DECLINED: ['ph ph-prohibit', 'var(--fgRed)', 'var(--chipRedBg)'] };",
   "DECLINED: ['ph ph-prohibit', 'var(--fgRed)', 'var(--chipRedBg)'], ESCALATED: ['ph ph-arrow-fat-line-up', 'var(--fgAmberDeep)', 'var(--chipAmberBg)'], MGMT_INFO: ['ph ph-question', 'var(--fgAmber)', 'var(--chipAmberBg)'], MGMT_APPROVED: ['ph ph-seal-check', 'var(--fgGreen)', 'var(--chipGreenBg)'], VOID: ['ph ph-lock-simple', 'var(--mut)', 'var(--tint)'] };"],

  // B. request page view model
  ["    let detail = { tiles: [], fields: [], docs: [], timeline: [], decisions: [], st: this.statusMeta('NEW') };",
   "    let detail = { tiles: [], fields: [], docs: [], timeline: [], decisions: [], st: this.statusMeta('NEW'), fin: { checks: [] }, esc: { failed: [], log: [] } };"],
  [NEXT_TEXT_FROM, NEXT_TEXT_TO],
  ["      if (!isOps && (r.status === 'NEW' || r.status === 'ACTION')) {",
   "      if (!isOps && !mgmtMe && (r.status === 'NEW' || r.status === 'ACTION' || r.status === 'MGMT_APPROVED')) {"],
  [ST_TAB_FROM, ST_TAB_TO],
  ["    }\n\n    const forced = this.p('layout', 'Auto');",
   "      Object.assign(detail, this.detailExtra(r, me, isOps));\n    }\n\n    const forced = this.p('layout', 'Auto');"],

  // E. Master Control → Platform reset
  ["        ['audit', 'Audit log', 'ph ph-scroll'], ['security', 'Security', 'ph ph-shield-check']\n      ].map(nv => ({",
   "        ['audit', 'Audit log', 'ph ph-scroll'], ['security', 'Security', 'ph ph-shield-check'], ['reset', 'Platform reset', 'ph ph-broom']\n      ].map(nv => ({"],
  ["        go: () => this.setState({ masterTab: nv[0] })\n      }));",
   "        go: () => { this.setState({ masterTab: nv[0] }); if (nv[0] === 'reset') this.loadReset(); }\n      }));"],
  ["      master.m_sec = s.masterTab === 'security';",
   "      master.m_sec = s.masterTab === 'security';\n      master.m_reset = s.masterTab === 'reset';\n      master.reset = this.resetVals();"],
  ["audit: 'Audit log', security: 'Security' })[s.masterTab];", "audit: 'Audit log', security: 'Security', reset: 'Platform reset' })[s.masterTab];"],
  ["        security: 'What the prototype does, and what production must do.'\n",
   "        security: 'What the prototype does, and what production must do.',\n        reset: 'Clear test data from the live platform. A backup is taken first and can be restored.'\n"],

  // renderVals: form escalation panel + modal extras
  ["      formShake: s.shake ? 'shake .4s ease ' + s.shake : 'none',", "      formShake: s.shake ? 'shake .4s ease ' + s.shake : 'none',\n      finFail: this.finFailVals(),"],
  [MODAL_VALS_FROM, MODAL_VALS_TO],

  // markup
  ['          <sc-if value="{{ askNoDoc }}" hint-placeholder-val="{{ false }}">', FINFAIL_MARKUP + '          <sc-if value="{{ askNoDoc }}" hint-placeholder-val="{{ false }}">'],
  ['{{ detail.actLabel }}</button>\n            </sc-if>\n          </div>\n', '{{ detail.actLabel }}</button>\n            </sc-if>\n          </div>\n' + VOID_BANNER],
  ['          </sc-if>\n        </div>\n\n        <section style="margin-top:16px; border-radius:24px; background:var(--sf); box-shadow:0 4px 16px rgba(16,38,66,.06), 0 0 0 1px var(--line); padding:20px 22px">\n          <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px">\n            <h6 style="color:var(--mut); margin:0">Documents</h6>',
   '          </sc-if>\n' + DETAIL_ACTIONS + '        </div>\n' + DETAIL_CARDS + '\n        <section style="margin-top:16px; border-radius:24px; background:var(--sf); box-shadow:0 4px 16px rgba(16,38,66,.06), 0 0 0 1px var(--line); padding:20px 22px">\n          <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px">\n            <h6 style="color:var(--mut); margin:0">Documents</h6>'],
  // a voided request is locked: no upload button, drop zone or note box
  ['            <button type="button" sc-camel-on-click="{{ pickDetailFiles }}" class="btn" style="margin-left:auto;',
   '            <sc-if value="{{ detail.editable }}" hint-placeholder-val="{{ true }}"><button type="button" sc-camel-on-click="{{ pickDetailFiles }}" class="btn" style="margin-left:auto;'],
  ['<i class="ph ph-upload-simple" style="font-size:15px"></i>Upload files</button>\n', '<i class="ph ph-upload-simple" style="font-size:15px"></i>Upload files</button></sc-if>\n'],
  ['          <div sc-camel-on-click="{{ pickDetailFiles }}"', '          <sc-if value="{{ detail.editable }}" hint-placeholder-val="{{ true }}">\n          <div sc-camel-on-click="{{ pickDetailFiles }}"'],
  ['            <div style="font-size:11.5px; color:var(--mut3); margin-top:3px">PDF, JPG or PNG · up to 7 MB each</div>\n          </div>\n',
   '            <div style="font-size:11.5px; color:var(--mut3); margin-top:3px">PDF, JPG or PNG · up to 7 MB each</div>\n          </div>\n          </sc-if>\n'],
  ['          <div style="display:flex; gap:9px; margin-top:4px">\n            <input class="input" placeholder="Add a note for the other side"',
   '          <sc-if value="{{ detail.editable }}" hint-placeholder-val="{{ true }}">\n          <div style="display:flex; gap:9px; margin-top:4px">\n            <input class="input" placeholder="Add a note for the other side"'],
  ['Escalate to Sven</button>\n            </sc-if>\n          </div>\n        </section>', 'Escalate to Sven</button>\n            </sc-if>\n          </div>\n          </sc-if>\n        </section>'],
  // global modal: chase files, busy / danger confirm
  ['        </sc-for>\n        <sc-if value="{{ modal.hasError }}"', '        </sc-for>\n' + MODAL_FILES + '        <sc-if value="{{ modal.hasError }}"'],
  [MODAL_CONFIRM_FROM, MODAL_CONFIRM_TO],
  // Master Control: the reset pane, after Security
  ['            </sc-if>\n          </div>\n        </div>\n      </div>\n    </sc-if>\n\n</main>', '            </sc-if>\n' + RESET_PANE + '          </div>\n        </div>\n      </div>\n    </sc-if>\n\n</main>']
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
