// Live "90s-from-holeshot" qualifying tracker.
//
// Reproduces, in real time, the scoring the Lua stage script
// (time_trial_laps_then_time.lua) computes after the fact:
//
//   * Each pilot's window starts at their HOLESHOT — the first lap-loop
//     crossing (isLapEnd). A staggered start is therefore irrelevant: every
//     pilot is timed from their own holeshot, not a shared race clock.
//   * A lap counts if the crossing that STARTS it happened within WINDOW
//     seconds of the holeshot. Once started, the lap counts in full even if it
//     finishes after the window closes (so counted time can exceed WINDOW).
//   * Ranking: most laps wins; ties broken by the shorter time.
//
// Fed one race at a time from the live DetectionExt stream (§7.4). State is
// reset on RaceLoaded / RaceStart and frozen on RaceEnd.

'use strict';

const configStore = require('./config-store.js');

const WINDOW = 90;      // seconds — keep in sync with the Lua WINDOW
const EPS = 0.0005;     // a crossing at exactly 90.000 still counts

function newPilot(channel) {
    return {
        channel: channel || null,
        lapEnds: [],       // raceTime (s since race start) of each valid isLapEnd, in order
        finished: false,
    };
}

// Holeshot mode: the first lap-loop crossing is the holeshot (window origin),
// real laps are the crossings after it. EndOfLap mode: no holeshot exists, so
// the window origin is race start (t=0) and every crossing ends a real lap.
function isHoleshotMode() {
    const loc = configStore.get().fpvt?.eventSettings?.primaryTimingSystemLocation;
    return loc !== 'EndOfLap';   // default to Holeshot (matches this event's config)
}

// "Smart Minimum Lap Time" (§3.4). Lap-ends closer together than this are
// spurious double-detections, not real laps. 0 = no minimum configured.
function minLapTime() {
    const v = configStore.get().fpvt?.eventSettings?.minLapTime;
    return (typeof v === 'number' && v > 0) ? v : 0;
}

const state = {
    raceActive: false,
    actualStartMs: null,    // wall-clock of RaceStart.actualStart, for live race-time interpolation
    round: null,
    race: null,
    raceType: null,
    pilots: new Map(),      // pilotName -> pilot record
};

function reset(evt) {
    state.raceActive = false;
    state.actualStartMs = null;
    state.round = evt?.round ?? null;
    state.race = evt?.race ?? null;
    state.raceType = evt?.raceType ?? null;
    state.pilots = new Map();
    // Seed the roster so pilots show up before their first lap.
    for (const p of evt?.pilots || []) {
        if (p?.name) state.pilots.set(p.name, newPilot(p.channel));
    }
}

function onRaceLoaded(evt) {
    reset(evt);
}

function onRaceStart(evt) {
    state.raceActive = true;
    const t = evt?.actualStart ? new Date(evt.actualStart).getTime() : NaN;
    state.actualStartMs = Number.isFinite(t) ? t : Date.now();
}

function onRaceEnd() {
    state.raceActive = false;
}

function onDetection(evt) {
    if (!evt || evt.valid === false) return;   // FPVTrackside already filtered this out
    if (!evt.isLapEnd) return;                 // only lap-loop crossings define laps
    if (typeof evt.raceTime !== 'number') return;
    const name = evt.pilotName;
    if (!name) return;

    let p = state.pilots.get(name);
    if (!p) { p = newPilot(evt.channel); state.pilots.set(name, p); }
    if (evt.channel) p.channel = evt.channel;

    // Reject a sub-minimum-lap crossing: a lap-end closer than minLapTime to the
    // previous accepted crossing is a spurious double-detection, not a real lap.
    // Dropping it (rather than recording a too-short lap) keeps the lap sequence
    // clean, so the next lap is still measured from the last real crossing.
    const minLap = minLapTime();
    const n = p.lapEnds.length;
    if (n > 0 && minLap > 0 && evt.raceTime - p.lapEnds[n - 1] < minLap - EPS) {
        return;
    }

    p.lapEnds.push(evt.raceTime);
    if (evt.raceFinishedForPilot) p.finished = true;
}

