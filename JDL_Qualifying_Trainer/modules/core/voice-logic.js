const logger = require('./logger.js');
const configStore = require('./config-store.js');
const voiceTemplates = require('./voice-templates.js');

// Phonetic comes from PilotInfoExt.phonetic (§6.2). Falls back to the display
// name when phonetic is not provided. Logs a one-shot warning per pilot so the
// operator can tell whether the sender just isn't shipping phonetic or whether
// the pilot lookup is missing entirely.
const _phoneticWarned = new Set();
function pilotSpeak(pilotInfo, fallbackName) {
    if (pilotInfo?.phonetic) return pilotInfo.phonetic;
    const key = pilotInfo?.name || fallbackName;
    if (key && !_phoneticWarned.has(key)) {
        _phoneticWarned.add(key);
        if (!pilotInfo) {
            logger.warn(`[Voice] no PilotInfoExt for "${key}" — using display name. (Receiver started mid-race? Wait for next RaceLoaded/PilotRaceState.)`);
        } else {
            logger.warn(`[Voice] pilot "${key}" has no phonetic field — using display name. Set "Phonetic" in FPVTrackside pilot config.`);
        }
    }
    if (pilotInfo?.name) return pilotInfo.name;
    return fallbackName || '';
}

function _resetPhoneticWarnings() {
    _phoneticWarned.clear();
}

function fmtSec(value) {
    if (value == null || !Number.isFinite(value)) return null;
    const dp = configStore.decimalPlaces();
    return Number(value).toFixed(dp);
}

// Minutes+seconds split for the finish total. windowFinish only fires once
// elapsed time exceeds the 90s window, so `value` here is always > 90 and
// `min` is always >= 1 — no need for a "0 minutes" fallback in the templates.
function splitMinSec(value) {
    if (value == null || !Number.isFinite(value)) return null;
    const dp = configStore.decimalPlaces();
    const mins = Math.floor(value / 60);
    const secs = value - mins * 60;
    return { min: mins, sec: secs.toFixed(dp) };
}

// Persistent state across detections (re-entered each race via resetForRace).
let pilotsByName = new Map();   // name -> PilotInfoExt
let finishedPilots = new Set();
let raceActive = false;
let countdownAnnounced = new Map();  // pilotName -> Set of remaining-seconds thresholds already spoken

// Remaining-seconds-in-window thresholds for the countdown tick, each with its
// own template key (and thus its own ON/OFF switch via voice-templates.js
// CATEGORY_OF_KEY). Ordered descending so a delayed tick still announces the
// furthest-out threshold it crossed first.
const COUNTDOWN_THRESHOLDS = [
    { remaining: 30, key: 'countdown30' },
    { remaining: 20, key: 'countdown20' },
    { remaining: 10, key: 'countdown10' },
];

function resetForRace() {
    finishedPilots.clear();
    countdownAnnounced.clear();
    logger.info('[Voice] state reset for new race');
}

function loadPilots(pilots) {
    pilotsByName = new Map();
    let withPhonetic = 0;
    for (const p of pilots || []) {
        if (p?.name) {
            pilotsByName.set(p.name, p);
            if (p.phonetic) withPhonetic++;
        }
    }
    const total = pilotsByName.size;
    if (total > 0) {
        logger.info(`[Voice] pilots loaded: ${total} (with phonetic: ${withPhonetic})`);
    }
    _resetPhoneticWarnings();
}

function setRaceActive(active) {
    raceActive = active;
}

// Render the pacemaker (Target) delta phrase spoken after a lap time. `d` is
// the cumulative ghost delta in seconds (negative = ahead/faster). Returns ''
// when no target is active or the value is unusable.
function renderTargetDelta(d) {
    if (d == null || !Number.isFinite(d)) return '';
    const abs = fmtSec(Math.abs(d));
    if (abs == null) return '';
    const key = d < 0 ? 'targetAhead' : (d > 0 ? 'targetBehind' : 'targetEven');
    return voiceTemplates.render(key, { delta: abs }) || '';
}

