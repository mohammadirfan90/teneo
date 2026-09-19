// src/lib/logger.ts
// Structured logger (Pino) with PII redaction per spec §11.3.1.
// Re-keys known sensitive fields to '[REDACTED]' before they leave the process.

import { pino } from 'pino';

const isProd = process.env.NODE_ENV === 'production';

const redactPaths = [
  'email',
  'password',
  'phone',
  'id_number',
  'address',
  'refresh_token',
  'access_token',
  '*.email',
  '*.password',
  '*.phone',
  '*.id_number',
  '*.address',
  '*.refreshToken',
  '*.refresh_token',
  '*.accessToken',
  '*.access_token',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactPaths, censor: '[REDACTED]', remove: false },
  base: { service: 'housing-platform-backend', env: process.env.NODE_ENV ?? 'development' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }),
});