// Build the per-lap boundary array B where B[0] is the window origin and B[k]
// is the end of real lap k. Real lap k: start=B[k-1], end=B[k].
function boundaries(lapEnds, holeshot) {
    if (holeshot) return lapEnds.slice();          // B[0] = holeshot crossing
    return [0, ...lapEnds];                         // EndOfLap: origin = race start
}

function scorePilot(p, holeshot) {
    const B = boundaries(p.lapEnds, holeshot);
    const origin = B.length ? B[0] : null;

    const lapTimes = [];        // only recorded laps: valid, started within the window
    let countedTime = 0;

    for (let k = 1; k < B.length; k++) {
        const startRel = B[k - 1] - B[0];           // start relative to window origin
        if (startRel > WINDOW + EPS) break;         // started after the window closed → not recorded
        const dur = B[k] - B[k - 1];
        lapTimes.push(dur);
        countedTime += dur;                         // counts in full, even if it finishes past WINDOW
    }
    const countedLaps = lapTimes.length;

    let bestLap = null;
    let avgLap = null;
    if (lapTimes.length) {
        bestLap = Math.min(...lapTimes);
        avgLap = lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length;
    }

    // Projection: if the pilot holds their average lap, how many laps start
    // within the window, and the total time to complete them.
    let projLaps = null;
    let projTime = null;
    if (avgLap && avgLap > 0) {
        projLaps = Math.floor((WINDOW + EPS) / avgLap) + 1;   // lap N starts at (N-1)*avg
        projTime = projLaps * avgLap;
    }

    return {
        laps: countedLaps,
        time: countedTime,
        windowOrigin: origin,   // raceTime at which this pilot's 90s window starts (null if no holeshot yet)
        lapTimes,
        bestLap,
        avgLap,
        projLaps,
        projTime,
        finished: p.finished,
        started: origin !== null,
    };
}

function currentRaceTime() {
    if (state.actualStartMs == null) return null;
    return (Date.now() - state.actualStartMs) / 1000;
}

// Pacemaker ("ghost") target lap time in seconds. 0 = disabled. The ghost
// completes one lap every `target` seconds from each pilot's window origin.
function targetLapTime() {
    const v = configStore.get().live_qualify?.targetLapTime;
    return (typeof v === 'number' && v > 0) ? v : 0;
}

function snapshot() {
    const holeshot = isHoleshotMode();
    const target = targetLapTime();
    const rows = [];
    for (const [name, p] of state.pilots) {
        const s = scorePilot(p, holeshot);
        const c = p.channel;
        // Cumulative ghost delta: the pilot's elapsed time to complete `laps`
        // laps (== s.time, since counted laps are contiguous from the origin)
        // minus the pacemaker's time for the same lap count. Negative = ahead
        // of the ghost (faster). Null until the pilot has a completed lap.
        const targetDelta = (target > 0 && s.laps > 0) ? (s.time - s.laps * target) : null;
        rows.push({
            pilotName: name,
            band: c ? `${String(c.band || '?').charAt(0)}${c.number ?? ''}` : '',
            frequency: c?.frequency ?? null,
            color: c ? { r: c.colorR ?? 255, g: c.colorG ?? 255, b: c.colorB ?? 255 } : null,
            ...s,
            targetDelta,
        });
    }

    const freqCmp = (a, b) => {
        const fa = a.frequency ?? Infinity, fb = b.frequency ?? Infinity;
        if (fa !== fb) return fa - fb;                         // low frequency first
        return a.pilotName.localeCompare(b.pilotName);
    };
    // Competitive order: started pilots first (most laps, then shortest time),
    // not-yet-started roster below by ascending frequency.
    const rankCmp = (a, b) => {
        if (a.started !== b.started) return a.started ? -1 : 1;
        if (!a.started) return freqCmp(a, b);
        if (a.laps !== b.laps) return b.laps - a.laps;
        if (a.time !== b.time) return a.time - b.time;
        return a.pilotName.localeCompare(b.pilotName);
    };

    // Rank (#) is always the competitive position, regardless of display order.
    rows.slice().sort(rankCmp).forEach((r, i) => { r.rank = r.started ? i + 1 : null; });

    // Display order:
    //   "rank"      → reshuffles as the race progresses (competitive order)
    //   "frequency" → every pilot pinned to ascending-frequency order (never moves)
    const sortMode = configStore.get().live_qualify?.sortMode === 'frequency' ? 'frequency' : 'rank';
    rows.sort(sortMode === 'frequency' ? freqCmp : rankCmp);

    return {
        window: WINDOW,
        target,                                 // pacemaker lap time (s); 0 = disabled
        raceActive: state.raceActive,
        raceTime: currentRaceTime(),            // server-side current race clock (s), null before RaceStart
        raceName: state.round != null ? `${state.raceType || 'Race'} ${state.round}-${state.race}` : null,
        holeshotMode: holeshot,
        minLapTime: minLapTime(),
        sortMode,
        decimalPlaces: configStore.get().fpvt?.decimalPlaces ?? 3,
        pilots: rows,
    };
}

