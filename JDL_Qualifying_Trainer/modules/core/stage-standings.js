// File-based "90s-from-holeshot" stage standings.
//
// Instead of the live DetectionExt stream, this reads FPVTrackside's own event
// files on disk (the authoritative lap record) and recomputes the qualifying
// standings across EVERY valid Time Trial race in the current event. It mirrors
// the Lua stage script (time_trial_laps_then_time.lua) with MODE = "best":
// each pilot keeps their single best 90s run (most laps, then shortest time).
//
// Data model (see result_formatter):
//   events/<eventId>/Event.json    -> [0].Name, .LastOpened, .Laps
//   events/<eventId>/Pilots.json   -> [{ ID, Name, ... }]
//   events/<eventId>/Rounds.json   -> [{ ID, EventType, ... }]  (EventType 'TimeTrial')
//   events/<eventId>/<raceId>/Race.json -> [0].{ Round, Valid, Laps[], Detections[] }
//       Laps[]:       { Detection, LapNumber, LengthSeconds, ... }  (LapNumber 0 = holeshot)
//       Detections[]: { ID, Pilot, Valid, ... }  (lap.Detection === detection.ID)
//
// A change to any file under the events directory triggers a debounced
// recompute so the leaderboard updates on every lap-time write.

'use strict';

const fs = require('fs');
const path = require('path');
const configStore = require('./config-store.js');
const logger = require('./logger.js');

const WINDOW = 90;      // seconds — keep in sync with the Lua WINDOW
const EPS = 0.0005;     // a crossing at exactly 90.000 still counts

function eventsDir() {
    return configStore.get().fpvt?.paths?.eventsDirectory || null;
}

function decimalPlaces() {
    return configStore.get().fpvt?.decimalPlaces ?? 3;
}

