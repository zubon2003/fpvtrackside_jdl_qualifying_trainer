#!/usr/bin/env node
//
// FPVTrackside Extension receiver — INTERFACE.en.md v1.1.
// Hosts:
//   • PUT receiver for FPVTrackside events (Hello, RaceLoaded, DetectionExt …)
//   • Socket.IO broadcast to overlays (announce_text, live_qualify)
//   • REST API consumed by overlays (/api/leaderboard, /api/live_qualify …)
//   • VOICEVOX / Browser TTS (Web Speech API)
//
'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server: IoServer } = require('socket.io');
const { performance } = require('perf_hooks');

const logger = require('./modules/core/logger.js');
const configStore = require('./modules/core/config-store.js');
const VoiceVoxHandler = require('./modules/core/voicevox-handler.js');
const BrowserTtsHandler = require('./modules/core/browser-tts-handler.js');
const voiceLogic = require('./modules/core/voice-logic.js');
const voiceTemplates = require('./modules/core/voice-templates.js');
const resultsStore = require('./modules/core/results-store.js');
const liveQualify = require('./modules/core/live-qualify.js');
const stageStandings = require('./modules/core/stage-standings.js');
const googleSheets = require('./modules/core/google-sheets.js');
const { createRouter } = require('./modules/core/event-router.js');

// --- Tunables ---------------------------------------------------------------

const DEFAULT_EXTENSION_PORT = 8765;
const DEFAULT_BIND_HOST = '127.0.0.1';
const REQUEST_BODY_LIMIT = '4mb';
// keepAlive ≥ Hello-Heartbeat interval so the sender's persistent connection
// is never closed under us between events; headers is +1s as Node requires.
const KEEPALIVE_TIMEOUT_MS = 360_000;
const HEADERS_TIMEOUT_MS   = 361_000;
const SHUTDOWN_FORCE_EXIT_MS = 2000;

// Out-of-box defaults. Used to seed config.json on first run (or after the
// user deletes it). Module-level DEFAULTS inside each handler still apply at
// runtime, but persisting these here keeps the on-disk config readable and
// makes the Web UI show real values instead of empty fields.
const DEFAULT_CONFIG = {
    extension: {
        port: DEFAULT_EXTENSION_PORT,
    },
    live_qualify: {
        // Display order for the Live 90s overlay:
        //   'rank'      — reorder by laps then time as the race runs
        //   'frequency' — keep pilots pinned to ascending-frequency order
        sortMode: 'frequency',
        // Pacemaker target lap time (s); 0 = disabled.
        targetLapTime: 0,
        // Read the Target delta aloud after each lap time (voice).
        speakTargetDelta: false,
        // Append "残りy秒" to the lap call once the pilot's remaining window
        // time drops below lapRemainingThreshold seconds. y is whole seconds,
        // rounded. Off by default; the threshold is ignored while off.
        speakLapRemaining: false,
        lapRemainingThreshold: 30,
    },
    google_sheets: {
        // Export the Time Trial results (one row per pilot per valid race) to a
        // Google Sheet. Auth uses credentials.json (service account) in the
        // project root; share the target sheet with that service account.
        // spreadsheetId is intentionally blank — it is per-event and private.
        enabled: false,
        spreadsheetId: '',
        sheetName: 'TimeTrial',
    },
    tts: {
        // 'voicevox' or 'browser'. Picks which TTS backend handles
        // race announcements and the Test Voice button.
        engine: 'browser',
        // Filename in the working directory that supplies the phrase
        // templates (e.g. voice_jp.json, voice_en.json). Empty string or
        // missing falls back to voice.json.
        voiceFile: 'voice_jp.json',
        // false = "anonymous" mode: the pilot's name is dropped from every
        // announcement except staggeredStart (voice-templates.js isPilotNameSuppressed).
        speakPilotName: true,
        // NOTE: `decimalPlaces` (decimal places for spoken times — lap time,
        // finish total, target delta) is deliberately NOT seeded here.
        // config-store.js ttsDecimalPlaces() falls back to the decimalPlaces
        // FPVTrackside reported in Hello whenever the key is absent, so an
        // existing install keeps the digit count it had before this setting
        // existed. Writing a default would pin every upgraded config to that
        // number and silently change what operators hear. The control panel
        // shows the effective value and writes an explicit 1..3 the first time
        // anything is saved; out-of-range values are clamped on read.
    },
    // Per-category ON/OFF switches for voice announcements (voice-templates.js
    // isCategoryEnabled). false = that category is silenced regardless of what
    // the active voice*.json phrase says. Target-delta has its own switch at
    // live_qualify.speakTargetDelta and is not listed here.
    voice_enabled: {
        lap: true,
        countdown30: false,
        countdown20: true,
        countdown10: false,
        staggeredStart: true,
        raceStart: true,
        windowFinish: true,
        // crash / raceEnd / raceCancelled / raceFailed are safety/status cues
        // and always speak — no switch for them (voice-templates.js CATEGORY_OF_KEY).
    },
    voicevox: {
        url: 'http://localhost:50021',
        speaker: null,
        volume: 2.7,
        speed: 1.2,
        audio_delay_ms: 0,
        enabled: false,
    },
    browser_tts: {
        // Web Speech API (speechSynthesis) played by the /html/livequalify page.
        // voiceName matches a voice from speechSynthesis.getVoices(); empty uses
        // the overlay page's default voice for `lang`.
        voiceName: 'Microsoft Haruka - Japanese (Japan)',
        lang: 'ja-JP',
        rate: 1.3,
        pitch: 1.0,
        volume: 1.0,
        enabled: true,
    },
};