// Build a TTS line for one DetectionExt and dispatch it to the announcer.
function onDetection(evt, announce, opts = {}) {
    if (!raceActive) return;
    if (!evt.isLapEnd) return;        // splits do not get announced
    if (evt.valid === false) return;  // sender filtered this detection
    if (evt.lapNumber === 0) return;  // holeshot crossing — not announced

    const pilot = pilotsByName.get(evt.pilotName);
    const speak = pilotSpeak(pilot, evt.pilotName);
    const key = evt.pilotName;

    if (finishedPilots.has(key)) return;

    let ttsText;
    if (opts.windowFinish) {
        // The 90s-qualifying window just closed on this lap (§ live-qualify.js
        // isWindowClosingLap). Speak a one-shot "finish" cue — with the counted
        // lap count + cumulative time (in minutes'seconds), when available —
        // in place of the lap call, and suppress all further laps for this
        // pilot this race.
        const laps = opts.finishSummary?.laps;
        const split = splitMinSec(opts.finishSummary?.time);
        let templateKey = 'windowFinishNoTime';
        if (laps != null && split) {
            // Skip the "0分" phrasing when the total is under a minute.
            templateKey = split.min > 0 ? 'windowFinish' : 'windowFinishSecOnly';
        }
        ttsText = voiceTemplates.render(templateKey, {
            pilot: speak, laps, min: split?.min, sec: split?.sec,
        });
        finishedPilots.add(key);
    } else {
        const lapT = fmtSec(evt.lapTimeSoFar);
        ttsText = voiceTemplates.render(lapT ? 'lap' : 'lapNoTime', {
            pilot: speak, lap: evt.lapNumber, time: lapT,
        });
        // When a Target is active, read the gap after the lap time.
        const dText = renderTargetDelta(opts.targetDelta);
        if (ttsText && dText) ttsText = `${ttsText}、${dText}`;
    }

    if (!ttsText) return;
    logger.info(`[Voice] ${ttsText}`);
    announce(ttsText);
}

// Fires roughly once per second from the server's tick loop (independent of
// detections, since a pilot can be mid-lap when a countdown mark passes).
// `pilotsRemaining` is live-qualify.js's pilotsRemaining(): an array of
// { pilotName, remaining } (seconds left in that pilot's 90s window). Each
// threshold is announced at most once per pilot per race.
function onCountdownTick(pilotsRemaining, announce) {
    if (!raceActive) return;
    for (const { pilotName, remaining } of pilotsRemaining || []) {
        if (finishedPilots.has(pilotName)) continue;
        let seen = countdownAnnounced.get(pilotName);
        if (!seen) { seen = new Set(); countdownAnnounced.set(pilotName, seen); }

        for (const { remaining: threshold, key } of COUNTDOWN_THRESHOLDS) {
            if (seen.has(threshold) || remaining > threshold) continue;
            seen.add(threshold);
            const pilot = pilotsByName.get(pilotName);
            const speak = pilotSpeak(pilot, pilotName);
            const text = voiceTemplates.render(key, { pilot: speak, remaining: threshold });
            if (!text) continue;
            logger.info(`[Voice] ${text}`);
            announce(text);
        }
    }
}

function onCrash(evt, announce) {
    const speak = pilotSpeak(evt.pilot, evt.pilot?.name);
    if (!speak) return;
    const text = voiceTemplates.render('crash', { pilot: speak });
    if (!text) return;
    logger.info(`[Voice] ${text}`);
    announce(text);
}

// Fires for each PilotStaggeredStart event (§7.9). Independent of the
// holeshot crossing (which is not announced) — uses `staggeredStart` so the
// operator can phrase this go-signal on its own in voice.json. Goes straight
// through `announce()`; no race state check (raceActive may not be true yet
// when the first pilot gets the signal).
function onStaggeredStart(evt, announce) {
    const speak = pilotSpeak(evt.pilot, evt.pilot?.name);
    if (!speak) return;
    const text = voiceTemplates.render('staggeredStart', { pilot: speak });
    if (!text) return;
    logger.info(`[Voice] ${text}`);
    announce(text);
}

module.exports = {
    resetForRace,
    loadPilots,
    setRaceActive,
    onDetection,
    onCountdownTick,
    onCrash,
    onStaggeredStart,
};