// Parse FPVTrackside's "2026/06/26 22:21:36.265" timestamp into a comparable ms.
function parseFpvtDate(s) {
    if (typeof s !== 'string') return 0;
    const t = Date.parse(s.replace(/\//g, '-').replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
}

// The current event = the event directory with the most recent LastOpened
// (falling back to directory mtime).
function currentEventDir() {
    const root = eventsDir();
    if (!root || !fs.existsSync(root)) return null;
    let best = null, bestT = -1;
    for (const f of fs.readdirSync(root)) {
        const dir = path.join(root, f);
        let st; try { st = fs.statSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;
        const ej = path.join(dir, 'Event.json');
        if (!fs.existsSync(ej)) continue;
        try {
            const e = JSON.parse(fs.readFileSync(ej, 'utf8'))[0];
            const t = parseFpvtDate(e?.LastOpened) || st.mtimeMs;
            if (t > bestT) { bestT = t; best = { dir, event: e }; }
        } catch { /* skip unreadable event */ }
    }
    return best;
}

// 90s-from-holeshot result for one pilot's real-lap durations (holeshot already
// excluded). A lap counts if its START (the running total before it) is within
// the window; it then counts in full even if it finishes past the window.
function score90(realLapDurations) {
    let cum = 0, laps = 0, time = 0;
    for (const dur of realLapDurations) {
        if (cum > WINDOW + EPS) break;   // this lap started after the window closed
        cum += dur;
        laps += 1;
        time = cum;
    }
    return { laps, time };
}

// Better of two runs: more laps wins, ties broken by the shorter time.
function betterRun(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (b.laps > a.laps) return b;
    if (b.laps === a.laps && b.time < a.time) return b;
    return a;
}

// Compute the standings across every valid Time Trial race in the current event.
function compute() {
    const cur = currentEventDir();
    if (!cur) {
        return { eventName: null, window: WINDOW, decimalPlaces: decimalPlaces(), raceCount: 0, pilots: [] };
    }
    const { dir, event } = cur;

    let pilots = [], rounds = [];
    try { pilots = JSON.parse(fs.readFileSync(path.join(dir, 'Pilots.json'), 'utf8')); } catch { /* none */ }
    try { rounds = JSON.parse(fs.readFileSync(path.join(dir, 'Rounds.json'), 'utf8')); } catch { /* none */ }
    const nameById = new Map(pilots.map(p => [p.ID, p.Name]));
    const ttRounds = new Set(rounds.filter(r => r.EventType === 'TimeTrial').map(r => r.ID));

    const bests = new Map();   // pilotId -> { laps, time }
    let raceCount = 0;

    for (const f of fs.readdirSync(dir)) {
        const rd = path.join(dir, f);
        let st; try { st = fs.statSync(rd); } catch { continue; }
        if (!st.isDirectory()) continue;
        const rj = path.join(rd, 'Race.json');
        if (!fs.existsSync(rj)) continue;

        let race;
        try { race = JSON.parse(fs.readFileSync(rj, 'utf8'))[0]; } catch { continue; }
        if (!race || race.Valid !== true) continue;         // valid races only
        if (!ttRounds.has(race.Round)) continue;            // Time Trial rounds only
        raceCount += 1;

        // Detection id -> detection (for Pilot + Valid lookup).
        const det = new Map();
        for (const d of race.Detections || []) det.set(d.ID, d);

        // Group each pilot's VALID laps (Detection.Valid filters sub-minimum /
        // spurious crossings — the authoritative "invalid lap" flag).
        const byPilot = new Map();
        for (const lap of race.Laps || []) {
            const d = det.get(lap.Detection);
            if (!d || d.Valid !== true) continue;
            if (!byPilot.has(d.Pilot)) byPilot.set(d.Pilot, []);
            byPilot.get(d.Pilot).push(lap);
        }

        for (const [pid, laps] of byPilot) {
            laps.sort((a, b) => a.LapNumber - b.LapNumber);
            // Holeshot is LapNumber 0; real laps are LapNumber >= 1.
            const real = laps.filter(l => l.LapNumber >= 1).map(l => l.LengthSeconds);
            const run = score90(real);
            if (run.laps === 0) continue;
            bests.set(pid, betterRun(bests.get(pid), run));
        }
    }

    const rows = [...bests.entries()].map(([pid, b]) => ({
        pilotName: nameById.get(pid) || String(pid).slice(0, 6),
        laps: b.laps,
        time: b.time,
    }));
    rows.sort((a, b) => (a.laps !== b.laps ? b.laps - a.laps : a.time - b.time));
    rows.forEach((r, i) => { r.rank = i + 1; });

    return {
        eventName: event?.Name || null,
        window: WINDOW,
        decimalPlaces: decimalPlaces(),
        raceCount,
        pilots: rows,
    };
}

// --- Detailed Time Trial export (one row per pilot per race) ----------------
//
// Columns (Google Sheets export). Finish time = sum of the pilot's VALID laps
// EXCLUDING the holeshot (LapNumber >= 1). AVG LAP = Finish time / Lap count.

const LAP_COLS = 30;
const TT_HEADERS = [
    'Event名', 'HEAT', '日付', 'スタート時刻', 'Pilot', 'Position', 'Lap数',
    'Finish time', 'AVG LAP', 'BEST LAP', '連続2周', '連続3周',
    ...Array.from({ length: LAP_COLS }, (_, i) => `LAP${i + 1}`),
];
// 0-based column indices for cell formatting in the sheet.
const TT_DATE_COL = 2;
const TT_TIME_COL = 3;
const TT_FIRST_DECIMAL_COL = 7;                       // Finish time
const TT_LAST_DECIMAL_COL = 11 + LAP_COLS;            // last LAP column

// Excel/Sheets serial for a FPVTrackside "yyyy/MM/dd H:mm:ss.fff" timestamp.
// Integer part = date, fractional part = time-of-day (local wall clock).
function excelSerial(startStr) {
    if (!startStr) return '';
    const d = new Date(startStr);
    if (isNaN(d.getTime())) return '';
    const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    const epoch = Date.UTC(1899, 11, 30);
    return (utc - epoch) / 86400000;
}

function minConsecutive(arr, n) {
    if (arr.length < n) return '';
    let min = Infinity;
    for (let i = 0; i + n <= arr.length; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += arr[i + j];
        if (s < min) min = s;
    }
    return isFinite(min) ? min : '';
}

// Build one row per pilot per valid Time Trial race in the current event.
function buildTimeTrialRows() {
    const cur = currentEventDir();
    if (!cur) return { eventName: null, headers: TT_HEADERS, rows: [] };
    const { dir, event } = cur;
    const eventName = event?.Name || '';

    let pilots = [], rounds = [];
    try { pilots = JSON.parse(fs.readFileSync(path.join(dir, 'Pilots.json'), 'utf8')); } catch { /* none */ }
    try { rounds = JSON.parse(fs.readFileSync(path.join(dir, 'Rounds.json'), 'utf8')); } catch { /* none */ }
    const pilotById = new Map(pilots.map(p => [p.ID, p]));
    const roundById = new Map(rounds.map(r => [r.ID, r]));
    const ttRounds = new Set(rounds.filter(r => r.EventType === 'TimeTrial').map(r => r.ID));

    const rows = [];
    for (const f of fs.readdirSync(dir)) {
        const rd = path.join(dir, f);
        let st; try { st = fs.statSync(rd); } catch { continue; }
        if (!st.isDirectory()) continue;
        const rj = path.join(rd, 'Race.json');
        if (!fs.existsSync(rj)) continue;

        let race;
        try { race = JSON.parse(fs.readFileSync(rj, 'utf8'))[0]; } catch { continue; }
        if (!race || race.Valid !== true) continue;
        if (!ttRounds.has(race.Round)) continue;

        const round = roundById.get(race.Round);
        const roundNumber = round ? round.RoundNumber : 0;
        const raceName = `TimeTrial ${roundNumber === 0 ? 'N/A' : roundNumber}-${race.RaceNumber}`;

        // Race timestamp = the earliest lap's StartTime.
        const firstLap = [...(race.Laps || [])].sort((a, b) => a.LapNumber - b.LapNumber)[0];
        const serial = excelSerial(firstLap && firstLap.StartTime);

        // Positions from Result.json (optional).
        const positions = new Map();
        try {
            const rs = path.join(rd, 'Result.json');
            if (fs.existsSync(rs)) {
                for (const r of JSON.parse(fs.readFileSync(rs, 'utf8'))) positions.set(r.Pilot, r.Position);
            }
        } catch { /* none */ }

        const det = new Map();
        for (const d of race.Detections || []) det.set(d.ID, d);

        const byPilot = new Map();
        for (const lap of race.Laps || []) {
            const d = det.get(lap.Detection);
            if (!d || d.Valid !== true) continue;
            if (!byPilot.has(d.Pilot)) byPilot.set(d.Pilot, []);
            byPilot.get(d.Pilot).push(lap);
        }

        for (const [pid, laps] of byPilot) {
            const pilot = pilotById.get(pid);
            if (!pilot) continue;
            laps.sort((a, b) => a.LapNumber - b.LapNumber);
            const actual = laps.filter(l => l.LapNumber >= 1).map(l => l.LengthSeconds);
            const lapCount = actual.length;
            const finish = actual.reduce((s, x) => s + x, 0);
            const avg = lapCount > 0 ? finish / lapCount : '';
            const best = lapCount > 0 ? Math.min(...actual) : '';
            const cons2 = minConsecutive(actual, 2);
            const cons3 = minConsecutive(actual, 3);

            const lapCells = Array(LAP_COLS).fill('');
            for (const lap of laps) {
                if (lap.LapNumber >= 1 && lap.LapNumber <= LAP_COLS) lapCells[lap.LapNumber - 1] = lap.LengthSeconds;
            }

            rows.push([
                eventName, raceName, serial, serial, pilot.Name,
                positions.has(pid) ? positions.get(pid) : '',
                lapCount, lapCount > 0 ? finish : '', avg, best, cons2, cons3,
                ...lapCells,
            ]);
        }
    }

    // Group chronologically: round, race, then finishing position.
    rows.sort((a, b) => {
        if (a[2] !== b[2]) return (a[2] || 0) - (b[2] || 0);     // date serial
        const pa = typeof a[5] === 'number' ? a[5] : 99;
        const pb = typeof b[5] === 'number' ? b[5] : 99;
        return pa - pb;
    });

    return { eventName, headers: TT_HEADERS, rows,
             dateCol: TT_DATE_COL, timeCol: TT_TIME_COL,
             firstDecimalCol: TT_FIRST_DECIMAL_COL, lastDecimalCol: TT_LAST_DECIMAL_COL };
}

// --- File watching ----------------------------------------------------------

let watcher = null;
let debounceTimer = null;

// Watch the events directory (recursively) and call onChange, debounced, on any
// file write — i.e. whenever FPVTrackside records a new lap time or result.
function startWatching(onChange, debounceMs = 800) {
    const root = eventsDir();
    if (!root || !fs.existsSync(root)) {
        logger.warn('[Stage] events directory not available yet — file watch not started');
        return false;
    }
    stopWatching();
    try {
        watcher = fs.watch(root, { recursive: true }, () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                try { onChange(); } catch (e) { logger.error('[Stage] onChange error: ' + e.message); }
            }, debounceMs);
        });
        logger.info(`[Stage] watching events dir for lap-time updates: ${root}`);
        return true;
    } catch (e) {
        logger.error('[Stage] fs.watch failed: ' + e.message);
        return false;
    }
}

function stopWatching() {
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    clearTimeout(debounceTimer);
    debounceTimer = null;
}

module.exports = { compute, buildTimeTrialRows, startWatching, stopWatching, WINDOW };