// Fill missing keys recursively. Returns true if anything was added. Existing
// user values — including explicit `false`, `0`, `""`, `null` — are left as-is;
// only keys absent from `target` get pulled from `defaults`.
function fillMissing(target, defaults) {
    let changed = false;
    for (const k of Object.keys(defaults)) {
        const dv = defaults[k];
        const isPlainObj = dv !== null && typeof dv === 'object' && !Array.isArray(dv);
        if (!(k in target)) {
            target[k] = isPlainObj ? { ...dv } : dv;
            changed = true;
        } else if (isPlainObj) {
            if (target[k] === null || typeof target[k] !== 'object' || Array.isArray(target[k])) {
                target[k] = { ...dv };
                changed = true;
            } else if (fillMissing(target[k], dv)) {
                changed = true;
            }
        }
    }
    return changed;
}

// --- Bootstrap config -------------------------------------------------------

let config = configStore.get();

if (fillMissing(config, DEFAULT_CONFIG)) {
    configStore.replace(config);
    logger.info('[Bootstrap] config.json seeded with defaults for missing keys');
}
const PORT = config.extension.port;
// Default to loopback only. Set extension.bindHost to "0.0.0.0" (or a specific
// interface IP) in config.json to expose the receiver to other machines on the
// LAN, e.g. when overlays run on a separate OBS PC.
const HOST = (config.extension && typeof config.extension.bindHost === 'string')
    ? config.extension.bindHost
    : DEFAULT_BIND_HOST;
if (HOST === '0.0.0.0') {
    logger.warn('[Bootstrap] bindHost=0.0.0.0 — receiver is reachable from the network. /api/config has no auth; restrict via firewall.');
}

// --- HTTP server + Socket.IO -----------------------------------------------
// Constructed before any module callback that might want to emit on `io`, so
// the `typeof io !== 'undefined'` guard is no longer needed.

const app = express();
const server = http.createServer(app);

// Socket.IO CORS: default to loopback origins. Set extension.allowAllOrigins=true
// in config.json when overlays load from another origin (e.g. LAN OBS PC).
function isOriginAllowed(origin) {
    if (!origin) return true;                      // same-origin or non-browser client
    if (config.extension?.allowAllOrigins) return true;
    try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch { return false; }
}
const io = new IoServer(server, {
    cors: { origin: (origin, cb) => cb(null, isOriginAllowed(origin)) },
});

