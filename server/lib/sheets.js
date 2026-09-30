// Finance_Approval_Records — append-only log with frozen header + status colours.
import { google } from 'googleapis';

const HEADER = ['Client Name', 'Company Name', 'Amount Requested', 'Amount Approved', 'Approval Status', 'Zoho Analytics Balance', 'Notes / Flags'];
let api = null, sheetId = null, ready = false;

function client() {
  if (api) return api;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64 || !process.env.GOOGLE_SHEET_ID) return null;
  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  api = google.sheets({ version: 'v4', auth });
  return api;
}
const tab = () => process.env.GOOGLE_SHEET_TAB || 'Finance_Approval_Records';
const rgb = h => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });

async function ensure(s, id) {
  if (ready) return;
  const meta = await s.spreadsheets.get({ spreadsheetId: id });
  let sh = meta.data.sheets.find(x => x.properties.title === tab());
  if (!sh) {
    const r = await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: tab() } } }] } });
    sheetId = r.data.replies[0].addSheet.properties.sheetId;
  } else sheetId = sh.properties.sheetId;

  const head = await s.spreadsheets.values.get({ spreadsheetId: id, range: `${tab()}!A1:G1` });
  if (!head.data.values || !head.data.values.length) {
    await s.spreadsheets.values.update({ spreadsheetId: id, range: `${tab()}!A1:G1`, valueInputOption: 'RAW', requestBody: { values: [HEADER] } });
    const range = { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 };
    const rule = (formula, color, index) => ({ addConditionalFormatRule: { index, rule: { ranges: [range], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format: { backgroundColor: rgb(color) } } } } });
    await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
      rule('=REGEXMATCH($E2,"^Approved")', '#d9ead3', 0),
      rule('=$E2="Partially Approved"', '#fff2cc', 1),
      rule('=$E2="Not Approved"', '#f4cccc', 2)
    ] } });
  }
  ready = true;
}

export async function appendRecord(row) {
  const s = client();
  if (!s) return { written: false, why: 'GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_B64 not set' };
  const id = process.env.GOOGLE_SHEET_ID;
  await ensure(s, id);
  const r = await s.spreadsheets.values.append({
    spreadsheetId: id, range: `${tab()}!A:G`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[row.clientName, row.companyName, row.requested, row.approved, row.status, row.balance, row.notes]] }
  });
  await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 7 } } }] } });
  return { written: true, range: r.data.updates.updatedRange };
}
