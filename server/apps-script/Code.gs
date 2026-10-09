// OneLink commission dashboard — READ-ONLY bridge to Google Sheets and Drive.
//
// Free alternative to a Google Cloud service account (no billing, no Cloud project). It runs as the
// Google account that deploys it, which can already open the sheets, and hands their cell values to
// the OneLink server. appsscript.json limits it to the spreadsheets.readonly and drive.readonly scopes,
// so Google itself refuses any write. Only these files can be read: the commission tracker, the
// Renewals sheet and spreadsheets named "… GP Report …".
//
// Set up once: Deploy › New deployment › Web app · Execute as: Me · Who has access: Anyone › Deploy ›
// Authorize. Put the web app URL in SHEETS_BRIDGE_URL and KEY below in SHEETS_BRIDGE_KEY on Render.

const KEY = 'PASTE-A-LONG-RANDOM-KEY';                              // = SHEETS_BRIDGE_KEY on Render
const TRACKER = '1E0YrI0wkgpGfgwmzbujIcLxM47ct7hZmPeQOS60-v5w';      // Freezone_Commission_Collection_Tracker
const RENEWALS = '111d7I-jqSHXAIzA4WFEbXEOOrylJhgPXIITb4JqWox0';     // Renewals

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (KEY.length < 24 || KEY.indexOf('PASTE') === 0 || p.key !== KEY) return out({ ok: false, error: 'Wrong or missing key' });
  try {
    if (p.action === 'reports') return out({ ok: true, files: reports() });
    if (p.action === 'values') return out({ ok: true, values: values(p.id, p.range) });
    return out({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// The monthly GP report spreadsheets, wherever they sit (shared drives included).
function reports() {
  const it = DriveApp.searchFiles("title contains 'GP Report' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false");
  const files = [];
  while (it.hasNext()) {
    const f = it.next();
    files.push({ id: f.getId(), name: f.getName(), modifiedTime: f.getLastUpdated().toISOString(), webViewLink: f.getUrl() });
  }
  return files;
}

function allowed(id) {
  if (id === TRACKER || id === RENEWALS) return true;
  return /GP Report/i.test(DriveApp.getFileById(id).getName());
}

// Cell values as the Sheets API returns them unformatted: numbers stay numbers, dates become
// 'yyyy-MM-dd' in the spreadsheet's own time zone. Trailing empty rows and cells are dropped.
function values(id, range) {
  if (!id || !range) throw new Error('id and range are required');
  if (!allowed(id)) throw new Error('This file is not one the dashboard may read');
  const ss = SpreadsheetApp.openById(id), tz = ss.getSpreadsheetTimeZone();
  const rows = ss.getRange(range).getValues().map(function (r) {
    const row = r.map(function (v) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v; });
    while (row.length && row[row.length - 1] === '') row.pop();
    return row;
  });
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}
