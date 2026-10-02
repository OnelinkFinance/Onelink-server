// Funding-request workflow patches for the Claude Design export (index.html).
// Applied to the decoded page template as it is served, so index.html stays the untouched export.
//
//   1. Client field is a live Zoho Books type-ahead: 2+ letters → matching clients → pick one.
//      Typed names are never accepted; no match shows "Client not found in Zoho Books. Cannot proceed."
//   2. Picking a client reads its balance from Zoho Analytics straight away, and the amount field
//      compares against it as the user types.
//   3. Sending a request runs the live funding check: sufficient balance → "Partially Approved – pending
//      final confirmation with Sven"; zero/insufficient → flagged for Sven. The server writes the chat
//      export and the funding sheet row.
//
// Each rule is either [from, to] (exact text, must occur once) or { start, end, to } (replaces the
// text from `start` up to, not including, `end`). If any rule misses, none are applied — a new export
// is served as-is rather than half-patched (the server still refuses typed client names).

const NOT_FOUND = 'Client not found in Zoho Books. Cannot proceed.';
const INSUFFICIENT = 'Client does not have sufficient balance in Zoho Analytics. Flagging Sven for review.';
const PROVISIONAL = 'Partially Approved – pending final confirmation with Sven';

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
    this.setState({ gate: Object.assign({}, g, { name: v, status: 'idle', results: [], notFound: false, searching: term.length >= 2, active: 0, hintErr: '', error: '' }) });
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
            gate: { name: o.j.clientName, status: 'ok', at: this.now(), clientId: o.j.clientId, matchedIn: o.j.matchedIn, token: o.j.token, balance: o.j.balance || null },
            form: Object.assign({}, s.form || this.blankForm(), (s.form && s.form.company) ? {} : { company: o.j.companyName || '' })
          }));
          if (o.j.balance && o.j.balance.pending) this.loadBalance(o.j.clientId);
          return;
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
          name: c.contactName, sub: (c.companyName && c.companyName !== c.contactName ? c.companyName + ' · ' : '') + 'Zoho Books · ' + c.contactId,
          active: i === act, bg: i === act ? 'var(--sf2)' : 'transparent', pick: () => this.pickClient(c)
        })),
        notFound: nf, notFoundMsg: '${NOT_FOUND}',
        title: { idle: 'Who is this request for?', checking: 'Confirming in Zoho Books and reading the Zoho Analytics balance…', ok: 'Client selected from Zoho Books', failed: 'Client not found — workflow locked', error: 'Zoho could not be reached' }[g.status],
        icon: { idle: 'ph ph-magnifying-glass', checking: 'ph ph-circle-notch', ok: 'ph ph-seal-check', failed: 'ph ph-prohibit', error: 'ph ph-plugs' }[g.status],
        iconSpin: g.status === 'checking' || g.searching ? 'spin .9s linear infinite' : 'none',
        iconBg: g.status === 'ok' ? 'var(--chipGreenBg)' : g.status === 'failed' || nf ? 'var(--chipRedBg)' : 'var(--chipBlueBg)',
        iconFg: g.status === 'ok' ? 'var(--fgGreen)' : g.status === 'failed' || nf ? 'var(--fgRed)' : 'var(--fgBlue)',
        frame: g.status === 'ok' ? 'var(--fgGreen)' : g.status === 'failed' || nf ? 'var(--fgRed)' : 'var(--line)',
        anim: g.status === 'failed' ? 'none' : 'riseIn .26s ease',
        inputBd: g.hintErr || nf ? 'var(--fgRed)' : 'var(--line)',
        hint: g.hintErr || (g.searching ? 'Searching Zoho Books…' : typed.length < 2 ? 'Type at least two letters — matching Zoho Books clients appear below. Typed names are not accepted.' : list.length ? list.length + ' Zoho Books match' + (list.length === 1 ? '' : 'es') + ' — pick one to continue.' : ''),
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
      detail.balanceLine = known ? 'Zoho Analytics balance ' + this.fmt(avail) + (r.zohoStatus ? ' · ' + r.zohoStatus : '') : 'Zoho Analytics balance not checked yet';
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
`]
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
