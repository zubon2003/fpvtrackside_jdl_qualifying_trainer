// Event router for FPVTrackside Extension notifications.
//
// Holds per-event-stream state (seq tracking, defensive de-dup window) and
// dispatches each parsed event to the right handler. Created once at boot with
// all services wired in, then `dispatch(evt)` is called from the PUT receiver's
// drain loop.
//
// Scope: this build drives the live 90s-qualifying overlay and TTS
// announcements only. Camera switching, LED, pre-race countdown, and next-race
// intro have been removed.
'use strict';

const SEEN_DETECTION_MAX = 10_000;

function createRouter(services) {
    const {
        io, ttsHandler: ttsHandlerRef,
        voiceLogic, voiceTemplates, resultsStore, liveQualify,
        configStore, logger, startStageWatch,
    } = services;
    // server.js may pass either the handler itself or a getter function so the
    // active TTS engine can be hot-swapped via /api/config. Normalise both.
    const getTts = typeof ttsHandlerRef === 'function' ? ttsHandlerRef : () => ttsHandlerRef;

    // --- State (per-event-stream, lives for the process lifetime) ----------

    let lastSeq = 0;

    // Bounded de-dup window. Detections that disappear from the window can be
    // re-processed on a network retry; that's acceptable because de-dup is a
    // defensive measure (the sender already filters duplicates per §10).
    const seenDetections = new Set();
    const seenOrder = [];

    function rememberDetection(id) {
        if (seenDetections.has(id)) return true;
        seenDetections.add(id);
        seenOrder.push(id);
        if (seenOrder.length > SEEN_DETECTION_MAX) {
            const evicted = seenOrder.shift();
            seenDetections.delete(evicted);
        }
        return false;
    }

    function clearSeenDetections() {
        seenDetections.clear();
        seenOrder.length = 0;
    }

    // --- Announce: text to overlays + TTS pipeline -------------------------

    function announce(text) {
        io.emit('announce_text', { text });
        const tts = getTts();
        if (tts && tts.enabled) {
            tts.enqueueText(text, (audioData) => {
                if (audioData) io.emit('play_audio', { data: audioData });
            });
        }
    }

    // Push the current live 90s-qualifying snapshot to all overlays.
    function emitLiveQualify() {
        if (liveQualify) io.emit('live_qualify', liveQualify.snapshot());
    }

    // --- Handlers (one per FPVTrackside event type) ------------------------

    const handlers = {
        Hello(evt) {
            configStore.applyHello(evt);
            // Hello is the first point paths.eventsDirectory is known; the
            // boot-time watch attempt (before any Hello) is a no-op on a
            // fresh install, so retry it here now that the path exists.
            if (startStageWatch) startStageWatch();
            const tsys = evt.timingSystem || {};
            const chans = evt.channelSettings?.channels || [];
            logger.info(`[Hello] v${evt.fpvtVersion} ${evt.platform} profile=${evt.profile?.name} timers=${tsys.count} sectorsPerLap=${tsys.splitsPerLap}`);
            const chanSummary = chans.length
                ? chans.map(c => `${c.band}${c.number}`).join(',')
                : '(none)';
            logger.info(`[Hello] channels=${chans.length} [${chanSummary}]`);
        },

        RaceLoaded(evt) {
            voiceLogic.loadPilots(evt.pilots);
            voiceLogic.setRaceActive(false);
            resultsStore.onRaceLoaded(evt);
            if (liveQualify) { liveQualify.onRaceLoaded(evt); emitLiveQualify(); }
        },

        RaceStart(evt) {
            voiceLogic.resetForRace();
            voiceLogic.setRaceActive(true);
            if (liveQualify) { liveQualify.onRaceStart(evt); emitLiveQualify(); }
            // Whole-race start announcement (independent of per-pilot holeshot).
            const startText = voiceTemplates.render('raceStart');
            if (startText) announce(startText);
            logger.info(`[RaceStart] R${evt.round}.${evt.race} t0=${evt.actualStart}`);
        },

        RaceTimesUp(evt) {
            logger.info(`[RaceTimesUp] R${evt.round}.${evt.race}`);
        },

        RaceEnd(evt)       { return handlers._raceEnded(evt); },
        RaceCancelled(evt) { return handlers._raceEnded(evt); },
        _raceEnded(evt) {
            voiceLogic.setRaceActive(false);
            try { getTts().clearQueue(); } catch (_e) { /* best-effort */ }
            resultsStore.onRaceEnd(evt);
            if (liveQualify) { liveQualify.onRaceEnd(evt); emitLiveQualify(); }
            const endKey = evt.type === 'RaceEnd'
                ? 'raceEnd'
                : (evt.failure ? 'raceFailed' : 'raceCancelled');
            const endText = voiceTemplates.render(endKey);
            if (endText) announce(endText);
        },

        DetectionExt(evt) {
            // §10: defensive de-dup even though sender filters.
            if (evt.detectionId && rememberDetection(evt.detectionId)) return;

            // Live 90s-qualifying: lap-loop crossings define laps, so refresh
            // the overlay whenever one arrives. Processed BEFORE the voice
            // announcement so the pacemaker (Target) delta reflects the lap that
            // was just completed and can be read out after the lap time.
            let targetDelta = null;
            let windowFinish = false;
            let finishSummary = null;
            let lapRemaining = null;
            if (liveQualify && evt.isLapEnd && evt.valid !== false) {
                liveQualify.onDetection(evt);
                // Only compute/speak the delta when the operator enabled it.
                if (configStore.get().live_qualify?.speakTargetDelta !== false) {
                    targetDelta = liveQualify.pilotDelta(evt.pilotName);
                }
                // Optional "残りy秒" tail on the lap call, once the pilot is inside
                // the closing stretch of their window. Opt-in (default off), and
                // only when the time left at this crossing is under the operator's
                // threshold — voice-logic.js does the rounding and the "don't say
                // 残り0秒" guard.
                const lq = configStore.get().live_qualify;
                if (lq?.speakLapRemaining) {
                    const threshold = Number(lq.lapRemainingThreshold);
                    const left = liveQualify.pilotRemainingAtLap(evt.pilotName);
                    if (Number.isFinite(threshold) && threshold > 0
                        && left != null && left < threshold) {
                        lapRemaining = left;
                    }
                }
                // True on the one lap that pushes this pilot past the 90s window —
                // the voice announcer speaks a "finish" cue and goes quiet after.
                windowFinish = liveQualify.isWindowClosingLap(evt.pilotName);
                if (windowFinish) {
                    // Counted laps + cumulative time, read out with the finish cue.
                    finishSummary = liveQualify.pilotFinishSummary(evt.pilotName);
                }
                emitLiveQualify();
                // Gate-pass sound cue, played by the overlay page in the browser.
                io.emit('play_sound', { file: 'detection.wav' });
            }

            voiceLogic.onDetection(evt, announce, {
                targetDelta, windowFinish, finishSummary, lapRemaining,
            });
        },

        RaceResult(evt) {
            resultsStore.onRaceResult(evt);
        },

        StageRanking(evt) {
            resultsStore.onStageRanking(evt);
        },

        PilotCrashedOut(evt) {
            resultsStore.onPilotCrashed(evt);
            voiceLogic.onCrash(evt, announce);
        },

        PilotRaceState(evt) {
            voiceLogic.loadPilots(evt.pilots);
        },

        // Per-pilot go signal during TimeTrial staggered start (§7.9). Queue a
        // "<pilot> START" TTS using the dedicated `staggeredStart` template.
        PilotStaggeredStart(evt) {
            const p = evt.pilot;
            if (!p) return;
            logger.info(`[StaggeredStart] ${p.name} (${evt.orderIndex + 1}/${evt.totalPilots}, delay=${evt.delaySeconds}s)`);
            voiceLogic.onStaggeredStart(evt, announce);
        },
    };

    // --- Dispatch ----------------------------------------------------------

    function checkSequence(evt) {
        if (typeof evt.seq !== 'number') return;
        if (evt.seq < lastSeq) {
            logger.warn(`[Seq] reset ${evt.seq} < ${lastSeq} — sender restart suspected`);
            clearSeenDetections();
        } else if (lastSeq !== 0 && evt.seq > lastSeq + 1) {
            logger.warn(`[Seq] gap expected ${lastSeq + 1} got ${evt.seq}`);
        }
        lastSeq = evt.seq;
    }

    function dispatch(evt) {
        if (!evt || typeof evt !== 'object') return;
        checkSequence(evt);

        const handler = handlers[evt.type];
        if (typeof handler === 'function' && !evt.type.startsWith('_')) {
            handler(evt);
        } else {
            // §10: silently ignore unknown types.
            logger.debug(`[ignored] type=${evt?.type ?? '<missing>'}`);
        }
    }

    // Called on a fixed interval (server.js) — independent of the FPVTrackside
    // event stream, since a countdown mark (60s/70s/80s since a pilot's own
    // holeshot) can fall in the middle of a lap, with no detection to hang off.
    function tick() {
        if (!liveQualify) return;
        voiceLogic.onCountdownTick(liveQualify.pilotsRemaining(), announce);
    }

    return {
        dispatch,
        announce,
        tick,
    };
}

module.exports = { createRouter };
