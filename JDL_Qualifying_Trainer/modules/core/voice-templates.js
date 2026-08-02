const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');
const configStore = require('./config-store.js');

const CWD = process.cwd();
// Filename pattern accepted by setFile() / listAvailable(). Only files that
// match this — and live in the working directory (no path separators) — are
// honoured, so /api/config can't be used to read arbitrary files.
const FILE_PATTERN = /^voice([_-][A-Za-z0-9._-]+)?\.json$/i;

// Default phrases. Used as a fallback when a key is missing in the active
// voice file. Edit voice.json (or a voice_XX.json variant) to override.
// Placeholders: {pilot}, {lap}, {time}, {total}
const DEFAULTS = {
    lap:            '{pilot}選手、{lap}周目{time}秒',
    lapNoTime:      '{pilot}選手、{lap}周目',
    // `windowFinish` fires once per pilot when their 90s-qualifying window
    // closes (the lap that pushes elapsed time since holeshot past 90s).
    // Replaces the normal lap call; no further laps are announced after it.
    // {laps} is the counted lap count; {min}/{sec} are the cumulative time
    // split into minutes and seconds (§ live-qualify.js pilotFinishSummary +
    // voice-logic.js splitMinSec). windowFinishSecOnly is used when the total
    // is under a minute (skips the "0分" phrasing); windowFinishNoTime is
    // used on the rare chance the summary isn't available yet.
    windowFinish:       '{pilot}選手、フィニッシュ!{laps}周、トータル{min}分{sec}秒',
    windowFinishSecOnly: '{pilot}選手、フィニッシュ!{laps}周、トータル{sec}秒',
    windowFinishNoTime: '{pilot}選手、フィニッシュ',
    // Countdown cues fired from the elapsed time since each pilot's own
    // holeshot (60s/70s/80s in), independent of lap crossings. {remaining} is
    // the seconds-left number (30/20/10).
    countdown30:    '{pilot}選手、残り{remaining}秒',
    countdown20:    '{pilot}選手、残り{remaining}秒',
    countdown10:    '{pilot}選手、残り{remaining}秒',
    // `staggeredStart` is the per-pilot go signal in a TimeTrial staggered start
    // — emitted on the wire as PilotStaggeredStart (spec §7.9), independent of
    // any detection (the holeshot crossing itself is not announced).
    staggeredStart: '{pilot}選手、スタート',
    // `raceStart` fires once on the RaceStart event (whole-race, no pilot).
    raceStart:      'レースを開始します。',
    // Pacemaker (Target) delta, appended after the lap time when a target lap
    // time is configured. {delta} is the absolute gap in seconds.
    targetAhead:    'ターゲットより{delta}秒速い',
    targetBehind:   'ターゲットより{delta}秒遅い',
    targetEven:     'ターゲットどおり',
    // Appended to the lap call (after the target delta) once the pilot's
    // remaining window time drops below live_qualify.lapRemainingThreshold.
    // {remaining} is whole seconds, rounded from the time left at that
    // crossing. Unlike countdown30/20/10 this rides along with a lap call
    // instead of firing on its own clock, and has its own ON/OFF switch at
    // live_qualify.speakLapRemaining — so it is not listed in CATEGORY_OF_KEY.
    lapRemaining:   '残り{remaining}秒',
    crash:          '{pilot}選手、クラッシュアウト',
    raceEnd:        'レース終了',
    raceCancelled:  'レース中止',
    raceFailed:     'レース失敗',
};

// Template keys that share one operator-facing ON/OFF switch. Keys not listed
// here are always enabled — either because they already have their own switch
// elsewhere (targetAhead/targetBehind/targetEven -> live_qualify.speakTargetDelta),
// or because they're safety/status cues that must never be silenced
// (crash, raceEnd, raceCancelled, raceFailed).
const CATEGORY_OF_KEY = {
    lap: 'lap', lapNoTime: 'lap',
    countdown30: 'countdown30',
    countdown20: 'countdown20',
    countdown10: 'countdown10',
    staggeredStart: 'staggeredStart',
    raceStart: 'raceStart',
    windowFinish: 'windowFinish', windowFinishSecOnly: 'windowFinish', windowFinishNoTime: 'windowFinish',
};

