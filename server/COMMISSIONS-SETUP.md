# Free Zone Commission Dashboard — setup

**Address:** https://onelink-commission-dashboard.onrender.com
**Render service:** `onelink-commission-dashboard`. It is separate from the funding platform (`onelink-funding-backend`), which it does not touch.
**Cost:** free (Render free plan, Google Apps Script, your existing Zoho).
**Read-only:** it only reads your sheets, Zoho and Gmail. It never writes to them.

---

## Sign-in

You sign in with your **email address only**. There is no password.

- **Who gets in:** by default, any `@onelink.solutions` address.
- **To limit it to certain people:** add the setting `COMMISSIONS_ALLOWED_EMAILS` on the dashboard service. Example: `finance@onelink.solutions, sven@onelink.solutions, adnan@onelink.solutions`. A whole domain can be written as `@onelink.solutions`.
- **How long it lasts:** you stay signed in for 8 hours on that browser. **Sign out** ends it sooner.
- **Search engines:** the page tells them not to list it.

> Note: without a password or emailed code, anyone who knows an allowed address can open the dashboard.
> Use `COMMISSIONS_ALLOWED_EMAILS` to keep the list short.

---

## Step 1: Zoho (copy existing settings, about 2 minutes)

1. In Render, open **onelink-funding-backend** → **Environment**.
2. Copy each of these that exists, with its value, into **onelink-commission-dashboard** → **Environment**:

| Setting | Needed |
|---|---|
| `ZOHO_CLIENT_ID` | yes |
| `ZOHO_CLIENT_SECRET` | yes |
| `ZOHO_REFRESH_TOKEN` | yes, if it is there |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | only if `ZOHO_REFRESH_TOKEN` is not there (the token is then read from Upstash) |
| `ZOHO_DC` | only if it is there |

3. Click **Save**. Only the dashboard restarts. The funding platform is not changed.

## Step 2: Google Sheets (free Apps Script, about 3 minutes)

Do this signed in as **finance@onelink.solutions**, which can open the tracker, the GP reports and the Renewals sheet.

1. Go to **script.google.com** → **New project**. Delete what is in the editor and paste in **`apps-script/Code.gs`**.
2. On the line `const KEY = 'PASTE-A-LONG-RANDOM-KEY';`, replace the text inside the quotes with your own password of at least 24 characters. Keep it private.
3. Click ⚙ **Project Settings** → tick **Show "appsscript.json" manifest file in editor**. Open **appsscript.json** and replace its contents with **`apps-script/appsscript.json`**.
4. **Deploy** → **New deployment** → type **Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
5. Authorize: choose your account → **Advanced** → **Go to project** → **Allow**.
   - Google says "unsafe" only because the script is your own and not reviewed by Google.
   - The permissions must read **"See"** your spreadsheets and Drive files (view-only). If it asks for more, stop.
6. Copy the **Web app URL**.
7. In Render, open **onelink-commission-dashboard** → **Environment** and add these two settings, then **Save**:
   - `SHEETS_BRIDGE_URL` = the Web app URL
   - `SHEETS_BRIDGE_KEY` = your password from step 2

## Step 3: Check

Open the dashboard and sign in. The row at the top shows each source with ✓ (working) or ✗ and the reason:
- Commission tracker
- GP reports
- Zoho Books
- Renewals sheet
- Gmail

Gmail is optional and shows "–" until it is set up.

---

## Optional settings (dashboard service)

| Setting | What it does |
|---|---|
| `COMMISSIONS_ALLOWED_EMAILS` | Who can sign in (default `@onelink.solutions`). |
| `COMMISSION_RENEWAL_WINDOW_DAYS` | Renewals due within this many days count as pending (default 60). |
| `TRACKER_SHEET_ID`, `RENEWALS_SHEET_ID`, `RENEWALS_TAB`, `GP_REPORT_TAB` | Point at different sheets or tabs if they ever move. |

## Optional: keep dashboard updates from restarting the funding platform

Both services deploy from the same repository. In **onelink-funding-backend** → **Settings** → **Build Filters**, add these **ignored paths**:

- `server/commissions*`
- `server/apps-script/**`
- `server/test/**`
- `server/COMMISSIONS-*.md`
