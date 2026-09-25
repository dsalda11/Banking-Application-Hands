import pino, { type DestinationStream, type Logger } from 'pino';

export interface LoggerOptions {
  readonly level?: string;
  readonly destination?: DestinationStream;
}

const redactedPaths = [
  '*.password',
  '*.password.*',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.cookie',
  '*.cookies',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  'password',
  'apiKey',
  'authorization',
  'cookie',
  'cookies',
  'token',
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      redact: { paths: redactedPaths, censor: '[REDACTED]' },
    },
    options.destination,
  );
}
