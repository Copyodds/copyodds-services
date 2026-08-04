import pino from 'pino';

const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function getLogLevel(): pino.LevelWithSilent {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && LEVELS.has(raw)) {
    return raw as pino.LevelWithSilent;
  }
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production' ? 'info' : 'debug';
}

/** 结构化 JSON 日志；生产默认 info，开发默认 debug。可通过 LOG_LEVEL 覆盖。 */
export const logger = pino({
  level: getLogLevel(),
  base: { service: 'polymarket-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-internal-secret"]',
      'req.headers["x-admin-key"]',
      'req.headers["x-admin-bootstrap-key"]',
      'req.headers["x-custody-payment-secret"]',
      'req.headers["x-custody-credit-secret"]',
    ],
    censor: '[REDACTED]',
  },
});
