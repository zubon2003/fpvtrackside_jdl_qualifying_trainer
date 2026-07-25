// Browser TTS handler (Web Speech API / speechSynthesis).
//
// Unlike VoiceVoxHandler, no audio is synthesised on the server. Instead we
// broadcast the announcement text (+ voice params) over Socket.IO to the
// Live 90s overlay page (/html/livequalify), which calls window.speechSynthesis
// on the operator's machine. Same public surface as VoiceVoxHandler so
// server.js / event-router can treat both engines the same.
'use strict';

const logger = require('./logger.js');

class BrowserTtsHandler {
    // `io` is the Socket.IO server — the overlay page(s) are the audio sink.
    constructor(config = {}, io) {
        this.io = io;
        this.enabled = !!config.enabled;
        this.voiceName = config.voiceName || '';   // browser voice name; '' = page default
        this.lang = config.lang || 'ja-JP';
        this.rate = typeof config.rate === 'number' ? config.rate : 1.0;
        this.pitch = typeof config.pitch === 'number' ? config.pitch : 1.0;
        this.volume = typeof config.volume === 'number' ? config.volume : 1.0;

        if (this.enabled) {
            logger.info(`[BrowserTTS] init voice="${this.voiceName || '(default)'}" lang=${this.lang} rate=${this.rate}`);
        }
    }

    // Parity with the OS-player handler; the browser is always "ready".
    ensurePlayer() { return true; }

    _settings() {
        return {
            voiceName: this.voiceName,
            lang: this.lang,
            rate: this.rate,
            pitch: this.pitch,
            volume: this.volume,
        };
    }

    _emitSpeak(text) {
        if (!this.io) {
            logger.warn('[BrowserTTS] no Socket.IO server wired — cannot reach the overlay page');
            return;
        }
        this.io.emit('browser_speak', { text, ...this._settings() });
    }

    // Race-driven path. Gated by `enabled` like VOICEVOX. The callback (used
    // elsewhere to ship base64 audio to browsers) is intentionally not called —
    // there is no server-side audio to deliver.
    enqueueText(text, _callback) {
        if (!this.enabled || !text) return;
        logger.debug(`[BrowserTTS] speak: "${text}"`);
        this._emitSpeak(text);
    }

    // Test Voice path (/api/test_voice). There is no server player for this
    // engine, so the test is routed to the overlay page regardless of
    // `enabled`, mirroring how VOICEVOX always sounds the test.
    async speakOnServer(text) {
        if (!text) return;
        this._emitSpeak(text);
    }

    // Drop anything the overlay page is still speaking / has queued.
    clearQueue() {
        if (this.io) this.io.emit('browser_speak_clear', {});
    }

    // No server-side audio for this engine.
    async generateAudio() { return null; }
}

module.exports = BrowserTtsHandler;
