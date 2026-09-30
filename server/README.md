# OneLink funding backend

## Go live (about 10 minutes)
1. Push this project to a GitHub repo (the `render.yaml` at the root is a ready blueprint).
2. Render → New → Blueprint → pick the repo. Fill in MASTER_ADMIN_PASSWORD (12+), SEED_TEAM_PASSWORD (8+), RECOVERY_CODE (12+). Leave ZOHO_MOCK=1 until the Zoho keys are in.
3. Copy the service URL, e.g. `https://onelink-funding-backend.onrender.com`.
4. In the design, open Tweaks → Live server → apiBase and paste that URL. Publish the artifact again.
5. Everyone signs in on the published link; the header chip shows **Live · n online**. Requests, approvals, chat, notifications, logins and account changes now reach every signed-in user instantly.
6. When Zoho/Google keys are ready, add them and set ZOHO_MOCK=0.

`POST /api/zoho/client-funding-check` — validates a funding request against Zoho Books + Zoho Analytics, decides the status, appends a row to **Finance_Approval_Records**, and returns a summary for Sven.

## Live, real-time sync (lib/store.js)
The published artifact is a static file; this server is what makes it live. Every signed-in browser loads the same data from `data/platform.json` and receives every change instantly over Server-Sent Events.
- `GET /api/sync/snapshot` — requests, chat, notifications, audit, accounts (filtered by role: operations see only their own requests).
- `POST /api/sync/put { col, item }` — create/update; write rules enforced server-side, then pushed to every connected user who may see it.
- `GET /api/sync/stream?t=<token>` — the live feed (heartbeat every 20 s). Master Admin also receives every login and account change.
- `POST /api/sync/bootstrap` — on first Master Admin sign-in, uploads the current workbook when the server is empty.
- Needs one always-on instance with a persistent disk (Render/Railway/Fly/VPS). Serverless functions will drop the live stream.

## Login enforcement (lib/auth.js)
- `POST /api/auth/login` → HttpOnly Secure session cookie; 30-minute idle expiry; 5 wrong passwords lock the account for 15 min.
- Every `/api/zoho/*` route returns `401 LOGIN_REQUIRED` without a valid session.
- Users live in `data/users.json` (scrypt-hashed) until the Master Admin deletes or deactivates them. Deactivating, deleting or resetting a password kills that user's live sessions.
- Master Admin only: `GET/POST /api/admin/users`, `POST /api/admin/users/:key/active`, `POST /api/admin/users/:key/password`, `DELETE /api/admin/users/:key`, `GET /api/admin/login-history`.
- Keep `data/` on a persistent disk and out of git.

## Strict client gate (lib/gate.js)
`POST /api/zoho/validate-client { clientName }` — runs before any request exists.
- Exact match only against Zoho Books contacts and the Analytics client view: spelling, spacing, punctuation, case. No trimming, no fuzzy match, no guessing.
- Not found → `422 CLIENT_NOT_FOUND`, "Client name not found in Zoho Books or Zoho Analytics. Fund request cannot be created." The session is locked (`423 WORKFLOW_LOCKED` on every retry) until `POST /api/zoho/restart`. Sven is notified. No sheet row.
- Found → a signed token (HMAC, 30 min) bound to that exact name. The funding check rejects a token whose name differs (`403`), and re-checks the name exactly anyway — an unknown client never reaches approval logic or the sheet.

## Rules (lib/rules.js)
1. Client name not in Zoho Books **or** Analytics → `Not Approved`, `CLIENT_NOT_FOUND`, flag Sven.
2. In Books but no Analytics balance row → `Not Approved`, `NO_ANALYTICS_RECORD`.
3. Purpose not in the client's ledger categories, or company not on the record → `Not Approved`, `NOT_RELEVANT`.
4. Balance 0 → `Not Approved`, `ZERO_AVAILABLE_BALANCE`.
5. Balance < requested → `Partially Approved`, approved = balance, Sven confirms.
6. Balance ≥ requested → `Approved (Pending Sven Final Check)`.

Every outcome sets `flagSven: true` — nothing releases without Sven.

## Run
```
cd server && npm i && cp .env.example .env   # fill in values
npm run test:check                            # rule tests, offline
ZOHO_MOCK=1 npm start                         # smoke test, no Zoho/Google needed
npm start
```
Expose over **https** (Cloud Run, Render, Fly, or `ngrok http 8787` for testing), add the platform's origin to `ALLOWED_ORIGINS`, then paste `https://…/api/zoho/client-funding-check` into Master Control Center → Zoho → Endpoint.

## Request
```json
{ "requestId": "r12", "clientName": "Tosin", "company": "Tosin", "purpose": "Licence renewal", "requestedAmount": 33450 }
```
## Response (abridged)
```json
{ "ok": true, "reason": "PARTIAL_BALANCE", "approvalStatus": "Partially Approved", "approvedAmount": 735,
  "availableBalance": 735, "booksMatched": true, "analyticsMatched": true, "relevancePassed": true,
  "sheet": { "written": true, "range": "Finance_Approval_Records!A14:G14" },
  "svenSummary": { "clientName": "Tosin", "requestedAmount": 33450, "approvedAmount": 735, "approvalStatus": "Partially Approved", "flagReason": "…" },
  "validationId": "ZV-9F2A11C0", "checkedAt": "2026-09-29T10:12:00.000Z" }
```

## Sheet
Created on first write if missing: header frozen, amounts formatted, columns auto-sized after each append, rows green / yellow / red by Approval Status. Rows are only ever appended.

## Setup notes
- Zoho Self Client → generate code with scopes `ZohoAnalytics.data.read,ZohoAnalytics.metadata.read,ZohoBooks.contacts.READ` → exchange for refresh token.
- Match `ZA_COL_*` to the exact column names in your Analytics view.
- Google: create a service account, enable Sheets API, share the sheet with its email as Editor, base64 the JSON key into `GOOGLE_SERVICE_ACCOUNT_B64`.