// --- TTS engine selector ----------------------------------------------------
// Only the active backend is instantiated, but we hang both configs off the
// handler so the Web UI can edit either pane without churn.
function createTtsHandler(cfg) {
    const engine = cfg.tts?.engine === 'browser' ? 'browser' : 'voicevox';
    if (engine === 'browser') {
        return { engine, handler: new BrowserTtsHandler(cfg.browser_tts || {}, io) };
    }
    return { engine, handler: new VoiceVoxHandler(cfg.voicevox || {}) };
}

let { engine: ttsEngine, handler: ttsHandler } = createTtsHandler(config);
logger.info(`[Bootstrap] TTS engine = ${ttsEngine}`);

// Honour the persisted voiceFile selection if it points at an existing file;
// otherwise stay on whatever voice-templates loaded by default (voice.json).
if (config.tts?.voiceFile && config.tts.voiceFile !== voiceTemplates.currentFileName()) {
    if (!voiceTemplates.setFile(config.tts.voiceFile)) {
        // Persist the resolved (fallback) file so the Web UI reflects reality.
        config.tts.voiceFile = voiceTemplates.currentFileName();
        configStore.replace(config);
    }
}

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, 'public')));
// Sound cues (e.g. gate-pass detection.wav) played by the overlay page.
app.use('/sound', express.static(path.join(__dirname, 'sound')));

// Vendored assets served from node_modules (offline-friendly).
// Tailwind is in public/vendor/tailwind.js (served by the static mount above).
const NM = path.join(__dirname, 'node_modules');
const VENDOR_MOUNTS = [
    { url: '/vendor/bootstrap',        src: ['bootstrap', 'dist'] },
    { url: '/vendor/fontawesome',      src: ['@fortawesome', 'fontawesome-free'] },
    { url: '/vendor/fonts/orbitron',       src: ['@fontsource', 'orbitron'] },
    { url: '/vendor/fonts/noto-sans-jp',   src: ['@fontsource', 'noto-sans-jp'] },
    { url: '/vendor/fonts/titillium-web',  src: ['@fontsource', 'titillium-web'] },
    { url: '/vendor/fonts/roboto-mono',    src: ['@fontsource', 'roboto-mono'] },
    { url: '/vendor/fonts/audiowide',      src: ['@fontsource', 'audiowide'] },
];
for (const m of VENDOR_MOUNTS) {
    app.use(m.url, express.static(path.join(NM, ...m.src)));
}

// Event router holds per-stream state (seq, dedup) and the type→handler
// dictionary. server.js stays thin: HTTP + bootstrap.
const router = createRouter({
    io,
    ttsHandler: () => ttsHandler,
    voiceLogic, voiceTemplates, resultsStore, liveQualify,
    configStore, logger,
    startStageWatch: () => startStageWatch(),
});

// Drives the per-pilot 30s/20s/10s-remaining voice countdown. Runs
// unconditionally; router.tick()/voiceLogic are no-ops outside an active race.
const COUNTDOWN_TICK_MS = 1000;
setInterval(() => router.tick(), COUNTDOWN_TICK_MS);

// PUT receiver — must ack BEFORE processing (§2.3).
const fpvtQueue = [];
let draining = false;

app.put('/', (req, res) => {
    res.status(200).end();
    enqueue(req.body);
});
app.put('/api/fpvtrackside/notification', (req, res) => {
    res.status(200).end();
    enqueue(req.body);
});

// Lenient: accept POST with the same shape (e.g. test clients / curl).
app.post('/api/fpvtrackside/notification', (req, res) => {
    res.status(200).end();
    enqueue(req.body);
});

// JSON parse failures from express.json end up here. Per spec §2.3 the sender
// expects an immediate 200 even when its payload is malformed — otherwise it
// retries and we get the same garbage again. Log and drop.
app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        logger.warn(`[PUT] JSON parse error: ${err.message}`);
        return res.status(200).end();
    }
    return next(err);
});

