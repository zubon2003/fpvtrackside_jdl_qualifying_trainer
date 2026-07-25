const fs = require('fs');
const path = require('path');
const winston = require('winston');

// File logging is opt-in via the --log CLI flag (e.g. `node server.js --log`,
// or `pnpm start -- --log`) — most sessions don't need a persisted log, so by
// default nothing is written to disk and the log/ directory is never created.
const FILE_LOGGING_ENABLED = process.argv.includes('--log');

const plainFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.splat(),
    winston.format.printf(info => {
        const { timestamp, level, message, ...args } = info;
        const ts = timestamp.slice(0, 19).replace('T', ' ');
        const m = typeof message === 'object' ? JSON.stringify(message) : message;
        const a = Object.keys(args).length ? ' ' + JSON.stringify(args) : '';
        return `${ts} [${level}]: ${m}${a}`;
    })
);

const colorFormat = winston.format.combine(
    winston.format.colorize(),
    plainFormat
);

const transports = [
    new winston.transports.Console({ format: colorFormat }),
];

let logFilePath = null;
if (FILE_LOGGING_ENABLED) {
    // Resolve log directory relative to the receiver's working directory so
    // the file lives next to config.json. Only created when --log is passed.
    const LOG_DIR = path.resolve(process.cwd(), 'log');
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_e) { /* ignore */ }
    logFilePath = path.join(LOG_DIR, 'server.log');
    // File transport intentionally has no rotation — winston-daily-rotate
    // would pull in a dep. 10 MB × 5 files gives ~50 MB of history before
    // the oldest is dropped, which is plenty for a race day.
    transports.push(new winston.transports.File({
        filename: logFilePath,
        format: plainFormat,
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
    }));
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports,
});

if (FILE_LOGGING_ENABLED) {
    logger.info(`[Logger] file logging enabled: ${logFilePath}`);
}

module.exports = logger;