// Seconds left in each started pilot's 90s window, interpolated from the
// wall clock (not tied to a detection). Used by the voice announcer's
// countdown tick (30s/20s/10s-remaining cues). Pilots with no holeshot yet
// are omitted; `remaining` can go negative once the window has closed.
function pilotsRemaining() {
    const now = currentRaceTime();
    if (now == null) return [];
    const holeshot = isHoleshotMode();
    const out = [];
    for (const [name, p] of state.pilots) {
        const B = boundaries(p.lapEnds, holeshot);
        const origin = B.length ? B[0] : null;
        if (origin == null) continue;
        out.push({ pilotName: name, remaining: WINDOW - (now - origin) });
    }
    return out;
}

// { laps, time } of the pilot's counted laps at the current state -- laps is
// the number of gate crossings that started within the window (matches the
// leaderboard scoring, not necessarily FPVTrackside's raw lapNumber if any
// crossing was dropped as a sub-minLapTime duplicate); time is the cumulative
// duration to complete them. Used by the voice announcer for the finish cue.
// Returns null if the pilot has no counted lap yet.
function pilotFinishSummary(pilotName) {
    const p = state.pilots.get(pilotName);
    if (!p) return null;
    const s = scorePilot(p, isHoleshotMode());
    if (!s.laps) return null;
    return { laps: s.laps, time: s.time };
}

// True exactly once per pilot per race: the lap just recorded is the one whose
// completion pushes elapsed time since the window origin (holeshot) past
// WINDOW for the first time -- i.e. the last lap that will ever be counted.
// Used by the voice announcer to speak a one-shot "finish" cue instead of
// continuing to call out laps. Must be called right after the detection that
// might close the window has been fed to onDetection() and before the next one.
function isWindowClosingLap(pilotName) {
    const p = state.pilots.get(pilotName);
    if (!p) return false;
    const B = boundaries(p.lapEnds, isHoleshotMode());
    if (B.length < 2) return false;   // no real lap recorded yet (only the origin)
    const last = B.length - 1;
    const elapsedNow = B[last] - B[0];
    if (elapsedNow <= WINDOW + EPS) return false;
    const elapsedBefore = B[last - 1] - B[0];
    return elapsedBefore <= WINDOW + EPS;
}

// Cumulative ghost delta for one pilot at the current state — used by the voice
// announcer to speak the gap after a lap. Returns null when the target is
// disabled or the pilot has no counted lap yet. Negative = ahead (faster).
function pilotDelta(pilotName) {
    const target = targetLapTime();
    if (target <= 0) return null;
    const p = state.pilots.get(pilotName);
    if (!p) return null;
    const s = scorePilot(p, isHoleshotMode());
    if (!s.laps) return null;
    return s.time - s.laps * target;
}

module.exports = {
    onRaceLoaded,
    onRaceStart,
    onRaceEnd,
    onDetection,
    snapshot,
    pilotDelta,
    isWindowClosingLap,
    pilotFinishSummary,
    pilotsRemaining,
    WINDOW,
};