function enqueue(body) {
    // Minimal shape check. Anything without a string `type` cannot be
    // dispatched and would just waste a queue slot.
    if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
        const preview = (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
        logger.warn(`[PUT] dropped malformed body: ${preview.slice(0, 200)}`);
        return;
    }
    fpvtQueue.push(body);
    setImmediate(drainQueue);
}

function drainQueue() {
    if (draining) return;
    draining = true;
    try {
        while (fpvtQueue.length > 0) {
            const evt = fpvtQueue.shift();
            try {
                router.dispatch(evt);
            } catch (e) {
                logger.error(`[Dispatch] type=${evt?.type} ${e.stack || e.message}`);
            }
        }
    } finally {
        draining = false;
    }
}

// --- REST API --------------------------------------------------------------

app.get('/api/config', (_req, res) => {
    res.json(configStore.get());
});

app.post('/api/config', (req, res) => {
    try {
        const next = req.body;
        configStore.replace(next);
        config = configStore.get();

        // Push a fresh Live 90s snapshot so a display-order change re-sorts the
        // overlay immediately, without waiting for the next detection.
        io.emit('live_qualify', liveQualify.snapshot());

        // Live-switch the voice template file if the operator picked a
        // different one. Templates are reloaded; failures fall back to the
        // previous file so announcements never go silent.
        if (config.tts?.voiceFile && config.tts.voiceFile !== voiceTemplates.currentFileName()) {
            if (!voiceTemplates.setFile(config.tts.voiceFile)) {
                config.tts.voiceFile = voiceTemplates.currentFileName();
            }
        }

        // TTS engine swap — if the operator flipped engines, drop the old
        // handler's queue and instantiate the new one. Otherwise live-update
        // settings on the existing handler so the next announcement uses them.
        const desiredEngine = config.tts?.engine === 'browser' ? 'browser' : 'voicevox';
        if (desiredEngine !== ttsEngine) {
            try { ttsHandler.clearQueue(); } catch (_e) { /* best-effort */ }
            ({ engine: ttsEngine, handler: ttsHandler } = createTtsHandler(config));
            logger.info(`[Config] TTS engine switched to ${ttsEngine}`);
        } else if (ttsEngine === 'voicevox' && config.voicevox) {
            // Skip null/undefined speaker — assigning it would send
            // `speaker=null` to VOICEVOX (HTTP 422, silent no-audio).
            if (config.voicevox.speaker != null) {
                ttsHandler.speaker = config.voicevox.speaker;
            }
            ttsHandler.volume = config.voicevox.volume;
            ttsHandler.enabled = !!config.voicevox.enabled;
            if (typeof config.voicevox.url === 'string' && config.voicevox.url) {
                ttsHandler.url = config.voicevox.url;
            }
            if (typeof config.voicevox.speed === 'number') {
                ttsHandler.speed = config.voicevox.speed;
            }
        } else if (ttsEngine === 'browser' && config.browser_tts) {
            const b = config.browser_tts;
            ttsHandler.enabled = !!b.enabled;
            if (typeof b.voiceName === 'string') ttsHandler.voiceName = b.voiceName;
            if (typeof b.lang === 'string' && b.lang) ttsHandler.lang = b.lang;
            if (typeof b.rate === 'number') ttsHandler.rate = b.rate;
            if (typeof b.pitch === 'number') ttsHandler.pitch = b.pitch;
            if (typeof b.volume === 'number') ttsHandler.volume = b.volume;
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/status', (_req, res) => {
    res.json({
        fpvt: configStore.get().fpvt || null,
    });
});

// Server-side proxy for VOICEVOX /speakers. The browser can't fetch
// http://localhost:50021/speakers directly because VOICEVOX doesn't send CORS
// headers by default. `?url=` lets the Web UI preview a not-yet-saved URL.
app.get('/api/voicevox/speakers', async (req, res) => {
    const fallbackUrl = (ttsEngine === 'voicevox' && ttsHandler.url)
        ? ttsHandler.url
        : (config.voicevox?.url || 'http://localhost:50021');
    const target = (typeof req.query.url === 'string' && req.query.url)
        ? req.query.url
        : fallbackUrl;
    try {
        const r = await fetch(`${target.replace(/\/+$/, '')}/speakers`);
        if (!r.ok) {
            res.status(r.status).json({ error: `VOICEVOX HTTP ${r.status}` });
            return;
        }
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Lists voice*.json files in the working directory and reports which one is
// currently active. The Web UI uses this to populate the file-picker so the
// operator can swap phrasing (language, tone, …) without restarting.
app.get('/api/voice_files', (_req, res) => {
    res.json({
        files: voiceTemplates.listAvailable(),
        current: voiceTemplates.currentFileName(),
    });
});

// Leaderboard = file-based 90s stage standings across all valid Time Trial
// races in the current event (mirrors the Lua result stage). Recomputed from
// FPVTrackside's event files; pushed live via Socket.IO ('leaderboard_update')
// on every lap-time write, and served here for the initial paint / poll.
function leaderboardPayload() {
    const s = stageStandings.compute();
    return {
        title: s.eventName || 'Qualifying',
        window: s.window,
        decimalPlaces: s.decimalPlaces,
        raceCount: s.raceCount,
        ranking: s.pilots.map(p => ({ pilotName: p.pilotName, time: p.time, count: p.laps })),
    };
}

app.get('/api/leaderboard', (_req, res) => {
    res.json(leaderboardPayload());
});

// Live "90s from holeshot" qualifying view, computed in real time from the
// DetectionExt stream (mirrors the Lua stage script). Pushed via Socket.IO
// ('live_qualify') on every lap; this endpoint serves the initial paint.
app.get('/api/live_qualify', (_req, res) => {
    res.json(liveQualify.snapshot());
});

// --- Google Sheets export (Time Trial results) -----------------------------
// Auto-write is debounced 10s after the last lap-time file change so we batch a
// burst of writes into one Sheets API call and stay well under rate limits.
let sheetsTimer = null;
function scheduleSheetsWrite() {
    const gs = config.google_sheets || {};
    if (!gs.enabled || !gs.spreadsheetId) return;
    clearTimeout(sheetsTimer);
    sheetsTimer = setTimeout(async () => {
        try {
            const data = stageStandings.buildTimeTrialRows();
            const r = await googleSheets.writeTimeTrialSheet(gs.spreadsheetId, gs.sheetName || 'TimeTrial', data);
            logger.info(`[Sheets] wrote ${r.rows} rows to "${r.sheetName}"`);
        } catch (e) {
            logger.error('[Sheets] write failed: ' + e.message);
        }
    }, 10_000);
}

// Starts (or restarts) the events-directory watcher. Called once at boot and
// again from the Hello handler: on a fresh install boot happens before
// FPVTrackside's first Hello, so paths.eventsDirectory isn't known yet and the
// boot-time attempt is a no-op (logs a warning). Hello is what actually
// populates it, so it must retry the watch itself or it never starts.
function startStageWatch() {
    return stageStandings.startWatching(() => {
        io.emit('leaderboard_update', leaderboardPayload());
        scheduleSheetsWrite();
    });
}

// Manual "write now" (config-page test button) — bypasses the debounce.
app.post('/api/sheets/write', async (_req, res) => {
    const gs = config.google_sheets || {};
    if (!gs.spreadsheetId) return res.status(400).json({ error: 'spreadsheetId not set' });
    try {
        const data = stageStandings.buildTimeTrialRows();
        const r = await googleSheets.writeTimeTrialSheet(gs.spreadsheetId, gs.sheetName || 'TimeTrial', data);
        res.json({ success: true, rows: r.rows, sheetName: r.sheetName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/test_voice', async (req, res) => {
    const defaultText = '接続テストです。この声で読み上げを行います。';
    const text = (req.query.text || defaultText).toString();
    try {
        // VOICEVOX plays through the server-side OS player (PowerShell / afplay
        // / ffplay), independent of `enabled`. Browser TTS routes the test to
        // the Live 90s overlay page(s) via Socket.IO instead.
        await ttsHandler.speakOnServer(text);
        res.json({ success: true, text, engine: ttsEngine });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/pilot_image', (req, res) => {
    const rel = (req.query.path || '').toString();
    if (!rel) return res.status(400).send('Path required');

    // Reject anything that could escape the pilots root before resolving.
    // Absolute paths and parent-traversal segments are not legitimate inputs
    // — Core only ever sends paths relative to the event working directory.
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        logger.warn(`[Media] Rejected suspicious path: "${rel}"`);
        return res.status(403).send('Forbidden');
    }

    const wd = configStore.workingDirectory();
    if (!wd) {
        logger.warn('[Media] No working directory configured (Hello not received yet)');
        return res.status(404).send('Not found');
    }

    const allowedRoot = path.resolve(wd, 'pilots');
    const requested = path.resolve(allowedRoot, rel);
    // After resolution, verify we are still scoped under allowedRoot.
    // The trailing separator on allowedRoot prevents "pilotsX/..." aliasing.
    if (requested !== allowedRoot && !requested.startsWith(allowedRoot + path.sep)) {
        logger.warn(`[Media] Rejected out-of-root path: "${requested}"`);
        return res.status(403).send('Forbidden');
    }

    if (!fs.existsSync(requested)) {
        logger.warn(`[Media] File not found: "${requested}" (requested: "${rel}")`);
        return res.status(404).send('Not found');
    }

    return res.sendFile(requested);
});

// HTML routing: /html/<category>[/<variant>]
//   default    → public/html/<dir>/<base>.html
//   variant=k  → public/html/<dir>/<base><K>.html  (e.g. f1 → <base>F1.html)
const HTML_CATEGORIES = {
    leaderboard: { dir: 'leaderboard', base: 'leaderboard' },
    livequalify: { dir: 'livequalify', base: 'liveQualify' },
};

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'index.html')));

app.get('/html/:category/:variant?', (req, res, next) => {
    const meta = HTML_CATEGORIES[req.params.category];
    if (!meta) return next();
    const { dir, base } = meta;
    const v = req.params.variant;
    const filename = v
        ? `${base}${v.charAt(0).toUpperCase()}${v.slice(1)}.html`
        : `${base}.html`;
    const filePath = path.join(__dirname, 'public', 'html', dir, filename);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    next();
});

// --- Socket.IO clock sync --------------------------------------------------

io.on('connection', (socket) => {
    logger.debug(`[io] connected ${socket.id}`);
    // Browser sends ts_server_time → return monotonic seconds for offset calc.
    socket.on('ts_server_time', (cb) => {
        if (cb) cb(performance.now() / 1000);
    });
    socket.on('disconnect', () => logger.debug(`[io] disconnect ${socket.id}`));
});

// --- Lifecycle --------------------------------------------------------------

server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
    console.log('────────────────────────────────────────────────────────────');
    console.log(' FPVTrackside Extension Sample — receiver');
    console.log(`  PUT      : http://127.0.0.1:${PORT}/  (NotificationURL)`);
    console.log(`  Web UI   : http://127.0.0.1:${PORT}/`);
    console.log(`  Ranking  : http://127.0.0.1:${PORT}/html/leaderboard`);
    console.log(`  Live 90s : http://127.0.0.1:${PORT}/html/livequalify`);
    console.log('────────────────────────────────────────────────────────────');

    // Watch FPVTrackside's event files; on every lap-time write, recompute the
    // stage standings and push them to the leaderboard overlays. On a fresh
    // install this is a no-op until Hello arrives and populates
    // paths.eventsDirectory (see startStageWatch's other call site).
    startStageWatch();
});

let shuttingDown = false;
function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${sig} received — shutting down`);

    try { ttsHandler.clearQueue(); } catch (_e) { /* best-effort */ }
    try { stageStandings.stopWatching(); } catch (_e) { /* best-effort */ }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_FORCE_EXIT_MS).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