function isCategoryEnabled(key) {
    const cat = CATEGORY_OF_KEY[key];
    if (!cat) return true;
    const flags = configStore.get().voice_enabled;
    if (!flags) return true;
    return flags[cat] !== false;
}

// "Anonymous" mode: tts.speakPilotName === false silences the pilot's name in
// every announcement except staggeredStart (the per-pilot go signal, where
// naming who's up is the whole point).
function isPilotNameSuppressed(key) {
    if (key === 'staggeredStart') return false;
    return configStore.get().tts?.speakPilotName === false;
}

let currentFile = 'voice.json';
let templates = { ...DEFAULTS };

function currentPath() {
    return path.resolve(CWD, currentFile);
}

function load() {
    const target = currentPath();
    try {
        const raw = fs.readFileSync(target, 'utf8');
        const user = JSON.parse(raw);
        templates = { ...DEFAULTS, ...user };
        logger.info(`[Voice] templates loaded from ${currentFile}`);
    } catch (e) {
        templates = { ...DEFAULTS };
        if (e.code === 'ENOENT') {
            // voice.json is the "use built-in defaults" sentinel — its absence is
            // normal, so only warn when a *specified* voice file is missing.
            if (currentFile !== 'voice.json') {
                logger.warn(`[Voice] ${currentFile} not found — using built-in defaults`);
            }
        } else {
            logger.warn(`[Voice] ${currentFile} read failed: ${e.message} — using defaults`);
        }
    }
}

// Switch the active voice file. Returns true on success, false if the name
// failed validation or the file does not exist (in which case `currentFile`
// is left unchanged). Pass an empty string / undefined to reset to voice.json.
function setFile(filename) {
    const desired = (filename && typeof filename === 'string') ? filename : 'voice.json';
    const base = path.basename(desired);
    if (!FILE_PATTERN.test(base)) {
        logger.warn(`[Voice] rejected invalid file name "${desired}"`);
        return false;
    }
    if (base === currentFile) {
        return true;
    }
    const target = path.resolve(CWD, base);
    // voice.json is the canonical "use built-in defaults" sentinel and is
    // accepted unconditionally — load() will silently fall back to DEFAULTS
    // when the file is missing. Other names must point at a real file so
    // the operator can't silently land on the defaults by typo.
    if (base !== 'voice.json' && !fs.existsSync(target)) {
        logger.warn(`[Voice] file not found: ${target}`);
        return false;
    }
    currentFile = base;
    load();
    return true;
}

// Returns the basenames of all voice*.json files in the working directory,
// sorted. voice.json (when present) sorts first so the canonical fallback is
// always at the top of the UI dropdown.
function listAvailable() {
    let entries;
    try {
        entries = fs.readdirSync(CWD, { withFileTypes: true });
    } catch (e) {
        logger.warn(`[Voice] listAvailable failed: ${e.message}`);
        return [];
    }
    const files = entries
        .filter(d => d.isFile() && FILE_PATTERN.test(d.name))
        .map(d => d.name);
    files.sort((a, b) => {
        if (a === 'voice.json') return -1;
        if (b === 'voice.json') return 1;
        return a.localeCompare(b);
    });
    return files;
}

// Render a template by key, substituting {placeholders} with vars.
// Returns '' if the template is empty (i.e. the user disabled this phrase).
function render(key, vars = {}) {
    const tpl = templates[key];
    if (tpl == null) return null;
    if (tpl === '') return '';
    if (!isCategoryEnabled(key)) return '';
    let text = tpl;
    if (isPilotNameSuppressed(key)) {
        // Drop {pilot} together with any honorific (選手/さん) and a trailing
        // separator (、, or plain space), so silencing the name doesn't leave
        // a stray "選手、" or a leading pause behind.
        text = text.replace(/\{pilot\}(?:選手|さん)?[、,]?\s*/g, '');
    }
    return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

function currentFileName() {
    return currentFile;
}

load();

module.exports = {
    render,
    load,
    setFile,
    listAvailable,
    currentFileName,
    get VOICE_PATH() { return currentPath(); },
};
