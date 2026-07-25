// Google Sheets writer for the Time Trial results export.
//
// Uses a service-account key (credentials.json in the project root — reused
// from result_formatter) to write the detailed per-race, per-pilot Time Trial
// table produced by stage-standings.buildTimeTrialRows(). Adapted from
// result_formatter/src/google-sheets.js.

'use strict';

const path = require('path');
const { google } = require('googleapis');
const logger = require('./logger.js');

const CREDENTIALS_PATH = path.resolve(__dirname, '..', '..', 'credentials.json');

let sheetsApi = null;
function getSheets() {
    if (sheetsApi) return sheetsApi;
    const auth = new google.auth.GoogleAuth({
        keyFile: CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsApi = google.sheets({ version: 'v4', auth });
    return sheetsApi;
}

// Build a single cell (userEnteredValue + format) for one row value.
function cellFor(value, colIndex, fmt) {
    const cell = { userEnteredValue: {}, userEnteredFormat: { horizontalAlignment: 'RIGHT' } };
    const isNum = typeof value === 'number' && isFinite(value);

    if (colIndex === fmt.dateCol && isNum) {
        cell.userEnteredValue.numberValue = value;
        cell.userEnteredFormat.numberFormat = { type: 'DATE', pattern: 'yyyy-mm-dd' };
    } else if (colIndex === fmt.timeCol && isNum) {
        cell.userEnteredValue.numberValue = value;
        cell.userEnteredFormat.numberFormat = { type: 'TIME', pattern: 'hh:mm:ss' };
    } else if (colIndex >= fmt.firstDecimalCol && colIndex <= fmt.lastDecimalCol && isNum) {
        cell.userEnteredValue.numberValue = value;
        cell.userEnteredFormat.numberFormat = { type: 'NUMBER', pattern: '0.000' };
    } else if (isNum) {
        cell.userEnteredValue.numberValue = value;
    } else {
        cell.userEnteredValue.stringValue = (value === null || value === undefined) ? '' : String(value);
    }
    return cell;
}

// Write the Time Trial table to `sheetName` in `spreadsheetId`, replacing its
// contents. `data` is the object returned by stage-standings.buildTimeTrialRows.
async function writeTimeTrialSheet(spreadsheetId, sheetName, data) {
    if (!spreadsheetId) throw new Error('spreadsheetId not configured');
    const sheets = getSheets();
    const { headers, rows } = data;
    const colCount = headers.length;
    const fmt = {
        dateCol: data.dateCol, timeCol: data.timeCol,
        firstDecimalCol: data.firstDecimalCol, lastDecimalCol: data.lastDecimalCol,
    };

    // Find or create the target sheet.
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    let sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) {
        const resp = await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: { requests: [{ addSheet: { properties: {
                title: sheetName,
                gridProperties: { rowCount: Math.max(1000, rows.length + 10), columnCount: Math.max(colCount, 26) },
            } } }] },
        });
        sheet = { properties: resp.data.replies[0].addSheet.properties };
        logger.info(`[Sheets] created sheet "${sheetName}"`);
    } else {
        // Remove existing banded ranges so re-adding banding doesn't collide.
        for (const band of (sheet.bandedRanges || [])) {
            try {
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId, resource: { requests: [{ deleteBanding: { bandedRangeId: band.bandedRangeId } }] },
                });
            } catch { /* already gone */ }
        }
    }
    const sheetId = sheet.properties.sheetId;

    const requests = [];

    // Ensure enough columns.
    const haveCols = sheet.properties.gridProperties ? sheet.properties.gridProperties.columnCount : 0;
    if (haveCols < colCount) {
        requests.push({ updateSheetProperties: {
            properties: { sheetId, gridProperties: { columnCount: colCount } },
            fields: 'gridProperties.columnCount',
        } });
    }

    // Clear everything.
    requests.push({ updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } });

    // Header row.
    requests.push({ updateCells: {
        rows: [{ values: headers.map(h => ({
            userEnteredValue: { stringValue: h },
            userEnteredFormat: {
                backgroundColor: { red: 0.4, green: 0.4, blue: 0.4 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                horizontalAlignment: 'RIGHT',
            },
        })) }],
        range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: colCount },
        fields: 'userEnteredValue,userEnteredFormat',
    } });

    // Zebra banding over the data rows.
    if (rows.length > 0) {
        requests.push({ addBanding: { bandedRange: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 1 + rows.length, startColumnIndex: 0, endColumnIndex: colCount },
            rowProperties: {
                firstBandColor: { red: 0.9, green: 0.9, blue: 0.9 },
                secondBandColor: { red: 1, green: 1, blue: 1 },
            },
        } } });

        requests.push({ updateCells: {
            rows: rows.map(row => ({ values: row.map((v, c) => cellFor(v, c, fmt)) })),
            start: { sheetId, rowIndex: 1, columnIndex: 0 },
            fields: 'userEnteredValue,userEnteredFormat',
        } });
    }

    await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
    return { rows: rows.length, sheetName };
}

module.exports = { writeTimeTrialSheet, CREDENTIALS_PATH };
